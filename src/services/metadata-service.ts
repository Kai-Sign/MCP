/**
 * Metadata Service
 * Fetches ERC-7730 metadata from KaiSign API with caching
 */

import {
  KAISIGN_API,
  RPC_URLS,
  EIP1967_IMPL_SLOT,
  SAFE_MASTER_COPY_SLOT
} from '../config/constants.js';
import { cacheManager } from './cache-manager.js';
import { onChainVerifier, VerificationResult } from './onchain-verifier.js';

export interface ContractMetadata {
  $schema?: string;
  context?: {
    contract?: {
      abi?: ABIEntry[];
      deployments?: Record<string, string>;
      name?: string;
      symbol?: string;
      decimals?: number;
    };
  };
  metadata?: {
    name?: string;
    symbol?: string;
    decimals?: number;
    description?: string;
  };
  display?: {
    formats?: Record<string, DisplayFormat>;
  };
  commandRegistries?: Record<string, CommandRegistry>;
  _verification?: VerificationResult;
}

export interface ABIEntry {
  type: string;
  name?: string;
  inputs?: ABIInput[];
  selector?: string;
}

export interface ABIInput {
  name: string;
  type: string;
  components?: ABIInput[];
}

export interface DisplayFormat {
  intent?: string | { type: string; template?: string };
  interpolatedIntent?: string;
  fields?: FieldDefinition[];
}

export interface FieldDefinition {
  path: string;
  label?: string;
  format?: string;
  params?: Record<string, unknown>;
  type?: string;
  to?: string;
}

export interface CommandRegistry {
  [commandByte: string]: CommandDefinition;
}

export interface CommandDefinition {
  name: string;
  intent?: string;
  inputs?: ABIInput[];
}

export interface TokenMetadata {
  symbol: string;
  decimals: number;
  name: string;
  address: string;
}

export class MetadataService {
  private apiBase: string;

  constructor(config?: { apiBase?: string }) {
    this.apiBase = config?.apiBase ?? KAISIGN_API;
  }

