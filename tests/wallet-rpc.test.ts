import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { Wallet, Transaction } from 'ethers';
import { WalletRpcGateway, rewriteBlockTags, USER_REJECTED, type ClearSignView } from '../src/wallet-rpc.js';

const SEPOLIA = 11155111;
const wallet = new Wallet('0x' + '11'.repeat(32));

interface Call { method: string; params: any[] }

function listen(server: Server): Promise<number> {
  return new Promise(r => server.listen(0, '127.0.0.1', () => {
    const a = server.address();
    r(typeof a === 'object' && a ? a.port : 0);
  }));
}

/** Light client stand-in: refuses `pending` exactly like the real one (-32001). */
function mockLightClient(calls: Call[]): Server {
  return createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const { id, method, params } = JSON.parse(body);
      calls.push({ method, params });
      const reply = (payload: object) => res.end(JSON.stringify({ jsonrpc: '2.0', id, ...payload }));
      if (params?.includes?.('pending')) return reply({ error: { code: -32001, message: 'pending is unavailable' } });
      switch (method) {
        case 'eth_chainId': return reply({ result: '0x' + SEPOLIA.toString(16) });
        case 'eth_getTransactionCount': return reply({ result: '0x5' });
        case 'eth_getBalance': return reply({ result: '0xde0b6b3a7640000' });
        case 'eth_sendRawTransaction': return reply({ result: Transaction.from(params[0]).hash });
        default: return reply({ error: { code: -32601, message: 'method not found' } });
      }
    });
  });
}

async function signedTx(overrides: Partial<{ chainId: number; nonce: number; data: string }> = {}): Promise<string> {
  return wallet.signTransaction({
    type: 2,
    chainId: overrides.chainId ?? SEPOLIA,
    nonce: overrides.nonce ?? 5,
    to: '0x1111111111111111111111111111111111111111',
    value: 0n,
    data: overrides.data ?? '0xa9059cbb0000000000000000000000002222222222222222222222222222222222222222000000000000000000000000000000000000000000000000000000000000000a',
    gasLimit: 60000n,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n
  });
}

function view(verdict: ClearSignView['verdict']): ClearSignView {
  return { verdict, reason: `${verdict} for test`, intent: 'Transfer 10 USDC to 0x2222…2222', text: 'KaiSign clear-sign\n', warnings: [] };
}

