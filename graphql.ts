// GitHub GraphQL v4 at /api/graphql: a small parser and executor for exactly the
// documents gh and github-mcp-server send — viewer, repository, issue and
// pull-request reads, __type introspection, cursor pagination, Relay global ids,
// the create/close/merge mutations, and batched operation documents.
import { globalId, isoTime, parseGlobalId, type Issue, type PullRequest, type Repo, type Store } from './store.ts';
import { trialNowSec, VIEWER_LOGIN } from './scenario.ts';

// ---------------------------------------------------------------------------
// Lexer / parser (the subset GraphQL documents here use)
// ---------------------------------------------------------------------------

type Token =
  | { kind: 'punct'; value: string }
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (/\s/.test(ch) || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():$![]=<>'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < input.length && input[j] !== '"') {
        if (input[j] === '\\' && j + 1 < input.length) {
          const esc = input[j + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === '"' ? '"' : esc === '\\' ? '\\' : esc;
          j += 2;
        } else {
          value += input[j] as string;
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9.]/.test(input[j] as string)) j += 1;
      const text = input.slice(i, j);
      tokens.push(text.includes('.') ? { kind: 'float', value: text } : { kind: 'int', value: text });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < input.length && /[_A-Za-z0-9]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: { name: string; value: ValueNode }[] };

interface FieldNode {
  kind: 'field';
  alias?: string;
  name: string;
  args: { name: string; value: ValueNode }[];
  selection?: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition?: string;
  selection: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface OperationNode {
  operation: 'query' | 'mutation';
  name?: string;
  variables: { name: string; defaultValue?: ValueNode }[];
  selection: SelectionNode[];
}

class Parser {
  #tokens: Token[];
  #pos = 0;
  constructor(tokens: Token[]) {
    this.#tokens = tokens;
  }
  peek(): Token | undefined {
    return this.#tokens[this.#pos];
  }
  next(): Token {
    const token = this.#tokens[this.#pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.#pos += 1;
    return token;
  }
  expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${value} in GraphQL document`);
  }
  expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }
  parseDocument(): OperationNode[] {
    const operations: OperationNode[] = [];
    while (this.peek() !== undefined) {
      operations.push(this.parseOperation());
    }
    return operations;
  }
  parseOperation(): OperationNode {
    let operation: 'query' | 'mutation' = 'query';
    const first = this.peek();
    if (first?.kind === 'name' && (first.value === 'query' || first.value === 'mutation')) {
      operation = this.next().value as 'query' | 'mutation';
    }
    let name: string | undefined;
    const maybeName = this.peek();
    if (maybeName?.kind === 'name') name = this.next().value;
    const variables: { name: string; defaultValue?: ValueNode }[] = [];
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseType();
        let defaultValue: ValueNode | undefined;
        if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '=') {
          this.next();
          defaultValue = this.parseValue();
        }
        variables.push({ name: varName, defaultValue });
      }
      this.expectPunct(')');
    }
    const selection = this.parseSelectionSet();
    return { operation, name, variables, selection };
  }
  parseType(): void {
    // A type reference: Name, [T], T! — consumed, not validated.
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === '[') {
      this.next();
      this.parseType();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '!') this.next();
  }
  parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
      selections.push(this.parseSelection());
    }
    this.expectPunct('}');
    return selections;
  }
  parseSelection(): SelectionNode {
    const token = this.peek();
    if (token?.kind === 'punct' && token.value === '...') {
      this.next();
      let typeCondition: string | undefined;
      const on = this.peek();
      if (on?.kind === 'name' && on.value === 'on') {
        this.next();
        typeCondition = this.expectName();
      }
      return { kind: 'fragment', typeCondition, selection: this.parseSelectionSet() };
    }
    const nameOrAlias = this.expectName();
    let alias: string | undefined;
    let name = nameOrAlias;
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ':') {
      this.next();
      alias = nameOrAlias;
      name = this.expectName();
    }
    const args: { name: string; value: ValueNode }[] = [];
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '(') {
      this.next();
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ')')) {
        const argName = this.expectName();
        this.expectPunct(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.expectPunct(')');
    }
    let selection: SelectionNode[] | undefined;
    if (this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '{') {
      selection = this.parseSelectionSet();
    }
    return { kind: 'field', alias, name, args, selection };
  }
  parseValue(): ValueNode {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { kind: 'variable', name: this.expectName() };
    if (token.kind === 'punct' && token.value === '[') {
      const values: ValueNode[] = [];
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === ']')) values.push(this.parseValue());
      this.expectPunct(']');
      return { kind: 'list', values };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: { name: string; value: ValueNode }[] = [];
      while (!(this.peek()?.kind === 'punct' && (this.peek() as { value: string }).value === '}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expectPunct('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number(token.value) };
    if (token.kind === 'float') return { kind: 'float', value: Number(token.value) };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'boolean', value: true };
      if (token.value === 'false') return { kind: 'boolean', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((child) => resolveValue(child, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = resolveValue(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// Schema surface
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type', '__schema'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'description', 'createdAt'],
  Ref: ['name'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'endCursor'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'headRef', 'baseRef'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes'],
  PullRequestChangedFile: ['path'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  CommentEdge: ['node'],
  Comment: ['id', 'body'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
};

const INTROSPECTION_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'url', 'createdAt', 'author', 'labels', 'comments', 'repository', 'assignees'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'headRef', 'baseRef', 'author', 'createdAt', 'mergedAt'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'url', 'description', 'createdAt', 'fork', 'private', 'isPrivate'],
  User: ['login', 'id', 'name', 'email'],
};

const INTROSPECTION_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'WIKI', 'PACKAGE', 'MARKETPLACE'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

class FieldError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FieldError';
  }
}

interface GqlContext {
  store: Store;
  login: string;
}

type AnyRecord = Record<string, unknown>;

function wrap(typename: string, value: AnyRecord): AnyRecord {
  return { __typename: typename, ...value };
}

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function cursorNumber(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const n = Number(text.slice('cursor:'.length));
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

function issueNode(store: Store, repo: Repo, issue: Issue): AnyRecord {
  void store;
  return wrap('Issue', {
    id: globalId('I', `${repo.owner}/${repo.name}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body,
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    createdAt: isoTime(1735689600),
  });
}

