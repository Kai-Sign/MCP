#!/usr/bin/env node
/**
 * KaiSign MCP HTTP Server
 *
 * Supports both:
 * - Streamable HTTP: POST /mcp with JSON-RPC messages
 * - SSE legacy:      GET /mcp, then POST /mcp?sessionId=...
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { handleMcpToolCall, mcpTools, server } from './index.js';

const DEFAULT_PORT = 3333;
const DEFAULT_HOST = '0.0.0.0';
const MAX_BODY_BYTES = 4 * 1024 * 1024;

const transports = new Map<string, SSEServerTransport>();
const streamableSessions = new Set<string>();

type JsonRpcMessage = {
  jsonrpc?: '2.0';
  id?: string | number | null;
  method?: string;
  params?: any;
};

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version, Last-Event-ID, Accept',
    'Access-Control-Expose-Headers': 'Mcp-Session-Id, MCP-Protocol-Version',
    'Access-Control-Allow-Private-Network': 'true'
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    ...corsHeaders(),
    ...extraHeaders
  });
  res.end(JSON.stringify(body));
}

function sendNoContent(res: ServerResponse, extraHeaders: Record<string, string> = {}): void {
  res.writeHead(202, {
    ...corsHeaders(),
    ...extraHeaders
  });
  res.end();
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, {
    error: 'not_found',
    message: 'Use POST /mcp for Streamable HTTP or GET /mcp for SSE legacy.'
  });
}

function rpcResult(id: JsonRpcMessage['id'], result: unknown): unknown {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: JsonRpcMessage['id'], code: number, message: string): unknown {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function mcpErrorToRpc(error: unknown): { code: number; message: string } {
  if (error instanceof McpError) {
    const code = error.code === ErrorCode.MethodNotFound ? -32601 : -32603;
    return { code, message: error.message };
  }
  return { code: -32603, message: error instanceof Error ? error.message : String(error) };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = '';
    let size = 0;

    req.setEncoding('utf8');
    req.on('data', (chunk) => {
      size += Buffer.byteLength(chunk);
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function handleStreamableMessage(message: JsonRpcMessage): Promise<unknown | undefined> {
  const id = message.id;

  // JSON-RPC notifications have no id. MCP initialized notifications should not get a response.
  if (id === undefined && message.method?.startsWith('notifications/')) return undefined;

  try {
    switch (message.method) {
      case 'initialize':
        return rpcResult(id, {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'kaisign-mcp', version: '1.0.0' }
        });

      case 'ping':
        return rpcResult(id, {});

      case 'tools/list':
        return rpcResult(id, { tools: mcpTools });

      case 'tools/call': {
        const params = message.params ?? {};
        const result = await handleMcpToolCall(params.name, params.arguments ?? {});
        return rpcResult(id, result);
      }

      default:
        return rpcError(id, -32601, `Method not found: ${message.method}`);
    }
  } catch (error) {
    const rpc = mcpErrorToRpc(error);
    return rpcError(id, rpc.code, rpc.message);
  }
}

async function handleStreamablePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  let parsed: JsonRpcMessage | JsonRpcMessage[];

  try {
    parsed = JSON.parse(body || 'null');
  } catch (error) {
    sendJson(res, 400, rpcError(null, -32700, 'Parse error'));
    return;
  }

  const existingSession = req.headers['mcp-session-id'];
  const sessionId = typeof existingSession === 'string' && existingSession
    ? existingSession
    : randomUUID();
  streamableSessions.add(sessionId);

  if (Array.isArray(parsed)) {
    const responses = (await Promise.all(parsed.map(handleStreamableMessage))).filter((r) => r !== undefined);
    if (responses.length === 0) {
      sendNoContent(res, { 'Mcp-Session-Id': sessionId });
      return;
    }
    sendJson(res, 200, responses, { 'Mcp-Session-Id': sessionId });
    return;
  }

  if (!parsed || typeof parsed !== 'object') {
    sendJson(res, 400, rpcError(null, -32600, 'Invalid Request'), { 'Mcp-Session-Id': sessionId });
    return;
  }

  const response = await handleStreamableMessage(parsed);
  if (response === undefined) {
    sendNoContent(res, { 'Mcp-Session-Id': sessionId });
    return;
  }

  sendJson(res, 200, response, { 'Mcp-Session-Id': sessionId });
}

async function handleMcp(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  if (req.method === 'GET') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    const transport = new SSEServerTransport('/mcp', res);
    transports.set(transport.sessionId, transport);

    transport.onclose = () => {
      transports.delete(transport.sessionId);
    };

    await server.connect(transport);
    return;
  }

  if (req.method === 'POST') {
    const sessionId = url.searchParams.get('sessionId');

    // SSE legacy POST path: /mcp?sessionId=...
    if (sessionId) {
      const transport = transports.get(sessionId);
      if (!transport) {
        sendJson(res, 404, {
          error: 'unknown_session',
          message: `No MCP SSE session found for sessionId=${sessionId}`
        });
        return;
      }

      await transport.handlePostMessage(req, res);
      return;
    }

    // Streamable HTTP POST path: /mcp
    await handleStreamablePost(req, res);
    return;
  }

  res.writeHead(405, { Allow: 'GET, POST, OPTIONS', ...corsHeaders() });
  res.end('Method Not Allowed');
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT || process.env.MCP_PORT || DEFAULT_PORT);
  const host = process.env.HOST || process.env.MCP_HOST || DEFAULT_HOST;

  const httpServer = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);

      if (url.pathname === '/health') {
        sendJson(res, 200, {
          ok: true,
          name: 'kaisign-mcp',
          transports: ['streamable-http', 'sse'],
          endpoint: '/mcp'
        });
        return;
      }

      if (url.pathname === '/mcp' || url.pathname === '/mcp/') {
        await handleMcp(req, res, url);
        return;
      }

      notFound(res);
    })().catch((error) => {
      console.error('HTTP MCP request failed:', error);
      if (!res.headersSent) {
        sendJson(res, 500, {
          error: 'internal_error',
          message: error instanceof Error ? error.message : String(error)
        });
      } else {
        res.end();
      }
    });
  });

  httpServer.listen(port, host, () => {
    console.error(`KaiSign MCP HTTP Server running at http://${host}:${port}/mcp`);
    console.error('MCP transports: Streamable HTTP + SSE legacy');
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Failed to start HTTP MCP server:', error);
    process.exit(1);
  });
}
