import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Interface } from 'ethers';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

// Practical nested transaction:
// EntryPoint.handleOps -> LightAccount.executeBatch -> USDC approve + LI.FI swap -> Uniswap exactInputSingle + USDC transfer
const entryPoint = '0x0000000071727de22e5e9d8baf0edac6f37da032';
const account = '0x8E8e658E22B12ada97B402fF0b044D6A325013C7';
const lifi = '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE';
const uniswap = '0x68b3465833fb72a70ecdf485e0e4c7bd8665fc45';
const usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const weth = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const spender = '0x3333333333333333333333333333333333333333';
const recipient = '0x2222222222222222222222222222222222222222';
const beneficiary = '0x1111111111111111111111111111111111111111';
const chainId = 1;

async function metadataAbi(path) {
  const metadata = JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
  return metadata.context.contract.abi;
}

const erc20 = new Interface(await metadataAbi('../metadata/tokens/usdc.json'));
const lightAccount = new Interface(await metadataAbi('../metadata/aa/alchemy-light-account-v2.json'));
const entry = new Interface(await metadataAbi('../metadata/aa/erc4337-entrypoint-v07.json'));
const lifiIface = new Interface(await metadataAbi('../metadata/protocols/lifi-diamond.json'));
const uni = new Interface(await metadataAbi('../metadata/dex/uniswap-v3-swap-router-02-ethereum.json'));

const approve1000Usdc = erc20.encodeFunctionData('approve', [spender, 1_000_000_000n]);
const transfer10Usdc = erc20.encodeFunctionData('transfer', [recipient, 10_000_000n]);

const uniSwap = uni.encodeFunctionData('exactInputSingle', [[
  usdc,
  weth,
  500,
  account,
  500_000_000n,
  490_000_000_000_000_000n,
  0
]]);

const txId = '0xabcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234abcd1234';
const swapData = [
  uniswap, // callTo
  uniswap, // approveTo
  usdc, // sendingAssetId/fromAssetId
  weth, // receivingAssetId/toAssetId
  500_000_000n, // fromAmount
  uniSwap, // callData
  true // requiresDeposit
];

const lifiSwap = lifiIface.encodeFunctionData('swapTokensSingleV3ERC20ToERC20(bytes32,string,string,address,uint256,(address,address,address,address,uint256,bytes,bool))', [
  txId,
  'uniswap',
  'kaisign-demo',
  account,
  500_000_000n,
  swapData
]);

const batch = lightAccount.encodeFunctionData('executeBatch(address[],uint256[],bytes[])', [
  [usdc, lifi, usdc],
  [0n, 0n, 0n],
  [approve1000Usdc, lifiSwap, transfer10Usdc]
]);

// EntryPoint v0.7 PackedUserOperation tuple:
// (sender,nonce,initCode,callData,accountGasLimits,preVerificationGas,gasFees,paymasterAndData,signature)
const pack128 = (hi, lo) => '0x' + ((BigInt(hi) << 128n) | BigInt(lo)).toString(16).padStart(64, '0');
const userOp = [
  account,
  0n,
  '0x',
  batch,
  pack128(150_000n, 1_000_000n),
  50_000n,
  pack128(1_000_000_000n, 30_000_000_000n),
  '0x',
  '0x'
];

const tx = {
  to: entryPoint,
  data: entry.encodeFunctionData('handleOps', [[userOp], beneficiary]),
  value: '0',
  chainId
};

const expectedSelectors = {
  entryPoint: '0x765e827f',
  lightAccountBatch: '0x47e1da2a',
  lifiSwap: '0x4666fc80',
  uniswapSwap: '0x04e45aaf',
  usdcApprove: '0x095ea7b3',
  usdcTransfer: '0xa9059cbb'
};
const actualSelectors = {
  entryPoint: tx.data.slice(0, 10),
  lightAccountBatch: batch.slice(0, 10),
  lifiSwap: lifiSwap.slice(0, 10),
  uniswapSwap: uniSwap.slice(0, 10),
  usdcApprove: approve1000Usdc.slice(0, 10),
  usdcTransfer: transfer10Usdc.slice(0, 10)
};
for (const [name, expected] of Object.entries(expectedSelectors)) {
  if (actualSelectors[name] !== expected) {
    throw new Error(`${name} selector mismatch: expected ${expected}, got ${actualSelectors[name]}`);
  }
}

const compressedTx = gzipSync(Buffer.from(JSON.stringify(tx))).toString('base64');

async function startMetadataApi() {
  const files = new Map([
    [entryPoint.toLowerCase(), '../metadata/aa/erc4337-entrypoint-v07.json'],
    [account.toLowerCase(), '../metadata/aa/alchemy-light-account-v2.json'],
    [usdc.toLowerCase(), '../metadata/tokens/usdc.json'],
    [lifi.toLowerCase(), '../metadata/protocols/lifi-diamond.json'],
    [uniswap.toLowerCase(), '../metadata/dex/uniswap-v3-swap-router-02-ethereum.json']
  ]);

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const match = url.pathname.match(/^\/api\/py\/contract\/(0x[a-fA-F0-9]{40})$/);
    if (!match) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'not_found' }));
      return;
    }

    const file = files.get(match[1].toLowerCase());
    if (!file) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'subgraph_not_found' }));
      return;
    }

    const metadata = JSON.parse(await readFile(new URL(file, import.meta.url), 'utf8'));
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ success: true, metadata }));
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  return { server, url: `http://127.0.0.1:${address.port}` };
}

const localApi = await startMetadataApi();
const client = new Client({ name: 'practical-deep-transaction-test', version: '1.0.0' }, { capabilities: {} });
const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js'],
  stderr: 'inherit',
  env: { ...process.env }
});
await client.connect(transport);
try {
  const result = await client.callTool({ name: 'clear_sign_payload', arguments: { payloadGzipBase64: compressedTx, compact: true } });
  const parsed = JSON.parse(result.content[0].text);
  console.log(JSON.stringify({
    mcpToolCall: { name: 'clear_sign_payload', arguments: { payloadGzipBase64Bytes: Buffer.byteLength(compressedTx), compact: true } },
    selectors: actualSelectors,
    dataBytes: (tx.data.length - 2) / 2,
    dataHash: `0x${createHash('sha256').update(tx.data).digest('hex')}`,
    intent: parsed.clearSign.intent,
    aggregatedIntent: parsed.clearSign.aggregatedIntent,
    fullyDecoded: parsed.clearSign.fullyDecoded,
    requiresHumanReview: parsed.clearSign.requiresHumanReview,
    safeToAutonomouslySign: parsed.clearSign.safeToAutonomouslySign,
    nestedIntents: parsed.clearSign.nestedIntents,
    nestedCalls: parsed.clearSign.nestedCalls,
    warnings: parsed.clearSign.warnings,
    signingPolicy: parsed.signingPolicy
  }, null, 2));
} finally {
  await client.close();
  localApi.server.close();
}
