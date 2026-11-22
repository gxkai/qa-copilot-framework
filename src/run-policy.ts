import { isIP } from "node:net";
import type { TestSpec, TestStep } from "./types.js";

export interface RunRequest {
  specs: TestSpec[];
  baseURL?: string;
}

export interface RunPolicy {
  allowedOrigins: ReadonlySet<string>;
  timeoutMs: number;
  browserChannel?: BrowserChannel;
}

export type BrowserChannel = "chromium" | "chrome" | "chrome-beta" | "msedge" | "msedge-beta" | "msedge-dev";

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_SPECS = 25;
const MAX_STEPS_PER_SPEC = 100;
const STEP_KINDS = ["navigate", "click", "type", "assert", "screenshot", "request", "wait"] as const;
const HTTP_METHODS = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;
const BROWSER_CHANNELS: readonly BrowserChannel[] = [
  "chromium",
  "chrome",
  "chrome-beta",
  "msedge",
  "msedge-beta",
  "msedge-dev",
];

export function createRunPolicy(allowedOrigins = process.env.QA_ALLOWED_ORIGINS ?? ""): RunPolicy {
  const parsedOrigins = allowedOrigins.split(",").map(value => value.trim()).filter(Boolean);
  const policy: RunPolicy = {
    allowedOrigins: new Set(parsedOrigins.map(parseAllowedOrigin)),
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  const browserChannel = process.env.QA_BROWSER_CHANNEL?.trim();
  if (browserChannel) {
    const channel = BROWSER_CHANNELS.find(candidate => candidate === browserChannel);
    if (!channel) {
      throw new Error(`Unsupported QA_BROWSER_CHANNEL: ${browserChannel}`);
    }
    policy.browserChannel = channel;
  }
  return policy;
}

export function parseRunRequest(value: unknown, policy: RunPolicy): RunRequest {
  const request = asRecord(value, "request");
  if (!Array.isArray(request.specs) || request.specs.length === 0 || request.specs.length > MAX_SPECS) {
    throw new Error(`specs must contain between 1 and ${MAX_SPECS} test specs`);
  }

  let baseURL: string | undefined;
  if (request.baseURL !== undefined) {
    if (typeof request.baseURL !== "string" || !request.baseURL.trim()) {
      throw new Error("baseURL must be a non-empty HTTP(S) URL");
    }
    baseURL = resolveDestination(request.baseURL, undefined, policy).href;
  }

  const specs = request.specs.map((value, specIndex) => {
    const rawSpec = asRecord(value, `specs[${specIndex}]`);
    const name = requiredString(rawSpec.name, `specs[${specIndex}].name`);
    if (!Array.isArray(rawSpec.steps) || rawSpec.steps.length === 0 || rawSpec.steps.length > MAX_STEPS_PER_SPEC) {
      throw new Error(`specs[${specIndex}].steps must contain between 1 and ${MAX_STEPS_PER_SPEC} steps`);
    }

    let currentBaseURL = baseURL;
    const steps = rawSpec.steps.map((value, stepIndex) => {
      const step = parseStep(value, `specs[${specIndex}].steps[${stepIndex}]`, policy);
      if (step.kind === "navigate" || step.kind === "request") {
        const url = resolveDestination(step.url!, currentBaseURL, policy);
        if (step.kind === "navigate") currentBaseURL = url.href;
      }
      return step;
    });

    const spec: TestSpec = { name, steps };
    if (rawSpec.tags !== undefined) {
      if (!Array.isArray(rawSpec.tags) || !rawSpec.tags.every(tag => typeof tag === "string")) {
        throw new Error(`specs[${specIndex}].tags must be an array of strings`);
      }
      spec.tags = rawSpec.tags;
    }
    if (rawSpec.framework !== undefined) {
      if (typeof rawSpec.framework !== "string") throw new Error(`specs[${specIndex}].framework must be a string`);
      spec.framework = rawSpec.framework;
    }
    return spec;
  });

  return baseURL === undefined ? { specs } : { specs, baseURL };
}

export function resolveDestination(rawURL: string, baseURL: string | undefined, policy: RunPolicy): URL {
  let url: URL;
  try {
    url = new URL(rawURL, baseURL);
  } catch {
    throw new Error("Destination must be an absolute URL or have an HTTP(S) baseURL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Destination must use HTTP or HTTPS");
  }
  if (url.username || url.password) {
    throw new Error("Destination URLs must not contain credentials");
  }
  if (!isAllowedDestination(url, policy)) {
    throw new Error(`Destination origin is not allowed: ${url.origin}`);
  }
  return url;
}

export function isAllowedDestination(url: URL, policy: RunPolicy): boolean {
  return (
    (url.protocol === "http:" || url.protocol === "https:") &&
    !url.username &&
    !url.password &&
    (isLoopbackHost(url.hostname) || policy.allowedOrigins.has(url.origin))
  );
}

function parseAllowedOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Invalid QA_ALLOWED_ORIGINS entry; expected an HTTP(S) origin");
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error("QA_ALLOWED_ORIGINS entries must be exact HTTP(S) origins");
  }
  return url.origin;
}

