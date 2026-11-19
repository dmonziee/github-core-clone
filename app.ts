// The forge's HTTP server: health probe, git smart HTTP, REST v3, GraphQL v4 and
// MCP, all on one in-memory store. Every REST/GraphQL/MCP reply carries a
// non-empty X-GitHub-Request-Id; every reply is JSON except the git wire
// formats, which carry their own content types.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleRest, type RestResult } from './rest.ts';
import { executeGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleReceivePack, handleUploadPack, v0Advertisement, v2Advertisement } from './githttp.ts';
import { VIEWER_LOGIN } from './scenario.ts';

const JSON_TYPE = 'application/json; charset=utf-8';

const store = new Store();
let requestCounter = 0;

function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  if (body === null || status === 204) {
    res.writeHead(status, { 'content-type': JSON_TYPE, 'x-github-request-id': nextRequestId(), ...headers });
    res.end();
    return;
  }
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text), 'x-github-request-id': nextRequestId(), ...headers });
  res.end(text);
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/.exec(header);
  return match === null ? null : (match[1] as string);
}

function parseJsonBody(raw: Buffer): { ok: true; value: unknown } | { ok: false } {
  const text = raw.toString('utf8').trim();
  if (text === '') return { ok: true, value: null };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function baseUrlOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const path = pathOf(req);
      const method = req.method ?? 'GET';
      const query = queryOf(req);
      const token = bearerToken(req);
      const login = VIEWER_LOGIN;

      try {
        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // ---------------------------------------------------------------- git smart HTTP
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(path);
        if (gitMatch !== null) {
          const owner = decodeURIComponent(gitMatch[1] as string);
          const repoName = decodeURIComponent(gitMatch[2] as string);
          const suffix = gitMatch[3] as string;
          const repo = store.getRepo(owner, repoName);
          if (suffix === 'info/refs' && method === 'GET') {
            const service = query.get('service');
            if (repo === undefined || (service !== 'git-upload-pack' && service !== 'git-receive-pack')) {
              sendJson(res, 404, { message: 'Not Found' });
              return;
            }
            if (service === 'git-receive-pack') {
              sendBuffer(res, 200, v0Advertisement(store, repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
              return;
            }
            const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
            sendBuffer(
              res,
              200,
              isV2 ? v2Advertisement() : v0Advertisement(store, repo, 'git-upload-pack'),
              'application/x-git-upload-pack-advertisement',
            );
            return;
          }
          if (suffix === 'git-upload-pack' && method === 'POST') {
            if (repo === undefined) {
              sendJson(res, 404, { message: 'Not Found' });
              return;
            }
            const body = await readBody(req);
            const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
            sendBuffer(res, 200, handleUploadPack(repo, body, isV2, store), 'application/x-git-upload-pack-result');
            return;
          }
          if (suffix === 'git-receive-pack' && method === 'POST') {
            if (repo === undefined) {
              sendJson(res, 404, { message: 'Not Found' });
              return;
            }
            const body = await readBody(req);
            sendBuffer(res, 200, handleReceivePack(store, repo, body), 'application/x-git-receive-pack-result');
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // ---------------------------------------------------------------- GraphQL v4
        if (path === '/api/graphql' && method === 'POST') {
          if (token === null || token === '') {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const raw = await readBody(req);
          const parsed = parseJsonBody(raw);
          if (!parsed.ok) {
            sendJson(res, 400, { message: 'Bad JSON' });
            return;
          }
          const ctx = { store, login };
          if (Array.isArray(parsed.value)) {
            const results = parsed.value.map((operation) => {
              const op = (operation ?? {}) as Record<string, unknown>;
              if (typeof op.query !== 'string') return { data: null, errors: [{ message: 'query is required' }] };
              return executeGraphQL(ctx, op.query, (op.variables ?? {}) as Record<string, unknown>);
            });
            sendJson(res, 200, results);
            return;
          }
          const body = (parsed.value ?? {}) as Record<string, unknown>;
          if (typeof body.query !== 'string') {
            sendJson(res, 400, { message: 'query is required' });
            return;
          }
          sendJson(res, 200, executeGraphQL(ctx, body.query, (body.variables ?? {}) as Record<string, unknown>));
          return;
        }

        // ---------------------------------------------------------------- MCP
        if (path === '/mcp' && method === 'POST') {
          if (token === null || token === '') {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          const raw = await readBody(req);
          const result = handleMcp(store, login, raw.toString('utf8'));
          if (result.body === null) {
            res.writeHead(result.status, { 'x-github-request-id': nextRequestId() });
            res.end();
            return;
          }
          sendJson(res, result.status, result.body, result.headers ?? {});
          return;
        }

        // ---------------------------------------------------------------- REST v3
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const restPath = path === '/api/v3' ? '' : path.slice('/api/v3/'.length);
          const segments = restPath === '' ? [] : restPath.split('/').map((part) => decodeURIComponent(part));
          // The API root and meta are public; everything else needs a token.
          const isPublic = segments.length === 0 || (segments.length === 1 && segments[0] === 'meta');
          if (!isPublic && (token === null || token === '')) {
            sendJson(res, 401, { message: 'Requires authentication' });
            return;
          }
          let body: Record<string, unknown> | null = null;
          if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
            const raw = await readBody(req);
            const parsed = parseJsonBody(raw);
            if (!parsed.ok) {
              sendJson(res, 400, { message: 'Bad JSON' });
              return;
            }
            body = (parsed.value ?? {}) as Record<string, unknown>;
          }
          const result: RestResult | null = handleRest({ store, baseUrl: baseUrlOf(req), login }, method, segments, query, body);
          if (result === null) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          sendJson(res, result.status, result.body, result.headers ?? {});
          return;
        }

        // ---------------------------------------------------------------- unknown route
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        // The server stays up through malformed requests and handler failures.
        try {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } catch {
          // The response is already gone; nothing more to do.
        }
      }
    })();
  });
}
