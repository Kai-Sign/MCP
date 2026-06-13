#!/usr/bin/env node
/**
 * KaiSign MCP Server
 * Metadata verification server for LLM transaction decoding
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError
} from '@modelcontextprotocol/sdk/types.js';

import { verifyContractMetadata, verifyMetadataSchema } from './tools/verify-metadata.js';
import { decodeTransaction, decodeTransactionSchema } from './tools/decode-transaction.js';
import { getCachedMetadata, getCachedMetadataSchema, clearCache, pruneExpiredCache } from './tools/get-cached-metadata.js';
import { validateTransaction, validateTransactionSchema } from './tools/validate-transaction.js';
import { getClearSignPrompt, getClearSignPromptSchema } from './tools/get-clear-sign-prompt.js';
import { clearSignPayload, clearSignPayloadSchema } from './tools/clear-sign-payload.js';
import { getFunctionSelectors, getFunctionSelectorsSchema } from './tools/get-function-selectors.js';
import { putPayloadChunk } from './services/payload-store.js';

// Create MCP server
export const server = new Server(
  {
    name: 'kaisign-mcp',
    version: '1.0.0'
  },
  {
    capabilities: {
      tools: {}
    }
  }
);

// Define tools
export const mcpTools = [
  {
    name: 'verify_contract_metadata',
    description: `Diagnostic: verify one contract's metadata attestation against the on-chain KaiSign Registry. For decoding + safety verdicts on a transaction, prefer clear_sign_payload (it verifies every contract in the call tree automatically).

This tool checks if a contract's ERC-7730 metadata has been attested on-chain by computing
leaf hashes and comparing them against the KaiSign Registry on Sepolia.

Verification flow:
1. Get contract bytecode hash (extcodehash)
2. Query registry for attestation UID
3. Parse attestation struct and compute leaf hash locally
4. Compare against on-chain computed leaf hash

Returns:
- verified: true if leaf hashes match
- source: 'leaf-verified' (success), 'local-metadata' (local file, no on-chain attestation), 'mismatch', or 'error'
- attestation details including metadataHash, idx, revoked status`,
    inputSchema: {
      type: 'object',
      properties: {
        contractAddress: {
          type: 'string',
          description: 'Contract address to verify (0x...)',
          pattern: '^0x[a-fA-F0-9]{40}$'
        },
        chainId: {
          type: 'number',
          description: 'Chain ID where the contract is deployed',
          default: 1
        }
      },
      required: ['contractAddress']
    }
  },
  {
    name: 'decode_transaction',
    description: `Decode transaction calldata using verified ERC-7730 metadata. Prefer clear_sign_payload for signing flows — it returns this decode plus the unified signing verdict, display text, and signing policy in one call.

This tool decodes Ethereum transaction calldata into human-readable format using
metadata from the KaiSign registry. It provides:

- Function name and signature
- Decoded parameters with labels and formatted values
- Intent description (e.g., "Swap 1.5 ETH for min 3000 USDC")
- Metadata-declared command registry decoding
- On-chain verification of metadata authenticity

Token savings: Cached metadata enables 80%+ token savings on repeated queries
to the same contract.`,
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Target contract address (0x...)',
          pattern: '^0x[a-fA-F0-9]{40}$'
        },
        data: {
          type: 'string',
          description: 'Transaction calldata (0x...)',
          pattern: '^0x[a-fA-F0-9]+$'
        },
        chainId: {
          type: 'number',
          description: 'Chain ID',
          default: 1
        },
        skipVerification: {
          type: 'boolean',
          description: 'Skip on-chain verification (faster, uses cached verification)',
          default: false
        },
        value: {
          type: 'string',
          description: 'Transaction value in wei (optional)'
        }
      },
      required: ['to', 'data']
    }
  },
  {
    name: 'get_cached_metadata',
    description: `Diagnostic: retrieve cached metadata status for a contract.

Use this to check if metadata is cached before making decode calls.
Cached metadata provides significant token savings by avoiding re-transmission
of full ABI and format definitions.

Returns:
- Cache status (found/not found)
- Approximate token count saved
- Verification status
- Cache statistics (hit rate, total entries)`,
    inputSchema: {
      type: 'object',
      properties: {
        contractAddress: {
          type: 'string',
          description: 'Contract address to check (0x...)',
          pattern: '^0x[a-fA-F0-9]{40}$'
        },
        chainId: {
          type: 'number',
          description: 'Chain ID',
          default: 1
        }
      },
      required: ['contractAddress']
    }
  },
  {
    name: 'clear_cache',
    description: 'Diagnostic: clear all cached metadata and verification results. Use sparingly.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'prune_expired_cache',
    description: 'Diagnostic: remove expired entries from cache. Called automatically but can be triggered manually.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'validate_transaction',
    description: `Validate a transaction payload against KaiSign Registry. Prefer clear_sign_payload — it wraps this validation and adds payload normalization, display text, and signing policy.

This tool is designed for signing flows:
1. A transaction builder creates an unsigned transaction payload
2. This tool validates the transaction against KaiSign's on-chain verified metadata
3. If verified (source: 'leaf-verified'), the decoded intent is trustworthy
4. User or policy can approve signing knowing the transaction matches intent

Returns:
- verified: true if contract has KaiSign-verified metadata
- source: 'leaf-verified' (trustless on-chain), 'local-metadata', 'unverified', or 'error'
- intent: Human-readable description of what the transaction does
- params: Decoded function parameters with labels
- warnings: Any concerns about the transaction
- verification: Attestation details (uid, metadataHash, idx, revoked status)`,
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Target contract address (0x...)',
          pattern: '^0x[a-fA-F0-9]{40}$'
        },
        data: {
          type: 'string',
          description: 'Transaction calldata (0x...)',
          pattern: '^0x[a-fA-F0-9]+$'
        },
        chainId: {
          type: 'number',
          description: 'Chain ID (default: 8453 for Base)',
          default: 8453
        },
        value: {
          type: 'string',
          description: 'Transaction value in wei (default: "0")',
          default: '0'
        }
      },
      required: ['to', 'data']
    }
  },
  {
    name: 'put_payload_chunk',
    description: `Auxiliary to clear_sign_payload: stage a large transaction payload or calldata in small chunks, then call clear_sign_payload with payloadRef or dataRef.

Use when a single MCP call with full calldata is too large for the MCP proxy/gateway. Send chunks under the client/proxy limit; after complete=true, call:
- clear_sign_payload({ payloadRef, compact: true }) for full transaction JSON/raw tx chunks
- clear_sign_payload({ to, dataRef: payloadRef, chainId, value, compact: true }) for calldata-only chunks`,
    inputSchema: {
      type: 'object',
      properties: {
        payloadId: {
          type: 'string',
          description: 'Optional id from the first chunk; omit on the first chunk to create one'
        },
        payloadRef: {
          type: 'string',
          description: 'Alias for payloadId/ref returned by a previous chunk'
        },
        chunk: {
          type: 'string',
          description: 'Chunk text: JSON fragment, raw tx hex fragment, or calldata hex fragment'
        },
        index: {
          type: 'number',
          description: 'Zero-based chunk index; default 0'
        },
        totalChunks: {
          type: 'number',
          description: 'Total number of chunks'
        },
        mode: {
          type: 'string',
          enum: ['json', 'text'],
          description: 'json for transaction JSON/raw tx payloadRef; text for calldata dataRef'
        },
        ttlSeconds: {
          type: 'number',
          description: 'How long to keep the staged payload; default 900 seconds'
        }
      },
      required: ['chunk'],
      additionalProperties: false
    }
  },
  {
    name: 'clear_sign_payload',
    description: `PRIMARY TOOL — use this for any transaction clear-signing, decoding, or safety question. Clear-signs any transaction payload from a transaction builder: LLM agent, wallet request, router API, custom code, or raw transaction.

Returns a unified signing block { verdict: safe|review|reject, reason, decodedCalls/totalCalls, attestedContracts/totalContracts }, a per-contract registry-attestation summary, a rendered call tree in displayText, and a signing policy. 'review' means fully decoded but registry attestation pending — show to the user; 'reject' means do not sign.

This is the generic pre-sign hook for transaction builders:
1. Accepts a direct transaction {to,data,value,chainId}, nested {transaction:{...}} / {tx:{...}}, calldata aliases, or rawTx
2. Normalizes it to the exact original transaction payload that must be signed
3. Calls KaiSign clear-signing verification and decoding
4. Returns displayText, intent, verification status, warnings, safe/autonomous decision fields, and signing policy

Builder UX rule: if the user gives only chainId, contracts, and actions, the agent should already know the desired artifact is an unsigned transaction. The user should not need to specify ABI safety instructions, nesting details, or return format. The agent may choose any realistic call path/nesting, but before encoding each call it should use get_function_selectors for the exact target address + chainId. Never guess a selector from model memory. Then call this tool on the final unsigned tx before signing/broadcasting. The final agent output should be the unsigned transaction fields: to, data, value, chainId.

Use this before any signing or broadcasting. Sign the returned transaction only after user/agent policy approval.`,
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Target contract address (direct payload shape)',
          pattern: '^0x[a-fA-F0-9]{40}$'
        },
        data: {
          type: 'string',
          description: 'Transaction calldata (direct payload shape)',
          pattern: '^0x[a-fA-F0-9]+$'
        },
        calldata: {
          type: 'string',
          description: 'Alias for data'
        },
        chainId: {
          type: 'number',
          description: 'Chain ID',
          default: 8453
        },
        chain: {
          description: 'Alias for chainId; accepts number or numeric string'
        },
        value: {
          type: 'string',
          description: 'Transaction value in wei',
          default: '0'
        },
        transaction: {
          type: 'object',
          description: 'Nested tx-builder payload containing to/data/value/chainId'
        },
        tx: {
          type: 'object',
          description: 'Nested tx-builder payload containing to/data/value/chainId'
        },
        rawTx: {
          type: 'string',
          description: 'Serialized signed/raw Ethereum transaction hex; used only to extract to/data/value/chainId for display'
        },
        rawTransaction: {
          type: 'string',
          description: 'Alias for rawTx'
        },
        payloadFile: {
          type: 'string',
          description: 'Read transaction JSON or raw tx hex from a local file to avoid local MCP client input-size limits'
        },
        payloadRef: {
          type: 'string',
          description: 'Reference returned by put_payload_chunk for remote/chunked payload JSON or raw tx hex'
        },
        dataRef: {
          type: 'string',
          description: 'Reference returned by put_payload_chunk for chunked calldata hex; pass with to/value/chainId'
        },
        payloadGzipBase64: {
          type: 'string',
          description: 'gzip+base64 compressed transaction JSON or raw tx hex; avoids proxy limits without server-side chunk state'
        },
        dataGzipBase64: {
          type: 'string',
          description: 'gzip+base64 compressed calldata hex; pass with to/value/chainId'
        },
        txFile: {
          type: 'string',
          description: 'Alias for payloadFile'
        },
        dataFile: {
          type: 'string',
          description: 'Read calldata hex from a local file while passing to/value/chainId as small tool arguments'
        },
        calldataFile: {
          type: 'string',
          description: 'Alias for dataFile'
        },
        compact: {
          type: 'boolean',
          description: 'Omit echoed calldata in the response and return a hash/byte summary instead'
        },
        responseMode: {
          type: 'string',
          enum: ['full', 'compact'],
          description: 'Use compact for very large calldata responses'
        }
      },
      additionalProperties: true
    }
  },
  {
    name: 'get_function_selectors',
    description: `Auxiliary to clear_sign_payload: resolve function selectors from KaiSign local metadata for an exact contract address + chainId (anti-hallucination — never guess selectors from model memory).

Builder UX rule: when a user gives only lightweight input like chainId, contracts, and actions (for example "approve 1000 USDC" and "transfer 10 USDC"), the agent should already know the desired artifact is an unsigned transaction. The user should not need to specify ABI safety instructions, nesting details, or return format. The agent may use the listed contracts to build a realistic batched, routed, nested, or account-abstraction transaction when that is implied by the contract set, but every encoded call must use a function returned by this tool for the exact target address + chainId. If a selector is not returned for the exact address + chainId, do not use it. The final agent output should be the unsigned transaction fields: to, data, value, chainId.

Use this before encoding calldata when an agent or transaction builder only knows a function name like executeBatch(...), swap(...), approve(...), or transfer(...). It returns canonical ABI signatures and computed selectors for that specific contract only, so agents do not hallucinate selectors from training data or reuse a same-named ABI from another contract. For signing flows, still call clear_sign_payload on the final unsigned transaction before signing/broadcasting.`,
    inputSchema: {
      type: 'object',
      properties: {
        contractAddress: {
          type: 'string',
          description: 'Exact target contract address (0x...)',
          pattern: '^0x[a-fA-F0-9]{40}$'
        },
        address: {
          type: 'string',
          description: 'Alias for contractAddress',
          pattern: '^0x[a-fA-F0-9]{40}$'
        },
        to: {
          type: 'string',
          description: 'Alias for contractAddress',
          pattern: '^0x[a-fA-F0-9]{40}$'
        },
        chainId: {
          type: 'number',
          description: 'Chain ID',
          default: 1
        },
        functionName: {
          type: 'string',
          description: 'Optional exact ABI function name filter, e.g. executeBatch'
        },
        selector: {
          type: 'string',
          description: 'Optional selector filter to verify against this exact contract metadata, e.g. 0x47e1da2a',
          pattern: '^0x[a-fA-F0-9]{8}$'
        }
      },
      additionalProperties: true
    }
  },
  {
    name: 'get_clear_sign_prompt',
    description: `Get a clear signing prompt for user confirmation. Prefer clear_sign_payload — it returns this prompt plus payload normalization and signing policy; this tool is a subset for direct {to,data} input.

This tool provides a formatted display for transaction signing flows:
1. Takes a transaction payload (to, data, value, chainId)
2. Verifies the contract against KaiSign on-chain registry
3. Decodes the transaction intent
4. Returns formatted display text for user confirmation

Use this when presenting transactions to users for signing. The response includes:
- displayText: Formatted text ready for display (includes verification badge, intent, warnings)
- verified: Whether the contract has on-chain verified metadata
- verificationBadge: "✓ Verified", "⚠ Local Metadata", or "⚠ Unverified"
- intent: Human-readable description of transaction
- functionName: The function being called
- warnings: Any concerns about the transaction
- transaction: The original transaction payload for signing`,
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Target contract address (0x...)',
          pattern: '^0x[a-fA-F0-9]{40}$'
        },
        data: {
          type: 'string',
          description: 'Transaction calldata (0x...)',
          pattern: '^0x[a-fA-F0-9]+$'
        },
        chainId: {
          type: 'number',
          description: 'Chain ID (default: 8453 for Base)',
          default: 8453
        },
        value: {
          type: 'string',
          description: 'Transaction value in wei (default: "0")',
          default: '0'
        }
      },
      required: ['to', 'data']
    }
  }
];

function textResult(result: unknown) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(result, null, 2)
      }
    ]
  };
}

export async function handleMcpToolCall(name: string, args: unknown) {
  try {
    switch (name) {
      case 'verify_contract_metadata': {
        const input = verifyMetadataSchema.parse(args);
        return textResult(await verifyContractMetadata(input));
      }

      case 'decode_transaction': {
        const input = decodeTransactionSchema.parse(args);
        return textResult(await decodeTransaction(input));
      }

      case 'get_cached_metadata': {
        const input = getCachedMetadataSchema.parse(args);
        return textResult(await getCachedMetadata(input));
      }

      case 'clear_cache': {
        return textResult(await clearCache());
      }

      case 'prune_expired_cache': {
        return textResult(await pruneExpiredCache());
      }

      case 'validate_transaction': {
        const input = validateTransactionSchema.parse(args);
        return textResult(await validateTransaction(input));
      }

      case 'clear_sign_payload': {
        const input = clearSignPayloadSchema.parse(args);
        return textResult(await clearSignPayload(input));
      }

      case 'put_payload_chunk': {
        return textResult(putPayloadChunk(clearSignPayloadSchema.parse(args) as any));
      }

      case 'get_function_selectors': {
        const input = getFunctionSelectorsSchema.parse(args);
        return textResult(await getFunctionSelectors(input));
      }

      case 'get_clear_sign_prompt': {
        const input = getClearSignPromptSchema.parse(args);
        return textResult(await getClearSignPrompt(input));
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (error) {
    if (error instanceof McpError) {
      throw error;
    }

    const message = error instanceof Error ? error.message : 'Unknown error';
    throw new McpError(ErrorCode.InternalError, message);
  }
}

// Handle list tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools: mcpTools };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return handleMcpToolCall(name, args);
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('KaiSign MCP Server running on stdio');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });
}
