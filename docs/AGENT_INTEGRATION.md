# KaiSign MCP Agent Integration

Direct instructions for using KaiSign MCP from Bankrbot, a generic LLM agent, a wallet, a router API, or any transaction builder.

KaiSign MCP is not a transaction builder and does not sign transactions. It takes a built transaction payload and returns clear-signing data before signing/broadcasting.

## Required flow

Every integration should follow this order:

1. Build an unsigned transaction payload.
2. Call KaiSign MCP `clear_sign_payload` with that payload.
3. Show `clearSign.displayText` to the user, or apply your autonomous policy.
4. Sign only the returned `transaction` object.
5. Broadcast the signed transaction through your normal path.

Never sign or broadcast before calling KaiSign MCP.

## Run the MCP server

Build the repo:

```bash
npm install
npm run build
```

MCP server command:

```bash
node /absolute/path/to/MCP/dist/index.js
```

From this repo on Muhammad's machine:

```bash
node /Users/muhammadaushijri/Desktop/git/MCP/dist/index.js
```

## MCP client config

Use this for any MCP-capable client:

```json
{
  "mcpServers": {
    "kaisign": {
      "command": "node",
      "args": ["/absolute/path/to/MCP/dist/index.js"]
    }
  }
}
```

If the client supports env variables and you use repo features that need them, add them:

```json
{
  "mcpServers": {
    "kaisign": {
      "command": "node",
      "args": ["/absolute/path/to/MCP/dist/index.js"],
      "env": {
        "BASE_RPC_URL": "https://...",
        "ETH_RPC_URL": "https://..."
      }
    }
  }
}
```

## Tool to call

Use `clear_sign_payload` for integrations. It accepts direct, nested, aliased, or raw transaction payloads and returns a normalized transaction plus clear-signing data.

Canonical input:

```json
{
  "to": "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD",
  "data": "0x3593564c...",
  "chainId": 8453,
  "value": "10000000000000000"
}
```

Nested builder input:

```json
{
  "transaction": {
    "to": "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD",
    "calldata": "0x3593564c...",
    "chain": "8453",
    "value": "10000000000000000"
  }
}
```

Raw transaction input:

```json
{
  "rawTx": "0x02f8..."
}
```

Accepted aliases:

- `data`, `calldata`, `input`
- `chainId`, `chain`, `networkId`
- `value`, `valueWei`, `ethValue`
- `transaction`, `tx`, `unsignedTransaction`, `unsignedTx`, `request`
- `rawTx`, `rawTransaction`, `signedRawTransaction`, `serializedTransaction`, `serialized`

## Response contract

`clear_sign_payload` returns:

```json
{
  "transaction": {
    "to": "0x...",
    "data": "0x...",
    "chainId": 8453,
    "value": "10000000000000000"
  },
  "clearSign": {
    "displayText": "✓ Verified Transaction\n\nSwap ...",
    "verified": true,
    "verificationBadge": "✓ Verified",
    "intent": "...",
    "aggregatedIntent": "...",
    "fullyDecoded": true,
    "requiresHumanReview": false,
    "safeToAutonomouslySign": true,
    "warnings": [],
    "verification": {
      "source": "leaf-verified",
      "attestationUid": "0x...",
      "metadataHash": "0x..."
    }
  },
  "signingPolicy": {
    "signOriginalTransactionOnly": true,
    "canAutonomouslySign": true,
    "mustShowToUser": false
  }
}
```

Meaning:

- `transaction`: the exact normalized transaction payload to sign.
- `clearSign.displayText`: user-facing clear-signing prompt.
- `clearSign.verified`: true only when KaiSign considers the metadata verified.
- `clearSign.fullyDecoded`: true only when calldata was decoded without unknown critical pieces.
- `clearSign.warnings`: display or enforce these before signing.
- `signingPolicy.signOriginalTransactionOnly`: never sign a modified transaction from the model; sign this returned transaction only.

## Bankrbot integration

Bankrbot does not need an LLM agent wrapper to use KaiSign MCP. Bankrbot only needs an MCP client or pre-sign hook.

Bankrbot-side required behavior:

1. Build the transaction from the user request.
2. Before signing or broadcasting, call KaiSign MCP `clear_sign_payload` with the built transaction.
3. Show `clearSign.displayText` to the user or enforce policy.
4. If approved, sign `transaction` from the MCP response.
5. Broadcast via Bankrbot's normal broadcaster.

