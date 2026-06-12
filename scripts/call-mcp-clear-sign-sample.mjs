#!/usr/bin/env node
/**
 * Human CLI test for KaiSign MCP clear_sign_payload.
 *
 * Default sample is a legit USDC transfer built from:
 *   metadata/tokens/usdc.json
 *
 * Usage:
 *   npm run build
 *   node scripts/call-mcp-clear-sign-sample.mjs
 *
 * Or paste your own payload:
 *   echo '{"to":"0x...","data":"0x...","value":"0","chainId":1}' | node scripts/call-mcp-clear-sign-sample.mjs
 *   echo '{"rawTx":"0x02f8..."}' | node scripts/call-mcp-clear-sign-sample.mjs
 */

import { readFileSync } from 'node:fs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const DEFAULT_PAYLOAD = {
  // USD Coin, from metadata/tokens/usdc.json
  to: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
  // transfer(address,uint256)
  // recipient: 0x2222222222222222222222222222222222222222
  // amount:    10 USDC = 10_000_000 base units, USDC decimals = 6
  data: '0xa9059cbb00000000000000000000000022222222222222222222222222222222222222220000000000000000000000000000000000000000000000000000000000989680',
  value: '0',
  chainId: 1
};

function readPayload() {
  if (process.stdin.isTTY) return DEFAULT_PAYLOAD;

  const stdin = readFileSync(0, 'utf8').trim();
  if (!stdin) return DEFAULT_PAYLOAD;

  return JSON.parse(stdin);
}

const payload = readPayload();

const client = new Client(
  { name: 'kaisign-human-cli-test', version: '1.0.0' },
  { capabilities: {} }
);

const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js'],
  stderr: 'ignore'
});

await client.connect(transport);

const result = await client.callTool({
  name: 'clear_sign_payload',
  arguments: payload
});

await client.close();

console.log(result.content[0].text);
