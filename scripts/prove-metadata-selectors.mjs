#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Interface, JsonRpcProvider, Contract } from 'ethers';

loadDotenv(path.resolve('.env'));

function loadDotenv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
    const [key, ...rest] = trimmed.split('=');
    if (process.env[key]) continue;
    process.env[key] = rest.join('=').replace(/^['"]|['"]$/g, '');
  }
}

const args = new Map(process.argv.slice(2).map(a => {
  const [k, ...rest] = a.split('=');
  return [k, rest.length ? rest.join('=') : true];
}));

const DEFAULT_METADATA_DIR = fs.existsSync('backend/metadata') ? 'backend/metadata' : 'metadata';
const METADATA_DIR = String(args.get('--metadata-dir') || process.env.KAISIGN_METADATA_DIR || DEFAULT_METADATA_DIR);
const FILE_FILTER = args.get('--file') ? String(args.get('--file')) : null;
const ADDRESS_FILTER = args.get('--address') ? String(args.get('--address')).toLowerCase() : null;
const CHAIN_FILTER = args.get('--chain') ? Number(args.get('--chain')) : null;
const SELECTOR_FILTER = new Set(String(args.get('--selectors') || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean));
const FULL_DIAMOND_CLOSURE = args.has('--diamond-closure');
const REQUIRE_DISPLAY = !args.has('--no-display');
const ALLOW_HTML_FALLBACK = args.has('--allow-html-fallback');
const USER_CALLABLE_ONLY = !args.has('--all-writes');
const FIX = args.has('--fix');
const ABI_ONLY = args.has('--abi-only') || args.has('--fill-from-abi');
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || process.env.ETHERSCAN_KEY || '';
const CACHE_DIR = String(args.get('--cache-dir') || process.env.KAISIGN_VERIFIED_ABI_CACHE || '.cache/verified-abis');
const NETWORK_TIMEOUT_MS = Number(args.get('--network-timeout-ms') || process.env.KAISIGN_SELECTOR_NETWORK_TIMEOUT_MS || 15000);
const CONCURRENCY = Math.max(1, Number(args.get('--concurrency') || process.env.KAISIGN_SELECTOR_CONCURRENCY || 6));

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
  34443: process.env.MODE_RPC_URL || 'https://mainnet.mode.network'
};

const LOUPE_ABI = [
  'function facets() view returns (tuple(address facetAddress, bytes4[] functionSelectors)[])',
  'function facetAddress(bytes4 _functionSelector) view returns (address facetAddress)'
];

function usage() {
  console.error(`Usage:
  ETHERSCAN_API_KEY=... node scripts/prove-metadata-selectors.mjs [--metadata-dir=backend/metadata] [--file=backend/metadata/protocols/lifi-diamond.json] [--address=0x...] [--chain=1] [--selectors=0x...] [--diamond-closure]

Default: prove every verified/live user-callable write selector has local metadata/display.
--all-writes: include admin/operator/system write selectors too.
--abi-only / --fill-from-abi: fetch verified ABI by address and fill/check selectors even when live RPC proof is unavailable.
--diamond-closure: kept for compatibility; diamond contracts are always checked from live facets.
--allow-html-fallback: use explorer HTML ABI only if API fails/missing; not an API proof.
`);
}

function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else if (ent.isFile() && ent.name.endsWith('.json')) out.push(p);
  }
  return out;
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

function isWrite(fn) {
  return fn?.type === 'function' && fn.stateMutability !== 'view' && fn.stateMutability !== 'pure';
}

function displayHasFormat(formats, fn, selector) {
  const sig = canonicalSignature(fn);
  return Boolean(formats[sig] || formats[selector] || formats[fn.name]);
}

function selectorExclusionsFromMetadata(meta) {
  const raw = meta['x-ksSelectorExclusions'] || meta.metadata?.selectorExclusions || meta.context?.contract?.selectorExclusions || [];
  return Array.isArray(raw) ? raw : [];
}

