import { readFile } from 'node:fs/promises';
import { cacheManager } from '../services/cache-manager.js';
import { decodeTransaction, type DecodeTransactionInput } from './decode-transaction.js';
import { assertMetadataHashMatches, type MetadataHashCheck } from '../services/metadata-hash.js';
import type { ContractMetadata } from '../services/metadata-service.js';
import type { VerificationResult } from '../services/onchain-verifier.js';
import type { ContractSummary, SigningStatus } from './signing-policy.js';

export interface ClearSignTransactionInput extends Omit<DecodeTransactionInput, 'skipVerification'> {
  skipVerification?: boolean;
  metadataFile?: string;
}

export interface ClearSignTransactionResult {
  verified: boolean;
  fullyClearSigned: boolean;
  safeToSign: boolean;
  decoded: boolean;
  source?: string;
  intent: string;
  aggregatedIntent: string;
  functionName?: string;
  functionSignature?: string;
  selector: string;
  params: DecodeTransactionInput extends never ? never : Record<string, unknown>;
  warnings: string[];
  transaction: {
    to: string;
    data: string;
    value: string;
    chainId: number;
  };
  metadataHashVerified: boolean;
  metadataHashCheck?: MetadataHashCheck;
  verification?: unknown;
  callTree?: unknown;
  signing: SigningStatus;
  contracts: ContractSummary[];
  error?: string;
}

function getRootMetadata(decoded: Awaited<ReturnType<typeof decodeTransaction>>): ContractMetadata | undefined {
  return decoded.callTree.metadata as ContractMetadata | undefined;
}

function getVerification(metadata: ContractMetadata | undefined): VerificationResult | undefined {
  return metadata?._verification;
}

async function loadMetadataFile(path: string, to: string, chainId: number): Promise<void> {
  const raw = await readFile(path, 'utf8');
  const metadata = JSON.parse(raw) as ContractMetadata;
  cacheManager.setMetadata(to.toLowerCase(), chainId, metadata);
}

/**
 * Valid ABI calldata is a 4-byte selector plus whole 32-byte words. A misaligned
 * length means characters were lost (typically a paste copied from terminal-wrapped
 * output) — flag it up front instead of surfacing a cryptic ABI offset error.
 */
export function calldataAlignmentWarning(data: string): string | undefined {
  if (!/^0x[0-9a-fA-F]{10,}$/.test(data)) return undefined;
  const argChars = data.length - 10;
  if (argChars % 64 === 0) return undefined;
  const missing = 64 - (argChars % 64);
  return `Calldata looks truncated/corrupted: ${data.length - 2} hex chars is not selector + whole 32-byte words (${missing} hex chars short of alignment). If you pasted this from a terminal or chat, re-copy it from the original source — wrapped copies often drop characters.`;
}

export async function clearSignTransaction(input: ClearSignTransactionInput): Promise<ClearSignTransactionResult> {
  const value = input.value ?? '0';

  const usingLocalMetadata = Boolean(input.metadataFile);

  if (input.metadataFile) {
    await loadMetadataFile(input.metadataFile, input.to, input.chainId ?? 1);
  }

  const decoded = await decodeTransaction({
    to: input.to,
    data: input.data,
    chainId: input.chainId,
    value,
    skipVerification: usingLocalMetadata || input.skipVerification === true
  });

  const metadata = getRootMetadata(decoded);
  const metadataVerification = getVerification(metadata);
  const attestedHash = metadataVerification?.attestationComponents?.metadataHash;
  const warnings = [...decoded.warnings];
  const alignmentWarning = calldataAlignmentWarning(input.data);
  if (alignmentWarning) warnings.unshift(alignmentWarning);
  let metadataHashCheck: MetadataHashCheck | undefined;
  let metadataHashVerified = false;

  if (metadata && attestedHash && metadataVerification?.verified && metadataVerification.source === 'leaf-verified') {
    metadataHashCheck = assertMetadataHashMatches(metadata, attestedHash);
    metadataHashVerified = metadataHashCheck.verified;
    if (!metadataHashCheck.verified && metadataHashCheck.error) {
      warnings.push(`CRITICAL: ${metadataHashCheck.error}`);
    }
  } else if (decoded.verified) {
    warnings.push('CRITICAL: could not bind fetched metadata JSON to attested metadataHash');
  }

  // A 'safe' verdict additionally requires binding the local metadata JSON to the
  // attested metadataHash; downgrade to review when that binding is missing.
  let signing = decoded.signing;
  if (alignmentWarning && signing.verdict === 'reject') {
    signing = { ...signing, reason: `calldata appears truncated/corrupted (not 32-byte-word aligned) — re-copy the payload from its original source. ${signing.reason}` };
  }
  if (!usingLocalMetadata && signing.verdict === 'safe' && !metadataHashVerified) {
    signing = { ...signing, verdict: 'review', reason: 'registry-attested, but local metadata JSON could not be bound to the attested metadataHash' };
  }

  const localDecoded = Boolean(
    decoded.success &&
    !decoded.hasUnknownInnerCalls &&
    !decoded.truncated &&
    !decoded.cycleDetected &&
    !decoded.error
  );
  const fullyClearSigned = usingLocalMetadata
    ? false
    : Boolean(decoded.fullyClearSigned && metadataHashVerified);

  return {
    verified: usingLocalMetadata ? false : Boolean(decoded.verified && metadataHashVerified),
    fullyClearSigned,
    safeToSign: usingLocalMetadata ? false : fullyClearSigned,
    decoded: usingLocalMetadata ? localDecoded : Boolean(decoded.success && !decoded.error),
    source: usingLocalMetadata ? 'local-file' : decoded.source,
    intent: decoded.intent,
    aggregatedIntent: decoded.aggregatedIntent,
    functionName: decoded.functionName,
    functionSignature: decoded.functionSignature,
    selector: decoded.selector,
    params: decoded.params,
    warnings,
    transaction: {
      to: input.to.toLowerCase(),
      data: input.data,
      value,
      chainId: input.chainId ?? 1
    },
    metadataHashVerified,
    metadataHashCheck,
    verification: decoded.verification,
    callTree: decoded.callTree,
    signing,
    contracts: decoded.contracts,
    error: decoded.error
  };
}
