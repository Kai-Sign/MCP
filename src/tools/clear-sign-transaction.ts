import { readFile } from 'node:fs/promises';
import { cacheManager } from '../services/cache-manager.js';
import { decodeTransaction, type DecodeTransactionInput } from './decode-transaction.js';
import { assertMetadataHashMatches, type MetadataHashCheck } from '../services/metadata-hash.js';
import type { ContractMetadata } from '../services/metadata-service.js';
import type { VerificationResult } from '../services/onchain-verifier.js';

export interface ClearSignTransactionInput extends Omit<DecodeTransactionInput, 'skipVerification'> {
  skipVerification?: boolean;
  metadataFile?: string;
}

export interface ClearSignTransactionResult {
  verified: boolean;
  fullyClearSigned: boolean;
  safeToSign: boolean;
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

  const localClearSigned = Boolean(
    decoded.success &&
    !decoded.hasUnknownInnerCalls &&
    !decoded.truncated &&
    !decoded.cycleDetected &&
    !decoded.error
  );
  const fullyClearSigned = usingLocalMetadata
    ? localClearSigned
    : Boolean(decoded.fullyClearSigned && metadataHashVerified);

  return {
    verified: usingLocalMetadata ? false : Boolean(decoded.verified && metadataHashVerified),
    fullyClearSigned,
    safeToSign: fullyClearSigned,
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
    error: decoded.error
  };
}
