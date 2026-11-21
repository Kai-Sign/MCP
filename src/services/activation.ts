/**
 * Deployment activation fee, verified on-chain by the node itself.
 *
 * No payment processor and no KaiSign server: the deployment shows a unique token
 * amount (e.g. 10.004217 USDC), the owner pays it from any wallet, and the node finds
 * the matching ERC-20 Transfer log through its own Nethermind light client, whose
 * receipts are verified against sync-committee-authenticated headers.
 *
 * The unique suffix (1..9999 micro-units) ties a payment to this deployment without a
 * memo field or a payment contract. Only transfers mined after the deployment was
 * created count, so an old payment cannot activate a new node.
 *
 * With no KAISIGN_FEE_RECIPIENT configured there is no fee and the node is active.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import { getAddress, formatUnits, parseUnits, zeroPadValue } from 'ethers';
import { LIGHT_CLIENT_MAX_LOG_RANGE } from './light-client.js';

export const TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';

/** Well-known USDC deployments on chains the light client serves. */
export const DEFAULT_FEE_TOKENS: Record<number, { address: string; symbol: string; decimals: number }> = {
  1: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', decimals: 6 },
  11155111: { address: '0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238', symbol: 'USDC', decimals: 6 }
};

const CHAIN_NAMES: Record<number, string> = { 1: 'Ethereum', 11155111: 'Sepolia', 100: 'Gnosis', 560048: 'Hoodi' };

export interface FeeConfig {
  recipient: string;
  /** Human amount in token units, e.g. "10" */
  amount: string;
  token?: string;
  symbol?: string;
  decimals?: number;
}

export interface ActivationState {
  deploymentId: string;
  chainId: number;
  token: string;
  symbol: string;
  decimals: number;
  recipient: string;
  /** Exact amount to pay, in base units (decimal string) */
  amountUnits: string;
  startBlock: number;
  scannedTo: number;
  activated?: { txHash: string; blockNumber: number; from: string; at: number };
}

export interface ActivationStatus {
  required: boolean;
  active: boolean;
  chainId?: number;
  chainName?: string;
  token?: string;
  symbol?: string;
  recipient?: string;
  amount?: string;
  amountUnits?: string;
  scannedTo?: number;
  activated?: ActivationState['activated'];
  /** Payment links for the page */
  links?: { eip681: string; metamask: string };
  error?: string;
}

export type Rpc = <T>(method: string, params: unknown[]) => Promise<T>;

export function feeConfigFromEnv(env: NodeJS.ProcessEnv = process.env): FeeConfig | undefined {
  const recipient = env.KAISIGN_FEE_RECIPIENT?.trim();
  if (!recipient) return undefined;
  return {
    recipient,
    amount: env.KAISIGN_FEE_AMOUNT?.trim() || '10',
    token: env.KAISIGN_FEE_TOKEN?.trim() || undefined,
    symbol: env.KAISIGN_FEE_SYMBOL?.trim() || undefined,
    decimals: env.KAISIGN_FEE_DECIMALS ? Number(env.KAISIGN_FEE_DECIMALS) : undefined
  };
}

/** EIP-681 ERC-20 transfer URI, understood by most mobile wallets and QR scanners. */
export function eip681Transfer(token: string, chainId: number, recipient: string, units: string): string {
  return `ethereum:${token}@${chainId}/transfer?address=${recipient}&uint256=${units}`;
}

/** MetaMask universal link: opens the MetaMask app on iOS/Android with the transfer prefilled. */
export function metamaskTransferLink(token: string, chainId: number, recipient: string, units: string): string {
  return `https://metamask.app.link/send/${token}@${chainId}/transfer?address=${recipient}&uint256=${units}`;
}

export class ActivationManager {
  private state?: ActivationState;
  private lastError?: string;
  private timer?: NodeJS.Timeout;
  private polling?: Promise<void>;

  constructor(
    private readonly rpc: Rpc,
    private readonly fee: FeeConfig | undefined,
    private readonly stateFile: string,
    private readonly log: (message: string) => void = message => console.error(message)
  ) {}

  get required(): boolean {
    return Boolean(this.fee);
  }

  get active(): boolean {
    return !this.fee || Boolean(this.state?.activated);
  }

