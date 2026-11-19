// Model Context Protocol at /mcp: JSON-RPC 2.0 Streamable HTTP, revision
// 2026-07-28 (`server/discover`) with the legacy `initialize` handshake. Six
// tools act on the same store as REST, with the same objects and ids.
import { issueJson, pullJson, repoJson } from './rest.ts';
import { isoTime, type Store } from './store.ts';
import { trialNowSec } from './scenario.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number (squash).',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

// The tools list is a constant: two calls answer byte-identical lists.
const TOOLS_JSON = JSON.stringify(TOOLS);

export interface McpResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

function rpcResult(id: unknown, result: unknown): McpResult {
  return { status: 200, body: { jsonrpc: '2.0', id: id ?? null, result } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpResult {
  return { status, body: { jsonrpc: '2.0', id: id ?? null, error: { code, message } } };
}

function toolResult(content: unknown, isError = false): Record<string, unknown> {
  const text = typeof content === 'string' ? content : JSON.stringify(content);
  return { content: [{ type: 'text', text }], structuredContent: content, isError };
}

function toolError(message: string): Record<string, unknown> {
  return toolResult({ error: message }, true);
}

function ownedRepo(store: Store, login: string, owner: string, repoName: string) {
  if (owner !== login) return undefined;
  return store.getRepo(owner, repoName);
}

function callTool(store: Store, login: string, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const text = (value: unknown): string => (typeof value === 'string' ? value : '');
  const num = (value: unknown): number | null => {
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
    return null;
  };
  switch (name) {
    case 'create_repo': {
      const repoName = text(args.name);
      if (repoName === '') return toolError('missing required argument: name');
      if (store.getRepo(login, repoName) !== undefined) return toolError(`repository ${login}/${repoName} already exists`);
      const repo = store.createRepo(login, repoName, args.private === true, text(args.description));
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      const owner = text(args.owner);
      const repoName = text(args.repo);
      if (owner === '' || repoName === '') return toolError('missing required argument: owner or repo');
      const repo = ownedRepo(store, login, owner, repoName);
      if (repo === undefined) return toolError(`repository ${owner}/${repoName} not found`);
      return toolResult(repoJson(repo));
    }
    case 'create_issue': {
      const owner = text(args.owner);
      const repoName = text(args.repo);
      const title = text(args.title);
      if (owner === '' || repoName === '' || title === '') return toolError('missing required argument: owner, repo or title');
      const repo = ownedRepo(store, login, owner, repoName);
      if (repo === undefined) return toolError(`repository ${owner}/${repoName} not found`);
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const issue = {
        id: store.nextIssueId,
        number,
        title,
        body: text(args.body),
        state: 'open' as const,
        labels: [] as string[],
        comments: [] as never[],
      };
      store.nextIssueId += 1;
      repo.issues.set(number, issue);
      return toolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const owner = text(args.owner);
      const repoName = text(args.repo);
      if (owner === '' || repoName === '') return toolError('missing required argument: owner or repo');
      const repo = ownedRepo(store, login, owner, repoName);
      if (repo === undefined) return toolError(`repository ${owner}/${repoName} not found`);
      const state = text(args.state) || 'open';
      let issues = [...repo.issues.values()];
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      issues.sort((a, b) => b.number - a.number);
      return toolResult(issues.map((issue) => issueJson(repo, issue)));
    }
    case 'create_pull_request': {
      const owner = text(args.owner);
      const repoName = text(args.repo);
      const title = text(args.title);
      const head = text(args.head);
      const base = text(args.base);
      if (owner === '' || repoName === '' || title === '' || head === '' || base === '') {
        return toolError('missing required argument: owner, repo, title, head or base');
      }
      const repo = ownedRepo(store, login, owner, repoName);
      if (repo === undefined) return toolError(`repository ${owner}/${repoName} not found`);
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) return toolError('head or base branch does not exist');
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const pr = {
        number,
        title,
        body: text(args.body),
        state: 'open' as const,
        head,
        base,
        headSha,
        baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
      };
      repo.pulls.set(number, pr);
      return toolResult(pullJson(store, repo, pr));
    }
    case 'merge_pull_request': {
      const owner = text(args.owner);
      const repoName = text(args.repo);
      const pullNumber = num(args.pull_number);
      if (owner === '' || repoName === '' || pullNumber === null) {
        return toolError('missing required argument: owner, repo or pull_number');
      }
      const repo = ownedRepo(store, login, owner, repoName);
      if (repo === undefined) return toolError(`repository ${owner}/${repoName} not found`);
      const pr = repo.pulls.get(pullNumber);
      if (pr === undefined) return toolError(`pull request #${pullNumber} not found`);
      if (pr.state !== 'open') return toolError(`pull request #${pullNumber} is not open`);
      const mergeSha = store.squashMerge(repo, pr, login);
      if (mergeSha === null) return toolError(`pull request #${pullNumber} has a merge conflict`);
      pr.state = 'closed';
      pr.merged = true;
      pr.mergedAt = isoTime(trialNowSec());
      pr.mergeCommitSha = mergeSha;
      return toolResult({ merged: true, sha: mergeSha, number: pullNumber, state: 'closed' });
    }
    default:
      return toolError(`unknown tool ${name}`);
  }
}

export function handleMcp(store: Store, login: string, rawBody: string): McpResult {
  let request: Record<string, unknown>;
  try {
    request = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  if (request === null || typeof request !== 'object' || Array.isArray(request)) {
    return rpcError(null, -32600, 'Invalid Request', 400);
  }
  const id = request.id ?? null;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;

  // Notifications carry no id and expect no answer body.
  if (id === null && method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }

  if (method === 'server/discover') {
    return rpcResult(id, {
      resultType: 'discover',
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'initialize') {
    const requested = typeof (params.protocolVersion as string | undefined) === 'string' ? (params.protocolVersion as string) : PROTOCOL_VERSION;
    const negotiated = SUPPORTED_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSION;
    return rpcResult(id, {
      protocolVersion: negotiated,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }
  if (method === 'ping') {
    return rpcResult(id, {});
  }
  if (method === 'tools/list') {
    // Byte-identical across calls: the same pre-rendered array.
    return { status: 200, body: { jsonrpc: '2.0', id, result: { tools: JSON.parse(TOOLS_JSON) as unknown } } };
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = TOOLS.find((candidate) => candidate.name === name);
    if (tool === undefined) return rpcError(id, -32602, `unknown tool: ${name}`);
    const missing = tool.inputSchema.required.filter((required) => args[required] === undefined || args[required] === null || args[required] === '');
    if (missing.length > 0) {
      return rpcResult(id, toolError(`missing required argument: ${missing.join(', ')}`));
    }
    return rpcResult(id, callTool(store, login, name, args));
  }
  return rpcError(id, -32601, `method not found: ${method}`);
}

export { TOOLS_JSON };
