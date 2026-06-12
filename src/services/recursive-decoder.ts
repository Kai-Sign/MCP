import { transactionDecoder, type DecodedTransaction, resolveFieldPath } from './abi-decoder.js';
import type { ContractMetadata, RecursiveRule } from './metadata-service.js';

export interface RecursiveCallNode {
  target: string;
  chainId: number;
  value?: string;
  selector: string;
  functionName?: string;
  functionSignature?: string;
  intent: string;
  success: boolean;
  verified: boolean;
  source?: string;
  params: DecodedTransaction['params'];
  formatted: DecodedTransaction['formatted'];
  rawParams: DecodedTransaction['rawParams'];
  decodedCommands?: DecodedTransaction['decodedCommands'];
  metadata?: unknown;
  error?: string;
  warnings: string[];
  children: RecursiveCallNode[];
  truncated?: boolean;
  cycleDetected?: boolean;
}

export interface ContractUsage {
  address: string;
  chainId: number;
  name?: string;
  calls: number;
  decoded: boolean;
}

export interface RecursiveDecodeResult {
  success: boolean;
  verified: boolean;
  source?: string;
  root: DecodedTransaction;
  callTree: RecursiveCallNode;
  nestedCalls: RecursiveCallNode[];
  nestedIntents: string[];
  aggregatedIntent: string;
  warnings: string[];
  errors: string[];
  truncated: boolean;
  cycleDetected: boolean;
  hasUnknownInnerCalls: boolean;
  hasUnverifiedMetadata: boolean;
  totalCalls: number;
  decodedCalls: number;
  contracts: ContractUsage[];
}

interface RecursiveDecoderOptions {
  maxDepth?: number;
}

interface DecodeContext {
  warnings: string[];
  errors: string[];
  nestedCalls: RecursiveCallNode[];
  nestedIntents: string[];
  truncated: boolean;
  cycleDetected: boolean;
  hasUnknownInnerCalls: boolean;
  hasUnverifiedMetadata: boolean;
  totalCalls: number;
  decodedCalls: number;
  contracts: Map<string, ContractUsage>;
}

function normalizeAddress(address: string): string {
  return address.toLowerCase();
}

function stringifyValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    const obj = value as { _value?: string; _hex?: string; toString?: () => string };
    if (obj._value !== undefined) return obj._value;
    if (obj._hex !== undefined) {
      try { return BigInt(obj._hex).toString(); } catch { return obj._hex; }
    }
    if (typeof obj.toString === 'function' && obj.toString !== Object.prototype.toString) return obj.toString();
  }
  return String(value);
}

function isHexCalldata(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{8,}$/.test(value);
}

function verificationSource(decoded: DecodedTransaction): string | undefined {
  const verification = (decoded.metadata as ContractMetadata | undefined)?._verification;
  return verification?.source;
}

function isVerified(decoded: DecodedTransaction): boolean {
  const verification = (decoded.metadata as ContractMetadata | undefined)?._verification;
  return Boolean(verification?.verified && verification.source === 'leaf-verified' && !verification.attestationComponents?.revoked);
}

function getDisplayFormat(decoded: DecodedTransaction) {
  const metadata = decoded.metadata as ContractMetadata | undefined;
  const formats = metadata?.display?.formats ?? {};
  return formats[decoded.selector] ?? formats[decoded.function ?? ''] ?? formats[decoded.functionName ?? ''];
}

function getRecursiveRules(decoded: DecodedTransaction): RecursiveRule[] {
  const metadata = decoded.metadata as ContractMetadata | undefined;
  const format = getDisplayFormat(decoded);
  const calldataFieldRules = (format?.fields ?? [])
    .filter(field => field.format === 'calldata')
    .map(field => ({
      type: 'fieldCalldata',
      calldataPath: field.path,
      targetPath: typeof field.params?.calleePath === 'string' ? field.params.calleePath : undefined,
      valuePath: typeof field.params?.amountPath === 'string' ? field.params.amountPath : undefined,
      chainIdPath: typeof field.params?.chainIdPath === 'string' ? field.params.chainIdPath : undefined
    }));

  return [
    ...calldataFieldRules,
    ...(metadata?.recursive ?? []),
    ...(metadata?.recursiveRules ?? []),
    ...(decoded.recursiveRules ?? [])
  ];
}