function pullNode(store: Store, repo: Repo, pr: PullRequest): AnyRecord {
  return wrap('PullRequest', {
    id: globalId('P', `${repo.owner}/${repo.name}:${pr.number}`),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.merged ? 'MERGED' : pr.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pr.merged,
    headRefName: pr.head,
    baseRefName: pr.base,
    mergeable: store.mergeable(repo, pr),
    __pr: pr,
    __repo: repo,
  });
}

function repoNode(repo: Repo): AnyRecord {
  return wrap('Repository', { __repo: repo });
}

function pageInfo(hasNextPage: boolean, endCursor: string | null): AnyRecord {
  return wrap('PageInfo', { hasNextPage, endCursor });
}

function resolveIssues(ctx: GqlContext, repo: Repo, args: Record<string, unknown>): AnyRecord {
  let issues = [...repo.issues.values()];
  const states = args.states as string[] | undefined;
  if (Array.isArray(states) && states.length > 0) {
    const wanted = new Set(states.map((s) => String(s).toUpperCase()));
    issues = issues.filter((issue) => wanted.has(issue.state === 'open' ? 'OPEN' : 'CLOSED'));
  }
  const orderBy = (args.orderBy as { field?: string; direction?: string } | undefined) ?? {};
  const direction = String(orderBy.direction ?? 'DESC').toUpperCase();
  issues.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  const after = cursorNumber(args.after);
  if (after !== null) {
    const index = issues.findIndex((issue) => issue.number === after);
    if (index >= 0) issues = issues.slice(index + 1);
  }
  const first = typeof args.first === 'number' ? args.first : issues.length;
  const page = issues.slice(0, first);
  const hasNextPage = issues.length > page.length;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1]?.number as number) : null;
  return wrap('IssueConnection', {
    nodes: page.map((issue) => issueNode(ctx.store, repo, issue)),
    pageInfo: pageInfo(hasNextPage, endCursor),
    totalCount: issues.length,
  });
}

