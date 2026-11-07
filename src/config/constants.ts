/**
 * KaiSign MCP Constants
 */

import { fileURLToPath } from 'node:url';

// KaiSign Registry (UUPS proxy, depth-256 SMT keyed by chainId + target address) on Sepolia
export const KAISIGN_REGISTRY = process.env.KAISIGN_REGISTRY_ADDRESS || '0xf70D41afe5Ff76Ac3Bee86BCBda07450f3b590F0';

// Chain IDs
export const SEPOLIA_CHAIN_ID = 11155111;
export const MAINNET_CHAIN_ID = 1;

// RPC URLs for Sepolia (registry lives here)
export const SEPOLIA_RPC_URLS = [
  'https://ethereum-sepolia-rpc.publicnode.com',
  'https://rpc.sepolia.org',
  'https://sepolia.drpc.org'
];

// RPC URLs by chain - prioritize env vars for reliable access
export const RPC_URLS: Record<number, string[]> = {
  1: [
    ...(process.env.ETH_RPC_URL ? [process.env.ETH_RPC_URL] : []),
    'https://ethereum-rpc.publicnode.com',
    'https://eth.llamarpc.com',
    'https://rpc.ankr.com/eth'
  ],
  11155111: [
    ...(process.env.SEPOLIA_RPC_URL ? [process.env.SEPOLIA_RPC_URL] : []),
    ...SEPOLIA_RPC_URLS
  ],
  10: [
    ...(process.env.OPTIMISM_RPC_URL ? [process.env.OPTIMISM_RPC_URL] : []),
    'https://optimism-rpc.publicnode.com',
    'https://mainnet.optimism.io'
  ],
  8453: [
    ...(process.env.BASE_RPC_URL ? [process.env.BASE_RPC_URL] : []),
    'https://base-rpc.publicnode.com',
    'https://mainnet.base.org'
  ],
  42161: [
    ...(process.env.ARBITRUM_RPC_URL ? [process.env.ARBITRUM_RPC_URL] : []),
    'https://arbitrum-one-rpc.publicnode.com',
    'https://arb1.arbitrum.io/rpc'
  ]
};

// Local ERC-7730 metadata directory. MCP is local-first; do not depend on the hosted API.
export const KAISIGN_METADATA_DIR = process.env.KAISIGN_METADATA_DIR;


// Cache settings
export const CACHE_TTL = 300000; // 5 minutes
export const TOKEN_CACHE_TTL = 600000; // 10 minutes

// EIP-1967 storage slots
export const EIP1967_IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
export const SAFE_MASTER_COPY_SLOT = '0x0000000000000000000000000000000000000000000000000000000000000000';

// Leaf set behind the registry's imported SMT root (later changes are replayed from SmtRootUpdated events)
export const KAISIGN_SMT_SEED_FILE = process.env.KAISIGN_SMT_SEED_FILE
  || fileURLToPath(new URL('../../registry/smt-seed.json', import.meta.url));

// Leaf typehash for verification
export const LEAF_TYPEHASH_STRING = 'RegistryLeaf(uint256 chainId,address target,bytes32 metadataHash)';
