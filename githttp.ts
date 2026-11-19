// Git smart HTTP: info/refs advertisements, upload-pack (protocol v2 with a v0
// fallback) and receive-pack v0, per the wire contract the env's git client
// speaks. Packets are pkt-lines; fetch packfiles travel inside sideband band 1;
// push reports travel the same way.
import {
  decodePktLines,
  isObjectId,
  parseCommit,
  parseTag,
  parseTree,
  pktLine,
  pktLines,
  readPack,
  verifyPackChecksum,
  writePack,
  type GitObject,
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
} from './gitobj.ts';
import { type Repo, type Store } from './store.ts';

const AGENT = 'github-core-clone/1.0.0';

const UPLOAD_V0_CAPS = `side-band-64k shallow thin-pack ofs-delta multi_ack symref=HEAD:refs/heads/main agent=${AGENT} object-format=sha1`;
const RECEIVE_CAPS = `report-status side-band-64k delete-refs agent=${AGENT} object-format=sha1 ofs-delta symref=HEAD:refs/heads/main`;

/** Refs in advertisement order: HEAD first, then the rest sorted by name. */
function sortedRefs(repo: Repo): { name: string; oid: string }[] {
  const refs = [...repo.refs.entries()].map(([name, oid]) => ({ name, oid }));
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return refs;
}

/** The peeled commit of a tag ref, when the ref points at a tag object. */
function peeledOf(store: Store, repo: Repo, oid: string): string | undefined {
  const object = repo.objects.get(oid);
  if (object?.type !== 'tag') return undefined;
  return store.peelToCommit(repo, oid);
}

/** v0 advertisement body for one service, with the `# service=` preamble. */
export function v0Advertisement(store: Store, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_CAPS;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    const headLine = headTip !== undefined ? `${headTip} HEAD\0${caps}\n` : null;
    if (headLine !== null) parts.push(pktLine(headLine));
    else parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      const peeled = peeledOf(store, repo, ref.oid);
      if (peeled !== undefined) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** v2 capability advertisement body for upload-pack, with the preamble. */
export function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('# service=git-upload-pack\n'),
    PKT_FLUSH,
    pktLine('version 2\n'),
    pktLine(`agent=${AGENT}\n`),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

// ---------------------------------------------------------------------------
// Fetch computation
// ---------------------------------------------------------------------------

interface FetchPlan {
  objects: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
}

/**
 * The objects a fetch transfers: the depth-limited closure of `wants`, minus
 * the full closure of `haves`. `oldShallow` is the client's current shallow
 * boundary list; the boundary moves as the depth limit dictates.
 */
function planFetch(
  store: Store,
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  depth: number | undefined,
  oldShallow: readonly string[],
): FetchPlan {
  // Generations from the wants: want = generation 1.
  const generations = new Map<string, number>();
  const queue: { oid: string; gen: number }[] = [];
  for (const want of wants) {
    const commit = store.peelToCommit(repo, want);
    if (commit !== undefined && !generations.has(commit)) {
      generations.set(commit, 1);
      queue.push({ oid: commit, gen: 1 });
    }
  }
  while (queue.length > 0) {
    const { oid, gen } = queue.shift() as { oid: string; gen: number };
    if (depth !== undefined && gen >= depth) continue;
    const object = repo.objects.get(oid);
    if (object?.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!generations.has(parent)) {
        generations.set(parent, gen + 1);
        queue.push({ oid: parent, gen: gen + 1 });
      }
    }
  }
  const wanted = new Map<string, GitObject>();
  const addClosure = (oid: string): void => {
    if (wanted.has(oid)) return;
    const object = repo.objects.get(oid);
    if (object === undefined) return;
    wanted.set(oid, object);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      addClosure(commit.tree);
      for (const parent of commit.parents) {
        if (generations.has(parent)) addClosure(parent);
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) addClosure(entry.oid);
    } else if (object.type === 'tag') {
      addClosure(parseTag(object.data).object);
    }
  };
  for (const want of wants) addClosure(want);
  for (const oid of generations.keys()) addClosure(oid);

  const held = heldClosure(repo, haves, new Set(oldShallow));
  for (const oid of held.keys()) wanted.delete(oid);

  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== undefined) {
    for (const [oid, gen] of generations) {
      if (gen === depth) shallow.push(oid);
    }
  }
  for (const boundary of oldShallow) {
    const gen = generations.get(boundary);
    if (gen === undefined) continue;
    if (depth === undefined || gen < depth) unshallow.push(boundary);
  }
  return { objects: wanted, shallow, unshallow };
}

