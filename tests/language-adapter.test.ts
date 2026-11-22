import assert from "node:assert/strict";
import { test } from "node:test";
import { generateCode } from "../src/languages/language-adapter.ts";

test("generates Python request code with a lowercase HTTP method", () => {
  const code = generateCode({
    name: "Users API",
    steps: [{ kind: "request", method: "GET", url: "http://127.0.0.1:4304/api/users" }],
  }, "python");

  assert.match(code, /page\.request\.get\("http:\/\/127\.0\.0\.1:4304\/api\/users"\)/);
});
