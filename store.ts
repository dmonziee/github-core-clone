// The forge's in-memory store: repositories, git objects and refs, issues, pull
// requests, labels and comments — one shared store for REST, GraphQL and MCP.
// Deterministic: ids and numbers come from counters, timestamps from the trial
// clock plus a per-repo sequence, never the wall clock or Math.random.
import {
  buildCommit,
  buildTag,
  buildTree,
  hashObject,
  identityLine,
  makeObject,
  parseCommit,
  parseTag,
  parseTree,
  type GitObject,
  type ObjectType,
  type TreeEntry,
  ZERO_OID,
} from './gitobj.ts';
import { trialNowSec, VIEWER_LOGIN } from './scenario.ts';

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
}

export interface Comment {
  id: number;
  body: string;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string; // branch name
  base: string; // branch name
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>; // full ref name -> oid
  issues: Map<number, Issue>;
  pulls: Map<number, PullRequest>;
  labels: Map<string, { name: string; color: string }>;
  nextNumber: number; // shared issue/PR numbering, per repo
  commitSeq: number; // deterministic timestamp offset for server-made commits
}

export class Store {
  repos = new Map<string, Repo>(); // "owner/name" -> repo
  nextRepoId = 1;
  nextIssueId = 1;
  nextCommentId = 1;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, isPrivate: boolean, description: string): Repo {
    const repo: Repo = {
      id: this.nextRepoId,
      name,
      owner,
      private: isPrivate,
      description,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextNumber: 1,
      commitSeq: 0,
    };
    this.nextRepoId += 1;
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === owner) out.push(repo);
    }
    return out;
  }

  // ---------------------------------------------------------------- git objects

  putObject(repo: Repo, type: ObjectType, data: Buffer): string {
    const { oid, object } = makeObject(type, data);
    repo.objects.set(oid, object);
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  refTip(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  headRef(repo: Repo): string {
    return `refs/heads/${repo.defaultBranch}`;
  }

  headTip(repo: Repo): string | undefined {
    return repo.refs.get(this.headRef(repo));
  }

  /** The commit a tag object (or a chain of them) ultimately points at. */
  peelToCommit(repo: Repo, oid: string): string | undefined {
    let current = oid;
    for (let depth = 0; depth < 10; depth += 1) {
      const object = repo.objects.get(current);
      if (object === undefined) return undefined;
      if (object.type === 'commit') return current;
      if (object.type === 'tag') {
        current = parseTag(object.data).object;
        continue;
      }
      return undefined;
    }
    return undefined;
  }

  /** All commit ids reachable from `tips` (tags peeled), newest-first traversal. */
  reachableCommits(repo: Repo, tips: readonly string[]): Set<string> {
    const seen = new Set<string>();
    const stack: string[] = [];
    for (const tip of tips) {
      const commit = this.peelToCommit(repo, tip);
      if (commit !== undefined) stack.push(commit);
    }
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      seen.add(oid);
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
    return seen;
  }

  /** The full object closure (commits, trees, blobs, tags) of `tips`. */
  closure(repo: Repo, tips: readonly string[]): Map<string, GitObject> {
    const out = new Map<string, GitObject>();
    const visit = (oid: string): void => {
      if (out.has(oid)) return;
      const object = repo.objects.get(oid);
      if (object === undefined) return;
      out.set(oid, object);
      if (object.type === 'commit') {
        const commit = parseCommit(object.data);
        visit(commit.tree);
        for (const parent of commit.parents) visit(parent);
      } else if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) visit(entry.oid);
      } else if (object.type === 'tag') {
        visit(parseTag(object.data).object);
      }
    };
    for (const tip of tips) visit(tip);
    return out;
  }

  /** Is `ancestor` an ancestor of (or equal to) `descendant`? */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    if (ancestor === ZERO_OID) return true;
    return this.reachableCommits(repo, [descendant]).has(ancestor);
  }

  /** The newest common ancestor of two commits, or null. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const aAncestors = this.reachableCommits(repo, [a]);
    const queue: string[] = [b];
    const seen = new Set<string>();
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (aAncestors.has(oid)) return oid;
      const object = repo.objects.get(oid);
      if (object?.type === 'commit') {
        for (const parent of parseCommit(object.data).parents) queue.push(parent);
      }
    }
    return null;
  }

  /** Commits reachable from `tip`, newest first (BFS by generation). */
  listCommits(repo: Repo, tip: string | undefined, limit = 100): { sha: string; message: string; time: number }[] {
    if (tip === undefined) return [];
    const out: { sha: string; message: string; time: number }[] = [];
    const seen = new Set<string>();
    const queue: string[] = [tip];
    while (queue.length > 0 && out.length < limit) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (object?.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      out.push({ sha: oid, message: commit.message, time: commit.committerTime });
      for (const parent of commit.parents) queue.push(parent);
    }
    // Newest first by commit time, stable by discovery order.
    return out.sort((a, b) => b.time - a.time);
  }

  // ---------------------------------------------------------------- trees

  /** Flatten a tree (by commit tip) into path -> {mode, oid}. */
  flattenTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { mode: string; oid: string }> {
    const out = new Map<string, { mode: string; oid: string }>();
    const walk = (oid: string, path: string): void => {
      const object = repo.objects.get(oid);
      if (object?.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const childPath = path === '' ? entry.name : `${path}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, childPath);
        else out.set(childPath, { mode: entry.mode, oid: entry.oid });
      }
    };
    walk(treeOid, prefix);
    return out;
  }

  /** Build nested tree objects from a flat file map; returns the root tree oid. */
  buildTreeFromFiles(repo: Repo, files: Map<string, { mode: string; oid: string }>): string {
    // Group by directory, bottom-up.
    const dirs = new Map<string, Map<string, TreeEntry>>();
    const ensureDir = (dir: string): Map<string, TreeEntry> => {
      let map = dirs.get(dir);
      if (map === undefined) {
        map = new Map();
        dirs.set(dir, map);
      }
      return map;
    };
    ensureDir('');
    for (const [path, file] of files) {
      const slash = path.lastIndexOf('/');
      const dir = slash < 0 ? '' : path.slice(0, slash);
      const name = slash < 0 ? path : path.slice(slash + 1);
      // Register every ancestor directory, even one holding only subdirectories.
      if (dir !== '') {
        const parts = dir.split('/');
        for (let i = 1; i <= parts.length; i += 1) ensureDir(parts.slice(0, i).join('/'));
      }
      ensureDir(dir).set(name, { mode: file.mode, name, oid: file.oid });
    }
    // Process deepest directories first (the root '' is depth 0, not 1).
    const depthOf = (dir: string): number => (dir === '' ? 0 : dir.split('/').length);
    const ordered = [...dirs.keys()].sort((a, b) => depthOf(b) - depthOf(a));
    const treeOids = new Map<string, string>();
    for (const dir of ordered) {
      const entries = [...(dirs.get(dir) as Map<string, TreeEntry>).values()];
      // Any subdirectories of this dir contribute their tree entries.
      for (const [sub, oid] of treeOids) {
        const parent = sub.includes('/') ? sub.slice(0, sub.lastIndexOf('/')) : '';
        if (parent === dir) {
          const name = sub.includes('/') ? sub.slice(sub.lastIndexOf('/') + 1) : sub;
          entries.push({ mode: '40000', name, oid });
        }
      }
      const treeOid = this.putObject(repo, 'tree', buildTree(entries));
      treeOids.set(dir, treeOid);
    }
    return treeOids.get('') as string;
  }

  /** Create a commit on `branch` from a file change against its tip. */
  commitFile(
    repo: Repo,
    branch: string,
    path: string,
    content: Buffer | null, // null = delete
    message: string,
    authorName: string,
  ): { commitSha: string; blobSha: string | null } {
    const ref = `refs/heads/${branch}`;
    const tip = repo.refs.get(ref);
    let files = new Map<string, { mode: string; oid: string }>();
    const parents: string[] = [];
    if (tip !== undefined) {
      const commit = parseCommit((repo.objects.get(tip) as GitObject).data);
      files = this.flattenTree(repo, commit.tree);
      parents.push(tip);
    }
    let blobSha: string | null = null;
    if (content === null) {
      files.delete(path);
    } else {
      blobSha = this.putObject(repo, 'blob', content);
      files.set(path, { mode: '100644', oid: blobSha });
    }
    const treeOid = this.buildTreeFromFiles(repo, files);
    const time = trialNowSec() + repo.commitSeq;
    repo.commitSeq += 1;
    const email = `${authorName}@users.noreply.github.com`;
    const identity = identityLine(authorName, email, time);
    const commitSha = this.putObject(
      repo,
      'commit',
      buildCommit({ tree: treeOid, parents, author: identity, committer: identity, message }),
    );
    repo.refs.set(ref, commitSha);
    return { commitSha, blobSha };
  }

  /** Create a tag object. */
  createTag(repo: Repo, name: string, target: string, message: string, authorName: string): string {
    const time = trialNowSec() + repo.commitSeq;
    repo.commitSeq += 1;
    const email = `${authorName}@users.noreply.github.com`;
    const tagger = identityLine(authorName, email, time);
    return this.putObject(repo, 'tag', buildTag({ object: target, type: 'commit', tag: name, tagger, message }));
  }

  // ---------------------------------------------------------------- diff / merge

  diffFiles(
    repo: Repo,
    baseTip: string | undefined,
    headTip: string | undefined,
  ): { filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number }[] {
    const baseFiles = baseTip === undefined ? new Map() : this.flattenTree(repo, parseCommit((repo.objects.get(baseTip) as GitObject).data).tree);
    const headFiles = headTip === undefined ? new Map() : this.flattenTree(repo, parseCommit((repo.objects.get(headTip) as GitObject).data).tree);
    const out: { filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number }[] = [];
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of [...paths].sort()) {
      const base = baseFiles.get(path);
      const head = headFiles.get(path);
      if (base !== undefined && head !== undefined && base.oid === head.oid) continue;
      const baseText = base === undefined ? '' : (repo.objects.get(base.oid) as GitObject).data.toString('utf8');
      const headText = head === undefined ? '' : (repo.objects.get(head.oid) as GitObject).data.toString('utf8');
      const counts = lineDiff(baseText, headText);
      out.push({
        filename: path,
        status: base === undefined ? 'added' : head === undefined ? 'removed' : 'modified',
        additions: counts.additions,
        deletions: counts.deletions,
        changes: counts.additions + counts.deletions,
      });
    }
    return out;
  }

  /**
   * Three-way squash merge of a PR's head into its base. Returns the new commit
   * sha, or null when the branches conflict (same file changed both sides to
   * different bytes).
   */
  squashMerge(repo: Repo, pr: PullRequest, authorName: string): string | null {
    const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
    const headTip = repo.refs.get(`refs/heads/${pr.head}`);
    if (baseTip === undefined || headTip === undefined) return null;
    const baseCommit = parseCommit((repo.objects.get(baseTip) as GitObject).data);
    const headCommit = parseCommit((repo.objects.get(headTip) as GitObject).data);
    const mergeBase = this.mergeBase(repo, baseTip, headTip);
    const baseFiles = this.flattenTree(repo, baseCommit.tree);
    const headFiles = this.flattenTree(repo, headCommit.tree);
    const ancestorFiles =
      mergeBase === null
        ? new Map<string, { mode: string; oid: string }>()
        : this.flattenTree(repo, parseCommit((repo.objects.get(mergeBase) as GitObject).data).tree);
    const merged = new Map(baseFiles);
    const paths = new Set([...ancestorFiles.keys(), ...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of paths) {
      const ancestor = ancestorFiles.get(path);
      const base = baseFiles.get(path);
      const head = headFiles.get(path);
      const baseChanged = !sameFile(ancestor, base);
      const headChanged = !sameFile(ancestor, head);
      if (headChanged && baseChanged && !sameFile(base, head)) return null; // conflict
      if (headChanged) {
        if (head === undefined) merged.delete(path);
        else merged.set(path, head);
      }
    }
    const treeOid = this.buildTreeFromFiles(repo, merged);
    // Deterministic timestamps: the head commit's own times.
    const author = headCommit.author;
    const committer = headCommit.committer;
    const message = `Merge pull request #${pr.number} from ${repo.owner}/${pr.head}\n\n${pr.title}`;
    const commitSha = this.putObject(repo, 'commit', buildCommit({ tree: treeOid, parents: [baseTip], author, committer, message }));
    repo.refs.set(`refs/heads/${pr.base}`, commitSha);
    return commitSha;
  }

  /** MERGEABLE / CONFLICTING for a PR, by the same three-way rule as squashMerge. */
  mergeable(repo: Repo, pr: PullRequest): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
    if (pr.state !== 'open') return 'UNKNOWN';
    const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
    const headTip = repo.refs.get(`refs/heads/${pr.head}`);
    if (baseTip === undefined || headTip === undefined) return 'UNKNOWN';
    const baseCommit = parseCommit((repo.objects.get(baseTip) as GitObject).data);
    const headCommit = parseCommit((repo.objects.get(headTip) as GitObject).data);
    const mergeBase = this.mergeBase(repo, baseTip, headTip);
    const baseFiles = this.flattenTree(repo, baseCommit.tree);
    const headFiles = this.flattenTree(repo, headCommit.tree);
    const ancestorFiles =
      mergeBase === null
        ? new Map<string, { mode: string; oid: string }>()
        : this.flattenTree(repo, parseCommit((repo.objects.get(mergeBase) as GitObject).data).tree);
    const paths = new Set([...ancestorFiles.keys(), ...baseFiles.keys(), ...headFiles.keys()]);
    for (const path of paths) {
      const ancestor = ancestorFiles.get(path);
      const base = baseFiles.get(path);
      const head = headFiles.get(path);
      if (!sameFile(ancestor, base) && !sameFile(ancestor, head) && !sameFile(base, head)) return 'CONFLICTING';
    }
    return 'MERGEABLE';
  }
}

