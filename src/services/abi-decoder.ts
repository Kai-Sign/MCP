/**
 * ABI Decoder
 * Port of SimpleInterface from KaiSign-Extension decode.js
 */

import { keccak256, toUtf8Bytes } from 'ethers';
import { ABIEntry, ABIInput, FieldDefinition, CommandRegistry, TokenMetadata } from './metadata-service.js';
import { metadataService } from './metadata-service.js';

export interface DecodedTransaction {
  success: boolean;
  selector: string;
  function?: string;
  functionName?: string;
  params: Record<string, string>;
  rawParams: Record<string, unknown>;
  intent: string;
  formatted: Record<string, FormattedParam>;
  metadata?: unknown;
  decodedCommands?: DecodedCommand[];
  nestedIntents?: string[];
  error?: string;
}

export interface FormattedParam {
  label: string;
  value: string;
  rawValue: string;
  format: string;
  params?: Record<string, unknown>;
}

export interface DecodedCommand {
  command: string;
  name: string;
  intent: string;
  params: Record<string, unknown>;
}

export class SimpleInterface {
  private abi: ABIEntry[];

  constructor(abi: ABIEntry | ABIEntry[]) {
    this.abi = Array.isArray(abi) ? abi : [abi];
  }

  /**
   * Calculate function selector from signature
   */
  static calculateSelector(signature: string): string {
    return keccak256(toUtf8Bytes(signature)).slice(0, 10);
  }

  /**
   * Safe slice with bounds checking
   */
  private safeSlice(data: string, start: number, end: number): string {
    const needed = end - start;
    if (start > data.length * 2) {
      throw new Error(`ABI decode: offset ${start / 2} beyond data length ${data.length / 2}`);
    }
    if (start >= data.length) {
      return '0'.repeat(needed);
    }
    const slice = data.slice(start, end);
    if (slice.length < needed) {
      return slice + '0'.repeat(needed - slice.length);
    }
    return slice;
  }

  /**
   * Parse array type
   */
  private parseArrayType(type: string): { baseType: string; size: number | null } | null {
    const match = type.match(/^(.+)\[(\d*)\]$/);
    if (!match) return null;
    return { baseType: match[1], size: match[2] === '' ? null : parseInt(match[2]) };
  }

  /**
   * Check if type is dynamic
   */
  private isDynamicType(type: string, input?: ABIInput): boolean {
    if (!type) return false;
    if (type === 'bytes' || type === 'string') return true;

    const arr = this.parseArrayType(type);
    if (arr) {
      if (arr.size === null) return true;
      return this.isDynamicType(arr.baseType, input);
    }

    if (type === 'tuple' && input?.components) {
      return input.components.some(c => this.isDynamicType(c.type, c));
    }

    return false;
  }

  /**
   * Decode static type
   */
  private decodeStaticType(
    type: string,
    paramData: string,
    offset: number,
    input?: ABIInput
  ): { value: unknown; size: number } {
    if (type === 'address') {
      const rawAddr = this.safeSlice(paramData, offset + 24, offset + 64);
      return { value: '0x' + rawAddr.toLowerCase(), size: 64 };
    }

    if (type.startsWith('uint')) {
      const hexValue = this.safeSlice(paramData, offset, offset + 64);
      try {
        const value = BigInt('0x' + hexValue);
        return {
          value: { _isBigNumber: true, _hex: '0x' + hexValue, _value: value.toString() },
          size: 64
        };
      } catch {
        return { value: '0x' + hexValue, size: 64 };
      }
    }

    if (type.startsWith('int')) {
      const hexValue = this.safeSlice(paramData, offset, offset + 64);
      try {
        const raw = BigInt('0x' + hexValue);
        const bits = parseInt(type.slice(3)) || 256;
        const mask = (1n << BigInt(bits)) - 1n;
        const truncated = raw & mask;
        const halfRange = 1n << BigInt(bits - 1);
        const value = truncated >= halfRange ? truncated - (1n << BigInt(bits)) : truncated;
        return {
          value: { _isBigNumber: true, _hex: '0x' + hexValue, _value: value.toString() },
          size: 64
        };
      } catch {
        return { value: '0x' + hexValue, size: 64 };
      }
    }

    if (type.startsWith('bytes') && !type.endsWith('[]') && type !== 'bytes') {
      const byteSize = parseInt(type.replace('bytes', '')) || 32;
      const hexSize = byteSize * 2;
      return { value: '0x' + this.safeSlice(paramData, offset, offset + hexSize), size: 64 };
    }

    if (type === 'bool') {
      const lastByte = this.safeSlice(paramData, offset + 62, offset + 64);
      return { value: lastByte !== '00', size: 64 };
    }

    // Fixed-size arrays
    const fixedArr = this.parseArrayType(type);
    if (fixedArr && fixedArr.size !== null && !this.isDynamicType(fixedArr.baseType, input)) {
      const results: unknown[] = [];
      let arrOffset = 0;
      for (let i = 0; i < fixedArr.size; i++) {
        const { value, size } = this.decodeStaticType(fixedArr.baseType, paramData, offset + arrOffset, input);
        results.push(value);
        arrOffset += size;
      }
      return { value: results, size: arrOffset };
    }

    // Tuple
    if (type === 'tuple' && input?.components) {
      const tupleData: Record<string, unknown> = {};
      let tupleOffset = 0;

      for (const component of input.components) {
        if (this.isDynamicType(component.type, component)) {
          const dynOffset = parseInt(paramData.slice(offset + tupleOffset, offset + tupleOffset + 64), 16) * 2;
          const dynResult = this.decodeDynamicType(component.type, paramData, offset + dynOffset, component);
          tupleData[component.name] = dynResult;
          tupleOffset += 64;
        } else {
          const result = this.decodeStaticType(component.type, paramData, offset + tupleOffset, component);
          tupleData[component.name] = result.value;
          tupleOffset += result.size;
        }
      }

      return { value: tupleData, size: tupleOffset };
    }

    return { value: '0x' + paramData.slice(offset, offset + 64), size: 64 };
  }

