#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ethers } from 'ethers';

const DEFAULT_REGISTRY = '0xf70D41afe5Ff76Ac3Bee86BCBda07450f3b590F0';
const DEFAULT_CHAIN_ID = 11155111;
const DEFAULT_RPC = process.env.SEPOLIA_RPC_URL || 'https://ethereum-sepolia.publicnode.com';
const DEFAULT_KEYSTORE = path.resolve('.kaisign', 'submission-keystore.json');
const MIN_BLOB_DATA_SIZE = 24 * 1024;
const PADDING_MARKER = '\n\n/* ERC7730_BLOB_PADDING_START */\n';

const REGISTRY_ABI = [
  'function minBond() view returns (uint256)',
  'function bondToken() view returns (address)',
  'function realityETH() view returns (address)',
  'function commitSpec(bytes32 commitment,uint256 chainId,bytes32 extcodehash) returns (bytes32 commitmentId)',
  'function revealSpec(bytes32 commitmentId,bytes32 blobHash,uint256 nonce,bytes32 metadataHash,uint256 tokenAmount) returns (bytes32 uid)'
];
const ERC20_ABI = [
  'function approve(address spender,uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner,address spender) view returns (uint256)'
];
const REALITY_ABI = [
  'function submitAnswerERC20(bytes32 question_id,bytes32 answer,uint256 max_previous,uint256 tokens)',
  'function getBond(bytes32 question_id) view returns (uint256)',
  'function questions(bytes32) view returns (bytes32 content_hash,address arbitrator,uint32 opening_ts,uint32 timeout,uint32 finalize_ts,bool is_pending_arbitration,uint256 bounty,bytes32 best_answer,bytes32 history_hash,uint256 bond,uint256 min_bond)'
];

// Optional SubmissionSponsor: lets a user submit WITHOUT holding the bond token.
// The sponsor holds the bond pool and is the attester; the user just calls these and pays gas.
// Set via --sponsor=0x... or SPONSOR_ADDRESS env. Once deployed, hardcode DEFAULT_SPONSOR.
const DEFAULT_SPONSOR = process.env.SPONSOR_ADDRESS || '0x8a9d99d4ef98a342fee36bb80f62381906e02ca8';
const SPONSOR_ABI = [
  'function sponsoredCommit(bytes32 commitment,uint256 chainId,bytes32 extcodehash) returns (bytes32 commitmentId)',
  'function sponsoredReveal(bytes32 commitmentId,bytes32 blobHash,uint256 nonce,bytes32 metadataHash) returns (bytes32 uid)'
];

const registryIface = new ethers.Interface(REGISTRY_ABI);
const erc20Iface = new ethers.Interface(ERC20_ABI);
const realityIface = new ethers.Interface(REALITY_ABI);
const sponsorIface = new ethers.Interface(SPONSOR_ABI);

function parseArgs(argv) {
  const out = { _: [] };
  for (const raw of argv) {
    if (!raw.startsWith('--')) out._.push(raw);
    else {
      const body = raw.slice(2);
      const eq = body.indexOf('=');
      if (eq === -1) out[body] = true;
      else out[body.slice(0, eq)] = body.slice(eq + 1);
    }
  }
  return out;
}

function usage() {
  console.error(`Usage:

SPONSORED (recommended): agent-held burner pays only GAS; the SubmissionSponsor posts the bond.
The burner posts the EIP-4844 blob and calls the sponsor. No bond token needed.
  node scripts/submission-keystore.mjs init-burner [--sponsor=0x...] [--password-file=.kaisign/pw.txt]
  # fund the printed burner address with a little Sepolia ETH (gas only), then:
  node scripts/submission-keystore.mjs submit-sponsored --metadata=metadata/file.json [--password-file=.kaisign/pw.txt] [--blob-hash=0x01...]
    # default: the burner posts the EIP-4844 blob locally (needs c-kzg).
    # --blob-hash=0x01...: use a blob already posted elsewhere (e.g. by the backend); the burner only does commit/reveal.

DIRECT (you bring your own bond-token-holding address and sign yourself):
  node scripts/submission-keystore.mjs init --address=0xYourSubmitter [--output=.kaisign/submission-keystore.json]
  node scripts/submission-keystore.mjs status
  node scripts/submission-keystore.mjs prepare-commit --metadata=metadata/file.json [--blob-hash=0x...]
  node scripts/submission-keystore.mjs prepare-reveal --state=.kaisign/submission-state/*.json --commitment-id=0x...
  node scripts/submission-keystore.mjs prepare-sponsored-commit --metadata=metadata/file.json [--sponsor=0x...] [--blob-hash=0x...]
  node scripts/submission-keystore.mjs prepare-sponsored-reveal --state=.kaisign/submission-state/*.json --commitment-id=0x... [--sponsor=0x...]
  node scripts/submission-keystore.mjs prepare-vote --question-id=0x...
  node scripts/submission-keystore.mjs verify-tx --tx=tx.json

You bring your own submitter address (an address YOU control, holding only Sepolia gas + KaiSign bond tokens).
This tool holds NO private key. It records your address as a public scope manifest and only PREPARES unsigned KaiSign
submission transactions to ${DEFAULT_REGISTRY}. You sign them with your own wallet and broadcast (e.g. via the backend
/eth/sendRawTransaction relay or any Sepolia RPC).
`);
}

