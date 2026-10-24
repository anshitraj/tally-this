import { expect, type Locator, type Page } from "@playwright/test";

export const PASSWORD = "Test-passw0rd-1";

let counter = 0;
/** A new address for every account, so tests never meet each other's data and can be run again on the same database. */
export function uniqueEmail(label: string): string {
  counter += 1;
  return `${label}-${Date.now().toString(36)}-${counter}@example.test`;
}

export interface Account {
  email: string;
  name: string;
  firm: string;
}

export function newAccount(label: string, overrides: Partial<Account> = {}): Account {
  return { email: uniqueEmail(label), name: "Anita Rao", firm: "Rao & Co", ...overrides };
}

/**
 * What a person would be bothered by while using a page: errors in the console, scripts that crash and API calls the
 * server refused. `ignore` lists the ones a test causes on purpose (a wrong password answers 401, and the browser
 * logs that in the console too).
 */
export function watchProblems(page: Page, ignore: RegExp[] = []) {
  const problems: string[] = [];
  const add = (text: string) => {
    if (!ignore.some(pattern => pattern.test(text))) problems.push(text);
  };
  page.on("console", message => {
    if (message.type() === "error") add(`console: ${message.text()}`);
  });
  page.on("pageerror", error => add(`page error: ${error.message}`));
  page.on("response", response => {
    const url = new URL(response.url());
    if (response.status() >= 400 && url.pathname.startsWith("/api/")) add(`${response.status()} ${response.request().method()} ${url.pathname}`);
  });
  return {
    problems,
    expectNone() {
      expect(problems, `problems seen while using the page:\n${problems.join("\n")}`).toEqual([]);
    },
  };
}

/** Makes an account through the sign-up page (the local stack has no Neon, so this is the older form) and waits for setup. */
export async function signUp(page: Page, account: Account) {
  await page.goto("/login?mode=signup");
  await page.locator("#name").fill(account.name);
  await page.locator("#company").fill(account.firm);
  await page.locator("#email").fill(account.email);
  await page.locator("#password").fill(PASSWORD);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
}

/** Setup the quick way: one client, then straight home. */
export async function setUpWorkspace(page: Page, clientName = "Test Client") {
  await page.locator("#client-name").fill(clientName);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "What do you want to do first?" })).toBeVisible();
  await page.getByRole("button", { name: /take me home/i }).click();
  await expect(page).toHaveURL(/\/app\/overview$/);
}

/** A signed-in account with one client, sitting on the home page. */
export async function signedUpAccount(page: Page, label: string, clientName = "Test Client") {
  const account = newAccount(label);
  await signUp(page, account);
  await setUpWorkspace(page, clientName);
  return account;
}

export async function sessionToken(page: Page): Promise<string> {
  const token = await page.evaluate(() => {
    try {
      return JSON.parse(localStorage.getItem("finverify_auth") || "{}").token as string | undefined;
    } catch {
      return undefined;
    }
  });
  if (!token) throw new Error("not signed in");
  return token;
}

/** Calls the API as the signed-in person, the way the page does. */
export async function api(page: Page, method: "GET" | "POST" | "PATCH" | "DELETE", path: string, options: { body?: unknown; headers?: Record<string, string> } = {}) {
  const token = await sessionToken(page);
  const response = await page.request.fetch(path, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}), ...options.headers },
    data: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    // not JSON
  }
  return { status: response.status(), json, text };
}

/**
 * The text of a headline number once it has stopped changing. The big counts on a result start at 0 and count up, so a
 * check that passes on the first matching frame can pass on a number that is still on its way to a different final value.
 */
export async function settledText(locator: Locator, quietMs = 700): Promise<string> {
  let last = "";
  let changedAt = Date.now();
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const text = ((await locator.first().textContent({ timeout: 5_000 }).catch(() => null)) ?? "").trim();
    if (text !== last) {
      last = text;
      changedAt = Date.now();
    } else if (text !== "" && Date.now() - changedAt >= quietMs) {
      return text;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  return last;
}

/** The count above a label such as "matched" or "need attention", read once it has settled. */
export function statValue(page: Page, label: string): Promise<string> {
  return settledText(page.getByText(label, { exact: true }).locator("xpath=preceding-sibling::*[1]"));
}

/** The page has no sideways scroll: nothing is cut off on a narrow screen. */
export async function expectNoSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  expect(overflow, "the page is wider than the screen").toBeLessThanOrEqual(2);
}
