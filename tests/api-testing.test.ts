import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { after, before, test } from "node:test";
import { assertResponse, executeRequest } from "../src/capabilities/api-testing.ts";
import { createRunPolicy } from "../src/run-policy.ts";

let server: Server;
let origin: string;

before(async () => {
  server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${request.headers.host}`);
    if (url.pathname === "/redirect") {
      response.writeHead(302, { location: "/json" }).end();
    } else if (url.pathname === "/external") {
      response.writeHead(302, { location: "https://example.com/" }).end();
    } else if (url.pathname === "/json") {
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    } else {
      response.writeHead(404).end("Not found");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve());
  });
});

test("returns the live HTTP status and body", async () => {
  const result = await executeRequest({
    kind: "request",
    method: "GET",
    url: `${origin}/missing`,
  }, undefined, createRunPolicy(""));

  assert.equal(result.status, 404);
  assert.equal(result.body, "Not found");
});

test("follows allowed redirects and rejects redirects to unallowed origins", async () => {
  const policy = createRunPolicy("");
  const local = await executeRequest({
    kind: "request",
    method: "GET",
    url: `${origin}/redirect`,
  }, undefined, policy);
  assert.equal(local.status, 200);
  assert.deepEqual(local.body, { ok: true });
  assert.equal(assertResponse(local, "body:ok").pass, true);

  await assert.rejects(executeRequest({
    kind: "request",
    method: "GET",
    url: `${origin}/external`,
  }, undefined, policy), /origin is not allowed/i);
});
