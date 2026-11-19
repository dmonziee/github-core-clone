// The git object model, packfiles and pkt-lines, implemented from scratch on the
// standard library only. No git binary, no network.
import { createHash } from 'node:crypto';
import { deflateSync as zlibDeflate, inflateSync as zlibInflate } from 'node:zlib';
const sha1 = (data: Buffer): string => createHash('sha1').update(data).digest('hex');

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

export function isObjectId(value: string): boolean {
  return /^[0-9a-f]{40}$/.test(value);
}

/** The id of `<type> <size>\0<data>`. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1(Buffer.concat([header, data]));
}

export function makeObject(type: ObjectType, data: Buffer): { oid: string; object: GitObject } {
  return { oid: hashObject(type, data), object: { type, data } };
}

// ---------------------------------------------------------------------------
// Commits, trees, tags
// ---------------------------------------------------------------------------

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string; // "Name <email> ts +0000"
  committer: string;
  message: string;
  authorTime: number;
  committerTime: number;
}

export function parseCommit(data: Buffer): CommitInfo {
  const cached = commitParseCache.get(data);
  if (cached !== undefined) return cached;
  const info = parseCommitUncached(data);
  commitParseCache.set(data, info);
  return info;
}

/** Objects are immutable once stored, so parsed forms are safe to cache by buffer. */
const commitParseCache = new WeakMap<Buffer, CommitInfo>();
const treeParseCache = new WeakMap<Buffer, TreeEntry[]>();
const tagParseCache = new WeakMap<Buffer, TagInfo>();

function parseCommitUncached(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  let authorTime = 0;
  let committerTime = 0;
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) {
      author = line.slice(7);
      const m = / (\d+) [+-]\d{4}$/.exec(author);
      if (m) authorTime = Number(m[1]);
    } else if (line.startsWith('committer ')) {
      committer = line.slice(10);
      const m = / (\d+) [+-]\d{4}$/.exec(committer);
      if (m) committerTime = Number(m[1]);
    }
  }
  return { tree, parents, author, committer, message, authorTime, committerTime };
}

