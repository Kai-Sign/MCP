/**
 * decode_transaction tool
 * Decodes transaction calldata using verified metadata
 */

import { z } from 'zod';
import { recursiveCalldataDecoder, type RecursiveCallNode } from '../services/recursive-decoder.js';
import { onChainVerifier } from '../services/onchain-verifier.js';
import { cacheManager } from '../services/cache-manager.js';

export const decodeTransactionSchema = z.object({
  to: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address'),
  data: z.string().regex(/^0x[a-fA-F0-9]+$/, 'Invalid calldata hex string'),
  chainId: z.number().int().positive().default(1),
  skipVerification: z.boolean().default(false),
  value: z.string().optional()
});

export type DecodeTransactionInput = z.infer<typeof decodeTransactionSchema>;

export interface DecodeTransactionResult {
  success: boolean;
  verified: boolean;
  source?: string;
  contractAddress: string;
  chainId: number;
  selector: string;
  functionName?: string;
  functionSignature?: string;
  intent: string;
  aggregatedIntent: string;
  root: RecursiveCallNode;
  nestedCalls: RecursiveCallNode[];
  nestedCallsTree: RecursiveCallNode;
  callTree: RecursiveCallNode;
  nestedIntents: string[];
  warnings: string[];
  params: Record<string, {
    label: string;
    value: string;
    rawValue: string;
    format: string;
  }>;
  decodedCommands?: Array<{
    command: string;
    name: string;
    intent: string;
  }>;
  verification?: {
    verified: boolean;
    source: string;
    details: string | null;
  };
  cacheStatus: 'hit' | 'miss';
  approximateTokensSaved?: number;
  hasUnknownInnerCalls: boolean;
  hasUnverifiedMetadata: boolean;
  truncated: boolean;
  cycleDetected: boolean;
  fullyClearSigned: boolean;
  error?: string;
}

/**
 * Decode transaction calldata using verified metadata
 */
export async function decodeTransaction(
  input: DecodeTransactionInput
): Promise<DecodeTransactionResult> {
  const { to, data, chainId, skipVerification, value } = decodeTransactionSchema.parse(input);

  const contractAddress = to.toLowerCase();

  // Check cache status
  const cacheInfo = cacheManager.getCacheEntryInfo(contractAddress, chainId);
  const cacheStatus: 'hit' | 'miss' = cacheInfo.found ? 'hit' : 'miss';

  // Decode transaction recursively through metadata-declared rules only.
  const decoded = await recursiveCalldataDecoder.decode(data, contractAddress, chainId, value);

  // Run verification unless skipped
  let verification: DecodeTransactionResult['verification'];
  if (!skipVerification) {
    try {
      const verificationResult = await onChainVerifier.verifyMetadata(contractAddress, chainId);
      verification = {
        verified: verificationResult.verified,
        source: verificationResult.source,
        details: verificationResult.details
      };
    } catch (e) {
      verification = {
        verified: false,
        source: 'error',
        details: (e as Error).message
      };
    }
  }

  // Format params for output
  const params: DecodeTransactionResult['params'] = {};
  for (const [key, val] of Object.entries(decoded.root.formatted)) {
    params[key] = {
      label: val.label,
      value: val.value,
      rawValue: val.rawValue,
      format: val.format
    };
  }

  // Calculate token savings for cache hits
  let approximateTokensSaved: number | undefined;
  if (cacheStatus === 'hit' && cacheInfo.approximateTokens) {
    approximateTokensSaved = Math.floor(cacheInfo.approximateTokens * 0.8);
  }

  const fullyClearSigned = Boolean(
    decoded.root.success &&
    decoded.callTree.verified &&
    !decoded.hasUnknownInnerCalls &&
    !decoded.hasUnverifiedMetadata &&
    !decoded.truncated &&
    !decoded.cycleDetected &&
    decoded.warnings.length === 0
  );

  return {
    success: decoded.root.success,
    verified: decoded.callTree.verified,
    source: decoded.callTree.source,
    contractAddress,
    chainId,
    selector: decoded.root.selector,
    functionName: decoded.root.functionName,
    functionSignature: decoded.root.function,
    intent: decoded.root.intent,
    aggregatedIntent: decoded.aggregatedIntent,
    root: decoded.callTree,
    nestedCalls: decoded.nestedCalls,
    nestedCallsTree: decoded.callTree,
    callTree: decoded.callTree,
    nestedIntents: decoded.nestedIntents,
    warnings: decoded.warnings,
    params,
    decodedCommands: decoded.root.decodedCommands?.map(cmd => ({
      command: cmd.command,
      name: cmd.name,
      intent: cmd.intent
    })),
    verification,
    cacheStatus,
    approximateTokensSaved,
    hasUnknownInnerCalls: decoded.hasUnknownInnerCalls,
    hasUnverifiedMetadata: decoded.hasUnverifiedMetadata,
    truncated: decoded.truncated,
    cycleDetected: decoded.cycleDetected,
    fullyClearSigned,
    error: decoded.root.error
  };
}
