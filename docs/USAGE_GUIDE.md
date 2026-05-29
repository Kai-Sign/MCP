# KaiSign MCP Server — Usage Guide

Direct Bankrbot / LLM agent / wallet integration instructions are in [AGENT_INTEGRATION.md](AGENT_INTEGRATION.md).

This guide covers how to set up and use the KaiSign MCP Server with Bankrbot and deployed contracts.

## Table of Contents

- [Setup](#setup)
- [Connecting to Claude](#connecting-to-claude)
- [Working with Deployed Contracts](#working-with-deployed-contracts)
- [Using with Bankrbot](#using-with-bankrbot)
- [Tool Reference](#tool-reference)
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

Edit `.env` with your values:

```env
# Required for Bankrbot features
BANKR_API_KEY=your_key_here

# Recommended: use authenticated RPCs for production
BASE_RPC_URL=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
ETH_RPC_URL=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
```

### 3. Verify Installation

```bash
npm run build && npm start
# Should print: "KaiSign MCP Server running on stdio"
# Press Ctrl+C to stop
```

---

## Connecting to Claude

### Claude Desktop

Edit `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%\Claude\claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "kaisign": {
      "command": "node",
      "args": ["/absolute/path/to/MCP/dist/index.js"],
      "env": {
        "BANKR_API_KEY": "your_key"
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
        "BANKR_API_KEY": "your_key"
      }
    }
  }
}
```

After adding the configuration, restart Claude. You should see "kaisign" listed as an available MCP server.

---

## Working with Deployed Contracts

### Verified Contracts

The following contracts have on-chain attested metadata in the KaiSign Registry. You can use them to test and explore the verification flow.

#### Uniswap Universal Router (Base)

| Field | Value |
|-------|-------|
| **Address** | `0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD` |
| **Chain** | Base (8453) |
| **Functions** | `execute(bytes,bytes[],uint256)` |
| **Commands** | WRAP_ETH, UNWRAP_WETH, V2_SWAP_EXACT_IN, V2_SWAP_EXACT_OUT, V3_SWAP_EXACT_IN, V3_SWAP_EXACT_OUT |

**Verify it:**
```
Tool: verify_contract_metadata
Input: {
  "contractAddress": "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD",
  "chainId": 8453
}
```

Expected response:
```json
{
  "verified": true,
  "source": "leaf-verified"
}
```

#### USDC (Base)

| Field | Value |
|-------|-------|
| **Address** | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| **Chain** | Base (8453) |
| **Functions** | `transfer`, `approve`, `transferFrom`, etc. |

#### USDC (Ethereum Mainnet)

| Field | Value |
|-------|-------|
| **Address** | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| **Chain** | Ethereum (1) |
| **Functions** | `transfer`, `approve`, `transferFrom`, etc. |

### KaiSign Registry

The registry lives on Sepolia testnet:

| Field | Value |
|-------|-------|
| **Address** | `0xC203e8C22eFCA3C9218a6418f6d4281Cb7744dAa` |
| **Network** | Sepolia (11155111) |
| **Explorer** | [View on Etherscan](https://sepolia.etherscan.io/address/0xC203e8C22eFCA3C9218a6418f6d4281Cb7744dAa) |

**Key registry methods:**
- `getLatestSpecForBytecode(chainId, extcodehash)` — Returns attestation UID for a contract
- `getAttestation(uid)` — Returns the full attestation struct
- `computeAttestationLeaf(uid)` — Returns the on-chain computed leaf hash

---

## Using with Bankrbot

[Bankrbot](https://bankr.bot) is an LLM-based agent that builds Ethereum transactions from natural language. KaiSign provides the verification layer.

### Getting a Bankrbot API Key

1. Visit [bankr.bot](https://bankr.bot)
2. Create an account and get your API key
3. Set it in your `.env` file: `BANKR_API_KEY=your_key`

### The Agent Signing Flow

```
┌──────────┐    ┌───────────┐    ┌─────────────┐    ┌──────────────┐
│  User     │───▶│  Claude   │───▶│  Bankrbot   │───▶│   KaiSign    │
│  "swap    │    │  (LLM)    │    │  (build tx) │    │  (verify +   │
│  0.01 ETH │    │           │◀───│             │◀───│   decode)     │
│  to USDC" │    │           │    │             │    │              │
└──────────┘    └───────────┘    └─────────────┘    └──────────────┘
                      │
                      ▼
               "Swap 0.01 ETH →
                min 25.50 USDC
                ✓ Verified"
```

**Step by step:**

1. User tells Claude: "swap 0.01 ETH to USDC on Base"
2. Claude calls Bankrbot API to build the transaction
3. Bankrbot returns raw transaction payload (to, data, value, chainId)
4. Claude calls `clear_sign_payload` with the payload (`validate_bankrbot_transaction` also works for canonical tx objects)
5. KaiSign verifies the contract on-chain and decodes the calldata
6. Claude shows the user a clear signing prompt with verification badge
7. User confirms or cancels
8. If confirmed, sign and broadcast the returned original `transaction` through wallet/RPC/relay/any medium

### Example: Swap ETH to USDC

**User prompt:** "swap 0.01 ETH to USDC on Base"

**Claude uses `validate_bankrbot_transaction`:**
```json
{
  "to": "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD",
  "data": "0x3593564c...",
  "chainId": 8453,
  "value": "10000000000000000"
}
```

**KaiSign returns:**
```json
{
  "verified": true,
  "source": "leaf-verified",
  "intent": "Swap 0.01 ETH → min 25.50 USDC via Uniswap Universal Router",
  "params": {
    "commands": { "label": "Commands", "value": "WRAP_ETH, V3_SWAP_EXACT_IN" },
    "deadline": { "label": "Deadline", "value": "2024-01-30 12:00:00 UTC" }
  },
  "warnings": [],
  "verification": {
    "attestationUid": "0x68b05727affff681..."
  }
}
```

**Claude shows the user:**
```
✓ Verified Transaction
Swap 0.01 ETH → min 25.50 USDC via Uniswap Universal Router

Contract: 0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD (Base)
Value: 0.01 ETH
Verification: On-chain leaf-verified

Would you like to proceed?
```

### Example: Token Approval

**User prompt:** "approve USDC spending on Base"

**KaiSign might return warnings:**
```json
{
  "verified": true,
  "source": "leaf-verified",
  "intent": "Approve unlimited USDC spending for 0xABCD...",
  "warnings": [
    "Risky selector: approve - grants token spending permission"
  ]
}
```

### Example: Unverified Contract

If the target contract doesn't have KaiSign metadata:

```json
{
  "verified": false,
  "source": "unverified",
  "intent": "Unknown function call",
  "warnings": [
    "Contract has no verified metadata in KaiSign Registry",
    "Cannot verify transaction intent"
  ]
}
```

---

## Tool Reference

### verify_contract_metadata

Verify that a contract has on-chain attested metadata.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `contractAddress` | string | Yes | — | Contract address (0x...) |
| `chainId` | number | No | 1 | Chain ID |

**Verification sources:**
- `leaf-verified` — Leaf hash matches on-chain (highest trust)
- `api-only` — Metadata found via API but no on-chain attestation
- `mismatch` — Leaf hashes don't match (suspicious)
- `error` — Verification failed

### decode_transaction

Decode transaction calldata using verified metadata.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `to` | string | Yes | — | Target contract address |
| `data` | string | Yes | — | Transaction calldata |
| `chainId` | number | No | 1 | Chain ID |
| `value` | string | No | "0" | Value in wei |
| `skipVerification` | boolean | No | false | Skip on-chain verification |

### validate_bankrbot_transaction

Validate a Bankrbot-built transaction. Combines verification + decoding + warnings.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `to` | string | Yes | — | Target contract address |
| `data` | string | Yes | — | Transaction calldata |
| `chainId` | number | No | 8453 | Chain ID (default: Base) |
| `value` | string | No | "0" | Value in wei |

### clear_sign_payload

Generic pre-sign hook for any transaction-builder payload: Bankrbot, an LLM agent, wallet, router API, or custom code. Accepts direct canonical tx fields, nested `transaction` / `tx` objects, calldata aliases, or `rawTx`, then returns normalized `transaction`, `clearSign`, and `signingPolicy`.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `to` | string | Conditional | — | Target contract address for direct payloads |
| `data` / `calldata` | string | Conditional | — | Transaction calldata for direct/nested payloads |
| `chainId` / `chain` | number/string | No | 1 | Chain ID |
| `value` | string | No | "0" | Value in wei |
| `transaction` / `tx` | object | Conditional | — | Nested tx-builder payload |
| `rawTx` / `rawTransaction` | string | Conditional | — | Serialized transaction to extract clear-sign fields |

Use this before signing/broadcasting. Sign only the returned `transaction` after policy/user approval.

### get_clear_sign_prompt

Get a formatted signing prompt for user display.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `to` | string | Yes | — | Target contract address |
| `data` | string | Yes | — | Transaction calldata |
| `chainId` | number | No | 8453 | Chain ID |
| `value` | string | No | "0" | Value in wei |

### get_cached_metadata

Check cache status for a contract.

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `contractAddress` | string | Yes | — | Contract address |
| `chainId` | number | No | 1 | Chain ID |

### clear_cache / prune_expired_cache

Cache management tools. No parameters required.

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
```
Transfer 1,000.00 USDC to 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045
✓ Verified
```

### Example 3: Build + Verify with Bankrbot

Ask Claude: "Swap 0.5 ETH for USDC on Base"

Claude will:
1. Call Bankrbot to build the swap transaction
2. Call `clear_sign_payload` to verify, decode, and produce the user display/signing policy
3. Show you the verified intent
4. Ask for confirmation before signing

---

## Troubleshooting

### "No metadata found for contract"

The contract doesn't have attested metadata in the KaiSign Registry. This is expected for most contracts — only contracts whose developers have registered metadata will be verified.

### "RPC error" or timeout

- Check your internet connection
- Try using authenticated RPC endpoints instead of public ones
- The server automatically rotates between backup RPCs

### "Bankrbot API error"

- Verify your `BANKR_API_KEY` is set correctly
- Check that the Bankrbot service is available at `https://api.bankr.bot`
- Bankrbot jobs timeout after 120 seconds

### "leaf-mismatch" verification

This means the locally computed leaf hash doesn't match what's on-chain. This could indicate:
- Metadata was recently updated (cache might be stale — try `clear_cache`)
- An integrity issue with the attestation

### Cache not working

- Cache is in-memory and resets on server restart
- Metadata TTL is 5 minutes, token metadata is 10 minutes
- Use `get_cached_metadata` to inspect cache status
