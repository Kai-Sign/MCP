import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Transaction, Wallet } from 'ethers';
import { clearSignPayload, normalizeTransactionPayload } from '../src/tools/clear-sign-payload.js';
import { clearPayloadStore, getPayloadFromStore, putPayloadChunk } from '../src/services/payload-store.js';

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

  it('accepts nested transaction-builder payloads and calldata/chain aliases', () => {
    expect(normalizeTransactionPayload({
      transaction: {
        to: tx.to,
        calldata: tx.data,
        chain: String(tx.chainId)
      }
    })).toEqual(tx);
  });

  it('accepts deeply nested hallucinated frontend/agent payload wrappers', () => {
    expect(normalizeTransactionPayload({
      chatCompletion: {
        tool_calls: [{
          function: {
            name: 'clear_sign_payload',
            arguments: {
              connector: 'KaiSignMCP',
              maybe: {
                builder: {
                  workflow: {
                    previewOnly: true,
                    neverBroadcast: true,
                    unsigned: {
                      walletRequest: {
                        transactionRequest: {
                          evmTransaction: {
                            target: tx.to,
                            input: tx.data,
                            networkId: String(tx.chainId),
                            valueWei: tx.value
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }]
      }
    })).toEqual(tx);
  });

  it('accepts local payload files to avoid MCP client input-size limits', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kaisign-clear-sign-test-'));
    const payloadFile = join(dir, 'tx.json');
    writeFileSync(payloadFile, JSON.stringify(tx));

    expect(normalizeTransactionPayload({ payloadFile })).toEqual(tx);
  });

  it('accepts local calldata files with small to/value/chainId arguments', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kaisign-clear-sign-test-'));
    const dataFile = join(dir, 'calldata.hex');
    writeFileSync(dataFile, tx.data);

    expect(normalizeTransactionPayload({ to: tx.to, dataFile, chainId: tx.chainId, value: tx.value })).toEqual(tx);
  });

  it('reassembles chunked remote payloads by payloadRef to avoid single-call size limits', () => {
    clearPayloadStore();
    const payload = JSON.stringify(tx);
    const first = putPayloadChunk({ chunk: payload.slice(0, 40), totalChunks: 2 });
    const second = putPayloadChunk({ payloadId: first.payloadId, chunk: payload.slice(40), index: 1, totalChunks: 2 });

    expect(second.complete).toBe(true);
    expect(getPayloadFromStore(second.payloadRef)).toEqual(tx);
    expect(normalizeTransactionPayload({ payloadRef: second.payloadRef })).toEqual(tx);
  });

  it('reassembles chunked remote calldata by payloadRef with small to/value/chainId arguments', () => {
    clearPayloadStore();
    const first = putPayloadChunk({ chunk: tx.data.slice(0, 50), totalChunks: 2, mode: 'text' });
    const second = putPayloadChunk({ payloadId: first.payloadId, chunk: tx.data.slice(50), index: 1, totalChunks: 2, mode: 'text' });

    expect(second.complete).toBe(true);
    expect(normalizeTransactionPayload({ to: tx.to, dataRef: second.payloadRef, chainId: tx.chainId, value: tx.value })).toEqual(tx);
  });

  it('accepts gzip+base64 compressed full payloads to bypass proxy argument limits', () => {
    const payloadGzipBase64 = gzipSync(Buffer.from(JSON.stringify(tx))).toString('base64');
    expect(payloadGzipBase64.length).toBeLessThan(JSON.stringify(tx).length);
    expect(normalizeTransactionPayload({ payloadGzipBase64 })).toEqual(tx);
  });

  it('accepts gzip+base64 compressed calldata with small to/value/chainId arguments', () => {
    const dataGzipBase64 = gzipSync(Buffer.from(tx.data)).toString('base64');
    expect(normalizeTransactionPayload({ to: tx.to, dataGzipBase64, chainId: tx.chainId, value: tx.value })).toEqual(tx);
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
      verification: { source: 'leaf-verified' as const }
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

  it('can compact echoed calldata in clear_sign_payload responses', async () => {
    const longData = `0x${'11'.repeat(4096)}`;
    const longTx = { ...tx, data: longData };
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
      transaction: longTx,
      nestedCalls: [{
        target: tx.to,
        selector: '0xa9059cbb',
        functionName: 'transfer',
        intent: 'Transfer token',
        success: true,
        params: { inner: longData },
        formatted: { inner: { label: 'inner', value: longData, rawValue: longData } },
        rawParams: { inner: longData },
        warnings: [],
        children: []
      }],
      verification: { source: 'leaf-verified' as const }
    }));

    const result = await clearSignPayload({ ...longTx, compact: true }, { getClearSignPrompt });
    const serialized = JSON.stringify(result);

    expect(result.transaction.data).toContain('[omitted');
    expect(result.clearSign.transaction.data).toContain('[omitted');
    expect((result.clearSign.nestedCalls?.[0] as any).rawParams.inner).toContain('[omitted');
    expect(serialized).not.toContain(longData);
    expect((result.clearSign as any).dataSummary.bytes).toBe((longData.length - 2) / 2);
  });
});
