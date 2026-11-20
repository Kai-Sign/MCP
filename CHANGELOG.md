# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Nethermind light client support** (NethermindEth/nethermind#14457) — `LIGHT_CLIENT_RPC_URL` routes registry reads (`smtRoot`, attestations) and proxy-slot reads through the locally verified light-client RPC; results report `registryReadVia`. Registry log replay uses 512-block chunks, falling back to public RPCs only for root-checked log input (`LIGHT_CLIENT_ONLY=true` disables).
- **KaiSign Wallet RPC** (`npm run start:wallet-rpc`, `kaisign-wallet-rpc`) — wallet-facing RPC in front of the light client that holds each `eth_sendRawTransaction`, clear-signs it, and relays it after one-click approval (browser page, terminal `y`/`n`, or `--auto-approve safe`). Maps `pending`/`safe` block tags and serves pending nonces so stock wallets work with the light client.
- Gnosis (chain 100) RPC defaults and Gnosis/Hoodi chain names.

## [1.0.0] - 2024-12-01

### Added

- **KaiSign MCP Server** — MCP server for verified transaction decoding
- **On-chain verification** — Cryptographic verification against KaiSign Registry on Sepolia
- **Transaction decoding** — ERC-7730 metadata-based calldata decoding
- **7 MCP tools:**
  - `verify_contract_metadata` — Verify contract against on-chain registry
  - `decode_transaction` — Decode calldata into human-readable intent
  - `validate_transaction` — Validate transaction payloads
  - `get_clear_sign_prompt` — Formatted signing prompt for user confirmation
  - `get_cached_metadata` — Cache status inspection
  - `clear_cache` — Manual cache clearing
  - `prune_expired_cache` — Remove expired cache entries
- **Clear signing flow** — Verification badge + decoded intent for transaction confirmation
- **Multi-chain support** — Ethereum, Base, Optimism, Arbitrum, Sepolia
- **Proxy detection** — EIP-1967, Diamond, and Safe proxy resolution
- **Smart caching** — TTL-based caching with token savings estimation
- **Test suite** — Verification tests, transaction validation tests, trust proof tests
