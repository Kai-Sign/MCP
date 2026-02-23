/**
 * validate_bankrbot_transaction tool
 * Validates transaction payloads from Bankrbot against KaiSign Registry
 */

import { z } from 'zod';
import { transactionDecoder } from '../services/abi-decoder.js';
import { onChainVerifier } from '../services/onchain-verifier.js';
import { cacheManager } from '../services/cache-manager.js';

export const validateBankrbotTxSchema = z.object({
  to: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address'),
  data: z.string().regex(/^0x[a-fA-F0-9]+$/, 'Invalid calldata hex string'),
  chainId: z.number().int().positive().default(8453), // Default to Base
  value: z.string().default('0')
});

export type ValidateBankrbotTxInput = z.infer<typeof validateBankrbotTxSchema>;

export interface ValidateBankrbotTxResult {
  /** Whether the contract has KaiSign-verified metadata */
  verified: boolean;

  /** Verification source: 'leaf-verified' (trustless), 'api-only', 'unverified', or 'error' */
  source: 'leaf-verified' | 'api-only' | 'unverified' | 'error';

  /** Human-readable description of transaction intent */
  intent: string;

  /** Decoded function parameters */
  params: Record<string, {
    label: string;
    value: string;
    rawValue: string;
  }>;

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

/**
 * Validate a transaction payload from Bankrbot
 *
 * This tool is designed for the signing flow:
 * 1. Bankrbot builds transaction from natural language
 * 2. This tool validates the transaction against KaiSign registry
 * 3. If verified, user can confidently sign
 *
 * @param input Transaction payload (to, data, chainId, value)
 * @returns Validation result with decoded intent and verification status
 */
export async function validateBankrbotTransaction(
  input: ValidateBankrbotTxInput
): Promise<ValidateBankrbotTxResult> {
  const { to, data, chainId, value } = validateBankrbotTxSchema.parse(input);

  const contractAddress = to.toLowerCase();
  const warnings: string[] = [];

  // Extract selector
  const selector = data.length >= 10 ? data.slice(0, 10) : '0x';

  // Initialize result
  const result: ValidateBankrbotTxResult = {
    verified: false,
    source: 'unverified',
    intent: 'Unknown transaction',
    params: {},
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
    // Step 1: Verify contract metadata on-chain
    const verificationResult = await onChainVerifier.verifyMetadata(contractAddress, chainId);

    result.verified = verificationResult.verified;
    result.source = verificationResult.source as ValidateBankrbotTxResult['source'];

    // Extract attestation details from verification result
    if (verificationResult.uid || verificationResult.attestationComponents) {
      result.verification = {
        attestationUid: verificationResult.uid,
        metadataHash: verificationResult.attestationComponents?.metadataHash,
        idx: verificationResult.attestationComponents?.idx,
        revoked: verificationResult.attestationComponents?.revoked
      };

      // Warn if attestation is revoked
      if (verificationResult.attestationComponents?.revoked) {
        warnings.push('WARNING: Contract metadata attestation has been revoked');
        result.verified = false;
      }
    }

    // Step 2: Decode transaction using metadata
    const decoded = await transactionDecoder.decodeCalldata(data, contractAddress, chainId);

    if (decoded.success) {
      result.intent = decoded.intent;
      result.transaction.functionName = decoded.functionName;

      // Format params
      for (const [key, val] of Object.entries(decoded.formatted)) {
        result.params[key] = {
          label: val.label,
          value: val.value,
          rawValue: val.rawValue
        };
      }

      // Add command decoding for Universal Router
      if (decoded.decodedCommands && decoded.decodedCommands.length > 0) {
        // Append command intents to main intent
        const commandIntents = decoded.decodedCommands.map(cmd => cmd.intent).join(', then ');
        if (commandIntents) {
          result.intent = commandIntents;
        }
      }
    } else {
      warnings.push(`Decoding failed: ${decoded.error || 'Unknown error'}`);
    }

    // Step 3: Add source-specific warnings
    if (result.source === 'api-only') {
      warnings.push('Metadata verified via API only, not on-chain. Consider waiting for on-chain attestation.');
    } else if (result.source === 'unverified') {
      warnings.push('Contract has no verified metadata. Transaction intent cannot be independently verified.');
    }

    // Step 4: Check for suspicious patterns
    if (BigInt(value) > BigInt(0)) {
      const ethValue = Number(BigInt(value)) / 1e18;
      if (ethValue > 10) {
        warnings.push(`Large ETH value: ${ethValue.toFixed(4)} ETH`);
      }
    }

    // Check for known risky selectors
    const riskySelectors: Record<string, string> = {
      '0x095ea7b3': 'approve',
      '0xa22cb465': 'setApprovalForAll',
      '0x42842e0e': 'safeTransferFrom'
    };

    if (selector in riskySelectors && !result.verified) {
      warnings.push(`Unverified ${riskySelectors[selector]} call - verify target contract before signing`);
    }

  } catch (error) {
    result.source = 'error';
    result.error = error instanceof Error ? error.message : 'Unknown error';
    warnings.push(`Verification error: ${result.error}`);
  }

  return result;
}
