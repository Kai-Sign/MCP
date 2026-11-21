#!/usr/bin/env node
/**
 * KaiSign Wallet RPC — a clear-signing approval gateway in front of the Nethermind
 * light client (NethermindEth/nethermind PR #14457).
 *
 *   wallet (MetaMask, Rabby, Frame, ethers, viem …)
 *        │  RPC URL http://127.0.0.1:8546
 *        ▼
 *   KaiSign Wallet RPC ── eth_sendRawTransaction is held, clear-signed and shown
 *        │                 for one-click approval (browser, terminal, or auto for SAFE)
 *        ▼
 *   Nethermind light client http://127.0.0.1:8545 (verified reads, P2P relay)
 *
 * Every other request is forwarded unchanged, except that block tags the light
 * client refuses (`pending`, `safe`) are mapped to the closest verified tag so
 * ordinary wallets work without a custom nonce manager.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import QRCode from 'qrcode';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { Transaction, formatEther, formatUnits } from 'ethers';
import { clearSignTransaction } from './tools/clear-sign-transaction.js';
import { formatPlain } from './cli.js';
import { lightClients, parseLightClientConfig } from './services/light-client.js';
import { ActivationManager, feeConfigFromEnv } from './services/activation.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export type Verdict = 'safe' | 'review' | 'reject';

export interface ClearSignView {
  verdict: Verdict;
  reason: string;
  intent: string;
  /** Same multi-line text the `kaisign clear-sign` CLI prints */
  text: string;
  warnings: string[];
}

export interface TxSummary {
  hash: string;
  from: string;
  to: string | null;
  value: string;
  nonce: number;
  chainId: number;
  gasLimit: string;
  maxFeePerGas?: string;
  dataBytes: number;
}

export type ApprovalStatus = 'waiting' | 'approved' | 'rejected' | 'broadcast' | 'failed';

export interface Approval {
  id: string;
  createdAt: number;
  status: ApprovalStatus;
  decidedBy?: 'browser' | 'terminal' | 'auto' | 'api' | 'timeout' | 'wallet-disconnected';
  result?: string;
  tx: TxSummary;
  clearSign: ClearSignView;
}

export interface WalletRpcOptions {
  /** Light client JSON-RPC URL (default http://127.0.0.1:8545) */
  upstream: string;
  host?: string;
  port?: number;
  /** 'safe' broadcasts SAFE (fully decoded + registry-attested) transactions without a click */
  autoApprove?: 'none' | 'safe';
  approvalTimeoutMs?: number;
  /** Map `pending`→`latest` and `safe`→`finalized` (the light client rejects both) */
  rewriteBlockTags?: boolean;
  clearSign?: (tx: Transaction, chainId: number) => Promise<ClearSignView>;
  log?: (message: string) => void;
  /** Called when a transaction needs a human decision */
  onPending?: (approval: Approval) => void;
  token?: string;
  /**
   * Remote mode (VPS / tailnet): secrets in the URL path replace the loopback-only rule.
   * Wallet URL: /rpc/<rpcToken>; owner approval page: /a/<approvalKey>/.
   * A leaked wallet URL can read and queue transactions but never approve them.
   */
  remote?: { rpcToken: string; approvalKey: string };
  /** Optional on-chain activation fee; RPC stays closed until it is paid */
  activation?: ActivationManager;
}

/** Minimum secret length for remote mode: 128 bits as hex. */
export const MIN_SECRET_LENGTH = 32;