  /**
   * Make an eth_call via RPC
   */
  private async ethCall(to: string, data: string, chainId: number): Promise<string> {
    const rpcUrls = RPC_URLS[chainId] ?? RPC_URLS[1];

    const response = await fetch(rpcUrls[0], {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'eth_call',
        params: [{ to, data }, 'latest']
      })
    });

    const result = await response.json() as { result?: string; error?: { message: string } };
    return result.result ?? '0x';
  }

  /**
   * Get eth_getStorageAt via RPC
   */
  private async ethGetStorageAt(address: string, slot: string, chainId: number): Promise<string> {
    const rpcUrls = RPC_URLS[chainId] ?? RPC_URLS[1];

    const response = await fetch(rpcUrls[0], {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: Date.now(),
        method: 'eth_getStorageAt',
        params: [address, slot, 'latest']
      })
    });

    const result = await response.json() as { result?: string };
    return result.result ?? '0x';
  }

  /**
   * Get implementation address from proxy contract storage
   */
  async getImplementationAddress(proxyAddress: string, chainId: number): Promise<string | null> {
    const slots = [EIP1967_IMPL_SLOT, SAFE_MASTER_COPY_SLOT];

    for (const slot of slots) {
      try {
        const result = await this.ethGetStorageAt(proxyAddress, slot, chainId);
        if (result && result !== '0x' + '0'.repeat(64)) {
          const implAddress = '0x' + result.slice(-40).toLowerCase();
          if (implAddress !== '0x' + '0'.repeat(40)) {
            return implAddress;
          }
        }
      } catch {
        // Continue to next slot
      }
    }
    return null;
  }

  /**
   * Get Diamond facet address for a specific selector
   */
  async getDiamondFacetAddress(diamondAddress: string, selector: string, chainId: number): Promise<string | null> {
    const FACET_ADDRESS_SELECTOR = '0xcdffacc6';
    const paddedSelector = selector.slice(2).padStart(64, '0');
    const calldata = FACET_ADDRESS_SELECTOR + paddedSelector;

    try {
      const result = await this.ethCall(diamondAddress, calldata, chainId);

      if (result && result !== '0x' && result.length >= 66) {
        const facetAddr = '0x' + result.slice(-40).toLowerCase();
        if (facetAddr !== '0x' + '0'.repeat(40)) {
          return facetAddr;
        }
      }
    } catch {
      // Not a Diamond proxy
    }

    return null;
  }

  /**
   * Fetch metadata from API
   */
  private async fetchMetadataFromAPI(address: string, chainId: number): Promise<ContractMetadata | null> {
    const url = `${this.apiBase}/api/py/contract/${address.toLowerCase()}?chain_id=${chainId}`;

    const response = await fetch(url);
    const data = await response.json() as { success: boolean; metadata?: ContractMetadata; error?: string };

    if (!data.success || !data.metadata) {
      return null;
    }

    return data.metadata;
  }

  /**
   * Get contract metadata with proxy detection and verification
   */
  async getContractMetadata(
    address: string,
    chainId: number,
    selector?: string
  ): Promise<ContractMetadata | null> {
    const normalizedAddress = address.toLowerCase();

    // Check cache
    const cached = cacheManager.getMetadata<ContractMetadata>(normalizedAddress, chainId);
    if (cached) {
      return cached;
    }

    try {
      // Try direct lookup first
      let metadata = await this.fetchMetadataFromAPI(normalizedAddress, chainId);

      // If no metadata, try proxy detection
      if (!metadata) {
        // Try Diamond proxy first
        if (selector) {
          const facetAddress = await this.getDiamondFacetAddress(normalizedAddress, selector, chainId);
          if (facetAddress && facetAddress !== normalizedAddress) {
            metadata = await this.fetchMetadataFromAPI(facetAddress, chainId);
          }
        }

        // Try EIP-1967 / Safe proxy
        if (!metadata) {
          const implAddress = await this.getImplementationAddress(normalizedAddress, chainId);
          if (implAddress && implAddress !== normalizedAddress) {
            metadata = await this.fetchMetadataFromAPI(implAddress, chainId);
          }
        }
      }

      if (!metadata) {
        return null;
      }

      // Run on-chain verification
      try {
        const verification = await onChainVerifier.verifyMetadata(normalizedAddress, chainId);
        metadata._verification = verification;
      } catch (e) {
        metadata._verification = {
          verified: false,
          source: 'error',
          details: (e as Error).message,
          hash: null,
          onChainHash: null
        };
      }

      // Cache result
      cacheManager.setMetadata(normalizedAddress, chainId, metadata);

      return metadata;
    } catch (e) {
      console.error('[MetadataService] Failed to fetch metadata:', (e as Error).message);
      return null;
    }
  }

  /**
   * Get token metadata (symbol, decimals, name)
   */
  async getTokenMetadata(address: string, chainId: number): Promise<TokenMetadata> {
    const normalizedAddress = address.toLowerCase();

    // Check cache
    const cached = cacheManager.getToken<TokenMetadata>(normalizedAddress, chainId);
    if (cached) {
      return cached;
    }

    let symbol = '';
    let decimals = 18;
    let name = 'Unknown Token';

    // Try API first
    try {
      const metadata = await this.getContractMetadata(normalizedAddress, chainId);
      if (metadata) {
        symbol = metadata.metadata?.symbol ?? metadata.context?.contract?.symbol ?? '';
        decimals = metadata.metadata?.decimals ?? metadata.context?.contract?.decimals ?? 0;
        name = metadata.metadata?.name ?? metadata.context?.contract?.name ?? 'Unknown Token';
      }
    } catch {
      // Continue to on-chain lookup
    }

    // Fetch from on-chain if needed
    if (!decimals) {
      try {
        const result = await this.ethCall(normalizedAddress, '0x313ce567', chainId);
        if (result && result !== '0x') {
          decimals = parseInt(result, 16);
        }
      } catch {
        decimals = 18;
      }
    }

    if (!symbol) {
      try {
        const result = await this.ethCall(normalizedAddress, '0x95d89b41', chainId);
        if (result && result !== '0x' && result.length > 2) {
          symbol = this.decodeAbiString(result);
        }
      } catch {
        symbol = `${normalizedAddress.slice(0, 6)}...${normalizedAddress.slice(-4)}`;
      }
    }

    const tokenInfo: TokenMetadata = {
      symbol: symbol || 'TOKEN',
      decimals: decimals || 18,
      name,
      address: normalizedAddress
    };

    cacheManager.setToken(normalizedAddress, chainId, tokenInfo);
    return tokenInfo;
  }

  /**
   * Decode ABI-encoded string return value
   */
  private decodeAbiString(hexData: string): string {
    try {
      const data = hexData.slice(2);
      const offset = parseInt(data.slice(0, 64), 16) * 2;
      const length = parseInt(data.slice(offset, offset + 64), 16);
      const strHex = data.slice(offset + 64, offset + 64 + length * 2);

      let str = '';
      for (let i = 0; i < strHex.length; i += 2) {
        const charCode = parseInt(strHex.slice(i, i + 2), 16);
        if (charCode > 0) str += String.fromCharCode(charCode);
      }
      return str;
    } catch {
      return '';
    }
  }
}

// Global metadata service instance
export const metadataService = new MetadataService();
