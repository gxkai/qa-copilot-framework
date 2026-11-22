import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

let server: ChildProcess | undefined;
let origin: string;
let spawnError: Error | undefined;

before(async () => {
  const port = await availablePort();
  origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      QA_ALLOWED_ORIGINS: origin,
    },
    stdio: "ignore",
  });
  server.once("error", error => {
    spawnError = error;
  });
  await waitForServer();
});

after(async () => {
  const child = server;
  if (child && child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([once(child, "exit"), delay(3_000)]);
  }
});

test("runs browser assertions against the requested page", async () => {
  const passed = await run([{
    name: "Dashboard heading",
    steps: [
      { kind: "navigate", url: origin },
      { kind: "assert", selector: "header h1", assertion: "text:QA Copilot" },
    ],
  }]);
  assert.equal(passed.summary.passed, 1);
  assert.equal(passed.results[0].steps[1].status, "passed");

  const failed = await run([{
    name: "Missing element",
    steps: [
      { kind: "navigate", url: origin },
      { kind: "assert", selector: "#does-not-exist", assertion: "visible" },
    ],
  }]);
  assert.equal(failed.summary.failed, 1);
  assert.equal(failed.results[0].status, "failed");
  assert.ok(failed.results[0].steps[1].error);
});

test("request steps use the live HTTP response", async () => {
  const result = await run([{
    name: "Missing API route",
    steps: [{
      kind: "request",
      method: "GET",
      url: `${origin}/route-that-does-not-exist`,
      assertion: "status:404",
    }],
  }]);
  assert.equal(result.summary.passed, 1);
});

async function run(specs: unknown[]) {
  const response = await fetch(`${origin}/api/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ specs }),
  });
  assert.equal(response.status, 200);
  return await response.json() as {
    results: Array<{
      status: string;
      steps: Array<{ status: string; error?: string }>;
    }>;
    summary: { passed: number; failed: number };
  };
}

async function availablePort(): Promise<number> {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const address = listener.address();
  assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => {
    listener.close(error => error ? reject(error) : resolve());
  });
  return address.port;
}

async function waitForServer(): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 50; attempt++) {
    if (spawnError) {
      throw new Error("Test server could not start", { cause: spawnError });
    }
    if (!server || server.exitCode !== null) {
      throw new Error(`Test server exited with code ${server?.exitCode}`);
    }
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) return;
      lastError = new Error(`Health endpoint returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await delay(100);
  }
  throw new Error("Test server did not become ready", { cause: lastError });
}