function makeNode(decoded: DecodedTransaction, target: string, chainId: number, value?: string): RecursiveCallNode {
  const verified = isVerified(decoded);
  return {
    target: normalizeAddress(target),
    chainId,
    value,
    selector: decoded.selector,
    functionName: decoded.functionName,
    functionSignature: decoded.function,
    intent: decoded.intent,
    success: decoded.success,
    verified,
    source: verificationSource(decoded),
    params: decoded.params,
    formatted: decoded.formatted,
    rawParams: decoded.rawParams,
    decodedCommands: decoded.decodedCommands,
    metadata: decoded.metadata,
    error: decoded.error,
    warnings: [],
    children: []
  };
}

function pushWarning(ctx: DecodeContext, node: RecursiveCallNode, message: string) {
  ctx.warnings.push(message);
  node.warnings.push(message);
}

function contractName(decoded: DecodedTransaction): string | undefined {
  const metadata = decoded.metadata as ContractMetadata | undefined;
  const meta = metadata as unknown as {
    metadata?: { owner?: string; name?: string };
    context?: { contract?: { name?: string } };
  } | undefined;
  return meta?.context?.contract?.name ?? meta?.metadata?.name ?? meta?.metadata?.owner;
}

function recordContractUsage(ctx: DecodeContext, decoded: DecodedTransaction, target: string, chainId: number) {
  ctx.totalCalls++;
  if (decoded.success) ctx.decodedCalls++;

  const key = `${chainId}:${target}`;
  const existing = ctx.contracts.get(key);
  if (existing) {
    existing.calls++;
    existing.decoded = existing.decoded && decoded.success;
    existing.name = existing.name ?? contractName(decoded);
  } else {
    ctx.contracts.set(key, {
      address: target,
      chainId,
      name: contractName(decoded),
      calls: 1,
      decoded: decoded.success
    });
  }
}

export class RecursiveCalldataDecoder {
  private maxDepth: number;

  constructor(options: RecursiveDecoderOptions = {}) {
    const envDepth = process.env.KAISIGN_RECURSIVE_MAX_DEPTH ? Number(process.env.KAISIGN_RECURSIVE_MAX_DEPTH) : undefined;
    this.maxDepth = options.maxDepth ?? (Number.isFinite(envDepth) && envDepth! >= 0 ? envDepth! : 128);
  }

  async decode(data: string, target: string, chainId: number, value?: string): Promise<RecursiveDecodeResult> {
    const ctx: DecodeContext = {
      warnings: [],
      errors: [],
      nestedCalls: [],
      nestedIntents: [],
      truncated: false,
      cycleDetected: false,
      hasUnknownInnerCalls: false,
      hasUnverifiedMetadata: false,
      totalCalls: 0,
      decodedCalls: 0,
      contracts: new Map()
    };

    const callTree = await this.decodeNode(data, normalizeAddress(target), chainId, value, 0, [], ctx, false);
    const root = this.nodeToDecoded(callTree);
    const allIntents = [callTree.intent, ...ctx.nestedIntents].filter(Boolean);

    return {
      success: callTree.success && !ctx.truncated && !ctx.cycleDetected && !ctx.hasUnknownInnerCalls && ctx.errors.length === 0,
      verified: callTree.verified && !ctx.hasUnverifiedMetadata,
      source: callTree.source,
      root,
      callTree,
      nestedCalls: ctx.nestedCalls,
      nestedIntents: ctx.nestedIntents,
      aggregatedIntent: allIntents.join(' + '),
      warnings: ctx.warnings,
      errors: ctx.errors,
      truncated: ctx.truncated,
      cycleDetected: ctx.cycleDetected,
      hasUnknownInnerCalls: ctx.hasUnknownInnerCalls,
      hasUnverifiedMetadata: ctx.hasUnverifiedMetadata,
      totalCalls: ctx.totalCalls,
      decodedCalls: ctx.decodedCalls,
      contracts: [...ctx.contracts.values()]
    };
  }

