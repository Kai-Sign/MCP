#!/usr/bin/env node
import { existsSync, readFileSync, statSync } from 'node:fs';
import { Transaction } from 'ethers';
import { clearSignTransaction, type ClearSignTransactionInput, type ClearSignTransactionResult } from './tools/clear-sign-transaction.js';
import { renderCallTree, renderStatusLines, type ContractSummary, type SigningStatus } from './tools/signing-policy.js';
import type { RecursiveCallNode } from './services/recursive-decoder.js';

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
    'Usage: kaisign clear-sign --to 0x... --data 0x... [--chain 8453] [--value 0] [--metadata path/to/metadata.json] [--json]',
    '       kaisign clear-sign --tx 0x02f8... [--metadata path/to/metadata.json] [--json]',
    '       kaisign clear-sign --json \'{"to":"0x...","data":"0x...","chainId":1,"value":"0"}\'',
    '       kaisign clear-sign path/to/tx.json [--json]',
    '       kaisign clear-sign [--json]',
    '',
    'clear-sign is the default command and may be omitted, e.g.: kaisign --json tx.json',
    '',
    'Or pipe JSON on stdin:',
    '  echo \'{"metadata":"metadata.json","to":"0x...","data":"0x...","chainId":8453,"value":"0"}\' | kaisign clear-sign --json',
    '',
    '--metadata is optional; when omitted, the decoder searches the local metadata folder/cache by target address + chainId. --metadata-file is kept as an alias.',
    '--data/--calldata is raw transaction calldata. --tx/--raw-tx is a signed serialized Ethereum transaction.',
    'With no tx args/stdin, clear-sign opens a paste box; paste the payload, then press Ctrl-D.'
  ].join('\n');
}

