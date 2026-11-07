/**
 * On-Chain Metadata Verifier
 *
 * Verifies a contract's ERC-7730 metadata against the KaiSignRegistry SMT on Sepolia.
 * Registry entries are keyed by (chainId, target), where target is the transaction
 * destination address (tx.to) on the target chain.
 *
 * Verification flow:
 * 1. getLatestSpecForTarget(chainId, target) → latest finalized, non-revoked UID
 * 2. getAttestation(uid) → record; must match (chainId, target), be finalized and not revoked
 * 3. Compute leaf locally: keccak256(abi.encode(LEAF_TYPEHASH, chainId, target, metadataHash))
 * 4. approvedLeaf(chainId, target, metadataHash) on-chain → must equal the local leaf
 *    (proves the deployment uses the same address-keyed leaf scheme)
 * The caller then checks the attested metadataHash against the local metadata file.
 */

import { AbiCoder, Interface, getAddress, keccak256, toUtf8Bytes } from 'ethers';
import {
  KAISIGN_REGISTRY,
  SEPOLIA_RPC_URLS,
  LEAF_TYPEHASH_STRING
} from '../config/constants.js';
import { cacheManager } from './cache-manager.js';

export interface AttestationComponents {
  uid: string;
  chainId: number;
  target: string;
  blobHash: string;
  metadataHash: string;
  attester: string;
  finalizedAt: number;
  revoked: boolean;
}

export interface VerificationResult {
  verified: boolean;
  source: 'leaf-verified' | 'local-metadata' | 'mismatch' | 'error';
  details: string | null;
  hash: string | null;
  onChainHash: string | null;
  uid?: string;
  attestationComponents?: AttestationComponents;
}

const REGISTRY_IFACE = new Interface([
  'function getLatestSpecForTarget(uint256 chainId, address target) view returns (bytes32 uid, bool valid)',
  'function getAttestation(bytes32 uid) view returns ((bytes32 uid, uint256 chainId, address target, bytes32 blobHash, bytes32 metadataHash, address attester, uint64 timestamp, bool revoked, uint64 finalizedAt, uint64 revokeProposedAt, address revokeProposer, uint32 revokeAttempt))',
  'function approvedLeaf(uint256 chainId, address target, bytes32 metadataHash) pure returns (bytes32)'
]);

