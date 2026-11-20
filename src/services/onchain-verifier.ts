/**
 * On-Chain Metadata Verifier
 *
 * Verifies a contract's ERC-7730 metadata against the KaiSignRegistry sparse Merkle
 * tree on Sepolia. Entries are keyed by (chainId, target), where target is the
 * transaction destination address (tx.to) on the target chain.
 *
 * Verification flow:
 * 1. Rebuild the SMT locally: seed leaves + SmtRootUpdated events since the seed block
 * 2. Read smtRoot() from the registry; the local root must equal it
 * 3. Look up the slot for (chainId, target); empty = no approved metadata
 * 4. Resolve its metadataHash (seed file, or the finalized registry record)
 * 5. Check the inclusion proof of keccak256(abi.encode(LEAF_TYPEHASH, chainId, target, metadataHash))
 *    against the on-chain root
 * The caller then compares the attested metadataHash with the local metadata file.
 *
 * With a Nethermind light client serving Sepolia (LIGHT_CLIENT_RPC_URL), every read that
 * the verdict depends on (eth_blockNumber, smtRoot, getLatestSpecForTarget, getAttestation)
 * goes to the light client only, so it is checked against sync-committee-authenticated
 * state instead of trusting an RPC provider. SmtRootUpdated logs are only replay input:
 * a wrong or incomplete log set cannot pass step 2, so they may fall back to public RPCs
 * when the light client cannot serve the range (disable with LIGHT_CLIENT_ONLY=true).
 */

import { Interface, getAddress } from 'ethers';
import {
  CACHE_TTL,
  KAISIGN_REGISTRY,
  KAISIGN_SMT_SEED_FILE,
  RPC_URLS,
  SEPOLIA_CHAIN_ID
} from '../config/constants.js';
import { cacheManager } from './cache-manager.js';
import {
  SMT_ROOT_UPDATED_TOPIC,
  RootUpdate,
  SmtSeed,
  SparseMerkleTree,
  ZERO_HASH,
  buildTree,
  decodeRootUpdate,
  loadSeed,
  smtKey,
  smtLeaf,
  verifySmtProof
} from './registry-smt.js';
import { LIGHT_CLIENT_MAX_LOG_RANGE, LightClientRegistry, lightClientOnly, lightClients } from './light-client.js';

export interface AttestationComponents {
  chainId: number;
  target: string;
  metadataHash: string;
  revoked: boolean;
  /** 'bonded' = finalized through commit/reveal/Reality.eth; 'owner-seed' = imported with the migrated root */
  approval: 'bonded' | 'owner-seed';
  uid?: string;
  blobHash?: string;
  attester?: string;
  finalizedAt?: number;
}

export interface VerificationResult {
  verified: boolean;
  source: 'leaf-verified' | 'local-metadata' | 'mismatch' | 'error';
  details: string | null;
  hash: string | null;
  onChainHash: string | null;
  /** Which RPC the registry state behind this verdict was read from */
  registryReadVia?: 'light-client' | 'rpc';
  uid?: string;
  attestationComponents?: AttestationComponents;
}

const REGISTRY_IFACE = new Interface([
  'function smtRoot() view returns (bytes32)',
  'function getLatestSpecForTarget(uint256 chainId, address target) view returns (bytes32 uid, bool valid)',
  'function getAttestation(bytes32 uid) view returns ((bytes32 uid, uint256 chainId, address target, bytes32 blobHash, bytes32 metadataHash, address attester, uint64 timestamp, bool revoked, uint64 finalizedAt, uint64 revokeProposedAt, address revokeProposer, uint32 revokeAttempt))'
]);

const FETCH_TIMEOUT_MS = Number(process.env.KAISIGN_MCP_FETCH_TIMEOUT_MS || 15000);
const LOG_BLOCK_RANGE = Number(process.env.KAISIGN_SMT_LOG_BLOCK_RANGE || 10000);
const SMT_CONFIRMATIONS = Number(process.env.KAISIGN_SMT_CONFIRMATIONS || 2);

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

interface TreeState {
  tree: SparseMerkleTree;
  metadataHashByKey: Map<string, string>;
  updates: RootUpdate[];
  syncedToBlock: number;
  syncedAt: number;
}

export class OnChainVerifier {
  private registryAddress: string;
  private rpcUrls: string[];
  private seedFile: string;
  private currentRpcIndex: number = 0;
  private seed: SmtSeed | null = null;
  private state: TreeState | null = null;
  private lightClients?: LightClientRegistry;

  constructor(config?: { registryAddress?: string; rpcUrls?: string[]; seedFile?: string; lightClients?: LightClientRegistry }) {
    this.registryAddress = getAddress(config?.registryAddress ?? KAISIGN_REGISTRY);
    this.rpcUrls = config?.rpcUrls ?? RPC_URLS[SEPOLIA_CHAIN_ID];
    this.seedFile = config?.seedFile ?? KAISIGN_SMT_SEED_FILE;
    // Explicit rpcUrls pin the verifier to those endpoints (tests, custom deployments).
    this.lightClients = config?.lightClients ?? (config?.rpcUrls ? undefined : lightClients);
  }

