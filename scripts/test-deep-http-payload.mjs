const endpoint = process.argv[2];
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
                    unsigned: {
                      walletRequest: {
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

let init = await fetch(endpoint, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'accept': 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'deep-http-test', version: '1' } } })
});
const sid = init.headers.get('mcp-session-id');
if (!init.ok || !sid) throw new Error(`init failed ${init.status} ${await init.text()}`);

let call = await fetch(endpoint, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'accept': 'application/json', 'mcp-session-id': sid },
  body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'clear_sign_payload', arguments: deeplyNested } })
});
const json = await call.json();
if (json.error) throw new Error(JSON.stringify(json.error));
const parsed = JSON.parse(json.result.content[0].text);
console.log(parsed.transaction);
console.log(parsed.clearSign.intent);
console.log(parsed.clearSign.functionName);
console.log(parsed.clearSign.fullyDecoded);