function secretEquals(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Methods a wallet needs to add the network before the node is activated. */
const PRE_ACTIVATION_METHODS = new Set(['eth_chainId', 'net_version', 'web3_clientVersion']);
export const NOT_ACTIVATED = -32002;

type JsonRpcId = string | number | null;
interface JsonRpcRequest { jsonrpc?: string; id?: JsonRpcId; method?: unknown; params?: unknown }
interface JsonRpcResponse { jsonrpc: '2.0'; id: JsonRpcId; result?: unknown; error?: { code: number; message: string; data?: unknown } }

// ─── Constants ──────────────────────────────────────────────────────────────

const MAX_BODY_BYTES = 5 * 1024 * 1024; // light client allows 4 MiB + 64 KiB for raw tx / call bodies
const UPSTREAM_TIMEOUT_MS = 95_000;     // light client deadline is 90 s per request
const HISTORY_LIMIT = 25;
/** A relayed tx that never lands must not leave wallets on a nonce gap forever. */
const LOCAL_NONCE_TTL_MS = 15 * 60_000;

/** EIP-1193 "user rejected the request" — wallets show this as a normal cancel. */
export const USER_REJECTED = 4001;

const BLOCK_PARAM_INDEX: Record<string, number> = {
  eth_getBalance: 1,
  eth_getCode: 1,
  eth_getTransactionCount: 1,
  eth_getStorageAt: 2,
  eth_call: 1,
  eth_estimateGas: 1,
  eth_getProof: 2,
  eth_feeHistory: 1,
  eth_getBlockByNumber: 0,
  eth_getBlockTransactionCountByNumber: 0,
  eth_getTransactionByBlockNumberAndIndex: 0,
  eth_getBlockReceipts: 0
};

const TAG_REWRITE: Record<string, string> = { pending: 'latest', safe: 'finalized' };

function nativeSymbol(chainId: number): string {
  return chainId === 100 ? 'xDAI' : 'ETH';
}

// ─── Clear signing ──────────────────────────────────────────────────────────

export async function defaultClearSign(tx: Transaction, chainId: number): Promise<ClearSignView> {
  const symbol = nativeSymbol(chainId);
  const value = `${formatEther(tx.value)} ${symbol}`;

  if (!tx.to) {
    const bytes = (tx.data.length - 2) / 2;
    return {
      verdict: 'review',
      reason: 'contract deployment: init code cannot be clear-signed',
      intent: `Deploy a contract (${bytes} bytes of init code)${tx.value > 0n ? `, sending ${value}` : ''}`,
      text: `KaiSign clear-sign\nVerdict:  REVIEW — contract deployment\nIntent: Deploy a contract (${bytes} bytes of init code)\nValue: ${value}\n`,
      warnings: []
    };
  }

  if (!tx.data || tx.data === '0x') {
    return {
      verdict: 'review',
      reason: 'plain value transfer: no calldata, confirm the recipient',
      intent: `Send ${value} to ${tx.to}`,
      text: `KaiSign clear-sign\nVerdict:  REVIEW — plain value transfer\nIntent: Send ${value} to ${tx.to}\n`,
      warnings: []
    };
  }

  try {
    const result = await clearSignTransaction({ to: tx.to, data: tx.data, chainId, value: tx.value.toString() });
    const verdict: Verdict = result.signing?.verdict ?? (result.safeToSign ? 'safe' : 'review');
    return {
      verdict,
      reason: result.signing?.reason ?? (result.safeToSign ? 'fully clear-signed' : 'not fully clear-signed'),
      intent: String(result.aggregatedIntent || result.intent || 'Unknown transaction'),
      text: formatPlain(result as unknown as Record<string, unknown>),
      warnings: result.warnings ?? []
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      verdict: 'reject',
      reason: `could not clear-sign: ${message}`,
      intent: `Unknown call to ${tx.to}`,
      text: `KaiSign clear-sign\nVerdict:  REJECT — could not clear-sign: ${message}\n`,
      warnings: [message]
    };
  }
}

export function summarizeTransaction(tx: Transaction): TxSummary {
  return {
    hash: tx.hash ?? '',
    from: tx.from ?? '',
    to: tx.to,
    value: tx.value.toString(),
    nonce: tx.nonce,
    chainId: Number(tx.chainId),
    gasLimit: tx.gasLimit.toString(),
    maxFeePerGas: (tx.maxFeePerGas ?? tx.gasPrice)?.toString(),
    dataBytes: (tx.data.length - 2) / 2
  };
}

// ─── Request helpers ────────────────────────────────────────────────────────

function isLoopbackHost(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  let hostname: string;
  try {
    hostname = new URL(`http://${hostHeader}`).hostname;
  } catch {
    return false;
  }
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1';
}

function isExtensionOrigin(origin: string): boolean {
  return /^(chrome-extension|moz-extension|safari-web-extension|ms-browser-extension):\/\//.test(origin);
}

function isSelfOrigin(origin: string, hostHeader: string | undefined, remote = false): boolean {
  if (!hostHeader) return false;
  try {
    const o = new URL(origin);
    if (remote) return (o.protocol === 'https:' || o.protocol === 'http:') && o.host === hostHeader;
    return o.protocol === 'http:' && o.host === hostHeader && isLoopbackHost(o.host);
  } catch {
    return false;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function rpcError(id: JsonRpcId | undefined, code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, error: data === undefined ? { code, message } : { code, message, data } };
}

function rewriteTag(value: unknown): unknown {
  return typeof value === 'string' && TAG_REWRITE[value] ? TAG_REWRITE[value] : value;
}

/** Map block tags the light client refuses onto the nearest verified tag. */
export function rewriteBlockTags(method: string, params: unknown): unknown {
  if (!Array.isArray(params)) return params;
  const out = [...params];
  if (method === 'eth_getLogs' && out[0] && typeof out[0] === 'object') {
    const filter = { ...(out[0] as Record<string, unknown>) };
    if ('fromBlock' in filter) filter.fromBlock = rewriteTag(filter.fromBlock);
    if ('toBlock' in filter) filter.toBlock = rewriteTag(filter.toBlock);
    out[0] = filter;
    return out;
  }
  const index = BLOCK_PARAM_INDEX[method];
  if (index !== undefined && index < out.length) out[index] = rewriteTag(out[index]);
  return out;
}

// ─── Gateway ────────────────────────────────────────────────────────────────

interface Waiter {
  resolve: (decision: { approve: boolean; by: NonNullable<Approval['decidedBy']>; reason?: string }) => void;
}

export class WalletRpcGateway {
  readonly token: string;
  readonly server: Server;
  private readonly options: Required<Omit<WalletRpcOptions, 'onPending' | 'token' | 'host' | 'port' | 'remote' | 'activation'>> & Pick<WalletRpcOptions, 'onPending' | 'remote' | 'activation'>;
  private readonly approvals = new Map<string, Approval>();
  private readonly waiters = new Map<string, Waiter>();
  /** sender → next nonce after the highest transaction this gateway relayed */
  private readonly localNonces = new Map<string, { next: number; at: number }>();
  private nextId = 1;
  private chainIdPromise?: Promise<number>;

  constructor(options: WalletRpcOptions) {
    if (options.remote) {
      for (const [name, value] of Object.entries(options.remote)) {
        if (!/^[A-Za-z0-9_-]+$/.test(value) || value.length < MIN_SECRET_LENGTH) {
          throw new Error(`remote ${name} must be at least ${MIN_SECRET_LENGTH} URL-safe characters`);
        }
      }
      if (options.remote.rpcToken === options.remote.approvalKey) throw new Error('rpcToken and approvalKey must differ');
    }
    this.token = options.remote?.approvalKey ?? options.token ?? randomBytes(24).toString('hex');
    this.options = {
      remote: options.remote,
      activation: options.activation,
      upstream: options.upstream,
      autoApprove: options.autoApprove ?? 'none',
      approvalTimeoutMs: options.approvalTimeoutMs ?? 5 * 60_000,
      rewriteBlockTags: options.rewriteBlockTags ?? true,
      clearSign: options.clearSign ?? defaultClearSign,
      log: options.log ?? ((message: string) => console.error(message)),
      onPending: options.onPending
    };
    this.server = createServer((req, res) => {
      this.handle(req, res).catch(error => {
        this.options.log(`[wallet-rpc] request failed: ${error instanceof Error ? error.message : String(error)}`);
        if (!res.headersSent) this.sendJson(req, res, 500, rpcError(null, -32603, 'internal error'));
        else res.end();
      });
    });
  }

  listen(port: number, host = '127.0.0.1'): Promise<{ port: number; host: string }> {
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        const address = this.server.address();
        resolve({ port: typeof address === 'object' && address ? address.port : port, host });
      });
    });
  }

  close(): Promise<void> {
    for (const id of [...this.waiters.keys()]) this.decide(id, false, 'api', 'gateway shutting down');
    return new Promise(resolve => this.server.close(() => resolve()));
  }

  list(): { pending: Approval[]; recent: Approval[] } {
    const all = [...this.approvals.values()];
    return {
      pending: all.filter(a => a.status === 'waiting'),
      recent: all.filter(a => a.status !== 'waiting').sort((a, b) => b.createdAt - a.createdAt).slice(0, HISTORY_LIMIT)
    };
  }

  /** Resolve a waiting approval. Returns false when it is unknown or already decided. */
  decide(id: string, approve: boolean, by: NonNullable<Approval['decidedBy']>, reason?: string): boolean {
    const waiter = this.waiters.get(id);
    if (!waiter) return false;
    this.waiters.delete(id);
    waiter.resolve({ approve, by, reason });
    return true;
  }

  /** Oldest waiting approval, for single-key terminal decisions. */
  oldestPending(): Approval | undefined {
    return this.list().pending.sort((a, b) => a.createdAt - b.createdAt)[0];
  }

  // ── upstream ──

  private async upstream(body: unknown): Promise<JsonRpcResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    try {
      const response = await fetch(this.options.upstream, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
      const text = await response.text();
      try {
        return JSON.parse(text) as JsonRpcResponse;
      } catch {
        return rpcError((body as JsonRpcRequest).id, -32603, `light client returned HTTP ${response.status}: ${text.slice(0, 200)}`);
      }
    } catch (error) {
      return rpcError((body as JsonRpcRequest).id, -32603, `light client unreachable at ${this.options.upstream}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      clearTimeout(timer);
    }
  }

  private chainId(): Promise<number> {
    if (!this.chainIdPromise) {
      this.chainIdPromise = this.upstream({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }).then(r => {
        if (typeof r.result !== 'string') throw new Error(r.error?.message ?? 'eth_chainId failed');
        return Number(BigInt(r.result));
      });
      this.chainIdPromise.catch(() => { this.chainIdPromise = undefined; });
    }
    return this.chainIdPromise;
  }

  // ── JSON-RPC ──

  private async handleItem(item: unknown, res: ServerResponse): Promise<JsonRpcResponse | undefined> {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof (item as JsonRpcRequest).method !== 'string') {
      return rpcError((item as JsonRpcRequest | undefined)?.id, -32600, 'Invalid Request');
    }
    const request = item as JsonRpcRequest & { method: string };
    const isNotification = !('id' in request);

    const activation = this.options.activation;
    if (activation && !activation.active && !PRE_ACTIVATION_METHODS.has(request.method)) {
      return isNotification ? undefined : rpcError(request.id, NOT_ACTIVATED,
        'KaiSign node not activated yet: open your approval page and pay the one-time setup fee');
    }

    if (request.method === 'eth_sendRawTransaction') {
      const response = await this.handleSend(request, res);
      return isNotification ? undefined : response;
    }

    let params = request.params;
    let pendingNonceFor: string | undefined;
    if (this.options.rewriteBlockTags) {
      if (request.method === 'eth_getTransactionCount' && Array.isArray(params) && params[1] === 'pending' && typeof params[0] === 'string') {
        pendingNonceFor = params[0].toLowerCase();
      }
      params = rewriteBlockTags(request.method, params);
    }

    const response = await this.upstream({ ...request, jsonrpc: '2.0', params });
    if (pendingNonceFor && typeof response.result === 'string') {
      const confirmed = Number(BigInt(response.result));
      const local = this.localNonces.get(pendingNonceFor);
      if (local !== undefined) {
        if (local.next <= confirmed || Date.now() - local.at > LOCAL_NONCE_TTL_MS) this.localNonces.delete(pendingNonceFor);
        else response.result = '0x' + local.next.toString(16);
      }
    }
    if (response && !isNotification) response.id = request.id ?? null;
    return isNotification ? undefined : response;
  }

  private async handleSend(request: JsonRpcRequest, res: ServerResponse): Promise<JsonRpcResponse> {
    const raw = Array.isArray(request.params) ? request.params[0] : undefined;
    if (typeof raw !== 'string') return rpcError(request.id, -32602, 'eth_sendRawTransaction expects a hex-encoded signed transaction');

    let tx: Transaction;
    try {
      tx = Transaction.from(raw);
      if (!tx.from) throw new Error('transaction is not signed');
    } catch (error) {
      return rpcError(request.id, -32602, `invalid raw transaction: ${error instanceof Error ? error.message : String(error)}`);
    }

    let chainId: number;
    try {
      chainId = await this.chainId();
    } catch (error) {
      return rpcError(request.id, -32603, `light client not ready: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (tx.chainId !== 0n && Number(tx.chainId) !== chainId) {
      return rpcError(request.id, -32000, `transaction is for chain ${tx.chainId} but this RPC serves chain ${chainId}`);
    }

    const approval: Approval = {
      id: String(this.nextId++),
      createdAt: Date.now(),
      status: 'waiting',
      tx: summarizeTransaction(tx),
      clearSign: await this.options.clearSign(tx, chainId)
    };
    this.approvals.set(approval.id, approval);
    this.prune();

    const decision = await this.awaitDecision(approval, res);
    approval.decidedBy = decision.by;

    if (!decision.approve) {
      approval.status = 'rejected';
      approval.result = decision.reason ?? 'rejected';
      this.options.log(`[wallet-rpc] #${approval.id} rejected (${decision.by}${decision.reason ? `: ${decision.reason}` : ''})`);
      return rpcError(request.id, USER_REJECTED, `KaiSign: transaction rejected${decision.reason ? ` (${decision.reason})` : ''}`);
    }

    approval.status = 'approved';
    const response = await this.upstream({ jsonrpc: '2.0', id: request.id ?? null, method: 'eth_sendRawTransaction', params: [raw] });
    if (response.error) {
      approval.status = 'failed';
      approval.result = response.error.message;
      this.options.log(`[wallet-rpc] #${approval.id} approved but the light client refused it: ${response.error.message}`);
    } else {
      approval.status = 'broadcast';
      approval.result = String(response.result);
      const sender = tx.from!.toLowerCase();
      this.localNonces.set(sender, { next: Math.max(this.localNonces.get(sender)?.next ?? 0, tx.nonce + 1), at: Date.now() });
      this.options.log(`[wallet-rpc] #${approval.id} approved (${decision.by}) and relayed: ${response.result}`);
    }
    response.id = request.id ?? null;
    return response;
  }

  private awaitDecision(approval: Approval, res: ServerResponse): Promise<{ approve: boolean; by: NonNullable<Approval['decidedBy']>; reason?: string }> {
    if (this.options.autoApprove === 'safe' && approval.clearSign.verdict === 'safe') {
      return Promise.resolve({ approve: true, by: 'auto' });
    }

    return new Promise(resolve => {
      const timer = setTimeout(() => this.decide(approval.id, false, 'timeout', 'approval timed out'), this.options.approvalTimeoutMs);
      // If the wallet gives up on the request, never broadcast behind its back.
      const onClose = () => {
        if (!res.writableEnded) this.decide(approval.id, false, 'wallet-disconnected', 'wallet closed the request before approval');
      };
      res.once('close', onClose);
      this.waiters.set(approval.id, {
        resolve: decision => {
          clearTimeout(timer);
          res.off('close', onClose);
          resolve(decision);
        }
      });
      this.options.onPending?.(approval);
    });
  }

  private prune(): void {
    const decided = [...this.approvals.values()].filter(a => a.status !== 'waiting').sort((a, b) => b.createdAt - a.createdAt);
    for (const old of decided.slice(HISTORY_LIMIT)) this.approvals.delete(old.id);
  }

  // ── HTTP ──

  private corsHeaders(req: IncomingMessage): Record<string, string> {
    const origin = req.headers.origin;
    if (origin && isExtensionOrigin(origin)) {
      return {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        Vary: 'Origin'
      };
    }
    return {};
  }

  private sendJson(req: IncomingMessage, res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...this.corsHeaders(req) });
    res.end(JSON.stringify(body));
  }

  /** Map a request path onto the RPC endpoint or the owner UI, checking path secrets. */
  private route(pathname: string): { kind: 'rpc' } | { kind: 'ui'; sub: string } | undefined {
    const remote = this.options.remote;
    if (!remote) {
      if (pathname === '/' || pathname === '/rpc') return pathname === '/rpc' ? { kind: 'rpc' } : { kind: 'ui', sub: '/' };
      return { kind: 'ui', sub: pathname };
    }
    const [, head, secret, ...rest] = pathname.split('/');
    if (head === 'rpc' && secret && rest.length === 0 && secretEquals(secret, remote.rpcToken)) return { kind: 'rpc' };
    if (head === 'a' && secret && secretEquals(secret, remote.approvalKey)) return { kind: 'ui', sub: '/' + rest.join('/') };
    return undefined;
  }

  private uiBase(): string {
    return this.options.remote ? `/a/${this.options.remote.approvalKey}` : '';
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/healthz') {
      this.sendJson(req, res, 200, { ok: true });
      return;
    }

    // Local mode follows the light client's exposure rules: loopback Host only (blocks DNS
    // rebinding). Remote mode is reached through a tailnet/VPN name and relies on path secrets.
    if (!this.options.remote && !isLoopbackHost(req.headers.host)) {
      res.writeHead(403).end('non-loopback Host header refused');
      return;
    }
    // Wallet extensions and non-browser callers allowed, ordinary websites refused.
    const origin = req.headers.origin;
    const selfOrigin = origin ? isSelfOrigin(origin, req.headers.host, Boolean(this.options.remote)) : false;
    if (origin && !isExtensionOrigin(origin) && !selfOrigin) {
      res.writeHead(403).end('origin not allowed');
      return;
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, this.corsHeaders(req)).end();
      return;
    }

    // A POST to "/" is the classic local wallet URL; remote mode only accepts /rpc/<token>.
    const target = !this.options.remote && req.method === 'POST' && url.pathname === '/' ? { kind: 'rpc' as const } : this.route(url.pathname);
    if (!target) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      return;
    }

    if (target.kind === 'rpc') {
      if (req.method !== 'POST') {
        res.writeHead(405, { Allow: 'POST', 'Content-Type': 'text/plain' }).end('JSON-RPC needs POST');
        return;
      }
      await this.handleRpc(req, res);
      return;
    }

    const sub = target.sub;
    if (req.method === 'GET' && sub === '/') {
      this.sendPage(res);
      return;
    }

    // Owner API: the approval page only, never wallet extensions or websites.
    const ownerRequest = (!origin || selfOrigin) && secretEquals(String(req.headers['x-kaisign-token'] ?? ''), this.token);

    if (req.method === 'GET' && sub === '/activation/qr.svg') {
      // <img> requests cannot carry the token header; in remote mode the path secret already
      // authenticated this request, and the QR only encodes the public payment request.
      const status = this.options.activation?.status();
      if (!status?.links || (!this.options.remote && !ownerRequest && origin)) {
        res.writeHead(404).end();
        return;
      }
      const svg = await QRCode.toString(status.links.eip681, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' }).end(svg);
      return;
    }

    if (!ownerRequest) {
      this.sendJson(req, res, 403, { error: 'owner API needs the approval page token' });
      return;
    }

    if (req.method === 'GET' && sub === '/status') {
      await this.sendStatus(req, res);
      return;
    }
    if (req.method === 'GET' && sub === '/activation') {
      this.sendJson(req, res, 200, this.options.activation?.status() ?? { required: false, active: true });
      return;
    }
    if (req.method === 'GET' && sub === '/approvals') {
      this.sendJson(req, res, 200, this.list());
      return;
    }
    const match = /^\/approvals\/([^/]+)\/(approve|reject)$/.exec(sub);
    if (req.method === 'POST' && match) {
      const ok = this.decide(match[1], match[2] === 'approve', 'browser', match[2] === 'reject' ? 'rejected in browser' : undefined);
      this.sendJson(req, res, ok ? 200 : 404, { ok });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
  }

  private async handleRpc(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readBody(req));
    } catch (error) {
      const tooLarge = error instanceof Error && error.message.includes('too large');
      this.sendJson(req, res, tooLarge ? 413 : 400, rpcError(null, tooLarge ? -32600 : -32700, tooLarge ? 'request body too large' : 'Parse error'));
      return;
    }

    if (Array.isArray(parsed)) {
      if (parsed.length === 0) {
        this.sendJson(req, res, 200, rpcError(null, -32600, 'empty batch'));
        return;
      }
      const responses = (await Promise.all(parsed.map(item => this.handleItem(item, res)))).filter(Boolean);
      if (res.writableEnded || res.destroyed) return;
      if (responses.length === 0) res.writeHead(204, this.corsHeaders(req)).end();
      else this.sendJson(req, res, 200, responses);
      return;
    }

    const response = await this.handleItem(parsed, res);
    if (res.writableEnded || res.destroyed) return;
    if (!response) res.writeHead(204, this.corsHeaders(req)).end();
    else this.sendJson(req, res, 200, response);
  }

  private async sendStatus(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let lightClient: unknown = null;
    try {
      const statusUrl = new URL('/status', this.options.upstream);
      const response = await fetch(statusUrl, { signal: AbortSignal.timeout(5000) });
      lightClient = await response.json();
    } catch (error) {
      lightClient = { error: error instanceof Error ? error.message : String(error) };
    }
    let chainId: number | null = null;
    try { chainId = await this.chainId(); } catch { /* reported via lightClient */ }
    this.sendJson(req, res, 200, {
      gateway: 'kaisign-wallet-rpc',
      upstream: this.options.upstream,
      chainId,
      autoApprove: this.options.autoApprove,
      pending: this.list().pending.length,
      walletRpcPath: this.options.remote ? `/rpc/${this.options.remote.rpcToken}` : '/',
      activation: this.options.activation?.status() ?? { required: false, active: true },
      lightClient
    });
  }

  private sendPage(res: ServerResponse): void {
    const nonce = randomBytes(16).toString('base64');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      // The page holds the approval token: never let another site frame or script it.
      'X-Frame-Options': 'DENY',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'`,
      'Referrer-Policy': 'no-referrer'
    });
    res.end(approvalPage(nonce, this.token, this.uiBase()));
  }
}

