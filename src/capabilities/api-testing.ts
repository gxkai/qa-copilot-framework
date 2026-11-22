import type { RunPolicy } from "../run-policy.js";
import { resolveDestination } from "../run-policy.js";
import type { TestStep } from "../types.js";

export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  durationMs: number;
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 5;

export async function executeRequest(
  step: TestStep,
  baseURL: string | undefined,
  policy: RunPolicy,
): Promise<ApiResponse> {
  const startedAt = Date.now();
  let url = resolveDestination(step.url!, baseURL, policy);
  let method = step.method!.toUpperCase();
  let body = step.body === undefined ? undefined : serializeBody(step.body);
  const headers: Record<string, string> = {};

  if (body !== undefined && typeof step.body !== "string") {
    headers["content-type"] = "application/json";
  }

  for (let redirectCount = 0; ; redirectCount++) {
    const response = await fetch(url, {
      method,
      headers,
      body: method === "GET" || method === "HEAD" ? undefined : body,
      redirect: "manual",
      signal: AbortSignal.timeout(policy.timeoutMs),
    });

    const location = response.headers.get("location");
    if (!REDIRECT_STATUSES.has(response.status) || !location) {
      const responseBody = await readBody(response);
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers.entries()),
        body: responseBody,
        durationMs: Date.now() - startedAt,
      };
    }

    if (redirectCount >= MAX_REDIRECTS) {
      throw new Error(`Request exceeded the limit of ${MAX_REDIRECTS} redirects`);
    }

    await response.body?.cancel();
    url = resolveDestination(location, url.href, policy);
    if (
      response.status === 303 ||
      ((response.status === 301 || response.status === 302) && method !== "GET" && method !== "HEAD")
    ) {
      method = "GET";
      body = undefined;
      delete headers["content-type"];
    }
  }
}

function serializeBody(body: unknown): string {
  if (typeof body === "string") return body;
  const serialized = JSON.stringify(body);
  if (serialized === undefined) throw new Error("Request body must be JSON serializable");
  return serialized;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return "";
  if (response.headers.get("content-type")?.includes("json")) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return text;
}

/** Assert on an API response. */
export function assertResponse(response: ApiResponse, assertion: string): { pass: boolean; detail: string } {
  if (assertion.startsWith("status:")) {
    const expected = Number(assertion.slice("status:".length));
    return response.status === expected
      ? { pass: true, detail: `status ${response.status} === ${expected}` }
      : { pass: false, detail: `status ${response.status} !== ${expected}` };
  }
  if (assertion.startsWith("body:")) {
    const key = assertion.slice("body:".length);
    return response.body && typeof response.body === "object" && key in response.body
      ? { pass: true, detail: `body has key "${key}"` }
      : { pass: false, detail: `body missing key "${key}"` };
  }
  return { pass: false, detail: `Unsupported response assertion: ${assertion}` };
}
