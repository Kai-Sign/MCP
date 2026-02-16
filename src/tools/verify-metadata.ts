/**
 * verify_contract_metadata tool
 * Verifies contract metadata against on-chain registry
 */

import { z } from 'zod';
import { onChainVerifier, VerificationResult } from '../services/onchain-verifier.js';
import { metadataService } from '../services/metadata-service.js';

export const verifyMetadataSchema = z.object({
  contractAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address'),
  chainId: z.number().int().positive().default(1)
});

export type VerifyMetadataInput = z.infer<typeof verifyMetadataSchema>;

export interface VerifyMetadataResult {
  contractAddress: string;
  chainId: number;
  verified: boolean;
  source: string;
  details: string | null;
  uid?: string;
  leafHash?: string;
  onChainLeafHash?: string;
  attestation?: {
    chainId: number;
    extcodehash: string;
    metadataHash: string;
    idx: number;
    revoked: boolean;
  };
  contractName?: string;
  hasMetadata: boolean;
}

/**
 * Verify contract metadata against on-chain registry
 */
export async function verifyContractMetadata(
  input: VerifyMetadataInput
): Promise<VerifyMetadataResult> {
  const { contractAddress, chainId } = verifyMetadataSchema.parse(input);

  // Run verification
  const verification = await onChainVerifier.verifyMetadata(contractAddress, chainId);

  // Try to fetch metadata for additional context
  let contractName: string | undefined;
  let hasMetadata = false;

  try {
    const metadata = await metadataService.getContractMetadata(contractAddress, chainId);
    if (metadata) {
      hasMetadata = true;
      contractName = metadata.context?.contract?.name ?? metadata.metadata?.name;
    }
  } catch {
    // Metadata not available
  }

  return {
    contractAddress: contractAddress.toLowerCase(),
    chainId,
    verified: verification.verified,
    source: verification.source,
    details: verification.details,
    uid: verification.uid,
    leafHash: verification.hash ?? undefined,
    onChainLeafHash: verification.onChainHash ?? undefined,
    attestation: verification.attestationComponents,
    contractName,
    hasMetadata
  };
}
