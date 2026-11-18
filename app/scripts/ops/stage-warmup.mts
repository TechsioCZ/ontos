#!/usr/bin/env node
/** Real browser login/prefetch, then every declared menu destination. No owner HTML guessing or auth bypass. */
import { NodeRuntime } from '@effect/platform-node';
import { Clock, Config, Console, Duration, Effect, Redacted, Ref, Schema } from 'effect';
import { chromium } from 'playwright-core';
import type { Browser, BrowserContext, Page } from 'playwright-core';

import { warmupAccounts } from '../demo/warmup-accounts.mts';
import {
  declareMenu,
  destinationCounts,
  recordFailure,
  recordVisit,
  StageWarmupIncompleteError,
  warmupGaps,
} from './stage-warmup-coverage.mts';
import type { WarmupCoverage } from './stage-warmup-coverage.mts';
import { checkStageVisibleText, renderedPageText, StageVisibleIdentifierError } from './stage-visible-text.mts';

export class StageWarmupError extends Schema.TaggedError<StageWarmupError>()('StageWarmupError', {
  phase: Schema.String,
}) {}

const STAGE_ORIGIN = 'https://ontos-stage.web-revolution.cz';
/**
 * The gate's wall-clock cap, not its expected cost: the sweep ends when the declared set is covered, so a cap above the
 * measured need costs the deploy nothing and only decides when an incomplete sweep is called a regression.
 *
 * Measured with the personas serialised, the declared set never fitted: 1 of 5 personas covered in 85.6 s (run
 * 43851633176), 2 of 5 in 85.6 s (43818786943), 3 of 5 in 85.5 s (43844672456). Serialisation was not the whole cost -
 * one persona was: obchod@demo.ontos alone took 73.8 s, 70.5 s and 56.2 s for its 38-42 destinations (1.25-1.55 s per
 * destination), while the other four need 6-8 s each for 6 destinations. With the personas concurrent the sweep is
 * therefore bounded by that one persona: 60-85 s expected, once five logins contend for the runner's cores. 150 s is
 * about 1.8x the worst measured persona, which is the headroom that makes failing on an exhausted budget a statement
 * about the stage rather than about the runner. Replace the expectation with the first concurrent run's measured
 * `stage.warmup.complete` durationMs.
 */
export const WARMUP_BUDGET_MS = 150_000;
const AUTH_PREFIX = '/shell-super-app-api/auth/';

/** Warmup reuses reviewed people and blocks business writes regardless of their assigned Role cells. */
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
      // Turns a stuck page into a typed per-persona error. The budget above is the gate's cap, and the five personas
      // now load their shells at the same time, so a per-wait cap tight enough to trip on runner contention would
      // quietly drop a persona out of the declared set instead of reporting a stage defect.
      page.setDefaultTimeout(30_000);
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
      // Login and the menu prefetch measured 5.4-12.1 s per persona while the personas ran one after another; they
      // now run side by side, so this wait is sized for that contention. The budget bounds the sweep.
      await page.waitForFunction(
        () => performance.getEntriesByName('ontos:menu-prefetch-complete').length > 0,
        undefined,
        { timeout: 45_000 },
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
  coverage: Ref.Ref<WarmupCoverage>,
  email: string,
  password: Redacted.Redacted,
) {
  const started = yield* Clock.currentTimeMillis;
  const context = yield* contextEffect(browser);
  const { counts, page, rejected } = yield* preparePage(context);
  const menu = yield* login(page, email, password);
  const prefetchMs = (yield* Clock.currentTimeMillis) - started;
  // This persona's declared set: the menu it was served. It is recorded before the first visit, so an interrupted
  // sweep still reports what the gate was supposed to read.
  const declared = menu.filter((destination) => destination.startsWith('/cs') && !destination.includes('?'));
  yield* Ref.update(coverage, (held) => declareMenu(held, email, declared));
  const destinations = yield* Effect.forEach(
    declared,
    // One page per persona, so this persona's clicks stay sequential; the personas themselves run side by side.
    (destination) =>
      visitDestination(page, destination).pipe(
        Effect.tap(() => Ref.update(coverage, (held) => recordVisit(held, email, destination))),
      ),
    { concurrency: 1 },
  );
  const durationMs = (yield* Clock.currentTimeMillis) - started;
  yield* Console.log('stage.warmup.persona', { ...counts, destinations, durationMs, email, prefetchMs, rejected });
  // A failed response on a page that still rendered and passed is noise the page itself absorbed (a retried read, a
  // prefetch the menu did not need): every destination was read, so it stays a warning.
  if (counts.failures > 0) {
    yield* Console.warn(`::warning title=Stage warm-up::${email} observed ${counts.failures} failed responses`);
  }
  return yield* Effect.void;
});

