import { chromium, type Browser, type Page } from "playwright";
import type { ApiResponse } from "../capabilities/api-testing.js";
import { assertResponse, executeRequest } from "../capabilities/api-testing.js";
import { isAllowedDestination, resolveDestination, type RunPolicy, type RunRequest } from "../run-policy.js";
import type { StepResult, TestResult, TestSpec, TestStatus, TestStep } from "../types.js";
import { runAfterSpec, runAfterStep, runBeforeSpec } from "../plugins/plugin-registry.js";

/** Run a suite in one Chromium process, isolating every spec in its own context. */
export async function runSuite(request: RunRequest, policy: RunPolicy): Promise<TestResult[]> {
  const browser = await chromium.launch({
    headless: true,
    ...(policy.browserChannel ? { channel: policy.browserChannel } : {}),
  });
  try {
    return await Promise.all(request.specs.map(spec =>
      executeSpec(browser, runBeforeSpec(spec), request, policy),
    ));
  } finally {
    await browser.close();
  }
}

async function executeSpec(
  browser: Browser,
  spec: TestSpec,
  request: RunRequest,
  policy: RunPolicy,
): Promise<TestResult> {
  const startedAt = Date.now();
  const context = await browser.newContext({ serviceWorkers: "block" });
  const page = await context.newPage();
  page.setDefaultTimeout(policy.timeoutMs);

  const blockedRequests: string[] = [];
  await context.route("**/*", async route => {
    const rawURL = route.request().url();
    let url: URL;
    try {
      url = new URL(rawURL);
    } catch {
      blockedRequests.push("Blocked a browser request with an invalid URL");
      await route.abort();
      return;
    }

    if (
      url.protocol === "data:" ||
      url.protocol === "blob:" ||
      url.protocol === "about:" ||
      ((url.protocol === "http:" || url.protocol === "https:") && isAllowedDestination(url, policy))
    ) {
      await route.continue();
      return;
    }

    blockedRequests.push(`Blocked browser request to ${url.origin || url.protocol} because the destination is not allowed`);
    await route.abort();
  });

  const stepResults: StepResult[] = [];
  let status: TestStatus = "passed";
  let screenshot: string | undefined;
  let lastApiResponse: ApiResponse | undefined;

  try {
    for (const step of spec.steps) {
      const stepStartedAt = Date.now();
      let stepStatus: TestStatus = "passed";
      let detail: string | undefined;
      let error: string | undefined;

      try {
        switch (step.kind) {
          case "navigate": {
            const baseURL = currentPageURL(page, request.baseURL);
            const destination = resolveDestination(step.url!, baseURL, policy);
            await page.goto(destination.href, { waitUntil: "load", timeout: policy.timeoutMs });
            detail = `Navigated to ${page.url()}`;
            break;
          }
          case "click": {
            await locatorFor(page, step).click({ timeout: policy.timeoutMs });
            detail = `Clicked ${step.text ?? step.selector}`;
            break;
          }
          case "type": {
            await page.locator(step.selector!).fill(step.text!, { timeout: policy.timeoutMs });
            detail = `Filled ${step.selector}`;
            break;
          }
          case "assert": {
            const assertion = step.assertion ?? "visible";
            if (assertion === "visible" || assertion === "hidden") {
              await page.locator(step.selector!).waitFor({
                state: assertion,
                timeout: policy.timeoutMs,
              });
              detail = `Selector ${step.selector} is ${assertion}`;
            } else if (assertion.startsWith("text:")) {
              const expected = assertion.slice("text:".length);
              const actual = await page.locator(step.selector!).innerText({ timeout: policy.timeoutMs });
              if (!actual.includes(expected)) {
                throw new Error(`Expected ${step.selector} to contain "${expected}", received "${actual}"`);
              }
              detail = `Selector ${step.selector} contains "${expected}"`;
            } else if (assertion.startsWith("status:") || assertion.startsWith("body:")) {
              if (!lastApiResponse) {
                throw new Error(`No prior HTTP response is available for this ${assertion.startsWith("status:") ? "status" : "body"} assertion`);
              }
              const result = assertResponse(lastApiResponse, assertion);
              if (!result.pass) throw new Error(result.detail);
              detail = result.detail;
            }
            break;
          }
          case "request": {
            lastApiResponse = await executeRequest(step, currentPageURL(page, request.baseURL), policy);
            if (step.assertion) {
              const result = assertResponse(lastApiResponse, step.assertion);
              detail = result.detail;
              if (!result.pass) throw new Error(result.detail);
            } else {
              detail = `Received HTTP ${lastApiResponse.status}`;
            }
            break;
          }
          case "wait": {
            if (step.selector) {
              await page.locator(step.selector).waitFor({
                state: "visible",
                timeout: step.timeoutMs ?? policy.timeoutMs,
              });
              detail = `Selector ${step.selector} became visible`;
            } else {
              const timeoutMs = step.timeoutMs ?? 1000;
              await page.waitForTimeout(timeoutMs);
              detail = `Waited ${timeoutMs}ms`;
            }
            break;
          }
          case "screenshot": {
            const image = await page.screenshot({ type: "png" });
            screenshot = `data:image/png;base64,${image.toString("base64")}`;
            detail = "Captured a PNG screenshot";
            break;
          }
        }
      } catch (caught) {
        stepStatus = "failed";
        error = errorMessage(caught);
      }

      if (blockedRequests.length > 0) {
        stepStatus = "failed";
        error = blockedRequests.splice(0).join("; ");
      }

      const result: StepResult = {
        step,
        status: stepStatus,
        durationMs: Date.now() - stepStartedAt,
      };
      if (detail !== undefined) result.detail = detail;
      if (error !== undefined) result.error = error;
      runAfterStep(step, { status: result.status, error: result.error });
      stepResults.push(result);

      if (stepStatus === "failed") {
        status = "failed";
        break;
      }
    }

    if (blockedRequests.length > 0 && status === "passed") {
      const last = stepResults.at(-1);
      if (last) {
        last.status = "failed";
        last.error = blockedRequests.join("; ");
        status = "failed";
      }
    }
  } finally {
    await context.close();
  }

  const result: TestResult = {
    specName: spec.name,
    status,
    durationMs: Date.now() - startedAt,
    steps: stepResults,
    retries: 0,
  };
  if (screenshot !== undefined) result.screenshot = screenshot;
  return runAfterSpec(result);
}

function locatorFor(page: Page, step: TestStep) {
  const isSelector = step.selector && /^(?:#|\.|\[|\/|text=|xpath=)/.test(step.selector);
  if (step.selector && step.text && step.selector === step.text && !isSelector) {
    return page.getByText(step.text, { exact: true });
  }
  if (step.selector) return page.locator(step.selector);
  if (step.text) return page.getByText(step.text, { exact: true });
  throw new Error("Click steps require a selector or text");
}

function currentPageURL(page: Page, baseURL: string | undefined): string | undefined {
  return page.url() === "about:blank" ? baseURL : page.url();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Summarize a suite run. */
export function summarizeSuite(results: TestResult[]): {
  total: number;
  passed: number;
  failed: number;
  flaky: number;
  passRate: number;
  durationMs: number;
} {
  const passed = results.filter(result => result.status === "passed").length;
  const failed = results.filter(result => result.status === "failed").length;
  const flaky = results.filter(result => result.status === "flaky").length;
  return {
    total: results.length,
    passed,
    failed,
    flaky,
    passRate: results.length > 0 ? passed / results.length : 0,
    durationMs: results.reduce((duration, result) => duration + result.durationMs, 0),
  };
}
