import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Interface } from 'ethers';
import { cacheManager } from '../../src/services/cache-manager.js';
import { RecursiveCalldataDecoder } from '../../src/services/recursive-decoder.js';
import { decodeTransaction } from '../../src/tools/decode-transaction.js';
import { getClearSignPrompt } from '../../src/tools/get-clear-sign-prompt.js';
import { onChainVerifier } from '../../src/services/onchain-verifier.js';
import type { ContractMetadata } from '../../src/services/metadata-service.js';

const chainId = 31337;
const erc20 = '0x1000000000000000000000000000000000000001';
const wrapper = '0x2000000000000000000000000000000000000002';
const batcher = '0x3000000000000000000000000000000000000003';
const router = '0x4000000000000000000000000000000000000004';
const unknown = '0x5000000000000000000000000000000000000005';
const recipient = '0x6000000000000000000000000000000000000006';

const verified = {
  verified: true,
  source: 'leaf-verified' as const,
  details: 'test verified',
  hash: '0xhash',
  onChainHash: '0xhash',
  uid: '0xuid',
  attestationComponents: { chainId, extcodehash: '0xcode', metadataHash: '0xmeta', idx: 1, revoked: false }
};

const erc20Iface = new Interface(['function transfer(address to,uint256 amount)']);
const wrapperIface = new Interface([
  'function execute(address target,bytes callData,uint256 value)',
  'function relay(address recipient,bytes payload)'
]);
const batchIface = new Interface(['function batch(tuple(address target,bytes callData,uint256 value)[] calls)']);
const parallelBatchIface = new Interface(['function executeBatch(address[] dest,uint256[] value,bytes[] func)']);
const routerIface = new Interface(['function execute(bytes commands,bytes[] inputs)']);

function sig(fragment: string): string {
  return fragment.replace('function ', '');
}

function metadata(name: string, abi: any[], formats: Record<string, any>, extra: Partial<ContractMetadata> = {}): ContractMetadata {
  return {
    context: { contract: { name, abi } },
    metadata: { name },
    display: { formats },
    _verification: verified,
    ...extra
  } as ContractMetadata;
}

function seed(address: string, data: ContractMetadata) {
  cacheManager.setMetadata(address.toLowerCase(), chainId, data);
}

function erc20Metadata(): ContractMetadata {
  return metadata('TestToken', [
    { type: 'function', name: 'transfer', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }] }
  ], {
    'transfer(address,uint256)': {
      intent: 'Transfer {amount} tokens to {to}',
      fields: [{ path: 'to', label: 'To' }, { path: 'amount', label: 'Amount' }]
    }
  });
}

beforeEach(() => {
  cacheManager.clearAll();
  vi.restoreAllMocks();
  vi.spyOn(onChainVerifier, 'verifyMetadata').mockResolvedValue(verified);
});

