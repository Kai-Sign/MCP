import { describe, expect, it, vi } from 'vitest';
import { Wallet } from 'ethers';
import { runCli, type ClearSignCliDeps } from '../src/cli.js';

const tx = {
  to: '0x1111111111111111111111111111111111111111',
  data: '0xa9059cbb0000000000000000000000002222222222222222222222222222222222222222000000000000000000000000000000000000000000000000000000000000000a',
  chainId: 8453,
  value: '0'
};

function deps(result: unknown): ClearSignCliDeps {
  return {
    clearSignTransaction: vi.fn(async () => result)
  };
}

describe('kaisign CLI', () => {
  it('prints plain clear-sign output from flags', async () => {
    const result = {
      verified: true,
      fullyClearSigned: true,
      safeToSign: true,
      source: 'leaf-verified',
      intent: 'Transfer 10 USDC to 0x2222222222222222222222222222222222222222',
      functionName: 'transfer',
      warnings: [],
      transaction: tx,
      metadataHashVerified: true
    };

    const out = await runCli([
      'clear-sign',
      '--metadata', 'metadata.json',
      '--to', tx.to,
      '--data', tx.data,
      '--chain', String(tx.chainId),
      '--value', tx.value
    ], '', deps(result));

    expect(out.exitCode).toBe(0);
    expect(out.stderr).toBe('');
    expect(out.stdout).toContain('✓ KaiSign verified');
    expect(out.stdout).toContain('Safe to sign: yes');
    expect(out.stdout).toContain('Intent: Transfer 10 USDC');
  });

  it('reads transaction JSON from stdin and prints JSON output', async () => {
    const result = {
      verified: false,
      fullyClearSigned: false,
      safeToSign: false,
      source: 'local-metadata',
      intent: 'Contract interaction',
      functionName: 'unknown',
      warnings: ['No verified metadata'],
      transaction: tx,
      metadataHashVerified: false
    };

    const out = await runCli(['clear-sign', '--metadata', 'metadata.json', '--json'], JSON.stringify(tx), deps(result));

    expect(out.exitCode).toBe(1);
    expect(out.stderr).toBe('');
    expect(JSON.parse(out.stdout)).toMatchObject({
      verified: false,
      safeToSign: false,
      metadataHashVerified: false
    });
  });

  it('accepts a signed serialized raw transaction via --tx', async () => {
    const wallet = new Wallet('0x'.padEnd(66, '1'));
    const rawTx = await wallet.signTransaction({
      to: tx.to,
      data: tx.data,
      value: BigInt(tx.value),
      chainId: tx.chainId,
      nonce: 0,
      gasLimit: 210000n,
      maxFeePerGas: 1000000000n,
      maxPriorityFeePerGas: 100000000n,
      type: 2
    });
    const dep = deps({
      verified: true,
      fullyClearSigned: true,
      safeToSign: true,
      source: 'leaf-verified',
      intent: 'Transfer 10 USDC',
      transaction: tx,
      metadataHashVerified: true
    });

    const out = await runCli(['clear-sign', '--metadata', 'metadata.json', '--tx', rawTx], '', dep);

    expect(out.exitCode).toBe(0);
    expect(dep.clearSignTransaction).toHaveBeenCalledWith(expect.objectContaining({
      to: tx.to,
      data: tx.data,
      chainId: tx.chainId,
      value: tx.value
    }));
  });

  it('accepts plaintext payload as positional input with --json', async () => {
    const result = {
      decoded: true,
      source: 'local-metadata',
      intent: 'Transfer 10 USDC',
      functionName: 'transfer',
      warnings: [],
      transaction: tx
    };
    const dep = deps(result);

    const out = await runCli(['clear-sign', '--json', JSON.stringify(tx)], '', dep);

    expect(out.exitCode).toBe(0);
    expect(out.stderr).toBe('');
    expect(dep.clearSignTransaction).toHaveBeenCalledWith(expect.objectContaining(tx));
    expect(JSON.parse(out.stdout)).toMatchObject({ decoded: true, functionName: 'transfer' });
  });

  it('accepts interactive paste mode input from stdin', async () => {
    const result = {
      decoded: true,
      source: 'local-metadata',
      intent: 'Transfer 10 USDC',
      functionName: 'transfer',
      warnings: [],
      transaction: tx
    };
    const wrapped = `{
      "to": "${tx.to}",
      "value": "0",
      "chainId": 8453,
      "data": "${tx.data.slice(0, 74)}\n        ${tx.data.slice(74)}"
    }`;
    const dep = deps(result);

    const out = await runCli(['clear-sign', '--paste'], wrapped, dep);

    expect(out.exitCode).toBe(0);
    expect(out.stderr).toBe('');
    expect(dep.clearSignTransaction).toHaveBeenCalledWith(expect.objectContaining(tx));
    expect(out.stdout).toContain('Intent: Transfer 10 USDC');
  });

  it('fails with usage when required args are missing', async () => {
    const out = await runCli(['clear-sign', '--to', tx.to], '', deps({}));

    expect(out.exitCode).toBe(2);
    expect(out.stderr).toContain('Usage: kaisign clear-sign');
  });
});
