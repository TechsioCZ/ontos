import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const proof = fileURLToPath(new URL('prove-storefront-artifact.mts', import.meta.url));
const sourceRoot = new URL('../../packages/storefront-runtime/src/', import.meta.url);
const revision = 'a'.repeat(40);
const packageName = 'akros-storefront';
const runFixture = (source, { observerOnly = false } = {}) => {
  const directory = mkdtempSync(path.join(tmpdir(), 'ontos-artifact-proof-'));
  mkdirSync(path.join(directory, packageName));
  mkdirSync(path.join(directory, 'node_modules/@effect'), { recursive: true });
  for (const name of ['effect', '@effect/platform-node']) {
    const manifest = fileURLToPath(import.meta.resolve(`${name}/package.json`));
    symlinkSync(realpathSync(path.dirname(manifest)), path.join(directory, 'node_modules', name), 'dir');
  }
  writeFileSync(path.join(directory, 'package.json'), '{"type":"module"}');
  for (const name of ['telemetry', 'observability']) {
    const compiled = stripTypeScriptTypes(readFileSync(new URL(`${name}.ts`, sourceRoot), 'utf-8'));
    writeFileSync(
      path.join(directory, packageName, `${name}.js`),
      compiled.replaceAll("'./telemetry.ts'", "'./telemetry.js'"),
    );
  }
  writeFileSync(
    path.join(directory, 'akros-storefront/server.js'),
    `
    import { createServer } from 'node:http';
    ${source}
    ${
      observerOnly
        ? ''
        : `createServer((request, response) => { response.writeHead(200); response.end('robots'); })
      .listen(Number(process.env.PORT), process.env.HOSTNAME);
    `
    }
  `,
  );
  try {
    if (observerOnly) {
      return spawnSync(process.execPath, ['akros-storefront/server.js'], {
        cwd: directory,
        encoding: 'utf-8',
        timeout: 3000,
      });
    }
    return spawnSync(process.execPath, [proof, directory, packageName, revision], {
      encoding: 'utf-8',
      timeout: 10_000,
    });
  } finally {
    rmSync(directory, { force: true, recursive: true });
  }
};
const observerSource = (sourceRevision = revision, family = packageName) => `
  import { Effect } from 'effect';
  import { NodeServices } from '@effect/platform-node';
  import { startStorefrontObservability } from './observability.js';
  Effect.runFork(startStorefrontObservability('${family}', '${sourceRevision}').pipe(Effect.provide(NodeServices.layer)));
`;

void test('native observer cleans up then preserves default process termination', () => {
  const result = runFixture(
    `
    const output = console.log;
    console.log = (...args) => {
      output(...args);
      if (args.some(value => String(value).includes('storefront.runtime.summary'))) {
        process.kill(process.pid, 'SIGTERM');
      }
    };
    ${observerSource()}
  `,
    { observerOnly: true },
  );
  assert.equal(result.status, null, result.stderr);
  assert.equal(result.signal, 'SIGTERM');
  assert.doesNotMatch(result.stdout + result.stderr, /\bERROR\b/u);
  assert.match(result.stdout, /storefront\.runtime\.boot/u);
  assert.match(result.stdout, /storefront\.runtime\.summary/u);
});

void test('accepts a relocated native observer with compiled artifact files, not workspace source imports', () => {
  const result = runFixture(observerSource());
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PASS relocated akros-storefront/u);
});

void test('refuses a forged summary with absent measurement and controller fields', () => {
  const result = runFixture(`
    console.log(JSON.stringify({event:'storefront.runtime.boot',revision:'${revision}',bootId:'boot',pid:process.pid}));
    console.log(JSON.stringify({event:'storefront.runtime.summary',revision:'${revision}',bootId:'boot',
      pid:process.pid,rssBytes:1,externalBytes:null,cgroup:null}));
  `);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.signal, null);
  assert.doesNotMatch(result.stdout, /PASS relocated/u);
});

void test('refuses a packaged observer from a different source revision', () => {
  const result = runFixture(observerSource('b'.repeat(40)));
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.signal, null);
  assert.doesNotMatch(result.stdout, /PASS relocated/u);
});

void test('does not leak raw child credentials when proof fails', () => {
  const result = runFixture(`
    console.error('credential-do-not-print');
    console.log(JSON.stringify({ event: 'storefront.runtime.summary', query: 'credential-do-not-print' }));
  `);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.signal, null);
  assert.doesNotMatch(result.stdout + result.stderr, /credential-do-not-print/u);
});

void test('scope force-kills a child that ignores graceful termination', () => {
  const result = runFixture(`
    process.on('SIGTERM', () => {});
    console.log(JSON.stringify({ event: 'storefront.runtime.summary', cgroup: null }));
  `);
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.signal, null);
  assert.doesNotMatch(result.stdout, /PASS relocated/u);
});

void test('refuses another storefront family even when source and process identity match', () => {
  const result = runFixture(observerSource(revision, 'n1-storefront'));
  assert.equal(result.status, 1, result.stderr);
  assert.equal(result.signal, null);
  assert.doesNotMatch(result.stdout, /PASS relocated/u);
});