function selectorExclusionFor(meta, selector, signature, name) {
  if (!USER_CALLABLE_ONLY) return null;
  for (const ex of selectorExclusionsFromMetadata(meta)) {
    const selectors = Array.isArray(ex.selectors) ? ex.selectors : [ex.selector].filter(Boolean);
    const signatures = Array.isArray(ex.signatures) ? ex.signatures : [ex.signature].filter(Boolean);
    const names = Array.isArray(ex.names) ? ex.names : [ex.name].filter(Boolean);
    if (selectors.map(s => String(s).toLowerCase()).includes(selector)) return ex;
    if (signatures.includes(signature)) return ex;
    if (names.includes(name)) return ex;
  }
  return null;
}

function normalizeAbiFunction(fn) {
  const out = {
    type: 'function',
    name: fn.name,
    inputs: Array.isArray(fn.inputs) ? fn.inputs : [],
    stateMutability: fn.stateMutability || 'nonpayable',
    selector: selectorOf(fn)
  };
  if (Array.isArray(fn.outputs) && fn.outputs.length) out.outputs = fn.outputs;
  return out;
}

function ensureMutableMetadata(meta) {
  meta.context ||= {};
  meta.context.contract ||= {};
  if (!Array.isArray(meta.context.contract.abi)) meta.context.contract.abi = [];
  meta.display ||= {};
  meta.display.formats ||= {};
}

function addLocalMetadataFunction(meta, verifiedFn) {
  ensureMutableMetadata(meta);
  const selector = verifiedFn.selector;
  const exists = localSelectorsFromMetadata(meta.context.contract.abi, meta.display.formats).has(selector);
  if (exists) return false;
  meta.context.contract.abi.push(normalizeAbiFunction(verifiedFn.fn));
  return true;
}

function genericFormat(fn) {
  const fields = (fn.inputs || []).map((input, i) => {
    const name = input.name || `param${i}`;
    const type = String(input.type || '');
    return {
      path: name,
      label: name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, c => c.toUpperCase()),
      format: type === 'address' ? 'addressName' : type === 'bool' ? 'boolean' : type.startsWith('bytes') ? 'hex' : 'raw'
    };
  });
  return { intent: `Review ${fn.name.replace(/([a-z0-9])([A-Z])/g, '$1 $2')} transaction`, ...(fields.length ? { fields } : {}) };
}

function addDisplayFormat(meta, verifiedFn) {
  ensureMutableMetadata(meta);
  const selector = verifiedFn.selector;
  const sig = verifiedFn.signature;
  if (displayHasFormat(meta.display.formats, verifiedFn.fn, selector)) return false;
  meta.display.formats[sig] = genericFormat(verifiedFn.fn);
  return true;
}

function normalizeDeployments(meta) {
  const c = meta.context?.contract || {};
  const raw = [];
  if (c.address && c.chainId) raw.push({ address: c.address, chainId: Number(c.chainId), source: 'context.contract' });
  if (meta.address && meta.chainId) raw.push({ address: meta.address, chainId: Number(meta.chainId), source: 'top-level' });
  for (const root of [c.deployments, meta.deployments]) {
    if (!root || typeof root !== 'object') continue;
    for (const [name, value] of Object.entries(root)) {
      const vals = Array.isArray(value) ? value : [value];
      for (const v of vals) {
        if (typeof v === 'string' && /^0x[a-fA-F0-9]{40}$/.test(v)) raw.push({ address: v, chainId: 1, source: `deployments.${name}` });
        else if (v && typeof v === 'object' && v.address && v.chainId) raw.push({ address: v.address, chainId: Number(v.chainId), source: `deployments.${name}` });
      }
    }
  }
  const seen = new Set();
  return raw.filter(d => {
    if (!/^0x[a-fA-F0-9]{40}$/.test(String(d.address))) return false;
    d.address = String(d.address).toLowerCase();
    const key = `${d.chainId}:${d.address}`;
    if (seen.has(key)) return false;
    seen.add(key);
    if (ADDRESS_FILTER && d.address !== ADDRESS_FILTER) return false;
    if (CHAIN_FILTER && d.chainId !== CHAIN_FILTER) return false;
    return true;
  });
}

