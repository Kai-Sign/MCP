import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const deeplyNested = {
  userFacingRequest: 'prepare only, do not send',
  hallucinatedLlmEnvelope: {
    choices: [{
      message: {
        tool_calls: [{
          function: {
            name: 'clear_sign_payload',
            arguments: {
              connector: 'KaiSignMCP',
              notes: ['generated from backend metadata/tokens/usdc-base.json'],
              bankr: {
                action: {
                  kind: 'erc20-transfer',
                  network: { name: 'Base', chain: '8453' },
                  token: {
                    symbol: 'USDC',
                    sourceMetadata: '../kaisign-backend/backend/metadata/tokens/usdc-base.json'
                  },
                  preview: {
                    doNotSend: true,
                    doNotSign: true,
                    doNotBroadcast: true,
                    unsigned: {
                      walletRequest: {
                        method: 'eth_sendTransaction',
                        params: [{
                          transactionRequest: {
                            evmTransaction: {
                              target: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
                              input: '0xa9059cbb0000000000000000000000002222222222222222222222222222222222222222000000000000000000000000000000000000000000000000000000000007a120',
                              valueWei: '0',
                              networkId: '8453'
                            }
                          }
                        }]
                      }
                    }
                  }
                }
              }
            }
          }
        }]
      }
    }]
  }
};

const client = new Client({ name: 'deep-human-test', version: '1.0.0' }, { capabilities: {} });
const transport = new StdioClientTransport({ command: 'node', args: ['dist/index.js'], stderr: 'ignore' });
await client.connect(transport);
const result = await client.callTool({ name: 'clear_sign_payload', arguments: deeplyNested });
console.log(result.content[0].text);
await client.close();
