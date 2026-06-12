/**
 * On-Chain Metadata Verifier
 *
 * Verifies fetched ERC-7730 metadata against on-chain leaf hashes stored in the
 * KaiSignRegistry contract on Sepolia.
 *
 * Verification flow (v1-core leaf hash):
 * 1. Get extcodehash of the contract via eth_getCode + keccak256
 * 2. Query registry: getLatestSpecForBytecode(chainId, extcodehash) → UID
 * 3. Query registry: getAttestation(uid) → parse Attestation struct → leaf components
 * 4. Compute leaf hash locally: keccak256(abi.encode(LEAF_TYPEHASH, chainId, extcodehash, metadataHash, idx, revoked))
 * 5. Query registry: computeAttestationLeaf(uid) → on-chain leaf hash
 * 6. Compare localLeaf === onChainLeaf
 */

import { keccak256, toUtf8Bytes, getBytes, hexlify } from 'ethers';
import {
  KAISIGN_REGISTRY,
  SEPOLIA_RPC_URLS,
  RPC_URLS,
  LEAF_TYPEHASH_STRING
} from '../config/constants.js';
import { cacheManager } from './cache-manager.js';

export interface VerificationResult {
  verified: boolean;
  source: 'leaf-verified' | 'local-metadata' | 'mismatch' | 'error';
  details: string | null;
  hash: string | null;
  onChainHash: string | null;
  uid?: string;
  attestationComponents?: AttestationComponents;
}

interface AttestationComponents {
  chainId: number;
  extcodehash: string;
  metadataHash: string;
  idx: number;
  revoked: boolean;
}

