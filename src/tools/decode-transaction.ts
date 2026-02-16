/**
 * decode_transaction tool
 * Decodes transaction calldata using verified metadata
 */

import { z } from 'zod';
import { transactionDecoder, DecodedTransaction } from '../services/abi-decoder.js';
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
  contractAddress: string;
  chainId: number;
  selector: string;
  functionName?: string;
  functionSignature?: string;
  intent: string;
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

  // Decode transaction
  const decoded = await transactionDecoder.decodeCalldata(data, contractAddress, chainId);

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
  for (const [key, val] of Object.entries(decoded.formatted)) {
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
    // Estimate that cached response saves ~80% of tokens vs full metadata
    approximateTokensSaved = Math.floor(cacheInfo.approximateTokens * 0.8);
  }

  return {
    success: decoded.success,
    contractAddress,
    chainId,
    selector: decoded.selector,
    functionName: decoded.functionName,
    functionSignature: decoded.function,
    intent: decoded.intent,
    params,
    decodedCommands: decoded.decodedCommands?.map(cmd => ({
      command: cmd.command,
      name: cmd.name,
      intent: cmd.intent
    })),
    verification,
    cacheStatus,
    approximateTokensSaved,
    error: decoded.error
  };
}