  /** Load or create this deployment's payment request. Safe to call again after a failure. */
  async init(): Promise<void> {
    if (!this.fee || this.state) return;

    if (existsSync(this.stateFile)) {
      const saved = JSON.parse(readFileSync(this.stateFile, 'utf8')) as ActivationState;
      if (getAddress(saved.recipient) === getAddress(this.fee.recipient)) {
        this.state = saved;
        return;
      }
      this.log('[activation] fee recipient changed; creating a new payment request');
    }

    const chainId = Number(BigInt(await this.rpc<string>('eth_chainId', [])));
    const known = DEFAULT_FEE_TOKENS[chainId];
    const token = this.fee.token ?? known?.address;
    if (!token) throw new Error(`no default fee token for chain ${chainId}; set KAISIGN_FEE_TOKEN`);
    const decimals = this.fee.decimals ?? (this.fee.token ? 18 : known!.decimals);
    const symbol = this.fee.symbol ?? (this.fee.token ? 'TOKEN' : known!.symbol);

    // Unique suffix: 1..9999 millionths of a token, scaled to the token's decimals.
    const scale = 10n ** BigInt(Math.max(decimals - 6, 0));
    const amountUnits = parseUnits(this.fee.amount, decimals) + BigInt(randomInt(1, 10_000)) * scale;
    const head = Number(BigInt(await this.rpc<string>('eth_blockNumber', [])));

    this.state = {
      deploymentId: randomUUID(),
      chainId,
      token: getAddress(token),
      symbol,
      decimals,
      recipient: getAddress(this.fee.recipient),
      amountUnits: amountUnits.toString(),
      startBlock: head,
      scannedTo: head - 1
    };
    this.save();
    this.log(`[activation] pay ${formatUnits(amountUnits, decimals)} ${symbol} to ${this.state.recipient} on chain ${chainId} to activate`);
  }

  private save(): void {
    mkdirSync(dirname(this.stateFile), { recursive: true });
    writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2), { mode: 0o600 });
  }

  /** Scan new blocks for the exact payment. Logs come from the light client, so they are verified. */
  async poll(): Promise<void> {
    if (!this.polling) {
      this.polling = this.pollOnce().finally(() => { this.polling = undefined; });
    }
    return this.polling;
  }

  private async pollOnce(): Promise<void> {
    try {
      await this.init();
      const s = this.state;
      if (!s || s.activated) return;

      const head = Number(BigInt(await this.rpc<string>('eth_blockNumber', [])));
      const recipientTopic = zeroPadValue(s.recipient, 32).toLowerCase();
      const expected = BigInt(s.amountUnits);

      while (s.scannedTo < head) {
        const from = s.scannedTo + 1;
        const to = Math.min(from + LIGHT_CLIENT_MAX_LOG_RANGE - 1, head);
        const logs = await this.rpc<Array<{ topics: string[]; data: string; transactionHash: string; blockNumber: string }>>('eth_getLogs', [{
          address: s.token,
          topics: [TRANSFER_TOPIC, null, recipientTopic],
          fromBlock: '0x' + from.toString(16),
          toBlock: '0x' + to.toString(16)
        }]);
        const match = logs.find(l => l.data && l.data !== '0x' && BigInt(l.data) === expected);
        if (match) {
          s.activated = {
            txHash: match.transactionHash,
            blockNumber: Number(BigInt(match.blockNumber)),
            from: getAddress('0x' + match.topics[1].slice(26)),
            at: Date.now()
          };
          s.scannedTo = to;
          this.save();
          this.log(`[activation] payment found in ${match.transactionHash}; deployment active`);
          break;
        }
        s.scannedTo = to;
        this.save();
      }
      this.lastError = undefined;
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error);
    }
  }

  start(intervalMs = 12_000): void {
    if (!this.fee || this.timer) return;
    void this.poll();
    this.timer = setInterval(() => {
      if (this.active) this.stop();
      else void this.poll();
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  status(): ActivationStatus {
    if (!this.fee) return { required: false, active: true };
    const s = this.state;
    if (!s) return { required: true, active: false, error: this.lastError ?? 'waiting for the light client' };
    return {
      required: true,
      active: Boolean(s.activated),
      chainId: s.chainId,
      chainName: CHAIN_NAMES[s.chainId] ?? `chain ${s.chainId}`,
      token: s.token,
      symbol: s.symbol,
      recipient: s.recipient,
      amount: formatUnits(BigInt(s.amountUnits), s.decimals),
      amountUnits: s.amountUnits,
      scannedTo: s.scannedTo,
      activated: s.activated,
      links: {
        eip681: eip681Transfer(s.token, s.chainId, s.recipient, s.amountUnits),
        metamask: metamaskTransferLink(s.token, s.chainId, s.recipient, s.amountUnits)
      },
      error: this.lastError
    };
  }
}