function assertAddress(value, label) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(String(value || ''))) throw new Error(`${label} must be a 20-byte 0x address`);
  return ethers.getAddress(String(value));
}

function assertBytes32(value, label) {
  if (!/^0x[a-fA-F0-9]{64}$/.test(String(value || ''))) throw new Error(`${label} must be bytes32`);
  return String(value).toLowerCase();
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function scopeManifest(args = {}) {
  const registry = ethers.getAddress(DEFAULT_REGISTRY);
  const submitterAddress = assertAddress(args.address, '--address');
  return {
    version: 3,
    kind: 'kaisign-submission-scope',
    signingMaterial: 'none',
    warning: 'Public scope manifest only. Holds NO private key. You sign with your own wallet. Use an address you control that holds only Sepolia gas + KaiSign bond tokens.',
    registryChainId: DEFAULT_CHAIN_ID,
    registry,
    submitterAddress,
    allowed: {
      registryCalls: [
        { signature: 'commitSpec(bytes32,uint256,bytes32)', selector: registryIface.getFunction('commitSpec').selector },
        { signature: 'revealSpec(bytes32,bytes32,uint256,bytes32,uint256)', selector: registryIface.getFunction('revealSpec').selector }
      ],
      erc20ApprovalSpenders: [registry],
      realityCalls: [
        { signature: 'submitAnswerERC20(bytes32,bytes32,uint256,uint256)', selector: realityIface.getFunction('submitAnswerERC20').selector }
      ]
    },
    createdAt: new Date().toISOString()
  };
}

// ======================= BURNER (sponsored, gas-only path) =======================
// For the SubmissionSponsor flow the agent generates and holds an encrypted burner.
// The burner pays only GAS — it never needs the bond token (the sponsor posts the bond).
// It posts the EIP-4844 blob and calls the sponsor's commit/reveal. This is a SEPARATE
// keystore kind from the keyless scope manifest above.
const DEFAULT_BURNER = path.resolve('.kaisign', 'burner.json');
const DEFAULT_BLOB_RPC = process.env.BLOB_RPC_URL || 'https://ethereum-sepolia-rpc.publicnode.com';

async function readPassword(args) {
  if (args['password-file']) return fs.readFileSync(String(args['password-file']), 'utf8').trim();
  if (args.password) return String(args.password);
  if (!process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const password = Buffer.concat(chunks).toString('utf8').trim();
    if (password) return password;
  }
  throw new Error('Pass --password-file=<path>, --password=<dev-only>, or pipe a password on stdin to encrypt/decrypt the burner');
}

async function createBurner(args) {
  const sponsor = args.sponsor ? assertAddress(args.sponsor, '--sponsor') : (DEFAULT_SPONSOR ? assertAddress(DEFAULT_SPONSOR, 'DEFAULT_SPONSOR') : '');
  if (!sponsor) throw new Error('no sponsor set; pass --sponsor=0x... or set SPONSOR_ADDRESS/DEFAULT_SPONSOR');
  const wallet = new ethers.Wallet(ethers.hexlify(crypto.randomBytes(32)));
  const password = await readPassword(args);
  const encryptedWallet = JSON.parse(await wallet.encrypt(password));
  return {
    version: 1,
    kind: 'kaisign-burner',
    warning: 'Agent-held burner for KaiSign SPONSORED submissions. Fund with Sepolia GAS only (no bond token needed). Do not reuse for funds.',
    registryChainId: DEFAULT_CHAIN_ID,
    registry: ethers.getAddress(DEFAULT_REGISTRY),
    sponsor: ethers.getAddress(sponsor),
    submitterAddress: wallet.address,
    encryptedWallet,
    createdAt: new Date().toISOString()
  };
}

async function loadBurnerWallet(args, provider) {
  const file = args.burner || DEFAULT_BURNER;
  const ks = readJson(file);
  if (ks.kind !== 'kaisign-burner') throw new Error(`${file} is not a KaiSign burner keystore`);
  if (ethers.getAddress(ks.registry) !== ethers.getAddress(DEFAULT_REGISTRY)) throw new Error('burner registry mismatch');
  const password = await readPassword(args);
  const wallet = (await ethers.Wallet.fromEncryptedJson(JSON.stringify(ks.encryptedWallet), password)).connect(provider);
  if (ethers.getAddress(wallet.address) !== ethers.getAddress(ks.submitterAddress)) {
    throw new Error('decrypted burner does not match stored submitterAddress');
  }
  return { wallet, ks };
}

function loadKeystore(file = DEFAULT_KEYSTORE) {
  const ks = readJson(file);
  if (ks.kind !== 'kaisign-submission-scope') {
    throw new Error(`${file} is not a KaiSign scoped submission keystore`);
  }
  if (!ks.submitterAddress) throw new Error(`${file} is missing submitterAddress`);
  if (ethers.getAddress(ks.registry) !== ethers.getAddress(DEFAULT_REGISTRY)) {
    throw new Error(`keystore registry mismatch: expected ${DEFAULT_REGISTRY}, got ${ks.registry}`);
  }
  if (Number(ks.registryChainId) !== DEFAULT_CHAIN_ID) {
    throw new Error(`keystore chain mismatch: expected ${DEFAULT_CHAIN_ID}, got ${ks.registryChainId}`);
  }
  const secretLike = [];
  function scan(value, trail = []) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      const next = [...trail, key];
      if (/^(privateKey|private_key|mnemonic|seed|phrase|encryptedWallet|crypto|keystore)$/i.test(key)) secretLike.push(next.join('.'));
      scan(child, next);
    }
  }
  scan(ks);
  if (secretLike.length) {
    throw new Error(`${file} contains signing-material fields: ${secretLike.join(', ')}`);
  }
  ks.submitterAddress = assertAddress(ks.submitterAddress, 'keystore.submitterAddress');
  return ks;
}