  private async decodeNode(
    data: string,
    target: string,
    chainId: number,
    value: string | undefined,
    depth: number,
    stack: string[],
    ctx: DecodeContext,
    isNested: boolean
  ): Promise<RecursiveCallNode> {
    const selector = data.slice(0, 10).toLowerCase();
    const stackKey = `${target}:${selector}:${data.toLowerCase()}`;

    if (depth > this.maxDepth) {
      ctx.truncated = true;
      const node = makeNode({
        success: false,
        selector,
        params: {},
        rawParams: {},
        formatted: {},
        intent: 'Recursive decode truncated',
        error: `Max recursion depth ${this.maxDepth} exceeded`
      }, target, chainId, value);
      node.truncated = true;
      pushWarning(ctx, node, `Recursive decode max depth ${this.maxDepth} exceeded at ${target} ${selector}`);
      return node;
    }

    if (stack.includes(stackKey)) {
      ctx.cycleDetected = true;
      const node = makeNode({
        success: false,
        selector,
        params: {},
        rawParams: {},
        formatted: {},
        intent: 'Recursive cycle detected',
        error: 'Recursive cycle detected'
      }, target, chainId, value);
      node.cycleDetected = true;
      pushWarning(ctx, node, `Recursive cycle detected at ${target} ${selector}`);
      return node;
    }

    let decoded: DecodedTransaction;
    try {
      decoded = await transactionDecoder.decodeCalldata(data, target, chainId);
    } catch (error) {
      const message = (error as Error).message;
      decoded = {
        success: false,
        selector,
        params: {},
        rawParams: {},
        formatted: {},
        intent: 'Decode error',
        error: message
      };
    }

    const node = makeNode(decoded, target, chainId, value);
    recordContractUsage(ctx, decoded, normalizeAddress(target), chainId);
    if (isNested) {
      ctx.nestedCalls.push(node);
      if (decoded.success && decoded.intent) ctx.nestedIntents.push(decoded.intent);
    }

    if (!decoded.success) {
      const message = `unknown inner call at ${target} ${selector}: ${decoded.error ?? 'decode failed'}`;
      if (isNested) {
        ctx.hasUnknownInnerCalls = true;
        pushWarning(ctx, node, message);
      } else {
        pushWarning(ctx, node, `Root decode failed at ${target} ${selector}: ${decoded.error ?? 'decode failed'}`);
      }
    }

    if (decoded.success && !node.verified) {
      // Registry attestation status is reported once per contract in the
      // result's contracts summary, not as a per-call warning.
      ctx.hasUnverifiedMetadata = true;
    }

    const nextStack = [...stack, stackKey];
    const rules = getRecursiveRules(decoded);
    for (const rule of rules) {
      try {
        await this.applyRule(rule, decoded, node, chainId, nextStack, depth, ctx);
      } catch (error) {
        const message = `Recursive rule error at ${target} ${selector}: ${(error as Error).message}`;
        ctx.errors.push(message);
        pushWarning(ctx, node, message);
      }
    }

    return node;
  }

  private async applyRule(
    rule: RecursiveRule,
    decoded: DecodedTransaction,
    node: RecursiveCallNode,
    defaultChainId: number,
    stack: string[],
    depth: number,
    ctx: DecodeContext
  ) {
    if (rule.type === 'calldata' || rule.type === 'fieldCalldata') {
      await this.decodeCalldataField(rule, decoded.rawParams, node, defaultChainId, stack, depth, ctx);
      return;
    }

    if (rule.type === 'calls') {
      if (!rule.callsPath) return;
      const calls = resolveFieldPath(rule.callsPath, decoded.rawParams);
      if (!Array.isArray(calls)) return;
      for (const call of calls) {
        await this.decodeSingleFromContainer(rule, call, node, defaultChainId, stack, depth, ctx);
      }
      return;
    }

    if (rule.type === 'parallelCalls') {
      await this.decodeParallelArrays(rule, decoded.rawParams, node, defaultChainId, stack, depth, ctx);
      return;
    }

    if (rule.type === 'commands') {
      for (const command of decoded.decodedCommands ?? []) {
        for (const commandRule of command.recursive ?? []) {
          if (commandRule.type === 'calldata') {
            await this.decodeSingleFromContainer(commandRule, command.params, node, defaultChainId, stack, depth, ctx);
          }
        }
        if (command.name.startsWith('UNKNOWN_')) {
          ctx.hasUnknownInnerCalls = true;
          pushWarning(ctx, node, `Unknown metadata command ${command.command} at ${node.target} ${node.selector}`);
        }
      }
    }
  }

  private resolveIndexedPath(path: string | undefined, params: Record<string, unknown>, index: number): unknown {
    if (!path) return undefined;
    return resolveFieldPath(path.replace(/\[\]/g, `[${index}]`), params);
  }

