/**
 * clear_sign_payload helper/tool
 *
 * Normalizes transaction payloads produced by tx builders/LLMs/Bankrbot-like agents
 * into the canonical KaiSign transaction shape, then returns clear-signing data for
 * the exact original transaction the user/agent must sign.
 */

import { Transaction, keccak256 } from 'ethers';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { getPayloadFromStore, getPayloadTextFromStore } from '../services/payload-store.js';
import { getClearSignPrompt, type ClearSignInput, type ClearSignResult } from './get-clear-sign-prompt.js';

export const clearSignPayloadSchema = z.object({}).passthrough();

export interface NormalizedTransactionPayload extends ClearSignInput {
  to: string;
  data: string;
  chainId: number;
  value: string;
}

export interface ClearSignPayloadDeps {
  getClearSignPrompt: (input: ClearSignInput) => Promise<ClearSignResult>;
}

export interface ClearSignPayloadResult {
  transaction: NormalizedTransactionPayload;
  clearSign: ClearSignResult;
  /** Unified signing verdict shared by all KaiSign tools */
  signing?: ClearSignResult['signing'];
  signingPolicy: {
    signOriginalTransactionOnly: true;
    canAutonomouslySign: boolean;
    mustShowToUser: boolean;
    blockReason?: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  return undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return undefined;
}

const NESTED_PAYLOAD_KEYS = [
  'transaction',
  'tx',
  'unsignedTransaction',
  'unsignedTx',
  'request',
  'payload',
  'params',
  'arguments',
  'args',
  'body',
  'draft',
  'prepared',
  'preparedTransaction',
  'evmTransaction',
  'transactionRequest',
  'walletRequest',
  'signingRequest'
];

function hasTransactionFields(input: Record<string, unknown>): boolean {
  const hasTo = input.to !== undefined || input.target !== undefined || input.contractAddress !== undefined;
  const hasData = input.data !== undefined || input.calldata !== undefined || input.input !== undefined;
  const hasRaw = rawTxFrom(input) !== undefined;
  return hasRaw || (hasTo && hasData);
}

function readTextFile(path: string): string {
  return readFileSync(resolve(path), 'utf8').trim();
}

function decodeGzipBase64(value: unknown): string | undefined {
  const encoded = asString(value);
  if (!encoded) return undefined;
  return gunzipSync(Buffer.from(encoded, 'base64')).toString('utf8').trim();
}

function parsePayloadText(text: string): unknown {
  if (/^0x[0-9a-fA-F]+$/.test(text)) return text;
  return JSON.parse(text);
}

function fileBackedPayload(input: Record<string, unknown>): unknown {
  const payloadGzip = decodeGzipBase64(input.payloadGzipBase64 ?? input.transactionGzipBase64 ?? input.txGzipBase64);
  if (payloadGzip) return parsePayloadText(payloadGzip);

  const payloadRef = asString(input.payloadRef ?? input.transactionRef ?? input.txRef);
  if (payloadRef) return getPayloadFromStore(payloadRef);

  const payloadFile = asString(input.payloadFile ?? input.transactionFile ?? input.txFile ?? input.inputFile);
  if (payloadFile) return parsePayloadText(readTextFile(payloadFile));

  const rawTxFile = asString(input.rawTxFile ?? input.rawTransactionFile ?? input.serializedTransactionFile);
  if (rawTxFile) return readTextFile(rawTxFile);

  const dataGzip = decodeGzipBase64(input.dataGzipBase64 ?? input.calldataGzipBase64);
  if (dataGzip) {
    return {
      ...input,
      data: dataGzip
    };
  }

  const dataRef = asString(input.dataRef ?? input.calldataRef);
  if (dataRef) {
    return {
      ...input,
      data: getPayloadTextFromStore(dataRef).trim()
    };
  }

  const dataFile = asString(input.dataFile ?? input.calldataFile);
  if (dataFile) {
    return {
      ...input,
      data: readTextFile(dataFile)
    };
  }

  return input;
}

function nestedPayload(input: unknown): Record<string, unknown> {
  if (!isRecord(input)) throw new Error('transaction payload must be an object');
  if (hasTransactionFields(input)) return input;

  const queue: Record<string, unknown>[] = [input];
  const seen = new Set<Record<string, unknown>>();

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);

    for (const key of NESTED_PAYLOAD_KEYS) {
      const nested = current[key];
      if (isRecord(nested)) {
        if (hasTransactionFields(nested)) return nested;
        queue.push(nested);
      } else if (Array.isArray(nested)) {
        for (const item of nested) {
          if (isRecord(item)) {
            if (hasTransactionFields(item)) return item;
            queue.push(item);
          }
        }
      }
    }

    // Last-resort support for LLM/UI wrappers with arbitrary names. Keep this breadth-first
    // so shallow canonical fields win over unrelated deep objects.
    for (const value of Object.values(current)) {
      if (isRecord(value)) {
        if (hasTransactionFields(value)) return value;
        queue.push(value);
      } else if (Array.isArray(value)) {
        for (const item of value) {
          if (isRecord(item)) {
            if (hasTransactionFields(item)) return item;
            queue.push(item);
          }
        }
      }
    }
  }

  return input;
}

function rawTxFrom(input: Record<string, unknown>): string | undefined {
  return asString(input.rawTx)
    ?? asString(input.rawTransaction)
    ?? asString(input.signedRawTransaction)
    ?? asString(input.serializedTransaction)
    ?? asString(input.serialized);
}