function resolvePullRequests(ctx: GqlContext, repo: Repo, args: Record<string, unknown>): AnyRecord {
  let pulls = [...repo.pulls.values()].filter((pr) => pr.state === 'open');
  pulls.sort((a, b) => b.number - a.number);
  const first = typeof args.first === 'number' ? args.first : pulls.length;
  const page = pulls.slice(0, first);
  return wrap('PullRequestConnection', {
    nodes: page.map((pr) => pullNode(ctx.store, repo, pr)),
    pageInfo: pageInfo(pulls.length > page.length, null),
    totalCount: pulls.length,
  });
}

function resolveFiles(ctx: GqlContext, repo: Repo, pr: PullRequest, args: Record<string, unknown>): AnyRecord {
  const baseTip = repo.refs.get(`refs/heads/${pr.base}`);
  const headTip = repo.refs.get(`refs/heads/${pr.head}`);
  const mergeBase = baseTip !== undefined && headTip !== undefined ? ctx.store.mergeBase(repo, baseTip, headTip) : null;
  const files = ctx.store.diffFiles(repo, mergeBase ?? baseTip, headTip);
  const first = typeof args.first === 'number' ? args.first : files.length;
  const page = files.slice(0, first);
  return wrap('PullRequestChangedFileConnection', {
    nodes: page.map((file) => wrap('PullRequestChangedFile', { path: file.filename })),
  });
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

function assertField(typename: string, field: string): void {
  if (field === '__typename') return;
  const fields = TYPE_FIELDS[typename];
  if (fields === undefined || !fields.includes(field)) {
    throw new FieldError(`Cannot query field "${field}" on type "${typename}".`);
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const arg of field.args) out[arg.name] = resolveValue(arg.value, variables);
  return out;
}

function resolveField(ctx: GqlContext, typename: string, value: AnyRecord, field: FieldNode, args: Record<string, unknown>): unknown {
  const name = field.name;
  assertField(typename, name);
  if (name === '__typename') return typename;
  switch (typename) {
    case 'Query': {
      if (name === 'viewer') return wrap('User', { login: ctx.login, id: 1000, name: ctx.login });
      if (name === 'repository') {
        const owner = String(args.owner ?? '');
        const repoName = String(args.name ?? '');
        if (owner !== ctx.login) return null;
        const repo = ctx.store.getRepo(owner, repoName);
        return repo === undefined ? null : repoNode(repo);
      }
      if (name === 'node') {
        const parsed = parseGlobalId(String(args.id ?? ''));
        if (parsed === null || parsed.kind !== 'R') return null;
        const [owner, repoName] = parsed.key.split('/', 2);
        if (owner === undefined || repoName === undefined) return null;
        const repo = ctx.store.getRepo(owner, repoName);
        return repo === undefined ? null : repoNode(repo);
      }
      if (name === '__type') {
        const typeName = String(args.name ?? '');
        const fields = INTROSPECTION_FIELDS[typeName];
        const enumValues = INTROSPECTION_ENUMS[typeName];
        if (fields === undefined && enumValues === undefined) return null;
        return wrap('__Type', {
          name: typeName,
          kind: enumValues !== undefined ? 'ENUM' : 'OBJECT',
          fields: fields === undefined ? null : fields.map((f) => wrap('__Field', { name: f })),
          enumValues: enumValues === undefined ? null : enumValues.map((v) => wrap('__EnumValue', { name: v })),
        });
      }
      return null;
    }
    case 'Mutation': {
      return resolveMutation(ctx, name, args);
    }
    case 'Repository': {
      const repo = value.__repo as Repo;
      switch (name) {
        case 'id':
          return globalId('R', `${repo.owner}/${repo.name}`);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return wrap('User', { login: repo.owner, id: 1000, name: repo.owner });
        case 'defaultBranchRef': {
          const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
          return tip === undefined ? null : wrap('Ref', { name: repo.defaultBranch });
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'url':
          return `https://github.com/${repo.owner}/${repo.name}`;
        case 'description':
          return repo.description;
        case 'createdAt':
          return isoTime(1735689600);
        case 'issue': {
          const issue = repo.issues.get(Number(args.number));
          return issue === undefined ? null : issueNode(ctx.store, repo, issue);
        }
        case 'issues':
          return resolveIssues(ctx, repo, args);
        case 'pullRequests':
          return resolvePullRequests(ctx, repo, args);
        case 'pullRequest': {
          const pr = repo.pulls.get(Number(args.number));
          return pr === undefined ? null : pullNode(ctx.store, repo, pr);
        }
        default:
          return null;
      }
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestChangedFileConnection': {
      if (name === 'nodes') return value.nodes ?? [];
      if (name === 'pageInfo') return value.pageInfo ?? pageInfo(false, null);
      if (name === 'totalCount') return value.totalCount ?? 0;
      return null;
    }
    case 'PageInfo':
      return value[name] ?? null;
    case 'PullRequest': {
      const pr = value.__pr as PullRequest;
      const repo = value.__repo as Repo;
      if (name === 'files') return resolveFiles(ctx, repo, pr, args);
      if (name === 'headRef') return wrap('Ref', { name: pr.head });
      if (name === 'baseRef') return wrap('Ref', { name: pr.base });
      return value[name] ?? null;
    }
    case 'CommentEdge':
      return value.node ?? null;
    case '__Type': {
      if (name === 'fields') {
        const includeDeprecated = args.includeDeprecated;
        void includeDeprecated;
        return value.fields ?? null;
      }
      if (name === 'enumValues') return value.enumValues ?? null;
      return value[name] ?? null;
    }
    default:
      return value[name] ?? null;
  }
}

function resolveMutation(ctx: GqlContext, name: string, args: Record<string, unknown>): unknown {
  const input = (args.input as Record<string, unknown> | undefined) ?? {};
  if (name === 'createIssue') {
    const parsed = parseGlobalId(String(input.repositoryId ?? ''));
    if (parsed === null || parsed.kind !== 'R') throw new FieldError('createIssue: unknown repository id');
    const [owner, repoName] = parsed.key.split('/', 2);
    const repo = ctx.store.getRepo(owner as string, repoName as string);
    if (repo === undefined) throw new FieldError('createIssue: unknown repository');
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const issue: Issue = {
      id: ctx.store.nextIssueId,
      number,
      title: String(input.title ?? ''),
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      labels: [],
      comments: [],
    };
    ctx.store.nextIssueId += 1;
    repo.issues.set(number, issue);
    return wrap('CreateIssuePayload', { issue: issueNode(ctx.store, repo, issue) });
  }
  if (name === 'closeIssue') {
    const parsed = parseGlobalId(String(input.issueId ?? ''));
    if (parsed === null || parsed.kind !== 'I') throw new FieldError('closeIssue: unknown issue id');
    const [ownerRepo, numberText] = parsed.key.split(':', 2);
    const [owner, repoName] = (ownerRepo as string).split('/', 2);
    const repo = ctx.store.getRepo(owner as string, repoName as string);
    const issue = repo?.issues.get(Number(numberText));
    if (issue === undefined) throw new FieldError('closeIssue: unknown issue');
    issue.state = 'closed';
    return wrap('CloseIssuePayload', { issue: issueNode(ctx.store, repo as Repo, issue) });
  }
  if (name === 'createPullRequest') {
    const parsed = parseGlobalId(String(input.repositoryId ?? ''));
    if (parsed === null || parsed.kind !== 'R') throw new FieldError('createPullRequest: unknown repository id');
    const [owner, repoName] = parsed.key.split('/', 2);
    const repo = ctx.store.getRepo(owner as string, repoName as string);
    if (repo === undefined) throw new FieldError('createPullRequest: unknown repository');
    const head = String(input.headRefName ?? '');
    const base = String(input.baseRefName ?? '');
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (headSha === undefined || baseSha === undefined) throw new FieldError('createPullRequest: head or base branch does not exist');
    const number = repo.nextNumber;
    repo.nextNumber += 1;
    const pr: PullRequest = {
      number,
      title: String(input.title ?? ''),
      body: typeof input.body === 'string' ? input.body : '',
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
    return wrap('CreatePullRequestPayload', { pullRequest: pullNode(ctx.store, repo, pr) });
  }
  if (name === 'mergePullRequest') {
    const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
    if (parsed === null || parsed.kind !== 'P') throw new FieldError('mergePullRequest: unknown pull request id');
    const [ownerRepo, numberText] = parsed.key.split(':', 2);
    const [owner, repoName] = (ownerRepo as string).split('/', 2);
    const repo = ctx.store.getRepo(owner as string, repoName as string);
    const pr = repo?.pulls.get(Number(numberText));
    if (pr === undefined || repo === undefined) throw new FieldError('mergePullRequest: unknown pull request');
    const mergeSha = ctx.store.squashMerge(repo, pr, ctx.login);
    if (mergeSha === null) throw new FieldError('mergePullRequest: merge conflict');
    pr.state = 'closed';
    pr.merged = true;
    pr.mergedAt = isoTime(trialNowSec());
    pr.mergeCommitSha = mergeSha;
    return wrap('MergePullRequestPayload', { pullRequest: pullNode(ctx.store, repo, pr) });
  }
  if (name === 'addComment') {
    const parsed = parseGlobalId(String(input.subjectId ?? ''));
    if (parsed === null || parsed.kind !== 'I') throw new FieldError('addComment: unknown subject id');
    const [ownerRepo, numberText] = parsed.key.split(':', 2);
    const [owner, repoName] = (ownerRepo as string).split('/', 2);
    const repo = ctx.store.getRepo(owner as string, repoName as string);
    const issue = repo?.issues.get(Number(numberText));
    if (issue === undefined) throw new FieldError('addComment: unknown issue');
    const comment = { id: ctx.store.nextCommentId, body: String(input.body ?? '') };
    ctx.store.nextCommentId += 1;
    issue.comments.push(comment);
    return wrap('AddCommentPayload', {
      commentEdge: wrap('CommentEdge', {
        node: wrap('Comment', { id: globalId('C', `${repo?.owner}/${repo?.name}:${issue.number}:${comment.id}`), body: comment.body }),
      }),
    });
  }
  throw new FieldError(`Cannot query field "${name}" on type "Mutation".`);
}

function executeSelection(
  ctx: GqlContext,
  typename: string,
  value: AnyRecord,
  selections: SelectionNode[],
  variables: Record<string, unknown>,
): AnyRecord {
  const out: AnyRecord = {};
  for (const selection of selections) {
    if (selection.kind === 'fragment') {
      if (selection.typeCondition !== undefined && selection.typeCondition !== typename) continue;
      Object.assign(out, executeSelection(ctx, typename, value, selection.selection, variables));
      continue;
    }
    const field = selection;
    const resolved = resolveField(ctx, typename, value, field, argsOf(field, variables));
    const key = field.alias ?? field.name;
    if (resolved === null || typeof resolved !== 'object') {
      out[key] = resolved ?? null;
      continue;
    }
    if (Array.isArray(resolved)) {
      out[key] = resolved.map((item) => {
        if (item !== null && typeof item === 'object' && field.selection !== undefined) {
          const itemType = String((item as AnyRecord).__typename ?? '');
          return executeSelection(ctx, itemType, item as AnyRecord, field.selection, variables);
        }
        return item;
      });
      continue;
    }
    const childType = String((resolved as AnyRecord).__typename ?? '');
    if (field.selection === undefined || childType === '') {
      out[key] = resolved;
      continue;
    }
    out[key] = executeSelection(ctx, childType, resolved as AnyRecord, field.selection, variables);
  }
  return out;
}

export interface GraphQLResult {
  data?: Record<string, unknown> | null;
  errors?: { message: string }[];
}

export function executeGraphQL(ctx: GqlContext, query: string, variables: Record<string, unknown>): GraphQLResult {
  let operations: OperationNode[];
  try {
    operations = new Parser(lex(query)).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : 'parse error' }] };
  }
  const operation = operations[0];
  if (operation === undefined) return { data: null, errors: [{ message: 'empty document' }] };
  const mergedVariables: Record<string, unknown> = {};
  for (const variable of operation.variables) {
    if (variables[variable.name] !== undefined) mergedVariables[variable.name] = variables[variable.name];
    else if (variable.defaultValue !== undefined) mergedVariables[variable.name] = resolveValue(variable.defaultValue, variables);
    else mergedVariables[variable.name] = null;
  }
  try {
    const rootType = operation.operation === 'mutation' ? 'Mutation' : 'Query';
    const data = executeSelection(ctx, rootType, wrap(rootType, {}), operation.selection, mergedVariables);
    return { data };
  } catch (err) {
    if (err instanceof FieldError) {
      return { data: null, errors: [{ message: err.message }] };
    }
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
}

export { VIEWER_LOGIN };