function parseStep(value: unknown, label: string, policy: RunPolicy): TestStep {
  const rawStep = asRecord(value, label);
  if (typeof rawStep.kind !== "string" || !STEP_KINDS.includes(rawStep.kind as typeof STEP_KINDS[number])) {
    throw new Error(`${label}.kind is not a supported test step`);
  }
  const kind = rawStep.kind as TestStep["kind"];
  const step: TestStep = { kind };

  if (rawStep.selector !== undefined) step.selector = requiredString(rawStep.selector, `${label}.selector`);
  if (rawStep.text !== undefined) step.text = requiredString(rawStep.text, `${label}.text`);
  if (rawStep.url !== undefined) step.url = requiredString(rawStep.url, `${label}.url`);
  if (rawStep.method !== undefined) step.method = requiredString(rawStep.method, `${label}.method`).toUpperCase();
  if (rawStep.body !== undefined) step.body = rawStep.body;
  if (rawStep.assertion !== undefined) step.assertion = requiredString(rawStep.assertion, `${label}.assertion`);

  switch (kind) {
    case "navigate":
      if (!step.url) throw new Error(`${label}.url is required`);
      break;
    case "click":
      if (!step.selector && !step.text) throw new Error(`${label} requires a selector or text`);
      break;
    case "type":
      if (!step.selector) throw new Error(`${label}.selector is required for type steps`);
      if (step.text === undefined) throw new Error(`${label}.text is required for type steps`);
      break;
    case "assert":
      validateAssertion(step, label);
      break;
    case "request":
      if (!step.url) throw new Error(`${label}.url is required`);
      if (!step.method || !HTTP_METHODS.includes(step.method as typeof HTTP_METHODS[number])) {
        throw new Error(`${label}.method must be one of ${HTTP_METHODS.join(", ")}`);
      }
      if (step.assertion !== undefined && !isRequestAssertion(step.assertion)) {
        throw new Error(`${label}.assertion must be status:<code> or body:<key>`);
      }
      if ((step.method === "GET" || step.method === "HEAD") && step.body !== undefined) {
        throw new Error(`${label}.body is not allowed for ${step.method}`);
      }
      break;
    case "wait":
      if (step.selector === undefined && rawStep.timeoutMs === undefined) {
        step.timeoutMs = 1000;
      }
      if (rawStep.timeoutMs !== undefined) {
        const timeoutMs = rawStep.timeoutMs;
        if (
          typeof timeoutMs !== "number" ||
          !Number.isInteger(timeoutMs) ||
          timeoutMs < 0 ||
          timeoutMs > policy.timeoutMs
        ) {
          throw new Error(`${label}.timeoutMs must be between 0 and ${policy.timeoutMs}`);
        }
        step.timeoutMs = timeoutMs;
      }
      break;
    case "screenshot":
      break;
  }

  return step;
}

function validateAssertion(step: TestStep, label: string): void {
  const assertion = step.assertion ?? "visible";
  if (assertion === "visible" || assertion === "hidden") {
    if (!step.selector) throw new Error(`${label}.selector is required for ${assertion} assertions`);
    return;
  }
  if (assertion.startsWith("text:")) {
    if (!step.selector || assertion.length === "text:".length) {
      throw new Error(`${label} text assertions require a selector and expected text`);
    }
    return;
  }
  if (/^status:\d{3}$/.test(assertion) && Number(assertion.slice(7)) >= 100 && Number(assertion.slice(7)) <= 599) return;
  if (assertion.startsWith("body:") && assertion.length > "body:".length) return;
  throw new Error(`${label}.assertion must be visible, hidden, text:<value>, status:<code>, or body:<key>`);
}

function isRequestAssertion(assertion: string): boolean {
  if (/^status:\d{3}$/.test(assertion)) {
    const status = Number(assertion.slice("status:".length));
    return status >= 100 && status <= 599;
  }
  return assertion.startsWith("body:") && assertion.length > "body:".length;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function isLoopbackHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  return isIP(host) === 4 && Number(host.split(".")[0]) === 127;
}
