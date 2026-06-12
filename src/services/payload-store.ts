import { randomUUID } from 'node:crypto';

const DEFAULT_TTL_MS = 15 * 60 * 1000;
const MAX_CHUNKS = 256;
const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;
const REF_PREFIX = 'kaisign-payload:';

type StoredPayload = {
  chunks: string[];
  totalChunks: number;
  mode: 'json' | 'text';
  createdAt: number;
  expiresAt: number;
};

export type PutPayloadChunkInput = {
  payloadId?: string;
  payloadRef?: string;
  chunk: string;
  index?: number;
  totalChunks?: number;
  mode?: 'json' | 'text';
  ttlSeconds?: number;
};

export type PutPayloadChunkResult = {
  payloadId: string;
  payloadRef: string;
  index: number;
  receivedChunks: number;
  totalChunks: number;
  complete: boolean;
  expiresAt: string;
  bytes?: number;
  sha256?: string;
};

const store = new Map<string, StoredPayload>();

function payloadIdFromRef(ref: string): string {
  return ref.startsWith(REF_PREFIX) ? ref.slice(REF_PREFIX.length) : ref;
}

function payloadRef(payloadId: string): string {
  return `${REF_PREFIX}${payloadId}`;
}

function pruneExpired(now = Date.now()): void {
  for (const [id, entry] of store.entries()) {
    if (entry.expiresAt <= now) store.delete(id);
  }
}

function assertReasonablePayload(entry: StoredPayload): void {
  const byteLength = Buffer.byteLength(entry.chunks.join(''), 'utf8');
  if (byteLength > MAX_PAYLOAD_BYTES) throw new Error(`payload too large: ${byteLength} bytes`);
}

function payloadText(ref: string): string {
  pruneExpired();
  const id = payloadIdFromRef(ref);
  const entry = store.get(id);
  if (!entry) throw new Error(`unknown or expired payloadRef: ${ref}`);
  if (entry.chunks.filter((chunk) => chunk !== undefined).length !== entry.totalChunks) {
    throw new Error(`payloadRef is incomplete: ${ref}`);
  }
  return entry.chunks.join('');
}

export function putPayloadChunk(input: PutPayloadChunkInput): PutPayloadChunkResult {
  pruneExpired();
  if (typeof input.chunk !== 'string') throw new Error('chunk must be a string');

  const payloadId = payloadIdFromRef(input.payloadRef ?? input.payloadId ?? randomUUID());
  const index = input.index ?? 0;
  const totalChunks = input.totalChunks ?? 1;
  const mode = input.mode ?? 'json';
  const ttlMs = Math.max(1, input.ttlSeconds ?? DEFAULT_TTL_MS / 1000) * 1000;

  if (!Number.isInteger(index) || index < 0) throw new Error('index must be a non-negative integer');
  if (!Number.isInteger(totalChunks) || totalChunks < 1 || totalChunks > MAX_CHUNKS) {
    throw new Error(`totalChunks must be between 1 and ${MAX_CHUNKS}`);
  }
  if (index >= totalChunks) throw new Error('index must be less than totalChunks');

  const now = Date.now();
  const existing = store.get(payloadId);
  const entry = existing ?? {
    chunks: new Array(totalChunks),
    totalChunks,
    mode,
    createdAt: now,
    expiresAt: now + ttlMs
  };

  if (entry.totalChunks !== totalChunks) throw new Error('totalChunks does not match existing payload');
  if (entry.mode !== mode) throw new Error('mode does not match existing payload');

  entry.chunks[index] = input.chunk;
  entry.expiresAt = Math.max(entry.expiresAt, now + ttlMs);
  assertReasonablePayload(entry);
  store.set(payloadId, entry);

  const receivedChunks = entry.chunks.filter((chunk) => chunk !== undefined).length;
  const complete = receivedChunks === entry.totalChunks;
  const text = complete ? entry.chunks.join('') : undefined;

  return {
    payloadId,
    payloadRef: payloadRef(payloadId),
    index,
    receivedChunks,
    totalChunks: entry.totalChunks,
    complete,
    expiresAt: new Date(entry.expiresAt).toISOString(),
    bytes: text === undefined ? undefined : Buffer.byteLength(text, 'utf8')
  };
}

export function getPayloadTextFromStore(ref: string): string {
  return payloadText(ref);
}

export function getPayloadFromStore(ref: string): unknown {
  const text = payloadText(ref).trim();
  if (/^0x[0-9a-fA-F]+$/.test(text)) return text;
  return JSON.parse(text);
}

export function clearPayloadStore(): void {
  store.clear();
}