  /**
   * Decode dynamic type
   */
  private decodeDynamicType(
    type: string,
    paramData: string,
    offset: number,
    input?: ABIInput
  ): unknown {
    if (type === 'bytes') {
      const length = parseInt(this.safeSlice(paramData, offset, offset + 64), 16);
      const hexLength = length * 2;
      return '0x' + paramData.slice(offset + 64, offset + 64 + hexLength);
    }

    if (type === 'string') {
      const length = parseInt(this.safeSlice(paramData, offset, offset + 64), 16);
      const hexLength = length * 2;
      const hexData = paramData.slice(offset + 64, offset + 64 + hexLength);
      return this.hexToString(hexData);
    }

    const dynArr = this.parseArrayType(type);

    // Fixed-size array of dynamic elements
    if (dynArr && dynArr.size !== null) {
      const results: unknown[] = [];
      for (let i = 0; i < dynArr.size; i++) {
        const elementOffsetHex = this.safeSlice(paramData, offset + i * 64, offset + (i + 1) * 64);
        const elementOffset = parseInt(elementOffsetHex, 16) * 2;
        results.push(this.decodeDynamicType(dynArr.baseType, paramData, offset + elementOffset, input));
      }
      return results;
    }

    // Dynamic-size array
    if (dynArr && dynArr.size === null) {
      const baseType = dynArr.baseType;
      const arrayLength = parseInt(this.safeSlice(paramData, offset, offset + 64), 16);
      const results: unknown[] = [];

      if (this.isDynamicType(baseType, input)) {
        for (let i = 0; i < arrayLength; i++) {
          const elementOffsetHex = this.safeSlice(paramData, offset + 64 + i * 64, offset + 64 + (i + 1) * 64);
          const elementOffset = parseInt(elementOffsetHex, 16) * 2;
          results.push(this.decodeDynamicType(baseType, paramData, offset + 64 + elementOffset, input));
        }
      } else {
        let arrayOffset = offset + 64;
        for (let i = 0; i < arrayLength; i++) {
          const { value, size } = this.decodeStaticType(baseType, paramData, arrayOffset, input);
          results.push(value);
          arrayOffset += size;
        }
      }

      return results;
    }

    // Dynamic tuple
    if (type === 'tuple' && input?.components) {
      const tupleData: Record<string, unknown> = {};
      let tupleOffset = 0;

      for (const component of input.components) {
        if (this.isDynamicType(component.type, component)) {
          const relOffsetHex = this.safeSlice(paramData, offset + tupleOffset, offset + tupleOffset + 64);
          const relOffset = parseInt(relOffsetHex, 16) * 2;
          tupleData[component.name] = this.decodeDynamicType(component.type, paramData, offset + relOffset, component);
          tupleOffset += 64;
        } else {
          const result = this.decodeStaticType(component.type, paramData, offset + tupleOffset, component);
          tupleData[component.name] = result.value;
          tupleOffset += result.size;
        }
      }

      return tupleData;
    }

    return '0x' + this.safeSlice(paramData, offset, offset + 64);
  }

