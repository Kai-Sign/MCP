/**
 * get_clear_sign_prompt tool
 * Returns a clear signing prompt for Bankrbot transactions
 */

import { z } from 'zod';
import { validateBankrbotTransaction, type ValidateBankrbotTxResult } from './validate-bankrbot-tx.js';

export const getClearSignPromptSchema = z.object({
  to: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address'),
  data: z.string().regex(/^0x[a-fA-F0-9]+$/, 'Invalid calldata hex string'),
  chainId: z.number().int().positive().default(8453),
  value: z.string().default('0')
});

export type ClearSignInput = z.infer<typeof getClearSignPromptSchema>;

export interface ClearSignResult {
  /** Formatted display text for user confirmation */
  displayText: string;

  /** Whether the contract has KaiSign-verified metadata */
  verified: boolean;

  /** Badge text for UI display */
  verificationBadge: string;

  /** Human-readable intent description */
  intent: string;

  /** Function being called */
  functionName: string;

  /** Contract name if known */
  contractName?: string;

  /** Any warnings about the transaction */
  warnings: string[];

  /** Transaction payload for signing */
  transaction: {
    to: string;
    data: string;
    value: string;
    chainId: number;
  };

  /** Verification details */
  verification?: {
    source: 'leaf-verified' | 'api-only' | 'unverified' | 'error';
    attestationUid?: string;
    metadataHash?: string;
  };
}

/**
 * Format ETH value for display
 */
function formatEthValue(weiValue: string): string {
  const wei = BigInt(weiValue);
  if (wei === BigInt(0)) {
    return '';
  }

  const eth = Number(wei) / 1e18;
  if (eth < 0.0001) {
    return `${wei.toString()} wei`;
  }
  if (eth < 1) {
    return `${eth.toFixed(6)} ETH`;
  }
  return `${eth.toFixed(4)} ETH`;
}

/**
 * Get chain name from chain ID
 */
function getChainName(chainId: number): string {
  const chains: Record<number, string> = {
    1: 'Ethereum',
    8453: 'Base',
    42161: 'Arbitrum',
    10: 'Optimism',
    137: 'Polygon',
    43114: 'Avalanche',
    56: 'BNB Chain',
    11155111: 'Sepolia'
  };
  return chains[chainId] || `Chain ${chainId}`;
}

/**
 * Get verification badge based on source
 */
function getVerificationBadge(source: ValidateBankrbotTxResult['source'], verified: boolean): string {
  if (verified && source === 'leaf-verified') {
    return '✓ Verified';
  }
  if (source === 'api-only') {
    return '⚠ API Only';
  }
  return '⚠ Unverified';
}

/**
 * Build display text for user confirmation
 */
function buildDisplayText(
  intent: string,
  verified: boolean,
  badge: string,
  value: string,
  to: string,
  chainId: number,
  warnings: string[]
): string {
  const lines: string[] = [];

  // Header
  if (verified) {
    lines.push(`${badge} Transaction`);
  } else {
    lines.push(`${badge} Transaction`);
  }
  lines.push('');

  // Intent
  lines.push(intent);
  lines.push('');

  // Details
  const shortAddress = `${to.slice(0, 6)}...${to.slice(-4)}`;
  lines.push(`Contract: ${shortAddress} (${getChainName(chainId)})`);

  const ethValue = formatEthValue(value);
  if (ethValue) {
    lines.push(`Value: ${ethValue}`);
  }

  // Warnings
  if (warnings.length > 0) {
    lines.push('');
    for (const warning of warnings) {
      lines.push(`⚠ ${warning}`);
    }
  }

  return lines.join('\n');
}

/**
 * Get a clear signing prompt for a transaction
 *
 * This tool wraps validateBankrbotTransaction and formats the output
 * for user-friendly display in signing flows.
 *
 * @param input Transaction payload (to, data, chainId, value)
 * @returns Clear signing result with display text and verification status
 */
export async function getClearSignPrompt(input: ClearSignInput): Promise<ClearSignResult> {
  const parsed = getClearSignPromptSchema.parse(input);

  // Use existing validation logic
  const validation = await validateBankrbotTransaction(parsed);

  // Get verification badge
  const badge = getVerificationBadge(validation.source, validation.verified);

  // Build display text
  const displayText = buildDisplayText(
    validation.intent,
    validation.verified,
    badge,
    parsed.value,
    parsed.to,
    parsed.chainId,
    validation.warnings
  );

  // Build result
  const result: ClearSignResult = {
    displayText,
    verified: validation.verified,
    verificationBadge: badge,
    intent: validation.intent,
    functionName: validation.transaction.functionName || 'unknown',
    warnings: validation.warnings,
    transaction: {
      to: validation.transaction.to,
      data: validation.transaction.data,
      value: validation.transaction.value,
      chainId: validation.transaction.chainId
    },
    verification: {
      source: validation.source,
      attestationUid: validation.verification?.attestationUid,
      metadataHash: validation.verification?.metadataHash
    }
  };

  return result;
}
