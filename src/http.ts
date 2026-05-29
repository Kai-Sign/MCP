#!/usr/bin/env node
/**
 * KaiSign MCP HTTP/SSE Server
 *
 * Bankrbot terminal frontend can add this as an MCP server URL:
 *   http://localhost:3333/mcp
 * Transport:
 *   SSE (legacy)
 */

import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { server } from './index.js';

const DEFAULT_PORT = 3333;
const DEFAULT_HOST = '0.0.0.0';

const transports = new Map<string, SSEServerTransport>();

function corsHeaders(): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, Mcp-Session-Id, MCP-Protocol-Version',
    'Access-Control-Allow-Private-Network': 'true'
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    ...corsHeaders()
  });
  res.end(JSON.stringify(body));
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, {
    error: 'not_found',
    message: 'Use GET /mcp for SSE transport. POST messages go to /mcp?sessionId=...'
  });
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
    if (!sessionId) {
      sendJson(res, 400, {
        error: 'missing_session',
        message: 'Missing sessionId. Connect with GET /mcp first; the SSE endpoint event gives /mcp?sessionId=...'
      });
      return;
    }

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

  res.writeHead(405, { Allow: 'GET, POST, OPTIONS' });
  res.end('Method Not Allowed');
}

async function main(): Promise<void> {
  const port = Number(process.env.PORT || process.env.MCP_PORT || DEFAULT_PORT);
  const host = process.env.HOST || process.env.MCP_HOST || DEFAULT_HOST;

  const httpServer = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);

      if (url.pathname === '/health') {
        sendJson(res, 200, { ok: true, name: 'kaisign-mcp', transport: 'sse' });
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
    console.error(`KaiSign MCP HTTP/SSE Server running at http://${host}:${port}/mcp`);
    console.error('Bankrbot MCP transport: SSE (legacy)');
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error('Failed to start HTTP MCP server:', error);
    process.exit(1);
  });
}
