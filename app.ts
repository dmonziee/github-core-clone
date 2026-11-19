// The forge's HTTP server: health probe, git smart HTTP, REST v3, GraphQL v4 and
// MCP, all on one in-memory store. Every REST/GraphQL/MCP reply carries a
// non-empty X-GitHub-Request-Id; every reply is JSON except the git wire
// formats, which carry their own content types.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, type Issue, type Repo } from './store.ts';
import { handleRest, issueResponseBuffer, type RestResult } from './rest.ts';
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
  if (Buffer.isBuffer(body)) {
    // A pre-serialized response (the cached single-issue body): skip
    // JSON.stringify and the byte-length scan entirely.
    res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': body.length, 'x-github-request-id': nextRequestId(), ...headers });
    res.end(body);
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
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;
  const token = header.slice('Bearer '.length);
  return token === '' ? null : token;
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

/** An empty query set, shared by every request without a query string. */
const EMPTY_PARAMS = new URLSearchParams();

/** The path and query of a request URL, parsed without `new URL`: the
 *  WHATWG parser costs several microseconds per request, and the hot routes
 *  (2,000 issue reads, 250 clone requests) never need it. `query` is built
 *  lazily only when a query string is present. */
function parseUrl(req: IncomingMessage): { path: string; query: URLSearchParams } {
  const raw = req.url ?? '/';
  const q = raw.indexOf('?');
  if (q < 0) return { path: raw, query: EMPTY_PARAMS };
  return { path: raw.slice(0, q), query: new URLSearchParams(raw.slice(q + 1)) };
}

/** Decode one path segment, skipping the decoder when there is nothing to decode. */
function decodeSegment(part: string): string {
  return part.includes('%') ? decodeURIComponent(part) : part;
}

/**
 * Synchronous fast paths for the hottest GETs: no promise, no URL parse, no
 * regex. Only exact shapes are handled here; anything else falls through to
 * the generic handler below, which keeps the full contract. Returns true
 * when the request was answered.
 */
function tryFastGet(req: IncomingMessage, res: ServerResponse): boolean {
  const rawUrl = req.url ?? '/';
  // GET /healthz
  if (rawUrl === '/healthz') {
    sendJson(res, 200, { ok: true });
    return true;
  }
  // GET /{owner}/{repo}.git/info/refs?service=git-upload-pack|git-receive-pack
  // (the clone workload re-fetches this advertisement three times per clone).
  const serviceIdx = rawUrl.indexOf('?service=');
  if (serviceIdx >= 0) {
    const service = rawUrl.slice(serviceIdx + '?service='.length);
    if (service === 'git-upload-pack' || service === 'git-receive-pack') {
      const parts = rawUrl.slice(0, serviceIdx).split('/');
      if (parts.length === 5 && parts[0] === '' && parts[3] === 'info' && parts[4] === 'refs') {
        const owner = parts[1] as string;
        const repoSeg = parts[2] as string;
        if (!owner.includes('%') && !repoSeg.includes('%') && repoSeg.endsWith('.git')) {
          const repo = store.getRepo(owner, repoSeg.slice(0, -'.git'.length));
          if (repo === undefined) {
            sendJson(res, 404, { message: 'Not Found' });
            return true;
          }
          if (service === 'git-receive-pack') {
            sendBuffer(res, 200, v0Advertisement(store, repo, 'git-receive-pack'), 'application/x-git-receive-pack-advertisement');
            return true;
          }
          const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
          sendBuffer(
            res,
            200,
            isV2 ? v2Advertisement() : v0Advertisement(store, repo, 'git-upload-pack'),
            'application/x-git-upload-pack-advertisement',
          );
          return true;
        }
      }
    }
  }
  // GET /api/v3/repos/{owner}/{repo}/issues/{number} with no query string
  // (the read workload: 2,000 sequential GETs on one keep-alive connection).
  if (rawUrl.startsWith('/api/v3/repos/') && rawUrl.indexOf('?') < 0) {
    const parts = rawUrl.split('/');
    // ['', 'api', 'v3', 'repos', owner, repo, 'issues', number]
    if (parts.length === 8 && parts[6] === 'issues') {
      const owner = parts[4] as string;
      const repoName = parts[5] as string;
      const numText = parts[7] as string;
      if (
        !owner.includes('%') && !repoName.includes('%') && !numText.includes('%') &&
        numText.length > 0 && /^[0-9]+$/.test(numText)
      ) {
        const token = bearerToken(req);
        if (token === null || token === '') {
          sendJson(res, 401, { message: 'Requires authentication' });
          return true;
        }
        if (owner !== VIEWER_LOGIN) {
          sendJson(res, 404, { message: 'Not Found' });
          return true;
        }
        const repo = store.getRepo(owner, repoName);
        const issue = repo?.issues.get(Number(numText));
        if (issue === undefined) {
          sendJson(res, 404, { message: 'Not Found' });
          return true;
        }
        sendJson(res, 200, issueResponseBuffer(repo as Repo, issue));
        return true;
      }
    }
  }
  return false;
}

function baseUrlOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    // The hottest GETs are answered synchronously before any promise exists.
    if ((req.method ?? 'GET') === 'GET' && tryFastGet(req, res)) return;
    void (async () => {
      const { path, query } = parseUrl(req);
      const method = req.method ?? 'GET';
      const token = bearerToken(req);
      const login = VIEWER_LOGIN;

      try {
        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // ---------------------------------------------------------------- POST /issues fast path
        // The write workload: 200 sequential issue creations. Same checks and
        // response as handleRest's create-issue branch, without the generic
        // segment/dispatch chain. Order mirrors the generic handler (token,
        // then body, then repo) so socket reuse behaves identically.
        if (method === 'POST') {
          const parts = path.split('/');
          if (
            parts.length === 7 && parts[1] === 'api' && parts[2] === 'v3' && parts[3] === 'repos' && parts[6] === 'issues' &&
            !(parts[4] as string).includes('%') && !(parts[5] as string).includes('%')
          ) {
            const owner = parts[4] as string;
            const repoName = parts[5] as string;
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
            const body = (parsed.value ?? {}) as Record<string, unknown>;
            if (owner !== login) {
              sendJson(res, 404, { message: 'Not Found' });
              return;
            }
            const repo = store.getRepo(owner, repoName);
            if (repo === undefined) {
              sendJson(res, 404, { message: 'Not Found' });
              return;
            }
            const title = typeof body.title === 'string' ? (body.title as string) : '';
            const issueBody = typeof body.body === 'string' ? (body.body as string) : '';
            const labelNames = Array.isArray(body.labels)
              ? (body.labels as unknown[]).filter((x): x is string => typeof x === 'string')
              : [];
            for (const name of labelNames) {
              if (!repo.labels.has(name)) {
                sendJson(res, 422, { message: `label ${name} does not exist` });
                return;
              }
            }
            const number = repo.nextNumber;
            repo.nextNumber += 1;
            const issue: Issue = {
              id: store.nextIssueId,
              number,
              title,
              body: issueBody,
              state: 'open',
              labels: labelNames,
              comments: [],
              jsonBuf: null,
            };
            store.nextIssueId += 1;
            repo.issues.set(number, issue);
            sendJson(res, 201, issueResponseBuffer(repo, issue));
            return;
          }
        }

        // ---------------------------------------------------------------- git smart HTTP
        // The regex only runs when the path can be a git path at all.
        const gitMatch = path.includes('.git/') ? /^\/([^/]+)\/([^/]+)\.git\/(.+)$/.exec(path) : null;
        if (gitMatch !== null) {
          const owner = decodeSegment(gitMatch[1] as string);
          const repoName = decodeSegment(gitMatch[2] as string);
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
          const segments = restPath === '' ? [] : restPath.split('/').map((part) => decodeSegment(part));
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