function sameFile(
  a: { oid: string } | undefined,
  b: { oid: string } | undefined,
): boolean {
  if (a === undefined && b === undefined) return true;
  if (a === undefined || b === undefined) return false;
  return a.oid === b.oid;
}

/** Line multiset diff: lines present in `after` but not `before` are additions. */
function lineDiff(before: string, after: string): { additions: number; deletions: number } {
  const countLines = (text: string): Map<string, number> => {
    const map = new Map<string, number>();
    if (text === '') return map;
    for (const line of text.split('\n')) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const beforeCounts = countLines(before);
  const afterCounts = countLines(after);
  let additions = 0;
  let deletions = 0;
  for (const [line, count] of afterCounts) {
    const diff = count - (beforeCounts.get(line) ?? 0);
    if (diff > 0) additions += diff;
  }
  for (const [line, count] of beforeCounts) {
    const diff = count - (afterCounts.get(line) ?? 0);
    if (diff > 0) deletions += diff;
  }
  return { additions, deletions };
}

/** Opaque, stable Relay global id. */
export function globalId(kind: string, key: string): string {
  return Buffer.from(`${kind}:${key}`, 'utf8').toString('base64');
}

export function parseGlobalId(id: string): { kind: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    return { kind: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

export function isoTime(sec: number): string {
  return new Date(sec * 1000).toISOString();
}
