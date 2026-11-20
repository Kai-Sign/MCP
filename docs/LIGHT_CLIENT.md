# Wallets + Nethermind light client + KaiSign clear signing

This guide connects three pieces:

| Piece | What it does | Default URL |
|-------|--------------|-------------|
| **Nethermind light client** ([NethermindEth/nethermind#14457](https://github.com/NethermindEth/nethermind/pull/14457)) | Follows sync-committee-authenticated beacon heads over P2P and serves a JSON-RPC whose state reads (`eth_getBalance`, `eth_call`, `eth_getStorageAt`, `eth_getLogs` …) are verified locally against the execution state root. Relays `eth_sendRawTransaction` to execution peers. | `http://127.0.0.1:8545` |
| **KaiSign Wallet RPC** (`kaisign-wallet-rpc`, this repo) | The URL your wallet uses. Forwards reads to the light client; **holds every signed transaction**, clear-signs it with KaiSign, and relays it only after you approve. | `http://127.0.0.1:8546` |
| **KaiSign MCP** (this repo) | With `LIGHT_CLIENT_RPC_URL` set, verifies registry attestations and proxy slots through the light client instead of trusting a public RPC. | stdio / `:3333` |

```
wallet ──► KaiSign Wallet RPC :8546 ──► Nethermind light client :8545 ──► P2P
              │ clear-sign + approve
              └─ browser page http://127.0.0.1:8546/  ·  terminal y/n  ·  auto for SAFE
```

## 1. Start the light client

From a Nethermind checkout that contains PR #14457 (light-client README, 2026-11-20):

```sh
# Sepolia — the network the KaiSign registry lives on; fetches an EF checkpoint by itself
dotnet run --project src/Nethermind/Nethermind.LightClient -c release -p:SaveDiskSpace=true -- --network sepolia

# Ethereum mainnet — you must choose the checkpoint (trust anchor) provider
dotnet run --project src/Nethermind/Nethermind.LightClient -c release -p:SaveDiskSpace=true -- \
  --network mainnet --checkpoint-url https://mainnet.checkpoint.sigp.io
```

Or with Docker: `cd tools/LightClient && cp .env.example .env && docker compose up -d`.

Wait until it is ready — `curl -s http://127.0.0.1:8545/status` must show `"startupStage": "running"`, `"rpcInitialized": true` and a fresh `latest` head.

To run two networks at once (e.g. mainnet for the wallet and Sepolia for the registry), give the second instance distinct ports: `--urls http://127.0.0.1:8547 --beacon-port … --execution-port …`.

## 2. Start the KaiSign Wallet RPC

```sh
npm install && npm run build
npm run start:wallet-rpc                       # upstream http://127.0.0.1:8545, port 8546
npm run start:wallet-rpc -- --open             # also opens the approvals page
npm run start:wallet-rpc -- --auto-approve safe  # SAFE verdicts go through without a click
```

Options (each has an env var): `--upstream` (`KAISIGN_WALLET_RPC_UPSTREAM`), `--port` (`KAISIGN_WALLET_RPC_PORT`), `--auto-approve none|safe` (`KAISIGN_AUTO_APPROVE`), `--timeout <seconds>` (`KAISIGN_APPROVAL_TIMEOUT_SECONDS`, default 300), `--no-rewrite-tags`.

## 3. Point your wallet at it

**MetaMask** → Settings → Networks → (your network) → *Add RPC URL* → `http://127.0.0.1:8546`, and select it.
Use the chain ID the light client serves: `1` mainnet, `11155111` Sepolia, `560048` Hoodi, `100` Gnosis (symbol `xDAI`).

**Rabby / Frame / other extensions**: add a custom RPC with the same URL.

**Scripts** (ethers / viem / Foundry): use `http://127.0.0.1:8546` as the RPC URL; `cast send --rpc-url http://127.0.0.1:8546 …` works as-is.

## 4. Approve — the easy part

When the wallet sends a transaction, the gateway decodes it and waits. Approve in whichever place is closest:

- **Browser** — `http://127.0.0.1:8546/` shows the clear-signed intent (e.g. *Transfer 1.00 USDC to 0x2222…*), a SAFE / REVIEW / REJECT badge, sender, nonce, fees and the full report. Click **Approve & send** or **Reject**. The tab title shows the waiting count.
- **Terminal** — the gateway prints the same report and rings the bell; type `y` or `n` and press Enter (applies to the oldest waiting transaction; `y 3` / `n 3` picks one).
- **Automatically** — with `--auto-approve safe`, transactions that are fully decoded *and* registry-attested *and* bound to the attested metadata hash are relayed immediately. Everything else still waits.

What the wallet sees:

| Outcome | Wallet receives |
|---------|-----------------|
| Approved | the transaction hash from the light client, exactly as without KaiSign |
| Rejected / timed out | JSON-RPC error `4001` *"KaiSign: transaction rejected"* — wallets show this as a normal cancellation |
| Wallet gave up first (closed the request) | the approval is cancelled; nothing is broadcast behind the wallet's back |

Verdicts:

| Badge | Meaning | Button |
|-------|---------|--------|
| **SAFE** | every call decoded, every contract registry-attested, metadata hash bound | Approve & send |
| **REVIEW** | decoded but not fully attested, a plain value transfer, or a contract deployment | Approve & send — read it first |
| **REJECT** | calldata could not be fully decoded, revoked attestation, hash mismatch … | **Approve anyway** (red, asks again); in the terminal you must type `approve <id>` |

> The wallet signs *before* the gateway sees the transaction, so KaiSign is a **broadcast gate**: a signed transaction you reject is never relayed by this RPC. Do not reuse the same signed bytes elsewhere if you rejected them.

## 5. Make the MCP verify through the light client

```sh
# bare URL: chain detected with eth_chainId; comma-separate several clients
export LIGHT_CLIENT_RPC_URL=http://127.0.0.1:8545
# or pin chains explicitly
export LIGHT_CLIENT_RPC_URL=11155111=http://127.0.0.1:8547,1=http://127.0.0.1:8545
```

When a light client serves a chain:

- **Registry (Sepolia)** — `eth_blockNumber`, `smtRoot()`, `getLatestSpecForTarget()` and `getAttestation()` go **only** to the light client (no silent fallback). Results report `registryReadVia: "light-client"`.
- **`SmtRootUpdated` log replay** uses ≤ 512-block `eth_getLogs` chunks (the light client's cap). If the light client cannot serve that history, logs are replayed from public RPCs — safe, because the rebuilt tree must still equal the light-client-verified `smtRoot`. Set `LIGHT_CLIENT_ONLY=true` to forbid that fallback.
- **Proxy detection** (`eth_getStorageAt` / `eth_call` on the target chain) reads verified state.

The wallet gateway registers its upstream automatically, so if that light client runs on Sepolia the gateway's clear-signing also reads the registry through it.

## Compatibility notes (light-client limits the gateway smooths over)

| Light client behaviour | Gateway handling |
|---|---|
| `pending` / `safe` tags return `-32001` | mapped to `latest` / `finalized` (`--no-rewrite-tags` to disable) |
| No pending nonce | `eth_getTransactionCount(addr, "pending")` = max(verified latest nonce, last nonce relayed through the gateway + 1) |
| Only extension / loopback origins accepted | same policy: wallet extensions and local tools allowed, websites refused, loopback `Host` only |
| WebSocket at `ws://127.0.0.1:8545/ws` | not proxied — wallets use HTTP; subscribe to the light client directly if needed |
| Optimism / Base / Arbitrum | not served by the light client; MCP keeps using `*_RPC_URL` providers for those chains |

## Security

- The gateway has no authentication: it refuses to bind to non-loopback addresses and checks the `Host` header (DNS-rebinding protection).
- The approval API (`/approvals…`) requires a per-process token embedded in the approvals page; wallet extensions and websites cannot call it. The page is served with `X-Frame-Options: DENY` and a nonce-based CSP so it cannot be framed or scripted by another site.
- The checkpoint you give the light client is a trust decision (see its README). Everything after that is verified locally.
