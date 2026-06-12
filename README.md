# KaiSign MCP Server

**Verified transaction decoding for LLM agents using on-chain attested metadata.**

This is an MCP (Model Context Protocol) server for the KaiSign on-chain registry — enabling AI agents to decode Ethereum transactions with cryptographic proof of authenticity. Instead of trusting external APIs like Etherscan for ABIs, this server verifies contract metadata against KaiSign's on-chain attestations — giving users confidence that decoded transaction intent is genuine.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen)](https://nodejs.org)
[![MCP](https://img.shields.io/badge/MCP-Compatible-purple)](https://modelcontextprotocol.io)

---

## The Problem

When an AI agent builds a transaction from natural language (e.g., "swap 0.01 ETH to USDC"), the result is raw calldata:

```
to: 0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD
data: 0x3593564c000000000000000000000000...
value: 10000000000000000
```

**How do you know this actually swaps ETH to USDC and doesn't drain your wallet?**

Without KaiSign, you either trust an external API for the ABI (which could be compromised, outdated, or wrong) or show the user meaningless bytes. With KaiSign, the metadata is **cryptographically verified on-chain** — attested by the contract developer and tamper-proof.

## How It Works

```
User prompt: "swap 0.01 ETH to USDC"
        │
        ▼
┌─────────────────┐     ┌──────────────────────┐     ┌─────────────────────┐
│   Bankrbot API  │────▶│  KaiSign MCP Server   │────▶│  KaiSign Registry   │
│  (builds tx)    │     │  (verifies + decodes) │     │  (Sepolia on-chain) │
└─────────────────┘     └──────────────────────┘     └─────────────────────┘
                                │
                                ▼
                    "Swap 0.01 ETH → min 25.50 USDC
                     via Uniswap Universal Router"
                              ✓ Verified
```

**Verification flow:**
1. Get `extcodehash` (keccak256 of contract bytecode) from the target chain
2. Query the KaiSign Registry on Sepolia for the attestation UID
3. Parse the attestation and compute the leaf hash locally
4. Compare against the on-chain computed leaf hash
5. If they match, the metadata is **authentic and attested by the contract developer**

## Features

- **On-chain verification** — Metadata verified against the KaiSign Registry (Sepolia), not trusted from external APIs
- **Transaction decoding** — Raw calldata decoded into human-readable intent using ERC-7730 metadata
- **Bankrbot integration** — Validate transactions built by [Bankrbot](https://bankr.bot) from natural language
- **Clear signing prompts** — Formatted transaction confirmations with verification badges
- **Selector lookup for builders** — Agents can fetch canonical function signatures/selectors by exact address + chain before encoding, instead of relying on model memory
- **Multi-chain support** — Ethereum, Base, Optimism, Arbitrum, and Sepolia
- **Proxy detection** — Automatic resolution of EIP-1967, Diamond, and Safe proxy contracts
- **Smart caching** — TTL-based caching for metadata and token info, reducing redundant RPC calls
- **Token efficiency** — Server-side processing keeps ABIs off LLM context (~150-250 tokens per response vs 3000-7000 without)

## Deployed Contracts & Supported Networks

### KaiSign Registry

| Network | Address | Purpose |
|---------|---------|---------|
| **Sepolia** | `0xC203e8C22eFCA3C9218a6418f6d4281Cb7744dAa` | On-chain attestation registry |

### Verified Contracts (Examples)

These contracts have on-chain attested metadata in the KaiSign Registry and can be used for testing:

| Contract | Network | Address | Chain ID |
|----------|---------|---------|----------|
| Uniswap Universal Router | Base | `0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD` | 8453 |
| USDC | Base | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | 8453 |
| USDC | Ethereum | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | 1 |

### Supported Chains

| Chain | Chain ID | Default RPC |
|-------|----------|-------------|
| Ethereum Mainnet | 1 | `https://ethereum-rpc.publicnode.com` |
| Optimism | 10 | `https://optimism-rpc.publicnode.com` |
| Base | 8453 | `https://base-rpc.publicnode.com` |
| Arbitrum | 42161 | `https://arbitrum-one-rpc.publicnode.com` |
| Sepolia (testnet) | 11155111 | `https://ethereum-sepolia-rpc.publicnode.com` |

## Quick Start

For a step-by-step local MCP setup, smoke test, Claude config, and optional HTTP/tunnel setup, see [docs/LOCAL_MCP_TUTORIAL.md](docs/LOCAL_MCP_TUTORIAL.md).

For direct Bankrbot / LLM agent / wallet integration instructions, see [docs/AGENT_INTEGRATION.md](docs/AGENT_INTEGRATION.md).

For the minimal command-line clear-signing tool, see [docs/CLI.md](docs/CLI.md). It supports pasted calldata (`--data` / `--calldata`), signed raw transactions (`--tx` / `--raw-tx`), and JSON stdin.

### Prerequisites

- Node.js >= 18.0.0
- npm

### Installation

```bash
git clone https://github.com/Kai-Sign/MCP.git
cd MCP
npm install
npm run build
```

### Configuration

Copy the example environment file and add your keys:

```bash
cp .env.example .env
```

```env
# Required for Bankrbot integration
BANKR_API_KEY=your_bankr_api_key

# Optional: Custom RPC URLs (public defaults are included)
ETH_RPC_URL=https://your-eth-rpc.com
BASE_RPC_URL=https://your-base-rpc.com
```

### Run the Server

```bash
# Production
npm start

# Development (with ts-node)
npm run dev
```

### Connect to Claude

Add the KaiSign MCP server to your Claude configuration:

**Claude Desktop** (`~/Library/Application Support/Claude/claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "kaisign": {
      "command": "node",
      "args": ["/absolute/path/to/MCP/dist/index.js"],
      "env": {
        "BANKR_API_KEY": "your_bankr_api_key"
      }
    }
  }
}
```

**Claude Code** (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "kaisign": {
      "command": "node",
      "args": ["/absolute/path/to/MCP/dist/index.js"],
      "env": {
        "BANKR_API_KEY": "your_bankr_api_key"
      }
    }
  }
}
```

## Usage Guide

### Tool 1: Verify Contract Metadata

Check if a contract has on-chain verified metadata in the KaiSign Registry.

```
Tool: verify_contract_metadata
Input: {
  "contractAddress": "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD",
  "chainId": 8453
}
```

**Response:**
```json
{
  "verified": true,
  "source": "leaf-verified",
  "attestationUid": "0x68b05727affff681...",
  "metadataHash": "0x1a2b3c...",
  "idx": 0,
  "revoked": false
}
```

### Tool 2: Decode Transaction

Decode raw calldata into human-readable intent using verified metadata.

```
Tool: decode_transaction
Input: {
  "to": "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD",
  "data": "0x3593564c...",
  "chainId": 8453,
  "value": "10000000000000000"
}
```

**Response:**
```json
{
  "verified": true,
  "source": "leaf-verified",
  "functionName": "execute",
  "intent": "Wrap ETH to WETH + Swap via V3_SWAP_EXACT_IN",
  "params": {
    "commands": { "label": "Commands", "value": "WRAP_ETH, V3_SWAP_EXACT_IN" },
    "deadline": { "label": "Deadline", "value": "2024-01-30 12:00:00 UTC" }
  }
}
```

### Tool 3: Validate Bankrbot Transaction

Validate a transaction built by Bankrbot against the KaiSign Registry. This is the primary tool for the agent signing flow.

```
Tool: validate_bankrbot_transaction
Input: {
  "to": "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD",
  "data": "0x3593564c...",
  "chainId": 8453,
  "value": "10000000000000000"
}
```

**Response:**
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
  "transaction": { "to": "0x3fc9...", "selector": "0x3593564c", "chainId": 8453 },
  "verification": { "attestationUid": "0x68b05..." }
}
```

### Tool 4: Clear Sign Any Tx-Builder Payload

Generic pre-sign hook for any transaction builder: Bankrbot, an LLM agent, a wallet, a router API, or custom code. Use this when the builder returns direct `{to,data,value,chainId}`, nested `{transaction:{...}}` / `{tx:{...}}`, calldata aliases, or a serialized raw transaction.

```
Tool: clear_sign_payload
Input: {
  "transaction": {
    "to": "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD",
    "calldata": "0x3593564c...",
    "chain": "8453",
    "value": "10000000000000000"
  }
}
```

**Response shape:**
```json
{
  "transaction": { "to": "0x...", "data": "0x...", "value": "...", "chainId": 8453 },
  "clearSign": {
    "displayText": "✓ Verified Transaction\n\nSwap ...",
    "verified": true,
    "fullyDecoded": true,
    "requiresHumanReview": false,
    "safeToAutonomouslySign": true,
    "warnings": [],
    "verification": { "source": "leaf-verified" }
  },
  "signingPolicy": {
    "signOriginalTransactionOnly": true,
    "canAutonomouslySign": true,
    "mustShowToUser": false
  }
}
```

Sign/broadcast only the returned `transaction`, after user/agent policy approval. KaiSign does not modify or sign the transaction.

### Tool 5: Get Function Selectors

Resolve canonical function signatures/selectors from KaiSign metadata for one exact target address and chain before encoding calldata.

This exists because agents can hallucinate selectors from training data. In one real test, Claude Sonnet 4.6 encoded Alchemy LightAccount V2 `executeBatch` as `executeBatch((address,uint256,bytes)[])` (`0x34fcd5be`) by relying on remembered smart-account patterns. That selector belongs to other account implementations, not the Alchemy LightAccount V2 contract at `0x8E8e658E22B12ada97B402fF0b044D6A325013C7`. The correct ABI entry for that address on mainnet is `executeBatch(address[] dest,uint256[] value,bytes[] func)` (`0x47e1da2a`).

Builder UX: users should be able to provide only chainId, contracts, and desired actions. The MCP tool descriptions tell agents that this is enough context to produce an unsigned transaction. Agents should use `get_function_selectors` automatically for each target contract they plan to encode, choose any realistic call path/nesting whose selectors exist on those exact contracts, call `clear_sign_payload` on the final unsigned transaction, and output only `to`, `data`, `value`, and `chainId` unless the caller asks for more.

```
Tool: get_function_selectors
Input: {
  "contractAddress": "0x8E8e658E22B12ada97B402fF0b044D6A325013C7",
  "chainId": 1,
  "functionName": "executeBatch"
}
```

**Response shape:**
```json
{
  "contractAddress": "0x8e8e658e22b12ada97b402ff0b044d6a325013c7",
  "chainId": 1,
  "contractName": "Alchemy LightAccount V2",
  "found": true,
  "functions": [
    {
      "name": "executeBatch",
      "signature": "executeBatch(address[],uint256[],bytes[])",
      "selector": "0x47e1da2a",
      "displayFormat": true
    }
  ]
}
```

### Tool 6: Get Clear Sign Prompt

Lower-level direct-payload formatter for user confirmation with verification badges. Use when you already have canonical `{to,data,chainId,value}`.

```
Tool: get_clear_sign_prompt
Input: {
  "to": "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD",
  "data": "0x3593564c...",
  "chainId": 8453,
  "value": "10000000000000000"
}
```

**Response:**
```
┌─────────────────────────────────────────┐
│  ✓ Verified Transaction                 │
│                                         │
│  Swap 0.01 ETH → min 25.50 USDC        │
│  via Uniswap Universal Router           │
│                                         │
│  Contract: 0x3fC9...7FAD (Base)         │
│  Value: 0.01 ETH                        │
│                                         │
│  [Confirm]  [Cancel]                    │
└─────────────────────────────────────────┘
```

### Tool 7: Cache Management

```
# Check cache status for a contract
Tool: get_cached_metadata
Input: { "contractAddress": "0x3fC9...", "chainId": 8453 }

# Clear all cached data
Tool: clear_cache

# Remove expired entries
Tool: prune_expired_cache
```

## Using with Bankrbot

[Bankrbot](https://bankr.bot) is an LLM-based transaction building agent that accepts natural language prompts and builds Ethereum transactions.

### End-to-End Flow (User-in-the-Loop)

1. **User says:** "swap 0.01 ETH to USDC on Base"
2. **Bankrbot** builds the unsigned transaction (calldata, target contract, value)
3. **KaiSign MCP** clear-signs the built payload via `clear_sign_payload` (or `get_clear_sign_prompt` for canonical tx shape)
4. **KaiSign MCP** verifies the contract against the on-chain registry
5. **KaiSign MCP** decodes the calldata into human-readable intent
6. **User sees:** "Swap 0.01 ETH → min 25.50 USDC via Uniswap Universal Router ✓ Verified"
7. **User confirms** and signs the original transaction
8. **Signed tx is broadcast** through wallet/RPC/relay/any medium

### Autonomous Agent Flow

The same flow works without user confirmation — the LLM verifies and decides on its own:

1. **A transaction builder** (Bankrbot, an LLM agent, wallet, router API, or custom code) builds unsigned tx payload from the request
2. **The caller** calls `clear_sign_payload` on KaiSign MCP → verifies contract metadata on-chain + decodes intent
3. **The caller** checks: `clearSign.verified: true`, `clearSign.fullyDecoded: true`, no warnings, intent matches original request
4. **The caller** proceeds to sign/broadcast the returned `transaction`, or halts based on verification/policy result

```
LLM prompt: "swap 0.01 ETH to USDC on Base"
        │
        ▼
┌─────────────────┐     ┌──────────────────────┐     ┌──────────────┐
│   Bankrbot API  │────▶│  KaiSign MCP Server   │────▶│  LLM decides │
│  (unsigned tx)  │     │  (verify + decode)    │     │  (proceed?)  │
└─────────────────┘     └──────────────────────┘     └──────────────┘
```

This is useful for fully autonomous agents that need to transact without human oversight while still maintaining cryptographic trust guarantees. The LLM never signs a transaction it can't independently verify.

### Setup

1. Get a Bankrbot API key from [bankr.bot](https://bankr.bot)
2. Set `BANKR_API_KEY` in your environment
3. Connect the KaiSign MCP server to Claude
4. Ask Claude to build and verify transactions using natural language

### Example: User-in-the-Loop

```
You: "Swap $10 of ETH to USDC on Base"

Claude: I'll build this transaction using Bankrbot and verify it with KaiSign.

[Calls validate_bankrbot_transaction]

✓ Verified Transaction
Swap 0.01 ETH → min 25.50 USDC via Uniswap Universal Router

Contract: 0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD (Base)
Value: 0.01 ETH
Verification: On-chain leaf-verified

Would you like to proceed with this transaction?
```

### Example: Autonomous Agent

```
Agent: Build swap 0.01 ETH to USDC on Base
  → Bankrbot returns unsigned tx {to, data, value, chainId}

Agent: Verify transaction with KaiSign
  → verified: true, source: leaf-verified
  → intent: "Swap 0.01 ETH → min 25.50 USDC via Uniswap Universal Router"
  → warnings: []

Agent: Verification passed, intent matches request → proceeding
```

## Architecture

```
src/
├── index.ts                      # MCP server entry point
├── config/
│   └── constants.ts              # RPC URLs, registry address, API endpoints
├── services/
│   ├── onchain-verifier.ts       # Cryptographic verification against registry
│   ├── metadata-service.ts       # ERC-7730 metadata fetching + proxy detection
│   ├── abi-decoder.ts            # Transaction calldata decoding engine
│   ├── cache-manager.ts          # TTL-based caching with token estimation
│   └── bankrbot-client.ts        # Bankrbot API client
└── tools/
    ├── verify-metadata.ts        # verify_contract_metadata tool
    ├── decode-transaction.ts     # decode_transaction tool
    ├── validate-bankrbot-tx.ts   # validate_bankrbot_transaction tool
    ├── clear-sign-payload.ts     # clear_sign_payload generic tx-builder pre-sign hook
    ├── get-function-selectors.ts # get_function_selectors exact-address ABI selector lookup
    ├── get-clear-sign-prompt.ts  # get_clear_sign_prompt tool
    └── get-cached-metadata.ts    # Cache management tools
```

### Trust Model

| Aspect | Without KaiSign | With KaiSign |
|--------|----------------|--------------|
| **ABI Source** | Etherscan, hardcoded, unknown | On-chain registry (Sepolia) |
| **Verification** | None | Cryptographic (leaf hash) |
| **Trust** | API provider | Math (keccak256) |
| **Tampering** | Possible | Detected immediately |
| **Proxy Support** | Manual resolution | Automatic (EIP-1967, Diamond, Safe) |
| **Cross-Chain** | Per-chain setup | Single registry, any chain |

For a detailed comparison, see [docs/KAISIGN_VS_WITHOUT.md](docs/KAISIGN_VS_WITHOUT.md).

## Development

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build for production
npm run build

# Run tests
npm test

# Run tests once (no watch)
npm run test:run
```

### Running Tests

Tests use [Vitest](https://vitest.dev) and make real RPC calls to verify on-chain data:

```bash
# Standard tests (verification + validation)
npm test

# With Bankrbot integration (requires API key, consumes real funds)
BANKR_API_KEY=your_key BANKR_TEST=1 npm run test:run
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `BANKR_API_KEY` | For Bankrbot | — | Bankrbot API key |
| `BANKR_API_URL` | No | `https://api.bankr.bot` | Bankrbot API endpoint |
| `KAISIGN_METADATA_DIR` | No | auto-detects repo-local `metadata/` | Local ERC-7730 metadata directory |
| `ETH_RPC_URL` | No | Public RPC | Ethereum Mainnet RPC |
| `BASE_RPC_URL` | No | Public RPC | Base RPC |
| `OPTIMISM_RPC_URL` | No | Public RPC | Optimism RPC |
| `ARBITRUM_RPC_URL` | No | Public RPC | Arbitrum RPC |
| `SEPOLIA_RPC_URL` | No | Public RPC | Sepolia testnet RPC |

## Contributing

Contributions are welcome! Please read the [Contributing Guide](CONTRIBUTING.md) before submitting a pull request.

## Security

For security concerns, please see our [Security Policy](SECURITY.md). Do not open public issues for security vulnerabilities.

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

## Links

- [KaiSign Registry (Sepolia)](https://sepolia.etherscan.io/address/0xC203e8C22eFCA3C9218a6418f6d4281Cb7744dAa)
- [Bankrbot](https://bankr.bot)
- [Model Context Protocol](https://modelcontextprotocol.io)
- [ERC-7730 Specification](https://eips.ethereum.org/EIPS/eip-7730)
