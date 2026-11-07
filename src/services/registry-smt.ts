/**
 * Local mirror of the KaiSignRegistry depth-256 sparse Merkle tree.
 *
 * The registry stores only the root. The leaf set is rebuilt from the seed file
 * (leaves behind the root imported at the address-keyed upgrade) plus every
 * SmtRootUpdated(newRoot, key, oldLeaf, newLeaf) event since `fromBlock`.
 * Hashing matches v1-core SparseMerkleTree.sol.
 */

import { readFileSync } from 'node:fs';
import { AbiCoder, concat, getAddress, id, keccak256, toUtf8Bytes } from 'ethers';
import { LEAF_TYPEHASH_STRING } from '../config/constants.js';

export const ZERO_HASH = '0x' + '00'.repeat(32);
const SMT_DEPTH = 256;
const LEAF_TYPEHASH = keccak256(toUtf8Bytes(LEAF_TYPEHASH_STRING));
const abi = AbiCoder.defaultAbiCoder();
export const SMT_ROOT_UPDATED_TOPIC = id('SmtRootUpdated(bytes32,bytes32,bytes32,bytes32)');

export function smtKey(chainId: number, target: string): string {
  return keccak256(abi.encode(['uint256', 'address'], [chainId, target]));
}

export function smtLeaf(chainId: number, target: string, metadataHash: string): string {
  return keccak256(abi.encode(['bytes32', 'uint256', 'address', 'bytes32'], [LEAF_TYPEHASH, chainId, target, metadataHash]));
}

function hashNode(left: string, right: string): string {
  return left === ZERO_HASH && right === ZERO_HASH ? ZERO_HASH : keccak256(concat([left, right]));
}

/** Same walk as SparseMerkleTree._verifySmtProof. */
export function verifySmtProof(key: string, value: string, siblings: string[], root: string): boolean {
  if (siblings.length !== SMT_DEPTH) return false;
  const k = BigInt(key);
  let node = value;
  for (let i = 0; i < SMT_DEPTH; i++) {
    const sibling = siblings[SMT_DEPTH - 1 - i];
    node = ((k >> BigInt(i)) & 1n) === 0n ? hashNode(node, sibling) : hashNode(sibling, node);
  }
  return node.toLowerCase() === root.toLowerCase();
}

export interface SeedLeaf {
  chainId: number;
  target: string;
  metadataHash: string;
}

export interface SmtSeed {
  registry: string;
  registryChainId: number;
  root: string;
  fromBlock: number;
  leaves: SeedLeaf[];
}

export function loadSeed(path: string): SmtSeed {
  const seed = JSON.parse(readFileSync(path, 'utf8')) as SmtSeed;
  if (!seed.root || !Array.isArray(seed.leaves) || !Number.isInteger(seed.fromBlock)) {
    throw new Error(`invalid SMT seed file ${path}: needs root, fromBlock and leaves[]`);
  }
  return seed;
}

/**
 * Sparse tree keeping only non-empty nodes. Node id = `${depth}:${prefix}` where
 * prefix is the top `depth` bits of the key (depth 0 = root).
 */
export class SparseMerkleTree {
  private leaves = new Map<string, string>(); // key -> leaf value
  private nodes = new Map<string, string>();
  private dirty = true;

  set(key: string, value: string): void {
    const k = key.toLowerCase();
    if (value.toLowerCase() === ZERO_HASH) this.leaves.delete(k);
    else this.leaves.set(k, value.toLowerCase());
    this.dirty = true;
  }

  get(key: string): string {
    return this.leaves.get(key.toLowerCase()) ?? ZERO_HASH;
  }

  get size(): number {
    return this.leaves.size;
  }

  private rebuild(): void {
    this.nodes.clear();
    const keys = [...this.leaves.keys()].map(k => BigInt(k)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const build = (lo: number, hi: number, depth: number): string => {
      if (lo >= hi) return ZERO_HASH;
      const prefix = keys[lo] >> BigInt(SMT_DEPTH - depth);
      let hash: string;
      if (depth === SMT_DEPTH) {
        hash = this.leaves.get('0x' + keys[lo].toString(16).padStart(64, '0'))!;
      } else {
        // keys are sorted, so the left child (next bit 0) is a contiguous prefix of [lo, hi)
        const shift = BigInt(SMT_DEPTH - depth - 1);
        let mid = lo;
        while (mid < hi && ((keys[mid] >> shift) & 1n) === 0n) mid++;
        hash = hashNode(build(lo, mid, depth + 1), build(mid, hi, depth + 1));
      }
      this.nodes.set(`${depth}:${prefix}`, hash);
      return hash;
    };
    build(0, keys.length, 0);
    this.dirty = false;
  }

  root(): string {
    if (this.dirty) this.rebuild();
    return this.nodes.get('0:0') ?? ZERO_HASH;
  }

  /** 256 siblings, top (depth 1) first, as finalize / verifyAttestation expect. */
  proof(key: string): string[] {
    if (this.dirty) this.rebuild();
    const k = BigInt(key);
    const siblings: string[] = [];
    for (let depth = 1; depth <= SMT_DEPTH; depth++) {
      const siblingPrefix = (k >> BigInt(SMT_DEPTH - depth)) ^ 1n;
      siblings.push(this.nodes.get(`${depth}:${siblingPrefix}`) ?? ZERO_HASH);
    }
    return siblings;
  }
}

export interface RootUpdate {
  newRoot: string;
  key: string;
  oldLeaf: string;
  newLeaf: string;
}

export function decodeRootUpdate(log: { topics: string[]; data: string }): RootUpdate {
  const [oldLeaf, newLeaf] = abi.decode(['bytes32', 'bytes32'], log.data);
  return { newRoot: log.topics[1], key: log.topics[2], oldLeaf, newLeaf };
}

/** Build the tree from seed leaves, check it reproduces the seed root, then apply updates in order. */
export function buildTree(seed: SmtSeed, updates: RootUpdate[]): { tree: SparseMerkleTree; metadataHashByKey: Map<string, string> } {
  const tree = new SparseMerkleTree();
  const metadataHashByKey = new Map<string, string>();
  for (const leaf of seed.leaves) {
    const target = getAddress(leaf.target);
    const key = smtKey(leaf.chainId, target);
    tree.set(key, smtLeaf(leaf.chainId, target, leaf.metadataHash));
    metadataHashByKey.set(key.toLowerCase(), leaf.metadataHash.toLowerCase());
  }
  if (tree.root() !== seed.root.toLowerCase()) {
    throw new Error(`SMT seed leaves give root ${tree.root()}, seed file says ${seed.root}`);
  }
  for (const update of updates) {
    if (tree.get(update.key) !== update.oldLeaf.toLowerCase()) {
      throw new Error(`SmtRootUpdated for key ${update.key} expects old leaf ${update.oldLeaf}, local tree has ${tree.get(update.key)}`);
    }
    tree.set(update.key, update.newLeaf);
    metadataHashByKey.delete(update.key.toLowerCase());
    if (tree.root() !== update.newRoot.toLowerCase()) {
      throw new Error(`replaying SmtRootUpdated gives root ${tree.root()}, event says ${update.newRoot}`);
    }
  }
  return { tree, metadataHashByKey };
}
