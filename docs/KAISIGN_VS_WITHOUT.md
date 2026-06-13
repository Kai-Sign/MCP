# KaiSign vs Without KaiSign

## The Problem: How Does an LLM Know What a Transaction Does?

When a user says "swap 0.01 ETH to USDC", the agent builds a transaction. But the transaction is just bytes:

```
to: 0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD
data: 0x3593564c000000000000000000000000000000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000000000a00000000000000000000000000000000000000000000000000000000065b8f70000000000000000000000000000000000000000000000000000000000000000020b00...
value: 10000000000000000
```

**How do you know this actually swaps ETH to USDC and doesn't drain your wallet?**

---

## Without KaiSign

### Step 1: Fetch ABI from Somewhere

The LLM needs the contract ABI to decode the transaction. Options:

1. **Etherscan API** - Trusting a centralized service
2. **Hardcoded ABIs** - Hoping they're correct and up-to-date
3. **Ask the user** - Bad UX

```typescript
// Fetching ABI from Etherscan
const response = await fetch(
  `https://api.etherscan.io/api?module=contract&action=getabi&address=${address}`
);
const abi = JSON.parse(response.result);
```

**Problems:**
- Etherscan could be compromised
- ABI could be for wrong contract version
- Proxy contracts need implementation ABI
- Rate limits, API keys, etc.

### Step 2: Decode with Untrusted ABI

```typescript
const iface = new Interface(abi); // ABI from unknown source
const decoded = iface.parseTransaction({ data, value });
console.log(decoded.name); // "execute" - but is this the REAL execute?
```

**Problems:**
- ABI might be outdated
- ABI might be for different contract
- ABI might be maliciously crafted
- No way to verify authenticity

### Step 3: Trust and Pray

The LLM shows the user:
```
Function: execute(bytes,bytes[],uint256)
Parameters: [0x0b00, [...], 1706620672]
```

**User sees:** Meaningless bytes
**User thinks:** "I guess I'll trust it?"

### What Could Go Wrong

1. **Malicious ABI**: Attacker provides fake ABI that decodes a drain as "swap"
2. **Outdated ABI**: Contract upgraded, old ABI decodes incorrectly
3. **Wrong Contract**: ABI is for different contract, decoding is nonsense
4. **Proxy Confusion**: ABI is for proxy, not implementation

**Result:** User signs transaction thinking it's a swap, but it's actually:
- Unlimited token approval to attacker
- Transfer to attacker address
- Malicious contract call

---

## With KaiSign

### Step 1: Verify Contract On-Chain

```typescript
const result = await validateTransaction({
  to: "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD",
  data: "0x3593564c...",
  chainId: 8453,
  value: "10000000000000000"
});
```

KaiSign does:

1. **Get extcodehash** from Base (the actual bytecode hash)
2. **Query KaiSign Registry on Sepolia** for attestation
3. **Verify leaf hash matches on-chain** (cryptographic proof)

```
Registry: 0xC203e8C22eFCA3C9218a6418f6d4281Cb7744dAa (Sepolia)

Local leaf:     0x17cd3a34850e1371...
On-chain leaf:  0x17cd3a34850e1371...
MATCH -> Metadata is authentic
```

### Step 2: Decode with Verified Metadata

The metadata is:
- **Attested by contract developer** (they signed it)
- **Stored on-chain** (immutable)
- **Tied to bytecode hash** (can't use wrong ABI)

```typescript
{
  verified: true,
  source: "leaf-verified",
  intent: "Swap 0.01 ETH -> min 25.50 USDC via Uniswap Universal Router",
  functionName: "execute",
  warnings: []
}
```

### Step 3: Show Clear Signing Prompt

```
┌─────────────────────────────────────────┐
│  ✓ Verified Transaction                 │
│                                         │
│  Swap 0.01 ETH → min 25.50 USDC         │
│  via Uniswap Universal Router           │
│                                         │
│  Contract: 0x3fC9...7FAD (Base)         │
│  Value: 0.01 ETH                        │
│                                         │
│  [Confirm]  [Cancel]                    │
└─────────────────────────────────────────┘
```

**User sees:** Clear intent in plain English
**User knows:** This is verified against on-chain registry

---

## Trust Model Comparison

| Aspect | Without KaiSign | With KaiSign |
|--------|----------------|--------------|
| **ABI Source** | Etherscan, hardcoded, unknown | On-chain registry (Sepolia) |
| **Verification** | None | Cryptographic (leaf hash) |
| **Trust** | API provider, developer | Math (keccak256) |
| **Tampering** | Possible | Detected |
| **Proxy Support** | Manual | Automatic |
| **Cross-Chain** | Per-chain setup | Single registry |

---

## The Cryptographic Proof

KaiSign verification works like this:

```
1. extcodehash = keccak256(contract bytecode) on target chain
2. attestationUID = registry.latestSpecs(chainId, extcodehash)
3. components = parseAttestation(attestationUID)
   - chainId, extcodehash, metadataHash, idx, revoked
