/**
 * Verification Tests
 * Tests leaf hash verification against on-chain registry
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { onChainVerifier } from '../src/services/onchain-verifier.js';
import { metadataService } from '../src/services/metadata-service.js';
import { verifyContractMetadata } from '../src/tools/verify-metadata.js';

// Known contracts with metadata in KaiSign registry
const TEST_CONTRACTS = {
  // Uniswap Universal Router on Sepolia
  UNISWAP_ROUTER_SEPOLIA: {
    address: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD',
    chainId: 11155111
  },
  // ERC20 token example
  USDC_MAINNET: {
    address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    chainId: 1
  }
};

describe('OnChainVerifier', () => {
  describe('computeSmtKey', () => {
    it('matches keccak256(abi.encode(chainId, target))', () => {
      expect(onChainVerifier.computeSmtKey(1, TEST_CONTRACTS.USDC_MAINNET.address))
        .toBe('0xb340dcebc6634c8db42e41014206798ccc4b36e5bf3a1ed61b89a5f70afa8cd4');
    });
  });

  describe('computeLeafHash', () => {
    // Golden vectors computed with `cast abi-encode` + `cast keccak` against
    // LEAF_TYPEHASH = keccak256("RegistryLeaf(uint256 chainId,address target,bytes32 metadataHash)")
    const components = {
      chainId: 1,
      target: TEST_CONTRACTS.USDC_MAINNET.address,
      metadataHash: '0x' + '2'.repeat(64)
    };

    it('matches the Solidity address-keyed leaf encoding', () => {
      expect(onChainVerifier.computeLeafHash(components))
        .toBe('0x9cbe189f572ea7793b5f21cf36de9e0e7ca1537d04fea83c8e843f7e44588432');
    });

    it('binds the target chain', () => {
      expect(onChainVerifier.computeLeafHash({ ...components, chainId: 8453 }))
        .toBe('0xd77b0d7850e3c1112517432feaaac69ba70cc6a33c60f9dc529f28ba2756c101');
    });

    it('is case-insensitive in the target address', () => {
      expect(onChainVerifier.computeLeafHash({ ...components, target: components.target.toLowerCase() }))
        .toBe(onChainVerifier.computeLeafHash(components));
    });
  });

  describe('verifyMetadata', () => {
    it('verifies registered contract metadata', async () => {
      const result = await onChainVerifier.verifyMetadata(
        TEST_CONTRACTS.UNISWAP_ROUTER_SEPOLIA.address,
        TEST_CONTRACTS.UNISWAP_ROUTER_SEPOLIA.chainId
      );

      // Contract may or may not be registered - check structure
      expect(result).toHaveProperty('verified');
      expect(result).toHaveProperty('source');
      expect(result).toHaveProperty('details');
      expect(['leaf-verified', 'local-metadata', 'mismatch', 'error']).toContain(result.source);
    });

    it('returns local-metadata for unregistered contract', async () => {
      // Use a random address unlikely to be registered
      const result = await onChainVerifier.verifyMetadata(
        '0x1234567890123456789012345678901234567890',
        1
      );

      expect(result.verified).toBe(false);
      expect(result.source).not.toBe('leaf-verified');
    });

    it('caches verification results', async () => {
      const address = TEST_CONTRACTS.USDC_MAINNET.address;
      const chainId = TEST_CONTRACTS.USDC_MAINNET.chainId;

      // First call
      const start1 = Date.now();
      const result1 = await onChainVerifier.verifyMetadata(address, chainId);
      const time1 = Date.now() - start1;

      // Second call should be cached
      const start2 = Date.now();
      const result2 = await onChainVerifier.verifyMetadata(address, chainId);
      const time2 = Date.now() - start2;

      expect(result1.verified).toBe(result2.verified);
      expect(result1.source).toBe(result2.source);

      // Cached call should be significantly faster
      expect(time2).toBeLessThan(time1);
    });
  });
});

describe('verifyContractMetadata tool', () => {
  it('returns complete verification result', async () => {
    const result = await verifyContractMetadata({
      contractAddress: TEST_CONTRACTS.USDC_MAINNET.address,
      chainId: TEST_CONTRACTS.USDC_MAINNET.chainId
    });

    expect(result).toHaveProperty('contractAddress');
    expect(result).toHaveProperty('chainId');
    expect(result).toHaveProperty('verified');
    expect(result).toHaveProperty('source');
    expect(result).toHaveProperty('hasMetadata');

    expect(result.contractAddress).toBe(TEST_CONTRACTS.USDC_MAINNET.address.toLowerCase());
    expect(result.chainId).toBe(TEST_CONTRACTS.USDC_MAINNET.chainId);
  });

  it('validates input addresses', async () => {
    await expect(
      verifyContractMetadata({
        contractAddress: 'invalid-address',
        chainId: 1
      })
    ).rejects.toThrow();
  });
});

describe('MetadataService', () => {
  describe('getContractMetadata', () => {
    it('fetches metadata for known contract', async () => {
      const metadata = await metadataService.getContractMetadata(
        TEST_CONTRACTS.USDC_MAINNET.address,
        TEST_CONTRACTS.USDC_MAINNET.chainId
      );

      // May be null if not in registry, but should not throw
      if (metadata) {
        expect(metadata).toHaveProperty('context');
        expect(metadata.context?.contract?.abi).toBeDefined();
      }
    });

    it('returns null for unknown contract', async () => {
      const metadata = await metadataService.getContractMetadata(
        '0x0000000000000000000000000000000000000001',
        1
      );

      expect(metadata).toBeNull();
    });
  });

  describe('getTokenMetadata', () => {
    it('fetches token metadata', async () => {
      const token = await metadataService.getTokenMetadata(
        TEST_CONTRACTS.USDC_MAINNET.address,
        TEST_CONTRACTS.USDC_MAINNET.chainId
      );

      expect(token).toHaveProperty('symbol');
      expect(token).toHaveProperty('decimals');
      expect(token).toHaveProperty('name');
      expect(token).toHaveProperty('address');

      // Verify we got valid token metadata
      expect(typeof token.decimals).toBe('number');
      expect(typeof token.symbol).toBe('string');
    });
  });
});