  /** Light client serving the registry chain, if configured and reachable. */
  private async registryLightClient(): Promise<string | undefined> {
    return this.lightClients?.urlFor(SEPOLIA_CHAIN_ID);
  }

  private getRpcUrl(): string {
    return this.rpcUrls[this.currentRpcIndex % this.rpcUrls.length];
  }

  /** Host only: RPC URLs from env often carry an API key in the path or query. */
  private rpcLabel(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return `RPC #${this.rpcUrls.indexOf(url)}`;
    }
  }

  private rotateRpc(): void {
    this.currentRpcIndex = (this.currentRpcIndex + 1) % this.rpcUrls.length;
  }

  private async rpcCall<T = string>(method: string, params: unknown[], url: string = this.getRpcUrl()): Promise<T> {
    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params })
    });
    const data = await response.json() as { result?: T; error?: { message: string } };
    if (data.error) throw new Error(data.error.message);
    return data.result as T;
  }

  /** JSON-RPC against the registry chain, retrying once on another RPC. */
  private async sepoliaRpc<T = string>(method: string, params: unknown[]): Promise<T> {
    const firstUrl = this.getRpcUrl();
    try {
      return await this.rpcCall<T>(method, params);
    } catch (e) {
      this.rotateRpc();
      console.warn(`[OnChainVerifier] RPC ${this.rpcLabel(firstUrl)} failed (${(e as Error).message}), retrying via ${this.rpcLabel(this.getRpcUrl())}`);
      return await this.rpcCall<T>(method, params);
    }
  }

  /**
   * JSON-RPC for reads the verdict depends on: the light client alone when it serves
   * Sepolia (no silent fallback to an unverified provider), otherwise the rotation.
   */
  private async trustedRpc<T = string>(method: string, params: unknown[]): Promise<T> {
    const lightClient = await this.registryLightClient();
    if (lightClient) return this.rpcCall<T>(method, params, lightClient);
    return this.sepoliaRpc<T>(method, params);
  }

  private async callRegistry(fn: string, args: unknown[], blockTag: string = 'latest'): Promise<ReturnType<Interface['decodeFunctionResult']>> {
    const result = await this.trustedRpc('eth_call', [{ to: this.registryAddress, data: REGISTRY_IFACE.encodeFunctionData(fn, args) }, blockTag]);
    if (!result || result === '0x') {
      throw new Error(`registry ${this.registryAddress} returned no data for ${fn}; it may not expose the address-keyed API`);
    }
    return REGISTRY_IFACE.decodeFunctionResult(fn, result);
  }

  /** smtRoot() at a specific block, so it can be compared with a tree synced to that block. */
  async getOnChainRoot(blockNumber: number): Promise<string> {
    const [root] = await this.callRegistry('smtRoot', [], '0x' + blockNumber.toString(16));
    return String(root).toLowerCase();
  }

  private async fetchRootUpdates(fromBlock: number, toBlock: number): Promise<RootUpdate[]> {
    const lightClient = await this.registryLightClient();
    if (!lightClient) return this.fetchRootUpdatesVia(fromBlock, toBlock, LOG_BLOCK_RANGE, (m, p) => this.sepoliaRpc(m, p));

    try {
      return await this.fetchRootUpdatesVia(fromBlock, toBlock, Math.min(LOG_BLOCK_RANGE, LIGHT_CLIENT_MAX_LOG_RANGE),
        (m, p) => this.rpcCall(m, p, lightClient));
    } catch (e) {
      if (lightClientOnly()) throw e;
      // Logs are untrusted replay input; the rebuilt root is still checked against the
      // light-client-verified smtRoot, so a public RPC cannot forge a passing tree.
      console.warn(`[OnChainVerifier] light client could not serve SmtRootUpdated logs ${fromBlock}-${toBlock} (${(e as Error).message}); replaying them from public RPCs, root still checked via the light client`);
      return this.fetchRootUpdatesVia(fromBlock, toBlock, LOG_BLOCK_RANGE, (m, p) => this.sepoliaRpc(m, p));
    }
  }

  private async fetchRootUpdatesVia(
    fromBlock: number,
    toBlock: number,
    range: number,
    rpc: <T>(method: string, params: unknown[]) => Promise<T>
  ): Promise<RootUpdate[]> {
    const updates: RootUpdate[] = [];
    for (let start = fromBlock; start <= toBlock; start += range) {
      const end = Math.min(start + range - 1, toBlock);
      const logs = await rpc<Array<{ topics: string[]; data: string; blockNumber: string; logIndex: string }>>('eth_getLogs', [{
        address: this.registryAddress,
        topics: [SMT_ROOT_UPDATED_TOPIC],
        fromBlock: '0x' + start.toString(16),
        toBlock: '0x' + end.toString(16)
      }]);
      logs.sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.logIndex) - BigInt(b.logIndex)));
      updates.push(...logs.map(decodeRootUpdate));
    }
    return updates;
  }

  /** Rebuild or extend the local tree up to the latest block. */
  async syncTree(): Promise<TreeState> {
    if (this.state && Date.now() - this.state.syncedAt < CACHE_TTL) return this.state;

    if (!this.seed) {
      this.seed = loadSeed(this.seedFile);
      if (getAddress(this.seed.registry) !== this.registryAddress) {
        throw new Error(`SMT seed ${this.seedFile} is for registry ${this.seed.registry}, verifier uses ${this.registryAddress}`);
      }
    }

    // Stay a few blocks behind head so every RPC in the rotation can serve the range.
    const latest = Number(BigInt(await this.trustedRpc('eth_blockNumber', []))) - SMT_CONFIRMATIONS;
    const fromBlock = this.state ? this.state.syncedToBlock + 1 : this.seed.fromBlock;
    const newUpdates = fromBlock <= latest ? await this.fetchRootUpdates(fromBlock, latest) : [];
    const updates = [...(this.state?.updates ?? []), ...newUpdates];

    const { tree, metadataHashByKey } = this.state && newUpdates.length === 0
      ? this.state
      : buildTree(this.seed, updates);

    this.state = { tree, metadataHashByKey, updates, syncedToBlock: latest, syncedAt: Date.now() };
    return this.state;
  }

  /** Resolve the metadataHash behind a non-empty slot, and how it was approved. */
  private async resolveEntry(state: TreeState, key: string, chainId: number, target: string, leaf: string): Promise<AttestationComponents | null> {
    const seeded = state.metadataHashByKey.get(key.toLowerCase());
    if (seeded && smtLeaf(chainId, target, seeded) === leaf) {
      return { chainId, target, metadataHash: seeded, revoked: false, approval: 'owner-seed' };
    }

    const [uid, valid] = await this.callRegistry('getLatestSpecForTarget', [chainId, target]);
    if (!valid || uid === ZERO_HASH) return null;
    const [att] = await this.callRegistry('getAttestation', [uid]);
    if (smtLeaf(chainId, target, att.metadataHash) !== leaf) return null;
    return {
      chainId,
      target,
      metadataHash: String(att.metadataHash).toLowerCase(),
      revoked: Boolean(att.revoked),
      approval: 'bonded',
      uid,
      blobHash: att.blobHash,
      attester: getAddress(att.attester),
      finalizedAt: Number(att.finalizedAt)
    };
  }

  /**
   * Full verification flow for (target, chainId).
   */
  async verifyMetadata(contractAddress: string, chainId: number): Promise<VerificationResult> {
    const cached = cacheManager.getVerification<VerificationResult>(contractAddress, chainId);
    if (cached) {
      return cached;
    }

    const result: VerificationResult = {
      verified: false,
      source: 'local-metadata',
      details: null,
      hash: null,
      onChainHash: null
    };

    try {
      const target = getAddress(contractAddress);
      result.registryReadVia = (await this.registryLightClient()) ? 'light-client' : 'rpc';
      const state = await this.syncTree();
      const onChainRoot = await this.getOnChainRoot(state.syncedToBlock);
      result.onChainHash = onChainRoot;

      if (state.tree.root() !== onChainRoot) {
        result.source = 'error';
        result.details = `Local SMT root ${state.tree.root()} does not match on-chain smtRoot ${onChainRoot}`;
        cacheManager.setVerification(contractAddress, chainId, result);
        return result;
      }

      const key = smtKey(chainId, target);
      const leaf = state.tree.get(key);
      if (leaf === ZERO_HASH) {
        result.details = 'No approved metadata for this contract in the registry SMT';
        cacheManager.setVerification(contractAddress, chainId, result);
        return result;
      }
      result.hash = leaf;

      const entry = await this.resolveEntry(state, key, chainId, target, leaf);
      if (!entry) {
        result.source = 'mismatch';
        result.details = `SMT slot for ${target} on chain ${chainId} holds leaf ${leaf}, but no known metadataHash produces it`;
        cacheManager.setVerification(contractAddress, chainId, result);
        return result;
      }
      result.attestationComponents = entry;
      result.uid = entry.uid;

      if (verifySmtProof(key, smtLeaf(chainId, target, entry.metadataHash), state.tree.proof(key), onChainRoot)) {
        result.verified = true;
        result.source = 'leaf-verified';
        result.details = `SMT inclusion proof verified against on-chain root (${entry.approval === 'bonded' ? 'bonded finalization' : 'owner-imported seed'})`
          + (result.registryReadVia === 'light-client' ? '; registry state verified by the Nethermind light client' : '');
      } else {
        result.source = 'mismatch';
        result.details = `SMT inclusion proof failed against on-chain root ${onChainRoot}`;
      }
    } catch (e) {
      result.source = 'error';
      result.details = `Verification error: ${(e as Error).message}`;
    }

    cacheManager.setVerification(contractAddress, chainId, result);
    return result;
  }
}

// Global verifier instance
export const onChainVerifier = new OnChainVerifier();