  /**
   * Convert hex to string
   */
  private hexToString(hex: string): string {
    if (!hex || hex.length === 0) return '';
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) {
      bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
    }
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0) end--;
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, end));
  }

  /**
   * Decode function calldata
   */
  decodeFunctionData(functionName: string, data: string): unknown[] {
    const funcAbi = this.abi.find(item => item.name === functionName);
    if (!funcAbi) throw new Error(`Function ${functionName} not found`);

    const paramData = data.slice(10);
    const inputs = funcAbi.inputs ?? [];
    const results: unknown[] = [];

    let headOffset = 0;
    const dynamicParams: { index: number; input: ABIInput; tailOffset: number }[] = [];

    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i];

      if (this.isDynamicType(input.type, input)) {
        const offsetHex = this.safeSlice(paramData, headOffset, headOffset + 64);
        const tailOffset = parseInt(offsetHex, 16) * 2;
        dynamicParams.push({ index: i, input, tailOffset });
        headOffset += 64;
      } else {
        const { value, size } = this.decodeStaticType(input.type, paramData, headOffset, input);
        results[i] = value;
        headOffset += size;
      }
    }

    for (const { index, input, tailOffset } of dynamicParams) {
      results[index] = this.decodeDynamicType(input.type, paramData, tailOffset, input);
    }

    return results;
  }
}

/**
 * Format token amount with decimals
 */
export function formatTokenAmount(rawValue: string, decimals: number, symbol: string): string {
  try {
    const dec = Number(decimals);
    if (isNaN(dec) || dec < 0) return rawValue;

    if (!rawValue || rawValue === '0x' || rawValue === '0x0') {
      return symbol ? `0 ${symbol}` : '0';
    }

    const value = BigInt(rawValue);
    const divisor = BigInt(10) ** BigInt(dec);
    const integerPart = value / divisor;
    const fractionalPart = value % divisor;

    if (value === 0n) {
      return symbol ? `0 ${symbol}` : '0';
    }

    const fullFraction = fractionalPart.toString().padStart(dec, '0');
    const maxDisplay = 6;
    const minDisplay = 2;

    let fractionalStr = fullFraction.replace(/0+$/, '');

    if (integerPart === 0n && fractionalPart > 0n) {
      const firstNonZero = fullFraction.search(/[1-9]/);
      if (firstNonZero !== -1) {
        const end = Math.min(firstNonZero + maxDisplay, fullFraction.length);
        fractionalStr = fullFraction.slice(0, end).replace(/0+$/, '');
      }
    }

    if (fractionalStr.length < minDisplay && integerPart < 1000n) {
      fractionalStr = fullFraction.slice(0, minDisplay);
    }

    if (fractionalStr === '') fractionalStr = '0';
    if (fractionalStr.length > maxDisplay) fractionalStr = fractionalStr.slice(0, maxDisplay);

    const formatted = `${integerPart}.${fractionalStr}`;
    return symbol ? `${formatted} ${symbol}` : formatted;
  } catch {
    return rawValue;
  }
}

/**
 * Resolve field path to value in params
 */
function resolveFieldPath(pathStr: string, params: Record<string, unknown>): unknown {
  let currentPath = pathStr;
  if (currentPath.startsWith('#.') || currentPath.startsWith('@.')) {
    currentPath = currentPath.substring(2);
  }

  const parts = currentPath.split('.').filter(p => p);
  let value: unknown = params;

  for (const part of parts) {
    if (value === undefined || value === null) return undefined;

    const arrayMatch = part.match(/^(.+?)?\[(-?\d+)\]$/);

    if (arrayMatch) {
      const fieldName = arrayMatch[1];
      const index = parseInt(arrayMatch[2]);

      if (fieldName) {
        value = (value as Record<string, unknown>)[fieldName];
        if (value === undefined || value === null) return undefined;
      }

      if (Array.isArray(value)) {
        const idx = index < 0 ? value.length + index : index;
        value = value[idx];
      } else {
        return undefined;
      }
    } else {
      value = (value as Record<string, unknown>)[part];
    }
  }

  return value;
}

/**
 * Apply field format to value
 */
