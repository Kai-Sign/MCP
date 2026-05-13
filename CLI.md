# KaiSign CLI

Minimum viable clear-signing CLI for pasted transaction calldata or a signed raw transaction.

The CLI takes metadata from a local JSON path. It does not need the backend API.

## Build

```bash
npm install
npm run build
```

## Use raw calldata

```bash
node dist/cli.js clear-sign \
  --metadata ./usdc.json \
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

Or put the metadata path in the flag:

```bash
echo '{"to":"0x1111111111111111111111111111111111111111","data":"0xa9059cbb...","chainId":8453,"value":"0"}' \
  | node dist/cli.js clear-sign --metadata ./usdc.json --json
```

## Files used by the CLI

Runtime entrypoint:

- `src/cli.ts` -> `dist/cli.js`
  - parses `clear-sign`, `--metadata`, `--to`, `--data`, `--tx`, stdin JSON, and output mode

Clear-sign flow:

- `src/tools/clear-sign-transaction.ts`
  - loads the local metadata JSON path into the metadata cache
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
  - in CLI local-file mode, metadata is already cached from `--metadata`; no backend API fetch is needed
- `src/services/cache-manager.ts`
  - stores the local metadata for the target contract during the CLI run
- `src/services/metadata-hash.ts`
  - used only when verification data exists; local-file CLI mode does not require backend fetch
- `src/config/constants.ts`
  - shared constants used by services

CLI tests/docs:

- `tests/cli.test.ts`
- `tests/metadata-hash.test.ts`
- `CLI.md`

## Output

Plain output:

```text
⚠ KaiSign not fully verified
Safe to sign: yes
Source: local-file
Function: transfer
Intent: Transfer 10 USDC to 0x...
```

JSON output:

```bash
node dist/cli.js clear-sign --metadata ./usdc.json --tx 0x02f8... --json
```

## Exit codes

- `0`: decoded with the provided metadata and safe to sign
- `1`: ran but could not fully clear-sign / not safe
- `2`: invalid input
