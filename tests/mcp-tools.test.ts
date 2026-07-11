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

  it('exposes ERC-7730 metadata submission workflow tools', () => {
    const names = mcpTools.map(tool => tool.name);

    expect(names).toEqual(expect.arrayContaining([
      'init_submission_burner',
      'get_submission_burner_status',
      'submit_sponsored_metadata',
      'init_submission_scope',
      'prepare_sponsored_commit',
      'prepare_sponsored_reveal',
      'get_submission_scope_status',
      'prepare_direct_commit',
      'prepare_direct_reveal',
      'prepare_direct_vote'
    ]));

    const submitTool = mcpTools.find(t => t.name === 'submit_sponsored_metadata');
    expect(submitTool?.description).toContain('EIP-4844 blob');
    expect(submitTool?.inputSchema.required).toContain('metadata');

    const directTool = mcpTools.find(t => t.name === 'prepare_direct_commit');
    expect(directTool?.description).toContain('permissioned bond token');
  });
});