async function applyFieldFormat(
  value: unknown,
  fieldSpec: FieldDefinition,
  allParams: Record<string, unknown>,
  chainId: number
): Promise<string> {
  const format = fieldSpec.format;
  const params = fieldSpec.params ?? {};

  // tokenAmount format
  if (format === 'tokenAmount') {
    const tokenPath = params.tokenPath as string;
    if (!tokenPath) return String(value);

    const tokenAddress = resolveFieldPath(tokenPath, allParams) as string;

    let decimals = 18;
    let symbol = '';

    if (tokenAddress && typeof tokenAddress === 'string' && tokenAddress.length >= 10) {
      const normalizedAddr = tokenAddress.toLowerCase();
      if (normalizedAddr === '0x0000000000000000000000000000000000000000' ||
          normalizedAddr === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee') {
        decimals = 18;
        symbol = 'ETH';
      } else {
        try {
          const tokenInfo = await metadataService.getTokenMetadata(tokenAddress, chainId);
          decimals = tokenInfo.decimals;
          symbol = tokenInfo.symbol;
        } catch {
          symbol = `${tokenAddress.slice(0, 6)}...${tokenAddress.slice(-4)}`;
        }
      }
    }

    const valueStr = extractValueString(value);
    return formatTokenAmount(valueStr, decimals, symbol);
  }

  // ethAmount format
  if (format === 'ethAmount') {
    const valueStr = extractValueString(value);
    return formatTokenAmount(valueStr, 18, 'ETH');
  }

  return extractValueString(value);
}

/**
 * Extract string value from various types
 */
function extractValueString(value: unknown): string {
  if (value && typeof value === 'object') {
    const obj = value as { _isBigNumber?: boolean; _value?: string; _hex?: string };
    if (obj._isBigNumber && obj._value !== undefined) {
      return obj._value;
    }
    if (obj._isBigNumber && obj._hex) {
      return BigInt(obj._hex).toString();
    }
    if (typeof (value as { toString?: () => string }).toString === 'function') {
      return (value as { toString: () => string }).toString();
    }
  }
  return String(value);
}

/**
 * Decode command array
 */
async function decodeCommandArray(
  commands: string,
  inputs: unknown[],
  registry: CommandRegistry,
  chainId: number
): Promise<DecodedCommand[]> {
  if (!commands || !registry) return [];

  const commandBytes = commands.startsWith('0x') ? commands.slice(2) : commands;
  const results: DecodedCommand[] = [];

  for (let i = 0; i < commandBytes.length; i += 2) {
    const cmdByte = '0x' + commandBytes.slice(i, i + 2).toLowerCase();
    const cmdDef = registry[cmdByte];
    const inputData = inputs?.[i / 2] as string | undefined;

    if (cmdDef) {
      let intent = cmdDef.intent ?? cmdDef.name;
      const decodedParams: Record<string, unknown> = {};

      if (inputData && cmdDef.inputs) {
        try {
          const mockAbi: ABIEntry = {
            type: 'function',
            name: 'decode',
            inputs: cmdDef.inputs
          };
          const iface = new SimpleInterface([mockAbi]);
          const fakeCalldata = '0x00000000' + (inputData.startsWith('0x') ? inputData.slice(2) : inputData);
          const decoded = iface.decodeFunctionData('decode', fakeCalldata);

          for (let j = 0; j < cmdDef.inputs.length && j < decoded.length; j++) {
            const paramDef = cmdDef.inputs[j];
            let value = decoded[j];

            if (value && typeof value === 'object') {
              const obj = value as { _isBigNumber?: boolean; _value?: string; _hex?: string };
              if (obj._isBigNumber) {
                value = obj._value ?? (obj._hex ? BigInt(obj._hex).toString() : String(value));
              }
            }

            decodedParams[paramDef.name] = value;
          }

          // Substitute template variables
          if (intent.includes('{')) {
            intent = intent.replace(/\{(\w+)\}/g, (match, paramName) => {
              return decodedParams[paramName] !== undefined ? String(decodedParams[paramName]) : match;
            });
          }
        } catch {
          // Continue with default intent
        }
      }

      results.push({
        command: cmdByte,
        name: cmdDef.name,
        intent,
        params: decodedParams
      });
    } else {
      results.push({
        command: cmdByte,
        name: `UNKNOWN_${cmdByte}`,
        intent: `Unknown command ${cmdByte}`,
        params: {}
      });
    }
  }

  return results;
}

/**
 * Main transaction decoder
 */
