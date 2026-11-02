#!/usr/bin/env node
/** Real browser login/prefetch, then every declared menu destination. No owner HTML guessing or auth bypass. */
import { NodeRuntime } from '@effect/platform-node';
import { Clock, Config, Console, Effect, Redacted, Schema } from 'effect';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';

import { warmupAccounts } from '../demo/warmup-accounts.mts';
import { checkStageVisibleText, renderedPageText, StageVisibleIdentifierError } from './stage-visible-text.mts';

export class StageWarmupError extends Schema.TaggedError<StageWarmupError>()('StageWarmupError', {
  phase: Schema.String,
}) {}

const STAGE_ORIGIN = 'https://ontos-stage.web-revolution.cz';
export const WARMUP_BUDGET_MS = 85_000;
const AUTH_PREFIX = '/shell-super-app-api/auth/';

/** Browser-level defence in addition to the seed's absent Action/write grants. */
export const warmupRequestAllowed = (method: string, url: string) => {
  const parsed = URL.parse(url);
  if (parsed?.origin !== STAGE_ORIGIN) {
    return false;
  }
  if (method === 'GET' || method === 'HEAD') {
    return true;
  }
  if (method !== 'POST') {
    return false;
  }
  const { pathname } = parsed;
  return (
    [
      `${AUTH_PREFIX}sign-in`,
      `${AUTH_PREFIX}sign-out`,
      `${AUTH_PREFIX}gateway-context`,
      `${AUTH_PREFIX}gateway-contexts`,
      `${AUTH_PREFIX}identity/demo-accounts/capability`,
      '/shell-super-app-api/shell/module-target',
      '/shell-super-app-api/shell/module-targets',
      '/shell-super-app-api/agent-platform/queue',
      '/shell-super-app-api/agent-platform/activity',
    ].includes(pathname) ||
    /^\/shell-super-app-api\/(?:module-api\/[^/]+\/[a-f0-9]+\/[^/]+|core)\/reads\/[^/]+$/u.test(pathname)
  );
};

const browserEffect = Effect.acquireRelease(
  Effect.tryPromise({
    catch: () => new StageWarmupError({ phase: 'browser-launch' }),
    try: async () => await chromium.launch({ headless: true }),
  }),
  (browser) =>
    Effect.tryPromise({
      catch: () => new StageWarmupError({ phase: 'browser-close' }),
      try: async () => await browser.close(),
    }).pipe(
      Effect.tapError(() => Console.warn('::warning title=Stage warm-up::Browser cleanup failed')),
      Effect.ignore,
    ),
);

const closeContext = (context: BrowserContext) =>
  Effect.gen(function* releaseSession() {
    yield* Effect.tryPromise({
      catch: () => new StageWarmupError({ phase: 'sign-out' }),
      try: async () =>
        await context.request.post(`${STAGE_ORIGIN}${AUTH_PREFIX}sign-out`, {
          headers: { origin: STAGE_ORIGIN },
          timeout: 3000,
        }),
    }).pipe(Effect.ignore);
    yield* Effect.tryPromise({
      catch: () => new StageWarmupError({ phase: 'context-close' }),
      try: async () => await context.close(),
    }).pipe(
      Effect.tapError(() => Console.warn('::warning title=Stage warm-up::Context cleanup failed')),
      Effect.ignore,
    );
  });

const contextEffect = (browser: Browser) =>
  Effect.acquireRelease(
    Effect.tryPromise({
      catch: () => new StageWarmupError({ phase: 'browser-context' }),
      try: async () => await browser.newContext({ locale: 'cs-CZ', viewport: { height: 900, width: 1440 } }),
    }),
    closeContext,
  );

const preparePage = (context: BrowserContext) =>
  Effect.tryPromise({
    catch: () => new StageWarmupError({ phase: 'prepare-page' }),
    try: async () => {
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      const counts = { assets: 0, blocked: 0, failures: 0, reads: 0 };
      const rejected: { method: string; path: string; status: number | 'blocked' }[] = [];
      await context.route('**/*', async (route) => {
        const request = route.request();
        if (warmupRequestAllowed(request.method(), request.url())) {
          await route.continue();
        } else {
          counts.blocked += 1;
          if (rejected.length < 20) {
            rejected.push({ method: request.method(), path: new URL(request.url()).pathname, status: 'blocked' });
          }
          await route.abort('blockedbyclient');
        }
      });
      page.on('response', (response) => {
        const { pathname } = new URL(response.url());
        counts.reads += pathname.includes('/reads/') ? 1 : 0;
        counts.assets += pathname.startsWith('/_m/') ? 1 : 0;
        counts.failures += response.status() >= 400 ? 1 : 0;
        if (response.status() >= 400 && rejected.length < 20) {
          rejected.push({ method: response.request().method(), path: pathname, status: response.status() });
        }
      });
      return { counts, page, rejected };
    },
  });

