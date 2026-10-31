import { NodeServices } from '@effect/platform-node';
import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess } from 'effect/process';

import { collectToolingProcess } from './tooling-process-fixture.mts';

// A separate process exercises each installed export with its real Hono context and filesystem.
const staticAssetsProbe = String.raw`
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { brotliCompressSync, gzipSync, brotliDecompressSync } from 'node:zlib';
const [format, mode] = process.argv.slice(1);
const optimized = mode === 'optimized';
const fromTools = createRequire(import.meta.resolve('@modern-js/app-tools'));
const fromServer = createRequire(fromTools.resolve('@modern-js/prod-server'));
const coreRoot = path.resolve(path.dirname(fromServer.resolve('@modern-js/server-core/node')), '../../../..');
const extensionRoot = path.resolve(path.dirname(fromTools.resolve('@modern-js/server-runtime-extensions')), '../..');
const staticModule = path.join(coreRoot, 'dist', format, 'adapters/node/plugins', format === 'cjs' ? 'static.js' : 'static.mjs');
const core = format === 'cjs' ? fromServer(staticModule)
  : await import(pathToFileURL(staticModule).href);
const extensionFormat = format === 'cjs' ? 'cjs' : 'esm-node';
const extensionFile = path.join(extensionRoot, 'dist', extensionFormat, 'static-serving', format === 'cjs' ? 'responders.js' : 'responders.mjs');
const { createStaticExtensionResponders } = format === 'cjs' ? fromTools(extensionFile) : await import(pathToFileURL(extensionFile).href);
const { Hono } = fromTools('hono');
const { fs } = fromServer('@modern-js/utils');
const directory = await mkdtemp(path.join(tmpdir(), 'ontos-static-assets-'));
const outside = await mkdtemp(path.join(tmpdir(), 'ontos-static-outside-'));
try {
  await mkdir(path.join(directory, 'static'));
  await mkdir(path.join(directory, 'public'));
  const filename = path.join(directory, 'static/asset.js');
  const bytes = Buffer.from('globalThis.asset = true;');
  await writeFile(filename, bytes);
  await writeFile(filename + '.br', brotliCompressSync(bytes));
  await writeFile(filename + '.gz', gzipSync(bytes));
  await writeFile(path.join(outside, 'private.txt'), 'private');
  await symlink(path.join(outside, 'private.txt'), path.join(directory, 'public/escape.txt'));
  let stats = 0, probes = 0;
  const originalStat = fs.lstat, originalExists = fs.pathExists;
  fs.lstat = (...args) => { if (args[0] === filename) stats++; return originalStat(...args); };
  fs.pathExists = (...args) => { if (args[0] === filename + '.br' || args[0] === filename + '.gz') probes++; return originalExists(...args); };
  const app = new Hono();
  app.use('*', core.createStaticMiddleware({
    pwd: directory, routes: [], output: {}, html: {}, server: {},
    ...createStaticExtensionResponders(),
  }));
  const request = (name, encoding) => app.request(name, { headers: { 'accept-encoding': encoding } });
  const first = await request('/static/asset.js', 'identity');
  assert.equal(first.status, 200);
  assert.equal(await first.text(), bytes.toString());
  assert.equal(first.headers.get('Content-Length'), String(bytes.length));
  assert.match(first.headers.get('Content-Type'), /javascript/);
  const afterFirst = stats;
  const repeated = await Promise.all(Array.from({ length: 8 }, () => request('/static/asset.js', 'identity')));
  assert(repeated.every(response => response.status === 200));
  if (optimized) { assert.equal(stats, afterFirst); assert.equal(probes, 0); }
  else { assert(stats > afterFirst); assert(probes >= 18); }
  const compressed = await request('/static/asset.js', 'br, gzip');
  assert.equal(compressed.headers.get('Content-Encoding'), optimized ? null : 'br');
  const selectedBytes = Buffer.from(await compressed.arrayBuffer());
  assert.equal((optimized ? selectedBytes : brotliDecompressSync(selectedBytes)).toString(), bytes.toString());
  if (!optimized) assert.match(compressed.headers.get('Vary'), /Accept-Encoding/);
  const refused = await request('/static/asset.js', 'identity;q=0, br;q=0, gzip;q=0');
  assert.equal(refused.status, 406);
  assert.match(refused.headers.get('Vary'), /Accept-Encoding/);
  assert.equal((await request('/static/new.js', 'identity')).status, 404);
  await writeFile(path.join(directory, 'static/new.js'), 'new');
  assert.equal(await (await request('/static/new.js', 'identity')).text(), 'new');
  assert.equal((await request('/escape.txt', 'identity')).status, 404);
  assert.equal((await request('/%2e%2e/private.txt', 'identity')).status, 404);
  const escaped = await core.serveStaticAsset({
    header() {}, body() { throw Error('must not serve an escaped path'); },
  }, { filename: path.join(outside, 'private.txt'), kind: 'static', root: directory });
  assert.equal(escaped, null);
  if (optimized) {
    let syntheticStats = 0;
    fs.lstat = () => { syntheticStats++; return Promise.resolve({ size: 1 }); };
    const context = { header() {} };
    const synthetic = index => core.serveStaticAsset(context, {
      filename: path.join(directory, 'bounded', String(index) + '.js'), kind: 'static',
    }, () => new Response('fixture'));
    for (let index = 0; index < 8193; index++) await synthetic(index);
    const afterFill = syntheticStats;
    await synthetic(8192);
    assert.equal(syntheticStats, afterFill);
    await synthetic(0);
    assert.equal(syntheticStats, afterFill + 1);
  }
  console.log(JSON.stringify({ stats, probes, passed: true }));
} finally {
  await rm(directory, { force: true, recursive: true });
  await rm(outside, { force: true, recursive: true });
}
`;

for (const format of ['cjs', 'esm', 'esm-node']) {
  for (const mode of ['default', 'optimized']) {
    it.effect(`preserves ${format} ${mode} asset negotiation, lengths and containment`, () =>
      Effect.gen(function* verifyStaticAssets() {
        const result = yield* collectToolingProcess(
          ChildProcess.make(process.execPath, ['--input-type=module', '--eval', staticAssetsProbe, format, mode], {
            env: {
              MODERN_SERVER_IMMUTABLE_ASSETS: mode === 'optimized' ? 'true' : 'false',
              MODERN_SERVER_PRECOMPRESSED_ASSETS: mode === 'optimized' ? 'false' : 'true',
              NODE_ENV: 'production',
            },
            extendEnv: true,
            stderr: 'pipe',
            stdin: 'ignore',
            stdout: 'pipe',
          }),
        );
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).toContain('"passed":true');
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    );
  }
}