describe('RecursiveCalldataDecoder', () => {
  it('decodes simple ERC20 transfer without inventing recursive calls', async () => {
    seed(erc20, erc20Metadata());
    const data = erc20Iface.encodeFunctionData('transfer', [recipient, 123n]);

    const decoded = await new RecursiveCalldataDecoder().decode(data, erc20, chainId);

    expect(decoded.root.success).toBe(true);
    expect(decoded.root.functionName).toBe('transfer');
    expect(decoded.callTree.children).toEqual([]);
    expect(decoded.nestedCalls).toEqual([]);
    expect(decoded.nestedIntents).toEqual([]);
    expect(decoded.hasUnknownInnerCalls).toBe(false);
  });

  it('decodes one inner calldata field only when metadata defines calldataPath and targetPath', async () => {
    seed(erc20, erc20Metadata());
    seed(wrapper, metadata('Wrapper', [
      { type: 'function', name: 'execute', inputs: [
        { name: 'target', type: 'address' },
        { name: 'callData', type: 'bytes' },
        { name: 'value', type: 'uint256' }
      ] }
    ], {
      'execute(address,bytes,uint256)': {
        intent: 'Execute verified inner call',
        recursive: [{ type: 'calldata', calldataPath: 'callData', targetPath: 'target', valuePath: 'value' }]
      }
    }));
    const inner = erc20Iface.encodeFunctionData('transfer', [recipient, 123n]);
    const outer = wrapperIface.encodeFunctionData('execute', [erc20, inner, 0n]);

    const decoded = await new RecursiveCalldataDecoder().decode(outer, wrapper, chainId);

    expect(decoded.callTree.children).toHaveLength(1);
    expect(decoded.callTree.children[0].target).toBe(erc20.toLowerCase());
    expect(decoded.callTree.children[0].functionName).toBe('transfer');
    expect(decoded.nestedIntents).toContain('Transfer 123 tokens to 0x6000000000000000000000000000000000000006');
  });

  it('decodes metadata-defined batch callsPath with multiple inner calls', async () => {
    seed(erc20, erc20Metadata());
    seed(batcher, metadata('Batcher', [
      { type: 'function', name: 'batch', inputs: [{ name: 'calls', type: 'tuple[]', components: [
        { name: 'target', type: 'address' },
        { name: 'callData', type: 'bytes' },
        { name: 'value', type: 'uint256' }
      ] }] }
    ], {
      'batch(tuple[])': {
        intent: 'Execute batch',
        recursive: [{ type: 'calls', callsPath: 'calls', targetPath: 'target', calldataPath: 'callData', valuePath: 'value' }]
      }
    }));
    const inner1 = erc20Iface.encodeFunctionData('transfer', [recipient, 1n]);
    const inner2 = erc20Iface.encodeFunctionData('transfer', [recipient, 2n]);
    const outer = batchIface.encodeFunctionData('batch', [[
      [erc20, inner1, 0n],
      [erc20, inner2, 0n]
    ]]);

    const decoded = await new RecursiveCalldataDecoder().decode(outer, batcher, chainId);

    expect(decoded.callTree.children.map(c => c.functionName)).toEqual(['transfer', 'transfer']);
    expect(decoded.nestedIntents).toEqual([
      'Transfer 1 tokens to 0x6000000000000000000000000000000000000006',
      'Transfer 2 tokens to 0x6000000000000000000000000000000000000006'
    ]);
  });

  it('decodes metadata-defined parallel AA executeBatch arrays into actual inner intents', async () => {
    seed(erc20, erc20Metadata());
    seed(batcher, metadata('LightAccountLike', [
      { type: 'function', name: 'executeBatch', inputs: [
        { name: 'dest', type: 'address[]' },
        { name: 'value', type: 'uint256[]' },
        { name: 'func', type: 'bytes[]' }
      ] }
    ], {
      'executeBatch(address[],uint256[],bytes[])': {
        intent: 'Execute batch transactions via LightAccountLike',
        recursive: [{ type: 'parallelCalls', targetPath: 'dest', valuePath: 'value', calldataPath: 'func' }]
      }
    }));
    const approveIface = new Interface(['function approve(address spender,uint256 amount)']);
    seed(unknown, metadata('ApprovalToken', [
      { type: 'function', name: 'approve', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }] }
    ], {
      'approve(address,uint256)': { intent: 'Approve {amount} tokens to {spender}', fields: [{ path: 'spender', label: 'Spender' }, { path: 'amount', label: 'Amount' }] }
    }));
    const inner1 = approveIface.encodeFunctionData('approve', [recipient, 1000n]);
    const inner2 = erc20Iface.encodeFunctionData('transfer', [recipient, 10n]);
    const outer = parallelBatchIface.encodeFunctionData('executeBatch', [[unknown, erc20], [0n, 0n], [inner1, inner2]]);

    const decoded = await new RecursiveCalldataDecoder().decode(outer, batcher, chainId);

    expect(decoded.callTree.children.map(c => c.functionName)).toEqual(['approve', 'transfer']);
    expect(decoded.nestedIntents).toEqual([
      'Approve 1000 tokens to 0x6000000000000000000000000000000000000006',
      'Transfer 10 tokens to 0x6000000000000000000000000000000000000006'
    ]);
    expect(decoded.aggregatedIntent).toContain('Approve 1000 tokens');
    expect(decoded.aggregatedIntent).toContain('Transfer 10 tokens');
  });

  it('decodes command registry commands only from metadata.commandRegistries and recursive command rules', async () => {
    seed(erc20, erc20Metadata());
    seed(router, metadata('RouterLike', [
      { type: 'function', name: 'execute', inputs: [
        { name: 'commands', type: 'bytes' },
        { name: 'inputs', type: 'bytes[]' }
      ] }
    ], {
      'execute(bytes,bytes[])': {
        intent: 'Execute metadata commands',
        recursive: [{ type: 'commands', commandRegistry: 'testRegistry', commandPath: 'commands', inputPath: 'inputs' }]
      }
    }, {
      commandRegistries: {
        testRegistry: {
          '0x01': {
            name: 'CALL',
            intent: 'Run registered call to {target}',
            inputs: [{ name: 'target', type: 'address' }, { name: 'callData', type: 'bytes' }],
            recursive: [{ type: 'calldata', targetPath: 'target', calldataPath: 'callData' }]
          }
        }
      }
    }));
    const inner = erc20Iface.encodeFunctionData('transfer', [recipient, 5n]);
    const input = '0x' + new Interface(['function decode(address target,bytes callData)']).encodeFunctionData('decode', [erc20, inner]).slice(10);
    const outer = routerIface.encodeFunctionData('execute', ['0x01', [input]]);

    const decoded = await new RecursiveCalldataDecoder().decode(outer, router, chainId);

    expect(decoded.root.decodedCommands?.[0].name).toBe('CALL');
    expect(decoded.callTree.children[0].functionName).toBe('transfer');
    expect(decoded.aggregatedIntent).toContain('Transfer 5 tokens');
  });

  it('surfaces unknown inner selector and rejects autonomous signing', async () => {
    seed(wrapper, metadata('Wrapper', [
      { type: 'function', name: 'execute', inputs: [
        { name: 'target', type: 'address' },
        { name: 'callData', type: 'bytes' },
        { name: 'value', type: 'uint256' }
      ] }
    ], {
      'execute(address,bytes,uint256)': {
        intent: 'Execute verified inner call',
        recursive: [{ type: 'calldata', calldataPath: 'callData', targetPath: 'target' }]
      }
    }));
    const outer = wrapperIface.encodeFunctionData('execute', [unknown, '0x12345678', 0n]);

    const decoded = await new RecursiveCalldataDecoder().decode(outer, wrapper, chainId);
    const validation = await decodeTransaction({ to: wrapper, data: outer, chainId, value: '0' });

    expect(decoded.hasUnknownInnerCalls).toBe(true);
    expect(decoded.warnings.some(w => w.includes('unknown inner call') || w.includes('No metadata'))).toBe(true);
    expect(validation.hasUnknownInnerCalls).toBe(true);
    expect(validation.signing.verdict).toBe('reject');
  });

  it('does not treat same target and selector with different calldata as a cycle', async () => {
    seed(erc20, erc20Metadata());
    seed(wrapper, metadata('Wrapper', [
      { type: 'function', name: 'execute', inputs: [
        { name: 'target', type: 'address' },
        { name: 'callData', type: 'bytes' },
        { name: 'value', type: 'uint256' }
      ] }
    ], {
      'execute(address,bytes,uint256)': {
        intent: 'Execute nested call',
        recursive: [{ type: 'calldata', calldataPath: 'callData', targetPath: 'target', valuePath: 'value' }]
      }
    }));
    const transfer = erc20Iface.encodeFunctionData('transfer', [recipient, 42n]);
    const nested = wrapperIface.encodeFunctionData('execute', [erc20, transfer, 0n]);
    const outer = wrapperIface.encodeFunctionData('execute', [wrapper, nested, 0n]);

    const decoded = await new RecursiveCalldataDecoder().decode(outer, wrapper, chainId);

    expect(decoded.cycleDetected).toBe(false);
    expect(decoded.callTree.children[0].functionName).toBe('execute');
    expect(decoded.callTree.children[0].children[0].functionName).toBe('transfer');
    expect(decoded.nestedIntents).toContain('Transfer 42 tokens to 0x6000000000000000000000000000000000000006');
  });

  it('decodes very deep real wrapper nesting before terminal batch calls', async () => {
    seed(erc20, erc20Metadata());
    seed(wrapper, metadata('LightAccountLike', [
      { type: 'function', name: 'execute', inputs: [
        { name: 'dest', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'func', type: 'bytes' }
      ] },
      { type: 'function', name: 'executeBatch', inputs: [
        { name: 'dest', type: 'address[]' },
        { name: 'value', type: 'uint256[]' },
        { name: 'func', type: 'bytes[]' }
      ] }
    ], {
      'execute(address,uint256,bytes)': {
        intent: 'Execute nested LightAccount call',
        recursive: [{ type: 'calldata', calldataPath: 'func', targetPath: 'dest', valuePath: 'value' }]
      },
      'executeBatch(address[],uint256[],bytes[])': {
        intent: 'Execute LightAccount batch',
        recursive: [{ type: 'parallelCalls', targetPath: 'dest', valuePath: 'value', calldataPath: 'func' }]
      }
    }));

    const transfer1 = erc20Iface.encodeFunctionData('transfer', [recipient, 1n]);
    const transfer2 = erc20Iface.encodeFunctionData('transfer', [recipient, 2n]);
    let nested = parallelBatchIface.encodeFunctionData('executeBatch', [[erc20, erc20], [0n, 0n], [transfer1, transfer2]]);
    for (let i = 0; i < 25; i++) {
      nested = new Interface(['function execute(address dest,uint256 value,bytes func)']).encodeFunctionData('execute', [wrapper, 0n, nested]);
    }

    const decoded = await new RecursiveCalldataDecoder().decode(nested, wrapper, chainId);

    expect(decoded.truncated).toBe(false);
    expect(decoded.cycleDetected).toBe(false);
    expect(decoded.hasUnknownInnerCalls).toBe(false);
    expect(decoded.nestedIntents).toContain('Transfer 1 tokens to 0x6000000000000000000000000000000000000006');
    expect(decoded.nestedIntents).toContain('Transfer 2 tokens to 0x6000000000000000000000000000000000000006');
  });

  it('stops at maxDepth with truncated=true and warning', async () => {
    seed(wrapper, metadata('Wrapper', [
      { type: 'function', name: 'execute', inputs: [
        { name: 'target', type: 'address' },
        { name: 'callData', type: 'bytes' },
        { name: 'value', type: 'uint256' }
      ] }
    ], {
      'execute(address,bytes,uint256)': {
        intent: 'Execute depth',
        recursive: [{ type: 'calldata', calldataPath: 'callData', targetPath: 'target' }]
      }
    }));
    const secondWrapper = '0x7000000000000000000000000000000000000007';
    seed(secondWrapper, metadata('Wrapper2', [
      { type: 'function', name: 'execute', inputs: [
        { name: 'target', type: 'address' },
        { name: 'callData', type: 'bytes' },
        { name: 'value', type: 'uint256' }
      ] }
    ], {
      'execute(address,bytes,uint256)': {
        intent: 'Execute depth',
        recursive: [{ type: 'calldata', calldataPath: 'callData', targetPath: 'target' }]
      }
    }));
    const inner = erc20Iface.encodeFunctionData('transfer', [recipient, 1n]);
    const second = wrapperIface.encodeFunctionData('execute', [erc20, inner, 0n]);
    const data = wrapperIface.encodeFunctionData('execute', [secondWrapper, second, 0n]);

    const decoded = await new RecursiveCalldataDecoder({ maxDepth: 1 }).decode(data, wrapper, chainId);

    expect(decoded.truncated).toBe(true);
    expect(decoded.warnings.some(w => w.toLowerCase().includes('max depth'))).toBe(true);
  });

  it('does not scan random selector-like bytes when no recursive metadata exists', async () => {
    seed(wrapper, metadata('Wrapper', [
      { type: 'function', name: 'relay', inputs: [
        { name: 'recipient', type: 'address' },
        { name: 'payload', type: 'bytes' }
      ] }
    ], {
      'relay(address,bytes)': { intent: 'Relay opaque payload' }
    }));
    const payload = '0xa9059cbb' + '00'.repeat(64);
    const outer = wrapperIface.encodeFunctionData('relay', [recipient, payload]);

    const decoded = await new RecursiveCalldataDecoder().decode(outer, wrapper, chainId);

    expect(decoded.callTree.children).toEqual([]);
    expect(decoded.warnings.some(w => w.includes('a9059cbb'))).toBe(false);
  });

  it('does not guess recipient field is target without targetPath metadata', async () => {
    seed(erc20, erc20Metadata());
    seed(wrapper, metadata('Wrapper', [
      { type: 'function', name: 'relay', inputs: [
        { name: 'recipient', type: 'address' },
        { name: 'payload', type: 'bytes' }
      ] }
    ], {
      'relay(address,bytes)': {
        intent: 'Relay payload without target',
        recursive: [{ type: 'calldata', calldataPath: 'payload' }]
      }
    }));
    const inner = erc20Iface.encodeFunctionData('transfer', [recipient, 7n]);
    const outer = wrapperIface.encodeFunctionData('relay', [erc20, inner]);

    const decoded = await new RecursiveCalldataDecoder().decode(outer, wrapper, chainId);

    expect(decoded.callTree.children).toHaveLength(1);
    expect(decoded.callTree.children[0].target).toBe(wrapper.toLowerCase());
    expect(decoded.callTree.children[0].success).toBe(false);
    expect(decoded.hasUnknownInnerCalls).toBe(true);
  });

  it('decodes a UniversalRouter-like call only when metadata registry and recursive rules define command/input parsing', async () => {
    seed(router, metadata('OpaqueRouterLike', [
      { type: 'function', name: 'execute', inputs: [
        { name: 'commands', type: 'bytes' },
        { name: 'inputs', type: 'bytes[]' }
      ] }
    ], {
      'execute(bytes,bytes[])': { intent: 'Execute opaque command bytes' }
    }));
    const outer = routerIface.encodeFunctionData('execute', ['0x01', ['0x12345678']]);

    const decoded = await new RecursiveCalldataDecoder().decode(outer, router, chainId);

    expect(decoded.root.decodedCommands).toBeUndefined();
    expect(decoded.callTree.children).toEqual([]);
  });
});

