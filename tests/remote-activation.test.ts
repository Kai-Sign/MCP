import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zeroPadValue, toBeHex } from 'ethers';
import { WalletRpcGateway, NOT_ACTIVATED } from '../src/wallet-rpc.js';
import { ActivationManager, DEFAULT_FEE_TOKENS, TRANSFER_TOPIC, eip681Transfer, type Rpc } from '../src/services/activation.js';

const RPC_TOKEN = 'r'.repeat(40);
const APPROVAL_KEY = 'k'.repeat(40);
const RECIPIENT = '0x9999999999999999999999999999999999999999';
const PAYER = '0x7777777777777777777777777777777777777777';
const USDC = DEFAULT_FEE_TOKENS[1].address;

interface Chain { head: number; logs: Array<{ address: string; topics: string[]; data: string; blockNumber: string; transactionHash: string }>; getLogsSpans: number[] }

function rpcFor(chain: Chain): Rpc {
  return (async (method: string, params: any[]) => {
    if (method === 'eth_chainId') return '0x1';
    if (method === 'eth_blockNumber') return '0x' + chain.head.toString(16);
    if (method === 'eth_getLogs') {
      const f = params[0];
      const from = Number(BigInt(f.fromBlock)); const to = Number(BigInt(f.toBlock));
      chain.getLogsSpans.push(to - from + 1);
      return chain.logs.filter(l => {
        const n = Number(BigInt(l.blockNumber));
        return n >= from && n <= to && l.address.toLowerCase() === f.address.toLowerCase()
          && l.topics[0] === f.topics[0] && l.topics[2] === f.topics[2];
      });
    }
    throw new Error('unexpected ' + method);
  }) as Rpc;
}

function transferLog(block: number, units: bigint, to = RECIPIENT) {
  return {
    address: USDC,
    topics: [TRANSFER_TOPIC, zeroPadValue(PAYER, 32).toLowerCase(), zeroPadValue(to, 32).toLowerCase()],
    data: toBeHex(units, 32),
    blockNumber: '0x' + block.toString(16),
    transactionHash: '0x' + block.toString(16).padStart(64, '0')
  };
}

describe('on-chain activation fee', () => {
  let chain: Chain;
  let stateFile: string;

  beforeEach(() => {
    chain = { head: 1000, logs: [], getLogsSpans: [] };
    stateFile = join(mkdtempSync(join(tmpdir(), 'kaisign-act-')), 'activation.json');
  });

  it('asks for a unique USDC amount and activates on the exact payment only', async () => {
    const manager = new ActivationManager(rpcFor(chain), { recipient: RECIPIENT, amount: '10' }, stateFile, () => {});
    await manager.init();
    const status = manager.status();
    expect(status.active).toBe(false);
    expect(status.symbol).toBe('USDC');
    const units = BigInt(status.amountUnits!);
    expect(units > 10_000_000n && units < 10_010_000n).toBe(true);
    expect(status.links!.eip681).toBe(eip681Transfer(USDC, 1, RECIPIENT, status.amountUnits!));

    // Old payment (before the node existed), wrong amount, wrong recipient: none count.
    chain.logs.push(transferLog(900, units), transferLog(1200, 10_000_000n), transferLog(1300, units, PAYER));
    chain.head = 2400;
    await manager.poll();
    expect(manager.active).toBe(false);
    expect(Math.max(...chain.getLogsSpans)).toBeLessThanOrEqual(512);

    chain.logs.push(transferLog(2500, units));
    chain.head = 2600;
    await manager.poll();
    expect(manager.active).toBe(true);
    expect(manager.status().activated).toMatchObject({ blockNumber: 2500, from: PAYER });
    expect(JSON.parse(readFileSync(stateFile, 'utf8')).activated.blockNumber).toBe(2500);

    // Survives a restart without paying again.
    const restarted = new ActivationManager(rpcFor(chain), { recipient: RECIPIENT, amount: '10' }, stateFile, () => {});
    await restarted.init();
    expect(restarted.active).toBe(true);
  });

  it('is not required without a fee recipient', () => {
    const manager = new ActivationManager(rpcFor(chain), undefined, stateFile, () => {});
    expect(manager.active).toBe(true);
    expect(manager.status()).toEqual({ required: false, active: true });
  });
});

