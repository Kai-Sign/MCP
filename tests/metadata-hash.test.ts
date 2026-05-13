import { describe, expect, it } from 'vitest';
import { computeMetadataHash, assertMetadataHashMatches } from '../src/services/metadata-hash.js';

describe('metadata hash binding', () => {
  it('hashes metadata with deterministic key ordering', () => {
    const a = { b: 2, a: { d: 4, c: 3 } };
    const b = { a: { c: 3, d: 4 }, b: 2 };

    expect(computeMetadataHash(a)).toBe(computeMetadataHash(b));
    expect(computeMetadataHash(a)).toMatch(/^0x[a-f0-9]{64}$/);
  });

  it('accepts matching fetched metadata hash', () => {
    const metadata = { context: { contract: { name: 'Token' } } };
    const hash = computeMetadataHash(metadata);

    const result = assertMetadataHashMatches(metadata, hash);

    expect(result.verified).toBe(true);
    expect(result.computedHash).toBe(hash);
  });

  it('rejects fetched metadata that does not match attested metadataHash', () => {
    const metadata = { context: { contract: { name: 'Wrong Token' } } };
    const attestedHash = '0x' + '1'.repeat(64);

    const result = assertMetadataHashMatches(metadata, attestedHash);

    expect(result.verified).toBe(false);
    expect(result.attestedHash).toBe(attestedHash);
    expect(result.error).toContain('metadata hash mismatch');
  });
});
