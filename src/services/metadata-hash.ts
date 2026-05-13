import { keccak256, toUtf8Bytes } from 'ethers';

export interface MetadataHashCheck {
  verified: boolean;
  computedHash: string;
  attestedHash: string;
  error?: string;
}

function normalizeForHash(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(normalizeForHash);
  }

  if (value && typeof value === 'object') {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};

    for (const key of Object.keys(input).sort()) {
      if (key.startsWith('_')) continue;
      if (input[key] === undefined) continue;
      output[key] = normalizeForHash(input[key]);
    }

    return output;
  }

  return value;
}

export function canonicalMetadataJson(metadata: unknown): string {
  return JSON.stringify(normalizeForHash(metadata));
}

export function computeMetadataHash(metadata: unknown): string {
  return keccak256(toUtf8Bytes(canonicalMetadataJson(metadata))).toLowerCase();
}

export function assertMetadataHashMatches(metadata: unknown, attestedHash: string): MetadataHashCheck {
  const computedHash = computeMetadataHash(metadata);
  const normalizedAttestedHash = attestedHash.toLowerCase();
  const verified = computedHash === normalizedAttestedHash;

  return {
    verified,
    computedHash,
    attestedHash: normalizedAttestedHash,
    error: verified ? undefined : `metadata hash mismatch: computed=${computedHash} attested=${normalizedAttestedHash}`
  };
}
