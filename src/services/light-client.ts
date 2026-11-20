/**
 * Nethermind light client integration (NethermindEth/nethermind PR #14457).
 *
 * The light client serves a bounded, locally verified JSON-RPC surface (default
 * http://127.0.0.1:8545) for one network per process: Ethereum mainnet, Sepolia,
 * Hoodi or Gnosis. Every state read is checked against a sync-committee-authenticated
 * execution header, so reads routed here do not trust the RPC operator.
 *
 * Configuration (either form, comma-separated for several clients):
 *   LIGHT_CLIENT_RPC_URL=http://127.0.0.1:8545                     chain detected via eth_chainId
 *   LIGHT_CLIENT_RPC_URL=11155111=http://127.0.0.1:8545,1=http://127.0.0.1:8555
 *   LIGHT_CLIENT_ONLY=true   never fall back to public RPCs for chains a light client serves
 */

/** The light client caps eth_getLogs at 512 inclusive blocks per request. */
export const LIGHT_CLIENT_MAX_LOG_RANGE = 512;

const PROBE_TIMEOUT_MS = Number(process.env.KAISIGN_LIGHT_CLIENT_PROBE_TIMEOUT_MS || 5000);

export interface LightClientEntry {
  url: string;
  chainId?: number;
}

export function parseLightClientConfig(value: string | undefined): LightClientEntry[] {
  if (!value) return [];
  return value
    .split(',')
    .map(part => part.trim())
    .filter(Boolean)
    .map(part => {
      const match = /^(\d+)=(.+)$/.exec(part);
      return match ? { chainId: Number(match[1]), url: match[2].trim() } : { url: part };
    });
}

export function lightClientOnly(): boolean {
  return /^(1|true|yes)$/i.test(process.env.LIGHT_CLIENT_ONLY ?? '');
}

async function probeChainId(url: string): Promise<number | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      signal: controller.signal
    });
    const body = await response.json() as { result?: string };
    return body.result ? Number(BigInt(body.result)) : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Resolves chainId -> light client URL. Explicit `chainId=url` entries need no probe;
 * bare URLs are asked for eth_chainId, which the light client answers locally even
 * while it is still bootstrapping. Failed probes are retried on the next lookup.
 */
export class LightClientRegistry {
  private resolved = new Map<number, string>();
  private pending: LightClientEntry[];
  private inflight?: Promise<void>;

  constructor(entries: LightClientEntry[] = parseLightClientConfig(process.env.LIGHT_CLIENT_RPC_URL)) {
    this.pending = [];
    for (const entry of entries) {
      if (entry.chainId !== undefined) this.resolved.set(entry.chainId, entry.url);
      else this.pending.push(entry);
    }
  }

  /** Register another light client at runtime (e.g. the wallet gateway's upstream). */
  add(entry: LightClientEntry): void {
    if (entry.chainId !== undefined) {
      if (!this.resolved.has(entry.chainId)) this.resolved.set(entry.chainId, entry.url);
    } else if (![...this.resolved.values()].includes(entry.url) && !this.pending.some(p => p.url === entry.url)) {
      this.pending.push(entry);
    }
  }

  get configured(): boolean {
    return this.resolved.size > 0 || this.pending.length > 0;
  }

  private async probePending(): Promise<void> {
    if (this.pending.length === 0) return;
    if (!this.inflight) {
      this.inflight = (async () => {
        const stillPending: LightClientEntry[] = [];
        await Promise.all(this.pending.map(async entry => {
          const chainId = await probeChainId(entry.url);
          if (chainId === undefined) stillPending.push(entry);
          else if (!this.resolved.has(chainId)) this.resolved.set(chainId, entry.url);
        }));
        this.pending = stillPending;
      })().finally(() => { this.inflight = undefined; });
    }
    await this.inflight;
  }

  /** Light client URL serving chainId, if one is configured and reachable. */
  async urlFor(chainId: number): Promise<string | undefined> {
    if (this.resolved.has(chainId)) return this.resolved.get(chainId);
    await this.probePending();
    return this.resolved.get(chainId);
  }
}

export const lightClients = new LightClientRegistry();

/**
 * RPC URLs to try for chainId: the light client alone when it serves the chain
 * (verified reads must not silently fall back to an unverified provider), otherwise
 * the configured public/provider list.
 */
export async function verifiedRpcUrls(chainId: number, fallback: string[]): Promise<{ urls: string[]; lightClient: boolean }> {
  const url = await lightClients.urlFor(chainId);
  if (url) return { urls: [url], lightClient: true };
  return { urls: fallback, lightClient: false };
}