const ZERO_BYTES32 = '0x' + '0'.repeat(64);
const FETCH_TIMEOUT_MS = Number(process.env.KAISIGN_MCP_FETCH_TIMEOUT_MS || 15000);

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export class OnChainVerifier {
  private registryAddress: string;
  private rpcUrls: string[];
  private currentRpcIndex: number = 0;
  private LEAF_TYPEHASH: string;

  constructor(config?: { registryAddress?: string; rpcUrls?: string[] }) {
    this.registryAddress = config?.registryAddress ?? KAISIGN_REGISTRY;
    this.rpcUrls = config?.rpcUrls ?? SEPOLIA_RPC_URLS;
    this.LEAF_TYPEHASH = keccak256(toUtf8Bytes(LEAF_TYPEHASH_STRING));
  }

  private getRpcUrl(): string {
    return this.rpcUrls[this.currentRpcIndex % this.rpcUrls.length];
  }

  private rotateRpc(): void {
    this.currentRpcIndex = (this.currentRpcIndex + 1) % this.rpcUrls.length;
  }

  private async rpcCall(method: string, params: unknown[], rpcUrl?: string): Promise<string> {
    const url = rpcUrl ?? this.getRpcUrl();

    const response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method,
        params
      })
    });

    const data = await response.json() as { result?: string; error?: { message: string } };

    if (data.error) {
      throw new Error(data.error.message);
    }

    return data.result ?? '0x';
  }

  /**
   * eth_call against the registry on Sepolia, retrying once on another RPC.
   */
  private async ethCallSepolia(to: string, data: string): Promise<string> {
    const firstUrl = this.getRpcUrl();
    try {
      return await this.rpcCall('eth_call', [{ to, data }, 'latest']);
    } catch (e) {
      this.rotateRpc();
      console.warn(`[OnChainVerifier] RPC ${firstUrl} failed (${(e as Error).message}), retrying via ${this.getRpcUrl()}`);
      return await this.rpcCall('eth_call', [{ to, data }, 'latest']);
    }
  }

  private async callRegistry(fn: string, args: unknown[]): Promise<ReturnType<Interface['decodeFunctionResult']>> {
    const result = await this.ethCallSepolia(this.registryAddress, REGISTRY_IFACE.encodeFunctionData(fn, args));
    if (!result || result === '0x') {
      throw new Error(`registry ${this.registryAddress} returned no data for ${fn}; it may not expose the address-keyed API`);
    }
    return REGISTRY_IFACE.decodeFunctionResult(fn, result);
  }

  /**
   * SMT leaf: keccak256(abi.encode(LEAF_TYPEHASH, chainId, target, metadataHash))
   */
  computeLeafHash(components: Pick<AttestationComponents, 'chainId' | 'target' | 'metadataHash'>): string {
    return keccak256(AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'uint256', 'address', 'bytes32'],
      [this.LEAF_TYPEHASH, components.chainId, components.target, components.metadataHash]
    ));
  }

  /**
   * SMT key: keccak256(abi.encode(chainId, target))
   */
  computeSmtKey(chainId: number, target: string): string {
    return keccak256(AbiCoder.defaultAbiCoder().encode(['uint256', 'address'], [chainId, target]));
  }

  async getLatestSpec(chainId: number, target: string): Promise<{ uid: string | null; valid: boolean }> {
    const [uid, valid] = await this.callRegistry('getLatestSpecForTarget', [chainId, target]);
    const isZero = uid === ZERO_BYTES32;
    return { uid: isZero ? null : uid, valid: Boolean(valid) && !isZero };
  }

  async getAttestationComponents(uid: string): Promise<AttestationComponents | null> {
    const [att] = await this.callRegistry('getAttestation', [uid]);
    if (!att || att.uid === ZERO_BYTES32) return null;
    return {
      uid: att.uid,
      chainId: Number(att.chainId),
      target: getAddress(att.target),
      blobHash: att.blobHash,
      metadataHash: att.metadataHash,
      attester: getAddress(att.attester),
      finalizedAt: Number(att.finalizedAt),
      revoked: Boolean(att.revoked)
    };
  }

  async getOnChainLeaf(components: Pick<AttestationComponents, 'chainId' | 'target' | 'metadataHash'>): Promise<string> {
    const [leaf] = await this.callRegistry('approvedLeaf', [components.chainId, components.target, components.metadataHash]);
    return leaf;
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

      const spec = await this.getLatestSpec(chainId, target);
      if (!spec.valid || !spec.uid) {
        result.details = 'No attestation found on-chain for this contract';
        cacheManager.setVerification(contractAddress, chainId, result);
        return result;
      }
      result.uid = spec.uid;

      const components = await this.getAttestationComponents(spec.uid);
      if (!components) {
        result.details = `Registry returned no record for uid ${spec.uid}`;
        cacheManager.setVerification(contractAddress, chainId, result);
        return result;
      }
      result.attestationComponents = components;

      if (components.chainId !== chainId || components.target !== target) {
        result.source = 'mismatch';
        result.details = `Record ${spec.uid} is for ${components.target} on chain ${components.chainId}, not ${target} on chain ${chainId}`;
      } else if (components.revoked || components.finalizedAt === 0) {
        result.source = 'mismatch';
        result.details = components.revoked ? `Record ${spec.uid} is revoked` : `Record ${spec.uid} is not finalized`;
      } else {
        const localLeaf = this.computeLeafHash(components);
        const onChainLeaf = await this.getOnChainLeaf(components);
        result.hash = localLeaf;
        result.onChainHash = onChainLeaf;

        if (localLeaf.toLowerCase() === onChainLeaf.toLowerCase()) {
          result.verified = true;
          result.source = 'leaf-verified';
          result.details = 'Finalized registry record verified; leaf matches the registry SMT leaf scheme';
        } else {
          result.source = 'mismatch';
          result.details = `Leaf mismatch: local=${localLeaf} on-chain=${onChainLeaf}`;
        }
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
