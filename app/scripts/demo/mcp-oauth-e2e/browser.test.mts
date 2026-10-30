import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { NodeServices } from '@effect/platform-node';
import { ConfigProvider, Effect, FileSystem, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { BrowserDriverFailure, openSharedTab } from './browser.mts';

const recordedCalls = Schema.Struct({ calls: Schema.Array(Schema.String) });
const operations = {
  closeBrowser: 'browser.close',
  closeContext: 'context.close',
  launch: 'chromium.launch',
  newContext: 'browser.newContext',
  newPage: 'context.newPage',
};

// Exercise the configured native module boundary without starting a real browser in unit tests.
const browserFixture = (failure = '', defaultExport = false) =>
  Effect.gen(function* makeBrowserFixture() {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'ontos-browser-' });
    const filename = path.join(directory, 'playwright module.mjs');
    yield* fs.writeFileString(
      filename,
      `
export const calls = [];
const record = (operation) => {
  calls.push(operation);
  if (operation === ${JSON.stringify(failure)}) throw new Error(operation);
};
const chromium = {
  async launch() {
    if (this !== chromium) throw new Error('Playwright launcher receiver was lost');
    record('chromium.launch');
    return {
      async newContext(options) {
        record('browser.newContext');
        calls.push(JSON.stringify(options));
        return {
          async newPage() {
            record('context.newPage');
            return { url: () => 'about:blank' };
          },
          async close() { record('context.close'); },
        };
      },
      async close() { record('browser.close'); },
    };
  },
};
${defaultExport ? 'export default { chromium };' : 'export { chromium };'}
`,
    );
    const moduleUrl = pathToFileURL(filename).href;
    const calls = Effect.tryPromise({
      catch: (cause) => new BrowserDriverFailure({ cause, operation: 'read fixture calls' }),
      try: async () => Schema.decodeUnknownResult(recordedCalls)(await import(moduleUrl)),
    }).pipe(
      Effect.flatMap(Effect.fromResult),
      Effect.map((mod) => mod.calls),
    );
    const open = openSharedTab().pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ E2E_PLAYWRIGHT_MODULE: filename }))),
    );
    return { calls, filename, moduleUrl, open };
  });

for (const defaultExport of [false, true]) {
  it.effect(
    `opens a module by native absolute path and closes its context and browser once (default=${defaultExport})`,
    () =>
      Effect.gen(function* openAndCloseBrowser() {
        const fixture = yield* browserFixture('', defaultExport);
        const tab = yield* fixture.open;
        expect(tab.page.url()).toBe('about:blank');
        yield* tab.close;
        yield* tab.close;
        expect(yield* fixture.calls).toEqual([
          operations.launch,
          operations.newContext,
          JSON.stringify({ viewport: { height: 900, width: 1440 } }),
          operations.newPage,
          operations.closeContext,
          operations.closeBrowser,
        ]);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

it.effect('also accepts a file URL for the configured module', () =>
  Effect.gen(function* fileUrlModule() {
    const fixture = yield* browserFixture();
    const tab = yield* openSharedTab().pipe(
      Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ E2E_PLAYWRIGHT_MODULE: fixture.moduleUrl }))),
    );
    expect(tab.page.url()).toBe('about:blank');
    yield* tab.close;
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

for (const { cleanup, operation } of [
  { cleanup: [], operation: operations.launch },
  { cleanup: [operations.closeBrowser], operation: operations.newContext },
  { cleanup: [operations.closeContext, operations.closeBrowser], operation: operations.newPage },
]) {
  it.effect(`reports ${operation} as a typed failure and releases any acquired browser resources`, () =>
    Effect.gen(function* acquisitionFailure() {
      const fixture = yield* browserFixture(operation);
      const failure = yield* fixture.open.pipe(Effect.flip);
      expect(Schema.is(BrowserDriverFailure)(failure)).toBe(true);
      expect(failure).toMatchObject({ operation });
      const calls = yield* fixture.calls;
      expect(calls.filter((call) => call.endsWith('.close'))).toEqual(cleanup);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

it.effect('still closes the browser when closing its context fails', () =>
  Effect.gen(function* failedContextCleanup() {
    const fixture = yield* browserFixture(operations.closeContext);
    const tab = yield* fixture.open;
    const failure = yield* tab.close.pipe(Effect.flip);
    expect(Schema.is(BrowserDriverFailure)(failure)).toBe(true);
    expect(failure).toMatchObject({ operation: operations.closeContext });
    expect((yield* fixture.calls).slice(-2)).toEqual([operations.closeContext, operations.closeBrowser]);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

for (const source of ['export const chromium = { launch: false };', 'export const other = {};']) {
  it.effect(`rejects an invalid Playwright module through the typed failure channel: ${source}`, () =>
    Effect.gen(function* invalidModule() {
      const fixture = yield* browserFixture();
      const fs = yield* FileSystem.FileSystem;
      yield* fs.writeFileString(fixture.filename, source);
      const failure = yield* fixture.open.pipe(Effect.flip);
      expect(Schema.is(BrowserDriverFailure)(failure)).toBe(true);
      expect(failure).toMatchObject({ operation: 'load Playwright' });
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}

it.effect('reports an unavailable configured module as an import failure', () =>
  Effect.gen(function* missingModule() {
    const fixture = yield* browserFixture();
    const fs = yield* FileSystem.FileSystem;
    yield* fs.remove(fixture.filename);
    const failure = yield* fixture.open.pipe(Effect.flip);
    expect(Schema.is(BrowserDriverFailure)(failure)).toBe(true);
    expect(failure).toMatchObject({ operation: 'import Playwright' });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