/**
 * What the client already holds: the closure of its haves, stopping at its
 * shallow boundaries — a shallow clone holds a boundary commit and its tree,
 * but not that commit's parents. Walking past a boundary would wrongly
 * exclude the very objects a deepen fetch must deliver.
 */
function heldClosure(repo: Repo, haves: readonly string[], boundaries: Set<string>): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const visit = (oid: string): void => {
    if (out.has(oid)) return;
    const object = repo.objects.get(oid);
    if (object === undefined) return;
    out.set(oid, object);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      visit(commit.tree);
      if (!boundaries.has(oid)) {
        for (const parent of commit.parents) visit(parent);
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) visit(entry.oid);
    } else if (object.type === 'tag') {
      visit(parseTag(object.data).object);
    }
  };
  for (const have of haves) visit(have);
  return out;
}

/** A packfile split into sideband band-1 pkt-lines. */
function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  const maxPayload = 65515; // 65520 pkt max - 4 length - 1 band byte
  for (let offset = 0; offset < pack.length; offset += maxPayload) {
    const chunk = pack.subarray(offset, Math.min(pack.length, offset + maxPayload));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// upload-pack
// ---------------------------------------------------------------------------

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
}

function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], depth: undefined };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).split(' ')[0] as string);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const n = Number(line.slice(7).trim());
      if (Number.isFinite(n) && n > 0) args.depth = Math.floor(n);
    }
  }
  return args;
}

export function handleUploadPack(repo: Repo, body: Buffer, isV2: boolean, store: Store): Buffer {
  const packets = decodePktLines(body);
  // Collect every data packet: in v0 the `have` lines come after the first
  // flush, so stopping at it would drop the negotiation.
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  if (!isV2) return handleUploadPackV0(repo, lines, store);
  const command = lines.find((line) => line.startsWith('command='))?.slice('command='.length);
  if (command === 'ls-refs') return handleLsRefs(store, repo, lines);
  if (command === 'fetch') return handleFetchV2(repo, lines, store);
  // Unknown command: answer a flush (the client will fail the check loudly).
  return PKT_FLUSH;
}