function parseArgs(argv: string[]): { command?: string; flags: Record<string, string | boolean> } {
  const [command, ...rest] = argv;
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (key === 'json') {
      flags.json = true;
      continue;
    }
    if (key === 'paste' || key === 'interactive') {
      flags.paste = true;
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

  if (positional.length > 0) flags._ = positional.join(' ');

  return { command, flags };
}

function metadataPathFromFlags(flags: Record<string, string | boolean>): string | undefined {
  return typeof flags.metadata === 'string'
    ? flags.metadata
    : (typeof flags['metadata-file'] === 'string' ? flags['metadata-file'] : undefined);
}

function stripHexWhitespace(value: string): string {
  const compact = value.replace(/\s+/g, '');
  return /^0x[0-9a-fA-F]*$/.test(compact) ? compact : value;
}

function sanitizeTransactionInput(input: ClearSignTransactionInput): ClearSignTransactionInput {
  return {
    ...input,
    to: stripHexWhitespace(String(input.to ?? '')),
    data: stripHexWhitespace(String(input.data ?? '')),
    value: input.value === undefined ? input.value : stripHexWhitespace(String(input.value))
  };
}

function parseLooseTransactionJson(text: string): Partial<ClearSignTransactionInput> & { chain?: number | string; tx?: string; rawTx?: string; metadata?: string } {
  try {
    return JSON.parse(text) as Partial<ClearSignTransactionInput> & { chain?: number | string; tx?: string; rawTx?: string; metadata?: string };
  } catch {
    // Agents often paste JSON-looking payloads with pretty-wrapped calldata inside a string.
    // That is not valid JSON, but the transaction fields are still unambiguous enough to recover.
    const stringField = (key: string): string | undefined => {
      const match = text.match(new RegExp(`"${key}"\\s*:\\s*"([\\s\\S]*?)"`, 'i'));
      return match ? stripHexWhitespace(match[1]) : undefined;
    };
    const numberField = (key: string): number | undefined => {
      const match = text.match(new RegExp(`"${key}"\\s*:\\s*(\\d+)`, 'i'));
      return match ? Number(match[1]) : undefined;
    };

    const parsed = {
      metadataFile: stringField('metadataFile'),
      metadata: stringField('metadata'),
      to: stringField('to'),
      data: stringField('data') ?? stringField('calldata') ?? stringField('input'),
      chainId: numberField('chainId') ?? numberField('chain'),
      value: stringField('value') ?? '0'
    };

    if (!parsed.to && !parsed.data) throw new Error('invalid JSON and could not recover transaction fields');
    return parsed;
  }
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

  let inlinePayload = typeof flags.payload === 'string'
    ? flags.payload
    : (typeof flags.text === 'string'
      ? flags.text
      : (typeof flags.input === 'string'
        ? flags.input
        : (typeof flags._ === 'string' ? flags._ : undefined)));

  // A positional/inline payload that names an existing file is read as the payload.
  if (inlinePayload?.trim() && existsSync(inlinePayload.trim()) && statSync(inlinePayload.trim()).isFile()) {
    inlinePayload = readFileSync(inlinePayload.trim(), 'utf8');
  }

  if (!stdin.trim() && inlinePayload?.trim()) stdin = inlinePayload;

  if (stdin.trim()) {
    const text = stdin.trim();
    if (/^0x[0-9a-fA-F]+$/.test(text)) return inputFromRawTx(text, metadataFile);
    const parsed = parseLooseTransactionJson(text);
    const parsedMetadataFile = parsed.metadataFile ?? parsed.metadata ?? metadataFile;
    if (parsed.tx || parsed.rawTx) return inputFromRawTx(String(parsed.tx ?? parsed.rawTx), parsedMetadataFile);
    const chainId = parsed.chainId ?? parsed.chain;
    return sanitizeTransactionInput({
      to: String(parsed.to ?? ''),
      data: String(parsed.data ?? ''),
      chainId: chainId === undefined ? 1 : Number(chainId),
      value: parsed.value === undefined ? '0' : String(parsed.value),
      metadataFile: parsedMetadataFile
    });
  }

  const data = typeof flags.data === 'string' ? flags.data : (typeof flags.calldata === 'string' ? flags.calldata : undefined);
  if (typeof flags.to !== 'string' || !data) return null;

  return sanitizeTransactionInput({
    to: flags.to,
    data,
    chainId: typeof flags.chain === 'string' ? Number(flags.chain) : (typeof flags.chainId === 'string' ? Number(flags.chainId) : 1),
    value: typeof flags.value === 'string' ? flags.value : '0',
    metadataFile
  });
}

function boolResult(value: unknown): boolean {
  return value === true;
}

async function readStdinText(): Promise<string> {
  process.stdin.setEncoding('utf8');

  // In a TTY, canonical (line-buffered) mode truncates each input line at the
  // kernel limit (4095 chars on macOS/Linux), silently corrupting pasted
  // calldata. Raw mode bypasses the line buffer; we handle Ctrl-D/Ctrl-C here.
  if (process.stdin.isTTY) {
    return new Promise((resolvePaste) => {
      let input = '';
      process.stdin.setRawMode(true);
      process.stdin.resume();
      const onData = (chunk: string) => {
        for (const char of chunk) {
          if (char.charCodeAt(0) === 0x03) { // Ctrl-C
            process.stdin.setRawMode(false);
            process.exit(130);
          }
          if (char.charCodeAt(0) === 0x04) { // Ctrl-D: end of paste
            process.stdin.setRawMode(false);
            process.stdin.pause();
            process.stdin.off('data', onData);
            process.stderr.write('\n');
            resolvePaste(input);
            return;
          }
          input += char === '\r' ? '\n' : char;
        }
        process.stderr.write(chunk.replace(/\r/g, '\n')); // echo (raw mode disables it)
      };
      process.stdin.on('data', onData);
    });
  }

  let input = '';
  for await (const chunk of process.stdin) input += chunk;
  return input;
}

function formatPlain(result: Record<string, unknown>): string {
  const signing = result.signing as SigningStatus | undefined;
  const contracts = (result.contracts as ContractSummary[] | undefined) ?? [];
  const callTree = result.callTree as RecursiveCallNode | undefined;
  const lines: string[] = ['KaiSign clear-sign'];

  if (signing) {
    lines.push(...renderStatusLines(signing, contracts));
  } else {
    // Legacy result shape (e.g. injected deps in tests) without the signing block.
    const verified = boolResult(result.verified) || boolResult(result.metadataHashVerified);
    const safe = boolResult(result.safeToSign) || boolResult(result.safeToAutonomouslySign) || boolResult(result.fullyClearSigned);
    lines.push(verified ? '✓ KaiSign verified' : '⚠ KaiSign not registry-attested');
    lines.push(`Safe to sign: ${safe ? 'yes' : 'no'}`);
  }
  if (result.source) lines.push(`Source: ${String(result.source)}`);
  lines.push(`Intent: ${String(result.aggregatedIntent ?? result.intent ?? 'Unknown transaction')}`);

  if (callTree && typeof callTree === 'object' && 'selector' in callTree) {
    lines.push('');
    lines.push(renderCallTree(callTree, contracts));
  }

  const warnings = Array.isArray(result.warnings) ? result.warnings : [];
  if (warnings.length) {
    lines.push('');
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
  // clear-sign is the default command; `kaisign --json tx.json` works without it.
  const normalizedArgv = argv[0] === 'clear-sign' ? argv : ['clear-sign', ...argv];
  const { command, flags } = parseArgs(normalizedArgv);

  if (command !== 'clear-sign' || argv[0] === 'help' || argv[0] === '--help' || flags.help === true) {
    return { exitCode: 2, stdout: '', stderr: `${usage()}\n` };
  }

  let input: ClearSignTransactionInput | null;
  try {
    input = inputFromFlags(flags, stdin);
  } catch (error) {
    return { exitCode: 2, stdout: '', stderr: `Invalid transaction JSON: ${(error as Error).message}\n${usage()}\n` };
  }

  if (!input || !input.to || !input.data) {
    return { exitCode: 2, stdout: '', stderr: `${usage()}\n` };
  }

  try {
    const result = await deps.clearSignTransaction(input) as Record<string, unknown>;
    // Exit 0 when fully decoded (verdict safe or review) — registry attestation
    // pending is status, not failure. Exit 1 only on reject/decode failure.
    const verdict = (result.signing as SigningStatus | undefined)?.verdict;
    const ok = verdict
      ? verdict !== 'reject'
      : boolResult(result.decoded) || boolResult(result.safeToSign) || boolResult(result.safeToAutonomouslySign) || boolResult(result.fullyClearSigned);
    const stdout = flags.json ? `${JSON.stringify(result, null, 2)}\n` : formatPlain(result);
    return { exitCode: ok ? 0 : 1, stdout, stderr: '' };
  } catch (error) {
    return { exitCode: 1, stdout: '', stderr: `${(error as Error).message}\n` };
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const cliArgs = process.argv[2] === 'clear-sign' ? process.argv.slice(3) : process.argv.slice(2);
  const hasTxInputArg = process.argv.some((arg) => [
    '--to', '--data', '--calldata', '--tx', '--raw-tx', '--payload', '--text', '--input'
  ].includes(arg));
  const hasPositionalPayload = cliArgs.some((arg) => !arg.startsWith('--'));
  const wantsPaste = process.argv.includes('--paste')
    || process.argv.includes('--interactive')
    || (process.stdin.isTTY && !hasTxInputArg && !hasPositionalPayload);
  if (wantsPaste && process.stdin.isTTY) {
    process.stderr.write([
      '┌────────────────────────────────────────────────────────────┐',
      '│ Paste unsigned tx JSON/plaintext below, then press Ctrl-D. │',
      '└────────────────────────────────────────────────────────────┘',
      ''
    ].join('\n'));
  }
  const stdinPromise = (!process.stdin.isTTY || wantsPaste) ? readStdinText() : Promise.resolve('');
  stdinPromise
    .then((stdin) => runCli(process.argv.slice(2), stdin))
    .then((result) => {
      if (result.stdout) process.stdout.write(result.stdout);
      if (result.stderr) process.stderr.write(result.stderr);
      process.exitCode = result.exitCode;
    })
    .catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
