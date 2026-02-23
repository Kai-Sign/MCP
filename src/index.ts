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
import { validateBankrbotTransaction, validateBankrbotTxSchema } from './tools/validate-bankrbot-tx.js';
import { getClearSignPrompt, getClearSignPromptSchema } from './tools/get-clear-sign-prompt.js';

// Create MCP server
const server = new Server(
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
const tools = [
  {
    name: 'verify_contract_metadata',
    description: `Verify contract metadata against on-chain KaiSign Registry.

This tool checks if a contract's ERC-7730 metadata has been attested on-chain by computing
leaf hashes and comparing them against the KaiSign Registry on Sepolia.

Verification flow:
1. Get contract bytecode hash (extcodehash)
2. Query registry for attestation UID
3. Parse attestation struct and compute leaf hash locally
4. Compare against on-chain computed leaf hash

Returns:
- verified: true if leaf hashes match
- source: 'leaf-verified' (success), 'api-only' (no on-chain data), 'mismatch', or 'error'
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
    description: `Decode transaction calldata using verified ERC-7730 metadata.

This tool decodes Ethereum transaction calldata into human-readable format using
metadata from the KaiSign registry. It provides:

- Function name and signature
- Decoded parameters with labels and formatted values
- Intent description (e.g., "Swap 1.5 ETH for min 3000 USDC")
- Command decoding for Universal Router transactions
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
    description: `Retrieve cached metadata status for a contract.

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
    description: 'Clear all cached metadata and verification results. Use sparingly.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'prune_expired_cache',
    description: 'Remove expired entries from cache. Called automatically but can be triggered manually.',
    inputSchema: {
      type: 'object',
      properties: {}
    }
  },
  {
    name: 'validate_bankrbot_transaction',
    description: `Validate a transaction payload from Bankrbot against KaiSign Registry.

This tool is designed for the agent signing flow:
1. Bankrbot builds a transaction from natural language (e.g., "swap $10 ETH to USDC")
2. This tool validates the transaction against KaiSign's on-chain verified metadata
3. If verified (source: 'leaf-verified'), the decoded intent is trustworthy
4. User can confidently sign knowing the transaction matches their intent

Returns:
- verified: true if contract has KaiSign-verified metadata
- source: 'leaf-verified' (trustless on-chain), 'api-only', 'unverified', or 'error'
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
    name: 'get_clear_sign_prompt',
    description: `Get a clear signing prompt for user confirmation.

This tool provides a formatted display for transaction signing flows:
1. Takes a transaction payload (to, data, value, chainId)
2. Verifies the contract against KaiSign on-chain registry
3. Decodes the transaction intent
4. Returns formatted display text for user confirmation

Use this when presenting transactions to users for signing. The response includes:
- displayText: Formatted text ready for display (includes verification badge, intent, warnings)
- verified: Whether the contract has on-chain verified metadata
- verificationBadge: "✓ Verified", "⚠ API Only", or "⚠ Unverified"
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

// Handle list tools request
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  try {
    switch (name) {
      case 'verify_contract_metadata': {
        const input = verifyMetadataSchema.parse(args);
        const result = await verifyContractMetadata(input);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      case 'decode_transaction': {
        const input = decodeTransactionSchema.parse(args);
        const result = await decodeTransaction(input);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      case 'get_cached_metadata': {
        const input = getCachedMetadataSchema.parse(args);
        const result = await getCachedMetadata(input);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      case 'clear_cache': {
        const result = await clearCache();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      case 'prune_expired_cache': {
        const result = await pruneExpiredCache();
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      case 'validate_bankrbot_transaction': {
        const input = validateBankrbotTxSchema.parse(args);
        const result = await validateBankrbotTransaction(input);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
      }

      case 'get_clear_sign_prompt': {
        const input = getClearSignPromptSchema.parse(args);
        const result = await getClearSignPrompt(input);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(result, null, 2)
            }
          ]
        };
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
});

// Start server
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('KaiSign MCP Server running on stdio');
}

main().catch((error) => {
  console.error('Failed to start server:', error);
  process.exit(1);
});