export class TransactionDecoder {
  /**
   * Decode transaction calldata
   */
  async decodeCalldata(
    data: string,
    contractAddress: string,
    chainId: number
  ): Promise<DecodedTransaction> {
    try {
      const selector = data.slice(0, 10);
      const metadata = await metadataService.getContractMetadata(contractAddress, chainId, selector);

      if (!metadata) {
        return {
          success: false,
          selector,
          params: {},
          rawParams: {},
          formatted: {},
          intent: 'Contract interaction',
          error: 'No metadata found'
        };
      }

      // Find function in ABI
      let functionSignature: string | null = null;
      let functionName: string | null = null;
      let abiFunction: ABIEntry | null = null;

      const abi = metadata.context?.contract?.abi;
      if (abi && Array.isArray(abi)) {
        for (const item of abi) {
          if (item.type === 'function') {
            const types = (item.inputs ?? []).map(input => input.type).join(',');
            const signature = `${item.name}(${types})`;
            const expectedSelector = item.selector ?? SimpleInterface.calculateSelector(signature);

            if (expectedSelector === selector) {
              functionSignature = signature;
              functionName = item.name ?? null;
              abiFunction = item;
              break;
            }
          }
        }
      }

      if (!functionSignature && !functionName) {
        return {
          success: false,
          selector,
          params: {},
          rawParams: {},
          formatted: {},
          intent: 'Unknown function',
          metadata,
          error: 'Function not found in metadata ABI'
        };
      }

      // Get format/intent from metadata
      let intent = 'Contract interaction';
      const fieldInfo: Record<string, FieldDefinition> = {};
      const formats = metadata.display?.formats ?? {};
      const format = formats[functionSignature ?? ''] ?? formats[functionName ?? ''];

      if (format) {
        if (format.interpolatedIntent) {
          intent = format.interpolatedIntent;
        } else if (typeof format.intent === 'string') {
          intent = format.intent;
        } else if (format.intent && typeof format.intent === 'object' && 'template' in format.intent) {
          intent = format.intent.template ?? intent;
        }

        if (format.fields) {
          for (const field of format.fields) {
            if (field.path) {
              fieldInfo[field.path] = field;
            }
          }
        }
      }

      // Decode parameters
      const params: Record<string, string> = {};
      const rawParams: Record<string, unknown> = {};
      const formatted: Record<string, FormattedParam> = {};

      if (abiFunction) {
        const iface = new SimpleInterface([abiFunction]);
        const decodedData = iface.decodeFunctionData(functionName!, data);
        const inputs = abiFunction.inputs ?? [];

        for (let i = 0; i < decodedData.length && i < inputs.length; i++) {
          const input = inputs[i];
          const value = decodedData[i];
          const paramName = input.name || `param${i}`;

          rawParams[paramName] = value;

          const fieldDef = fieldInfo[paramName];
          let rawValue = extractValueString(value);
          let displayValue = rawValue;

          // Apply formatting
          if (fieldDef) {
            displayValue = await applyFieldFormat(value, fieldDef, rawParams, chainId);
          }

          params[paramName] = rawValue;
          formatted[paramName] = {
            label: fieldDef?.label ?? paramName,
            value: displayValue,
            rawValue,
            format: fieldDef?.format ?? 'raw',
            params: fieldDef?.params
          };
        }
      }

      // Handle composite intents (command registries)
      let decodedCommands: DecodedCommand[] | undefined;
      const commandRegistries = metadata.commandRegistries;

      if (commandRegistries && rawParams.commands) {
        const commands = rawParams.commands as string;
        const inputs = rawParams.inputs as unknown[];
        const registryName = Object.keys(commandRegistries)[0];
        const registry = commandRegistries[registryName];

        if (registry) {
          decodedCommands = await decodeCommandArray(commands, inputs, registry, chainId);
          if (decodedCommands.length > 0) {
            intent = decodedCommands.map(cmd => cmd.intent).join(' + ');
          }
        }
      }

      // Substitute template variables in intent
      if (intent.includes('{')) {
        intent = intent.replace(/\{([#@]?[\w.\[\]]+)(?::(\w+))?\}/g, (match, path) => {
          const value = formatted[path]?.value ?? rawParams[path];
          return value !== undefined ? String(value) : match;
        });
      }

      return {
        success: true,
        selector,
        function: functionSignature ?? undefined,
        functionName: functionName ?? undefined,
        params,
        rawParams,
        intent,
        formatted,
        metadata,
        decodedCommands
      };
    } catch (error) {
      return {
        success: false,
        selector: data.slice(0, 10),
        params: {},
        rawParams: {},
        formatted: {},
        intent: 'Contract interaction',
        error: (error as Error).message
      };
    }
  }
}

// Global decoder instance
export const transactionDecoder = new TransactionDecoder();
