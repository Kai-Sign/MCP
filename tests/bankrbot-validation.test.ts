/**
 * Bankrbot + KaiSign Validation Integration Tests
 *
 * Tests the full flow:
 * 1. Bankrbot builds transaction from natural language
 * 2. KaiSign validates the transaction payload
 * 3. User can verify the decoded intent matches their request
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { validateBankrbotTransaction } from '../src/tools/validate-bankrbot-tx.js';
import { getClearSignPrompt } from '../src/tools/get-clear-sign-prompt.js';
import { bankrbotClient } from '../src/services/bankrbot-client.js';

// Known verified contracts for testing
const TEST_CONTRACTS = {
  // Uniswap Universal Router on Base
  UNISWAP_ROUTER_BASE: {
    address: '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD',
    chainId: 8453
  },
  // USDC on Base
  USDC_BASE: {
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    chainId: 8453
  }
};

describe('Bankrbot Transaction Validation', () => {
  describe('validateBankrbotTransaction', () => {
    it('validates a verified contract transaction', async () => {
      // Sample swap calldata (execute with Universal Router)
      const sampleCalldata = '0x3593564c00000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000000000066ff1b9f7d000000000000000000000000000000000000000000000000000000000000000000000000000000010800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000002386f26fc100000000000000000000000000000000000000000000000000000000000000b71b0000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002b4200000000000000000000000000000000000006000bb8833589fcd6edb6e08f4c7c32d4f71b54bda02913000000000000000000000000000000000000000000';

      const result = await validateBankrbotTransaction({
        to: TEST_CONTRACTS.UNISWAP_ROUTER_BASE.address,
        data: sampleCalldata,
        chainId: TEST_CONTRACTS.UNISWAP_ROUTER_BASE.chainId,
        value: '10000000000000000' // 0.01 ETH
      });

      // Check result structure
      expect(result).toHaveProperty('verified');
      expect(result).toHaveProperty('source');
      expect(result).toHaveProperty('intent');
      expect(result).toHaveProperty('params');
      expect(result).toHaveProperty('warnings');
      expect(result).toHaveProperty('transaction');

      // Transaction details
      expect(result.transaction.to).toBe(TEST_CONTRACTS.UNISWAP_ROUTER_BASE.address.toLowerCase());
      expect(result.transaction.chainId).toBe(8453);
      expect(result.transaction.selector).toBe('0x3593564c'); // execute selector

      console.log('Validation result:', JSON.stringify(result, null, 2));
    });

    it('detects unverified contracts', async () => {
      // Use a random address that's unlikely to have verified metadata
      const result = await validateBankrbotTransaction({
        to: '0x1234567890123456789012345678901234567890',
        data: '0xa9059cbb000000000000000000000000deadbeef00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a',
        chainId: 8453,
        value: '0'
      });

      expect(result.verified).toBe(false);
      expect(result.source).not.toBe('leaf-verified');
      expect(result.warnings.length).toBeGreaterThan(0);

      console.log('Unverified result:', JSON.stringify(result, null, 2));
    });

    it('warns about risky selectors on unverified contracts', async () => {
      // Approve selector on unverified contract
      const approveCalldata = '0x095ea7b3000000000000000000000000deadbeef0000000000000000000000000000000000000000000000000000000000000000ffffffffffffffffffffffffffffffff';

      const result = await validateBankrbotTransaction({
        to: '0x1234567890123456789012345678901234567890',
        data: approveCalldata,
        chainId: 8453,
        value: '0'
      });

      expect(result.warnings.some(w => w.includes('approve'))).toBe(true);

      console.log('Risky selector result:', JSON.stringify(result, null, 2));
    });

    it('handles large ETH values with warning', async () => {
      const result = await validateBankrbotTransaction({
        to: TEST_CONTRACTS.UNISWAP_ROUTER_BASE.address,
        data: '0x3593564c0000000000000000000000000000000000000000000000000000000000000000',
        chainId: 8453,
        value: '50000000000000000000' // 50 ETH
      });

      expect(result.warnings.some(w => w.includes('Large ETH value'))).toBe(true);
    });

    it('handles invalid calldata gracefully', async () => {
      const result = await validateBankrbotTransaction({
        to: TEST_CONTRACTS.UNISWAP_ROUTER_BASE.address,
        data: '0x12345678', // Invalid/short calldata
        chainId: 8453,
        value: '0'
      });

      // Should not throw, just return appropriate warnings
      expect(result).toHaveProperty('warnings');
      expect(result.transaction.selector).toBe('0x12345678');
    });
  });

  describe('getClearSignPrompt', () => {
    it('returns formatted clear signing prompt', async () => {
      const sampleCalldata = '0x3593564c00000000000000000000000000000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000080000000000000000000000000000000000066ff1b9f7d000000000000000000000000000000000000000000000000000000000000000000000000000000000000010800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000002386f26fc100000000000000000000000000000000000000000000000000000000000000b71b0000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000002b4200000000000000000000000000000000000006000bb8833589fcd6edb6e08f4c7c32d4f71b54bda02913000000000000000000000000000000000000000000';

      const result = await getClearSignPrompt({
        to: TEST_CONTRACTS.UNISWAP_ROUTER_BASE.address,
        data: sampleCalldata,
        chainId: TEST_CONTRACTS.UNISWAP_ROUTER_BASE.chainId,
        value: '10000000000000000' // 0.01 ETH
      });

      // Check result structure
      expect(result).toHaveProperty('displayText');
      expect(result).toHaveProperty('verified');
      expect(result).toHaveProperty('verificationBadge');
      expect(result).toHaveProperty('intent');
      expect(result).toHaveProperty('functionName');
      expect(result).toHaveProperty('warnings');
      expect(result).toHaveProperty('transaction');
      expect(result).toHaveProperty('verification');

      // Transaction should be preserved
      expect(result.transaction.to).toBe(TEST_CONTRACTS.UNISWAP_ROUTER_BASE.address.toLowerCase());
      expect(result.transaction.chainId).toBe(8453);
      expect(result.transaction.value).toBe('10000000000000000');

      // Display text should contain key info
      expect(result.displayText).toContain('Transaction');
      expect(result.displayText).toContain('Base'); // Chain name
      expect(result.displayText).toContain('0.01'); // ETH value

      // Badge should be one of the expected values
      expect(['✓ Verified', '⚠ API Only', '⚠ Unverified']).toContain(result.verificationBadge);

      console.log('Clear sign result:');
      console.log('Display text:\n' + result.displayText);
      console.log('\nFull result:', JSON.stringify(result, null, 2));
    });

    it('formats unverified contracts with warning badge', async () => {
      const result = await getClearSignPrompt({
        to: '0x1234567890123456789012345678901234567890',
        data: '0xa9059cbb000000000000000000000000deadbeef00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000a',
        chainId: 8453,
        value: '0'
      });

      expect(result.verified).toBe(false);
      expect(result.verificationBadge).not.toBe('✓ Verified');
      expect(result.displayText).toContain('⚠');

      console.log('Unverified display text:\n' + result.displayText);
    });

    it('includes ETH value in display when non-zero', async () => {
      const result = await getClearSignPrompt({
        to: TEST_CONTRACTS.UNISWAP_ROUTER_BASE.address,
        data: '0x3593564c0000000000000000000000000000000000000000000000000000000000000000',
        chainId: 8453,
        value: '1000000000000000000' // 1 ETH
      });

      expect(result.displayText).toContain('Value:');
      expect(result.displayText).toContain('ETH');
    });

    it('omits value line when zero', async () => {
      const result = await getClearSignPrompt({
        to: TEST_CONTRACTS.UNISWAP_ROUTER_BASE.address,
        data: '0x3593564c0000000000000000000000000000000000000000000000000000000000000000',
        chainId: 8453,
        value: '0'
      });

      expect(result.displayText).not.toContain('Value:');
    });
  });

  describe('Bankrbot Client', () => {
    const hasApiKey = !!process.env.BANKR_API_KEY;
    // NOTE: Bankrbot auto-executes transactions (signs and broadcasts immediately)
    // rather than returning unsigned tx payloads. These tests consume real funds.
    // To run: BANKR_TEST=1 npm run test:run
    const runBankrTests = process.env.BANKR_TEST === '1';

    it('reports configuration status', () => {
      if (hasApiKey) {
        expect(bankrbotClient.isConfigured()).toBe(true);
      } else {
        expect(bankrbotClient.isConfigured()).toBe(false);
        console.log('Skipping Bankrbot API tests - BANKR_API_KEY not set');
      }
    });

    // NOTE: Bankrbot auto-executes transactions (signs + broadcasts immediately)
    // It does NOT return unsigned tx payloads for pre-signing validation.
    // These tests verify that Bankrbot successfully executes and returns tx hash.
    it.skipIf(!hasApiKey)('executes swap and returns confirmation', async () => {
      // This test actually executes a swap - Bankrbot doesn't have "build only" mode
      try {
        const result = await bankrbotClient.getTransaction(
          'swap 0.00001 ETH to USDC on base',
          8453
        );
        // If we get here, Bankrbot returned a tx payload (unexpected)
        expect(result).toHaveProperty('to');
        console.log('Bankrbot returned tx payload:', JSON.stringify(result, null, 2));
      } catch (error) {
        // Expected: Bankrbot executes and returns message with tx hash
        const msg = (error as Error).message;
        if (msg.includes('swapped') && msg.includes('basescan.org/tx/')) {
          console.log('Bankrbot executed swap successfully');
          console.log('Response:', msg);
          // Extract tx hash from message
          const txMatch = msg.match(/0x[a-fA-F0-9]{64}/);
          expect(txMatch).toBeTruthy();
          console.log('TX Hash:', txMatch?.[0]);
        } else {
          throw error; // Re-throw if it's a different error
        }
      }
    }, 120000);

    it.skipIf(!hasApiKey)('end-to-end: executes swap via Bankrbot', async () => {
      // This demonstrates the actual Bankrbot flow:
      // 1. Bankrbot receives prompt
      // 2. Bankrbot builds, signs, and broadcasts tx
      // 3. Returns confirmation with tx hash

      console.log('Submitting prompt to Bankrbot...');
      try {
        const tx = await bankrbotClient.getTransaction(
          'swap 0.00001 ETH to USDC on base',
          8453
        );

        // If we get a tx payload, validate it with KaiSign
        console.log('Validating transaction with KaiSign...');
        const validation = await validateBankrbotTransaction({
          to: tx.to,
          data: tx.data,
          chainId: tx.chainId,
          value: tx.value
        });

        console.log('Full validation result:', JSON.stringify(validation, null, 2));
        expect(validation.transaction.to).toBe(tx.to.toLowerCase());
        expect(validation.intent).toBeTruthy();

        if (validation.verified) {
          expect(validation.source).toBe('leaf-verified');
          console.log('Transaction verified with decoded intent:', validation.intent);
        }
      } catch (error) {
        // Expected: Bankrbot auto-executes and returns message with tx hash
        const msg = (error as Error).message;
        if (msg.includes('swapped') && msg.includes('basescan.org/tx/')) {
          console.log('Bankrbot executed swap successfully');
          const txMatch = msg.match(/0x[a-fA-F0-9]{64}/);
          expect(txMatch).toBeTruthy();
          console.log('TX Hash:', txMatch?.[0]);
          console.log('Full response:', msg);
        } else {
          throw error;
        }
      }
    }, 120000);
  });
});