4. localLeaf = keccak256(TYPEHASH + components)
5. onChainLeaf = registry.computeAttestationLeaf(attestationUID)
6. VERIFY: localLeaf == onChainLeaf
```

If they match:
- Metadata hash is authentic
- Contract developer attested this metadata
- Attestation hasn't been revoked
- **LLM can trust the decoded intent**

---

## Real Example

### Transaction
```json
{
  "to": "0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD",
  "data": "0x3593564c...",
  "value": "10000000000000000",
  "chainId": 8453
}
```

### Without KaiSign
```
Function: execute
Params: bytes, bytes[], uint256
Intent: ??? (need to decode commands manually)
Trust: None
```

### With KaiSign
```json
{
  "verified": true,
  "source": "leaf-verified",
  "intent": "Wrap ETH to WETH + Swap via V3_SWAP_EXACT_IN",
  "attestationUID": "0x68b05727affff681...",
  "warnings": []
}
```

---

## What the LLM Actually Receives

MCP tools work by returning JSON responses to the LLM. The question isn't "what does the LLM need to know?" — it's "what does the tool return?"

### KaiSign MCP Tool Response

When the LLM calls `validate_transaction`, it receives:

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
  "transaction": { "to": "0x3fC9...", "selector": "0x3593564c" },
  "verification": { "attestationUid": "0x68b05..." }
}
```

**Response size: ~150-250 tokens**

The heavy lifting (ABIs, command registries, token metadata) stays server-side in `cache-manager.ts`.

### Alternative Approaches

**Option A: Hardcoded ABIs in system prompt**
- Uniswap Router ABI embedded in prompt: ~4000 tokens
- Command registry definitions: ~800 tokens
- This bloats *every* conversation, not just transaction ones
- **Per-conversation overhead: ~4800+ tokens**

**Option B: LLM fetches and decodes manually**
- Call Etherscan API for ABI: response ~2000-5000 tokens
- Parse and decode calldata: multiple tool calls
- Interpret decoded output: additional context needed
- **Per-transaction overhead: 3000-7000 tokens across multiple calls**

**Option C: Return raw calldata**
- Tool returns: `"data": "0x3593564c000000..."`
- LLM sees bytes it can't interpret
- User sees: "Function: execute(bytes,bytes[],uint256)" — meaningless
- **Zero tokens saved, zero clarity gained**

### What This Means

KaiSign keeps complexity server-side:

| Component | Where It Lives | Sent to LLM? |
|-----------|----------------|--------------|
| Contract ABIs | Server cache | No |
| Command registries | Server cache | No |
| Token metadata | Server cache | No |
| Verification logic | Server-side | No |
| **Decoded intent** | Tool response | **Yes (~150-250 tokens)** |

The LLM receives a concise, actionable response — not raw ABIs or calldata.

### Where the Savings Come From

1. **Response efficiency**: KaiSign returns a distilled intent (~150-250 tokens), not raw decoded ABI output (~500-2000 tokens). The server does the heavy lifting of parsing commands, resolving token symbols, and formatting human-readable descriptions.

2. **Single call vs multi-call**: Without KaiSign, decoding a Uniswap transaction might require: fetch ABI → decode calldata → look up command registry → resolve token addresses. Each tool call adds response overhead. KaiSign does this in one call.

3. **Server-side caching**: The `cache-manager.ts` stores ABIs, command registries, and verification results. Repeated queries for the same contract don't re-fetch or re-send this data — only the decoded result is returned.

4. **No system prompt bloat**: Some approaches embed ABIs in the system prompt so the LLM "knows" how to decode. This adds thousands of tokens to *every* conversation, whether or not transactions are involved. KaiSign keeps this data server-side.

The savings are from returning a compact, pre-processed result instead of raw data the LLM would need to interpret.

---

## Summary

| Without KaiSign | With KaiSign |
|-----------------|--------------|
| Trust external APIs | Trust on-chain registry |
| Hope ABI is correct | Verify cryptographically |
| Manual proxy handling | Automatic |
| ABIs in system prompt or multi-step decoding | ~150-250 token tool response |
| "Function: execute" | "Swap 0.01 ETH → USDC" |
| User confused | User confident |
| Vulnerable to fake ABIs | Tamper-proof |
