import { AbiCoder, Interface } from 'ethers';

// Practical deep payload built only from metadata already present in this repo.
// No self-referential account.execute(account, ...) nesting.
// Shape:
//   EntryPoint.handleOps(PackedUserOperation[])
//     -> each UserOperation.callData targets sender LightAccount
//       -> LightAccount.executeBatch(address[] dest,uint256[] value,bytes[] func)
//         -> USDC.approve(Uniswap Universal Router, amount)
//         -> Uniswap Universal Router.execute(commands, inputs, deadline)
//            -> V2_SWAP_EXACT_IN command input
//            -> SWEEP command input
//         -> USDC.transfer(recipient, amount)
//
// This is the kind of AA + protocol-router + token batch where an LLM tends to hallucinate
// because the same payload contains tuple arrays, parallel arrays, embedded calldata, command
// bytes, ABI-encoded command inputs, and terminal ERC20 operations.

const chainId = 1;
const entryPoint = '0x0000000071727de22e5e9d8baf0edac6f37da032';
const accountA = '0x8E8e658E22B12ada97B402fF0b044D6A325013C7';
const accountB = '0x7777777777777777777777777777777777777777';
const usdc = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const dai = '0x6b175474e89094c44da98b954eedeac495271d0f';
const universalRouter = '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad';
const recipient = '0x2222222222222222222222222222222222222222';
const beneficiary = '0x9999999999999999999999999999999999999999';
const deadline = 1893456000n; // 2030-01-01T00:00:00Z

const abi = AbiCoder.defaultAbiCoder();
const erc20 = new Interface([
  'function approve(address spender,uint256 amount)',
  'function transfer(address to,uint256 amount)'
]);
const lightAccount = new Interface([
  'function executeBatch(address[] dest,uint256[] value,bytes[] func)'
]);
const router = new Interface([
  'function execute(bytes commands,bytes[] inputs,uint256 deadline)'
]);
const entryPointIface = new Interface([
  'function handleOps((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature)[] ops,address beneficiary)'
]);

function v2SwapExactInInput(amountIn, amountOutMin, payerIsUser = true) {
  return abi.encode(
    ['address', 'uint256', 'uint256', 'address[]', 'bool'],
    [recipient, amountIn, amountOutMin, [usdc, dai], payerIsUser]
  );
}

function sweepInput(token, to, amountMin) {
  return abi.encode(['address', 'address', 'uint256'], [token, to, amountMin]);
}

function buildRouterSwap(amountIn, minDaiOut, sweepMin) {
  // 0x08 = V2_SWAP_EXACT_IN, 0x04 = SWEEP per backend universalRouterCommands registry.
  return router.encodeFunctionData('execute', [
    '0x0804',
    [v2SwapExactInInput(amountIn, minDaiOut), sweepInput(dai, recipient, sweepMin)],
    deadline
  ]);
}

function buildAccountBatch({ approveAmount, swapAmount, minDaiOut, sweepMin, transferAmount }) {
  const approveRouter = erc20.encodeFunctionData('approve', [universalRouter, approveAmount]);
  const routerSwap = buildRouterSwap(swapAmount, minDaiOut, sweepMin);
  const transferUsdc = erc20.encodeFunctionData('transfer', [recipient, transferAmount]);

  return lightAccount.encodeFunctionData('executeBatch', [
    [usdc, universalRouter, usdc],
    [0n, 0n, 0n],
    [approveRouter, routerSwap, transferUsdc]
  ]);
}

function packedUserOp(sender, nonce, callData) {
  return {
    sender,
    nonce,
    initCode: '0x',
    callData,
    // verificationGasLimit || callGasLimit as bytes16+bytes16 for EntryPoint v0.7 PackedUserOperation.
    accountGasLimits: '0x00000000000000000000000000030d400000000000000000000000000007a120',
    preVerificationGas: 75_000n,
    // maxPriorityFeePerGas || maxFeePerGas as bytes16+bytes16.
    gasFees: '0x00000000000000000000000059682f00000000000000000000000000b2d05e00',
    paymasterAndData: '0x',
    signature: '0x' + '11'.repeat(65)
  };
}

const accountABatch = buildAccountBatch({
  approveAmount: 1_000_000_000n,      // 1,000 USDC
  swapAmount: 250_000_000n,           // 250 USDC
  minDaiOut: 240_000000000000000000n, // 240 DAI
  sweepMin: 1n,
  transferAmount: 10_000_000n         // 10 USDC
});

const accountBBatch = buildAccountBatch({
  approveAmount: 500_000_000n,        // 500 USDC
  swapAmount: 125_000_000n,           // 125 USDC
  minDaiOut: 120_000000000000000000n, // 120 DAI
  sweepMin: 1n,
  transferAmount: 5_000_000n          // 5 USDC
});

const ops = [
  packedUserOp(accountA, 42n, accountABatch),
  packedUserOp(accountB, 43n, accountBBatch)
];

const tx = {
  to: entryPoint,
  data: entryPointIface.encodeFunctionData('handleOps', [ops, beneficiary]),
  value: '0',
  chainId
};

const endpoint = process.argv[2];
if (!endpoint) throw new Error('usage: node scripts/test-deep-http-payload.mjs http://127.0.0.1:3333/mcp');

let init = await fetch(endpoint, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'real-aa-entrypoint-router-batch-http-test', version: '1' } } })
});
const sid = init.headers.get('mcp-session-id');
if (!init.ok || !sid) throw new Error(`init failed ${init.status} ${await init.text()}`);

let call = await fetch(endpoint, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'accept': 'application/json', 'mcp-session-id': sid },
  body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'clear_sign_payload', arguments: tx } })
});
const json = await call.json();
if (json.error) throw new Error(JSON.stringify(json.error));
const parsed = JSON.parse(json.result.content[0].text);
console.log(JSON.stringify({
  mcpToolCall: { name: 'clear_sign_payload', arguments: tx },
  practicalShape: 'EntryPoint.handleOps -> LightAccount.executeBatch -> [USDC.approve, UniversalRouter.execute(commands), USDC.transfer]',
  metadataUsed: [
    'metadata/aa/erc4337-entrypoint-v07.json',
    'metadata/aa/alchemy-light-account-v2.json',
    'metadata/protocols/uniswap-universal-router.json',
    'metadata/tokens/usdc.json',
    'metadata/tokens/dai.json'
  ],
  userOps: ops.length,
  calldataBytes: (tx.data.length - 2) / 2,
  intent: parsed.clearSign.intent,
  aggregatedIntent: parsed.clearSign.aggregatedIntent,
  fullyDecoded: parsed.clearSign.fullyDecoded,
  requiresHumanReview: parsed.clearSign.requiresHumanReview,
  safeToAutonomouslySign: parsed.clearSign.safeToAutonomouslySign,
  nestedIntents: parsed.clearSign.nestedIntents,
  nestedCalls: parsed.clearSign.nestedCalls?.map(c => ({ target: c.target, selector: c.selector, functionName: c.functionName, intent: c.intent, success: c.success })),
  warnings: parsed.clearSign.warnings,
  signingPolicy: parsed.signingPolicy
}, null, 2));