function withTimeout(promise, label, ms = NETWORK_TIMEOUT_MS) {
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    })
  ]);
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NETWORK_TIMEOUT_MS);
  const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'kaisign-selector-proof/1.0' } }).finally(() => clearTimeout(timer));
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
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

async function fetchAbiApi(chainId, address) {
  if (!ETHERSCAN_API_KEY) throw new Error('ETHERSCAN_API_KEY missing; refusing to claim API proof. Use --allow-html-fallback only for non-API debugging.');
  const url = new URL('https://api.etherscan.io/v2/api');
  url.searchParams.set('chainid', String(chainId));
  url.searchParams.set('module', 'contract');
  url.searchParams.set('action', 'getabi');
  url.searchParams.set('address', address);
  url.searchParams.set('apikey', ETHERSCAN_API_KEY);
  const json = await fetchEtherscanJson(url);
  if (json.status !== '1') throw new Error(`Etherscan v2 getabi failed chain=${chainId} address=${address}: ${json.message} ${String(json.result).slice(0, 200)}`);
  return { source: 'etherscan-v2-getabi', abi: JSON.parse(json.result) };
}

async function fetchSourceCodeApi(chainId, address) {
  if (!ETHERSCAN_API_KEY) throw new Error('ETHERSCAN_API_KEY missing; refusing sourcecode API lookup.');
  const url = new URL('https://api.etherscan.io/v2/api');
  url.searchParams.set('chainid', String(chainId));
  url.searchParams.set('module', 'contract');
  url.searchParams.set('action', 'getsourcecode');
  url.searchParams.set('address', address);
  url.searchParams.set('apikey', ETHERSCAN_API_KEY);
  const json = await fetchEtherscanJson(url);
  if (json.status !== '1') throw new Error(`Etherscan v2 getsourcecode failed chain=${chainId} address=${address}: ${json.message} ${String(json.result).slice(0, 200)}`);
  return Array.isArray(json.result) ? json.result[0] : null;
}

