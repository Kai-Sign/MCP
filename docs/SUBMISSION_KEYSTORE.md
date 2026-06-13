# KaiSign Submission Setup

This note is for users/agents who generate local ERC-7730 metadata and want to submit it to KaiSign's Sepolia registry `0xf70D41afe5Ff76Ac3Bee86BCBda07450f3b590F0`.

There are two paths. **The sponsored path is recommended** — it does not require the permissioned bond token.

### Sepolia addresses (verify live before relying on these)

| | Address |
|---|---|
| Registry (proxy) | `0xf70D41afe5Ff76Ac3Bee86BCBda07450f3b590F0` |
| SubmissionSponsor | `0x8a9d99D4EF98A342FeE36Bb80F62381906E02cA8` |
| Bond token (pBTOKEN, permissioned) | `0x8Bab26B2Efe3f4C72644413671437B4D423E16F1` |
| Reality.eth ERC20 | `0xCC982820EEf54D1E518BD31e7f6467E793352126` |

`minBond` is `0.1` pBTOKEN. The registry attests metadata for contracts on **any** chain (the target `chainId` and its bytecode hash are submitted as data); the registry itself lives on Sepolia.

## Path A (recommended): sponsored, gas-only via a burner

A `SubmissionSponsor` contract (`0x8a9d99D4EF98A342FeE36Bb80F62381906E02cA8`) holds the bond pool and posts the bond on your behalf. **You only need Sepolia gas — no permissioned bond token.** The tool generates a dedicated **burner** address that posts the EIP-4844 blob and calls the sponsor's `sponsoredCommit` / `sponsoredReveal`.

```bash
# 1. Generate an encrypted burner (bound to the sponsor). Prints the address to fund.
mkdir -p .kaisign
openssl rand -base64 32 > .kaisign/burner-password.txt
npm run submission:keystore -- init-burner --password-file=.kaisign/burner-password.txt

# 2. Fund the printed burner address with a little Sepolia ETH (GAS ONLY — no bond token).
#    A real submission posts a blob + 2 contract calls; budget ~0.05–0.1 ETH at busy gas.
#    The user, an agent, or the backend can fund it.

# 3. Submit. Posts the blob, runs sponsoredCommit, waits one block, then sponsoredReveal.
npm run submission:keystore -- submit-sponsored \
  --metadata=metadata/tokens/usdc-draft.json \
  --password-file=.kaisign/burner-password.txt
```

Output includes `blobHash` (+ a blobscan URL), `blobTx` (null if the blob was posted externally), `commitTx`, `commitmentId`, `revealTx`, `uid`, and `questionId`. The sponsor is recorded as the on-chain attester; the burner is logged as the triggering user in the `SponsoredReveal` event (that event is the only link from the attestation back to the real submitter).

### Who posts the blob

An EIP-4844 blob (type-3) tx **must be sent by an EOA — a contract cannot post a blob.** The registry only stores the blob's versioned hash; the blob data itself lives on the beacon chain / blob archives (Blobscan, etc.). You have two options:

- **Burner posts it (default).** `submit-sponsored` builds the blob and sends the type-3 tx from the burner, then commits/reveals. Requires the native `c-kzg` library (`npm i c-kzg` — already a dependency here) and `ethers` v6. This is the simplest, fully self-contained path.

