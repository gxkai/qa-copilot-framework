// src/server.ts — QA Copilot Framework: full API + dashboard
import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { FRAMEWORK_CONFIG } from "./config.js";
import { parseTest, describeSpec } from "./ai/nl-to-test.js";
import { healSelector } from "./ai/self-healer.js";
import type { DomElement } from "./ai/self-healer.js";
import { generateCode } from "./languages/language-adapter.js";
import { runSuite, summarizeSuite } from "./core/runner.js";
import { createRunPolicy, parseRunRequest, type RunRequest } from "./run-policy.js";
import type { TestSpec } from "./types.js";
import { list, register, clear } from "./plugins/plugin-registry.js";
import { collectMetrics, formatPerfReport } from "./capabilities/performance.js";
import { runA11yChecks, getRules } from "./capabilities/accessibility.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: "2mb" }));
const startedAt = Date.now();
const runPolicy = createRunPolicy();

// Register some demo plugins
register({ name: "@qa-copilot/playwright", version: "1.0.0", capabilities: ["ui", "visual", "a11y"] });
register({ name: "@qa-copilot/api", version: "1.0.0", capabilities: ["api"] });
register({ name: "@qa-copilot/perf", version: "1.0.0", capabilities: ["performance"] });

app.get("/health", (_q,r) => r.json({ ok: true, version: FRAMEWORK_CONFIG.version, uptime: Math.round((Date.now()-startedAt)/1000) }));

app.get("/api/status", (_q,r) => {
  r.json({
    ok: true,
    stars: FRAMEWORK_CONFIG.stars,
    healedToday: FRAMEWORK_CONFIG.healedToday,
    languages: FRAMEWORK_CONFIG.languages,
    plugins: list().map(p => ({ name: p.name, version: p.version, capabilities: p.capabilities })),
    capabilities: ["self-heal", "nl-steps", "record-replay", "visual", "api", "perf", "a11y", "multi-lang"],
  });
});

app.post("/api/nl-to-test", (req,r) => {
  const body = req.body;
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return r.status(400).json({ error: "A request object with steps is required" });
  }
  const name = "name" in body ? body.name : "AI Test";
  if (typeof name !== "string" || !name.trim()) return r.status(400).json({ error: "name must be a non-empty string" });
  if (!("steps" in body) || typeof body.steps !== "string") {
    return r.status(400).json({ error: "steps must be a natural-language string" });
  }
  try {
    const spec = parseTest(name, body.steps);
    r.json({ spec, description: describeSpec(spec) });
  } catch (error) {
    r.status(400).json({ error: formatError(error) });
  }
});

app.post("/api/self-heal", (req,r) => {
  const { selector, dom } = req.body || {};
  if (!selector || !Array.isArray(dom)) return r.status(400).json({ error: "selector + dom array required" });
  const result = healSelector(selector, dom as DomElement[]);
  r.json({ result });
});

app.post("/api/generate-code", (req,r) => {
  const { spec, language = "typescript" } = req.body || {};
  if (!spec) return r.status(400).json({ error: "spec required" });
  const code = generateCode(spec as TestSpec, language);
  r.json({ code, language });
});

app.post("/api/run", async (req,r) => {
  let request: RunRequest;
  try {
    request = parseRunRequest(req.body, runPolicy);
  } catch (error) {
    return r.status(400).json({ error: formatError(error) });
  }
  try {
    const results = await runSuite(request, runPolicy);
    r.json({ results, summary: summarizeSuite(results) });
  } catch (error) {
    r.status(500).json({ error: formatError(error) });
  }
});

app.get("/api/perf", (_q,r) => {
  const metrics = collectMetrics();
  r.json({ metrics, report: formatPerfReport(metrics) });
});

app.post("/api/a11y", (req,r) => {
  const { elements = [] } = req.body || {};
  const result = runA11yChecks(elements);
  r.json(result);
});

app.get("/api/a11y/rules", (_q,r) => r.json({ rules: getRules() }));
app.get("/api/plugins", (_q,r) => r.json({ plugins: list() }));

app.use(express.static(path.join(__dirname, "../public")));
app.get("/", (_q,r) => r.sendFile(path.join(__dirname, "../public/index.html")));
app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const status = typeof error === "object" && error !== null && "status" in error
    ? Number(error.status)
    : 500;
  if (status === 400) return res.status(400).json({ error: "Invalid JSON request body" });
  if (status === 413) return res.status(413).json({ error: "JSON request body exceeds the 2 MB limit" });
  return res.status(500).json({ error: "Internal server error" });
});

function formatError(error: unknown): string {
  if (error instanceof Error) return error.message || error.name || "Unknown error";
  if (typeof error === "string") return error || "Unknown error";
  if (typeof error === "object" && error !== null && "message" in error) {
    try {
      const message = error.message;
      if (typeof message === "string" && message) return message;
    } catch {
      // Fall back to serializing the unknown error.
    }
  }
  try {
    const serialized = JSON.stringify(error);
    if (serialized !== undefined) return serialized;
  } catch {
    // Fall back to string conversion for cyclic or non-serializable values.
  }
  try {
    return String(error);
  } catch {
    return "Unknown error";
  }
}

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? FRAMEWORK_CONFIG.defaultPort);
app.listen(port, host, () =>
  console.log(`qa-copilot-framework → http://${host}:${port}`));
