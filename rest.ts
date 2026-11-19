// GitHub REST v3 under /api/v3. Every reply is application/json with a
// non-empty X-GitHub-Request-Id; errors carry {message}; unknown routes are
// 404 JSON; malformed JSON bodies are 400. A repository belongs to the token's
// login: the same name under another owner is 404, never 403.
import { globalId, isoTime, type Issue, type PullRequest, type Repo, type Store } from './store.ts';
import { trialNowSec, VIEWER_LOGIN } from './scenario.ts';
import { parseCommit, type GitObject } from './gitobj.ts';

export interface RestResult {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** The fixed creation timestamp every repository, issue and pull request
 *  carries (2025-01-01T00:00:00Z): precomputed once instead of building a
 *  Date and formatting it per object. */
const FIXED_ISO = '2025-01-01T00:00:00.000Z';

const ok = (status: number, body: unknown, headers?: Record<string, string>): RestResult => ({ status, body, headers });
const err = (status: number, message: string): RestResult => ({ status, body: { message } });

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('R', `${repo.owner}/${repo.name}`),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('I', `${repo.owner}/${repo.name}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed', default: false, description: '' };
    }),
    user: { login: repo.owner, id: 1000, type: 'User' },
    comments: issue.comments.length,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

/** Hand-built serialization of a single issue, byte-identical to
 *  `${JSON.stringify(issueJson(repo, issue))}\n` but without building the
 *  intermediate object: the write workload creates 200 issues in a row, and
 *  this is its per-create serialization cost. Every string field is escaped
 *  with JSON.stringify, and the field order matches issueJson, so the bytes
 *  match the generic path exactly. */
export function issueResponseString(repo: Repo, issue: Issue): string {
  const labels = issue.labels
    .map((name) => {
      const label = repo.labels.get(name);
      return `{"name":${JSON.stringify(name)},"color":${JSON.stringify(label?.color ?? 'ededed')},"default":false,"description":""}`;
    })
    .join(',');
  return (
    `{"id":${issue.id},"node_id":${JSON.stringify(globalId('I', `${repo.owner}/${repo.name}:${issue.number}`))},"number":${issue.number},` +
    `"title":${JSON.stringify(issue.title)},"body":${JSON.stringify(issue.body)},"state":${JSON.stringify(issue.state)},"labels":[${labels}],` +
    `"user":{"login":${JSON.stringify(repo.owner)},"id":1000,"type":"User"},"comments":${issue.comments.length},` +
    `"created_at":"${FIXED_ISO}","updated_at":"${FIXED_ISO}",` +
    `"html_url":${JSON.stringify(`https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`)},` +
    `"url":${JSON.stringify(`/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`)}}\n`
  );
}

/** The serialized single-issue response (JSON + newline), cached on the issue:
 *  the read workload asks for the same unchanged issue 2,000 times, so only
 *  the first call pays for serialization. */
export function issueResponseBuffer(repo: Repo, issue: Issue): Buffer {
  if (issue.jsonBuf !== null) return issue.jsonBuf;
  const buf = Buffer.from(issueResponseString(repo, issue), 'utf8');
  issue.jsonBuf = buf;
  return buf;
}

export function pullJson(store: Store, repo: Repo, pr: PullRequest): Record<string, unknown> {
  return {
    id: pr.number,
    node_id: globalId('P', `${repo.owner}/${repo.name}:${pr.number}`),
    number: pr.number,
    state: pr.state,
    title: pr.title,
    body: pr.body,
    head: { ref: pr.head, sha: pr.headSha, label: `${repo.owner}:${pr.head}` },
    base: { ref: pr.base, sha: pr.baseSha, label: `${repo.owner}:${pr.base}` },
    merged: pr.merged,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    mergeable: pr.state === 'open' ? store.mergeable(repo, pr) === 'MERGEABLE' : null,
    user: { login: repo.owner, id: 1000, type: 'User' },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
  };
}

interface Ctx {
  store: Store;
  baseUrl: string;
  login: string;
}

function linkHeader(ctx: Ctx, path: string, query: URLSearchParams, page: number, perPage: number): string {
  const next = new URLSearchParams(query);
  next.set('page', String(page + 1));
  next.set('per_page', String(perPage));
  return `<${ctx.baseUrl}${path}?${next.toString()}>; rel="next"`;
}

/** Resolve a repository the token's login owns; anything else is a 404. */
function ownedRepo(ctx: Ctx, owner: string, name: string): Repo | null {
  if (owner !== ctx.login) return null;
  const repo = ctx.store.getRepo(owner, name);
  return repo ?? null;
}

function parseIntParam(query: URLSearchParams, name: string, fallback: number): number {
  const raw = query.get(name);
  if (raw === null) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.floor(n) : fallback;
}

export function handleRest(
  ctx: Ctx,
  method: string,
  segments: string[],
  query: URLSearchParams,
  body: Record<string, unknown> | null,
): RestResult | null {
  const [first, ...rest] = segments;
  if (first === undefined || first === '') {
    if (method === 'GET') {
      return ok(200, {}, { 'x-oauth-scopes': 'repo, user, gist' });
    }
    return null;
  }
  if (first === 'meta' && method === 'GET') {
    return ok(200, { installed_version: '1.0.0' });
  }
  if (first === 'user') {
    if (rest.length === 0 && method === 'GET') {
      return ok(200, { login: ctx.login, id: 1000, type: 'User', name: ctx.login });
    }
    if (rest[0] === 'repos') {
      if (method === 'GET') {
        const repos = ctx.store.listRepos(ctx.login);
        const perPage = parseIntParam(query, 'per_page', 30);
        const page = parseIntParam(query, 'page', 1);
        const start = (page - 1) * perPage;
        const slice = repos.slice(start, start + perPage);
        const headers: Record<string, string> = {};
        if (start + perPage < repos.length) {
          headers.link = linkHeader(ctx, '/api/v3/user/repos', query, page, perPage);
        }
        return ok(200, slice.map(repoJson), headers);
      }
      if (method === 'POST') {
        const name = typeof body?.name === 'string' ? body.name : '';
        if (name === '') return err(422, 'name is required');
        if (ctx.store.getRepo(ctx.login, name) !== undefined) return err(422, 'Repository already exists');
        const repo = ctx.store.createRepo(
          ctx.login,
          name,
          body?.private === true,
          typeof body?.description === 'string' ? (body.description as string) : '',
        );
        return ok(201, repoJson(repo));
      }
    }
    return null;
  }
  if (first !== 'repos') return null;
  // /repos/{owner}/{name}[/...]
  const owner = rest[0];
  const name = rest[1];
  if (owner === undefined || name === undefined) return null;
  const tail = rest.slice(2);
  const repo = ownedRepo(ctx, owner, name);
  if (tail.length === 0) {
    if (repo === null) return err(404, 'Not Found');
    if (method === 'GET') return ok(200, repoJson(repo));
    if (method === 'PATCH') {
      if (typeof body?.description === 'string') repo.description = body.description as string;
      if (typeof body?.name === 'string' && (body.name as string) !== '') {
        // Renames are not exercised; accept the new name in place.
        ctx.store.deleteRepo(owner, name);
        repo.name = body.name as string;
        ctx.store.repos.set(ctx.store.key(owner, repo.name), repo);
      }
      return ok(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      ctx.store.deleteRepo(owner, name);
      return { status: 204, body: null };
    }
    return null;
  }
  if (repo === null) return err(404, 'Not Found');
  return handleRepoSub(ctx, repo, method, tail, query, body);
}

function handleRepoSub(
  ctx: Ctx,
  repo: Repo,
  method: string,
  tail: string[],
  query: URLSearchParams,
  body: Record<string, unknown> | null,
): RestResult | null {
  const [head, ...rest] = tail;

  if (head === 'git' && rest[0] === 'refs') {
    if (method === 'POST' && rest.length === 1) {
      const ref = typeof body?.ref === 'string' ? (body.ref as string) : '';
      const sha = typeof body?.sha === 'string' ? (body.sha as string) : '';
      if (!ref.startsWith('refs/') || sha === '') return err(422, 'ref and sha are required');
      if (repo.objects.get(sha) === undefined) return err(422, 'object not found');
      if (repo.refs.has(ref)) return err(422, 'reference already exists');
      repo.refs.set(ref, sha);
      return ok(201, { ref, object: { sha } });
    }
    if (method === 'GET' && rest.length === 3 && rest[1] === 'heads') {
      const branch = decodeURIComponent(rest[2] as string);
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) return err(404, 'Not Found');
      return ok(200, { ref: `refs/heads/${branch}`, object: { sha } });
    }
    return null;
  }

  if (head === 'branches') {
    if (method === 'GET' && rest.length === 0) {
      const branches: Record<string, unknown>[] = [];
      for (const [ref, sha] of repo.refs) {
        if (!ref.startsWith('refs/heads/')) continue;
        branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha } });
      }
      branches.sort((a, b) => String(a.name).localeCompare(String(b.name)));
      return ok(200, branches);
    }
    if (method === 'GET' && rest.length === 1) {
      const branch = decodeURIComponent(rest[0] as string);
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) return err(404, 'Not Found');
      return ok(200, { name: branch, commit: { sha } });
    }
    return null;
  }

  if (head === 'commits') {
    if (method === 'GET' && rest.length === 0) {
      const shaParam = query.get('sha');
      let tip: string | undefined = ctx.store.headTip(repo);
      if (shaParam !== null && shaParam !== '') {
        tip = repo.refs.get(`refs/heads/${shaParam}`) ?? (repo.objects.get(shaParam)?.type === 'commit' ? shaParam : undefined);
      }
      const commits = ctx.store.listCommits(repo, tip);
      return ok(
        200,
        commits.map((entry) => {
          const object = repo.objects.get(entry.sha) as GitObject;
          const commit = parseCommit(object.data);
          const authorLine = commit.author;
          const authorName = authorLine.slice(0, authorLine.lastIndexOf(' <'));
          const authorEmail = authorLine.slice(authorLine.lastIndexOf(' <') + 2, authorLine.lastIndexOf('>'));
          return {
            sha: entry.sha,
            commit: {
              // GitHub's API returns the commit message without the
              // trailing newline that the stored commit object carries.
              message: commit.message.replace(/\n$/, ''),
              author: { name: authorName, email: authorEmail, date: isoTime(commit.authorTime) },
              committer: { name: authorName, email: authorEmail, date: isoTime(commit.committerTime) },
            },
            parents: commit.parents.map((sha) => ({ sha })),
          };
        }),
      );
    }
    return null;
  }

  if (head === 'contents') {
    return handleContents(ctx, repo, method, rest.join('/'), query, body);
  }

  if (head === 'labels') {
    if (method === 'POST') {
      const name = typeof body?.name === 'string' ? (body.name as string) : '';
      if (name === '') return err(422, 'name is required');
      const color = typeof body?.color === 'string' ? (body.color as string) : 'ededed';
      repo.labels.set(name, { name, color });
      // Label colors are embedded in cached issue responses.
      for (const issue of repo.issues.values()) issue.jsonBuf = null;
      return ok(201, { name, color, default: false, description: '' });
    }
    return null;
  }

  if (head === 'issues') {
    return handleIssues(ctx, repo, method, rest, body, query);
  }

  if (head === 'pulls') {
    return handlePulls(ctx, repo, method, rest, body, query);
  }

  return null;
}

// ---------------------------------------------------------------------------
// contents
// ---------------------------------------------------------------------------

function resolveRefTip(store: Store, repo: Repo, ref: string | null): string | undefined {
  if (ref === null || ref === '') return store.headTip(repo);
  return repo.refs.get(`refs/heads/${ref}`) ?? (repo.objects.get(ref)?.type === 'commit' ? ref : undefined);
}

function handleContents(
  ctx: Ctx,
  repo: Repo,
  method: string,
  path: string,
  query: URLSearchParams,
  body: Record<string, unknown> | null,
): RestResult | null {
  const decodedPath = path.split('/').map((part) => (part.includes('%') ? decodeURIComponent(part) : part)).join('/');
  if (method === 'GET') {
    const tip = resolveRefTip(ctx.store, repo, query.get('ref'));
    if (tip === undefined) return err(404, 'Not Found');
    const commit = parseCommit((repo.objects.get(tip) as GitObject).data);
    const files = ctx.store.flattenTree(repo, commit.tree);
    const file = files.get(decodedPath);
    if (file !== undefined) {
      const blob = repo.objects.get(file.oid) as GitObject;
      return ok(200, {
        type: 'file',
        name: decodedPath.split('/').pop() ?? decodedPath,
        path: decodedPath,
        sha: file.oid,
        size: blob.data.length,
        content: blob.data.toString('base64'),
        encoding: 'base64',
      });
    }
    // Directory listing: immediate children of the path.
    const prefix = decodedPath === '' ? '' : `${decodedPath}/`;
    const entries = new Map<string, { type: string; name: string; path: string; sha: string }>();
    for (const [filePath, entry] of files) {
      if (!filePath.startsWith(prefix)) continue;
      const remainder = filePath.slice(prefix.length);
      const slash = remainder.indexOf('/');
      if (slash < 0) {
        entries.set(remainder, { type: 'file', name: remainder, path: filePath, sha: entry.oid });
      } else {
        const dirName = remainder.slice(0, slash);
        if (!entries.has(dirName)) {
          // Find the tree oid for this directory.
          let treeOid = commit.tree;
          const parts = `${prefix}${dirName}`.split('/');
          for (const part of parts) {
            const tree = repo.objects.get(treeOid);
            if (tree?.type !== 'tree') break;
            const found = parseTree(tree.data).find((e) => e.name === part && e.mode === '40000');
            if (found === undefined) break;
            treeOid = found.oid;
          }
          entries.set(dirName, { type: 'dir', name: dirName, path: `${prefix}${dirName}`, sha: treeOid });
        }
      }
    }
    if (entries.size === 0) return err(404, 'Not Found');
    return ok(200, [...entries.values()].sort((a, b) => a.name.localeCompare(b.name)));
  }

  if (method === 'PUT') {
    const message = typeof body?.message === 'string' ? (body.message as string) : 'update';
    const contentB64 = typeof body?.content === 'string' ? (body.content as string) : '';
    if (contentB64 === '') return err(422, 'content is required');
    const content = Buffer.from(contentB64, 'base64');
    const branch = typeof body?.branch === 'string' && (body.branch as string) !== '' ? (body.branch as string) : repo.defaultBranch;
    const branchRef = `refs/heads/${branch}`;
    if (!repo.refs.has(branchRef)) {
      const defaultTip = ctx.store.headTip(repo);
      if (defaultTip !== undefined) repo.refs.set(branchRef, defaultTip);
    }
    const tip = repo.refs.get(branchRef);
    let existingSha: string | undefined;
    if (tip !== undefined) {
      const commit = parseCommit((repo.objects.get(tip) as GitObject).data);
      existingSha = ctx.store.flattenTree(repo, commit.tree).get(decodedPath)?.oid;
    }
    const givenSha = typeof body?.sha === 'string' ? (body.sha as string) : undefined;
    if (existingSha !== undefined) {
      if (givenSha === undefined || givenSha !== existingSha) return err(409, 'sha does not match the current file');
    }
    const { commitSha, blobSha } = ctx.store.commitFile(repo, branch, decodedPath, content, message, ctx.login);
    return ok(existingSha === undefined ? 201 : 200, {
      content: {
        name: decodedPath.split('/').pop() ?? decodedPath,
        path: decodedPath,
        sha: blobSha,
        size: content.length,
        type: 'file',
        encoding: 'base64',
        content: contentB64,
      },
      commit: { sha: commitSha, message },
    });
  }

  if (method === 'DELETE') {
    const branch = typeof body?.branch === 'string' && (body.branch as string) !== '' ? (body.branch as string) : repo.defaultBranch;
    const message = typeof body?.message === 'string' ? (body.message as string) : 'delete';
    const givenSha = typeof body?.sha === 'string' ? (body.sha as string) : undefined;
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (tip === undefined) return err(404, 'Not Found');
    const commit = parseCommit((repo.objects.get(tip) as GitObject).data);
    const existing = ctx.store.flattenTree(repo, commit.tree).get(decodedPath);
    if (existing === undefined) return err(404, 'Not Found');
    if (givenSha !== undefined && givenSha !== existing.oid) return err(409, 'sha does not match the current file');
    const { commitSha } = ctx.store.commitFile(repo, branch, decodedPath, null, message, ctx.login);
    return ok(200, { commit: { sha: commitSha, message } });
  }

  return null;
}

// ---------------------------------------------------------------------------
// issues
// ---------------------------------------------------------------------------

function handleIssues(
  ctx: Ctx,
  repo: Repo,
  method: string,
  rest: string[],
  body: Record<string, unknown> | null,
  query: URLSearchParams,
): RestResult | null {
  if (rest.length === 0) {
    if (method === 'GET') {
      let issues = [...repo.issues.values()];
      const state = query.get('state') ?? 'open';
      if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
      const direction = query.get('direction') ?? 'desc';
      issues.sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
      const perPage = parseIntParam(query, 'per_page', 30);
      const page = parseIntParam(query, 'page', 1);
      const start = (page - 1) * perPage;
      const slice = issues.slice(start, start + perPage);
      const headers: Record<string, string> = {};
      if (start + perPage < issues.length) {
        headers.link = linkHeader(ctx, `/api/v3/repos/${repo.owner}/${repo.name}/issues`, query, page, perPage);
      }
      return ok(200, slice.map((issue) => issueJson(repo, issue)), headers);
    }
    if (method === 'POST') {
      const title = typeof body?.title === 'string' ? (body.title as string) : '';
      const issueBody = typeof body?.body === 'string' ? (body.body as string) : '';
      const labelNames = Array.isArray(body?.labels) ? (body.labels as unknown[]).filter((x): x is string => typeof x === 'string') : [];
      for (const name of labelNames) {
        if (!repo.labels.has(name)) return err(422, `label ${name} does not exist`);
      }
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const issue: Issue = {
        id: ctx.store.nextIssueId,
        number,
        title,
        body: issueBody,
        state: 'open',
        labels: labelNames,
        comments: [],
        jsonBuf: null,
      };
      ctx.store.nextIssueId += 1;
      repo.issues.set(number, issue);
      return ok(201, issueResponseBuffer(repo, issue));
    }
    return null;
  }
  const number = Number(rest[0]);
  if (!Number.isInteger(number)) return null;
  const issue = repo.issues.get(number);
  if (rest.length === 1) {
    if (issue === undefined) return err(404, 'Not Found');
    if (method === 'GET') return ok(200, issueResponseBuffer(repo, issue));
    if (method === 'PATCH') {
      issue.jsonBuf = null;
      if (body?.state === 'open' || body?.state === 'closed') issue.state = body.state;
      if (typeof body?.title === 'string') issue.title = body.title as string;
      if (typeof body?.body === 'string') issue.body = body.body as string;
      return ok(200, issueResponseBuffer(repo, issue));
    }
    return null;
  }
  if (rest[1] === 'comments') {
    if (issue === undefined) return err(404, 'Not Found');
    if (method === 'GET') {
      return ok(
        200,
        issue.comments.map((comment) => ({ id: comment.id, body: comment.body, user: { login: repo.owner } })),
      );
    }
    if (method === 'POST') {
      const commentBody = typeof body?.body === 'string' ? (body.body as string) : '';
      const comment = { id: ctx.store.nextCommentId, body: commentBody };
      ctx.store.nextCommentId += 1;
      issue.comments.push(comment);
      issue.jsonBuf = null; // the comments count in the cached response changed
      return ok(201, { id: comment.id, body: comment.body, user: { login: repo.owner } });
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// pulls
// ---------------------------------------------------------------------------

function handlePulls(
  ctx: Ctx,
  repo: Repo,
  method: string,
  rest: string[],
  body: Record<string, unknown> | null,
  query: URLSearchParams,
): RestResult | null {
  if (rest.length === 0) {
    if (method === 'GET') {
      let pulls = [...repo.pulls.values()];
      const state = query.get('state') ?? 'open';
      if (state !== 'all') pulls = pulls.filter((pr) => pr.state === state);
      pulls.sort((a, b) => b.number - a.number);
      const perPage = parseIntParam(query, 'per_page', 30);
      const page = parseIntParam(query, 'page', 1);
      const start = (page - 1) * perPage;
      return ok(200, pulls.slice(start, start + perPage).map((pr) => pullJson(ctx.store, repo, pr)));
    }
    if (method === 'POST') {
      const head = typeof body?.head === 'string' ? (body.head as string) : '';
      const base = typeof body?.base === 'string' ? (body.base as string) : repo.defaultBranch;
      const title = typeof body?.title === 'string' ? (body.title as string) : '';
      const prBody = typeof body?.body === 'string' ? (body.body as string) : '';
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (headSha === undefined || baseSha === undefined) return err(422, 'head or base branch does not exist');
      for (const existing of repo.pulls.values()) {
        if (existing.head === head && existing.state === 'open') return err(422, 'a pull request from this branch is already open');
      }
      const number = repo.nextNumber;
      repo.nextNumber += 1;
      const pr: PullRequest = {
        number,
        title,
        body: prBody,
        state: 'open',
        head,
        base,
        headSha,
        baseSha,
        merged: false,
        mergedAt: null,
        mergeCommitSha: null,
      };
      repo.pulls.set(number, pr);
      return ok(201, pullJson(ctx.store, repo, pr));
    }
    return null;
  }
  const number = Number(rest[0]);
  if (!Number.isInteger(number)) return null;
  const pr = repo.pulls.get(number);
  if (rest.length === 1) {
    if (pr === undefined) return err(404, 'Not Found');
    if (method === 'GET') return ok(200, pullJson(ctx.store, repo, pr));
    return null;
  }
  if (rest[1] === 'files' && method === 'GET') {
    if (pr === undefined) return err(404, 'Not Found');
    const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
    const headTip = repo.refs.get(`refs/heads/${pr.head}`);
    const mergeBase = baseTip !== undefined && headTip !== undefined ? ctx.store.mergeBase(repo, baseTip, headTip) : null;
    const files = ctx.store.diffFiles(repo, mergeBase ?? baseTip, headTip);
    return ok(200, files);
  }
  if (rest[1] === 'merge' && method === 'PUT') {
    if (pr === undefined) return err(404, 'Not Found');
    if (pr.state !== 'open') return err(405, 'pull request is not open');
    const mergeSha = ctx.store.squashMerge(repo, pr, ctx.login);
    if (mergeSha === null) return err(405, 'merge conflict');
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = isoTime(trialNowSec());
    pr.mergeCommitSha = mergeSha;
    return ok(200, { sha: mergeSha, merged: true, message: `Merge pull request #${pr.number}` });
  }
  return null;
}

export { VIEWER_LOGIN };
