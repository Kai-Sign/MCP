/**
 * validate_bankrbot_transaction tool
 * Validates transaction payloads from Bankrbot against KaiSign Registry
 */

import { z } from 'zod';
import { recursiveCalldataDecoder, type RecursiveCallNode } from '../services/recursive-decoder.js';
import { onChainVerifier } from '../services/onchain-verifier.js';

export const validateBankrbotTxSchema = z.object({
  to: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address'),
  data: z.string().regex(/^0x[a-fA-F0-9]+$/, 'Invalid calldata hex string'),
  chainId: z.number().int().positive().default(8453), // Default to Base
  value: z.string().default('0')
});

export type ValidateBankrbotTxInput = z.infer<typeof validateBankrbotTxSchema>;

export interface ValidateBankrbotTxResult {
  /** Whether the outer contract has leaf-verified KaiSign metadata */
  verified: boolean;

  /** Verification source: 'leaf-verified' (trustless), 'api-only', 'unverified', or 'error' */
  source: 'leaf-verified' | 'api-only' | 'unverified' | 'mismatch' | 'error';

  /** Human-readable description of transaction intent */
  intent: string;
  aggregatedIntent: string;

  /** Decoded function parameters */
  params: Record<string, {
    label: string;
    value: string;
    rawValue: string;
  }>;

  nestedCalls: RecursiveCallNode[];
  callTree?: RecursiveCallNode;
  nestedIntents: string[];

  /** Agent-safe decision fields */
  fullyDecoded: boolean;
  hasUnknownInnerCalls: boolean;
  hasUnverifiedMetadata: boolean;
  requiresHumanReview: boolean;
  safeToAutonomouslySign: boolean;

  /** Any warnings about the transaction */
  warnings: string[];

  /** Transaction details */
  transaction: {
    to: string;
    data: string;
    value: string;
    chainId: number;
    selector: string;
    functionName?: string;
  };

  /** Verification details */
  verification?: {
    attestationUid?: string;
    metadataHash?: string;
    idx?: number;
    revoked?: boolean;
  };

  /** Error message if verification failed */
  error?: string;
}

function hasCriticalWarning(warnings: string[]): boolean {
  return warnings.some(w => /unknown|unverified|mismatch|revoked|cycle|max depth|truncated|decode failed|error/i.test(w));
}

/**
 * Validate a transaction payload from Bankrbot
 *
 * This tool is designed for the signing flow:
 * 1. Bankrbot builds transaction from natural language
 * 2. This tool validates the transaction against KaiSign registry
 * 3. If verified, user can confidently sign
 */
export async function validateBankrbotTransaction(
  input: ValidateBankrbotTxInput
): Promise<ValidateBankrbotTxResult> {
  const { to, data, chainId, value } = validateBankrbotTxSchema.parse(input);

  const contractAddress = to.toLowerCase();
  const warnings: string[] = [];
  const selector = data.length >= 10 ? data.slice(0, 10) : '0x';

  const result: ValidateBankrbotTxResult = {
    verified: false,
    source: 'unverified',
    intent: 'Unknown transaction',
    aggregatedIntent: 'Unknown transaction',
    params: {},
    nestedCalls: [],
    nestedIntents: [],
    fullyDecoded: false,
    hasUnknownInnerCalls: false,
    hasUnverifiedMetadata: false,
    requiresHumanReview: true,
    safeToAutonomouslySign: false,
    warnings,
    transaction: {
      to: contractAddress,
      data,
      value,
      chainId,
      selector
    }
  };

  try {
    // Step 1: Verify outer contract metadata on-chain.
    const verificationResult = await onChainVerifier.verifyMetadata(contractAddress, chainId);

    result.verified = verificationResult.verified && verificationResult.source === 'leaf-verified';
    result.source = verificationResult.source as ValidateBankrbotTxResult['source'];

    if (verificationResult.uid || verificationResult.attestationComponents) {
      result.verification = {
        attestationUid: verificationResult.uid,
        metadataHash: verificationResult.attestationComponents?.metadataHash,
        idx: verificationResult.attestationComponents?.idx,
        revoked: verificationResult.attestationComponents?.revoked
      };

      if (verificationResult.attestationComponents?.revoked) {
        warnings.push('CRITICAL: Contract metadata attestation has been revoked');
        result.verified = false;
      }
    }

    // Step 2: Decode recursively through metadata-declared rules only.
    const decoded = await recursiveCalldataDecoder.decode(data, contractAddress, chainId, value);

    result.intent = decoded.aggregatedIntent || decoded.root.intent;
    result.aggregatedIntent = decoded.aggregatedIntent || decoded.root.intent;
    result.transaction.functionName = decoded.root.functionName;
    result.nestedCalls = decoded.nestedCalls;
    result.callTree = decoded.callTree;
    result.nestedIntents = decoded.nestedIntents;
    result.hasUnknownInnerCalls = decoded.hasUnknownInnerCalls;
    result.hasUnverifiedMetadata = decoded.hasUnverifiedMetadata;
    warnings.push(...decoded.warnings);

    if (decoded.root.success) {
      for (const [key, val] of Object.entries(decoded.root.formatted)) {
        result.params[key] = {
          label: val.label,
          value: val.value,
          rawValue: val.rawValue
        };
      }
    } else {
      warnings.push(`Decoding failed: ${decoded.root.error || 'Unknown error'}`);
    }

    if (result.source === 'api-only') {
      warnings.push('Metadata verified via API only, not on-chain. Consider waiting for on-chain attestation.');
    } else if (result.source === 'unverified') {
      warnings.push('Contract has no verified metadata. Transaction intent cannot be independently verified.');
    } else if (result.source === 'mismatch') {
      warnings.push('CRITICAL: Metadata hash mismatch. Do not sign autonomously.');
    }

    if (BigInt(value) > BigInt(0)) {
      const ethValue = Number(BigInt(value)) / 1e18;
      if (ethValue > 10) {
        warnings.push(`Large ETH value: ${ethValue.toFixed(4)} ETH`);
      }
    }

    const hasCritical = hasCriticalWarning(warnings);
    result.fullyDecoded = Boolean(decoded.root.success && !decoded.hasUnknownInnerCalls && !decoded.truncated && !decoded.cycleDetected && decoded.errors.length === 0);
    result.hasUnverifiedMetadata = result.hasUnverifiedMetadata || !result.verified;
    result.requiresHumanReview = Boolean(!result.fullyDecoded || !result.verified || result.hasUnknownInnerCalls || result.hasUnverifiedMetadata || hasCritical);
    result.safeToAutonomouslySign = Boolean(
      result.verified &&
      result.source === 'leaf-verified' &&
      result.fullyDecoded &&
      !result.hasUnknownInnerCalls &&
      !result.hasUnverifiedMetadata &&
      !decoded.truncated &&
      !decoded.cycleDetected &&
      !result.verification?.revoked &&
      !hasCritical
    );
  } catch (error) {
    result.source = 'error';
    result.error = error instanceof Error ? error.message : 'Unknown error';
    warnings.push(`Verification error: ${result.error}`);
    result.requiresHumanReview = true;
    result.safeToAutonomouslySign = false;
  }

  return result;
}
