#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Interface, JsonRpcProvider } from 'ethers';

loadDotenv(path.resolve('.env'));

const args = parseArgs(process.argv.slice(2));
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || process.env.ETHERSCAN_KEY || '';
const NETWORK_TIMEOUT_MS = Number(args['network-timeout-ms'] || process.env.KAISIGN_ETHERSCAN_TIMEOUT_MS || 15000);
const DEFAULT_OUTPUT_DIR = path.resolve('metadata', 'generated');
const SCHEMA_URL = 'https://eips.ethereum.org/assets/eip-7730/erc7730-v2.schema.json';

const RPC_BY_CHAIN = {
  1: process.env.ETH_RPC_URL || 'https://ethereum.publicnode.com',
  10: process.env.OPTIMISM_RPC_URL || 'https://optimism.publicnode.com',
  56: process.env.BSC_RPC_URL || 'https://bsc.publicnode.com',
  100: process.env.GNOSIS_RPC_URL || 'https://gnosis-rpc.publicnode.com',
  137: process.env.POLYGON_RPC_URL || 'https://polygon-bor-rpc.publicnode.com',
  250: process.env.FANTOM_RPC_URL || 'https://rpcapi.fantom.network',
  8453: process.env.BASE_RPC_URL || 'https://base.publicnode.com',
  42161: process.env.ARBITRUM_RPC_URL || 'https://arbitrum-one.publicnode.com',
  43114: process.env.AVALANCHE_RPC_URL || 'https://avalanche-c-chain-rpc.publicnode.com',
  534352: process.env.SCROLL_RPC_URL || 'https://scroll-rpc.publicnode.com',
  81457: process.env.BLAST_RPC_URL || 'https://blast-rpc.publicnode.com',
  34443: process.env.MODE_RPC_URL || 'https://mainnet.mode.network',
  11155111: process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia.publicnode.com',
  84532: process.env.BASE_SEPOLIA_RPC_URL || 'https://base-sepolia-rpc.publicnode.com',
  421614: process.env.ARBITRUM_SEPOLIA_RPC_URL || 'https://arbitrum-sepolia-rpc.publicnode.com',
  11155420: process.env.OPTIMISM_SEPOLIA_RPC_URL || 'https://optimism-sepolia.publicnode.com'
};

function usage() {
  console.error(`Usage:
  ETHERSCAN_API_KEY=... node scripts/generate-erc7730-from-etherscan.mjs --chain=1 --address=0x... [--output=metadata/protocols/name.json]

Build a draft ERC-7730 v2-equivalent KaiSign metadata file from verified Etherscan v2 ABI evidence.
It keeps metadata bound to the requested address, resolves Etherscan/RPC implementation for proxies, computes selectors from canonical ABI signatures, and emits generic display formats for write functions.

Required:
  --chain=<id>             Etherscan v2 chain ID
  --address=<0x...>        contract/proxy address to bind metadata to

Useful options:
  --output=<path>          output JSON path (default: metadata/generated/<contract>-<chain>-<addr>.json)
  --force                  overwrite output if it already exists
  --name=<name>            override contract display name
  --symbol=<symbol>        token symbol override
  --decimals=<n>           token decimals override
  --description=<text>     metadata description override
  --include-views          include view/pure functions in context.contract.abi; display still only for writes
  --all-functions          include all ABI functions, including views, in context.contract.abi
  --abi-file=<path>        offline/test mode: read a verified ABI JSON array instead of calling Etherscan
  --contract-name=<name>   offline/test mode contract name
  --no-rpc-code-check      skip eth_getCode check when RPC is unavailable

Notes:
  - This creates a safe selector/ABI skeleton, not final human-quality clear-signing text.
  - Review and specialize display.formats before registry submission.
`);
}

function parseArgs(argv) {
  const out = {};
  for (const raw of argv) {
    if (!raw.startsWith('--')) continue;
    const body = raw.slice(2);
    const eq = body.indexOf('=');
    if (eq === -1) out[body] = true;
    else out[body.slice(0, eq)] = body.slice(eq + 1);
  }
  return out;
}

function loadDotenv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const [key, ...rest] = trimmed.split('=');
    if (process.env[key]) continue;
    process.env[key] = rest.join('=').replace(/^["']|["']$/g, '');
  }
}