describe('decode_transaction recursive output', () => {
  it('returns nested call tree, nested intents, aggregate intent, and warnings', async () => {
    seed(erc20, erc20Metadata());
    seed(wrapper, metadata('Wrapper', [
      { type: 'function', name: 'execute', inputs: [
        { name: 'target', type: 'address' },
        { name: 'callData', type: 'bytes' },
        { name: 'value', type: 'uint256' }
      ] }
    ], {
      'execute(address,bytes,uint256)': {
        intent: 'Execute verified inner call',
        recursive: [{ type: 'calldata', calldataPath: 'callData', targetPath: 'target' }]
      }
    }));
    const inner = erc20Iface.encodeFunctionData('transfer', [recipient, 9n]);
    const outer = wrapperIface.encodeFunctionData('execute', [erc20, inner, 0n]);

    const result = await decodeTransaction({ to: wrapper, data: outer, chainId, skipVerification: true });

    expect(result.root.functionName).toBe('execute');
    expect(result.nestedCalls).toHaveLength(1);
    expect(result.nestedCalls[0].functionName).toBe('transfer');
    expect(result.nestedIntents).toContain('Transfer 9 tokens to 0x6000000000000000000000000000000000000006');
    expect(result.aggregatedIntent).toContain('Execute verified inner call');
    expect(result.aggregatedIntent).toContain('Transfer 9 tokens');
  });

  it('uses ERC-7730 interpolatedIntent and nested field paths in decode and prompt output', async () => {
    const tupleWrapperIface = new Interface(['function route(tuple(address tokenIn,address tokenOut,uint256 amountIn,uint256 minOut,bytes callData) route)']);
    seed(erc20, erc20Metadata());
    seed(wrapper, metadata('TupleWrapper', [
      { type: 'function', name: 'route', inputs: [{ name: 'route', type: 'tuple', components: [
        { name: 'tokenIn', type: 'address' },
        { name: 'tokenOut', type: 'address' },
        { name: 'amountIn', type: 'uint256' },
        { name: 'minOut', type: 'uint256' },
        { name: 'callData', type: 'bytes' }
      ] }] }
    ], {
      'route((address,address,uint256,uint256,bytes))': {
        interpolatedIntent: 'Swap {route.amountIn} of {route.tokenIn} for at least {route.minOut} of {route.tokenOut}',
        fields: [
          { path: 'route.amountIn', label: 'Amount In' },
          { path: 'route.tokenIn', label: 'Token In' },
          { path: 'route.minOut', label: 'Minimum Out' },
          { path: 'route.tokenOut', label: 'Token Out' }
        ],
        recursive: [{ type: 'calldata', calldataPath: 'route.callData', targetPath: 'route.tokenOut' }]
      }
    }));
    const inner = erc20Iface.encodeFunctionData('transfer', [recipient, 42n]);
    const outer = tupleWrapperIface.encodeFunctionData('route', [[erc20, erc20, 100n, 90n, inner]]);

    const decoded = await decodeTransaction({ to: wrapper, data: outer, chainId, skipVerification: true });
    const prompt = await getClearSignPrompt({ to: wrapper, data: outer, chainId, value: '0' });

    expect(decoded.intent).toContain('Swap 100 of 0x1000000000000000000000000000000000000001 for at least 90');
    expect(decoded.nestedIntents).toContain('Transfer 42 tokens to 0x6000000000000000000000000000000000000006');
    expect(decoded.aggregatedIntent).toContain('Swap 100');
    expect(decoded.aggregatedIntent).toContain('Transfer 42 tokens');
    expect(prompt.displayText).toContain('Swap 100');
    expect(prompt.displayText).toContain('└─ transfer');
    expect(prompt.displayText).toContain('Transfer 42 tokens');
  });
});
