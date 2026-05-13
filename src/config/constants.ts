/**
 * KaiSign MCP Constants
 */

// KaiSign Registry contract on Sepolia
export const KAISIGN_REGISTRY = process.env.KAISIGN_REGISTRY_ADDRESS || '0x655084b6A0f2Ee600bd31A71820b5E068b7870d0';

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

// KaiSign API
export const KAISIGN_API = process.env.KAISIGN_API_URL || 'https://kai-sign-production.up.railway.app';

// Bankrbot API
export const BANKR_API_URL = process.env.BANKR_API_URL || 'https://api.bankr.bot';

// Cache settings
export const CACHE_TTL = 300000; // 5 minutes
export const TOKEN_CACHE_TTL = 600000; // 10 minutes

// EIP-1967 storage slots
export const EIP1967_IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
export const SAFE_MASTER_COPY_SLOT = '0x0000000000000000000000000000000000000000000000000000000000000000';

// Leaf typehash for verification
export const LEAF_TYPEHASH_STRING = 'RegistryLeaf(uint256 chainId,bytes32 extcodehash,bytes32 metadataHash,uint256 idx,bool revoked)';
