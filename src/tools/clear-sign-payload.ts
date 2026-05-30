/**
 * clear_sign_payload helper/tool
 *
 * Normalizes transaction payloads produced by tx builders/LLMs/Bankrbot-like agents
 * into the canonical KaiSign transaction shape, then returns clear-signing data for
 * the exact original transaction the user/agent must sign.
 */

import { Transaction } from 'ethers';
import { z } from 'zod';
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

export async function clearSignPayload(
  input: unknown,
  deps: ClearSignPayloadDeps = { getClearSignPrompt }
): Promise<ClearSignPayloadResult> {
  const transaction = normalizeTransactionPayload(input);
  const clearSign = await deps.getClearSignPrompt(transaction);
  const warnings = Array.isArray(clearSign.warnings) ? clearSign.warnings : [];
  const canAutonomouslySign = Boolean(clearSign.safeToAutonomouslySign && clearSign.verified && warnings.length === 0);
  const mustShowToUser = Boolean(clearSign.requiresHumanReview || !canAutonomouslySign);

  return {
    transaction,
    clearSign,
    signingPolicy: {
      signOriginalTransactionOnly: true,
      canAutonomouslySign,
      mustShowToUser,
      blockReason: canAutonomouslySign ? undefined : 'requires user or agent policy approval before signing/broadcasting'
    }
  };
}