export function buildCommit(info: {
  tree: string;
  parents: readonly string[];
  author: string;
  committer: string;
  message: string;
}): Buffer {
  const lines: string[] = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  const message = info.message.endsWith('\n') ? info.message : `${info.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

export function identityLine(name: string, email: string, timeSec: number): string {
  return `${name} <${email}> ${timeSec} +0000`;
}

export interface TreeEntry {
  mode: string; // e.g. "100644", "40000"
  name: string;
  oid: string;
}

/** Parse a tree object's binary entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const cached = treeParseCache.get(data);
  if (cached !== undefined) return cached;
  const entries = parseTreeUncached(data);
  treeParseCache.set(data, entries);
  return entries;
}

function parseTreeUncached(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space + 1);
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git tree sort: entries ordered by name, directories compared as if ending in '/'. */
export function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface TagInfo {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function parseTag(data: Buffer): TagInfo {
  const cached = tagParseCache.get(data);
  if (cached !== undefined) return cached;
  const info = parseTagUncached(data);
  tagParseCache.set(data, info);
  return info;
}

function parseTagUncached(data: Buffer): TagInfo {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

export function buildTag(info: { object: string; type: string; tag: string; tagger: string; message: string }): Buffer {
  const message = info.message.endsWith('\n') ? info.message : `${info.message}\n`;
  return Buffer.from(
    `object ${info.object}\ntype ${info.type}\ntag ${info.tag}\ntagger ${info.tagger}\n\n${message}`,
    'utf8',
  );
}

// ---------------------------------------------------------------------------
// Pkt-lines
// ---------------------------------------------------------------------------

/** Encode one data packet; the payload usually ends in '\n'. */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export function pktLines(payloads: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const payload of payloads) {
    if (payload === 'flush') parts.push(PKT_FLUSH);
    else if (payload === 'delim') parts.push(PKT_DELIM);
    else parts.push(pktLine(payload));
  }
  return Buffer.concat(parts);
}

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface Pkt {
  kind: PktKind;
  payload: Buffer;
}

/** Decode a whole buffer of pkt-lines (no streaming). */
export function decodePktLines(buffer: Buffer): Pkt[] {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const length = parseInt(buffer.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(length)) break;
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
    } else {
      packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return packets;
}

/** Incremental pkt-line decoder for streaming request bodies. */
export class PktLineDecoder {
  #buffer = Buffer.alloc(0);
  push(chunk: Buffer): void {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
  }
  next(): Pkt | null {
    if (this.#buffer.length < 4) return null;
    const length = parseInt(this.#buffer.subarray(0, 4).toString('ascii'), 16);
    if (Number.isNaN(length)) throw new Error('bad pkt-line length');
    if (length === 0) {
      this.#buffer = this.#buffer.subarray(4);
      return { kind: 'flush', payload: Buffer.alloc(0) };
    }
    if (length === 1) {
      this.#buffer = this.#buffer.subarray(4);
      return { kind: 'delim', payload: Buffer.alloc(0) };
    }
    if (length === 2) {
      this.#buffer = this.#buffer.subarray(4);
      return { kind: 'response-end', payload: Buffer.alloc(0) };
    }
    if (this.#buffer.length < length) return null;
    const payload = this.#buffer.subarray(4, length);
    this.#buffer = this.#buffer.subarray(length);
    return { kind: 'data', payload };
  }
  /** Bytes not yet consumed (raw pack bytes after the final flush). */
  rest(): Buffer {
    return this.#buffer;
  }
}

// ---------------------------------------------------------------------------
// Packfiles
// ---------------------------------------------------------------------------

const PACK_TYPES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const PACK_TYPE_IDS: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Write a version-2 pack of plain (undeltified) objects. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    const typeId = PACK_TYPE_IDS[object.type];
    const size = object.data.length;
    // Varint header: low 4 bits of size in the first byte, then 7 bits per byte.
    const headerBytes: number[] = [];
    let remaining = size;
    let first = (typeId << 4) | (remaining & 0x0f);
    remaining >>>= 4;
    if (remaining > 0) first |= 0x80;
    headerBytes.push(first);
    while (remaining > 0) {
      let byte = remaining & 0x7f;
      remaining >>>= 7;
      if (remaining > 0) byte |= 0x80;
      headerBytes.push(byte);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(zlibDeflate(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(sha1(body), 'hex');
  return Buffer.concat([body, trailer]);
}

/** Verify a pack trailer; returns the recomputed checksum. */
export function verifyPackChecksum(pack: Buffer): { ok: boolean; expected: string; actual: string } {
  const expected = pack.subarray(pack.length - 20).toString('hex');
  const actual = sha1(pack.subarray(0, pack.length - 20));
  return { ok: expected === actual, expected, actual };
}

interface PackEntry {
  type: number;
  size: number;
  data: Buffer;
  offset: number;
  baseOffset?: number;
  baseOid?: string;
  isDelta: boolean;
}

/** Read one zlib stream starting at `offset`; returns the data and bytes consumed. */
function inflateAt(buffer: Buffer, offset: number): { data: Buffer; consumed: number } {
  // One inflate: inflateSync ignores trailing bytes, and with {info: true} the
  // engine reports exactly how many input bytes the stream consumed, so no
  // binary search over the length is needed. (The old code retried inflateSync
  // ~log2(n) times per object, and every failed attempt built an Error with a
  // stack trace — the profile showed error construction alone cost ~10% of
  // push CPU.) A truncated stream still throws, as before.
  const result = zlibInflate(buffer.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, consumed: result.engine.bytesWritten };
}

function readVarint(buffer: Buffer, offset: number): { value: number; next: number } {
  let value = buffer[offset] & 0x7f;
  let shift = 7;
  let pos = offset + 1;
  while (buffer[pos - 1] & 0x80) {
    value |= (buffer[pos] & 0x7f) << shift;
    shift += 7;
    pos += 1;
  }
  return { value, next: pos };
}

/** Apply a git delta to a base object, returning the result bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const sourceSize = readVarint(delta, pos);
  pos = sourceSize.next;
  if (sourceSize.value !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint(delta, pos);
  pos = targetSize.next;
  const parts: Buffer[] = [];
  let produced = 0;
  while (pos < delta.length) {
    const opcode = delta[pos];
    pos += 1;
    if (opcode & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i += 1) {
        if (opcode & (1 << i)) {
          offset |= delta[pos] << (8 * i);
          pos += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (opcode & (0x10 << i)) {
          size |= delta[pos] << (8 * i);
          pos += 1;
        }
      }
      if (size === 0) size = 0x10000;
      parts.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (opcode !== 0) {
      parts.push(delta.subarray(pos, pos + opcode));
      produced += opcode;
      pos += opcode;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (produced !== targetSize.value) throw new Error('delta target size mismatch');
  return Buffer.concat(parts);
}

export interface ReadPackResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/**
 * Read a packfile (v2/v3), resolving OFS_DELTA and REF_DELTA. `resolveBase`
 * supplies objects the pack references but does not carry (a thin pack's bases,
 * which the server already holds).
 */
export function readPack(
  pack: Buffer,
  options: { resolveBase?: (oid: string) => GitObject | undefined } = {},
): ReadPackResult {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const count = pack.readUInt32BE(8);
  const entries: PackEntry[] = [];
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, PackEntry>();
  let offset = 12;
  let deltaCount = 0;
  for (let i = 0; i < count; i += 1) {
    const entryOffset = offset;
    let byte = pack[offset];
    offset += 1;
    const type = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset];
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const entry: PackEntry = { type, size, data: Buffer.alloc(0), offset: entryOffset, isDelta: false };
    if (type === 6) {
      // OFS_DELTA: negative offset to the base object.
      byte = pack[offset];
      offset += 1;
      let baseOffset = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset];
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
      }
      entry.baseOffset = entryOffset - baseOffset;
      entry.isDelta = true;
      deltaCount += 1;
    } else if (type === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      entry.isDelta = true;
      deltaCount += 1;
    }
    const inflated = inflateAt(pack, offset);
    if (inflated.data.length !== size) throw new Error('inflated size mismatch');
    entry.data = inflated.data;
    offset += inflated.consumed;
    entries.push(entry);
    byOffset.set(entryOffset, entry);
  }

  const resolve = (entry: PackEntry, seen: Set<number>): GitObject => {
    if (!entry.isDelta) {
      const type = PACK_TYPES[entry.type];
      if (type === undefined) throw new Error(`unknown pack object type ${entry.type}`);
      return { type, data: entry.data };
    }
    let base: GitObject;
    if (entry.baseOffset !== undefined) {
      if (seen.has(entry.baseOffset)) throw new Error('delta cycle');
      const baseEntry = byOffset.get(entry.baseOffset);
      if (baseEntry === undefined) throw new Error('ofs-delta base missing');
      seen.add(entry.baseOffset);
      base = resolve(baseEntry, seen);
    } else if (entry.baseOid !== undefined) {
      const held = options.resolveBase?.(entry.baseOid);
      if (held !== undefined) {
        base = held;
      } else {
        const baseEntry = entries.find((candidate) => hashObject(PACK_TYPES[candidate.type] ?? 'blob', candidate.data) === entry.baseOid);
        if (baseEntry === undefined) throw new Error(`ref-delta base ${entry.baseOid} missing`);
        base = resolve(baseEntry, seen);
      }
    } else {
      throw new Error('delta without a base');
    }
    return { type: base.type, data: applyDelta(base.data, entry.data) };
  };

  for (const entry of entries) {
    const object = resolve(entry, new Set([entry.offset]));
    objects.set(hashObject(object.type, object.data), object);
  }
  return { objects, deltaCount };
}
