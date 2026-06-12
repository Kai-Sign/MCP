/**
 * Shared signing policy and call-tree rendering.
 *
 * Every tool (CLI, MCP) derives its safety verdict from computeSigningStatus so
 * "decoded", "registry-attested" and "safe to sign" stay distinct and consistent.
 */

import type { RecursiveCallNode, ContractUsage } from '../services/recursive-decoder.js';

export type ContractAttestation = 'leaf-verified' | 'local-metadata' | 'revoked' | 'none' | 'error';

export interface ContractSummary extends ContractUsage {
  attestation: ContractAttestation;
}

export type SigningVerdict = 'safe' | 'review' | 'reject';

export interface SigningStatus {
  verdict: SigningVerdict;
  reason: string;
  decodedCalls: number;
  totalCalls: number;
  attestedContracts: number;
  totalContracts: number;
}

export interface SigningStatusInput {
  decodedCalls: number;
  totalCalls: number;
  contracts: ContractSummary[];
  truncated?: boolean;
  cycleDetected?: boolean;
  hasUnknownInnerCalls?: boolean;
  metadataHashMismatch?: boolean;
  error?: string;
}

export function computeSigningStatus(input: SigningStatusInput): SigningStatus {
  const attestedContracts = input.contracts.filter(c => c.attestation === 'leaf-verified').length;
  const totalContracts = input.contracts.length;
  const fullyDecoded = input.totalCalls > 0 && input.decodedCalls === input.totalCalls;
  const revoked = input.contracts.some(c => c.attestation === 'revoked');

  const base = {
    decodedCalls: input.decodedCalls,
    totalCalls: input.totalCalls,
    attestedContracts,
    totalContracts
  };

  if (input.error) {
    return { verdict: 'reject', reason: `decode error: ${input.error}`, ...base };
  }
  if (revoked) {
    return { verdict: 'reject', reason: 'a contract attestation has been revoked on the registry', ...base };
  }
  if (input.metadataHashMismatch) {
    return { verdict: 'reject', reason: 'metadata hash does not match the on-chain attestation', ...base };
  }
  if (input.cycleDetected) {
    return { verdict: 'reject', reason: 'recursive cycle detected in calldata', ...base };
  }
  if (input.truncated) {
    return { verdict: 'reject', reason: 'recursive decode truncated at max depth', ...base };
  }
  if (!fullyDecoded || input.hasUnknownInnerCalls) {
    return {
      verdict: 'reject',
      reason: `only ${input.decodedCalls}/${input.totalCalls} calls decoded; unknown calldata cannot be clear-signed`,
      ...base
    };
  }
  if (attestedContracts === totalContracts && totalContracts > 0) {
    return { verdict: 'safe', reason: 'fully decoded; all contracts registry-attested', ...base };
  }
  return {
    verdict: 'review',
    reason: `fully decoded from local metadata; ${attestedContracts}/${totalContracts} contracts registry-attested (registry attestation pending)`,
    ...base
  };
}

function shortAddress(address: string): string {
  return address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

function nodeLabel(node: RecursiveCallNode, names: Map<string, string | undefined>): string {
  const fn = node.functionName ?? node.selector;
  const name = names.get(`${node.chainId}:${node.target}`);
  const where = name ? `${name} ${shortAddress(node.target)}` : shortAddress(node.target);
  const params = Object.values(node.formatted ?? {})
    .filter(p => typeof p.value === 'string' && p.value.length <= 64 && !p.value.includes('[object Object]'))
    .slice(0, 2)
    .map(p => `${p.label}: ${p.value}`)
    .join(', ');
  const status = node.success ? '' : `  [DECODE FAILED${node.error ? `: ${node.error}` : ''}]`;
  return `${fn}  (${where})${params ? `  ${params}` : ''}${status}`;
}

/**
 * Render the decoded call tree as an indented box-drawing tree.
 */
export function renderCallTree(root: RecursiveCallNode, contracts: ContractSummary[] = []): string {
  const names = new Map(contracts.map(c => [`${c.chainId}:${c.address}`, c.name]));
  const lines: string[] = [nodeLabel(root, names)];

  const walk = (node: RecursiveCallNode, prefix: string) => {
    node.children.forEach((child, i) => {
      const last = i === node.children.length - 1;
      lines.push(`${prefix}${last ? '└─' : '├─'} ${nodeLabel(child, names)}`);
      walk(child, `${prefix}${last ? '   ' : '│  '}`);
    });
  };

  walk(root, '');
  return lines.join('\n');
}

const ATTESTATION_LABEL: Record<ContractAttestation, string> = {
  'leaf-verified': 'registry-attested',
  'local-metadata': 'local metadata',
  revoked: 'REVOKED',
  none: 'no metadata',
  error: 'verification error'
};

/**
 * Render the tiered status header shared by CLI plain output and MCP displayText.
 */
export function renderStatusLines(signing: SigningStatus, contracts: ContractSummary[]): string[] {
  const lines = [
    `Decoded:  ${signing.decodedCalls}/${signing.totalCalls} calls`,
    `Attested: ${signing.attestedContracts}/${signing.totalContracts} contracts on registry`,
    `Verdict:  ${signing.verdict.toUpperCase()} — ${signing.reason}`
  ];
  for (const contract of contracts) {
    const label = contract.name ? `${contract.name} ${shortAddress(contract.address)}` : contract.address;
    lines.push(`  - ${label} (chain ${contract.chainId}, ${contract.calls} call${contract.calls === 1 ? '' : 's'}): ${ATTESTATION_LABEL[contract.attestation]}`);
  }
  return lines;
}