interface FunctionSelectors {
  getLatestSpecForBytecode: string;
  getAttestation: string;
  computeAttestationLeaf: string;
}

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
  private selectors: FunctionSelectors;
  private LEAF_TYPEHASH: string;

  constructor(config?: { registryAddress?: string; rpcUrls?: string[] }) {
    this.registryAddress = config?.registryAddress ?? KAISIGN_REGISTRY;
    this.rpcUrls = config?.rpcUrls ?? SEPOLIA_RPC_URLS;
    this.selectors = this.computeSelectors();
    this.LEAF_TYPEHASH = keccak256(toUtf8Bytes(LEAF_TYPEHASH_STRING));
  }

  /**
   * Compute function selectors for registry calls
   */
  private computeSelectors(): FunctionSelectors {
    return {
      getLatestSpecForBytecode: keccak256(toUtf8Bytes('getLatestSpecForBytecode(uint256,bytes32)')).slice(0, 10),
      getAttestation: keccak256(toUtf8Bytes('getAttestation(bytes32)')).slice(0, 10),
      computeAttestationLeaf: keccak256(toUtf8Bytes('computeAttestationLeaf(bytes32)')).slice(0, 10)
    };
  }

  /**
   * Get the current RPC URL, rotating on failure
   */
  private getRpcUrl(): string {
    return this.rpcUrls[this.currentRpcIndex % this.rpcUrls.length];
  }

  /**
   * Rotate to next RPC URL on failure
   */
  private rotateRpc(): void {
    this.currentRpcIndex = (this.currentRpcIndex + 1) % this.rpcUrls.length;
  }

  /**
   * Make a JSON-RPC call
   */
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
   * Make an eth_call to a contract on Sepolia (where registry lives)
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

  /**
   * Get the bytecode of a contract and compute its keccak256 hash (extcodehash)
   */
  async getExtcodehash(address: string, chainId: number): Promise<string | null> {
    try {
      const rpcUrls = RPC_URLS[chainId] ?? RPC_URLS[1];
      const bytecode = await this.rpcCall('eth_getCode', [address, 'latest'], rpcUrls[0]);

      if (!bytecode || bytecode === '0x') {
        return null; // EOA or empty contract
      }

      return keccak256(bytecode);
    } catch (e) {
      console.warn('[OnChainVerifier] Failed to get extcodehash:', (e as Error).message);
      return null;
    }
  }

  /**
   * ABI-encode a uint256 value as a 32-byte hex string (no 0x prefix)
   */
  private encodeUint256(value: number | bigint): string {
    return BigInt(value).toString(16).padStart(64, '0');
  }

  /**
   * ABI-encode a bytes32 value as a 32-byte hex string (no 0x prefix)
   */
  private encodeBytes32(value: string): string {
    const hex = value.startsWith('0x') ? value.slice(2) : value;
    return hex.padStart(64, '0');
  }

  /**
   * ABI-encode a bool value as a 32-byte hex string (no 0x prefix)
   */
  private encodeBool(value: boolean): string {
    return value ? '0'.repeat(63) + '1' : '0'.repeat(64);
  }

  /**
   * Compute leaf hash from leaf components
   */
  computeLeafHash(components: AttestationComponents): string {
    const encoded = '0x' +
      this.encodeBytes32(this.LEAF_TYPEHASH) +
      this.encodeUint256(components.chainId) +
      this.encodeBytes32(components.extcodehash) +
      this.encodeBytes32(components.metadataHash) +
      this.encodeUint256(components.idx) +
      this.encodeBool(components.revoked);

    return keccak256(getBytes(encoded));
  }

  /**
   * Query registry for latest spec by bytecode hash
   */
  async getLatestSpec(chainId: number, extcodehash: string): Promise<{ uid: string | null; valid: boolean }> {
    const calldata = this.selectors.getLatestSpecForBytecode +
      this.encodeUint256(chainId) +
      this.encodeBytes32(extcodehash);

    const result = await this.ethCallSepolia(this.registryAddress, calldata);

    if (!result || result === '0x' || result.length < 66) {
      return { uid: null, valid: false };
    }

    const uid = '0x' + result.slice(2, 66);
    const isZero = uid === '0x' + '0'.repeat(64);

    return { uid: isZero ? null : uid, valid: !isZero };
  }

  /**
   * Get attestation leaf components from the registry
   */
  async getAttestationComponents(uid: string): Promise<AttestationComponents | null> {
    const calldata = this.selectors.getAttestation + this.encodeBytes32(uid);
    const result = await this.ethCallSepolia(this.registryAddress, calldata);

    if (!result || result === '0x' || result.length < 66) {
      return null;
    }

    try {
      const hex = result.slice(2);

      if (hex.length < 704) {
        return null;
      }

      return {
        chainId: Number(BigInt('0x' + hex.slice(64, 128))),
        extcodehash: '0x' + hex.slice(128, 192),
        metadataHash: '0x' + hex.slice(256, 320),
        idx: Number(BigInt('0x' + hex.slice(448, 512))),
        revoked: BigInt('0x' + hex.slice(512, 576)) !== 0n
      };
    } catch (e) {
      console.warn('[OnChainVerifier] Failed to decode attestation struct:', (e as Error).message);
      return null;
    }
  }

  /**
   * Call computeAttestationLeaf(uid) on the registry contract
   */
  async getOnChainLeaf(uid: string): Promise<string | null> {
    try {
      const calldata = this.selectors.computeAttestationLeaf + this.encodeBytes32(uid);
      const result = await this.ethCallSepolia(this.registryAddress, calldata);

      if (!result || result === '0x' || result.length < 66) {
        return null;
      }

      return '0x' + result.slice(2, 66);
    } catch (e) {
      console.warn('[OnChainVerifier] Failed to get on-chain leaf:', (e as Error).message);
      return null;
    }
  }

  /**
   * Full verification flow
   */
  async verifyMetadata(contractAddress: string, chainId: number): Promise<VerificationResult> {
    // Check cache first
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
      // Step 1: Get extcodehash
      const extcodehash = await this.getExtcodehash(contractAddress, chainId);
      if (!extcodehash) {
        result.details = 'Could not get contract bytecode hash';
        cacheManager.setVerification(contractAddress, chainId, result);
        return result;
      }

      // Step 2: Query registry for UID
      const spec = await this.getLatestSpec(chainId, extcodehash);
      if (!spec.valid || !spec.uid) {
        result.details = 'No attestation found on-chain for this contract';
        cacheManager.setVerification(contractAddress, chainId, result);
        return result;
      }
      result.uid = spec.uid;

      // Step 3: Get attestation components
      const components = await this.getAttestationComponents(spec.uid);
      if (!components) {
        result.details = 'Could not parse attestation struct';
        cacheManager.setVerification(contractAddress, chainId, result);
        return result;
      }
      result.attestationComponents = components;

      // Step 4: Compute leaf hash locally
      const recomputedLeaf = this.computeLeafHash(components);
      result.hash = recomputedLeaf;

      // Step 5: Get on-chain leaf hash
      const onChainLeaf = await this.getOnChainLeaf(spec.uid);
      if (!onChainLeaf) {
        result.details = 'Could not compute on-chain leaf hash';
        cacheManager.setVerification(contractAddress, chainId, result);
        return result;
      }
      result.onChainHash = onChainLeaf;

      // Step 6: Compare
      if (recomputedLeaf.toLowerCase() === onChainLeaf.toLowerCase()) {
        result.verified = true;
        result.source = 'leaf-verified';
        result.details = 'Leaf hash verified against on-chain registry';
      } else {
        result.source = 'mismatch';
        result.details = `Leaf mismatch: recomputed=${recomputedLeaf.slice(0, 18)}... on-chain=${onChainLeaf.slice(0, 18)}...`;
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
