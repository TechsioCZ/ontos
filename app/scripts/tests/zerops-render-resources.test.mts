import { NodeServices } from '@effect/platform-node';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess } from 'effect/process';

import { collectToolingProcess } from './tooling-process-fixture.mts';

const renderResourcesProbe = String.raw`import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// Exercise the installed patch, not a second implementation of the framework middleware.
const fromTools = createRequire(import.meta.resolve('@modern-js/app-tools'));
const fromServer = createRequire(fromTools.resolve('@modern-js/prod-server'));
const nodeEntry = fromServer.resolve('@modern-js/server-core/node');
const root = path.resolve(path.dirname(nodeEntry), '../../../..');
const [format, mode] = process.argv.slice(1);
const { injectResourcePlugin } =
  format === 'cjs'
    ? fromServer('@modern-js/server-core/node')
    : await import(pathToFileURL(path.join(root, 'dist', format, 'adapters/node/plugins/resource.mjs')).href);
const directory = await mkdtemp(path.join(tmpdir(), 'ontos-render-resources-'));
try {
  await mkdir(path.join(directory, 'bundles'));
  await writeFile(path.join(directory, 'index.html'), '<html>owner template</html>');
  await writeFile(
    path.join(directory, 'bundles/index.js'),
    'globalThis.ontosRenderLoads = (globalThis.ontosRenderLoads || 0) + 1; exports.owner = "fixture";',
  );
  await writeFile(
    path.join(directory, 'bundles/index-server-loaders.js'),
    'exports.loadModules = async () => { globalThis.ontosLoaderLoads = (globalThis.ontosLoaderLoads || 0) + 1; return { fixture: true }; };',
  );
  const context = {
    distDirectory: directory,
    middlewares: [],
    renderMiddlewares: [],
    routes: [{ bundle: 'bundles/index.js', entryName: 'index', entryPath: 'index.html', isSSR: true, urlPath: '/' }],
  };
  let prepare;
  injectResourcePlugin().setup({
    getServerContext: () => context,
    onPrepare: (callback) => {
      prepare = callback;
    },
  });
  await prepare();
  if (mode === 'lazy') {
    assert.equal(globalThis.ontosRenderLoads, undefined);
    assert.equal(globalThis.ontosLoaderLoads, undefined);
    assert.equal(context.middlewares.length, 0);
    assert.equal(context.renderMiddlewares.length, 2);
    // The production render plugin mounts these after the BFF and static responders.
    const { Hono } = fromTools('hono');
    const app = new Hono();
    app.get('/api/ping', c => c.text('api'));
    app.get('/static/client.js', c => c.text('client'));
    for (const middleware of context.renderMiddlewares) app.use('*', middleware.handler);
    app.get('/document', c => c.json({ owner: c.get('serverManifest').renderBundles.index.owner }));
    assert.equal(await (await app.request('/api/ping')).text(), 'api');
    assert.equal(await (await app.request('/static/client.js')).text(), 'client');
    assert.equal(globalThis.ontosRenderLoads, undefined);
    assert.equal(globalThis.ontosLoaderLoads, undefined);
    await writeFile(path.join(directory, 'bundles/other.js'), 'globalThis.ontosOtherRenderLoads = 1; exports.owner = "other";');
    const other = { ...context, middlewares: [], renderMiddlewares: [],
      routes: [{ ...context.routes[0], bundle: 'bundles/other.js', entryName: 'other' }] };
    let prepareOther;
    injectResourcePlugin().setup({
      getServerContext: () => other,
      onPrepare: callback => { prepareOther = callback; },
    });
    await prepareOther();
    assert.deepEqual(await (await app.request('/document')).json(), { owner: 'fixture' });
    assert.equal(globalThis.ontosOtherRenderLoads, undefined);
  } else {
    assert.equal(context.renderMiddlewares.length, 0);
    assert.equal(context.middlewares.length, 2);
  }
  const requests = Array.from({ length: 3 }, () => {
    const values = new Map();
    return { get: (key) => values.get(key), set: (key, value) => values.set(key, value) };
  });
  const handlers = mode === 'lazy' ? context.renderMiddlewares : context.middlewares;
  for (const { handler } of handlers) {
    await Promise.all(requests.map((request) => handler(request, async () => {})));
  }
  if (mode !== 'development') assert.equal(globalThis.ontosRenderLoads, 1);
  assert.equal(globalThis.ontosLoaderLoads, mode === 'development' ? 3 : 1);
  assert.equal(requests[0].get('serverManifest').renderBundles.index.owner, 'fixture');
  assert.equal(requests[0].get('serverManifest').loaderBundles.index.fixture, true);
  if (mode === 'development') {
    assert.notEqual(requests[0].get('serverManifest'), requests[1].get('serverManifest'));
    await writeFile(path.join(directory, 'index.html'), '<html>updated template</html>');
    // Modern's development rebuild resets its file-reader storage before the next request.
    const fromCore = createRequire(nodeEntry);
    const readerRoot = path.resolve(path.dirname(fromCore.resolve('@modern-js/runtime-utils/fileReader')), '../../..');
    const reader = format === 'cjs' ? fromCore('@modern-js/runtime-utils/fileReader')
      : await import(pathToFileURL(path.join(readerRoot, 'dist/esm-node/node/fileReader.mjs')).href);
    await reader.fileReader.reset();
    const values = new Map();
    const freshRequest = { get: key => values.get(key), set: (key, value) => values.set(key, value) };
    await handlers[1].handler(freshRequest, async () => {});
    assert.equal(Object.values(freshRequest.get('templates'))[0], '<html>updated template</html>');
  } else {
    assert.equal(requests[0].get('serverManifest'), requests[1].get('serverManifest'));
  }
  assert.equal(Object.values(requests[0].get('templates'))[0], '<html>owner template</html>');
  console.log('render resources passed');
} finally {
  await rm(directory, { force: true, recursive: true });
}
`;

for (const format of ['cjs', 'esm', 'esm-node']) {
  for (const mode of ['lazy', 'eager', 'development']) {
    it.effect(`preserves the ${format} ${mode} render-resource lifetime`, () =>
      Effect.gen(function* verifyRenderResources() {
        const result = yield* collectToolingProcess(
          ChildProcess.make(process.execPath, ['--input-type=module', '--eval', renderResourcesProbe, format, mode], {
            env: {
              MODERN_SERVER_RENDER_RESOURCES: mode,
              NODE_ENV: mode === 'development' ? 'development' : 'production',
            },
            extendEnv: true,
            stderr: 'pipe',
            stdin: 'ignore',
            stdout: 'pipe',
          }),
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain('render resources passed');
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }
}
