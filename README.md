# KaiSign MCP Server

MCP server for verified transaction decoding using the KaiSign Registry.

## Features

- **verify_contract_metadata**: Verify metadata against on-chain registry
- **decode_transaction**: Decode calldata using verified ERC-7730 metadata
- **get_cached_metadata**: Check cache status and token savings

## Quick Start

```bash
npm install
npm run build
npm start
```

## Testing with Claude

Add to your MCP config:

```json
{
  "mcpServers": {
    "kaisign": {
      "command": "node",
      "args": ["/path/to/MCP/dist/index.js"]
    }
  }
}
```

## Development

```bash
npm run dev      # Run with ts-node
npm test         # Run tests
npm run build    # Build TypeScript
```
