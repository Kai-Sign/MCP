#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { Interface, JsonRpcProvider, Contract } from 'ethers';

const CHAIN_ID = Number(process.env.CHAIN_ID || 1);
const RPC_URL = process.env.ETH_RPC_URL || 'https://ethereum.publicnode.com';
const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY || process.env.ETHERSCAN_KEY || '';
const DIAMOND = process.env.LIFI_DIAMOND || '0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE';
const METADATA_PATH = process.env.KAISIGN_LIFI_METADATA || path.resolve('metadata/protocols/lifi-diamond.json');
const ALLOW_HTML_FALLBACK = process.argv.includes('--allow-html-fallback');
const ONLY_SELECTORS = new Set(
  (process.argv.find(a => a.startsWith('--selectors='))?.split('=')[1] || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
);

const LOUPE_ABI = [
  'function facets() view returns (tuple(address facetAddress, bytes4[] functionSelectors)[])',
  'function facetAddress(bytes4 _functionSelector) view returns (address facetAddress)'
];

function canonicalInput(input) {
  if (!input.type.startsWith('tuple')) return input.type;
  const suffix = input.type.slice('tuple'.length);
  const inner = (input.components || []).map(canonicalInput).join(',');
  return `(${inner})${suffix}`;
}

function canonicalSignature(fn) {
  return `${fn.name}(${(fn.inputs || []).map(canonicalInput).join(',')})`;
}

function selectorFromAbiFunction(fn) {
  const iface = new Interface([fn]);
  const fragment = iface.fragments.find(f => f.type === 'function');
  return iface.getFunction(fragment.format('sighash')).selector.toLowerCase();
}

function loadLocalMetadata() {
  const metadata = JSON.parse(fs.readFileSync(METADATA_PATH, 'utf8'));
  const abi = metadata.context?.contract?.abi || [];
  const formats = metadata.display?.formats || {};
  const selectors = new Map();
  for (const item of abi) {
    if (item?.type !== 'function') continue;
    const sig = canonicalSignature(item);
    const selector = selectorFromAbiFunction(item);
    selectors.set(selector, {
      sig,
      name: item.name,
      hasFormat: Boolean(formats[sig] || formats[selector] || formats[item.name])
    });
  }
  return selectors;
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'kaisign-selector-proof/1.0' } });
  const text = await res.text();
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

async function fetchAbiFromEtherscanApi(address) {
  if (!ETHERSCAN_API_KEY) {
    throw new Error('ETHERSCAN_API_KEY missing. Refusing to claim API proof without an API key. Set ETHERSCAN_API_KEY or pass --allow-html-fallback for explorer HTML proof only.');
  }
  const url = new URL('https://api.etherscan.io/v2/api');
  url.searchParams.set('chainid', String(CHAIN_ID));
  url.searchParams.set('module', 'contract');
  url.searchParams.set('action', 'getabi');
  url.searchParams.set('address', address);
  url.searchParams.set('apikey', ETHERSCAN_API_KEY);
  const json = await fetchJson(url.toString());
  if (json.status !== '1') throw new Error(`Etherscan API getabi failed for ${address}: ${json.message} ${String(json.result).slice(0, 200)}`);
  return { source: 'etherscan-v2-getabi', abi: JSON.parse(json.result) };
}

async function fetchAbiFromExplorerHtml(address) {
  const url = `https://etherscan.io/address/${address}#code`;
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 kaisign-selector-proof/1.0' } });
  const html = await res.text();
  if (!res.ok) throw new Error(`Etherscan HTML failed for ${address}: ${res.status}`);
  const m = html.match(/<pre[^>]*id=["']js-copytextarea2["'][^>]*>([\s\S]*?)<\/pre>/);
  if (!m) throw new Error(`No ABI pre#js-copytextarea2 found for ${address}`);
  const abiText = m[1]
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
  return { source: 'etherscan-html-pre#js-copytextarea2', abi: JSON.parse(abiText) };
}

async function fetchVerifiedAbi(address) {
  try {
    return await fetchAbiFromEtherscanApi(address);
  } catch (apiError) {
    if (!ALLOW_HTML_FALLBACK) throw apiError;
    const html = await fetchAbiFromExplorerHtml(address);
    return { ...html, apiError: apiError.message };
  }
}

function functionSelectorsFromAbi(abi) {
  const out = [];
  for (const item of abi) {
    if (item?.type !== 'function') continue;
    const state = item.stateMutability || '';
    if (state === 'view' || state === 'pure') continue;
    const sig = canonicalSignature(item);
    const selector = selectorFromAbiFunction(item);
    out.push({ selector, sig, name: item.name, stateMutability: state || 'nonpayable' });
  }
  out.sort((a, b) => a.selector.localeCompare(b.selector) || a.sig.localeCompare(b.sig));
  return out;
}

async function main() {
  const provider = new JsonRpcProvider(RPC_URL);
  const diamond = new Contract(DIAMOND, LOUPE_ABI, provider);
  const local = loadLocalMetadata();

  const facets = await diamond.facets();
  const rows = [];
  const missing = [];
  const checkedFacets = [];

  for (const facet of facets) {
    const facetAddress = facet.facetAddress;
    const liveSelectors = new Set(facet.functionSelectors.map(s => String(s).toLowerCase()));
    const wanted = ONLY_SELECTORS.size ? [...liveSelectors].some(s => ONLY_SELECTORS.has(s)) : true;
    if (!wanted) continue;

    const { source, abi, apiError } = await fetchVerifiedAbi(facetAddress);
    checkedFacets.push({ facetAddress, source, apiError, liveSelectors: liveSelectors.size });
    const verifiedFunctions = functionSelectorsFromAbi(abi);

    for (const fn of verifiedFunctions) {
      if (!liveSelectors.has(fn.selector)) continue;
      if (ONLY_SELECTORS.size && !ONLY_SELECTORS.has(fn.selector)) continue;
      const localHit = local.get(fn.selector);
      const row = {
        diamond: DIAMOND,
        facet: facetAddress,
        selector: fn.selector,
        signature: fn.sig,
        abiSource: source,
        liveOnDiamond: true,
        localMetadata: Boolean(localHit),
        localMetadataSignature: localHit?.sig || null,
        localDisplayFormat: Boolean(localHit?.hasFormat)
      };
      rows.push(row);
      if (!row.localMetadata || !row.localDisplayFormat) missing.push(row);
    }
  }

  for (const sel of ONLY_SELECTORS) {
    if (!rows.some(r => r.selector === sel)) {
      const facet = await diamond.facetAddress(sel);
      missing.push({ diamond: DIAMOND, selector: sel, facet, liveOnDiamond: facet !== '0x0000000000000000000000000000000000000000', error: 'selector not proven from verified facet ABI' });
    }
  }

  rows.sort((a, b) => a.facet.localeCompare(b.facet) || a.selector.localeCompare(b.selector));
  console.log(JSON.stringify({
    ok: missing.length === 0,
    chainId: CHAIN_ID,
    rpc: RPC_URL,
    diamond: DIAMOND,
    metadataPath: METADATA_PATH,
    mode: ONLY_SELECTORS.size ? 'selected-selectors' : 'all-live-diamond-write-selectors',
    selectorsRequested: [...ONLY_SELECTORS],
    facetsChecked: checkedFacets,
    liveVerifiedWriteSelectors: rows.length,
    missingLocalMetadataOrDisplay: missing.length,
    missing,
    rows
  }, null, 2));

  if (missing.length) process.exit(1);
}

main().catch(err => {
  console.error(JSON.stringify({ ok: false, error: err.message, stack: err.stack }, null, 2));
  process.exit(2);
});
