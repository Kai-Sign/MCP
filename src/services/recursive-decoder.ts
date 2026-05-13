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
  return formats[decoded.function ?? ''] ?? formats[decoded.functionName ?? ''];
}

function getRecursiveRules(decoded: DecodedTransaction): RecursiveRule[] {
  const metadata = decoded.metadata as ContractMetadata | undefined;
  return [
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

export class RecursiveCalldataDecoder {
  private maxDepth: number;

  constructor(options: RecursiveDecoderOptions = {}) {
    this.maxDepth = options.maxDepth ?? 5;
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
      hasUnverifiedMetadata: false
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
      hasUnverifiedMetadata: ctx.hasUnverifiedMetadata
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
    const stackKey = `${target}:${selector}`;

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
      ctx.hasUnverifiedMetadata = true;
      if (isNested) pushWarning(ctx, node, `Unverified metadata for inner call at ${target} ${selector}`);
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
    if (rule.type === 'calldata') {
      await this.decodeSingleFromContainer(rule, decoded.rawParams, node, defaultChainId, stack, depth, ctx);
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
