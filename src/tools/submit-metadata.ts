import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { ethers } from 'ethers';
import { z } from 'zod';

const execFileAsync = promisify(execFile);

const DEFAULT_BURNER = '.kaisign/burner.json';
const DEFAULT_PASSWORD_FILE = '.kaisign/burner-password.txt';
const DEFAULT_SUBMISSION_SCOPE = '.kaisign/submission-keystore.json';
const DEFAULT_SEPOLIA_RPC = 'https://ethereum-sepolia.publicnode.com';
const SEPOLIA_CHAIN_ID = 11155111;

export const initSubmissionBurnerSchema = z.object({
  passwordFile: z.string().default(DEFAULT_PASSWORD_FILE),
  burnerFile: z.string().default(DEFAULT_BURNER),
  sponsor: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid sponsor address').optional(),
  force: z.boolean().default(false)
});

export const getSubmissionBurnerStatusSchema = z.object({
  burnerFile: z.string().default(DEFAULT_BURNER),
  rpcUrl: z.string().url().optional()
});

export const submitSponsoredMetadataSchema = z.object({
  metadata: z.string().min(1),
  passwordFile: z.string().default(DEFAULT_PASSWORD_FILE),
  burnerFile: z.string().default(DEFAULT_BURNER),
  blobHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/, 'Invalid blob hash').optional(),
  targetAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid target address').optional(),
  sponsor: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid sponsor address').optional()
});

export const initSubmissionScopeSchema = z.object({
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid submitter address'),
  output: z.string().default(DEFAULT_SUBMISSION_SCOPE)
});

export const prepareSponsoredCommitSchema = z.object({
  metadata: z.string().min(1),
  keystore: z.string().default(DEFAULT_SUBMISSION_SCOPE),
  output: z.string().optional(),
  blobHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/, 'Invalid blob hash').optional(),
  targetAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid target address').optional(),
  sponsor: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid sponsor address').optional()
});

export const prepareSponsoredRevealSchema = z.object({
  state: z.string().min(1),
  commitmentId: z.string().regex(/^0x[a-fA-F0-9]{64}$/, 'Invalid commitment id'),
  keystore: z.string().default(DEFAULT_SUBMISSION_SCOPE),
  sponsor: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid sponsor address').optional()
});

export const getSubmissionScopeStatusSchema = z.object({
  keystore: z.string().default(DEFAULT_SUBMISSION_SCOPE)
});

export const prepareDirectCommitSchema = z.object({
  metadata: z.string().min(1),
  keystore: z.string().default(DEFAULT_SUBMISSION_SCOPE),
  output: z.string().optional(),
  blobHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/, 'Invalid blob hash').optional(),
  targetAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/, 'Invalid target address').optional()
});

export const prepareDirectRevealSchema = z.object({
  state: z.string().min(1),
  commitmentId: z.string().regex(/^0x[a-fA-F0-9]{64}$/, 'Invalid commitment id'),
  keystore: z.string().default(DEFAULT_SUBMISSION_SCOPE),
  tokenAmount: z.string().regex(/^[0-9]+$/, 'Invalid token amount').optional()
});

export const prepareDirectVoteSchema = z.object({
  questionId: z.string().regex(/^0x[a-fA-F0-9]{64}$/, 'Invalid question id'),
  keystore: z.string().default(DEFAULT_SUBMISSION_SCOPE),
  tokens: z.string().regex(/^[0-9]+$/, 'Invalid token amount').optional()
});

function loadDotEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  try {
    const text = readFileSync(resolve('.env'), 'utf8');
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!match) continue;
      env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
    }
  } catch {
    // Local .env is optional.
  }
  return env;
}

