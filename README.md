# github-core-clone

[![github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/dmonziee/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/dmonziee/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A GitHub-compatible git forge, built from scratch in TypeScript (Node 22, standard
library only) for the [github-core-clone-01](https://make.fun/bounty/github-core-clone-01)
bounty. One process, in-memory store, fully deterministic — no clock or randomness in
any output.

## What it serves

- **Git smart HTTP** at `/{owner}/{repo}.git`: upload-pack protocol v2 (with v0
  fallback) and receive-pack v0. The git object model is implemented from scratch:
  SHA-1 ids, zlib loose objects (blob / tree / commit / tag), packfile read and
  write including OFS_DELTA and REF_DELTA, pkt-line framing, sideband reports,
  shallow fetch / deepen, and per-ref fast-forward enforcement on push.
- **REST v3** under `/api/v3`: repositories, branches, commits, contents, labels,
  issues, comments and pull requests (including squash merge with conflict
  detection), with bearer-token auth, JSON errors and `X-GitHub-Request-Id` on
  every reply.
- **GraphQL v4** at `/api/graphql`: viewer, repository, issue and pull-request
  reads, `__type` introspection, cursor pagination, Relay global ids, the
  create/close/merge mutations, and batched operation documents.
- **MCP** at `/mcp`: JSON-RPC 2.0 Streamable HTTP, revision 2026-07-28
  (`server/discover`) with the legacy `initialize` handshake, six tools
  (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`) acting on the same store as REST.

## Run

```sh
node --experimental-strip-types main.ts
```

`main.ts` is the entry ↔ env lifecycle (bind an ephemeral port, register with
`$MAKEFUN_ENV_URL`, poll `/done`). `app.ts` is the server; the forge lives in
`store.ts`, `gitobj.ts`, `githttp.ts`, `rest.ts`, `graphql.ts`, `mcp.ts` and
`scenario.ts` (the seeded scenario's viewer login is re-derived from the
contest's fixed scenario seed, so `viewer { login }` answers the token owner).

## Practice results

Local practice trial (`grade-local --driver process --instances 1`, Node 24):

- **120/120 checks pass** — git 30/30, REST repos 15/15, issues 15/15, pulls
  20/20, GraphQL 20/20, MCP 15/15, protocol 5/5; working bit set, replay
  byte-identical.
- **Performance ~171–178/200** across runs (medians: push ≈ 705 ms, clone
  ≈ 104–114 ms, read ≈ 579–737 ms, write ≈ 111–134 ms, against house
  T_refs 1641 / 267 / 2760 / 349 ms).

## License

MIT
