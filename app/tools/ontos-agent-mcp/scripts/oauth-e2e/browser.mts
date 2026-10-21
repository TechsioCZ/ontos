import { mkdirSync } from 'node:fs';

// Structural types so this module does not import playwright directly.

export interface E2eLocator {
  click(options?: { timeout?: number }): Promise<void>;
  first(): E2eLocator;
  count(): Promise<number>;
  waitFor(options?: { timeout?: number }): Promise<void>;
}

export interface E2eApiResponse {
  status(): number;
  text(): Promise<string>;
}

export interface E2ePage {
  goto(url: string, options?: { waitUntil?: 'load' | 'domcontentloaded' }): Promise<unknown>;
  url(): string;
  fill(selector: string, value: string): Promise<void>;
  click(selector: string): Promise<void>;
  getByText(text: string, options?: { exact?: boolean }): E2eLocator;
  getByRole(role: 'button' | 'radio' | 'link', options: { name: string }): E2eLocator;
  waitForURL(url: (url: URL) => boolean, options?: { timeout?: number }): Promise<void>;
  screenshot(options: { path: string; fullPage?: boolean }): Promise<unknown>;
  request: {
    post(url: string, options: { data: unknown; headers?: Record<string, string> }): Promise<E2eApiResponse>;
  };
}

export interface E2eTab {
  readonly page: E2ePage;
  close(): Promise<void>;
}

export const WRITE_MODE_LABEL = {
  read_only: 'Jen čtení',
  approval: 'Navrhovat změny ke schválení',
  direct: 'Provádět změny přímo',
} as const;

export type ActAs = { readonly kind: 'me' } | { readonly kind: 'agent'; readonly agentName: string };

/** Opens one tab on the machine-wide shared headless browser (max 2 sessions; see browser-concurrency-cap). */
export async function openSharedTab(): Promise<E2eTab> {
  // A string-typed variable keeps TypeScript from resolving the untyped .mjs module.
  const clientPath: string = '/Volumes/TraceDecayKingston/techsio-demo/shared-browser/client.mjs';
  const mod = (await import(clientPath)) as { openTab: (options?: object) => Promise<E2eTab> };
  return await mod.openTab({ viewport: { width: 1440, height: 900 } });
}

export async function loginIfNeeded(page: E2ePage, email: string, password: string): Promise<void> {
  if (!new URL(page.url()).pathname.startsWith('/cs/login')) {
    return;
  }
  await page.fill('input[autocomplete="username"]', email);
  await page.fill('input[autocomplete="current-password"]', password);
  await page.click('button[type="submit"]');
}

export async function ensureLoggedIn(page: E2ePage, shellUrl: string, email: string, password: string): Promise<void> {
  await page.goto(`${shellUrl}/cs/login`, { waitUntil: 'domcontentloaded' });
  await loginIfNeeded(page, email, password);
  await page.waitForURL((url) => !url.pathname.startsWith('/cs/login'), { timeout: 30_000 });
}

/** Drives the consent screens (/cs/pripojit) for one authorization URL; ends when the callback redirect lands. */
export async function approveConnection(
  page: E2ePage,
  authorizationUrl: string,
  opts: {
    email: string;
    password: string;
    actAs: ActAs;
    writeMode: keyof typeof WRITE_MODE_LABEL;
    shotsDir: string;
    shotPrefix: string;
  },
): Promise<void> {
  mkdirSync(opts.shotsDir, { recursive: true });
  await page.goto(authorizationUrl, { waitUntil: 'domcontentloaded' });
  await page.waitForURL((u) => u.pathname.startsWith('/cs/login') || u.pathname.startsWith('/cs/pripojit'), {
    timeout: 30_000,
  });
  await loginIfNeeded(page, opts.email, opts.password);
  await page.waitForURL((u) => u.pathname.startsWith('/cs/pripojit') && !u.pathname.includes('souhlas'), {
    timeout: 60_000,
  });
  // The "Za koho bude jednat" picker only renders when the person operates at least one agent; otherwise "Za mě" is implied.
  const acting = page.getByText(opts.actAs.kind === 'me' ? 'Za mě' : `Za agenta ${opts.actAs.agentName}`).first();
  await page.getByRole('button', { name: 'Pokračovat' }).waitFor({ timeout: 30_000 });
  if (opts.actAs.kind === 'agent' || (await acting.count()) > 0) {
    await acting.click();
  }
  // "Jen čtení" is also part of agent names ("AI agent A · jen čtení"), so it must match exactly; the other labels
  // carry suffixes such as "(doporučeno)" and match as substrings.
  await page.getByText(WRITE_MODE_LABEL[opts.writeMode], { exact: opts.writeMode === 'read_only' }).first().click();
  await page.screenshot({ path: `${opts.shotsDir}/${opts.shotPrefix}-1-pripojit.png`, fullPage: true });
  await page.getByRole('button', { name: 'Pokračovat' }).click();
  await page.waitForURL((u) => u.pathname.startsWith('/cs/pripojit/souhlas'), { timeout: 30_000 });
  await page.getByRole('button', { name: 'Povolit přístup' }).waitFor({ timeout: 30_000 });
  await page.screenshot({ path: `${opts.shotsDir}/${opts.shotPrefix}-2-souhlas.png`, fullPage: true });
  await page.getByRole('button', { name: 'Povolit přístup' }).click();
  await page.waitForURL((u) => u.pathname === '/callback', { timeout: 30_000 });
}

/** POSTs JSON to the shell through the shared page's request context (same-origin headers). */
export async function sessionPost(
  page: E2ePage,
  shellUrl: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: unknown; text: string }> {
  const response = await page.request.post(`${shellUrl}${path}`, {
    data: body,
    headers: { 'content-type': 'application/json', origin: shellUrl, ...headers },
  });
  const text = await response.text();
  let json: unknown = undefined;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status(), json, text };
}
