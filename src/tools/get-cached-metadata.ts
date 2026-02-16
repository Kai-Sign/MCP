/**
 * get_cached_metadata tool
 * Retrieve cached metadata for a contract (token saver)
 */

import { z } from 'zod';
import { cacheManager } from '../services/cache-manager.js';
import { ContractMetadata } from '../services/metadata-service.js';

export const getCachedMetadataSchema = z.object({
  contractAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid Ethereum address'),
  chainId: z.number().int().positive().default(1)
});

export type GetCachedMetadataInput = z.infer<typeof getCachedMetadataSchema>;

export interface GetCachedMetadataResult {
  contractAddress: string;
  chainId: number;
  found: boolean;
  cachedAt?: number;
  expiresIn?: number;
  approximateTokens?: number;
  verificationStatus?: string;
  contractName?: string;
  contractSymbol?: string;
  functionCount?: number;
  cacheStats: {
    totalEntries: number;
    hitRate: number;
    approximateTotalTokens: number;
  };
}

/**
 * Get cached metadata for a contract
 */
export async function getCachedMetadata(
  input: GetCachedMetadataInput
): Promise<GetCachedMetadataResult> {
  const { contractAddress, chainId } = getCachedMetadataSchema.parse(input);

  const normalizedAddress = contractAddress.toLowerCase();

  // Get cache entry info
  const cacheInfo = cacheManager.getCacheEntryInfo(normalizedAddress, chainId);

  // Get global cache stats
  const stats = cacheManager.getStats();

  const result: GetCachedMetadataResult = {
    contractAddress: normalizedAddress,
    chainId,
    found: cacheInfo.found,
    cacheStats: {
      totalEntries: stats.size,
      hitRate: stats.hitRate,
      approximateTotalTokens: stats.approximateTotalTokens
    }
  };

  if (cacheInfo.found) {
    result.cachedAt = cacheInfo.cachedAt;
    result.expiresIn = cacheInfo.expiresIn;
    result.approximateTokens = cacheInfo.approximateTokens;
    result.verificationStatus = cacheInfo.verificationStatus;

    // Try to get additional metadata info from cache
    const metadata = cacheManager.getMetadata<ContractMetadata>(normalizedAddress, chainId);
    if (metadata) {
      result.contractName = metadata.context?.contract?.name ?? metadata.metadata?.name;
      result.contractSymbol = metadata.context?.contract?.symbol ?? metadata.metadata?.symbol;

      const abi = metadata.context?.contract?.abi;
      if (abi && Array.isArray(abi)) {
        result.functionCount = abi.filter(entry => entry.type === 'function').length;
      }
    }
  }

  return result;
}

/**
 * Clear all caches
 */
export async function clearCache(): Promise<{ cleared: true; previousStats: ReturnType<typeof cacheManager.getStats> }> {
  const previousStats = cacheManager.getStats();
  cacheManager.clearAll();
  return { cleared: true, previousStats };
}

/**
 * Prune expired entries
 */
export async function pruneExpiredCache(): Promise<{ prunedCount: number }> {
  const prunedCount = cacheManager.pruneExpired();
  return { prunedCount };
}
