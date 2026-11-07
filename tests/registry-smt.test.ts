import { describe, it, expect } from 'vitest';
import { concat, keccak256 } from 'ethers';
import { KAISIGN_SMT_SEED_FILE } from '../src/config/constants.js';
import {
  ZERO_HASH,
  buildTree,
  loadSeed,
  smtKey,
  smtLeaf,
  verifySmtProof
} from '../src/services/registry-smt.js';

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const META = '0x' + '2'.repeat(64);

// Same walk as SparseMerkleTree._computeSmtRoot: new root after writing `value` at `key`.
function computeRoot(key: string, value: string, siblings: string[]): string {
  const hashNode = (l: string, r: string) => (l === ZERO_HASH && r === ZERO_HASH ? ZERO_HASH : keccak256(concat([l, r])));
  let node = value;
  for (let i = 0; i < 256; i++) {
    const s = siblings[255 - i];
    node = ((BigInt(key) >> BigInt(i)) & 1n) === 0n ? hashNode(node, s) : hashNode(s, node);
  }
  return node;
}

describe('registry SMT hashing', () => {
  // Golden vectors from `cast abi-encode` + `cast keccak`
  it('matches the Solidity key encoding', () => {
    expect(smtKey(1, USDC)).toBe('0xb340dcebc6634c8db42e41014206798ccc4b36e5bf3a1ed61b89a5f70afa8cd4');
  });

  it('matches the Solidity address-keyed leaf encoding', () => {
    expect(smtLeaf(1, USDC, META)).toBe('0x9cbe189f572ea7793b5f21cf36de9e0e7ca1537d04fea83c8e843f7e44588432');
    expect(smtLeaf(8453, USDC, META)).toBe('0xd77b0d7850e3c1112517432feaaac69ba70cc6a33c60f9dc529f28ba2756c101');
    expect(smtLeaf(1, USDC.toLowerCase(), META)).toBe(smtLeaf(1, USDC, META));
  });
});

describe('registry SMT tree', () => {
  const seed = loadSeed(KAISIGN_SMT_SEED_FILE);
  const { tree } = buildTree(seed, []);

  it('rebuilds the seed root from the seed leaves', () => {
    expect(tree.root()).toBe(seed.root.toLowerCase());
    expect(tree.size).toBe(seed.leaves.length);
  });

  it('proves inclusion of a seeded leaf and rejects tampered metadata', () => {
    const leaf = seed.leaves.find(l => l.target.toLowerCase() === USDC.toLowerCase())!;
    const key = smtKey(1, USDC);
    const proof = tree.proof(key);
    expect(verifySmtProof(key, smtLeaf(1, USDC, leaf.metadataHash), proof, seed.root)).toBe(true);
    expect(verifySmtProof(key, smtLeaf(1, USDC, META), proof, seed.root)).toBe(false);
  });

  it('proves exclusion of an empty slot', () => {
    const key = smtKey(1, '0x1234567890123456789012345678901234567890');
    expect(tree.get(key)).toBe(ZERO_HASH);
    expect(verifySmtProof(key, ZERO_HASH, tree.proof(key), seed.root)).toBe(true);
  });

  it('replays SmtRootUpdated insert and remove like the registry', () => {
    const target = '0x1234567890123456789012345678901234567890';
    const key = smtKey(1, target);
    const newLeaf = smtLeaf(1, target, META);
    const insertedRoot = computeRoot(key, newLeaf, tree.proof(key));

    const inserted = buildTree(seed, [{ newRoot: insertedRoot, key, oldLeaf: ZERO_HASH, newLeaf }]).tree;
    expect(inserted.root()).toBe(insertedRoot);
    expect(verifySmtProof(key, newLeaf, inserted.proof(key), insertedRoot)).toBe(true);

    const removedRoot = computeRoot(key, ZERO_HASH, inserted.proof(key));
    expect(removedRoot).toBe(seed.root.toLowerCase());
    const removed = buildTree(seed, [
      { newRoot: insertedRoot, key, oldLeaf: ZERO_HASH, newLeaf },
      { newRoot: removedRoot, key, oldLeaf: newLeaf, newLeaf: ZERO_HASH }
    ]).tree;
    expect(removed.root()).toBe(seed.root.toLowerCase());
  });

  it('rejects an event stream that does not match the local tree', () => {
    const key = smtKey(1, USDC);
    expect(() => buildTree(seed, [{ newRoot: ZERO_HASH, key, oldLeaf: ZERO_HASH, newLeaf: META }])).toThrow(/expects old leaf/);
  });
});
