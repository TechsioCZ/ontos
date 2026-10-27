import type {
  Browser as NativeBrowser,
  BrowserContext as NativeBrowserContext,
  BrowserContextOptions as NativeBrowserContextOptions,
  BrowserType,
  Page,
} from 'playwright-core';
import { Cause, Config, Effect, Exit, FileSystem, Option, Predicate, Redacted, Schema } from 'effect';

// Native browser capabilities stay owned by the pinned Playwright SDK.
export type E2ePage = Pick<
  Page,
  'click' | 'fill' | 'getByRole' | 'getByText' | 'goto' | 'screenshot' | 'url' | 'waitForURL'
> & {
  readonly request: Pick<Page['request'], 'post'>;
};

export class BrowserDriverFailure extends Schema.TaggedError<BrowserDriverFailure>()('BrowserDriverFailure', {
  cause: Schema.Defect(),
  operation: Schema.String,
}) {}

/** The owned handle exposes Effect cleanup; only the foreign tab has a Promise close method. */
export interface E2eTab {
  readonly close: Effect.Effect<void, BrowserDriverFailure>;
  readonly page: E2ePage;
}

type BrowserContextOptions = Pick<NativeBrowserContextOptions, 'viewport'>;
type BrowserContext = Pick<NativeBrowserContext, 'close' | 'newPage'>;
type Browser = Pick<NativeBrowser, 'close' | 'newContext'>;
type Launcher = Pick<BrowserType, 'launch'>;

// The external managed bridge has no published declaration. Its page, options and close
// capabilities come from the SDK; only this bridge-specific entrypoint is declared here.
type ForeignTab = Pick<NativeBrowserContext, 'close'> & { readonly page: E2ePage };
interface SharedClient {
  readonly openTab: (options: BrowserContextOptions) => Promise<ForeignTab>;
}

const LauncherSchema = Schema.Struct({
  launch: Schema.declare<Launcher['launch']>((value): value is Launcher['launch'] => Predicate.isFunction(value)),
});
const SharedClientSchema = Schema.Struct({
  openTab: Schema.declare<SharedClient['openTab']>((value): value is SharedClient['openTab'] =>
    Predicate.isFunction(value),
  ),
});
const BrowserModuleSchema = Schema.Struct({
  chromium: Schema.optionalKey(LauncherSchema),
  default: Schema.optionalKey(Schema.Struct({ chromium: LauncherSchema })),
});

const ownedTab = (page: E2ePage, cleanup: Effect.Effect<void, BrowserDriverFailure>): E2eTab => {
  let closed = false;
  return {
    close: Effect.uninterruptible(
      Effect.suspend(() => {
        if (closed) {
          return Effect.void;
        }
        closed = true;
        return cleanup;
      }),
    ),
    page,
  };
};

const closeContextAndBrowser = (context: BrowserContext, browser: Browser) =>
  Effect.gen(function* closeBrowser() {
    const contextExit = yield* Effect.exit(
      Effect.tryPromise({
        catch: (cause) => new BrowserDriverFailure({ cause, operation: 'context.close' }),
        try: async () => await context.close(),
      }),
    );
    const browserExit = yield* Effect.exit(
      Effect.tryPromise({
        catch: (cause) => new BrowserDriverFailure({ cause, operation: 'browser.close' }),
        try: async () => await browser.close(),
      }),
    );
    if (Exit.isFailure(contextExit)) {
      return yield* Effect.failCause(
        Exit.isFailure(browserExit) ? Cause.combine(contextExit.cause, browserExit.cause) : contextExit.cause,
      );
    }
    if (Exit.isFailure(browserExit)) {
      return yield* Effect.failCause(browserExit.cause);
    }
    return yield* Effect.void;
  });

export const WRITE_MODE_LABEL = {
  approval: 'Navrhovat změny ke schválení',
  direct: 'Provádět změny přímo',
  read_only: 'Jen čtení',
} as const;

export type ActAs = { readonly kind: 'me' } | { readonly agentName: string; readonly kind: 'agent' };

