import assert from "node:assert/strict";
import { test } from "node:test";
import { createRunPolicy, isAllowedDestination, parseRunRequest, resolveDestination } from "../src/run-policy.ts";

test("allows loopback HTTP(S) destinations but blocks other hosts by default", () => {
  const policy = createRunPolicy("");

  assert.equal(isAllowedDestination(new URL("http://127.0.0.1:4304"), policy), true);
  assert.equal(isAllowedDestination(new URL("https://localhost:9000"), policy), true);
  assert.equal(isAllowedDestination(new URL("http://[::1]:8080"), policy), true);
  assert.equal(isAllowedDestination(new URL("https://example.com"), policy), false);
  assert.equal(isAllowedDestination(new URL("http://user:password@127.0.0.1"), policy), false);
  assert.throws(() => resolveDestination("file:///etc/passwd", undefined, policy), /HTTP or HTTPS/);
  assert.throws(() => resolveDestination("http://user:password@127.0.0.1", undefined, policy), /credentials/);
});

test("configured origins match the exact normalized origin", () => {
  const policy = createRunPolicy("https://qa.example:8443/");

  assert.equal(isAllowedDestination(new URL("https://qa.example:8443/path"), policy), true);
  assert.equal(isAllowedDestination(new URL("https://qa.example:9443/path"), policy), false);
  assert.equal(isAllowedDestination(new URL("http://qa.example:8443/path"), policy), false);
  assert.throws(() => createRunPolicy("https://qa.example/path"), /exact HTTP\(S\) origins/);
});

test("uses a supported optional Playwright browser channel", () => {
  const previous = process.env.QA_BROWSER_CHANNEL;
  process.env.QA_BROWSER_CHANNEL = "chrome";
  try {
    assert.equal(createRunPolicy("").browserChannel, "chrome");
    process.env.QA_BROWSER_CHANNEL = "not-a-browser";
    assert.throws(() => createRunPolicy(""), /Unsupported QA_BROWSER_CHANNEL/);
  } finally {
    if (previous === undefined) delete process.env.QA_BROWSER_CHANNEL;
    else process.env.QA_BROWSER_CHANNEL = previous;
  }
});

test("parses a typed request and rejects unsupported step payloads", () => {
  const policy = createRunPolicy("");
  const parsed = parseRunRequest({
    baseURL: "http://127.0.0.1:4304",
    specs: [{ name: "home", steps: [{ kind: "navigate", url: "/" }, { kind: "assert", selector: "h1", assertion: "text:QA Copilot" }] }],
  }, policy);

  assert.equal(parsed.baseURL, "http://127.0.0.1:4304/");
  assert.equal(parsed.specs[0].steps[0].kind, "navigate");
  assert.throws(() => parseRunRequest({
    specs: [{ name: "unknown", steps: [{ kind: "execute-shell" }] }],
  }, policy), /not a supported test step/);
  assert.throws(() => parseRunRequest({
    specs: [{ name: "invalid assertion", steps: [{ kind: "request", method: "GET", url: "http://127.0.0.1/", assertion: "visible" }] }],
  }, policy), /status:<code> or body:<key>/);
});