Bankrbot pre-sign hook pseudocode:

```ts
async function beforeSignOrBroadcast(builtTx) {
  const result = await mcp.callTool('kaisign', 'clear_sign_payload', {
    transaction: builtTx
  });

  const { transaction, clearSign, signingPolicy } = JSON.parse(result.content[0].text);

  if (clearSign.warnings.length > 0) {
    showWarnings(clearSign.warnings);
  }

  if (signingPolicy.mustShowToUser) {
    const approved = await askUserToConfirm(clearSign.displayText);
    if (!approved) throw new Error('User rejected transaction');
  }

  if (!clearSign.verified || !clearSign.fullyDecoded) {
    const approved = await askUserToConfirm(
      `${clearSign.displayText}\n\nTransaction is not fully KaiSign verified. Continue?`
    );
    if (!approved) throw new Error('User rejected unverified transaction');
  }

  return transaction;
}
```

Bankrbot system/developer instruction:

```text
Before signing or broadcasting any transaction, call KaiSign MCP tool `clear_sign_payload` with the built transaction payload. Show `clearSign.displayText` to the user. If `clearSign.warnings` is non-empty, show all warnings. If `clearSign.verified` is false or `clearSign.fullyDecoded` is false, require explicit user confirmation. Sign only the returned `transaction` object. Never sign or broadcast before KaiSign MCP returns.
```

If Bankrbot currently auto-signs or auto-broadcasts immediately, add the KaiSign call as a pre-sign/pre-broadcast hook. If a pre-sign hook cannot be added, Bankrbot cannot provide pre-sign clear-signing; only post-broadcast inspection is possible.

## Generic LLM agent integration

A generic LLM agent can be the transaction builder or can call another builder. Either way, once it has a transaction payload, it calls KaiSign MCP.

Agent system/developer instruction:

```text
You may build transactions or receive transaction payloads from tools. Before asking the user to sign, before signing locally, or before broadcasting, you MUST call KaiSign MCP `clear_sign_payload` with the transaction payload.

After the tool returns:
- Show `clearSign.displayText` to the user.
- Show every item in `clearSign.warnings`.
- If `clearSign.verified` is false, `clearSign.fullyDecoded` is false, or `signingPolicy.mustShowToUser` is true, require explicit user confirmation.
- Only sign or broadcast the returned `transaction` object.
- Never modify the returned `transaction` after clear-signing. If anything changes, call `clear_sign_payload` again.
```

Agent tool-call sequence:

```text
User: Swap 0.01 ETH to USDC on Base.
Agent: Build unsigned transaction payload.
Agent -> KaiSign MCP clear_sign_payload({ transaction: builtTx })
KaiSign -> Agent: { transaction, clearSign, signingPolicy }
Agent -> User: clearSign.displayText + warnings
User -> Agent: approve/reject
Agent: if approved, sign returned transaction and broadcast.
```

## Wallet/router/custom service integration

Any service that already has `{to,data,value,chainId}` can call `clear_sign_payload` directly before opening a wallet confirmation, returning a deeplink, displaying a QR, or calling `eth_sendRawTransaction`.

Service pseudocode:

```ts
const clearSigned = await mcp.callTool('kaisign', 'clear_sign_payload', txPayload);
const { transaction, clearSign } = JSON.parse(clearSigned.content[0].text);

render(clearSign.displayText);

if (await userApproves()) {
  const signed = await wallet.signTransaction(transaction);
  await rpc.sendRawTransaction(signed);
}
```

## Policy suggestions

User-in-the-loop policy:

- Always show `clearSign.displayText`.
- Always show warnings.
- Let user decide whether to continue.

Strict autonomous policy:

- Continue only if all are true:
  - `clearSign.verified === true`
  - `clearSign.verification.source === "leaf-verified"`
  - `clearSign.fullyDecoded === true`
  - `clearSign.safeToAutonomouslySign === true`
  - `clearSign.warnings.length === 0`
  - `signingPolicy.canAutonomouslySign === true`

Otherwise halt or require human confirmation.

## Minimal integration checklist

- [ ] MCP client configured with KaiSign server.
- [ ] Transaction builder returns payload before signing/broadcasting.
- [ ] Pre-sign hook calls `clear_sign_payload`.
- [ ] UI/agent displays `clearSign.displayText` and warnings.
- [ ] Signer signs only returned `transaction`.
- [ ] If transaction changes, call `clear_sign_payload` again.
