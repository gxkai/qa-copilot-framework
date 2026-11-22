import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer } from "node:net";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";

let server: ChildProcess | undefined;
let targetServer: HttpServer | undefined;
let origin: string;
let targetOrigin: string;
let spawnError: Error | undefined;

before(async () => {
  targetServer = createHttpServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    if (url.pathname === "/redirect-external") {
      response.writeHead(302, { location: "https://example.com/" }).end();
    } else if (url.pathname === "/redirect-local") {
      response.writeHead(302, { location: "/json" }).end();
    } else if (url.pathname === "/page") {
      response.writeHead(200, { "content-type": "text/html" }).end(
        '<input id="email"><button id="submit">Submit</button><p id="message" hidden></p>' +
        '<script>document.querySelector("#submit").addEventListener("click",()=>{' +
        'const message=document.querySelector("#message");message.textContent=document.querySelector("#email").value;' +
        'message.hidden=false;});</script>',
      );
    } else if (url.pathname === "/external-resource") {
      response.writeHead(200, { "content-type": "text/html" }).end(
        '<img src="https://example.com/blocked.png">',
      );
    } else if (url.pathname === "/external-websocket") {
      response.writeHead(200, { "content-type": "text/html" }).end(
        '<script>new WebSocket("wss://example.com/socket");</script>',
      );
    } else if (url.pathname === "/json") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    } else {
      response.writeHead(404).end("Not found");
    }
  });
  targetServer.listen(0, "127.0.0.1");
  await once(targetServer, "listening");
  const targetAddress = targetServer.address();
  assert.ok(targetAddress && typeof targetAddress !== "string");
  targetOrigin = `http://127.0.0.1:${targetAddress.port}`;

  const port = await availablePort();
  origin = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, ["--import", "tsx", "src/server.ts"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      QA_ALLOWED_ORIGINS: origin,
      ...(process.env.QA_BROWSER_CHANNEL ? { QA_BROWSER_CHANNEL: process.env.QA_BROWSER_CHANNEL } : {}),
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
  const fixture = targetServer;
  if (fixture?.listening) {
    await new Promise<void>((resolve, reject) => {
      fixture.close(error => error ? reject(error) : resolve());
    });
  }
});

test("runs browser assertions against the requested page", async () => {
  const passed = await run([{
    name: "Dashboard heading",
    steps: [
      { kind: "navigate", url: origin },
      { kind: "assert", selector: "header h1", assertion: "text:QA Copilot" },
      { kind: "assert", selector: "#run-form", assertion: "visible" },
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

test("executes browser interactions, waits, and returns a screenshot with step details", async () => {
  const result = await run([{
    name: "Browser interaction",
    steps: [
      { kind: "navigate", url: `${targetOrigin}/page` },
      { kind: "type", selector: "#email", text: "hello" },
      { kind: "click", selector: "#submit", text: "Submit" },
      { kind: "assert", selector: "#message", assertion: "text:hello" },
      { kind: "wait", selector: "#message", timeoutMs: 1000 },
      { kind: "screenshot" },
    ],
  }]);

  assert.equal(result.summary.passed, 1);
  assert.ok(result.results[0].steps.every(step => step.status === "passed"));
  assert.ok(result.results[0].steps.every(step => step.durationMs >= 0));
  assert.match(result.results[0].screenshot ?? "", /^data:image\/png;base64,/);
});

test("dashboard submits a natural-language test and renders its live result", async () => {
  const result = await run([{
    name: "Dashboard form",
    steps: [
      { kind: "navigate", url: origin },
      { kind: "type", selector: "#target-url", text: `${targetOrigin}/page` },
      { kind: "type", selector: "#test-steps", text: "verify #email visible" },
      { kind: "click", selector: "#run-test" },
      { kind: "wait", selector: ".run-result h3", timeoutMs: 10000 },
      { kind: "assert", selector: ".run-result h3", assertion: "text:Dashboard test: passed" },
    ],
  }]);

  assert.equal(result.summary.passed, 1);
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

test("follows local HTTP redirects and blocks redirects outside the origin policy", async () => {
  const local = await run([{
    name: "Local redirect",
    steps: [{
      kind: "request",
      method: "GET",
      url: `${targetOrigin}/redirect-local`,
      assertion: "body:ok",
    }],
  }]);
  assert.equal(local.summary.passed, 1);

  const blocked = await run([{
    name: "External redirect",
    steps: [{
      kind: "request",
      method: "GET",
      url: `${targetOrigin}/redirect-external`,
      assertion: "status:200",
    }],
  }]);
  assert.equal(blocked.summary.failed, 1);
  assert.match(blocked.results[0].steps[0].error ?? "", /origin is not allowed/i);
});

test("blocks browser redirects and subresource requests outside the origin policy", async () => {
  for (const path of ["/redirect-external", "/external-resource"]) {
    const result = await run([{
      name: "Blocked browser destination",
      steps: [{ kind: "navigate", url: `${targetOrigin}${path}` }],
    }]);
    assert.equal(result.summary.failed, 1);
    assert.match(result.results[0].steps[0].error ?? "", /blocked browser request/i);
  }
});

test("blocks WebSocket handshakes outside the origin policy and reports the failed step", async () => {
  const result = await run([{
    name: "Blocked WebSocket destination",
    steps: [{ kind: "navigate", url: `${targetOrigin}/external-websocket` }],
  }]);

  assert.equal(result.summary.failed, 1);
  assert.equal(result.results[0].steps[0].status, "failed");
  assert.match(result.results[0].steps[0].error ?? "", /blocked browser websocket/i);
});

test("rejects malformed specs and destinations outside the origin policy", async () => {
  const invalidJSON = await fetch(`${origin}/api/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{",
  });
  assert.equal(invalidJSON.status, 400);
  assert.match((await invalidJSON.json()).error, /invalid JSON/i);

  const malformed = await post({
    specs: [{ name: "Invalid step", steps: [{ kind: "click" }] }],
  });
  assert.equal(malformed.status, 400);
  assert.match((await malformed.json()).error, /selector/i);

  for (const step of [
    { kind: "navigate", url: "https://example.com/" },
    { kind: "request", method: "GET", url: "https://example.com/" },
  ]) {
    const response = await post({ specs: [{ name: "External", steps: [step] }] });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /origin|destination/i);
  }
});

test("rejects empty and partially unparsed natural-language input", async () => {
  for (const steps of ["", "click Submit, do something unknown"]) {
    const response = await fetch(`${origin}/api/nl-to-test`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ steps }),
    });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error, /at least one step|could not parse/i);
  }
});

async function run(specs: unknown[]) {
  const response = await post({ specs });
  assert.equal(response.status, 200);
  return await response.json() as {
    results: Array<{
      status: string;
      steps: Array<{ status: string; durationMs: number; detail?: string; error?: string }>;
      screenshot?: string;
    }>;
    summary: { passed: number; failed: number };
  };
}

async function post(body: unknown) {
  return await fetch(`${origin}/api/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
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
