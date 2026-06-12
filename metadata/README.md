# API Metadata Files

This folder contains ERC-7730 format metadata files for submission to the KaiSign API.

## Structure

```
api-metadata/
├── dex/
│   ├── paraswap-augustus-v6.json    # ParaSwap DEX aggregator
│   ├── 0x-exchange-proxy.json       # 0x Protocol exchange
│   └── cow-protocol-settlement.json # CoW Protocol batch settlement
└── README.md
```

## Contracts Covered

| Protocol | Address | Functions |
|----------|---------|-----------|
| ParaSwap Augustus V6 | `0x6A000F20005980200259B80c5102003040001068` | simpleSwap, multiSwap, megaSwap |
| 0x Exchange Proxy | `0xDef1C0ded9bec7F1a1670819833240f027b25EfF` | transformERC20, fillRfqOrder, fillLimitOrder |
| CoW Protocol Settlement | `0x9008D19f58AAbD9eD0D60971565AA8510560ab41` | settle, setPreSignature, invalidateOrder |

## Generate a draft from verified Etherscan ABI

When local metadata is missing, start from verified ABI evidence instead of hand-typing selectors:

```bash
ETHERSCAN_API_KEY=... npm run metadata:from-etherscan -- \
  --chain=1 \
  --address=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 \
  --output=metadata/tokens/usdc-draft.json
```

The generator:
- calls Etherscan v2 `getsourcecode` / `getabi` with `chainid`
- reads `ETHERSCAN_API_KEY` from the environment or MCP `.env`
- keeps `context.contract.address` bound to the requested contract/proxy address
- uses the implementation ABI when Etherscan reports a proxy implementation
- verifies deployed bytecode with RPC unless `--no-rpc-code-check` is passed
- computes every selector from the canonical ABI signature
- emits generic `display.formats` for write functions as a reviewable skeleton

This is not final clear-signing metadata. Review and replace generic intents/field labels before registry submission. For proxies, keep the metadata address as the proxy even when the ABI source is the implementation.

## Submission

To submit these metadata files to the KaiSign API:

```bash
# Submit all files in the folder
curl -X POST https://kai-sign-production.up.railway.app/api/metadata/batch \
  -H "Content-Type: application/json" \
  -d @api-metadata/dex/*.json
```

Or submit individually via the KaiSign Builder UI.

## Format

Each file follows the ERC-7730 standard with:
- `context.contract`: Contract address, chainId, name, and ABI with selectors
- `display.formats`: Human-readable intent and field labels for each function
