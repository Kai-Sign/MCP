import { describe, expect, it } from 'vitest';
import { getFunctionSelectors } from '../src/tools/get-function-selectors.js';

describe('get_function_selectors', () => {
  it('resolves Alchemy LightAccount V2 executeBatch selectors from exact address metadata', async () => {
    const result = await getFunctionSelectors({
      contractAddress: '0x8E8e658E22B12ada97B402fF0b044D6A325013C7',
      chainId: 1,
      functionName: 'executeBatch'
    });

    expect(result.found).toBe(true);
    expect(result.functions.map(fn => fn.signature)).toContain('executeBatch(address[],uint256[],bytes[])');
    expect(result.functions.map(fn => fn.selector)).toContain('0x47e1da2a');
    expect(result.functions.map(fn => fn.selector)).not.toContain('0x34fcd5be');
  });

  it('rejects a selector that belongs to a different account ABI for the same LightAccount address', async () => {
    const result = await getFunctionSelectors({
      contractAddress: '0x8E8e658E22B12ada97B402fF0b044D6A325013C7',
      chainId: 1,
      functionName: 'executeBatch',
      selector: '0x34fcd5be'
    });

    expect(result.found).toBe(false);
    expect(result.functions).toEqual([]);
    expect(result.warning).toContain('Do not substitute');
  });
});
