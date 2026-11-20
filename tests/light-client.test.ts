import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { Interface } from 'ethers';
import { LIGHT_CLIENT_MAX_LOG_RANGE, LightClientRegistry, parseLightClientConfig } from '../src/services/light-client.js';
import { OnChainVerifier } from '../src/services/onchain-verifier.js';
import { KAISIGN_SMT_SEED_FILE } from '../src/config/constants.js';

const seed = JSON.parse(readFileSync(KAISIGN_SMT_SEED_FILE, 'utf8'));
const iface = new Interface(['function smtRoot() view returns (bytes32)']);

interface Call { method: string; params: any[] }

/** Minimal stand-in for the Nethermind light client JSON-RPC on Sepolia. */
function mockLightClient(calls: Call[]) {
  const head = seed.fromBlock + 1500;
  return createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => {
      const { id, method, params } = JSON.parse(body);
      calls.push({ method, params });
      let result: unknown;
      let error: { code: number; message: string } | undefined;
      switch (method) {
        case 'eth_chainId': result = '0xaa36a7'; break;
        case 'eth_blockNumber': result = '0x' + head.toString(16); break;
        case 'eth_getLogs': {
          const span = Number(BigInt(params[0].toBlock) - BigInt(params[0].fromBlock)) + 1;
          if (span > LIGHT_CLIENT_MAX_LOG_RANGE) error = { code: -32005, message: 'log range exceeds 512 blocks' };
          else result = [];
          break;
        }
        case 'eth_call':
          result = iface.encodeFunctionResult('smtRoot', [seed.root]);
          break;
        default: error = { code: -32601, message: 'method not found' };
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(error ? { jsonrpc: '2.0', id, error } : { jsonrpc: '2.0', id, result }));
    });
  });
}

describe('light client config', () => {
  it('parses bare and chain-pinned URLs', () => {
    expect(parseLightClientConfig('http://127.0.0.1:8545, 1=http://127.0.0.1:8555')).toEqual([
      { url: 'http://127.0.0.1:8545' },
      { chainId: 1, url: 'http://127.0.0.1:8555' }
    ]);
    expect(parseLightClientConfig(undefined)).toEqual([]);
  });
});

describe('verifier through a light client', () => {
  const calls: Call[] = [];
  let server: Server;
  let url: string;

  beforeAll(async () => {
    server = mockLightClient(calls);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
    const address = server.address();
    url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });
  afterAll(() => new Promise<void>(r => server.close(() => r())));

  it('detects the chain with eth_chainId', async () => {
    const registry = new LightClientRegistry([{ url }]);
    expect(await registry.urlFor(11155111)).toBe(url);
    expect(await registry.urlFor(1)).toBeUndefined();
  });

  it('verifies registry state only through the light client, in 512-block log chunks', async () => {
    const lightClients = new LightClientRegistry([{ url }]);
    // Unreachable public fallbacks: any request that leaks there fails the test.
    const verifier = new OnChainVerifier({ lightClients, rpcUrls: ['http://127.0.0.1:1'] });
    const leaf = seed.leaves[0];

    const result = await verifier.verifyMetadata(leaf.target, leaf.chainId);

    expect(result.source).toBe('leaf-verified');
    expect(result.verified).toBe(true);
    expect(result.registryReadVia).toBe('light-client');
    expect(result.details).toContain('Nethermind light client');

    const logCalls = calls.filter(c => c.method === 'eth_getLogs');
    expect(logCalls.length).toBeGreaterThan(1);
    for (const c of logCalls) {
      const span = Number(BigInt(c.params[0].toBlock) - BigInt(c.params[0].fromBlock)) + 1;
      expect(span).toBeLessThanOrEqual(LIGHT_CLIENT_MAX_LOG_RANGE);
    }
    // smtRoot is read at the synced block (inside the light client's 32-ancestor window).
    const rootCall = calls.find(c => c.method === 'eth_call');
    expect(rootCall?.params[1]).toMatch(/^0x[0-9a-f]+$/);
  });
});