// ─── Approval page ──────────────────────────────────────────────────────────

function approvalPage(nonce: string, token: string, base: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>KaiSign Approvals</title>
<style>
  :root { --bg:#f6f7f9; --card:#fff; --text:#16181d; --muted:#5d6470; --line:#e2e5ea;
          --safe:#11845b; --review:#b36b00; --reject:#c62828; --btn:#16181d; --btn-text:#fff; }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0f1115; --card:#181b21; --text:#eceef2; --muted:#9aa1ad; --line:#2a2f38;
            --safe:#3ccf8e; --review:#f0a83a; --reject:#ff6b6b; --btn:#eceef2; --btn-text:#0f1115; }
  }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--bg); color:var(--text); font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { max-width:760px; margin:0 auto; padding:24px 16px 64px; }
  h1 { font-size:20px; margin:0 0 4px; }
  .muted { color:var(--muted); font-size:13px; overflow-wrap:anywhere; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:16px; margin-top:16px; }
  .badge { display:inline-block; font-weight:700; font-size:12px; letter-spacing:.04em; padding:2px 8px; border-radius:999px; border:1.5px solid currentColor; }
  .safe { color:var(--safe); } .review { color:var(--review); } .reject { color:var(--reject); }
  .intent { font-size:19px; font-weight:600; margin:10px 0 6px; overflow-wrap:anywhere; }
  dl { display:grid; grid-template-columns:max-content 1fr; gap:2px 12px; margin:10px 0; font-size:13px; }
  dt { color:var(--muted); } dd { margin:0; font-family:ui-monospace,Menlo,monospace; overflow-wrap:anywhere; }
  details pre { white-space:pre-wrap; overflow-wrap:anywhere; font:12px/1.45 ui-monospace,Menlo,monospace; background:var(--bg); padding:10px; border-radius:8px; }
  .actions { display:flex; gap:10px; margin-top:14px; }
  button { flex:1; font:600 16px system-ui,sans-serif; padding:14px; border-radius:10px; cursor:pointer; border:1.5px solid var(--btn); }
  .approve { background:var(--btn); color:var(--btn-text); }
  .approve.risky { background:var(--reject); border-color:var(--reject); color:#fff; }
  .rejectbtn { background:transparent; color:var(--text); }
  .empty { text-align:center; padding:28px 16px; color:var(--muted); }
  .row { display:flex; justify-content:space-between; gap:8px; flex-wrap:wrap; font-size:13px; padding:6px 0; border-top:1px solid var(--line); }
  .row:first-child { border-top:0; }
  code { font-family:ui-monospace,Menlo,monospace; font-size:13px; }
  .warn { color:var(--reject); font-size:13px; margin:4px 0 0; }
  .pay h2, .wallet h2 { font-size:17px; margin:0 0 6px; }
  .amount { font-size:28px; font-weight:700; margin:6px 0 2px; overflow-wrap:anywhere; }
  .stack { display:flex; flex-direction:column; gap:10px; margin-top:14px; }
  a.btn { display:block; text-align:center; text-decoration:none; font:600 16px system-ui,sans-serif; padding:14px; border-radius:10px; border:1.5px solid var(--btn); color:var(--text); }
  a.btn.primary, button.primary { background:var(--btn); color:var(--btn-text); }
  .qr { display:block; width:200px; max-width:100%; margin:14px auto 4px; background:#fff; padding:8px; border-radius:8px; }
  .copy { display:flex; gap:8px; align-items:center; margin-top:8px; }
  .copy code { flex:1; background:var(--bg); padding:8px; border-radius:8px; overflow-wrap:anywhere; font-size:12px; }
  .copy button { flex:0 0 auto; padding:8px 12px; font-size:14px; }
  .ok { color:var(--safe); font-weight:600; }
</style>
</head>
<body>
<main>
  <h1>KaiSign approvals</h1>
  <div class="muted" id="conn">Connecting…</div>
  <div id="activation"></div>
  <div id="pending"></div>
  <div id="wallet"></div>
  <div class="card"><strong>Recent</strong><div id="recent" class="muted">None yet.</div></div>
</main>
<script nonce="${nonce}">
const TOKEN = ${JSON.stringify(token)};
const BASE = ${JSON.stringify(base)};
const H = { headers:{ 'X-KaiSign-Token': TOKEN } };
const $ = (tag, cls, text) => { const el = document.createElement(tag); if (cls) el.className = cls; if (text !== undefined) el.textContent = text; return el; };
const sym = id => id === 100 ? 'xDAI' : 'ETH';
const fmtWei = (wei, id) => { try { const v = BigInt(wei); const whole = v / 10n**18n; const frac = (v % 10n**18n).toString().padStart(18,'0').replace(/0+$/,''); return whole + (frac ? '.' + frac : '') + ' ' + sym(id); } catch { return wei; } };
const gwei = wei => { try { return (Number(BigInt(wei)) / 1e9).toFixed(2) + ' gwei'; } catch { return wei; } };
let shown = '';

async function decide(id, action, risky) {
  if (action === 'approve' && risky && !confirm('KaiSign could NOT clear-sign this transaction. Broadcast it anyway?')) return;
  await fetch(BASE + '/approvals/' + encodeURIComponent(id) + '/' + action, { method:'POST', headers:{ 'X-KaiSign-Token': TOKEN } });
  refresh();
}

function card(a) {
  const c = $('div', 'card');
  const v = a.clearSign.verdict;
  c.append($('span', 'badge ' + v, v.toUpperCase()), $('span', 'muted', '  #' + a.id + ' · ' + a.clearSign.reason));
  c.append($('div', 'intent', a.clearSign.intent));
  for (const w of a.clearSign.warnings || []) c.append($('p', 'warn', '⚠ ' + w));
  const dl = $('dl');
  const add = (k, val) => { dl.append($('dt', '', k), $('dd', '', val)); };
  add('From', a.tx.from); add('To', a.tx.to || '(contract creation)'); add('Value', fmtWei(a.tx.value, a.tx.chainId));
  add('Chain', String(a.tx.chainId)); add('Nonce', String(a.tx.nonce)); add('Gas limit', a.tx.gasLimit);
  if (a.tx.maxFeePerGas) add('Max fee', gwei(a.tx.maxFeePerGas));
  add('Tx hash', a.tx.hash);
  c.append(dl);
  const det = $('details'); det.append($('summary', 'muted', 'Full clear-sign report'), $('pre', '', a.clearSign.text)); c.append(det);
  const act = $('div', 'actions');
  const risky = v === 'reject';
  const ok = $('button', 'approve' + (risky ? ' risky' : ''), risky ? 'Approve anyway' : 'Approve & send');
  const no = $('button', 'rejectbtn', 'Reject');
  ok.onclick = () => decide(a.id, 'approve', risky);
  no.onclick = () => decide(a.id, 'reject', false);
  act.append(ok, no); c.append(act);
  return c;
}

function copyRow(text) {
  const row = $('div', 'copy'); const code = $('code', '', text); const b = $('button', '', 'Copy');
  b.onclick = async () => { try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; setTimeout(() => b.textContent = 'Copy', 1500); } catch {} };
  row.append(code, b); return row;
}

/** ERC-20 transfer(recipient, amount) calldata */
function transferData(to, units) {
  return '0xa9059cbb' + to.slice(2).toLowerCase().padStart(64, '0') + BigInt(units).toString(16).padStart(64, '0');
}

async function payInBrowser(a, btn) {
  try {
    btn.textContent = 'Check your wallet…';
    const [from] = await window.ethereum.request({ method:'eth_requestAccounts' });
    try { await window.ethereum.request({ method:'wallet_switchEthereumChain', params:[{ chainId:'0x' + a.chainId.toString(16) }] }); } catch {}
    await window.ethereum.request({ method:'eth_sendTransaction', params:[{ from, to:a.token, data:transferData(a.recipient, a.amountUnits) }] });
    btn.textContent = 'Sent — waiting for confirmation…';
  } catch (e) { btn.textContent = 'Pay with this browser wallet'; alert(e.message || e); }
}

let activationKey = '';
function renderActivation(a) {
  const box = document.getElementById('activation');
  const key = JSON.stringify([a.required, a.active, a.amountUnits, a.error && !a.amountUnits]);
  if (!a.required || (a.active && activationKey === key)) { if (!a.required) box.replaceChildren(); return; }
  if (activationKey === key) { const s = document.getElementById('scan'); if (s && a.scannedTo) s.textContent = 'Watching the chain for your payment… (block ' + a.scannedTo + ')'; return; }
  activationKey = key;
  const c = $('div', 'card pay');
  if (a.active) {
    c.append($('h2', 'ok', '✓ Node activated'), $('div', 'muted', 'Payment ' + a.activated.txHash.slice(0, 10) + '…' + a.activated.txHash.slice(-8) + ' verified by your own light client.'));
    box.replaceChildren(c); return;
  }
  c.append($('h2', '', 'Activate your KaiSign node'));
  if (!a.amountUnits) { c.append($('div', 'muted', 'Preparing payment request: ' + (a.error || 'waiting for the light client to sync…'))); box.replaceChildren(c); return; }
  c.append($('div', 'muted', 'One-time setup fee, paid on ' + a.chainName + '. Send exactly:'));
  c.append($('div', 'amount', a.amount + ' ' + a.symbol));
  c.append($('div', 'muted', 'The last digits identify this node. Your node verifies the payment itself — no payment processor, no account.'));
  const st = $('div', 'stack');
  if (window.ethereum) {
    const b = $('button', 'primary', 'Pay with this browser wallet'); b.onclick = () => payInBrowser(a, b); st.append(b);
  }
  const mm = $('a', 'btn' + (window.ethereum ? '' : ' primary'), 'Pay in MetaMask app'); mm.href = a.links.metamask; st.append(mm);
  const any = $('a', 'btn', 'Pay with another wallet app'); any.href = a.links.eip681; st.append(any);
  c.append(st);
  const qr = $('img', 'qr'); qr.src = BASE + '/activation/qr.svg'; qr.alt = 'Payment QR code'; c.append(qr);
  c.append($('div', 'muted', 'Or scan with a wallet on another phone.'));
  const det = $('details'); det.append($('summary', 'muted', 'Pay manually'));
  det.append($('div', 'muted', 'Token (' + a.symbol + ') contract'), copyRow(a.token), $('div', 'muted', 'Send to'), copyRow(a.recipient), $('div', 'muted', 'Amount'), copyRow(a.amount));
  c.append(det);
  const scan = $('div', 'muted', 'Watching the chain for your payment…'); scan.id = 'scan'; c.append(scan);
  box.replaceChildren(c);
}

let walletShown = false;
function renderWallet(status) {
  if (walletShown || !status || !status.walletRpcPath || status.walletRpcPath === '/') return;
  walletShown = true;
  const c = $('div', 'card wallet');
  c.append($('h2', '', 'Connect your wallet'));
  c.append($('div', 'muted', 'In your wallet, edit the network with chain ID ' + status.chainId + ' and set its RPC URL to:'));
  c.append(copyRow(location.origin + status.walletRpcPath));
  c.append($('div', 'muted', 'Keep this URL private. It can queue transactions, but only this page can approve them.'));
  document.getElementById('wallet').replaceChildren(c);
}

async function refresh() {
  try {
    const [list, status] = await Promise.all([
      fetch(BASE + '/approvals', H).then(r => r.json()),
      fetch(BASE + '/status', H).then(r => r.json()).catch(() => null)
    ]);
    if (status && status.activation) renderActivation(status.activation);
    if (status && (!status.activation || status.activation.active)) renderWallet(status);
    if (status) {
      const lc = status.lightClient || {};
      const fresh = lc.latest && typeof lc.latest.fresh === 'boolean' ? (lc.latest.fresh ? 'fresh head' : 'STALE head') : (lc.startupStage || lc.error || 'unknown');
      document.getElementById('conn').textContent = 'Node: ' + location.host + ' · chain ' + status.chainId + ' · light client: ' + fresh + ' · auto-approve: ' + status.autoApprove;
    }
    const key = JSON.stringify(list.pending.map(a => a.id));
    if (key !== shown) {
      shown = key;
      const box = document.getElementById('pending');
      box.replaceChildren(...(list.pending.length ? list.pending.map(card) : [Object.assign($('div', 'card empty', 'No transactions waiting. Send one from your wallet.'))]));
    }
    document.title = (list.pending.length ? '(' + list.pending.length + ') ' : '') + 'KaiSign Approvals';
    const recent = document.getElementById('recent');
    if (list.recent.length) recent.replaceChildren(...list.recent.map(a => {
      const r = $('div', 'row');
      r.append($('span', '', '#' + a.id + ' ' + a.clearSign.intent), $('span', '', a.status + (a.decidedBy ? ' · ' + a.decidedBy : '') + (a.result ? ' · ' + a.result : '')));
      return r;
    }));
  } catch (e) {
    document.getElementById('conn').textContent = 'Gateway unreachable: ' + e.message;
  }
}
refresh(); setInterval(refresh, 1000);
</script>
</body>
</html>`;
}

// ─── CLI entry ──────────────────────────────────────────────────────────────

function parseFlags(argv: string[]): Record<string, string | boolean> {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [key, inline] = arg.slice(2).split('=', 2);
    if (inline !== undefined) flags[key] = inline;
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[key] = argv[++i];
    else flags[key] = true;
  }
  return flags;
}

function usage(): string {
  return [
    'Usage: kaisign-wallet-rpc [--upstream http://127.0.0.1:8545] [--port 8546] [--auto-approve none|safe]',
    '                          [--timeout 300] [--no-rewrite-tags] [--open]',
    '',
    'Point your wallet at http://127.0.0.1:8546. Every eth_sendRawTransaction is clear-signed by',
    'KaiSign and held until you approve it in the browser page, or type y / n here.',
    '',
    'Env: KAISIGN_WALLET_RPC_UPSTREAM, KAISIGN_WALLET_RPC_PORT, KAISIGN_WALLET_RPC_HOST,',
    '     KAISIGN_AUTO_APPROVE, KAISIGN_APPROVAL_TIMEOUT_SECONDS, LIGHT_CLIENT_RPC_URL',
    '',
    'Remote mode (VPS / tailnet, see docs/REMOTE_DEPLOY.md):',
    '  KAISIGN_RPC_TOKEN, KAISIGN_APPROVAL_KEY   secrets (>= 32 URL-safe chars) -> /rpc/<token>, /a/<key>/',
    '  KAISIGN_PUBLIC_URL                        e.g. https://kaisign.tail1234.ts.net (for printed links)',
    '  KAISIGN_DATA_DIR                          activation state (default ./.kaisign)',
    '  KAISIGN_FEE_RECIPIENT, KAISIGN_FEE_AMOUNT optional one-time activation fee (USDC by default)'
  ].join('\n');
}

function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(command, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref();
  } catch { /* best effort */ }
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  if (flags.help || flags.h) {
    console.log(usage());
    return;
  }

  const lightClientDefault = parseLightClientConfig(process.env.LIGHT_CLIENT_RPC_URL)[0]?.url;
  const upstream = String(flags.upstream ?? process.env.KAISIGN_WALLET_RPC_UPSTREAM ?? lightClientDefault ?? 'http://127.0.0.1:8545');
  const port = Number(flags.port ?? process.env.KAISIGN_WALLET_RPC_PORT ?? 8546);
  const host = String(flags.host ?? process.env.KAISIGN_WALLET_RPC_HOST ?? '127.0.0.1');
  const autoApprove = String(flags['auto-approve'] ?? process.env.KAISIGN_AUTO_APPROVE ?? 'none') === 'safe' ? 'safe' : 'none';
  const timeoutSeconds = Number(flags.timeout ?? process.env.KAISIGN_APPROVAL_TIMEOUT_SECONDS ?? 300);

  const rpcToken = process.env.KAISIGN_RPC_TOKEN?.trim();
  const approvalKey = process.env.KAISIGN_APPROVAL_KEY?.trim();
  const remote = rpcToken || approvalKey ? { rpcToken: rpcToken ?? '', approvalKey: approvalKey ?? '' } : undefined;
  if (remote && (!remote.rpcToken || !remote.approvalKey)) {
    console.error('Remote mode needs both KAISIGN_RPC_TOKEN and KAISIGN_APPROVAL_KEY.');
    process.exit(1);
  }

  if (!remote && !isLoopbackHost(host.includes(':') && !host.startsWith('[') ? `[${host}]` : host)) {
    console.error(`Refusing to listen on ${host} without remote-mode secrets (KAISIGN_RPC_TOKEN / KAISIGN_APPROVAL_KEY). Keep it on loopback.`);
    process.exit(1);
  }

  const upstreamRpc = async <T>(method: string, params: unknown[]): Promise<T> => {
    const response = await fetch(upstream, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(95_000)
    });
    const body = await response.json() as { result?: T; error?: { message: string } };
    if (body.error) throw new Error(body.error.message);
    return body.result as T;
  };
  const dataDir = process.env.KAISIGN_DATA_DIR ?? '.kaisign';
  const fee = feeConfigFromEnv();
  const activation = fee ? new ActivationManager(upstreamRpc, fee, join(dataDir, 'activation.json')) : undefined;

  // The upstream light client also verifies KaiSign registry reads when it serves Sepolia.
  lightClients.add({ url: upstream });

  const publicBase = (process.env.KAISIGN_PUBLIC_URL ?? `http://127.0.0.1:${port}`).replace(/\/+$/, '');
  const pageUrl = () => remote ? `${publicBase}/a/${remote.approvalKey}/` : `${publicBase}/`;
  const walletUrl = () => remote ? `${publicBase}/rpc/${remote.rpcToken}` : publicBase;
  const interactive = Boolean(process.stdin.isTTY);

  const gateway = new WalletRpcGateway({
    upstream,
    autoApprove,
    approvalTimeoutMs: timeoutSeconds * 1000,
    rewriteBlockTags: !flags['no-rewrite-tags'],
    remote,
    activation,
    onPending: approval => {
      const bar = '━'.repeat(60);
      console.error(`\n${bar}\nKaiSign approval #${approval.id}  [${approval.clearSign.verdict.toUpperCase()}]  ${approval.clearSign.intent}\n${bar}`);
      console.error(`From ${approval.tx.from}  nonce ${approval.tx.nonce}  value ${formatEther(approval.tx.value)} ${nativeSymbol(approval.tx.chainId)}`
        + (approval.tx.maxFeePerGas ? `  max fee ${formatUnits(approval.tx.maxFeePerGas, 'gwei')} gwei` : ''));
      console.error(approval.clearSign.text.trimEnd());
      console.error(`\n→ Approve at ${pageUrl()}${interactive ? '  or type  y (approve) / n (reject)  + Enter' : ''}`);
      process.stdout.write('\x07');
    }
  });

  const { port: boundPort } = await gateway.listen(port, host);
  activation?.start();
  const chainHint = await fetch(upstream, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    signal: AbortSignal.timeout(5000)
  }).then(r => r.json() as Promise<{ result?: string }>).then(r => (r.result ? Number(BigInt(r.result)) : undefined)).catch(() => undefined);

  console.error([
    'KaiSign Wallet RPC is running',
    `  Wallet RPC URL : ${remote ? walletUrl() : `http://127.0.0.1:${boundPort}`}${chainHint !== undefined ? `   (chain ID ${chainHint})` : ''}`,
    `  Approvals page : ${remote ? pageUrl() : `http://127.0.0.1:${boundPort}/`}`,
    `  Mode           : ${remote ? `remote (listening on ${host}:${boundPort}, path secrets required)` : 'local (loopback only)'}`,
    `  Activation fee : ${fee ? `${fee.amount} to ${fee.recipient} (verified on-chain by this node)` : 'none'}`,
    `  Light client   : ${upstream}${chainHint === undefined ? '   (not reachable yet — start it, the gateway will retry)' : ''}`,
    `  Auto-approve   : ${autoApprove === 'safe' ? 'SAFE verdicts (fully decoded + registry-attested)' : 'off — every transaction needs a click'}`,
    `  Timeout        : ${timeoutSeconds}s, then the wallet sees "rejected"`
  ].join('\n'));

  if (flags.open) openBrowser(`http://127.0.0.1:${boundPort}/`);

  if (interactive) {
    const rl = createInterface({ input: process.stdin });
    rl.on('line', line => {
      const [answer, id] = line.trim().toLowerCase().split(/\s+/);
      const target = id ?? gateway.oldestPending()?.id;
      if (!target || !answer) return;
      if (['y', 'yes', 'a', 'approve'].includes(answer)) {
        const a = gateway.list().pending.find(p => p.id === target);
        if (a?.clearSign.verdict === 'reject' && answer !== 'approve') {
          console.error(`#${target} could NOT be clear-signed. Type "approve ${target}" to broadcast it anyway.`);
          return;
        }
        if (!gateway.decide(target, true, 'terminal')) console.error(`No waiting transaction #${target}`);
      } else if (['n', 'no', 'r', 'reject'].includes(answer)) {
        if (!gateway.decide(target, false, 'terminal', 'rejected in terminal')) console.error(`No waiting transaction #${target}`);
      }
    });
  }

  const shutdown = () => { void gateway.close().then(() => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(error => {
    console.error('Failed to start KaiSign Wallet RPC:', error);
    process.exit(1);
  });
}

