/**
 * Metadata Service
 * Loads ERC-7730 metadata from local JSON files with caching.
 */

import {
  KAISIGN_METADATA_DIR,
  RPC_URLS,
  EIP1967_IMPL_SLOT,
  SAFE_MASTER_COPY_SLOT
} from '../config/constants.js';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cacheManager } from './cache-manager.js';
import { VerificationResult } from './onchain-verifier.js';
import { id as keccakId } from 'ethers';

const FETCH_TIMEOUT_MS = Number(process.env.KAISIGN_MCP_FETCH_TIMEOUT_MS || 15000);

async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export interface ContractMetadata {
  $schema?: string;
  context?: {
    contract?: {
      abi?: ABIEntry[];
      address?: string;
      chainId?: number;
      deployments?: Record<string, string | string[] | number>;
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
  recursive?: RecursiveRule[];
  recursiveRules?: RecursiveRule[];
  commandRegistries?: Record<string, CommandRegistry>;
  _verification?: VerificationResult;
}

export interface RecursiveRule {
  type: 'calldata' | 'calls' | 'parallelCalls' | 'commands' | string;
  calldataPath?: string;
  targetPath?: string;
  valuePath?: string;
  chainIdPath?: string;
  callsPath?: string;
  commandRegistry?: string;
  inputPath?: string;
  commandPath?: string;
}

export interface ABIEntry {
  type: string;
  name?: string;
  inputs?: ABIInput[];
  selector?: string;
  stateMutability?: string;
}

export interface ABIInput {
  name: string;
  type: string;
  components?: ABIInput[];
}

export interface DisplayFormat {
  intent?: string | {
    type: string;
    template?: string;
    registry?: string;
    source?: string;
    commandPath?: string;
    inputPath?: string;
    inputs?: string;
    separator?: string;
    maxDisplay?: number;
    overflow?: string;
    format?: unknown[];
  };
  interpolatedIntent?: string;
  fields?: FieldDefinition[];
  recursive?: RecursiveRule[];
  recursiveRules?: RecursiveRule[];
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
  recursive?: RecursiveRule[];
  recursiveRules?: RecursiveRule[];
}

export interface TokenMetadata {
  symbol: string;
  decimals: number;
  name: string;
  address: string;
}

type LocalMetadataEntry = {
  path: string;
  metadata: ContractMetadata;
  chainId?: number;
};

class LocalMetadataIndex {
  readonly byAddress = new Map<string, LocalMetadataEntry[]>();
  readonly allEntries: LocalMetadataEntry[] = [];

  constructor(readonly rootDirs: string[]) {}

  get(address: string) {
    const entries = this.byAddress.get(address.toLowerCase()) ?? [];
    return {
      find: (chainId: number, selector?: string) => findBestLocalMetadata(entries, chainId, selector)
    };
  }

  hasAddress(address: string, chainId: number): boolean {
    const entries = this.byAddress.get(address.toLowerCase()) ?? [];
    return entries.some(entry => entry.chainId === undefined || entry.chainId === chainId);
  }

  findByUniqueSelector(chainId: number, selector?: string): ContractMetadata | null {
    if (!selector) return null;
    const candidates = this.allEntries
      .filter(entry => entry.chainId === undefined || entry.chainId === chainId)
      .filter(entry => metadataHasSelector(entry.metadata, selector));

    const uniqueByFile = new Map<string, LocalMetadataEntry>();
    for (const candidate of candidates) uniqueByFile.set(candidate.path, candidate);
    if (uniqueByFile.size !== 1) return null;
    return cloneMetadata([...uniqueByFile.values()][0].metadata);
  }
}

function repoRootFromModule(): string {
  // src/services/*.ts and dist/services/*.js both resolve two levels up to repo root.
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function buildMetadataDirs(configDir?: string): string[] {
  const repoRoot = repoRootFromModule();
  const explicitDir = configDir ?? KAISIGN_METADATA_DIR;
  if (explicitDir) {
    const resolved = resolve(explicitDir);
    return existsSync(resolved) && statSync(resolved).isDirectory() ? [resolved] : [];
  }

  const candidates = [
    resolve(repoRoot, 'metadata'),
    resolve(process.cwd(), 'metadata'),
    resolve(process.cwd(), 'backend', 'metadata')
  ];

  const firstExisting = candidates.map(path => resolve(path)).find(path => existsSync(path) && statSync(path).isDirectory());
  return firstExisting ? [firstExisting] : [];
}

function buildLocalMetadataIndex(rootDirs: string[]): LocalMetadataIndex {
  const index = new LocalMetadataIndex(rootDirs);
  const skipped: string[] = [];
  for (const rootDir of rootDirs) {
    for (const file of walkJsonFiles(rootDir)) {
      try {
        const metadata = JSON.parse(readFileSync(file, 'utf8')) as ContractMetadata;
        index.allEntries.push({ path: file, metadata });
        for (const binding of extractAddressBindings(metadata)) {
          const entry: LocalMetadataEntry = { path: file, metadata, chainId: binding.chainId };
          const current = index.byAddress.get(binding.address) ?? [];
          current.push(entry);
          index.byAddress.set(binding.address, current);
        }
      } catch {
        skipped.push(file);
      }
    }
  }
  if (skipped.length > 0) {
    console.warn(`[MetadataService] Skipped ${skipped.length} unparseable JSON file(s) while indexing metadata, e.g.: ${skipped.slice(0, 3).join(', ')}`);
  }
  return index;
}

function walkJsonFiles(rootDir: string): string[] {
  const out: string[] = [];
  const stack = [rootDir];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const name of readdirSync(dir)) {
      const path = resolve(dir, name);
      const stat = statSync(path);
      if (stat.isDirectory()) stack.push(path);
      else if (name.endsWith('.json')) out.push(path);
    }
  }
  return out;
}

function normalizeAddress(value: unknown): string | null {
  return typeof value === 'string' && /^0x[a-fA-F0-9]{40}$/.test(value)
    ? value.toLowerCase()
    : null;
}

function maybeChainId(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value === 'string' && /^\\d+$/.test(value)) return Number(value);
  return undefined;
}

