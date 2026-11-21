# Your own KaiSign node, off your PC

Run the Nethermind light client and the KaiSign Wallet RPC on a small server you rent, reach it **only** from your own devices over Tailscale, and approve every transaction on your iPhone. Your PC is not involved.

```
iPhone ── Tailscale (WireGuard) ──► your VPS
  wallet  → https://kaisign.<tailnet>.ts.net/rpc/<token>      ┐
  Safari  → https://kaisign.<tailnet>.ts.net/a/<key>/         ├─ tailscale serve (HTTPS)
                                                              │    └─ KaiSign gateway :8546
                                                              │         └─ Nethermind light client :8545 ── P2P
```

## Why a small server and not "serverless"

The light client keeps long-lived P2P connections to beacon and execution peers and stores its verified state on disk. Functions-as-a-service platforms stop idle processes and have no persistent disk, so the light client cannot run there. The setup below is the closest equivalent: **one paste at server creation, no SSH, no maintenance commands.**

## What "trustless" means here

| You do not have to trust | Because |
|---|---|
| An RPC provider | The light client verifies every state read, receipt and log against sync-committee-authenticated headers. |
| KaiSign (us) | The server runs in **your** cloud account, built from a git commit you choose. Secrets are generated in your browser by `deploy/wizard.html` and never sent to us. No KaiSign server is in the loop. |
| A payment processor | The activation fee is a plain USDC transfer that **your node** finds on-chain through **its own** light client. |
| The open internet | Nothing but P2P ports is public. The RPC and approval page are reachable only inside your tailnet. |

What you still trust, and should choose deliberately:
- **The checkpoint provider**: the light client's one-time starting point.
- **Your VPS provider**: anyone who controls the machine can read its disk and memory.
- **Tailscale's coordination server**: it sees device metadata, but traffic is end-to-end WireGuard. Self-host [Headscale](https://headscale.net) to remove it.
- **The code version you deploy**: pin a commit you have reviewed.

## Deploy in 4 steps

1. **Tailscale.** Install the app on your iPhone. In the admin console, under DNS, enable *MagicDNS* and *HTTPS certificates*. Then go to Settings → Keys and generate a one-off auth key.
2. **Wizard.** Open `deploy/wizard.html`. It works offline, as a local file or from any static host. Pick the network, paste the Tailscale key and tap *Generate*. Save the two private links it shows.
3. **Server.** At any VPS provider, create a Ubuntu 24.04 machine (2 vCPU / 4 GB RAM / 40 GB disk is a sensible start). Paste the generated cloud-init into the **User data / Cloud config** field. It installs Docker from Docker's signed apt repository, clones this repo at your chosen commit, and runs `docker compose up -d --build` in `deploy/`.
4. **iPhone.** With Tailscale on, open the **approval page** link:
   - **Activate** (if the deployment has a fee). The page shows *Send exactly 10.00xxxx USDC*. Tap **Pay in MetaMask app**, or **Pay with another wallet app** (EIP-681 link), or scan the QR code, then confirm. The page flips to *Node activated* within about a block.
   - **Connect.** The page shows your wallet RPC URL. In your wallet, edit the network and paste it as the RPC URL.
   - **Use.** Every transaction your wallet sends appears on the approval page with the KaiSign clear-sign result. Tap **Approve & send** or **Reject**. Add the page to your Home Screen.

## The activation fee

- **Amount.** The fee is a fixed amount plus a random suffix of 0.000001–0.009999 USDC. The suffix identifies your node without a memo field or a payment contract.
- **Verification.** The node scans `Transfer(any → recipient)` logs on the USDC contract in ≤512-block chunks through its light client. It accepts only the exact amount, mined after the node was created, and stores the result in `/data/activation.json`.
- **Before payment.** The wallet RPC answers only `eth_chainId`, `net_version` and `web3_clientVersion`, so a wallet can already add the network. Everything else returns `-32002 KaiSign node not activated yet`.
- **Supported tokens.** USDC is built in for Ethereum mainnet and Sepolia. Other networks need `KAISIGN_FEE_TOKEN` (plus `KAISIGN_FEE_DECIMALS` and `KAISIGN_FEE_SYMBOL`).
- **No fee.** With no `KAISIGN_FEE_RECIPIENT`, there is no fee and the node is active immediately.

Operators set the recipient and price at the top of `deploy/wizard.html` (`FEE_RECIPIENT`, `FEE_AMOUNT`, `FEE_TOKENS`).

> The code is MIT-licensed and the fee is a configuration value in the user's own `.env`. It is an honest payment for a guided setup, not copy protection: a technical user can remove it. Nothing about the fee weakens the user's security.

## Secrets and what they allow

| Secret | Where it goes | Lets the holder… |
|---|---|---|
| `KAISIGN_RPC_TOKEN` | your wallet's RPC URL | read verified chain data and **queue** transactions. It cannot approve them. |
| `KAISIGN_APPROVAL_KEY` | approval page link | approve or reject queued transactions. Treat it like a password. |
| `TS_AUTHKEY` | server only | join a device to your tailnet. Use a one-off key; it is spent at first boot. |

Both KaiSign secrets are 256-bit random values, compared in constant time. Wrong paths get `404`. The approval page sends `X-Frame-Options: DENY` and a nonce-based CSP.

## Options

| `.env` | Effect |
|---|---|
| `KAISIGN_AUTO_APPROVE=safe` | Relay SAFE verdicts (fully decoded, registry-attested, hash-bound) without a tap |
| `COMPOSE_PROFILES=verified-registry` + `LIGHT_CLIENT_RPC_URL=11155111=http://light-client-sepolia:8545` | Run a second light client on Sepolia so registry attestations are verified too, not just your wallet's chain. The wizard enables this by default when your network isn't Sepolia. |
| `LC_IMAGE` | Light-client image (default `nethermindeth/nethermind:light-client-1.0.1`) |

## Operating it

```sh
# on the server (or Tailscale SSH)
cd /opt/kaisign/src/deploy
docker compose ps
docker compose logs -f gateway        # approvals, activation
docker compose logs -f light-client   # sync, peers
git -C .. fetch && git -C .. checkout --detach <new-commit> && docker compose up -d --build   # update
```

## Running it without Tailscale

The gateway is a plain HTTP service on `127.0.0.1:8546`. You can put any authenticated tunnel or VPN in front (WireGuard, Headscale, a reverse proxy with TLS), as long as it forwards to that port. Do not publish port 8546 or 8545 to the internet: the path secrets protect it, but a VPN keeps the node invisible.
