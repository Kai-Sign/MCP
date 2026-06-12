# Local KaiSign MCP Tutorial

Run KaiSign MCP locally when you want a Claude/agent/wallet flow to clear-sign built transactions against local ERC-7730 metadata and the KaiSign registry.

KaiSign MCP does not build, sign, or broadcast transactions. It takes an already-built transaction payload, verifies matching metadata, decodes calldata, and returns a clear-signing result plus the normalized transaction to sign.

## 1. Install and build

```bash
git clone https://github.com/Kai-Sign/MCP.git
cd MCP
npm install
npm run build
```

If you already cloned the repo, just run:

```bash
npm install
npm run build
```

## 2. Configure local metadata and RPCs

The server auto-detects repo-local metadata at `metadata/`. If your metadata lives elsewhere, point the server at it:

```bash
export KAISIGN_METADATA_DIR=/absolute/path/to/metadata
```

Public RPC defaults are included for the supported chains. For production or rate-limit-sensitive use, set your own RPCs:

```bash
export ETH_RPC_URL=https://your-ethereum-rpc
export BASE_RPC_URL=https://your-base-rpc
export OPTIMISM_RPC_URL=https://your-optimism-rpc
export ARBITRUM_RPC_URL=https://your-arbitrum-rpc
export SEPOLIA_RPC_URL=https://your-sepolia-rpc
```

The generic `clear_sign_payload` flow works with any built transaction payload. KaiSign MCP does not need transaction-builder credentials for local clear-signing.

## 3. Smoke-test the local MCP server

The repo includes a local MCP client smoke test that starts `dist/index.js` over stdio and calls `clear_sign_payload` with a USDC transfer sample:

```bash
npm run build
npm run mcp:sample
```

Expected shape:

```json
{
  "transaction": {
    "to": "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    "data": "0xa9059cbb...",
    "value": "0",
    "chainId": 1
  },
  "clearSign": {
    "displayText": "⚠ Local Metadata Transaction\n\nTransfer 10.00 USDC...",
    "verified": false,
    "verificationBadge": "⚠ Local Metadata",
    "fullyDecoded": true,
    "warnings": [
      "Metadata loaded locally but not verified against on-chain attestation. Human review required."
    ],
    "verification": {
      "source": "local-metadata"
    }
  },
  "signingPolicy": {
    "signOriginalTransactionOnly": true,
    "canAutonomouslySign": false,
    "mustShowToUser": true
  }
}
```

The default sample uses repo-local metadata, so `local-metadata` is expected unless that contract also has a matching on-chain attestation in the configured registry. It is still useful as a local MCP smoke test because it proves the client can start the server, call a tool, load metadata, and decode calldata.

To test your own payload:

```bash
echo '{"to":"0x...","data":"0x...","value":"0","chainId":8453}' \
  | node scripts/call-mcp-clear-sign-sample.mjs
```

Raw serialized transaction payloads are also accepted:

```bash
echo '{"rawTx":"0x02f8..."}' | node scripts/call-mcp-clear-sign-sample.mjs
```

## 4. Connect a local MCP client over stdio

Most desktop/agent MCP clients should launch the stdio server directly:

```bash
node /absolute/path/to/MCP/dist/index.js
```

Generic MCP config:

```json
{
  "mcpServers": {
    "kaisign": {
      "command": "node",
      "args": ["/absolute/path/to/MCP/dist/index.js"],
      "env": {
        "KAISIGN_METADATA_DIR": "/absolute/path/to/MCP/metadata",
        "BASE_RPC_URL": "https://your-base-rpc",
        "ETH_RPC_URL": "https://your-ethereum-rpc"
      }
    }
  }
}
```

For this repository, replace `/absolute/path/to/MCP` with your clone path. From the repo root, `pwd` prints the path to use.

### Claude Desktop

macOS config file:

```text
~/Library/Application Support/Claude/claude_desktop_config.json
```

Example:

```json
{
  "mcpServers": {
    "kaisign": {
      "command": "node",
      "args": ["/Users/you/code/MCP/dist/index.js"],
      "env": {
        "KAISIGN_METADATA_DIR": "/Users/you/code/MCP/metadata"
      }
    }
  }
}
```

Restart Claude after editing the config.

### Claude Code

If your Claude Code setup uses MCP config in `~/.claude/settings.json`, use the same `mcpServers` entry:

```json
{
  "mcpServers": {
    "kaisign": {
      "command": "node",
      "args": ["/absolute/path/to/MCP/dist/index.js"]
    }
  }
}
```

## 5. Use the tool

For integrations, call `clear_sign_payload`. It accepts direct, nested, aliased, or raw transaction payloads.

Direct transaction:

```json
{
  "to": "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD",
  "data": "0x3593564c...",
  "chainId": 8453,
  "value": "10000000000000000"
}
```

Nested builder response:

```json
{
  "transaction": {
    "to": "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD",
    "calldata": "0x3593564c...",
    "chain": "8453",
    "valueWei": "10000000000000000"
  }
}
```

Required signing rule:

1. Build or receive the unsigned transaction.
2. Call `clear_sign_payload` before signing or broadcasting.
3. Show `clearSign.displayText` and `clearSign.warnings` to the user, or enforce your autonomous policy.
4. Sign only the returned `transaction` object.
5. If anything about the transaction changes, call `clear_sign_payload` again.

## 6. Optional: run local HTTP MCP

The default local MCP mode is stdio. Use HTTP when a client expects a URL.

Start the HTTP server:

```bash
npm run build
npm run start:http
```

Health check:

```bash
curl http://127.0.0.1:3333/health
```

MCP URL:

```text
http://127.0.0.1:3333/mcp
```

Transport:

```text
Streamable HTTP
```

The HTTP server also supports legacy SSE at the same `/mcp` endpoint.

If you need a temporary public URL for a browser-hosted client or remote integration, run:

```bash
npm run mcp:bridge
```

It starts or reuses the local HTTP server, opens a tunnel with ngrok when configured, otherwise falls back to localtunnel, and prints the MCP URL to paste into the client.

## Troubleshooting

- `Cannot find module dist/index.js`: run `npm run build` first.
- Client shows no `kaisign` server: use an absolute path in `args`, then restart the client.
- Stdio server appears to hang: that is normal when launched directly; it waits for MCP JSON-RPC over stdin. Use `npm run mcp:sample` for a human smoke test.
- `Port 3333 is already in use`: stop the process on that port or run HTTP with another port, for example `MCP_PORT=3334 npm run start:http`.
- Metadata is not found: make sure `metadata/` exists in the repo or set `KAISIGN_METADATA_DIR` to the directory containing ERC-7730 JSON files.
- Verification is slow or rate-limited: set authenticated RPC URLs for the relevant chain and Sepolia.
