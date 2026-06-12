# KaiSign CLI

Minimum viable clear-signing CLI for pasted transaction calldata or a signed raw transaction.

By default the CLI searches the local metadata folder/cache by transaction `to` + `chainId`. You can still pass `--metadata path/to/file.json` to force a specific local ERC-7730 metadata file. It does not need the backend API.

## Build

```bash
npm install
npm run build
```

## Use raw calldata

```bash
node dist/cli.js clear-sign \
  --chain 8453 \
  --to 0x1111111111111111111111111111111111111111 \
  --data 0xa9059cbb0000000000000000000000002222222222222222222222222222222222222222000000000000000000000000000000000000000000000000000000000000000a
```

`--data` and `--calldata` are aliases.
`--metadata-file` is an alias for `--metadata`.

## Use a signed serialized transaction

```bash
node dist/cli.js clear-sign --metadata ./usdc.json --tx 0x02f8...
```

`--tx` and `--raw-tx` are aliases. The CLI parses `to`, `data`, `value`, and `chainId` from the raw transaction.

## Use JSON stdin

```bash
echo '{"metadata":"./usdc.json","to":"0x1111111111111111111111111111111111111111","data":"0xa9059cbb...","chainId":8453,"value":"0"}' \
  | node dist/cli.js clear-sign --json
```

Or pass the metadata path explicitly if you want to force a file:

```bash
echo '{"to":"0x1111111111111111111111111111111111111111","data":"0xa9059cbb...","chainId":8453,"value":"0"}' \
  | node dist/cli.js clear-sign --metadata ./usdc.json --json
```

## Paste an agent payload

If an agent returns `{to,data,value,chainId}`, use either JSON output on any pasted/plaintext payload, or the interactive paste box. `--metadata` is optional, and wrapped calldata with whitespace/newlines inside the quoted hex string is normalized.

### Option 1: `--json` on plaintext

Pass/paste the whole payload as plaintext:

```bash
node dist/cli.js clear-sign --json '{"to":"0x0000000071727De22E5E9d8BAf0edAc6f37da032","value":"0x0","chainId":1,"data":"0x765e827f..."}'
```

Or pipe clipboard/stdin:

```bash
pbpaste | node dist/cli.js clear-sign --json
```

### Option 2: interactive paste box

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

## Generate local metadata from Etherscan

If a payload fails because metadata is missing, create a draft from verified Etherscan ABI evidence:

```bash
ETHERSCAN_API_KEY=*** npm run metadata:from-etherscan -- \
  --chain=1 \
  --address=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48 \
  --output=metadata/tokens/usdc-draft.json
```

Then edit `display.formats` from generic review text into real clear-signing intent, build, and replay a real payload through `node dist/cli.js clear-sign --json`.

## Files used by the CLI

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

## Output

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

## Exit codes

- `0`: decoded successfully
- `1`: decode failed or could not resolve
- `2`: invalid input
