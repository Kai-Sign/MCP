# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in this project, please report it responsibly.

**Do not open a public GitHub issue for security vulnerabilities.**

Instead, please email security concerns to the project maintainers with:

1. A description of the vulnerability
2. Steps to reproduce
3. Potential impact
4. Suggested fix (if any)

We will acknowledge receipt within 48 hours and aim to provide a fix within 7 days for critical issues.

## Scope

### In Scope

- KaiSign MCP server code (`src/`)
- On-chain verification logic
- Metadata parsing and decoding
- API client implementations

### Out of Scope

- The KaiSign Registry smart contract (separate repository)
- Third-party RPC providers
- Claude/MCP protocol itself

## Security Model

KaiSign's security relies on:

1. **On-chain verification** — Metadata is verified by computing leaf hashes locally and comparing against the KaiSign Registry on Sepolia. This is a trustless, cryptographic check.

2. **Extcodehash binding** — Metadata is bound to the keccak256 hash of contract bytecode, meaning it cannot be applied to the wrong contract.

3. **Attestation integrity** — Attestations are signed on-chain and include a revocation flag. Revoked attestations are flagged in verification results.

### Known Limitations

- **RPC trust** — The server trusts RPC responses for bytecode and registry reads. Use trusted RPC providers in production.
- **Public RPC defaults** — Default RPC URLs are public endpoints suitable for development. Replace with authenticated endpoints for production use.
- **In-memory cache** — Cache is not persisted and resets on server restart. Cache entries have TTL expiration.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.x     | Yes       |

## Best Practices

When deploying KaiSign MCP Server:

- Use authenticated RPC endpoints (Alchemy, Infura, etc.) instead of public defaults
- Store API keys in environment variables, never in code
- Keep dependencies updated (`npm audit`)
- Review transaction warnings before signing — even verified contracts can have risky operations
