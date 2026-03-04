# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2024-12-01

### Added

- **KaiSign MCP Server** — MCP server for verified transaction decoding
- **On-chain verification** — Cryptographic verification against KaiSign Registry on Sepolia
- **Transaction decoding** — ERC-7730 metadata-based calldata decoding
- **7 MCP tools:**
  - `verify_contract_metadata` — Verify contract against on-chain registry
  - `decode_transaction` — Decode calldata into human-readable intent
  - `validate_bankrbot_transaction` — Validate Bankrbot-built transactions
  - `get_clear_sign_prompt` — Formatted signing prompt for user confirmation
  - `get_cached_metadata` — Cache status inspection
  - `clear_cache` — Manual cache clearing
  - `prune_expired_cache` — Remove expired cache entries
- **Bankrbot integration** — API client for natural language transaction building
- **Clear signing flow** — Verification badge + decoded intent for transaction confirmation
- **Multi-chain support** — Ethereum, Base, Optimism, Arbitrum, Sepolia
- **Proxy detection** — EIP-1967, Diamond, and Safe proxy resolution
- **Smart caching** — TTL-based caching with token savings estimation
- **Test suite** — Verification tests, Bankrbot validation tests, trust proof tests
