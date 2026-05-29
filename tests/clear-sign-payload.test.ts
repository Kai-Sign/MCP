import { describe, expect, it, vi } from 'vitest';
import { Transaction, Wallet } from 'ethers';
import { clearSignPayload, normalizeTransactionPayload } from '../src/tools/clear-sign-payload.js';

const tx = {
  to: '0x1111111111111111111111111111111111111111',
  data: '0xa9059cbb0000000000000000000000002222222222222222222222222222222222222222000000000000000000000000000000000000000000000000000000000000000a',
  chainId: 8453,
  value: '0'
};

describe('clear sign payload normalization', () => {
  it('accepts direct tx-builder payloads', () => {
    expect(normalizeTransactionPayload(tx)).toEqual(tx);
  });

  it('accepts Bankrbot-style nested transaction payloads and calldata/chain aliases', () => {
    expect(normalizeTransactionPayload({
      transaction: {
        to: tx.to,
        calldata: tx.data,
        chain: String(tx.chainId)
      }
    })).toEqual(tx);
  });

  it('accepts signed raw transactions for post-build display', async () => {
    const wallet = new Wallet('0x'.padEnd(66, '1'));
    const rawTx = await wallet.signTransaction({
      to: tx.to,
      data: tx.data,
      value: 0n,
      chainId: tx.chainId,
      nonce: 0,
      gasLimit: 210000n,
      maxFeePerGas: 1000000000n,
      maxPriorityFeePerGas: 100000000n,
      type: 2
    });

    expect(normalizeTransactionPayload({ rawTx })).toEqual(tx);
  });

  it('returns clear-sign data plus the normalized original transaction to sign', async () => {
    const getClearSignPrompt = vi.fn(async () => ({
      displayText: '✓ Verified Transaction\n\nTransfer 10 USDC',
      verified: true,
      verificationBadge: '✓ Verified',
      intent: 'Transfer 10 USDC',
      functionName: 'transfer',
      warnings: [],
      fullyDecoded: true,
      requiresHumanReview: false,
      safeToAutonomouslySign: true,
      transaction: tx,
      verification: { source: 'leaf-verified' }
    }));

    const result = await clearSignPayload({ tx }, { getClearSignPrompt });

    expect(getClearSignPrompt).toHaveBeenCalledWith(tx);
    expect(result.transaction).toEqual(tx);
    expect(result.clearSign.intent).toBe('Transfer 10 USDC');
    expect(result.signingPolicy).toMatchObject({
      signOriginalTransactionOnly: true,
      canAutonomouslySign: true,
      mustShowToUser: false
    });
  });
});