describe('remote mode gateway', () => {
  let upstream: Server;
  let gateway: WalletRpcGateway;
  let base: string;
  let chain: Chain;

  beforeEach(async () => {
    chain = { head: 1000, logs: [], getLogsSpans: [] };
    upstream = createServer((req, res) => {
      let body = '';
      req.on('data', c => { body += c; });
      req.on('end', () => {
        const { id, method } = JSON.parse(body);
        res.end(JSON.stringify({ jsonrpc: '2.0', id, result: method === 'eth_chainId' ? '0x1' : '0x10' }));
      });
    });
    await new Promise<void>(r => upstream.listen(0, '127.0.0.1', () => r()));
    const a = upstream.address();
    const activation = new ActivationManager(rpcFor(chain), { recipient: RECIPIENT, amount: '10' },
      join(mkdtempSync(join(tmpdir(), 'kaisign-gw-')), 'activation.json'), () => {});
    await activation.init();
    gateway = new WalletRpcGateway({
      upstream: `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`,
      remote: { rpcToken: RPC_TOKEN, approvalKey: APPROVAL_KEY },
      activation,
      clearSign: async () => ({ verdict: 'review', reason: '', intent: '', text: '', warnings: [] }),
      log: () => {}
    });
    const { port } = await gateway.listen(0);
    base = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    await gateway.close();
    await new Promise<void>(r => upstream.close(() => r()));
  });

  const rpc = (path: string, method: string, host = 'kaisign.tail1234.ts.net') =>
    fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', Host: host }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params: [] }) });

  it('rejects weak or reused secrets', () => {
    expect(() => new WalletRpcGateway({ upstream: 'http://x', remote: { rpcToken: 'short', approvalKey: APPROVAL_KEY } })).toThrow();
    expect(() => new WalletRpcGateway({ upstream: 'http://x', remote: { rpcToken: APPROVAL_KEY, approvalKey: APPROVAL_KEY } })).toThrow();
  });

  it('serves JSON-RPC only on the secret path', async () => {
    expect((await rpc('/', 'eth_chainId')).status).toBe(404);
    expect((await rpc('/rpc/' + 'x'.repeat(40), 'eth_chainId')).status).toBe(404);
    const ok = await (await rpc('/rpc/' + RPC_TOKEN, 'eth_chainId')).json();
    expect(ok.result).toBe('0x1');
  });

  it('keeps the RPC closed until the activation fee is paid on-chain', async () => {
    const closed = await (await rpc('/rpc/' + RPC_TOKEN, 'eth_blockNumber')).json();
    expect(closed.error.code).toBe(NOT_ACTIVATED);

    const status = await (await fetch(`${base}/a/${APPROVAL_KEY}/activation`, { headers: { 'X-KaiSign-Token': APPROVAL_KEY } })).json();
    chain.logs.push(transferLog(1100, BigInt(status.amountUnits)));
    chain.head = 1200;
    // Reach the manager through the same status endpoint the page polls.
    await (gateway as any).options.activation.poll();

    const open = await (await rpc('/rpc/' + RPC_TOKEN, 'eth_blockNumber')).json();
    expect(open.result).toBe('0x10');
  });

  it('protects the owner page with the approval key, not the wallet token', async () => {
    expect((await fetch(`${base}/a/${RPC_TOKEN}/`)).status).toBe(404);
    const page = await fetch(`${base}/a/${APPROVAL_KEY}/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain(JSON.stringify(`/a/${APPROVAL_KEY}`));
    expect((await fetch(`${base}/a/${APPROVAL_KEY}/approvals`)).status).toBe(403);
    expect((await fetch(`${base}/a/${APPROVAL_KEY}/approvals`, { headers: { 'X-KaiSign-Token': APPROVAL_KEY } })).status).toBe(200);
    const qr = await fetch(`${base}/a/${APPROVAL_KEY}/activation/qr.svg`);
    expect(qr.headers.get('content-type')).toBe('image/svg+xml');
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });
});
