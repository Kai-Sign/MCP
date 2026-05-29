import { describe, expect, it } from 'vitest';
import { mcpTools } from '../src/index.js';

describe('MCP tool registry', () => {
  it('exposes clear_sign_payload for any tx-builder output shape', () => {
    const tool = mcpTools.find(t => t.name === 'clear_sign_payload');

    expect(tool).toBeTruthy();
    expect(tool?.description).toContain('transaction builder');
    expect(tool?.inputSchema.properties).toMatchObject({
      to: expect.objectContaining({ type: 'string' }),
      data: expect.objectContaining({ type: 'string' }),
      transaction: expect.objectContaining({ type: 'object' }),
      rawTx: expect.objectContaining({ type: 'string' })
    });
  });
});