function ensurePasswordFile(passwordFile: string) {
  const file = resolve(passwordFile);
  try {
    const existing = readFileSync(file, 'utf8').trim();
    if (existing) return { passwordFile: file, created: false };
  } catch {
    // Create below.
  }

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${randomBytes(32).toString('base64')}\n`, { mode: 0o600 });
  return { passwordFile: file, created: true };
}

function parseJsonOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(trimmed.slice(start, end + 1));
    return trimmed;
  }
}

async function runSubmissionHelper(args: string[]) {
  try {
    const { stdout, stderr } = await execFileAsync('node', ['scripts/submission-keystore.mjs', ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...loadDotEnv() },
      maxBuffer: 1024 * 1024 * 20
    });
    return {
      ok: true,
      result: parseJsonOutput(stdout),
      stdout: stdout.trim() || undefined,
      stderr: stderr.trim() || undefined
    };
  } catch (error) {
    const err = error as Error & { stdout?: string; stderr?: string; code?: number };
    return {
      ok: false,
      code: err.code,
      error: err.message,
      result: err.stdout ? parseJsonOutput(err.stdout) : undefined,
      stdout: err.stdout?.trim() || undefined,
      stderr: err.stderr?.trim() || undefined
    };
  }
}

type SubmissionStatus = {
  ok?: boolean;
  eligible?: boolean;
  submitterAddress?: string;
  ethBalance?: string;
  tokenBalance?: string;
  minBond?: string;
  bondToken?: string;
  eligibility?: string;
};

function optionalFlag(args: string[], name: string, value: string | undefined) {
  if (value) args.push(`--${name}=${value}`);
}

function helperResultObject(result: Awaited<ReturnType<typeof runSubmissionHelper>>): SubmissionStatus | null {
  if (result.result && typeof result.result === 'object' && !Array.isArray(result.result)) {
    return result.result as SubmissionStatus;
  }
  return null;
}

async function getDirectStatus(keystore: string) {
  return runSubmissionHelper(['status', `--keystore=${resolve(keystore)}`]);
}

async function assertDirectEligible(keystore: string) {
  const status = await getDirectStatus(keystore);
  const details = helperResultObject(status);
  if (!status.ok || !details?.eligible) {
    return {
      ok: false,
      refused: true,
      reason: 'Direct EOA submission requires verified Sepolia gas and permissioned bond token balance >= minBond. Use the sponsored smart-account/default path instead.',
      status: details ?? status.result ?? status
    };
  }
  return null;
}

export async function initSubmissionBurner(input: z.infer<typeof initSubmissionBurnerSchema>) {
  const parsed = initSubmissionBurnerSchema.parse(input);
  const password = ensurePasswordFile(parsed.passwordFile);
  const args = ['init-burner', `--password-file=${password.passwordFile}`, `--output=${resolve(parsed.burnerFile)}`];
  optionalFlag(args, 'sponsor', parsed.sponsor);
  if (parsed.force) args.push('--force');

  const result = await runSubmissionHelper(args);
  return {
    ...result,
    passwordFile: password.passwordFile,
    passwordFileCreated: password.created,
    burnerFile: resolve(parsed.burnerFile)
  };
}

export async function getSubmissionBurnerStatus(input: z.infer<typeof getSubmissionBurnerStatusSchema>) {
  const parsed = getSubmissionBurnerStatusSchema.parse(input);
  const burner = JSON.parse(readFileSync(resolve(parsed.burnerFile), 'utf8')) as {
    kind?: string;
    registryChainId?: number;
    registry?: string;
    sponsor?: string;
    submitterAddress?: string;
    createdAt?: string;
  };
  if (burner.kind !== 'kaisign-burner' || !burner.submitterAddress) {
    throw new Error(`${parsed.burnerFile} is not a KaiSign burner keystore`);
  }

  const rpcUrl = parsed.rpcUrl ?? loadDotEnv().SEPOLIA_RPC_URL ?? process.env.SEPOLIA_RPC_URL ?? DEFAULT_SEPOLIA_RPC;
  const provider = new ethers.JsonRpcProvider(rpcUrl, SEPOLIA_CHAIN_ID, { staticNetwork: true });
  const [balance, blockNumber] = await Promise.all([
    provider.getBalance(burner.submitterAddress),
    provider.getBlockNumber()
  ]);

  return {
    ok: true,
    burnerFile: resolve(parsed.burnerFile),
    registryChainId: burner.registryChainId,
    registry: burner.registry,
    sponsor: burner.sponsor,
    submitterAddress: ethers.getAddress(burner.submitterAddress),
    createdAt: burner.createdAt,
    blockNumber,
    balanceWei: balance.toString(),
    balanceEth: ethers.formatEther(balance),
    funded: balance > 0n
  };
}

export async function submitSponsoredMetadata(input: z.infer<typeof submitSponsoredMetadataSchema>) {
  const parsed = submitSponsoredMetadataSchema.parse(input);
  const args = [
    'submit-sponsored',
    `--metadata=${resolve(parsed.metadata)}`,
    `--password-file=${resolve(parsed.passwordFile)}`,
    `--burner=${resolve(parsed.burnerFile)}`
  ];
  optionalFlag(args, 'blob-hash', parsed.blobHash);
  optionalFlag(args, 'target-address', parsed.targetAddress);
  optionalFlag(args, 'sponsor', parsed.sponsor);
  return runSubmissionHelper(args);
}

export async function initSubmissionScope(input: z.infer<typeof initSubmissionScopeSchema>) {
  const parsed = initSubmissionScopeSchema.parse(input);
  return runSubmissionHelper(['init', `--address=${parsed.address}`, `--output=${resolve(parsed.output)}`]);
}

export async function getSubmissionScopeStatus(input: z.infer<typeof getSubmissionScopeStatusSchema>) {
  const parsed = getSubmissionScopeStatusSchema.parse(input);
  return getDirectStatus(parsed.keystore);
}

export async function prepareSponsoredCommit(input: z.infer<typeof prepareSponsoredCommitSchema>) {
  const parsed = prepareSponsoredCommitSchema.parse(input);
  const args = [
    'prepare-sponsored-commit',
    `--metadata=${resolve(parsed.metadata)}`,
    `--keystore=${resolve(parsed.keystore)}`
  ];
  optionalFlag(args, 'output', parsed.output ? resolve(parsed.output) : undefined);
  optionalFlag(args, 'blob-hash', parsed.blobHash);
  optionalFlag(args, 'target-address', parsed.targetAddress);
  optionalFlag(args, 'sponsor', parsed.sponsor);
  return runSubmissionHelper(args);
}

export async function prepareSponsoredReveal(input: z.infer<typeof prepareSponsoredRevealSchema>) {
  const parsed = prepareSponsoredRevealSchema.parse(input);
  const args = [
    'prepare-sponsored-reveal',
    `--state=${resolve(parsed.state)}`,
    `--commitment-id=${parsed.commitmentId}`,
    `--keystore=${resolve(parsed.keystore)}`
  ];
  optionalFlag(args, 'sponsor', parsed.sponsor);
  return runSubmissionHelper(args);
}

export async function prepareDirectCommit(input: z.infer<typeof prepareDirectCommitSchema>) {
  const parsed = prepareDirectCommitSchema.parse(input);
  const refusal = await assertDirectEligible(parsed.keystore);
  if (refusal) return refusal;

  const args = [
    'prepare-commit',
    `--metadata=${resolve(parsed.metadata)}`,
    `--keystore=${resolve(parsed.keystore)}`
  ];
  optionalFlag(args, 'output', parsed.output ? resolve(parsed.output) : undefined);
  optionalFlag(args, 'blob-hash', parsed.blobHash);
  optionalFlag(args, 'target-address', parsed.targetAddress);
  return runSubmissionHelper(args);
}

export async function prepareDirectReveal(input: z.infer<typeof prepareDirectRevealSchema>) {
  const parsed = prepareDirectRevealSchema.parse(input);
  const refusal = await assertDirectEligible(parsed.keystore);
  if (refusal) return refusal;

  const args = [
    'prepare-reveal',
    `--state=${resolve(parsed.state)}`,
    `--commitment-id=${parsed.commitmentId}`,
    `--keystore=${resolve(parsed.keystore)}`
  ];
  optionalFlag(args, 'token-amount', parsed.tokenAmount);
  return runSubmissionHelper(args);
}

export async function prepareDirectVote(input: z.infer<typeof prepareDirectVoteSchema>) {
  const parsed = prepareDirectVoteSchema.parse(input);
  const refusal = await assertDirectEligible(parsed.keystore);
  if (refusal) return refusal;

  const args = [
    'prepare-vote',
    `--question-id=${parsed.questionId}`,
    `--keystore=${resolve(parsed.keystore)}`
  ];
  optionalFlag(args, 'tokens', parsed.tokens);
  return runSubmissionHelper(args);
}