function extractAddressBindings(metadata: ContractMetadata): Array<{ address: string; chainId?: number }> {
  const contract = metadata.context?.contract;
  if (!contract) return [];

  const bindings: Array<{ address: string; chainId?: number }> = [];
  const direct = normalizeAddress(contract.address);
  if (direct) bindings.push({ address: direct, chainId: maybeChainId(contract.chainId) });

  const deployments = contract.deployments ?? {};
  for (const [key, rawValue] of Object.entries(deployments)) {
    const values = Array.isArray(rawValue) ? rawValue : [rawValue];
    for (const value of values) {
      if (value && typeof value === 'object') {
        const deployment = value as { address?: unknown; chainId?: unknown };
        const address = normalizeAddress(deployment.address) ?? normalizeAddress(key);
        if (!address) continue;
        bindings.push({ address, chainId: maybeChainId(deployment.chainId) ?? maybeChainId(key) });
        continue;
      }

      const address = normalizeAddress(value) ?? normalizeAddress(key);
      if (!address) continue;
      const chainId = normalizeAddress(key) ? maybeChainId(value) : maybeChainId(key);
      bindings.push({ address, chainId });
    }
  }

  const seen = new Set<string>();
  return bindings.filter(binding => {
    const key = `${binding.chainId ?? '*'}:${binding.address}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function abiInputSignature(input: ABIInput): string {
  if (!input.type.startsWith('tuple')) return input.type;
  const suffix = input.type.slice('tuple'.length);
  const inner = (input.components ?? []).map(abiInputSignature).join(',');
  return `(${inner})${suffix}`;
}

function abiEntrySelector(entry: ABIEntry): string | null {
  if (entry.selector) return entry.selector.toLowerCase();
  if (entry.type !== 'function' || !entry.name) return null;
  const types = (entry.inputs ?? []).map(abiInputSignature).join(',');
  return keccakId(`${entry.name}(${types})`).slice(0, 10).toLowerCase();
}

function metadataHasSelector(metadata: ContractMetadata, selector?: string): boolean {
  if (!selector) return true;
  const normalized = selector.toLowerCase();
  const abi = metadata.context?.contract?.abi;
  const abiHasSelector = Array.isArray(abi) && abi.some(entry => abiEntrySelector(entry) === normalized);
  const displayHasSelector = Boolean(metadata.display?.formats?.[normalized]);
  return abiHasSelector || displayHasSelector;
}

function cloneMetadata(metadata: ContractMetadata): ContractMetadata {
  return JSON.parse(JSON.stringify(metadata)) as ContractMetadata;
}

function findBestLocalMetadata(entries: LocalMetadataEntry[], chainId: number, selector?: string): ContractMetadata | null {
  const candidates = entries
    .filter(entry => entry.chainId === undefined || entry.chainId === chainId)
    .filter(entry => metadataHasSelector(entry.metadata, selector));

  const exactChain = candidates.find(entry => entry.chainId === chainId);
  const fallback = exactChain ?? candidates[0];
  return fallback ? cloneMetadata(fallback.metadata) : null;
}

export class MetadataService {
  private metadataDirs: string[];
  private localIndex?: LocalMetadataIndex;

  constructor(config?: { metadataDir?: string }) {
    this.metadataDirs = buildMetadataDirs(config?.metadataDir);
  }

  /**
   * Make an eth_call via RPC
   */
  private async ethCall(to: string, data: string, chainId: number): Promise<string> {
    const rpcUrls = RPC_URLS[chainId] ?? RPC_URLS[1];

    const response = await fetchWithTimeout(rpcUrls[0], {
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

    const response = await fetchWithTimeout(rpcUrls[0], {
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

  private getLocalIndex(): LocalMetadataIndex {
    if (!this.localIndex) this.localIndex = buildLocalMetadataIndex(this.metadataDirs);
    return this.localIndex;
  }

  hasLocalContractMetadata(address: string, chainId: number): boolean {
    return this.getLocalIndex().hasAddress(address.toLowerCase(), chainId);
  }

  /**
   * Fetch metadata from local backend/metadata JSON files only.
   */
  private fetchMetadataFromLocal(address: string, chainId: number, selector?: string): ContractMetadata | null {
    const index = this.getLocalIndex();
    return index.get(address.toLowerCase())?.find(chainId, selector) ?? index.findByUniqueSelector(chainId, selector);
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
    const cached = cacheManager.getMetadata<ContractMetadata>(normalizedAddress, chainId, selector)
      ?? cacheManager.getMetadata<ContractMetadata>(normalizedAddress, chainId);
    if (cached && metadataHasSelector(cached, selector)) {
      return cached;
    }

    try {
      // Try direct local metadata lookup first.
      let metadata = this.fetchMetadataFromLocal(normalizedAddress, chainId, selector);

      // If no metadata, try proxy detection
      if (!metadata) {
        // Try Diamond proxy first
        if (selector) {
          const facetAddress = await this.getDiamondFacetAddress(normalizedAddress, selector, chainId);
          if (facetAddress && facetAddress !== normalizedAddress) {
            metadata = this.fetchMetadataFromLocal(facetAddress, chainId, selector);
          }
        }

        // Try EIP-1967 / Safe proxy
        if (!metadata) {
          const implAddress = await this.getImplementationAddress(normalizedAddress, chainId);
          if (implAddress && implAddress !== normalizedAddress) {
            metadata = this.fetchMetadataFromLocal(implAddress, chainId, selector);
          }
        }
      }

      if (!metadata) {
        return null;
      }

      metadata._verification = {
        verified: false,
        source: 'local-metadata',
        details: `loaded from local metadata directory: ${this.getLocalIndex().rootDirs.join(', ')}`,
        hash: null,
        onChainHash: null
      };

      // Cache result
      cacheManager.setMetadata(normalizedAddress, chainId, metadata, selector);
      if (selector) cacheManager.setMetadata(normalizedAddress, chainId, metadata);

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