- **Backend (or any EOA) posts it; tool just commits/reveals.** Post the blob elsewhere, then pass its versioned hash so the burner does only the two sponsor calls (no `c-kzg` needed locally):

  ```bash
  npm run submission:keystore -- submit-sponsored \
    --metadata=metadata/tokens/usdc-draft.json \
    --blob-hash=0x01... \
    --password-file=.kaisign/burner-password.txt
  ```

  > The supplied `--blob-hash` MUST be the versioned hash of a blob whose data encodes **exactly these metadata bytes** (the on-chain `metadataHash` is computed from the local file; if the posted blob's content differs, the attestation will point at the wrong/again-unretrievable data). The backend posts the blob from its own funded EOA; the tool does not call the backend automatically — you pass the hash it returns.

Notes:
- The burner key is stored **encrypted** in `.kaisign/burner.json` (`kind: kaisign-burner`, distinct from Path B's keyless manifest). Fund it with gas only and treat it as disposable.
- No bond token is ever pulled from the burner — the sponsor's pool covers `minBond` per submission.
- The reveal creates a Reality.eth question and is the expensive call; budget gas accordingly.
- `submit-sponsored` waits one block between commit and reveal (the registry enforces `MIN_REVEAL_DELAY`); commit and reveal cannot be the same transaction.

## Path B: direct (you bring your own bond-token-holding address)

Use this only if you specifically want to hold the permissioned bond token and sign yourself. **This tool holds no private key for Path B** — you bring your own submitter address and sign every transaction with your own wallet. The tool records your address as a public scope manifest in `.kaisign/submission-keystore.json`, checks eligibility (gas + bond tokens), and **prepares** unsigned commit/reveal/vote transactions. You sign and broadcast them.

Use a **dedicated address** that holds only Sepolia gas + KaiSign bond tokens — not a personal/hardware/mainnet wallet.

`.kaisign/` is gitignored. Keep it local.

> If you have an older `.kaisign/submission-keystore.json` that embedded an encrypted wallet, delete it and re-run `init`. The Path B manifest refuses any keystore containing signing material (Path A uses a separate `.kaisign/burner.json`).

The rest of this document covers Path B.

## 1. Get an Etherscan API key

The metadata generator uses Etherscan only to fetch verified ABI/source evidence. The key is not a signing key.

1. Create/sign in to an Etherscan account.
2. Open API Keys in the Etherscan dashboard.
3. Create a key for local development.
4. Put it in the MCP repo-local `.env` or export it in your shell:

```bash
ETHERSCAN_API_KEY=...
```

Then generate a draft metadata file from a verified contract:

```bash
npm run metadata:from-etherscan -- \
  --chain=1 \
  --address=0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48 \
  --output=metadata/tokens/usdc-draft.json
```

Review and improve the generated display text before submission. ABI-derived generic display text is not enough by itself.

## 2. Prepare your own submitter address

Create or pick an address you control (a fresh burner is recommended). Get its public address from your wallet, then record it:

```bash
mkdir -p .kaisign
npm run submission:keystore -- init --address=0xYourSubmitterAddress
```

This writes `.kaisign/submission-keystore.json` containing only your public address, the registry, and the allowed submission selectors. No password, no key. You will sign with your own wallet in later steps.

## 3. Check whether the submitter is eligible to submit

```bash
npm run submission:keystore -- status
```

The status command checks the recorded address on Sepolia:

- Sepolia ETH balance for gas
- KaiSign bond token balance
- registry address
- bond token address
- Reality.eth address
- current `minBond()`
- whether the address is funded enough for submission

The address is eligible only if it has:

- Sepolia ETH for gas
- at least `minBond()` bond tokens for the reveal/vote path

If `eligible` is false, fund the address shown by `status` (gas + bond tokens). The KaiSign bond token is permissioned — see the project for how to obtain it for your submitter address.

## 4. Prepare the commit transaction

```bash
npm run submission:keystore -- prepare-commit \
  --metadata=metadata/tokens/usdc-draft.json
```

The command uses your recorded submitter address as `from`. There is no `--from` argument.

It computes:

- target contract deployment from the metadata file
- live `extcodehash`
- metadata hash from exact file bytes
- blob versioned hash when `c-kzg` is installed, or accepts `--blob-hash=0x01...`
- random commit nonce
- unsigned `commitSpec(bytes32,uint256,bytes32)` transaction

It writes a state file under `.kaisign/submission-state/`.

### Blob hash and posting the blob

The submission references a blob (EIP-4844) carrying the metadata, and the blob must actually be **posted on-chain by an EOA** (a contract cannot post a blob) so the metadata is retrievable. The registry stores only the versioned hash.

Computing the blob versioned hash locally requires the native `c-kzg` library (`npm i c-kzg`). If you upload the blob with an external tool or the backend, skip the local install and pass the versioned hash it returns:

```bash
npm run submission:keystore -- prepare-commit \
  --metadata=metadata/tokens/usdc-draft.json \
  --blob-hash=0x01...
```

In Path B you are responsible for posting the blob yourself (from your own EOA, or via the backend) in addition to signing commit/reveal. Whatever blob you post must encode exactly the metadata file bytes, so its content hash matches the on-chain `metadataHash`. (Path A's `submit-sponsored` automates the blob post for you.)

Sign and broadcast the commit transaction from your submitter address (see "Signing and broadcasting" below). Read `commitmentId` from the `LogCommitSpec` event in the receipt.

## 5. Prepare the reveal transaction

```bash
npm run submission:keystore -- prepare-reveal \
  --state=.kaisign/submission-state/<file>.json \
  --commitment-id=0x...
```

The command again uses your recorded submitter address. It outputs:

1. exact ERC20 approval to the registry for `minBond()`
2. unsigned registry `revealSpec(...)`

Approvals are exact needed amounts, not max allowance. Sign and broadcast both, in order.

## 6. Prepare the Reality.eth valid vote

After reveal creates a Reality.eth question:

```bash
npm run submission:keystore -- prepare-vote --question-id=0x...
```

The command outputs:

1. exact ERC20 approval to the Reality.eth ERC20 instance
2. unsigned `submitAnswerERC20(...)` vote with VALID answer

## 7. Verify a prepared transaction

```bash
npm run submission:keystore -- verify-tx --tx=.kaisign/submission-state/<file>.json
```

The verifier checks that:

- `chainId` is Sepolia
- `to` is the scoped KaiSign registry for registry calls (or a known scoped spender for approvals)
- selector is an allowed submission selector
- `from`, when present, matches your recorded submitter address

This is an inspection aid, not an enforcement boundary — you control the key and the wallet that signs.

## Signing and broadcasting

The tool emits **unsigned** transaction objects (`{to, from, data, value, chainId}`). Sign each with the wallet that controls your submitter address and broadcast it on Sepolia. Two common paths:

- **Your own wallet / RPC:** import the tx into your signer (or script it with your key) and send via any Sepolia RPC.
- **KaiSign backend relay:** broadcast the signed raw tx through the backend's `POST /eth/sendRawTransaction` endpoint (it forwards to the configured Sepolia RPC; it does not sign).

Either way the private key never enters this tool.

## Do not submit metadata unless

- the contract is real or the metadata is valid EIP-712/off-chain metadata
- ABI evidence is authoritative/verified
- selector proof matches live code/proxy/diamond state
- display text is meaningful and not generic garbage
- local clear-sign output was tested
- your submitter address is funded and eligible
