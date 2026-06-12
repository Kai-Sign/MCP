# KaiSign MCP Server — Usage Guide

Direct agent / wallet / router integration instructions are in [AGENT_INTEGRATION.md](AGENT_INTEGRATION.md).

This guide covers how to set up and use the KaiSign MCP Server, HTTP endpoint, and CLI with local clear-signing metadata.

## Table of Contents

- [Setup](#setup)
- [Local MCP tutorial](LOCAL_MCP_TUTORIAL.md)
- [CLI](CLI.md)
- [Connecting to Claude](#connecting-to-claude)
- [Working with Deployed Contracts](#working-with-deployed-contracts)
- [Tool Reference](#tool-reference)
- [Command-line clear-signing](#command-line-clear-signing)
- [Examples](#examples)
- [Troubleshooting](#troubleshooting)

---

## Setup

### 1. Install and Build

```bash
git clone https://github.com/Kai-Sign/MCP.git
cd MCP
npm install
npm run build
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env` if you want custom RPC endpoints:

```env
# Recommended: authenticated RPCs for production
BASE_RPC_URL=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
ETH_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY

# Optional: force local metadata directory
KAISIGN_METADATA_DIR=/absolute/path/to/MCP/metadata
```

### 3. Verify Installation

```bash
npm run build && npm start
# Should print: "KaiSign MCP Server running on stdio"
# Press Ctrl+C to stop
```

HTTP server:

```bash
npm run start:http
# POST JSON-RPC to /mcp
```

---

## Connecting to Claude

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\\Claude\\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "kaisign": {
      "command": "node",
      "args": ["/absolute/path/to/MCP/dist/index.js"],
      "env": {
        "KAISIGN_METADATA_DIR": "/absolute/path/to/MCP/metadata"
      }
    }
  }
}
```

### Claude Code

Edit `~/.claude/settings.json`:

```json
{
  "mcpServers": {
    "kaisign": {
      "command": "node",
      "args": ["/absolute/path/to/MCP/dist/index.js"],
      "env": {
        "KAISIGN_METADATA_DIR": "/absolute/path/to/MCP/metadata"
      }
    }
  }
}
```

After adding the configuration, restart Claude. You should see `kaisign` listed as an available MCP server.

---

## Working with Deployed Contracts

### Local metadata first

MCP searches local metadata by `to` + `chainId` by default. Use repo-local `metadata/` or set `KAISIGN_METADATA_DIR`.

Verification sources:

- `leaf-verified` — metadata leaf matches on-chain registry state
- `local-metadata` — metadata loaded from local files, not proven on-chain
- `mismatch` — locally computed leaf does not match on-chain state
- `unverified` — no verified/local metadata for the contract
- `error` — verification failed

### USDC (Base)

| Field | Value |
|-------|-------|
| Address | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Chain | Base (8453) |
| Functions | `transfer`, `approve`, `transferFrom`, etc. |

### USDC (Ethereum Mainnet)

| Field | Value |
|-------|-------|
| Address | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| Chain | Ethereum (1) |
| Functions | `transfer`, `approve`, `transferFrom`, etc. |

### KaiSign Registry

The current registry address should be read from deployment constants before relying on it:

- `metadata/deployment.js` in this repo when present
- `kaisign-backend/backend/metadata/deployment.js`
- `kaisign-backend/backend/deployment.py`

Key registry methods:

- `getLatestSpecForBytecode(chainId, extcodehash)` — returns attestation UID for a contract bytecode binding
- `getAttestation(uid)` — returns attestation data
- `computeAttestationLeaf(uid)` — returns the on-chain computed leaf hash

---

## Tool Reference

### verify_contract_metadata

Verify that a contract has on-chain attested metadata or usable local metadata.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `contractAddress` | string | Yes | — | Contract address (`0x...`) |
| `chainId` | number | No | 1 | Chain ID |

### decode_transaction

Decode transaction calldata using metadata.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `to` | string | Yes | — | Target contract address |
| `data` | string | Yes | — | Transaction calldata |
| `chainId` | number | No | 1 | Chain ID |
| `value` | string | No | `"0"` | Value in wei |
| `skipVerification` | boolean | No | false | Skip on-chain verification |

### clear_sign_payload

Generic pre-sign hook for any transaction-builder payload: LLM agent, wallet, router API, custom code, or direct calldata. Accepts direct canonical tx fields, nested `transaction` / `tx` objects, calldata aliases, or `rawTx`, then returns normalized `transaction`, `clearSign`, and `signingPolicy`.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `to` | string | Conditional | — | Target contract address for direct payloads |
| `data` / `calldata` | string | Conditional | — | Transaction calldata for direct/nested payloads |
| `chainId` / `chain` | number/string | No | 1 | Chain ID |
| `value` | string | No | `"0"` | Value in wei |
| `transaction` / `tx` | object | Conditional | — | Nested tx-builder payload |
| `rawTx` / `rawTransaction` | string | Conditional | — | Serialized transaction to extract clear-sign fields |
| `compact` | boolean | No | false | Compact large calldata/response fields when supported |
| `payloadRef` / `dataRef` | string | Conditional | — | Server-side chunked payload reference when supported |

Use this before signing/broadcasting. Sign only the returned `transaction` after policy/user approval.

### get_function_selectors

Resolve callable function selectors from the exact contract address + chain before encoding calldata.

Use it to avoid same-name selector mistakes across proxies, diamonds, account abstraction contracts, and router variants.

### get_clear_sign_prompt

Get a formatted signing prompt for user display.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `to` | string | Yes | — | Target contract address |
| `data` | string | Yes | — | Transaction calldata |
| `chainId` | number | No | 1 | Chain ID |
| `value` | string | No | `"0"` | Value in wei |

### get_cached_metadata

Check cache status for a contract.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `contractAddress` | string | Yes | — | Contract address |
| `chainId` | number | No | 1 | Chain ID |

### clear_cache / prune_expired_cache

Cache management tools. No parameters required.

---

## Command-line clear-signing

Minimum viable clear-signing CLI for pasted transaction calldata or a signed raw transaction.

By default the CLI searches the local metadata folder/cache by transaction `to` + `chainId`. You can still pass `--metadata path/to/file.json` to force a specific local ERC-7730 metadata file. It does not need the backend API.

### Build

```bash
npm install
npm run build
```

### Use raw calldata

```bash
node dist/cli.js clear-sign \
  --chain 8453 \
  --to 0x1111111111111111111111111111111111111111 \
  --data 0xa9059cbb0000000000000000000000002222222222222222222222222222222222222222000000000000000000000000000000000000000000000000000000000000000a
```

`--data` and `--calldata` are aliases.
`--metadata-file` is an alias for `--metadata`.

### Use a signed serialized transaction

```bash
node dist/cli.js clear-sign --metadata ./usdc.json --tx 0x02f8...
```

`--tx` and `--raw-tx` are aliases. The CLI parses `to`, `data`, `value`, and `chainId` from the raw transaction.

### Use JSON stdin

```bash
echo '{"metadata":"./usdc.json","to":"0x1111111111111111111111111111111111111111","data":"0xa9059cbb...","chainId":8453,"value":"0"}' \
  | node dist/cli.js clear-sign --json
```

Or pass the metadata path explicitly if you want to force a file:

```bash
echo '{"to":"0x1111111111111111111111111111111111111111","data":"0xa9059cbb...","chainId":8453,"value":"0"}' \
  | node dist/cli.js clear-sign --metadata ./usdc.json --json
```

### Paste an agent payload

If an agent returns `{to,data,value,chainId}`, use either JSON output on any pasted/plaintext payload, or the interactive paste box. `--metadata` is optional, and wrapped calldata with whitespace/newlines inside the quoted hex string is normalized.

Pass/paste the whole payload as plaintext:

```bash
node dist/cli.js clear-sign --json '{"to":"0x0000000071727De22E5E9d8BAf0edAc6f37da032","value":"0x0","chainId":1,"data":"0x765e827f..."}'
```

Or pipe clipboard/stdin:

```bash
pbpaste | node dist/cli.js clear-sign --json
```

Interactive paste box:

```bash
node dist/cli.js clear-sign --json
```

With no piped stdin, no tx args, and no inline payload, the CLI opens the paste box automatically. Paste the payload, then press Ctrl-D.

For plain semantic text instead of JSON:

```bash
node dist/cli.js clear-sign
```

Saving a file also works:

```bash
cat > /tmp/tx.json <<'JSON'
{
  "to": "0x0000000071727De22E5E9d8BAf0edAc6f37da032",
  "value": "0x0",
  "chainId": 1,
  "data": "0x765e827f..."
}
JSON

node dist/cli.js clear-sign --json < /tmp/tx.json
```

### Files used by the CLI

Runtime entrypoint:

- `src/cli.ts` -> `dist/cli.js`
  - parses `clear-sign`, `--metadata`, `--to`, `--data`, `--tx`, stdin JSON, and output mode

Clear-sign flow:

- `src/tools/clear-sign-transaction.ts`
  - optionally loads a forced local metadata JSON path into the metadata cache
  - calls the transaction decoder
  - returns `safeToSign`, `intent`, decoded params, warnings, and transaction info
- `src/tools/decode-transaction.ts`
  - validates transaction input
  - formats the final decode result returned by the recursive decoder
- `src/services/recursive-decoder.ts`
  - decodes the root call and metadata-declared nested calls only
  - builds the call tree and aggregate intent
- `src/services/abi-decoder.ts`
  - matches calldata selector against metadata ABI
  - ABI-decodes function params
  - applies ERC-7730 display fields and intent interpolation
- `src/services/metadata-service.ts`
  - supplies metadata to the decoder
  - without `--metadata`, searches local metadata by target address + chainId; in local-file mode, metadata is cached from `--metadata`
- `src/services/cache-manager.ts`
  - stores the local metadata for the target contract during the CLI run
- `src/services/metadata-hash.ts`
  - used only when verification data exists; local-file CLI mode does not require backend fetch
- `src/config/constants.ts`
  - shared constants used by services

CLI tests/docs:

- `tests/cli.test.ts`
- `tests/metadata-hash.test.ts`
- `docs/CLI.md`

### Output

Plain output:

```text
Decoded
Source: local-file
Function: transfer
Intent: Transfer 10 USDC to 0x...
```

JSON output:

```bash
node dist/cli.js clear-sign --metadata ./usdc.json --tx 0x02f8... --json
```

### Exit codes

- `0`: decoded successfully
- `1`: decode failed or could not resolve
- `2`: invalid input

---

## Examples

### Example 1: Verify USDC on Ethereum

Ask Claude: "Is the USDC contract on Ethereum verified in KaiSign?"

Claude will call:

```json
{
  "tool": "verify_contract_metadata",
  "input": {
    "contractAddress": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    "chainId": 1
  }
}
```

### Example 2: Decode a Token Transfer

Ask Claude: "Decode this transaction: to=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913, data=0xa9059cbb000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045000000000000000000000000000000000000000000000000000000003b9aca00, chainId=8453"

Claude will call `decode_transaction` and show:

```text
Transfer 1,000.00 USDC to 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045
```

### Example 3: Clear-sign any built payload

Any transaction builder can produce an unsigned payload:

```json
{
  "to": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  "data": "0xa9059cbb000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045000000000000000000000000000000000000000000000000000000003b9aca00",
  "value": "0",
  "chainId": 1
}
```

Then run:

```bash
node dist/cli.js clear-sign --json '{"to":"0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48","data":"0xa9059cbb000000000000000000000000d8da6bf26964af9d7eed9e03e53415d37aa96045000000000000000000000000000000000000000000000000000000003b9aca00","value":"0","chainId":1}'
```

---

## Troubleshooting

### "No metadata found for contract"

The contract does not have usable local metadata or on-chain attested metadata. Report:

- `chainId`
- target `to`
- selector (`data.slice(0,10)`)
- whether local metadata exists for that address/chain

If the ABI/selector is verified and useful, add metadata and submit it for registry verification.

### "Unknown selector"

Prove the selector from the canonical ABI signature before adding metadata:

```bash
node - <<'NODE'
import { id } from 'ethers';
console.log(id('transfer(address,uint256)').slice(0, 10));
NODE
```

For proxies, resolve implementation ABI. For diamonds, query live facet/loupe state.

### "RPC error" or timeout

- Check your internet connection
- Try authenticated RPC endpoints instead of public ones
- Check the configured RPC URL for the chain you are using

### "leaf-mismatch" verification

This means the locally computed leaf hash does not match on-chain state. Possible causes:

- Metadata was recently updated but not attested
- Cache is stale — try `clear_cache`
- The local file differs from the registry-attested metadata
- The attestation is stale or revoked

### Cache not working

- Cache is in-memory and resets on server restart
- Metadata TTL is 5 minutes, token metadata is 10 minutes
- Use `get_cached_metadata` to inspect cache status