function assertAddress(value, label) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(String(value || ''))) throw new Error(`${label} must be a 20-byte 0x address`);
  return String(value).toLowerCase();
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
  const res = await fetch(url, {
    signal: controller.signal,
    headers: { 'user-agent': 'kaisign-erc7730-generator/1.0' }
  }).finally(() => clearTimeout(timer));
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 240)}`);
  return JSON.parse(text);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchEtherscanJson(url) {
  let last;
  for (let attempt = 0; attempt < 8; attempt++) {
    const json = await fetchJson(url.toString());
    const msg = `${json.message || ''} ${String(json.result || '')}`;
    if (!/rate limit|max calls per sec/i.test(msg)) return json;
    last = json;
    await sleep(1250 * (attempt + 1));
  }
  return last;
}

async function fetchSourceCodeApi(chainId, address) {
  if (!ETHERSCAN_API_KEY) throw new Error('ETHERSCAN_API_KEY missing; set it in the environment or .env, or use --abi-file for offline testing.');
  const url = new URL('https://api.etherscan.io/v2/api');
  url.searchParams.set('chainid', String(chainId));
  url.searchParams.set('module', 'contract');
  url.searchParams.set('action', 'getsourcecode');
  url.searchParams.set('address', address);
  url.searchParams.set('apikey', ETHERSCAN_API_KEY);
  const json = await fetchEtherscanJson(url);
  if (json.status !== '1') throw new Error(`Etherscan v2 getsourcecode failed chain=${chainId} address=${address}: ${json.message} ${String(json.result).slice(0, 240)}`);
  const row = Array.isArray(json.result) ? json.result[0] : null;
  if (!row) throw new Error(`Etherscan v2 returned no sourcecode row for chain=${chainId} address=${address}`);
  return row;
}

async function fetchAbiApi(chainId, address) {
  if (!ETHERSCAN_API_KEY) throw new Error('ETHERSCAN_API_KEY missing; set it in the environment or .env, or use --abi-file for offline testing.');
  const url = new URL('https://api.etherscan.io/v2/api');
  url.searchParams.set('chainid', String(chainId));
  url.searchParams.set('module', 'contract');
  url.searchParams.set('action', 'getabi');
  url.searchParams.set('address', address);
  url.searchParams.set('apikey', ETHERSCAN_API_KEY);
  const json = await fetchEtherscanJson(url);
  if (json.status !== '1') throw new Error(`Etherscan v2 getabi failed chain=${chainId} address=${address}: ${json.message} ${String(json.result).slice(0, 240)}`);
  const abi = JSON.parse(json.result);
  if (!Array.isArray(abi)) throw new Error(`Etherscan ABI for ${address} is not a JSON array`);
  return abi;
}

async function getCodeExists(chainId, address) {
  const rpc = RPC_BY_CHAIN[chainId];
  if (!rpc) throw new Error(`No RPC default for chain ${chainId}; set the chain RPC env var or pass --no-rpc-code-check.`);
  const provider = new JsonRpcProvider(rpc, Number(chainId), { staticNetwork: true });
  const code = await provider.getCode(address);
  return Boolean(code && code !== '0x');
}

function canonicalInput(input) {
  if (!input.type || !input.type.startsWith('tuple')) return input.type;
  const suffix = input.type.slice('tuple'.length);
  const inner = (input.components || []).map(canonicalInput).join(',');
  return `(${inner})${suffix}`;
}

function canonicalSignature(fn) {
  return `${fn.name}(${(fn.inputs || []).map(canonicalInput).join(',')})`;
}

function selectorOf(fn) {
  const iface = new Interface([fn]);
  const frag = iface.fragments.find(f => f.type === 'function');
  return iface.getFunction(frag.format('sighash')).selector.toLowerCase();
}

function normalizeAbiInput(input, index = 0) {
  const out = {
    name: input.name || `param${index}`,
    type: input.type
  };
  if (input.internalType) out.internalType = input.internalType;
  if (Array.isArray(input.components)) out.components = input.components.map(normalizeAbiInput);
  return out;
}

function normalizeAbiFunction(fn) {
  const out = {
    type: 'function',
    name: fn.name,
    inputs: Array.isArray(fn.inputs) ? fn.inputs.map(normalizeAbiInput) : [],
    stateMutability: fn.stateMutability || 'nonpayable',
    selector: selectorOf(fn)
  };
  if (Array.isArray(fn.outputs) && fn.outputs.length) out.outputs = fn.outputs.map(normalizeAbiInput);
  return out;
}

function isWrite(fn) {
  return fn?.type === 'function' && fn.stateMutability !== 'view' && fn.stateMutability !== 'pure';
}

function title(name) {
  return String(name || 'contract interaction')
    .replace(/_/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, c => c.toUpperCase());
}

function fieldFormatFor(input) {
  const type = String(input.type || '');
  if (type === 'address') return 'addressName';
  if (type === 'bool') return 'boolean';
  if (type === 'bytes' || type.startsWith('bytes')) return 'hex';
  if (/^u?int/.test(type)) return 'raw';
  return 'raw';
}

function genericDisplayFormat(fn) {
  const fields = (fn.inputs || []).map((input, index) => ({
    path: input.name || `param${index}`,
    label: title(input.name || `param${index}`),
    format: fieldFormatFor(input)
  }));
  return {
    intent: `Review ${title(fn.name)} transaction`,
    ...(fields.length ? { fields } : {})
  };
}

function slugify(value) {
  return String(value || 'contract')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'contract';
}

function defaultOutputPath(contractName, chainId, address) {
  return path.join(DEFAULT_OUTPUT_DIR, `${slugify(contractName)}-${chainId}-${address.slice(2, 10)}.json`);
}

function readAbiFile(file) {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Array.isArray(raw)) return raw;
  if (Array.isArray(raw.abi)) return raw.abi;
  if (Array.isArray(raw.context?.contract?.abi)) return raw.context.contract.abi;
  throw new Error(`--abi-file ${file} must contain an ABI JSON array, {"abi": [...]}, or KaiSign metadata with context.contract.abi`);
}

async function main() {
  if (args.help || args.h) { usage(); return; }

  const chainId = Number(args.chain || args.chainId);
  if (!Number.isInteger(chainId) || chainId <= 0) throw new Error('--chain=<id> is required');
  const address = assertAddress(args.address, '--address');
  const includeViews = Boolean(args['include-views'] || args['all-functions']);
  const force = Boolean(args.force);

  let sourceRow = null;
  let abiAddress = address;
  let abiSource = 'abi-file';
  let rawAbi;
  let implementation = null;
  let contractName = args['contract-name'] || args.name || 'Contract';

  if (args['abi-file']) {
    rawAbi = readAbiFile(String(args['abi-file']));
    contractName = args['contract-name'] || args.name || path.basename(String(args['abi-file']), path.extname(String(args['abi-file'])));
  } else {
    sourceRow = await fetchSourceCodeApi(chainId, address);
    contractName = args.name || sourceRow.ContractName || contractName;
    const impl = sourceRow.Implementation;
    if (impl && /^0x[a-fA-F0-9]{40}$/.test(impl)) {
      implementation = impl.toLowerCase();
      abiAddress = implementation;
    }
    rawAbi = await fetchAbiApi(chainId, abiAddress);
    abiSource = implementation ? `etherscan-v2-getabi implementation ${implementation}` : 'etherscan-v2-getabi';
  }

  if (!args['no-rpc-code-check']) {
    const exists = await getCodeExists(chainId, address);
    if (!exists) throw new Error(`eth_getCode returned 0x for chain=${chainId} address=${address}; refusing to generate contract metadata for a non-contract`);
  }

  const allFunctions = rawAbi.filter(fn => fn.type === 'function' && fn.name);
  const abiFunctions = allFunctions
    .filter(fn => includeViews || isWrite(fn))
    .map(normalizeAbiFunction)
    .sort((a, b) => a.selector.localeCompare(b.selector) || canonicalSignature(a).localeCompare(canonicalSignature(b)));
  if (!abiFunctions.length) throw new Error('No ABI functions selected for metadata');

  const formats = {};
  for (const fn of abiFunctions.filter(isWrite)) {
    formats[canonicalSignature(fn)] = genericDisplayFormat(fn);
  }

  const contract = {
    address,
    chainId,
    name: args.name || contractName,
    abi: abiFunctions
  };
  if (args.symbol) contract.symbol = String(args.symbol);
  if (args.decimals !== undefined) contract.decimals = Number(args.decimals);

  const metadata = {
    $schema: SCHEMA_URL,
    context: { contract },
    metadata: {
      name: args.name || contractName,
      description: args.description || `Draft clear-signing metadata generated from verified ABI for ${contractName} on chain ${chainId}. Review display formats before registry submission.`
    },
    display: { formats },
    'x-ksSourceProof': {
      generatedBy: path.basename(fileURLToPath(import.meta.url)),
      generatedAt: new Date().toISOString(),
      chainId,
      metadataAddress: address,
      abiAddress,
      abiSource,
      contractName,
      implementation,
      selectors: abiFunctions.map(fn => ({ selector: fn.selector, signature: canonicalSignature(fn), write: isWrite(fn) }))
    }
  };

  const output = path.resolve(String(args.output || defaultOutputPath(contractName, chainId, address)));
  if (fs.existsSync(output) && !force) throw new Error(`Output exists: ${output}. Pass --force to overwrite.`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, `${JSON.stringify(metadata, null, 2)}\n`);

  console.log(JSON.stringify({
    ok: true,
    output,
    chainId,
    address,
    abiAddress,
    abiSource,
    contractName,
    functions: abiFunctions.length,
    writeFunctions: abiFunctions.filter(isWrite).length,
    displayFormats: Object.keys(formats).length,
    next: 'Review display.formats for human intent, then run npm run build and clear-sign a real payload.'
  }, null, 2));
}

main().catch(e => {
  console.error(JSON.stringify({ ok: false, error: e.message, stack: e.stack }, null, 2));
  process.exit(2);
});