/** One persona's sweep. A persona that stopped is recorded and the others go on; the coverage decides the verdict. */
const sweepPersona = (
  browser: Browser,
  coverage: Ref.Ref<WarmupCoverage>,
  email: string,
  password: Redacted.Redacted,
) =>
  warmPersona(browser, coverage, email, password).pipe(
    Effect.scoped,
    Effect.catchTag('StageWarmupError', ({ phase }) =>
      Ref.update(coverage, (held) => recordFailure(held, email, phase)).pipe(
        Effect.andThen(Console.warn(`::warning title=Stage warm-up::${phase} did not finish`)),
      ),
    ),
  );

export const stageWarmup = Effect.gen(function* warmStage() {
  const enabled = yield* Config.Boolean('ONTOS_STAGE_WARMUP_ENABLED').pipe(Config.withDefault(true));
  if (!enabled) {
    return yield* Console.log('stage.warmup skipped (disabled for matched fresh-deploy baseline)');
  }
  const started = yield* Clock.currentTimeMillis;
  const password = yield* Config.Redacted('ONTOS_WARMUP_PASSWORD').pipe(
    Config.withDefault(Redacted.make('password1234')),
  );
  const coverage = yield* Ref.make<WarmupCoverage>(new Map());
  const outcome = yield* browserEffect.pipe(
    Effect.flatMap((browser) =>
      Effect.forEach(
        warmupAccounts,
        ({ email }) => sweepPersona(browser, coverage, email, password),
        // Every persona owns its browser context on the one browser, so the sweep costs the slowest persona instead
        // of the sum of all five.
        { concurrency: warmupAccounts.length, discard: true },
      ),
    ),
    Effect.timeout(Duration.millis(WARMUP_BUDGET_MS)),
    Effect.scoped,
    Effect.as('swept' as const),
    Effect.catch((error) => {
      // A visible identifier is a real page defect and fails at once. A browser that never launched and an expired
      // budget end the sweep; the coverage below is their verdict.
      if (Schema.is(StageVisibleIdentifierError)(error)) {
        return Effect.fail(error);
      }
      if (Schema.is(StageWarmupError)(error)) {
        return Console.warn(`::warning title=Stage warm-up::${error.phase} failed`).pipe(Effect.as('swept' as const));
      }
      return Effect.succeed('budget-expired' as const);
    }),
  );
  const covered = yield* Ref.get(coverage);
  const durationMs = (yield* Clock.currentTimeMillis) - started;
  const gaps = warmupGaps(
    warmupAccounts.map(({ email }) => email),
    covered,
  );
  const counts = destinationCounts(covered);
  yield* Console.log('stage.warmup.complete', {
    budgetMs: WARMUP_BUDGET_MS,
    ...counts,
    declaredPersonas: warmupAccounts.length,
    durationMs,
    gaps,
    outcome,
  });
  if (gaps.length > 0) {
    // Completion is judged by what was declared on every exit: a persona that failed fast leaves the same gap as one
    // the budget cut off, and both mean the visible-identifier gate did not read its declared set.
    const ending = outcome === 'budget-expired' ? `the ${WARMUP_BUDGET_MS} ms budget expired` : 'the sweep ended';
    yield* Console.error(
      `::error title=Stage warm-up::${ending} after ${durationMs} ms with ${counts.visitedDestinations}/${counts.declaredDestinations} declared destinations read; unverified: ${gaps.join('; ')}`,
    );
    return yield* new StageWarmupIncompleteError({
      ...counts,
      declaredPersonas: warmupAccounts.length,
      durationMs,
      gaps,
    });
  }
  return yield* Effect.void;
});

if (import.meta.main) {
  NodeRuntime.runMain(stageWarmup);
}