function metadataDeployments(metadata) {
  const c = metadata.context?.contract || {};
  const out = [];
  if (c.address && c.chainId) out.push({ address: assertAddress(c.address, 'context.contract.address'), chainId: Number(c.chainId), source: 'context.contract' });
  if (c.deployments && typeof c.deployments === 'object') {
    for (const [network, deployment] of Object.entries(c.deployments)) {
      const items = Array.isArray(deployment) ? deployment : [deployment];
      for (const item of items) {
        if (item?.address && item?.chainId) {
          out.push({ address: assertAddress(item.address, `deployments.${network}.address`), chainId: Number(item.chainId), source: `deployments.${network}` });
        }
      }
    }
  }
  const seen = new Set();
  return out.filter(dep => {
    const key = `${dep.chainId}:${dep.address.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return dep.chainId > 0;
  });
}

function chainRpc(chainId) {
  const envByChain = {
    1: process.env.ETH_RPC_URL,
    10: process.env.OPTIMISM_RPC_URL,
    56: process.env.BSC_RPC_URL,
    100: process.env.GNOSIS_RPC_URL,
    137: process.env.POLYGON_RPC_URL,
    8453: process.env.BASE_RPC_URL,
    42161: process.env.ARBITRUM_RPC_URL,
    43114: process.env.AVALANCHE_RPC_URL,
    11155111: process.env.SEPOLIA_RPC_URL,
    84532: process.env.BASE_SEPOLIA_RPC_URL
  };
  const fallback = {
    1: 'https://ethereum.publicnode.com',
    10: 'https://optimism.publicnode.com',
    56: 'https://bsc.publicnode.com',
    100: 'https://gnosis-rpc.publicnode.com',
    137: 'https://polygon-bor-rpc.publicnode.com',
    8453: 'https://base.publicnode.com',
    42161: 'https://arbitrum-one.publicnode.com',
    43114: 'https://avalanche-c-chain-rpc.publicnode.com',
    11155111: DEFAULT_RPC,
    84532: 'https://base-sepolia-rpc.publicnode.com'
  };
  return envByChain[chainId] || fallback[chainId];
}

async function extcodehash(address, chainId) {
  const rpc = chainRpc(chainId);
  if (!rpc) throw new Error(`No RPC configured for metadata chain ${chainId}`);
  const provider = new ethers.JsonRpcProvider(rpc, chainId, { staticNetwork: true });
  const code = await provider.getCode(address);
  if (code === '0x') throw new Error(`No code at ${address} on chain ${chainId}`);
  return ethers.keccak256(code);
}

function addPaddingIfNeeded(data) {
  if (data.length >= MIN_BLOB_DATA_SIZE) return { paddedData: data, wasPadded: false };
  const paddingNeeded = MIN_BLOB_DATA_SIZE - data.length - PADDING_MARKER.length;
  if (paddingNeeded <= 0) return { paddedData: data, wasPadded: false };
  return { paddedData: data + PADDING_MARKER + '0'.repeat(paddingNeeded), wasPadded: true };
}

function toBlob(data) {
  const blob = new Uint8Array(131072);
  const bytes = Buffer.from(data);
  let blobIndex = 0;
  for (let i = 0; i < bytes.length; i++) {
    const fieldIndex = Math.floor(blobIndex / 31);
    const byteIndex = blobIndex % 31;
    if (fieldIndex >= 4096) break;
    blob[fieldIndex * 32 + byteIndex + 1] = bytes[i] ?? 0;
    blobIndex++;
  }
  return blob;
}

async function computeBlobHashIfPossible(rawMetadata) {
  try {
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const cKzg = require('c-kzg');
    try { cKzg.loadTrustedSetup(0, cKzg.DEFAULT_TRUSTED_SETUP_PATH); } catch {}
    const { paddedData, wasPadded } = addPaddingIfNeeded(rawMetadata);
    const blob = toBlob(paddedData);
    const commitment = cKzg.blobToKzgCommitment(blob);
    const proof = cKzg.computeBlobKzgProof(blob, commitment);
    if (!cKzg.verifyBlobKzgProof(blob, commitment, proof)) throw new Error('invalid KZG proof');
    const commitmentHash = ethers.sha256(commitment);
    return { blobHash: `0x01${commitmentHash.substring(4)}`, wasPadded, kzgAvailable: true };
  } catch (e) {
    return { blobHash: null, wasPadded: null, kzgAvailable: false, kzgError: e.message };
  }
}

function randomNonce() {
  return BigInt(`0x${crypto.randomBytes(32).toString('hex')}`);
}

function txObject({ to, from, data, value = '0', chainId = DEFAULT_CHAIN_ID, note }) {
  return { to: ethers.getAddress(to), from: ethers.getAddress(from), chainId, value, data, note };
}

async function registryContext() {
  const provider = new ethers.JsonRpcProvider(DEFAULT_RPC, DEFAULT_CHAIN_ID, { staticNetwork: true });
  const registry = new ethers.Contract(DEFAULT_REGISTRY, REGISTRY_ABI, provider);
  const [minBond, bondToken, realityETH] = await Promise.all([
    registry.minBond(),
    registry.bondToken(),
    registry.realityETH()
  ]);
  return {
    provider,
    minBond: minBond.toString(),
    bondToken: ethers.getAddress(bondToken),
    realityETH: ethers.getAddress(realityETH)
  };
}

let _kzg = null;
async function kzgInstance() {
  if (_kzg) return _kzg;
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const cKzg = require('c-kzg');
  try { cKzg.loadTrustedSetup(0, cKzg.DEFAULT_TRUSTED_SETUP_PATH); } catch {}
  _kzg = cKzg;
  return cKzg;
}

// Build blob + KZG commitment/proof + versioned hash for a metadata string.
async function buildBlob(rawMetadata) {
  const cKzg = await kzgInstance();
  const { paddedData } = addPaddingIfNeeded(rawMetadata);
  const blob = toBlob(paddedData);
  const commitment = cKzg.blobToKzgCommitment(blob);
  const proof = cKzg.computeBlobKzgProof(blob, commitment);
  if (!cKzg.verifyBlobKzgProof(blob, commitment, proof)) throw new Error('invalid KZG proof');
  const versionedHash = `0x01${ethers.sha256(commitment).substring(4)}`;
  return { blob, commitment, proof, versionedHash };
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Full sponsored submission from the agent-held burner (gas only, no bond token):
//   build blob -> post EIP-4844 blob tx -> sponsoredCommit -> wait a block -> sponsoredReveal.
async function submitSponsored(args) {
  const provider = new ethers.JsonRpcProvider(DEFAULT_RPC, DEFAULT_CHAIN_ID, { staticNetwork: true });
  const { wallet, ks } = await loadBurnerWallet(args, provider);
  const sponsorAddr = args.sponsor ? assertAddress(args.sponsor, '--sponsor') : ks.sponsor;
  const sponsor = new ethers.Contract(sponsorAddr, SPONSOR_ABI, wallet);

  const metadataPath = String(args.metadata || '');
  if (!metadataPath) throw new Error('--metadata is required');
  const rawMetadata = fs.readFileSync(metadataPath, 'utf8');
  const metadata = JSON.parse(rawMetadata);
  const deployments = metadataDeployments(metadata);
  if (!deployments.length) throw new Error('metadata has no context.contract address+chainId or deployments');
  const dep = args['target-address']
    ? deployments.find(d => d.address.toLowerCase() === String(args['target-address']).toLowerCase())
    : deployments[0];
  if (!dep) throw new Error('--target-address not present in metadata deployments');

  const gasBal = await provider.getBalance(wallet.address);
  if (gasBal === 0n) throw new Error(`burner ${wallet.address} has no Sepolia gas; fund it first`);

  const metadataHash = ethers.keccak256(ethers.toUtf8Bytes(rawMetadata));
  const codeHash = await extcodehash(dep.address, dep.chainId);
  const nonce = randomNonce();

  console.error(`burner: ${wallet.address}`);
  console.error(`sponsor: ${sponsorAddr}`);

  // 1) Get the blob versioned hash. Two modes:
  //    a) --blob-hash=0x01...  -> the blob was already posted elsewhere (e.g. by the backend
  //       or any EOA uploader). We only need the hash; we do NOT post a blob here.
  //    b) default               -> build and post the EIP-4844 blob (type-3) from the burner.
  let versionedHash;
  let blobTxHash = null;
  if (args['blob-hash']) {
    versionedHash = assertBytes32(args['blob-hash'], '--blob-hash');
    if (!versionedHash.startsWith('0x01')) throw new Error('--blob-hash must be an EIP-4844 versioned hash (0x01...)');
    console.error(`using externally-posted blob hash: ${versionedHash}`);
  } else {
    console.error('building blob...');
    const cKzg = await kzgInstance();
    const built = await buildBlob(rawMetadata);
    versionedHash = built.versionedHash;
    console.error('posting blob (type-3) ...');
    const blobProvider = new ethers.JsonRpcProvider(DEFAULT_BLOB_RPC, DEFAULT_CHAIN_ID, { staticNetwork: true });
    const blobSigner = wallet.connect(blobProvider);
    const latest = await blobProvider.getBlock('latest');
    const baseFee = latest?.baseFeePerGas ?? ethers.parseUnits('1', 'gwei');
    const blobTx = await blobSigner.sendTransaction({
      type: 3,
      to: ethers.ZeroAddress,
      value: 0n,
      maxPriorityFeePerGas: ethers.parseUnits('2', 'gwei'),
      maxFeePerGas: baseFee * 2n + ethers.parseUnits('2', 'gwei'),
      maxFeePerBlobGas: ethers.parseUnits('30', 'gwei'),
      blobVersionedHashes: [versionedHash],
      kzg: cKzg,
      blobs: [built.blob]
    });
    blobTxHash = blobTx.hash;
    console.error(`  blob tx: ${blobTx.hash}`);
    const blobRcpt = await blobTx.wait();
    console.error(`  blob in block ${blobRcpt.blockNumber}; blobscan: https://sepolia.blobscan.com/blob/${versionedHash}`);
  }
  const commitment = ethers.keccak256(ethers.solidityPacked(['bytes32', 'uint256'], [versionedHash, nonce]));

  // 2) sponsoredCommit
  console.error('sponsoredCommit ...');
  const commitTx = await sponsor.sponsoredCommit(commitment, dep.chainId, codeHash);
  const commitRcpt = await commitTx.wait();
  // commitmentId = registry LogCommitSpec topic[2]
  const lcs = ethers.id('LogCommitSpec(address,bytes32,uint256,bytes32)');
  const commitLog = commitRcpt.logs.find(l => l.topics[0] === lcs);
  if (!commitLog) throw new Error('LogCommitSpec not found in commit receipt');
  const commitmentId = commitLog.topics[2];
  console.error(`  commit tx: ${commitTx.hash}  commitmentId: ${commitmentId}`);

  // 3) wait for next block (MIN_REVEAL_DELAY)
  console.error('waiting for next block (MIN_REVEAL_DELAY) ...');
  const b0 = await provider.getBlockNumber();
  while (await provider.getBlockNumber() <= b0) await sleep(3000);

  // 4) sponsoredReveal
  console.error('sponsoredReveal ...');
  const revealTx = await sponsor.sponsoredReveal(commitmentId, versionedHash, nonce, metadataHash);
  const revealRcpt = await revealTx.wait();
  const qc = ethers.id('QuestionCreated(bytes32,bytes32,uint256)');
  const qLog = revealRcpt.logs.find(l => l.topics[0] === qc);
  const uid = qLog ? qLog.topics[1] : null;
  const questionId = qLog ? qLog.topics[2] : null;

  console.log(JSON.stringify({
    ok: true,
    burner: wallet.address,
    sponsor: ethers.getAddress(sponsorAddr),
    target: dep.address,
    chainId: dep.chainId,
    blobHash: versionedHash,
    blobTx: blobTxHash,
    blobPostedExternally: blobTxHash === null,
    blobscan: `https://sepolia.blobscan.com/blob/${versionedHash}`,
    commitTx: commitTx.hash,
    commitmentId,
    revealTx: revealTx.hash,
    uid,
    questionId,
    metadataHash
  }, null, 2));
}

async function prepareCommit(args, sponsored = false) {
  const ks = loadKeystore(args.keystore || DEFAULT_KEYSTORE);
  const from = ks.submitterAddress;
  const metadataPath = String(args.metadata || '');
  if (!metadataPath) throw new Error('--metadata is required');
  const rawMetadata = fs.readFileSync(metadataPath, 'utf8');
  const metadata = JSON.parse(rawMetadata);
  const deployments = metadataDeployments(metadata);
  if (!deployments.length) throw new Error('metadata has no context.contract address+chainId or deployments');
  const dep = args['target-address']
    ? deployments.find(d => d.address.toLowerCase() === String(args['target-address']).toLowerCase())
    : deployments[0];
  if (!dep) throw new Error('--target-address not present in metadata deployments');

  const blobInfo = args['blob-hash']
    ? { blobHash: assertBytes32(args['blob-hash'], '--blob-hash'), kzgAvailable: false, supplied: true }
    : await computeBlobHashIfPossible(rawMetadata);
  if (!blobInfo.blobHash) {
    throw new Error(`Blob hash unavailable. Install c-kzg or pass --blob-hash=0x... from your blob uploader. KZG error: ${blobInfo.kzgError || 'n/a'}`);
  }

  const nonce = args.nonce ? BigInt(String(args.nonce)) : randomNonce();
  const metadataHash = ethers.keccak256(ethers.toUtf8Bytes(rawMetadata));
  const codeHash = await extcodehash(dep.address, dep.chainId);
  const commitment = ethers.keccak256(ethers.solidityPacked(['bytes32', 'uint256'], [blobInfo.blobHash, nonce]));

  // Sponsored mode: call the SubmissionSponsor instead of the registry directly, so the user
  // does not need to hold the bond token. The sponsor is the registry committer/attester.
  const sponsorAddr = args.sponsor ? assertAddress(args.sponsor, '--sponsor') : (DEFAULT_SPONSOR ? assertAddress(DEFAULT_SPONSOR, 'SPONSOR_ADDRESS') : '');
  if (sponsored && !sponsorAddr) throw new Error('sponsored commit requires --sponsor=0x... or SPONSOR_ADDRESS');

  const data = sponsored
    ? sponsorIface.encodeFunctionData('sponsoredCommit', [commitment, dep.chainId, codeHash])
    : registryIface.encodeFunctionData('commitSpec', [commitment, dep.chainId, codeHash]);
  const commitTo = sponsored ? sponsorAddr : DEFAULT_REGISTRY;
  const commitTx = txObject({
    to: commitTo,
    from,
    data,
    note: sponsored
      ? 'Sponsored: sign and broadcast first. Read commitmentId from the SponsoredCommit/LogCommitSpec event, then run prepare-sponsored-reveal at least one block later.'
      : 'Sign and broadcast this first. Read commitmentId from LogCommitSpec, then run prepare-reveal.'
  });
  const state = {
    version: 1,
    kind: 'kaisign-submission-state',
    sponsored,
    sponsor: sponsored ? ethers.getAddress(sponsorAddr) : null,
    metadataPath: path.resolve(metadataPath),
    targetContract: dep.address,
    targetChainId: dep.chainId,
    registry: ethers.getAddress(DEFAULT_REGISTRY),
    registryChainId: DEFAULT_CHAIN_ID,
    from,
    extcodehash: codeHash,
    metadataHash,
    blobHash: blobInfo.blobHash,
    nonce: nonce.toString(),
    commitment,
    commitTx,
    generatedAt: new Date().toISOString()
  };
  const out = path.resolve(args.output || path.join('.kaisign', 'submission-state', `${path.basename(metadataPath, '.json')}-${Date.now()}.json`));
  writeJson(out, state);
  console.log(JSON.stringify({ ok: true, stateFile: out, state }, null, 2));
}

async function prepareReveal(args, sponsored = false) {
  const ks = loadKeystore(args.keystore || DEFAULT_KEYSTORE);
  const state = readJson(String(args.state || ''));
  const from = ks.submitterAddress;
  if (state.from && ethers.getAddress(state.from) !== from) throw new Error(`state submitter ${state.from} does not match keystore submitter ${from}`);
  const commitmentId = assertBytes32(args['commitment-id'], '--commitment-id');
  if (ethers.getAddress(state.registry) !== ethers.getAddress(DEFAULT_REGISTRY)) throw new Error('state registry mismatch');

  // Sponsored mode: single call to the sponsor, no token approval (sponsor posts the bond).
  if (sponsored || state.sponsored) {
    const sponsorAddr = args.sponsor
      ? assertAddress(args.sponsor, '--sponsor')
      : (state.sponsor ? assertAddress(state.sponsor, 'state.sponsor') : (DEFAULT_SPONSOR ? assertAddress(DEFAULT_SPONSOR, 'SPONSOR_ADDRESS') : ''));
    if (!sponsorAddr) throw new Error('sponsored reveal requires a sponsor address (state.sponsor, --sponsor, or SPONSOR_ADDRESS)');
    const revealData = sponsorIface.encodeFunctionData('sponsoredReveal', [
      commitmentId,
      state.blobHash,
      BigInt(state.nonce),
      state.metadataHash
    ]);
    const txs = [
      txObject({ to: sponsorAddr, from, data: revealData, note: 'Sponsored reveal: sign at least one block after the sponsored commit. No token approval needed; the sponsor posts the bond.' })
    ];
    console.log(JSON.stringify({ ok: true, sponsored: true, sponsor: ethers.getAddress(sponsorAddr), txs }, null, 2));
    return;
  }

  const ctx = await registryContext();
  const minBond = args['token-amount'] ? BigInt(String(args['token-amount'])) : BigInt(ctx.minBond);
  const approveData = erc20Iface.encodeFunctionData('approve', [DEFAULT_REGISTRY, minBond]);
  const revealData = registryIface.encodeFunctionData('revealSpec', [
    commitmentId,
    state.blobHash,
    BigInt(state.nonce),
    state.metadataHash,
    minBond
  ]);
  const txs = [
    txObject({ to: ctx.bondToken, from, data: approveData, note: `Approve exactly ${minBond} bond tokens for registry reveal` }),
    txObject({ to: DEFAULT_REGISTRY, from, data: revealData, note: 'Reveal metadata spec after commit tx is mined and blob is available' })
  ];
  console.log(JSON.stringify({ ok: true, registry: ethers.getAddress(DEFAULT_REGISTRY), bondToken: ctx.bondToken, minBond: minBond.toString(), txs }, null, 2));
}

async function prepareVote(args) {
  const ks = loadKeystore(args.keystore || DEFAULT_KEYSTORE);
  const from = ks.submitterAddress;
  const questionId = assertBytes32(args['question-id'], '--question-id');
  const ctx = await registryContext();
  const provider = new ethers.JsonRpcProvider(DEFAULT_RPC, DEFAULT_CHAIN_ID, { staticNetwork: true });
  const reality = new ethers.Contract(ctx.realityETH, REALITY_ABI, provider);
  const [currentBond, question] = await Promise.all([reality.getBond(questionId), reality.questions(questionId)]);
  const newBond = args.tokens ? BigInt(String(args.tokens)) : (currentBond === 0n ? BigInt(question.min_bond || ctx.minBond) : currentBond * 2n);
  const validAnswer = ethers.zeroPadValue(ethers.toBeHex(1), 32);
  const txs = [
    txObject({ to: ctx.bondToken, from, data: erc20Iface.encodeFunctionData('approve', [ctx.realityETH, newBond]), note: `Approve exactly ${newBond} bond tokens for Reality.eth vote` }),
    txObject({ to: ctx.realityETH, from, data: realityIface.encodeFunctionData('submitAnswerERC20', [questionId, validAnswer, currentBond, newBond]), note: 'Vote VALID on the metadata submission question' })
  ];
  console.log(JSON.stringify({ ok: true, realityETH: ctx.realityETH, bondToken: ctx.bondToken, currentBond: currentBond.toString(), newBond: newBond.toString(), txs }, null, 2));
}


async function status(args) {
  const ks = loadKeystore(args.keystore || DEFAULT_KEYSTORE);
  const ctx = await registryContext();
  const provider = new ethers.JsonRpcProvider(DEFAULT_RPC, DEFAULT_CHAIN_ID, { staticNetwork: true });
  const token = new ethers.Contract(ctx.bondToken, ERC20_ABI, provider);
  const [ethBalance, tokenBalance, registryAllowance, realityAllowance] = await Promise.all([
    provider.getBalance(ks.submitterAddress),
    token.balanceOf(ks.submitterAddress),
    token.allowance(ks.submitterAddress, DEFAULT_REGISTRY),
    token.allowance(ks.submitterAddress, ctx.realityETH)
  ]);
  const minBond = BigInt(ctx.minBond);
  const eligible = ethBalance > 0n && tokenBalance >= minBond;
  console.log(JSON.stringify({
    ok: true,
    registry: ethers.getAddress(DEFAULT_REGISTRY),
    submitterAddress: ks.submitterAddress,
    ethBalance: ethBalance.toString(),
    bondToken: ctx.bondToken,
    tokenBalance: tokenBalance.toString(),
    minBond: ctx.minBond,
    registryAllowance: registryAllowance.toString(),
    realityETH: ctx.realityETH,
    realityAllowance: realityAllowance.toString(),
    eligible,
    eligibility: eligible ? 'funded for submission' : 'needs Sepolia ETH for gas and at least minBond bond tokens'
  }, null, 2));
}

function extractTx(raw) {
  const tx = raw.to && raw.data ? raw : raw.commitTx;
  if (!tx) throw new Error('tx JSON must be a transaction object or submission state with commitTx');
  return tx;
}

// Offline scope check: confirm a prepared tx is one of the allowed KaiSign
// submission calls from the expected submitter address, on Sepolia. This tool
// never holds signing material — the user signs with their own wallet — so this
// is an inspection aid, not an enforcement boundary.
function checkTxScope(ks, tx) {
  const to = assertAddress(tx.to, 'tx.to');
  const chainId = Number(tx.chainId);
  if (chainId !== DEFAULT_CHAIN_ID) throw new Error(`tx chainId ${chainId} not allowed`);
  const data = String(tx.data || '');
  if (!/^0x[0-9a-fA-F]{8,}$/.test(data)) throw new Error('tx.data missing selector');
  const selector = data.slice(0, 10).toLowerCase();
  const registry = ethers.getAddress(ks.registry);
  let ok = false;
  let reason = '';

  const sponsorSelectors = [
    sponsorIface.getFunction('sponsoredCommit').selector.toLowerCase(),
    sponsorIface.getFunction('sponsoredReveal').selector.toLowerCase()
  ];

  if (to === registry) {
    ok = ks.allowed.registryCalls.some(c => c.selector.toLowerCase() === selector);
    reason = ok ? 'allowed registry submission call' : 'registry selector not allowed';
  } else if (sponsorSelectors.includes(selector)) {
    ok = true;
    reason = 'SubmissionSponsor call; verify `to` matches your expected sponsor address';
  } else if (selector === erc20Iface.getFunction('approve').selector.toLowerCase()) {
    const [spender] = erc20Iface.decodeFunctionData('approve', data);
    const allowedSpenders = (ks.allowed.erc20ApprovalSpenders || []).map(s => ethers.getAddress(s));
    ok = allowedSpenders.includes(ethers.getAddress(spender));
    reason = ok ? 'allowed ERC20 approval to scoped spender' : `approve spender ${spender} not in known allowed scope (Reality.eth approve is validated by prepare-vote output)`;
  } else if (selector === realityIface.getFunction('submitAnswerERC20').selector.toLowerCase()) {
    ok = true;
    reason = 'Reality.eth vote call; verify target against prepare-vote realityETH output';
  } else {
    reason = 'selector not in known submission scope';
  }

  const from = tx.from ? assertAddress(tx.from, 'tx.from') : undefined;
  if (from && from !== ks.submitterAddress) { ok = false; reason = `tx.from ${from} does not match expected submitter ${ks.submitterAddress}`; }
  return { ok, to, from, chainId, selector, reason };
}

function verifyTx(args) {
  const ks = loadKeystore(args.keystore || DEFAULT_KEYSTORE);
  const tx = extractTx(readJson(String(args.tx || '')));
  const result = checkTxScope(ks, tx);
  console.log(JSON.stringify({ ...result, expectedFrom: ks.submitterAddress }, null, 2));
  if (!result.ok) process.exit(1);
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  if (!cmd || cmd === 'help' || args.help) { usage(); return; }
  if (cmd === 'init' || cmd === 'create') {
    if (cmd === 'create') console.error('note: "create" is deprecated and no longer generates a key; use "init --address=0x...".');
    const out = path.resolve(args.output || DEFAULT_KEYSTORE);
    const ks = scopeManifest(args);
    writeJson(out, ks);
    console.log(JSON.stringify({ ok: true, output: out, registry: ethers.getAddress(DEFAULT_REGISTRY), submitterAddress: ks.submitterAddress, signingMaterial: 'none' }, null, 2));
    return;
  }
  if (cmd === 'init-burner') {
    const out = path.resolve(args.output || DEFAULT_BURNER);
    if (fs.existsSync(out) && !args.force) throw new Error(`${out} exists; pass --force to overwrite (this discards the old burner key)`);
    const ks = await createBurner(args);
    writeJson(out, ks);
    console.log(JSON.stringify({ ok: true, output: out, sponsor: ks.sponsor, submitterAddress: ks.submitterAddress, fund: `Send Sepolia gas (no bond token needed) to ${ks.submitterAddress}` }, null, 2));
    return;
  }
  if (cmd === 'submit-sponsored') return await submitSponsored(args);
  if (cmd === 'status') return await status(args);
  if (cmd === 'prepare-commit') return await prepareCommit(args, false);
  if (cmd === 'prepare-reveal') return await prepareReveal(args, false);
  if (cmd === 'prepare-sponsored-commit') return await prepareCommit(args, true);
  if (cmd === 'prepare-sponsored-reveal') return await prepareReveal(args, true);
  if (cmd === 'prepare-vote') return await prepareVote(args);
  if (cmd === 'verify-tx') return verifyTx(args);
  throw new Error(`unknown command: ${cmd}`);
}

main().catch(e => {
  console.error(JSON.stringify({ ok: false, error: e.message, stack: e.stack }, null, 2));
  process.exit(2);
});