function normalizeRawTransaction(rawTx: string): NormalizedTransactionPayload {
  const tx = Transaction.from(rawTx.trim());
  if (!tx.to) throw new Error('raw transaction has no target address');
  if (!tx.data || tx.data === '0x') throw new Error('raw transaction has no calldata');

  return {
    to: tx.to,
    data: tx.data,
    chainId: Number(tx.chainId || BigInt(1)),
    value: tx.value.toString()
  };
}

export function normalizeTransactionPayload(input: unknown): NormalizedTransactionPayload {
  if (isRecord(input)) input = fileBackedPayload(input);

  if (typeof input === 'string') {
    if (/^0x[0-9a-fA-F]+$/.test(input.trim())) return normalizeRawTransaction(input);
    throw new Error('string payload must be a serialized raw transaction hex string');
  }

  const payload = nestedPayload(input);
  const rawTx = rawTxFrom(payload);
  if (rawTx) return normalizeRawTransaction(rawTx);

  const to = asString(payload.to ?? payload.target ?? payload.contractAddress);
  const data = asString(payload.data ?? payload.calldata ?? payload.input);
  const chainId = asNumber(payload.chainId ?? payload.chain ?? payload.networkId);
  const value = asString(payload.value ?? payload.valueWei ?? payload.ethValue) ?? '0';

  if (!to) throw new Error('transaction payload missing to');
  if (!data) throw new Error('transaction payload missing data/calldata');

  const normalized = {
    to,
    data,
    chainId: chainId ?? 1,
    value
  };

  // Reuse the existing public schema so all MCP surfaces enforce the same safety checks.
  return {
    ...getClearSignPromptSchemaCompatibleParse(normalized)
  };
}

function getClearSignPromptSchemaCompatibleParse(input: NormalizedTransactionPayload): NormalizedTransactionPayload {
  // Keep this file decoupled from zod internals while matching get_clear_sign_prompt constraints.
  if (!/^0x[a-fA-F0-9]{40}$/.test(input.to)) throw new Error('Invalid Ethereum address');
  if (!/^0x[a-fA-F0-9]+$/.test(input.data)) throw new Error('Invalid calldata hex string');
  if (!Number.isInteger(input.chainId) || input.chainId <= 0) throw new Error('Invalid chainId');
  return input;
}

function compactHex(hex: string) {
  return {
    omitted: true,
    bytes: (hex.length - 2) / 2,
    keccak256: keccak256(hex),
    prefix: hex.slice(0, 18),
    suffix: hex.slice(-16)
  };
}

function isLongHex(value: unknown): value is string {
  return typeof value === 'string' && /^0x[0-9a-fA-F]+$/.test(value) && value.length > 98;
}

function compactHexString(hex: string): string {
  const summary = compactHex(hex);
  return `[omitted ${summary.bytes} bytes ${summary.keccak256}]`;
}

function compactLargeHexValues<T>(value: T, seen = new WeakSet<object>()): T {
  if (isLongHex(value)) return compactHexString(value) as T;

  if (Array.isArray(value)) {
    return value.map(item => compactLargeHexValues(item, seen)) as T;
  }

  if (value && typeof value === 'object') {
    if (seen.has(value as object)) return value;
    seen.add(value as object);

    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      output[key] = compactLargeHexValues(entry, seen);
    }
    return output as T;
  }

  return value;
}

function wantsCompact(input: unknown): boolean {
  return isRecord(input) && (input.compact === true || input.responseMode === 'compact' || input.omitTransactionData === true);
}

export async function clearSignPayload(
  input: unknown,
  deps: ClearSignPayloadDeps = { getClearSignPrompt }
): Promise<ClearSignPayloadResult> {
  const compact = wantsCompact(input);
  const transaction = normalizeTransactionPayload(input);
  const clearSign = await deps.getClearSignPrompt(transaction);
  const warnings = Array.isArray(clearSign.warnings) ? clearSign.warnings : [];
  const canAutonomouslySign = clearSign.signing
    ? clearSign.signing.verdict === 'safe' && warnings.length === 0
    : Boolean(clearSign.safeToAutonomouslySign && clearSign.verified && warnings.length === 0);
  const mustShowToUser = Boolean(clearSign.requiresHumanReview || !canAutonomouslySign);

  const result: ClearSignPayloadResult = {
    transaction,
    clearSign,
    signing: clearSign.signing,
    signingPolicy: {
      signOriginalTransactionOnly: true,
      canAutonomouslySign,
      mustShowToUser,
      blockReason: canAutonomouslySign ? undefined : (clearSign.signing?.reason ?? 'requires user or agent policy approval before signing/broadcasting')
    }
  };

  if (compact) {
    const dataSummary = compactHex(transaction.data);
    const compactData = `[omitted ${dataSummary.bytes} bytes ${dataSummary.keccak256}]`;
    const compactClearSign = compactLargeHexValues(clearSign);

    return {
      ...result,
      transaction: {
        ...transaction,
        data: compactData
      },
      clearSign: {
        ...compactClearSign,
        transaction: {
          ...compactClearSign.transaction,
          data: compactData
        },
        dataSummary
      } as ClearSignResult & { dataSummary: ReturnType<typeof compactHex> }
    };
  }

  return result;
}
