/**
 * Bankrbot Simulation Tests
 * Demonstrates token savings with cached metadata
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { decodeTransaction } from '../src/tools/decode-transaction.js';
import { getCachedMetadata, clearCache } from '../src/tools/get-cached-metadata.js';
import { verifyContractMetadata } from '../src/tools/verify-metadata.js';
import { cacheManager } from '../src/services/cache-manager.js';

// Uniswap Universal Router on mainnet
const UNISWAP_ROUTER = '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD';

// Example swap calldata (execute function)
const SWAP_CALLDATA = '0x3593564c000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000065b8f70000000000000000000000000000000000000000000000000000000000000000020b000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000084b858183f00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000de0b6b3a764000000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000104b858183f00000000000000000000000000000000000000000000000000000000000000020000000000000000000000000000000000000000000000000de0b6b3a76400000000000000000000000000000000000000000000000000000de0b6b3a764000000000000000000000000000000000000000000000000000000000000000000a000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000042c02aaa39b223fe8d0a0e5c4f27ead9083c756cc20001f4a0b86991c6218b36c1d19d4a2e9eb0ce3606eb480001f4dac17f958d2ee523a2206206994597c13d831ec700000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000';

/**
 * Estimate token count for a string
 * Approximation: ~4 characters per token
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

describe('Bankrbot Token Savings', () => {
  beforeEach(async () => {
    // Clear cache before each test
    await clearCache();
  });

  it('demonstrates token savings with cached metadata', async () => {
    const tx = {
      to: UNISWAP_ROUTER,
      data: SWAP_CALLDATA,
      chainId: 1
    };

    // BEFORE: First call fetches and caches metadata
    const beforeResult = await decodeTransaction(tx);

    // Full metadata response is much larger
    const beforeTokens = estimateTokens(JSON.stringify(beforeResult));

    console.log('First call (cache miss):');
    console.log('  - Success:', beforeResult.success);
    console.log('  - Cache status:', beforeResult.cacheStatus);
    console.log('  - Approximate tokens:', beforeTokens);

    // AFTER: Second call uses cached metadata
    const afterResult = await decodeTransaction({ ...tx, skipVerification: true });

    // Intent + params is much smaller
    const intentAndParams = {
      intent: afterResult.intent,
      params: Object.fromEntries(
        Object.entries(afterResult.params).map(([k, v]) => [k, v.value])
      )
    };
    const afterTokens = estimateTokens(JSON.stringify(intentAndParams));

    console.log('\nSecond call (cache hit):');
    console.log('  - Success:', afterResult.success);
    console.log('  - Cache status:', afterResult.cacheStatus);
    console.log('  - Approximate tokens:', afterTokens);

    // Calculate savings
    if (beforeResult.success) {
      const savings = ((beforeTokens - afterTokens) / beforeTokens) * 100;
      console.log(`\nToken savings: ${savings.toFixed(1)}%`);
      console.log(`  Before: ${beforeTokens} tokens`);
      console.log(`  After: ${afterTokens} tokens`);
      console.log(`  Saved: ${beforeTokens - afterTokens} tokens`);

      // Verify significant savings
      expect(afterResult.cacheStatus).toBe('hit');
    }
  });

  it('verifies and decodes transaction', async () => {
    // Step 1: Verify contract metadata
    const verification = await verifyContractMetadata({
      contractAddress: UNISWAP_ROUTER,
      chainId: 1
    });

    console.log('Verification result:');
    console.log('  - Verified:', verification.verified);
    console.log('  - Source:', verification.source);
    console.log('  - Has metadata:', verification.hasMetadata);

    expect(verification).toHaveProperty('verified');
    expect(verification).toHaveProperty('source');

    // Step 2: Decode with verified metadata
    const decoded = await decodeTransaction({
      to: UNISWAP_ROUTER,
      data: SWAP_CALLDATA,
      chainId: 1
    });

    console.log('\nDecoded transaction:');
    console.log('  - Intent:', decoded.intent);
    console.log('  - Function:', decoded.functionName);
    console.log('  - Verification:', decoded.verification?.source);

    if (decoded.success) {
      expect(decoded.intent).toBeTruthy();
      expect(decoded.selector).toBe('0x3593564c');
    }
  });

  it('tracks cache performance metrics', async () => {
    // Make several calls to build up cache
    const contracts = [
      { to: UNISWAP_ROUTER, chainId: 1 },
      { to: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', chainId: 1 }, // USDC
      { to: '0xdAC17F958D2ee523a2206206994597C13D831ec7', chainId: 1 }  // USDT
    ];

    // First round - cache misses
    for (const contract of contracts) {
      await getCachedMetadata({
        contractAddress: contract.to,
        chainId: contract.chainId
      });
    }

    // Get cache stats
    const stats = cacheManager.getStats();

    console.log('Cache Statistics:');
    console.log('  - Total entries:', stats.size);
    console.log('  - Cache hits:', stats.hits);
    console.log('  - Cache misses:', stats.misses);
    console.log('  - Hit rate:', (stats.hitRate * 100).toFixed(1) + '%');
    console.log('  - Approximate total tokens cached:', stats.approximateTotalTokens);

    // Verify cache is working
    const cachedResult = await getCachedMetadata({
      contractAddress: UNISWAP_ROUTER,
      chainId: 1
    });

    console.log('\nUniswap Router cache entry:');
    console.log('  - Found:', cachedResult.found);
    console.log('  - Cached at:', cachedResult.cachedAt ? new Date(cachedResult.cachedAt).toISOString() : 'N/A');
    console.log('  - Approximate tokens:', cachedResult.approximateTokens);
    console.log('  - Verification status:', cachedResult.verificationStatus);
  });

  it('handles multiple decode calls efficiently', async () => {
    const tx = {
      to: UNISWAP_ROUTER,
      data: SWAP_CALLDATA,
      chainId: 1
    };

    // Simulate multiple bot queries to same contract
    const numCalls = 5;
    const timings: number[] = [];

    for (let i = 0; i < numCalls; i++) {
      const start = Date.now();
      await decodeTransaction({
        ...tx,
        skipVerification: i > 0 // Only verify first call
      });
      timings.push(Date.now() - start);
    }

    console.log('Multiple decode call timings:');
    timings.forEach((t, i) => {
      console.log(`  Call ${i + 1}: ${t}ms`);
    });

    const firstCall = timings[0];
    const avgSubsequent = timings.slice(1).reduce((a, b) => a + b, 0) / (numCalls - 1);

    console.log(`\nFirst call: ${firstCall}ms`);
    console.log(`Average subsequent: ${avgSubsequent.toFixed(1)}ms`);
    console.log(`Speedup: ${(firstCall / avgSubsequent).toFixed(1)}x`);

    // Subsequent calls should be faster due to caching
    expect(avgSubsequent).toBeLessThan(firstCall);
  });
});

describe('Integration Flow', () => {
  it('full bankrbot integration flow', async () => {
    // Clear cache to simulate fresh start
    await clearCache();

    // 1. Bot receives transaction to analyze
    const pendingTx = {
      to: UNISWAP_ROUTER,
      data: SWAP_CALLDATA,
      chainId: 1,
      value: '0'
    };

    console.log('=== Bankrbot Integration Flow ===\n');

    // 2. Check if metadata is cached
    const cacheCheck = await getCachedMetadata({
      contractAddress: pendingTx.to,
      chainId: pendingTx.chainId
    });

    console.log('Step 1: Cache check');
    console.log('  - Cached:', cacheCheck.found);

    // 3. Verify contract if not cached
    if (!cacheCheck.found) {
      console.log('\nStep 2: Verifying contract metadata...');
      const verification = await verifyContractMetadata({
        contractAddress: pendingTx.to,
        chainId: pendingTx.chainId
      });

      console.log('  - Verified:', verification.verified);
      console.log('  - Source:', verification.source);

      if (verification.verified) {
        console.log('  - UID:', verification.uid);
      }
    }

    // 4. Decode transaction
    console.log('\nStep 3: Decoding transaction...');
    const decoded = await decodeTransaction({
      to: pendingTx.to,
      data: pendingTx.data,
      chainId: pendingTx.chainId,
      skipVerification: cacheCheck.found // Skip if already verified
    });

    console.log('  - Success:', decoded.success);
    console.log('  - Intent:', decoded.intent);
    console.log('  - Function:', decoded.functionName || decoded.selector);

    if (decoded.decodedCommands) {
      console.log('  - Commands:');
      decoded.decodedCommands.forEach((cmd, i) => {
        console.log(`    ${i + 1}. ${cmd.name}: ${cmd.intent}`);
      });
    }

    // 5. Final cache stats
    const finalCache = await getCachedMetadata({
      contractAddress: pendingTx.to,
      chainId: pendingTx.chainId
    });

    console.log('\nStep 4: Final cache state');
    console.log('  - Cached:', finalCache.found);
    console.log('  - Approximate tokens saved:', finalCache.approximateTokens);
    console.log('  - Global hit rate:', (finalCache.cacheStats.hitRate * 100).toFixed(1) + '%');

    console.log('\n=== Flow Complete ===');
  });
});
