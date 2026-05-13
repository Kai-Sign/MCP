#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { Transaction } from 'ethers';
import { clearSignTransaction, type ClearSignTransactionInput, type ClearSignTransactionResult } from './tools/clear-sign-transaction.js';

export interface ClearSignCliDeps {
  clearSignTransaction: (input: ClearSignTransactionInput) => Promise<ClearSignTransactionResult | unknown>;
}

export interface CliRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

function usage(): string {
  return [
    'Usage: kaisign clear-sign --metadata path/to/metadata.json --to 0x... --data 0x... [--chain 8453] [--value 0] [--json]',
    '       kaisign clear-sign --metadata path/to/metadata.json --tx 0x02f8... [--json]',
    '',
    'Or pipe JSON on stdin:',
    '  echo \'{"metadata":"metadata.json","to":"0x...","data":"0x...","chainId":8453,"value":"0"}\' | kaisign clear-sign --json',
    '',
    '--metadata is a local ERC-7730 metadata JSON file. --metadata-file is kept as an alias.',
    '--data/--calldata is raw transaction calldata. --tx/--raw-tx is a signed serialized Ethereum transaction.'
  ].join('\n');
}

function parseArgs(argv: string[]): { command?: string; flags: Record<string, string | boolean> } {
  const [command, ...rest] = argv;
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('--')) continue;
    const key = arg.slice(2);
    if (key === 'json') {
      flags.json = true;
      continue;
    }
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) {
      flags[key] = true;
      continue;
    }
    flags[key] = next;
    i++;
  }

  return { command, flags };
}

function metadataPathFromFlags(flags: Record<string, string | boolean>): string | undefined {
  return typeof flags.metadata === 'string'
    ? flags.metadata
    : (typeof flags['metadata-file'] === 'string' ? flags['metadata-file'] : undefined);
}

function inputFromRawTx(rawTx: string, metadataFile?: string): ClearSignTransactionInput {
  const tx = Transaction.from(rawTx.trim());
  if (!tx.to) throw new Error('raw transaction has no target address');
  if (!tx.data || tx.data === '0x') throw new Error('raw transaction has no calldata');
  return {
    to: tx.to,
    data: tx.data,
    chainId: Number(tx.chainId || BigInt(1)),
    value: tx.value.toString(),
    metadataFile
  };
}

function inputFromFlags(flags: Record<string, string | boolean>, stdin: string): ClearSignTransactionInput | null {
  const metadataFile = metadataPathFromFlags(flags);
  const rawTxFlag = typeof flags.tx === 'string' ? flags.tx : (typeof flags['raw-tx'] === 'string' ? flags['raw-tx'] : undefined);
  if (rawTxFlag) return inputFromRawTx(rawTxFlag, metadataFile);

  if (stdin.trim()) {
    const text = stdin.trim();
    if (/^0x[0-9a-fA-F]+$/.test(text)) return inputFromRawTx(text, metadataFile);
    const parsed = JSON.parse(text) as Partial<ClearSignTransactionInput> & { chain?: number | string; tx?: string; rawTx?: string; metadata?: string };
    const parsedMetadataFile = parsed.metadataFile ?? parsed.metadata ?? metadataFile;
    if (parsed.tx || parsed.rawTx) return inputFromRawTx(String(parsed.tx ?? parsed.rawTx), parsedMetadataFile);
    const chainId = parsed.chainId ?? parsed.chain;
    return {
      to: String(parsed.to ?? ''),
      data: String(parsed.data ?? ''),
      chainId: chainId === undefined ? 1 : Number(chainId),
      value: parsed.value === undefined ? '0' : String(parsed.value),
      metadataFile: parsedMetadataFile
    };
  }

  const data = typeof flags.data === 'string' ? flags.data : (typeof flags.calldata === 'string' ? flags.calldata : undefined);
  if (typeof flags.to !== 'string' || !data) return null;

  return {
    to: flags.to,
    data,
    chainId: typeof flags.chain === 'string' ? Number(flags.chain) : (typeof flags.chainId === 'string' ? Number(flags.chainId) : 1),
    value: typeof flags.value === 'string' ? flags.value : '0',
    metadataFile
  };
}

function boolResult(value: unknown): boolean {
  return value === true;
}

function formatPlain(result: Record<string, unknown>): string {
  const verified = boolResult(result.verified) || boolResult(result.metadataHashVerified);
  const safe = boolResult(result.safeToSign) || boolResult(result.safeToAutonomouslySign) || boolResult(result.fullyClearSigned);
  const lines: string[] = [];

  lines.push(verified ? '✓ KaiSign verified' : '⚠ KaiSign not fully verified');
  lines.push(`Safe to sign: ${safe ? 'yes' : 'no'}`);
  if (result.source) lines.push(`Source: ${String(result.source)}`);
  if (result.functionName) lines.push(`Function: ${String(result.functionName)}`);
  lines.push(`Intent: ${String(result.aggregatedIntent ?? result.intent ?? 'Unknown transaction')}`);

  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  if (warnings.length) {
    lines.push('Warnings:');
    for (const warning of warnings) lines.push(`- ${String(warning)}`);
  }

  return lines.join('\n') + '\n';
}

export async function runCli(
  argv: string[] = process.argv.slice(2),
  stdin = '',
  deps: ClearSignCliDeps = { clearSignTransaction }
): Promise<CliRunResult> {
  const { command, flags } = parseArgs(argv);

  if (command !== 'clear-sign') {
    return { exitCode: 2, stdout: '', stderr: `${usage()}\n` };
  }

  let input: ClearSignTransactionInput | null;
  try {
    input = inputFromFlags(flags, stdin);
  } catch (error) {
    return { exitCode: 2, stdout: '', stderr: `Invalid transaction JSON: ${(error as Error).message}\n${usage()}\n` };
  }

  if (!input || !input.to || !input.data || !input.metadataFile) {
    return { exitCode: 2, stdout: '', stderr: `${usage()}\n` };
  }

  try {
    const result = await deps.clearSignTransaction(input) as Record<string, unknown>;
    const safe = boolResult(result.safeToSign) || boolResult(result.safeToAutonomouslySign) || boolResult(result.fullyClearSigned);
    const stdout = flags.json ? `${JSON.stringify(result, null, 2)}\n` : formatPlain(result);
    return { exitCode: safe ? 0 : 1, stdout, stderr: '' };
  } catch (error) {
    return { exitCode: 1, stdout: '', stderr: `${(error as Error).message}\n` };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const stdin = process.stdin.isTTY ? '' : readFileSync(0, 'utf8');
  runCli(process.argv.slice(2), stdin).then((result) => {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
  });
}
