/**
 * Cache Manager with TTL and token tracking
 */

import { CACHE_TTL, TOKEN_CACHE_TTL } from '../config/constants.js';

interface CacheEntry<T> {
  data: T;
  timestamp: number;
  approximateTokens?: number;
}

interface CacheStats {
  hits: number;
  misses: number;
  size: number;
  approximateTotalTokens: number;
}

export class CacheManager {
  private metadataCache: Map<string, CacheEntry<unknown>> = new Map();
  private verificationCache: Map<string, CacheEntry<unknown>> = new Map();
  private tokenCache: Map<string, CacheEntry<unknown>> = new Map();

  private stats: CacheStats = {
    hits: 0,
    misses: 0,
    size: 0,
    approximateTotalTokens: 0
  };

  private metadataTTL: number;
  private tokenTTL: number;

  constructor(config?: { metadataTTL?: number; tokenTTL?: number }) {
    this.metadataTTL = config?.metadataTTL ?? CACHE_TTL;
    this.tokenTTL = config?.tokenTTL ?? TOKEN_CACHE_TTL;
  }

  /**
   * Estimate token count for a given data object
   * Approximation: ~4 characters per token for JSON
   */
  private estimateTokens(data: unknown): number {
    const json = JSON.stringify(data);
    return Math.ceil(json.length / 4);
  }

  /**
   * Generate cache key for metadata
   */
  private getMetadataKey(contractAddress: string, chainId: number, selector?: string): string {
    const suffix = selector ? `-${selector.toLowerCase()}` : '';
    return `${contractAddress.toLowerCase()}-${chainId}${suffix}`;
  }

  /**
   * Get cached metadata
   */
  getMetadata<T>(contractAddress: string, chainId: number, selector?: string): T | null {
    const key = this.getMetadataKey(contractAddress, chainId, selector);
    const entry = this.metadataCache.get(key) as CacheEntry<T> | undefined;

    if (!entry) {
      this.stats.misses++;
      return null;
    }

    if (Date.now() - entry.timestamp > this.metadataTTL) {
      this.metadataCache.delete(key);
      this.stats.misses++;
      return null;
    }

    this.stats.hits++;
    return entry.data;
  }

  /**
   * Set cached metadata
   */
  setMetadata<T>(contractAddress: string, chainId: number, data: T, selector?: string): void {
    const key = this.getMetadataKey(contractAddress, chainId, selector);
    const tokens = this.estimateTokens(data);

    this.metadataCache.set(key, {
      data,
      timestamp: Date.now(),
      approximateTokens: tokens
    });

    this.stats.size = this.metadataCache.size;
    this.stats.approximateTotalTokens += tokens;
  }

  /**
   * Get cached verification result
   */
  getVerification<T>(contractAddress: string, chainId: number): T | null {
    const key = this.getMetadataKey(contractAddress, chainId);
    const entry = this.verificationCache.get(key) as CacheEntry<T> | undefined;

    if (!entry) {
      return null;
    }

    if (Date.now() - entry.timestamp > this.metadataTTL) {
      this.verificationCache.delete(key);
      return null;
    }

    return entry.data;
  }

  /**
   * Set cached verification result
   */
  setVerification<T>(contractAddress: string, chainId: number, data: T): void {
    const key = this.getMetadataKey(contractAddress, chainId);
    this.verificationCache.set(key, {
      data,
      timestamp: Date.now()
    });
  }

  /**
   * Get cached token metadata
   */
  getToken<T>(tokenAddress: string, chainId: number): T | null {
    const key = `token-${tokenAddress.toLowerCase()}-${chainId}`;
    const entry = this.tokenCache.get(key) as CacheEntry<T> | undefined;

    if (!entry) {
      return null;
    }

    if (Date.now() - entry.timestamp > this.tokenTTL) {
      this.tokenCache.delete(key);
      return null;
    }

    return entry.data;
  }

  /**
   * Set cached token metadata
   */
  setToken<T>(tokenAddress: string, chainId: number, data: T): void {
    const key = `token-${tokenAddress.toLowerCase()}-${chainId}`;
    this.tokenCache.set(key, {
      data,
      timestamp: Date.now()
    });
  }

  /**
   * Get detailed cache entry info
   */
  getCacheEntryInfo(contractAddress: string, chainId: number): {
    found: boolean;
    cachedAt?: number;
    approximateTokens?: number;
    verificationStatus?: string;
    expiresIn?: number;
  } {
    const key = this.getMetadataKey(contractAddress, chainId);
    const entry = this.metadataCache.get(key);
    const verification = this.verificationCache.get(key);

    if (!entry) {
      return { found: false };
    }

    const now = Date.now();
    const expiresIn = Math.max(0, this.metadataTTL - (now - entry.timestamp));

    return {
      found: true,
      cachedAt: entry.timestamp,
      approximateTokens: entry.approximateTokens,
      verificationStatus: verification ?
        ((verification.data as { verified?: boolean })?.verified ? 'verified' : 'unverified') :
        'unknown',
      expiresIn
    };
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats & { hitRate: number } {
    const total = this.stats.hits + this.stats.misses;
    return {
      ...this.stats,
      hitRate: total > 0 ? this.stats.hits / total : 0
    };
  }

  /**
   * Clear all caches
   */
  clearAll(): void {
    this.metadataCache.clear();
    this.verificationCache.clear();
    this.tokenCache.clear();
    this.stats = {
      hits: 0,
      misses: 0,
      size: 0,
      approximateTotalTokens: 0
    };
  }

  /**
   * Clear expired entries
   */
  pruneExpired(): number {
    const now = Date.now();
    let pruned = 0;

    for (const [key, entry] of this.metadataCache.entries()) {
      if (now - entry.timestamp > this.metadataTTL) {
        this.metadataCache.delete(key);
        pruned++;
      }
    }

    for (const [key, entry] of this.verificationCache.entries()) {
      if (now - entry.timestamp > this.metadataTTL) {
        this.verificationCache.delete(key);
        pruned++;
      }
    }

    for (const [key, entry] of this.tokenCache.entries()) {
      if (now - entry.timestamp > this.tokenTTL) {
        this.tokenCache.delete(key);
        pruned++;
      }
    }

    this.stats.size = this.metadataCache.size;
    return pruned;
  }
}

// Global cache instance
export const cacheManager = new CacheManager();