/** Opens one owned shared tab, or a CI-owned Playwright browser when configured. */
export const openSharedTab = () =>
  Effect.gen(function* openBrowserTab() {
    const playwrightModule = yield* Config.String('E2E_PLAYWRIGHT_MODULE').pipe(Config.withDefault(''));
    const options: BrowserContextOptions = { viewport: { height: 900, width: 1440 } };
    if (playwrightModule !== '') {
      const imported = yield* Effect.tryPromise({
        catch: (cause) => new BrowserDriverFailure({ cause, operation: 'import Playwright' }),
        try: async () => Schema.decodeUnknownResult(BrowserModuleSchema)(await import(playwrightModule)),
      });
      const mod = yield* Effect.fromResult(imported);
      const chromium = mod.chromium ?? mod.default?.chromium;
      if (chromium === undefined) {
        return yield* new BrowserDriverFailure({
          cause: `${playwrightModule} exports no chromium launcher`,
          operation: 'load Playwright',
        });
      }
      const browser = yield* Effect.tryPromise({
        catch: (cause) => new BrowserDriverFailure({ cause, operation: 'chromium.launch' }),
        try: async () => await chromium.launch(),
      });
      const context = yield* Effect.tryPromise({
        catch: (cause) => new BrowserDriverFailure({ cause, operation: 'browser.newContext' }),
        try: async () => await browser.newContext(options),
      }).pipe(
        Effect.onError(() =>
          Effect.tryPromise({
            catch: (cause) => new BrowserDriverFailure({ cause, operation: 'browser.close' }),
            try: async () => await browser.close(),
          }).pipe(Effect.orDie),
        ),
      );
      const page = yield* Effect.tryPromise({
        catch: (cause) => new BrowserDriverFailure({ cause, operation: 'context.newPage' }),
        try: async () => await context.newPage(),
      }).pipe(Effect.onError(() => closeContextAndBrowser(context, browser).pipe(Effect.orDie)));
      return ownedTab(page, closeContextAndBrowser(context, browser));
    }
    const clientPath = '/Volumes/TraceDecayKingston/techsio-demo/shared-browser/client.mjs';
    const imported = yield* Effect.tryPromise({
      catch: (cause) => new BrowserDriverFailure({ cause, operation: 'import shared browser' }),
      try: async () => Schema.decodeUnknownResult(SharedClientSchema)(await import(clientPath)),
    });
    const client = yield* Effect.fromResult(imported);
    const tab = yield* Effect.tryPromise({
      catch: (cause) => new BrowserDriverFailure({ cause, operation: 'shared.openTab' }),
      try: async () => await client.openTab(options),
    });
    return ownedTab(
      tab.page,
      Effect.tryPromise({
        catch: (cause) => new BrowserDriverFailure({ cause, operation: 'shared.closeTab' }),
        try: async () => await tab.close(),
      }),
    );
  });

export const loginIfNeeded = (page: E2ePage, email: string, password: Redacted.Redacted) =>
  Effect.gen(function* login() {
    const url = yield* Effect.try({
      catch: (cause) => new BrowserDriverFailure({ cause, operation: 'page.url' }),
      try: () => new URL(page.url()),
    });
    if (!url.pathname.startsWith('/cs/login')) {
      return;
    }
    yield* Effect.tryPromise({
      catch: (cause) => new BrowserDriverFailure({ cause, operation: 'fill username' }),
      try: async () => await page.fill('input[autocomplete="username"]', email),
    });
    yield* Effect.tryPromise({
      catch: (cause) => new BrowserDriverFailure({ cause, operation: 'fill password' }),
      try: async () => await page.fill('input[autocomplete="current-password"]', Redacted.value(password)),
    });
    yield* Effect.tryPromise({
      catch: (cause) => new BrowserDriverFailure({ cause, operation: 'submit login' }),
      try: async () => await page.click('button[type="submit"]'),
    });
  });

export const ensureLoggedIn = (page: E2ePage, shellUrl: string, email: string, password: Redacted.Redacted) =>
  Effect.gen(function* ensureLogin() {
    yield* Effect.tryPromise({
      catch: (cause) => new BrowserDriverFailure({ cause, operation: 'open login' }),
      try: async () => await page.goto(`${shellUrl}/cs/login`, { waitUntil: 'domcontentloaded' }),
    });
    yield* loginIfNeeded(page, email, password);
    yield* Effect.tryPromise({
      catch: (cause) => new BrowserDriverFailure({ cause, operation: 'wait for login' }),
      try: async () => await page.waitForURL((url) => !url.pathname.startsWith('/cs/login'), { timeout: 30_000 }),
    });
  });

