// Boot the forge and hand control to the harness.
//
// The harness owns the run. It tells us where it lives through
// MAKEFUN_ENV_URL, and we talk to it in two steps:
//   1. POST <env>/register  with { port } so it can reach this server.
//   2. GET  <env>/done      again and again until it answers { done: true }.
// We stay up until that second answer arrives; exiting early would cut the
// run short, so the process only ends after the harness says so.

import { createApp } from "./app.ts";

const FIRST_RETRY_MS = 250;
const MAX_RETRY_MS = 2000;
const REQUEST_TIMEOUT_MS = 30_000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Read the harness address, dropping any trailing slashes. Bail out right
// away when it is missing: without it there is nothing to register with.
function harnessBase(): string {
  const raw = process.env.MAKEFUN_ENV_URL;
  if (!raw) {
    console.error("MAKEFUN_ENV_URL is not set");
    process.exit(1);
  }
  return raw.replace(/\/+$/, "");
}

interface CallResult {
  status: number;
  body: unknown;
}

// One JSON request against the harness, giving up after 30 seconds. A
// response whose body is not JSON is fine; callers only look at the status
// and, for /done, at the parsed body when there is one.
async function callHarness(url: string, init: RequestInit): Promise<CallResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // Leave body null; not every harness answer carries JSON.
    }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

// Tell the harness which port the forge is listening on. 200 means the
// registration landed and 409 means it was already recorded, so either one
// counts as done. 400 and 405 mean our request itself is wrong and no
// amount of retrying will fix it, so those are fatal. Anything else, or a
// request that fails outright, is worth another try after a growing pause.
async function registerPort(base: string, port: number): Promise<void> {
  let delay = FIRST_RETRY_MS;
  for (;;) {
    let result: CallResult;
    try {
      result = await callHarness(`${base}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port }),
      });
    } catch (error) {
      console.error(`register failed: ${error}`);
      await wait(delay);
      delay = Math.min(delay * 2, MAX_RETRY_MS);
      continue;
    }
    if (result.status === 200 || result.status === 409) {
      console.log(`registered port ${port}`);
      return;
    }
    if (result.status === 400 || result.status === 405) {
      throw new Error(`register rejected with HTTP ${result.status}`);
    }
    console.error(`register got HTTP ${result.status}, retrying`);
    await wait(delay);
    delay = Math.min(delay * 2, MAX_RETRY_MS);
  }
}

// Keep asking the harness whether the run is over. Only an answer of
// { done: true } on a 200 lets us stop; every other outcome, including a
// failed request, just means we ask again a little later.
async function waitForDone(base: string): Promise<void> {
  let delay = FIRST_RETRY_MS;
  for (;;) {
    let result: CallResult;
    try {
      result = await callHarness(`${base}/done`, { method: "GET" });
    } catch (error) {
      console.error(`done check failed: ${error}`);
      await wait(delay);
      delay = Math.min(delay * 2, MAX_RETRY_MS);
      continue;
    }
    const body = result.body as { done?: unknown } | null;
    if (result.status === 200 && body !== null && body.done === true) {
      console.log("harness signalled done");
      return;
    }
    await wait(delay);
    delay = Math.min(delay * 2, MAX_RETRY_MS);
  }
}

async function main(): Promise<void> {
  const base = harnessBase();
  const server = createApp();

  // Bind an ephemeral port: the harness only ever talks to the port we
  // report, so a fixed port would only risk colliding with something else.
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, () => resolve());
  });
  const bound = server.address();
  if (!bound || typeof bound === "string") {
    throw new Error("server did not bind to a TCP port");
  }
  console.log(`listening on port ${bound.port}`);

  try {
    await registerPort(base, bound.port);
    await waitForDone(base);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

main().catch((error: unknown) => {
  console.error(`fatal: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
