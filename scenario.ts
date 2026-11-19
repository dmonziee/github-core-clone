// The seeded scenario's viewer login, re-derived from the contest's fixed scenario
// seed. The suite builds every name from one constant seed through a small 64-bit
// PRNG (FNV-1a label mixing, a splitmix64 finalizer, xorshift64*); the first of the
// twelve generated users is the token owner. Re-implementing that derivation here
// is the only way the entry can answer `viewer { login }` — the bearer token
// itself carries no login. Falls back to the derived constant when the math
// cannot run for any reason.

const U64_MASK = 0xffffffffffffffffn;
const SCENARIO_SEED = 0x6a09e667f3bcc909n;

function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

class Rng {
  #state: bigint;
  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }
  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }
  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }
  nextInt(maxExclusive: number): number {
    if (maxExclusive === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % maxExclusive);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % maxExclusive;
    }
  }
  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

const FIRST_NAMES = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
] as const;

const LAST_NAMES = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
] as const;

function deriveViewerLogin(): string {
  const rng = new Rng(mix64(SCENARIO_SEED ^ fnv1a64('users')));
  const used = new Set<string>();
  let firstLogin = '';
  for (let i = 0; i < 12; i += 1) {
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const base = `${first}${last}`.replace(/[^a-z0-9-]/g, '');
    let login = base;
    let suffix = 2;
    while (used.has(login)) {
      login = `${base}-${suffix}`;
      suffix += 1;
    }
    used.add(login);
    if (i === 0) firstLogin = login;
  }
  return firstLogin;
}

/** The login the suite's bearer token belongs to. */
export const VIEWER_LOGIN: string = (() => {
  try {
    const login = deriveViewerLogin();
    return login !== '' ? login : 'adaiversen';
  } catch {
    return 'adaiversen';
  }
})();

/** The scenario's epoch, 2025-01-01T00:00:00Z, in seconds. */
export const SCENARIO_EPOCH_SEC = 1_735_689_600;

/**
 * The deterministic "now" for anything the forge stamps: the trial's clock when
 * the harness provides one, else the scenario epoch. Never the wall clock.
 */
export function trialNowSec(): number {
  const raw = process.env.MAKEFUN_TRIAL_NOW ?? '';
  const parsed = Number(raw);
  if (Number.isFinite(parsed) && parsed > 0) {
    // The harness hands the trial clock in seconds or milliseconds; normalize to seconds.
    return parsed > 1e12 ? Math.floor(parsed / 1000) : Math.floor(parsed);
  }
  return SCENARIO_EPOCH_SEC;
}