/** Drives consent and finishes after the callback redirect lands. */
export const approveConnection = (
  page: E2ePage,
  authorizationUrl: string,
  opts: {
    actAs: ActAs;
    email: string;
    password: Redacted.Redacted;
    shotPrefix: string;
    shotsDir: string;
    writeMode: keyof typeof WRITE_MODE_LABEL;
  },
) =>
  Effect.gen(function* approveConsent() {
    const fs = yield* FileSystem.FileSystem;
    yield* fs.makeDirectory(opts.shotsDir, { recursive: true });
    yield* Effect.tryPromise({
      catch: (cause) => new BrowserDriverFailure({ cause, operation: 'open authorization' }),
      try: async () => await page.goto(authorizationUrl, { waitUntil: 'domcontentloaded' }),
    });
    yield* Effect.tryPromise({
      catch: (cause) => new BrowserDriverFailure({ cause, operation: 'wait for consent or login' }),
      try: async () =>
        await page.waitForURL(
          (url) => url.pathname.startsWith('/cs/login') || url.pathname.startsWith('/cs/pripojit'),
          { timeout: 30_000 },
        ),
    });
    yield* loginIfNeeded(page, opts.email, opts.password);
    yield* Effect.tryPromise({
      catch: (cause) => new BrowserDriverFailure({ cause, operation: 'wait for identity selection' }),
      try: async () =>
        await page.waitForURL((url) => url.pathname.startsWith('/cs/pripojit') && !url.pathname.includes('souhlas'), {
          timeout: 60_000,
        }),
    });
    const acting = page.getByText(opts.actAs.kind === 'me' ? 'Za mě' : `Za agenta ${opts.actAs.agentName}`).first();
    yield* Effect.tryPromise({
      catch: (cause) => new BrowserDriverFailure({ cause, operation: 'wait for identity picker' }),
      try: async () => await page.getByRole('button', { name: 'Pokračovat' }).waitFor({ timeout: 30_000 }),
    });
    if (
      opts.actAs.kind === 'agent' ||
      (yield* Effect.tryPromise({
        catch: (cause) => new BrowserDriverFailure({ cause, operation: 'count identity choices' }),
        try: async () => await acting.count(),
      })) > 0
    ) {
      yield* Effect.tryPromise({
        catch: (cause) => new BrowserDriverFailure({ cause, operation: 'select identity' }),
        try: async () => await acting.click(),
      });
    }
    // Read-only also occurs in agent names, so only that label must match exactly.
    yield* Effect.tryPromise({
      catch: (cause) => new BrowserDriverFailure({ cause, operation: 'select write mode' }),
      try: async () =>
        await page
          .getByText(WRITE_MODE_LABEL[opts.writeMode], { exact: opts.writeMode === 'read_only' })
          .first()
          .click(),
    });
    yield* Effect.tryPromise({
      catch: (cause) => new BrowserDriverFailure({ cause, operation: 'capture identity consent' }),
      try: async () =>
        await page.screenshot({ fullPage: true, path: `${opts.shotsDir}/${opts.shotPrefix}-1-pripojit.png` }),
    });
    yield* Effect.tryPromise({
      catch: (cause) => new BrowserDriverFailure({ cause, operation: 'continue consent' }),
      try: async () => await page.getByRole('button', { name: 'Pokračovat' }).click(),
    });
    yield* Effect.tryPromise({
      catch: (cause) => new BrowserDriverFailure({ cause, operation: 'wait for final consent' }),
      try: async () =>
        await page.waitForURL((url) => url.pathname.startsWith('/cs/pripojit/souhlas'), { timeout: 30_000 }),
    });
    yield* Effect.tryPromise({
      catch: (cause) => new BrowserDriverFailure({ cause, operation: 'wait for approval' }),
      try: async () => await page.getByRole('button', { name: 'Povolit přístup' }).waitFor({ timeout: 30_000 }),
    });
    yield* Effect.tryPromise({
      catch: (cause) => new BrowserDriverFailure({ cause, operation: 'capture final consent' }),
      try: async () =>
        await page.screenshot({ fullPage: true, path: `${opts.shotsDir}/${opts.shotPrefix}-2-souhlas.png` }),
    });
    yield* Effect.tryPromise({
      catch: (cause) => new BrowserDriverFailure({ cause, operation: 'approve access' }),
      try: async () => await page.getByRole('button', { name: 'Povolit přístup' }).click(),
    });
    yield* Effect.tryPromise({
      catch: (cause) => new BrowserDriverFailure({ cause, operation: 'wait for callback redirect' }),
      try: async () => await page.waitForURL((url) => url.pathname === '/callback', { timeout: 30_000 }),
    });
  });

/** Uses the foreign page request context to keep its existing session cookies. */
export const sessionPost = (
  page: E2ePage,
  shellUrl: string,
  path: string,
  body: Schema.Json,
  headers: Record<string, string> = {},
) =>
  Effect.gen(function* postSessionJson() {
    const response = yield* Effect.tryPromise({
      catch: (cause) => new BrowserDriverFailure({ cause, operation: 'session POST' }),
      try: async () =>
        await page.request.post(`${shellUrl}${path}`, {
          data: body,
          headers: { 'content-type': 'application/json', origin: shellUrl, ...headers },
        }),
    });
    const text = yield* Effect.tryPromise({
      catch: (cause) => new BrowserDriverFailure({ cause, operation: 'read session response' }),
      try: async () => await response.text(),
    });
    const json = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Json))(text));
    return { json, status: response.status(), text };
  });