async function fetchAbiHtml(chainId, address) {
  if (chainId !== 1) throw new Error(`HTML fallback implemented only for mainnet etherscan in this script; chain=${chainId}`);
  const res = await fetch(`https://etherscan.io/address/${address}#code`, { headers: { 'user-agent': 'Mozilla/5.0 kaisign-selector-proof/1.0' } });
  const html = await res.text();
  if (!res.ok) throw new Error(`Etherscan HTML failed ${address}: ${res.status}`);
  const m = html.match(/<pre[^>]*id=["']js-copytextarea2["'][^>]*>([\s\S]*?)<\/pre>/);
  if (!m) throw new Error(`No ABI pre#js-copytextarea2 for ${address}`);
  const abiText = m[1].replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
  return { source: 'etherscan-html-pre#js-copytextarea2', abi: JSON.parse(abiText) };
}

async function fetchVerifiedAbi(chainId, address) {
  const cached = readCachedAbi(chainId, address);
  if (cached) return cached;
  try { return await fetchAbiApi(chainId, address); }
  catch (e) {
    if (!ALLOW_HTML_FALLBACK) throw e;
    const fallback = await fetchAbiHtml(chainId, address);
    return { ...fallback, apiError: e.message };
  }
}

function readCachedAbi(chainId, address) {
  const kinds = fs.existsSync(CACHE_DIR)
    ? fs.readdirSync(CACHE_DIR, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name)
    : [];
  const preferred = ['verified-stack-source', 'sourcify', 'etherscan-v2', 'explorer-html', 'bookmarklet', 'blockscout'];
  const orderedKinds = [...preferred, ...kinds.filter(k => !preferred.includes(k))];
  for (const kind of orderedKinds) {
    const p = path.join(CACHE_DIR, kind, String(chainId), `${String(address).toLowerCase()}.json`);
    if (!fs.existsSync(p)) continue;
    try {
      const json = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (json?.notFound || !Array.isArray(json?.abi)) continue;
      return { source: `cache:${kind}`, abi: json.abi };
    } catch {}
  }
  return null;
}

function localSelectorsFromMetadata(abi, formats) {
  const map = new Map();
  for (const fn of abi || []) {
    if (!isWrite(fn)) continue;
    const selector = selectorOf(fn);
    if (SELECTOR_FILTER.size && !SELECTOR_FILTER.has(selector)) continue;
    map.set(selector, {
      fn,
      selector,
      signature: canonicalSignature(fn),
      hasFormat: displayHasFormat(formats, fn, selector)
    });
  }
  return map;
}

function writeSelectorsFromAbi(abi) {
  const out = [];
  for (const fn of abi || []) {
    if (!isWrite(fn)) continue;
    const selector = selectorOf(fn);
    if (SELECTOR_FILTER.size && !SELECTOR_FILTER.has(selector)) continue;
    out.push({
      selector,
      signature: canonicalSignature(fn),
      name: fn.name,
      stateMutability: fn.stateMutability || 'nonpayable',
      fn
    });
  }
  out.sort((a, b) => a.selector.localeCompare(b.selector) || a.signature.localeCompare(b.signature));
  return out;
}

async function implementationFor(chainId, address, { allowRpc = true } = {}) {
  let implementation = await apiImplementation(chainId, address).catch(() => null);
  if (!implementation && allowRpc) implementation = await eip1967Implementation(chainId, address).catch(() => null);
  return implementation;
}

async function getProvider(chainId) {
  const rpc = RPC_BY_CHAIN[chainId];
  if (!rpc) throw new Error(`No RPC configured for chain ${chainId}; set RPC_BY_CHAIN env override in script or filter chain.`);
  return new JsonRpcProvider(rpc, Number(chainId), { staticNetwork: true });
}

const EIP1967_IMPL_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';

async function eip1967Implementation(chainId, address) {
  const provider = await getProvider(chainId);
  const raw = await withTimeout(provider.getStorage(address, EIP1967_IMPL_SLOT), `getStorage chain=${chainId} address=${address}`);
  const impl = `0x${raw.slice(-40)}`;
  if (/^0x0{40}$/i.test(impl)) return null;
  return impl;
}

async function apiImplementation(chainId, address) {
  const src = await fetchSourceCodeApi(chainId, address).catch(() => null);
  const impl = src?.Implementation;
  if (impl && /^0x[a-fA-F0-9]{40}$/.test(impl)) return impl;
  return null;
}

async function maybeDiamondFacets(chainId, address) {
  try {
    const provider = await getProvider(chainId);
    const c = new Contract(address, LOUPE_ABI, provider);
    const facets = await withTimeout(c.facets(), `diamond facets chain=${chainId} address=${address}`);
    return facets.map(f => ({ facetAddress: f.facetAddress, selectors: f.functionSelectors.map(s => String(s).toLowerCase()) }));
  } catch {
    return null;
  }
}

async function liveCodeExists(chainId, address) {
  const provider = await getProvider(chainId);
  const code = await withTimeout(provider.getCode(address), `getCode chain=${chainId} address=${address}`);
  return code && code !== '0x';
}

function isCodeRequirementSatisfied(codeExists) {
  if (ABI_ONLY) return codeExists !== false;
  return codeExists === true;
}

async function proveDeployment(file, meta, deployment) {
  const abi = meta.context?.contract?.abi || [];
  const abiIsExternalReference = typeof abi === 'string';
  const formats = meta.display?.formats || {};
  const localSelectors = localSelectorsFromMetadata(abi, formats);

  const verified = await fetchVerifiedAbi(deployment.chainId, deployment.address);
  const codeExists = ABI_ONLY
    ? await liveCodeExists(deployment.chainId, deployment.address).catch(() => null)
    : await liveCodeExists(deployment.chainId, deployment.address);
  const shouldCheckDiamond = FULL_DIAMOND_CLOSURE || /diamond/i.test(file) || /diamond/i.test(String(meta.metadata?.contractName || ''));
  const diamondFacets = shouldCheckDiamond ? await maybeDiamondFacets(deployment.chainId, deployment.address) : null;

  const rows = [];
  const missing = [];

  if (diamondFacets) {
    for (const f of diamondFacets) {
      if (SELECTOR_FILTER.size && !f.selectors.some(s => SELECTOR_FILTER.has(s))) continue;
      const facetAbi = await fetchVerifiedAbi(deployment.chainId, f.facetAddress);
      for (const verifiedFn of writeSelectorsFromAbi(facetAbi.abi)) {
        const selector = verifiedFn.selector;
        if (!f.selectors.includes(selector)) continue;
        if (SELECTOR_FILTER.size && !SELECTOR_FILTER.has(selector)) continue;
        let local = localSelectors.get(selector) || (abiIsExternalReference ? {
          signature: verifiedFn.signature,
          hasFormat: displayHasFormat(formats, verifiedFn.fn, selector)
        } : null);
        if (FIX && !local && !abiIsExternalReference && addLocalMetadataFunction(meta, verifiedFn)) {
          local = { signature: verifiedFn.signature, hasFormat: displayHasFormat(meta.display.formats, verifiedFn.fn, selector) };
        }
        if (FIX && local && REQUIRE_DISPLAY && !local.hasFormat && addDisplayFormat(meta, verifiedFn)) {
          local.hasFormat = true;
        }
        const exclusion = selectorExclusionFor(meta, selector, verifiedFn.signature, verifiedFn.name);
        const row = {
          file, chainId: deployment.chainId, address: deployment.address, selector,
          localSignature: local?.signature || null, verifiedSignatures: [verifiedFn.signature],
          codeExists, diamond: true, liveFacet: f.facetAddress, abiSource: facetAbi.source,
          selectorInVerifiedAbi: true, localMetadata: Boolean(local), localDisplayFormat: Boolean(local?.hasFormat),
          excluded: Boolean(exclusion), exclusionReason: exclusion?.reason || null, exclusionCategory: exclusion?.category || null
        };
        rows.push(row);
        if (!exclusion && (!isCodeRequirementSatisfied(codeExists) || !local || (REQUIRE_DISPLAY && !local.hasFormat))) missing.push(row);
      }
    }
  } else {
    let source = verified.source;
    let verifiedAbi = verified.abi;
    const implementation = await implementationFor(deployment.chainId, deployment.address, { allowRpc: !ABI_ONLY });
    if (implementation) {
      const implAbi = await fetchVerifiedAbi(deployment.chainId, implementation);
      source = `${implAbi.source} implementation ${implementation}`;
      verifiedAbi = implAbi.abi;
    }

    for (const verifiedFn of writeSelectorsFromAbi(verifiedAbi)) {
      let local = localSelectors.get(verifiedFn.selector) || (abiIsExternalReference ? {
        signature: verifiedFn.signature,
        hasFormat: displayHasFormat(formats, verifiedFn.fn, verifiedFn.selector)
      } : null);
      if (FIX && !local && !abiIsExternalReference && addLocalMetadataFunction(meta, verifiedFn)) {
        local = { signature: verifiedFn.signature, hasFormat: displayHasFormat(meta.display.formats, verifiedFn.fn, verifiedFn.selector) };
      }
      if (FIX && local && REQUIRE_DISPLAY && !local.hasFormat && addDisplayFormat(meta, verifiedFn)) {
        local.hasFormat = true;
      }
      const exclusion = selectorExclusionFor(meta, verifiedFn.selector, verifiedFn.signature, verifiedFn.name);
      const row = {
        file, chainId: deployment.chainId, address: deployment.address, selector: verifiedFn.selector,
        localSignature: local?.signature || null, verifiedSignatures: [verifiedFn.signature],
        codeExists, diamond: false, liveFacet: null, abiSource: source, abiOnly: ABI_ONLY,
        selectorInVerifiedAbi: true, localMetadata: Boolean(local), localDisplayFormat: Boolean(local?.hasFormat),
        excluded: Boolean(exclusion), exclusionReason: exclusion?.reason || null, exclusionCategory: exclusion?.category || null
      };
      rows.push(row);
      if (!exclusion && (!isCodeRequirementSatisfied(codeExists) || !local || (REQUIRE_DISPLAY && !local.hasFormat))) missing.push(row);
    }
  }

  for (const sel of SELECTOR_FILTER) {
    if (!rows.some(r => r.selector === sel)) {
      missing.push({
        file, chainId: deployment.chainId, address: deployment.address, selector: sel,
        codeExists, diamond: Boolean(diamondFacets),
        error: diamondFacets ? 'selector not live on verified diamond facet ABI' : 'selector not found in verified write ABI'
      });
    }
  }

  return { rows, missing };
}

async function main() {
  if (args.has('--help')) { usage(); return; }
  const files = FILE_FILTER ? [FILE_FILTER] : walk(METADATA_DIR);
  const allRows = [];
  const allMissing = [];
  const skipped = [];

  async function processFile(file) {
    const rowsOut = [];
    const missingOut = [];
    const skippedOut = [];
    let meta;
    try { meta = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { skippedOut.push({ file, reason: `invalid json: ${e.message}` }); return { rowsOut, missingOut, skippedOut }; }
    const beforeFix = FIX ? JSON.stringify(meta) : null;
    const deployments = normalizeDeployments(meta);
    if (!deployments.length) { skippedOut.push({ file, reason: 'no deployment address+chainId' }); return { rowsOut, missingOut, skippedOut }; }
    for (const dep of deployments) {
      try {
        const { rows, missing } = await proveDeployment(file, meta, dep);
        rowsOut.push(...rows);
        missingOut.push(...missing);
      } catch (e) {
        missingOut.push({ file, chainId: dep.chainId, address: dep.address, error: e.message });
      }
    }
    if (FIX && JSON.stringify(meta) !== beforeFix) {
      fs.writeFileSync(file, `${JSON.stringify(meta, null, 2)}\n`);
    }
    return { rowsOut, missingOut, skippedOut };
  }

  let next = 0;
  async function worker() {
    while (next < files.length) {
      const i = next++;
      const file = files[i];
      if (args.has('--progress')) console.error(`[${i + 1}/${files.length}] ${file}`);
      const { rowsOut, missingOut, skippedOut } = await processFile(file);
      allRows.push(...rowsOut);
      allMissing.push(...missingOut);
      skipped.push(...skippedOut);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, () => worker()));

  const result = {
    ok: allMissing.length === 0,
    metadataDir: METADATA_DIR,
    mode: FULL_DIAMOND_CLOSURE ? 'verified-write-selectors-plus-diamond-closure' : 'verified-write-selectors',
    requireDisplay: REQUIRE_DISPLAY,
    userCallableOnly: USER_CALLABLE_ONLY,
    abiOnly: ABI_ONLY,
    fix: FIX,
    apiProof: !ALLOW_HTML_FALLBACK,
    filesScanned: files.length,
    rows: allRows.length,
    missing: allMissing.length,
    skipped,
    failures: allMissing,
    proofs: allRows
  };
  console.log(JSON.stringify(result, null, 2));
  if (allMissing.length) process.exit(1);
}

main().catch(e => {
  console.error(JSON.stringify({ ok: false, error: e.message, stack: e.stack }, null, 2));
  process.exit(2);
});