  private async decodeCalldataField(
    rule: RecursiveRule,
    params: Record<string, unknown>,
    parent: RecursiveCallNode,
    defaultChainId: number,
    stack: string[],
    depth: number,
    ctx: DecodeContext
  ) {
    if (!rule.calldataPath) return;

    if (rule.calldataPath.includes('[]')) {
      const pathForArray = rule.calldataPath.replace(/\.\[\].*$/, '').replace(/\[\].*$/, '');
      const values = resolveFieldPath(pathForArray, params);
      if (!Array.isArray(values)) return;

      for (let i = 0; i < values.length; i++) {
        const calldata = resolveFieldPath(rule.calldataPath.replace(/\[\]/g, `[${i}]`), params);
        if (!isHexCalldata(calldata)) continue;
        const target = stringifyValue(this.resolveIndexedPath(rule.targetPath, params, i))?.toLowerCase() ?? parent.target;
        const value = stringifyValue(this.resolveIndexedPath(rule.valuePath, params, i));
        const chainIdValue = stringifyValue(this.resolveIndexedPath(rule.chainIdPath, params, i));
        const chainId = chainIdValue ? Number(chainIdValue) : defaultChainId;
        const child = await this.decodeNode(calldata, target, chainId, value, depth + 1, stack, ctx, true);
        parent.children.push(child);
      }
      return;
    }

    await this.decodeSingleFromContainer(rule, params, parent, defaultChainId, stack, depth, ctx);
  }

  private async decodeParallelArrays(
    rule: RecursiveRule,
    params: Record<string, unknown>,
    parent: RecursiveCallNode,
    defaultChainId: number,
    stack: string[],
    depth: number,
    ctx: DecodeContext
  ) {
    if (!rule.calldataPath || !rule.targetPath) return;

    const calldatas = resolveFieldPath(rule.calldataPath, params);
    const targets = resolveFieldPath(rule.targetPath, params);
    const values = rule.valuePath ? resolveFieldPath(rule.valuePath, params) : undefined;
    const chainIds = rule.chainIdPath ? resolveFieldPath(rule.chainIdPath, params) : undefined;

    if (!Array.isArray(calldatas) || !Array.isArray(targets)) return;

    const count = Math.min(calldatas.length, targets.length);
    if (calldatas.length !== targets.length || (Array.isArray(values) && values.length !== count) || (Array.isArray(chainIds) && chainIds.length !== count)) {
      const message = `Parallel recursive call arrays length mismatch at ${parent.target} ${parent.selector}`;
      ctx.errors.push(message);
      pushWarning(ctx, parent, message);
    }

    for (let i = 0; i < count; i++) {
      const calldata = calldatas[i];
      if (!isHexCalldata(calldata)) continue;

      const target = stringifyValue(targets[i])?.toLowerCase() ?? parent.target;
      const value = Array.isArray(values) ? stringifyValue(values[i]) : undefined;
      const chainIdValue = Array.isArray(chainIds) ? stringifyValue(chainIds[i]) : undefined;
      const chainId = chainIdValue ? Number(chainIdValue) : defaultChainId;

      const child = await this.decodeNode(calldata, target, chainId, value, depth + 1, stack, ctx, true);
      parent.children.push(child);
    }
  }

  private async decodeSingleFromContainer(
    rule: RecursiveRule,
    container: unknown,
    parent: RecursiveCallNode,
    defaultChainId: number,
    stack: string[],
    depth: number,
    ctx: DecodeContext
  ) {
    if (!rule.calldataPath) return;
    const calldata = resolveFieldPath(rule.calldataPath, container);
    if (!isHexCalldata(calldata)) return;

    const targetValue = rule.targetPath ? resolveFieldPath(rule.targetPath, container) : parent.target;
    const target = stringifyValue(targetValue)?.toLowerCase() ?? parent.target;
    const value = rule.valuePath ? stringifyValue(resolveFieldPath(rule.valuePath, container)) : undefined;
    const chainIdValue = rule.chainIdPath ? stringifyValue(resolveFieldPath(rule.chainIdPath, container)) : undefined;
    const chainId = chainIdValue ? Number(chainIdValue) : defaultChainId;

    const child = await this.decodeNode(calldata, target, chainId, value, depth + 1, stack, ctx, true);
    parent.children.push(child);
  }

  private nodeToDecoded(node: RecursiveCallNode): DecodedTransaction {
    return {
      success: node.success,
      selector: node.selector,
      function: node.functionSignature,
      functionName: node.functionName,
      params: node.params,
      rawParams: node.rawParams,
      intent: node.intent,
      formatted: node.formatted,
      metadata: node.metadata,
      decodedCommands: node.decodedCommands,
      recursiveRules: [],
      error: node.error
    };
  }
}

export const recursiveCalldataDecoder = new RecursiveCalldataDecoder();