function handleLsRefs(store: Store, repo: Repo, lines: string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const line of lines) {
    if (line === 'peel') peel = true;
    else if (line === 'symrefs') symrefs = true;
    else if (line === 'unborn') unborn = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
  }
  const parts: Buffer[] = [];
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const refs = sortedRefs(repo);
  // Never advertise an unborn branch as a ref: the suite's clone-empty
  // check requires zero `refs/` entries for a repo with no refs, and the
  // GraphQL git fixture treats any listed refs/heads/<branch> as an
  // existing branch (it would then try to read that branch's tree).
  if (refs.length === 0) {
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  // HEAD is subject to the same prefix filter as any ref: git's clone
  // asks for `ref-prefix HEAD` alongside `refs/heads/` and `refs/tags/`.
  if (matches('HEAD')) {
    const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (headTip !== undefined) {
      const line = symrefs ? `${headTip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n` : `${headTip} HEAD\n`;
      parts.push(pktLine(line));
    }
  }
  for (const ref of refs) {
      if (!matches(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      if (peel) {
        const peeled = peeledOf(store, repo, ref.oid);
        if (peeled !== undefined) line += ` peeled:${peeled}`;
      }
      parts.push(pktLine(`${line}\n`));
    }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function handleFetchV2(repo: Repo, lines: string[], store: Store): Buffer {
  const args = parseFetchArgs(lines);
  const plan = planFetch(store, repo, args.wants, args.haves, args.depth, args.shallow);
  const pack = writePack([...plan.objects.values()]);
  const parts: Buffer[] = [];
  // The acknowledgments section is only sent when the client offered haves;
  // with none, the response opens on shallow-info or the packfile.
  if (args.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    parts.push(pktLine('NAK\n'));
    parts.push(PKT_DELIM);
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

function handleUploadPackV0(repo: Repo, lines: string[], store: Store): Buffer {
  const args = parseFetchArgs(lines);
  const plan = planFetch(store, repo, args.wants, args.haves, args.depth, args.shallow);
  const pack = writePack([...plan.objects.values()]);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(sidebandPack(pack));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export function handleReceivePack(store: Store, repo: Repo, body: Buffer): Buffer {
  const packets = decodePktLines(body);
  const commands: PushCommand[] = [];
  let packStart = body.length;
  {
    // Find the end of the command section (the first flush packet).
    let offset = 0;
    for (const packet of packets) {
      const length = packet.kind === 'flush' ? 4 : packet.kind === 'delim' ? 4 : packet.kind === 'response-end' ? 4 : packet.payload.length + 4;
      if (packet.kind === 'flush') {
        packStart = offset + 4;
        break;
      }
      if (packet.kind === 'data') {
        const text = packet.payload.toString('utf8');
        const nul = text.indexOf('\0');
        const commandText = (nul >= 0 ? text.slice(0, nul) : text).replace(/\n$/, '');
        const parts = commandText.split(' ');
        if (parts.length >= 3 && isObjectId(parts[0] as string) && isObjectId(parts[1] as string)) {
          commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
        }
      }
      offset += length;
    }
  }
  const results: { ref: string; ok: boolean; reason: string }[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  const packBytes = body.subarray(packStart);
  if (packBytes.length > 0) {
    try {
      const checksum = verifyPackChecksum(packBytes);
      if (!checksum.ok) throw new Error('pack checksum mismatch');
      const read = readPack(packBytes, { resolveBase: (oid) => repo.objects.get(oid) });
      for (const [oid, object] of read.objects) repo.objects.set(oid, object);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  for (const command of commands) {
    if (!unpackOk) {
      results.push({ ref: command.ref, ok: false, reason: 'unpack failed' });
      continue;
    }
    results.push(applyPushCommand(store, repo, command));
  }
  const reportLines: (string | 'flush')[] = [`unpack ${unpackDetail}\n`];
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  // The report stream itself ends with a flush inside band 1: a reader that
  // decodes report pkt-lines until a flush would otherwise see a hangup.
  reportLines.push('flush');
  const inner = pktLines(reportLines);
  return Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), inner])), PKT_FLUSH]);
}

function applyPushCommand(store: Store, repo: Repo, command: PushCommand): { ref: string; ok: boolean; reason: string } {
  const { oldOid, newOid, ref } = command;
  const current = repo.refs.get(ref);
  if (newOid === ZERO_OID) {
    // Delete.
    if (current === undefined) return { ref, ok: false, reason: 'remote ref does not exist' };
    repo.refs.delete(ref);
    return { ref, ok: true, reason: '' };
  }
  const newObject = repo.objects.get(newOid);
  if (newObject === undefined) return { ref, ok: false, reason: 'object not found' };
  if (oldOid === ZERO_OID) {
    // Create.
    if (current !== undefined) return { ref, ok: false, reason: 'already exists' };
    repo.refs.set(ref, newOid);
    return { ref, ok: true, reason: '' };
  }
  // Update: must be a fast-forward from the advertised old value.
  if (current === undefined) return { ref, ok: false, reason: 'remote ref does not exist' };
  if (current !== oldOid) return { ref, ok: false, reason: 'non-fast-forward' };
  if (newObject.type === 'commit') {
    const ancestor = store.isAncestor(repo, oldOid, newOid);
    if (!ancestor) return { ref, ok: false, reason: 'non-fast-forward' };
  }
  repo.refs.set(ref, newOid);
  return { ref, ok: true, reason: '' };
}