describe('KaiSign wallet RPC gateway', () => {
  let upstream: Server;
  let calls: Call[];
  let gateway: WalletRpcGateway;
  let base: string;
  let verdict: ClearSignView['verdict'];
  let onPending: ((id: string) => void) | undefined;

  async function start(options: { autoApprove?: 'none' | 'safe'; approvalTimeoutMs?: number } = {}) {
    gateway = new WalletRpcGateway({
      upstream: `http://127.0.0.1:${await listen(upstream)}`,
      clearSign: async () => view(verdict),
      log: () => {},
      onPending: a => onPending?.(a.id),
      ...options
    });
    const { port } = await gateway.listen(0);
    base = `http://127.0.0.1:${port}`;
  }

  const rpc = (method: string, params: unknown[], headers: Record<string, string> = {}) =>
    fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }) });

  beforeEach(() => {
    calls = [];
    verdict = 'review';
    onPending = undefined;
    upstream = mockLightClient(calls);
  });

  afterEach(async () => {
    await gateway?.close();
    await new Promise<void>(r => upstream.close(() => r()));
  });

  it('forwards reads and maps tags the light client refuses', async () => {
    await start();
    const res = await (await rpc('eth_getBalance', [wallet.address, 'pending'])).json();
    expect(res).toEqual({ jsonrpc: '2.0', id: 7, result: '0xde0b6b3a7640000' });
    expect(calls.at(-1)).toEqual({ method: 'eth_getBalance', params: [wallet.address, 'latest'] });
    expect(rewriteBlockTags('eth_getLogs', [{ fromBlock: 'safe', toBlock: 'pending' }])).toEqual([{ fromBlock: 'finalized', toBlock: 'latest' }]);
  });

  it('holds eth_sendRawTransaction until approved, then relays it', async () => {
    await start();
    const raw = await signedTx();
    onPending = id => {
      expect(calls.some(c => c.method === 'eth_sendRawTransaction')).toBe(false);
      void fetch(`${base}/approvals/${id}/approve`, { method: 'POST', headers: { 'X-KaiSign-Token': gateway.token } });
    };

    const res = await (await rpc('eth_sendRawTransaction', [raw])).json();

    expect(res.result).toBe(Transaction.from(raw).hash);
    expect(calls.filter(c => c.method === 'eth_sendRawTransaction')).toHaveLength(1);
    expect(gateway.list().recent[0]).toMatchObject({ status: 'broadcast', decidedBy: 'browser' });

    // The light client has no pending state; the gateway serves the next nonce itself.
    const nonce = await (await rpc('eth_getTransactionCount', [wallet.address, 'pending'])).json();
    expect(nonce.result).toBe('0x6');
  });

  it('returns EIP-1193 4001 and never broadcasts when rejected', async () => {
    await start();
    onPending = id => { gateway.decide(id, false, 'terminal', 'nope'); };
    const res = await (await rpc('eth_sendRawTransaction', [await signedTx()])).json();
    expect(res.error.code).toBe(USER_REJECTED);
    expect(calls.some(c => c.method === 'eth_sendRawTransaction')).toBe(false);
  });

  it('auto-approves SAFE verdicts when enabled, but not REVIEW', async () => {
    await start({ autoApprove: 'safe', approvalTimeoutMs: 200 });
    verdict = 'safe';
    expect((await (await rpc('eth_sendRawTransaction', [await signedTx()])).json()).result).toMatch(/^0x/);
    verdict = 'review';
    const held = await (await rpc('eth_sendRawTransaction', [await signedTx({ nonce: 6 })])).json();
    expect(held.error.code).toBe(USER_REJECTED);
    expect(held.error.message).toContain('timed out');
  });

  it('refuses a transaction signed for another chain', async () => {
    await start();
    const res = await (await rpc('eth_sendRawTransaction', [await signedTx({ chainId: 1 })])).json();
    expect(res.error.message).toContain('chain 1');
    expect(gateway.list().pending).toHaveLength(0);
  });

  it('cancels the approval when the wallet disconnects', async () => {
    await start();
    const raw = await signedTx();
    const url = new URL(base);
    await new Promise<void>(resolve => {
      onPending = () => { req.destroy(); setTimeout(resolve, 50); };
      const req = httpRequest({ host: url.hostname, port: url.port, method: 'POST', headers: { 'Content-Type': 'application/json' } });
      req.on('error', () => {});
      req.end(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_sendRawTransaction', params: [raw] }));
    });
    expect(gateway.list().recent[0]).toMatchObject({ status: 'rejected', decidedBy: 'wallet-disconnected' });
    expect(calls.some(c => c.method === 'eth_sendRawTransaction')).toBe(false);
  });

  it('allows wallet extensions and refuses websites', async () => {
    await start();
    const ext = await rpc('eth_chainId', [], { Origin: 'chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn' });
    expect(ext.status).toBe(200);
    expect(ext.headers.get('access-control-allow-origin')).toBe('chrome-extension://nkbihfbeogaeaoehlefnkodbefgpgknn');
    expect((await rpc('eth_chainId', [], { Origin: 'https://evil.example' })).status).toBe(403);
  });

  it('protects the approval API with the page token', async () => {
    await start();
    expect((await fetch(`${base}/approvals`)).status).toBe(403);
    expect((await fetch(`${base}/approvals`, { headers: { 'X-KaiSign-Token': gateway.token, Origin: 'chrome-extension://abc' } })).status).toBe(403);
    expect((await fetch(`${base}/approvals`, { headers: { 'X-KaiSign-Token': gateway.token } })).status).toBe(200);
    const page = await fetch(`${base}/`);
    expect(page.headers.get('x-frame-options')).toBe('DENY');
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });
});