const login = (page: Page, email: string, password: Redacted.Redacted) =>
  Effect.tryPromise({
    catch: () => new StageWarmupError({ phase: `login:${email}` }),
    try: async () => {
      await page.goto(`${STAGE_ORIGIN}/cs/login`, { waitUntil: 'domcontentloaded' });
      await page.locator('form[data-hydrated]').waitFor();
      await page.locator('#login').fill(email);
      await page.locator('#password').fill(Redacted.value(password));
      await page.locator('button[type=submit]').click();
      await page.waitForURL((url) => !url.pathname.endsWith('/login'));
      await page.waitForFunction(
        () => performance.getEntriesByName('ontos:menu-prefetch-complete').length > 0,
        undefined,
        { timeout: 25_000 },
      );
      return await page
        .locator('nav a[href^="/cs"], aside a[href^="/cs"]')
        .evaluateAll((links) => [...new Set(links.map((link) => link.getAttribute('href') ?? ''))]);
    },
  });

const visitDestination = (page: Page, destination: string) =>
  Effect.tryPromise({
    catch: () => new StageWarmupError({ phase: `destination:${destination}` }),
    try: async () => {
      if (new URL(page.url()).pathname !== destination) {
        await page.evaluate(() => performance.clearMarks('ontos:visible-reads-complete'));
        await page.locator(`a[href="${destination}"]`).first().click();
        await page.waitForURL((url) => url.pathname === destination);
        await page.waitForFunction(() => performance.getEntriesByName('ontos:visible-reads-complete').length > 0);
      }
      await page.locator('main').waitFor({ state: 'visible' });
      return { destination, text: await page.evaluate(renderedPageText) };
    },
  }).pipe(
    Effect.tap(({ destination: path, text }) => checkStageVisibleText(path, text)),
    Effect.map(({ destination: path }) => path),
  );

const warmPersona = Effect.fn('Stage.warmPersona')(function* warmPersona(
  browser: Browser,
  email: string,
  password: Redacted.Redacted,
) {
  const started = yield* Clock.currentTimeMillis;
  const context = yield* contextEffect(browser);
  const { counts, page, rejected } = yield* preparePage(context);
  const menu = yield* login(page, email, password);
  const prefetchMs = (yield* Clock.currentTimeMillis) - started;
  const destinations = yield* Effect.forEach(
    menu.filter((destination) => destination.startsWith('/cs') && !destination.includes('?')),
    (destination) => visitDestination(page, destination),
    { concurrency: 1 },
  );
  const durationMs = (yield* Clock.currentTimeMillis) - started;
  yield* Console.log('stage.warmup.persona', { ...counts, destinations, durationMs, email, prefetchMs, rejected });
  if (counts.failures > 0) {
    yield* Console.warn(`::warning title=Stage warm-up::${email} observed ${counts.failures} failed responses`);
  }
  return yield* Effect.void;
});

export const stageWarmup = Effect.gen(function* warmStage() {
  const enabled = yield* Config.Boolean('ONTOS_STAGE_WARMUP_ENABLED').pipe(Config.withDefault(true));
  if (!enabled) {
    return yield* Console.log('stage.warmup skipped (disabled for matched fresh-deploy baseline)');
  }
  const started = yield* Clock.currentTimeMillis;
  const password = yield* Config.Redacted('ONTOS_WARMUP_PASSWORD').pipe(
    Config.withDefault(Redacted.make('password1234')),
  );
  yield* browserEffect.pipe(
    Effect.flatMap((browser) =>
      Effect.forEach(
        warmupAccounts,
        ({ email }) =>
          warmPersona(browser, email, password).pipe(
            Effect.scoped,
            Effect.catchTag('StageWarmupError', (error) =>
              Console.warn(
                `::warning title=Stage warm-up::${error.phase} did not finish; native verification still runs`,
              ),
            ),
          ),
        { concurrency: 1, discard: true },
      ),
    ),
    Effect.timeout('85 seconds'),
    Effect.scoped,
    Effect.catch((error) =>
      Schema.is(StageVisibleIdentifierError)(error)
        ? Effect.fail(error)
        : Console.warn(
            Schema.is(StageWarmupError)(error)
              ? `::warning title=Stage warm-up::${error.phase} unavailable; native verification still runs`
              : '::warning title=Stage warm-up::Warm-up budget exhausted; native verification still runs',
          ),
    ),
  );
  const durationMs = (yield* Clock.currentTimeMillis) - started;
  return yield* Console.log('stage.warmup.complete', { budgetMs: WARMUP_BUDGET_MS, durationMs });
});

if (import.meta.main) {
  NodeRuntime.runMain(stageWarmup);
}
