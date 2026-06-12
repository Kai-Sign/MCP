import { id as keccakId } from 'ethers';
import { z } from 'zod';
import { ABIEntry, ABIInput, ContractMetadata, MetadataService } from '../services/metadata-service.js';

export const getFunctionSelectorsSchema = z.object({
  contractAddress: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  to: z.string().regex(/^0x[a-fA-F0-9]{40}$/).optional(),
  chainId: z.number().int().positive().default(1),
  functionName: z.string().optional(),
  selector: z.string().regex(/^0x[a-fA-F0-9]{8}$/).optional()
}).passthrough();

export type GetFunctionSelectorsInput = z.infer<typeof getFunctionSelectorsSchema>;

export interface FunctionSelectorInfo {
  name: string;
  signature: string;
  selector: string;
  metadataSelector?: string;
  selectorMatchesMetadata: boolean;
  stateMutability?: string;
  displayFormat: boolean;
  displayKeys: string[];
}

export interface GetFunctionSelectorsResult {
  contractAddress: string;
  chainId: number;
  contractName?: string;
  source?: string;
  selector?: string;
  functionName?: string;
  found: boolean;
  count: number;
  functions: FunctionSelectorInfo[];
  warning?: string;
}

function abiInputSignature(input: ABIInput): string {
  if (!input.type.startsWith('tuple')) return input.type;
  const suffix = input.type.slice('tuple'.length);
  const inner = (input.components ?? []).map(abiInputSignature).join(',');
  return `(${inner})${suffix}`;
}

function functionSignature(entry: ABIEntry): string | null {
  if (entry.type !== 'function' || !entry.name) return null;
  const types = (entry.inputs ?? []).map(abiInputSignature).join(',');
  return `${entry.name}(${types})`;
}

function computedSelector(signature: string): string {
  return keccakId(signature).slice(0, 10).toLowerCase();
}

function displayKeysFor(metadata: ContractMetadata, signature: string, selector: string, name: string): string[] {
  const formats = metadata.display?.formats ?? {};
  return [selector, signature, name].filter(key => Boolean(formats[key]));
}

function metadataName(metadata: ContractMetadata): string | undefined {
  return metadata.context?.contract?.name
    ?? metadata.metadata?.name
    ?? metadata.metadata?.symbol
    ?? metadata.context?.contract?.symbol;
}

export async function getFunctionSelectors(
  input: GetFunctionSelectorsInput,
  deps: { metadataService?: MetadataService } = {}
): Promise<GetFunctionSelectorsResult> {
  const contractAddress = (input.contractAddress ?? input.address ?? input.to)?.toLowerCase();
  if (!contractAddress) throw new Error('contractAddress, address, or to is required');

  const chainId = input.chainId ?? 1;
  const selectorFilter = input.selector?.toLowerCase();
  const functionNameFilter = input.functionName;
  const metadataService = deps.metadataService ?? new MetadataService();

  // Address + chain are authoritative here. Do not infer a selector from another contract's ABI.
  const metadata = await metadataService.getContractMetadata(contractAddress, chainId);
  if (!metadata) {
    return {
      contractAddress,
      chainId,
      selector: selectorFilter,
      functionName: functionNameFilter,
      found: false,
      count: 0,
      functions: [],
      warning: 'No metadata found for this exact contract address and chainId. Do not infer ABI or selector from training data.'
    };
  }

  const abi = metadata.context?.contract?.abi ?? [];
  const functions = abi
    .filter(entry => entry.type === 'function' && entry.name)
    .map(entry => {
      const signature = functionSignature(entry);
      if (!signature || !entry.name) return null;
      const selector = computedSelector(signature);
      const metadataSelector = entry.selector?.toLowerCase();
      const displayKeys = displayKeysFor(metadata, signature, selector, entry.name);
      const info: FunctionSelectorInfo = {
        name: entry.name,
        signature,
        selector,
        metadataSelector,
        selectorMatchesMetadata: !metadataSelector || metadataSelector === selector,
        stateMutability: entry.stateMutability,
        displayFormat: displayKeys.length > 0,
        displayKeys
      };
      return info;
    })
    .filter((item): item is FunctionSelectorInfo => item !== null)
    .filter(item => !functionNameFilter || item.name === functionNameFilter)
    .filter(item => !selectorFilter || item.selector === selectorFilter || item.metadataSelector === selectorFilter);

  return {
    contractAddress,
    chainId,
    contractName: metadataName(metadata),
    source: metadata._verification?.source,
    selector: selectorFilter,
    functionName: functionNameFilter,
    found: functions.length > 0,
    count: functions.length,
    functions,
    warning: functions.length > 0
      ? undefined
      : 'No matching function selector in metadata for this exact contract address and chainId. Do not substitute a same-named selector from another contract.'
  };
}
