import { readFileSync } from 'node:fs';

import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Schema } from 'effect';
import { sharedBuildSourceDigest } from '../demo/shared-build-source-digest.mts';
import { expect, it } from 'effect-rstest';
import { parse } from 'yaml';

const StepSchema = Schema.Struct({
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  id: Schema.optionalKey(Schema.String),
  if: Schema.optionalKey(Schema.String),
  name: Schema.String,
  run: Schema.optionalKey(Schema.String),
  'timeout-minutes': Schema.optionalKey(Schema.Number),
  uses: Schema.optionalKey(Schema.String),
  'working-directory': Schema.optionalKey(Schema.String),
});
const WorkflowSchema = Schema.Struct({
  jobs: Schema.Struct({
    release: Schema.Struct({ steps: Schema.Array(StepSchema) }),
    'release-script-tests': Schema.Struct({ steps: Schema.Array(StepSchema) }),
  }),
});
const readJobs = () =>
  Schema.decodeUnknownSync(WorkflowSchema)(
    parse(readFileSync(new URL('../../../.github/workflows/stage-demo-deploy.yml', import.meta.url), 'utf-8')),
  ).jobs;

const MIGRATE = 'Migrate every owner schema';
const ORIGINAL_SHARED_SOURCE = 'export const value = 1;';
const secretReference = (name: string) => ['${{', `secrets.${name}`, '}}'].join(' ');
const indexOf = (steps: readonly { readonly name: string }[], name: string) =>
  steps.findIndex((step) => step.name === name);

it('migrates every owner schema through the private network before any upload or publication', () => {
  const { steps } = readJobs().release;
  const migrate = steps.find(({ name }) => name === MIGRATE);
  expect(migrate?.run).toBe('mise exec -- pnpm db:migrate');
  expect(migrate?.['working-directory']).toBe('app');
  expect(migrate?.['timeout-minutes']).toBeGreaterThan(0);
  // A failed migration fails the job: the step is unconditional and never continues on error.
  expect(migrate?.if).toBeUndefined();
  const connect = steps.findIndex(({ id }) => id === 'composition-vpn');
  expect(connect).toBeGreaterThanOrEqual(0);
  expect(indexOf(steps, MIGRATE)).toBeGreaterThan(connect);
  for (const later of [
    'Upload every immutable release Worker',
    'Publish the Application Composition',
    'Activate the Shell ingress',
    'Deploy the AKROS storefront',
  ]) {
    expect(indexOf(steps, later)).toBeGreaterThan(indexOf(steps, MIGRATE));
  }
});

it('migrates the Commerce portal realm with the runtime and administrator database pair', () => {
  const migrate = readJobs().release.steps.find(({ name }) => name === MIGRATE);
  expect(migrate?.env).toEqual({
    COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL: secretReference('DATABASE_ADMIN_URL'),
    COMMERCE_PORTAL_AUTH_DATABASE_URL: secretReference('DATABASE_URL'),
  });
});

it('runs this workflow test with the release script tests that gate the release job', () => {
  const tests = readJobs()['release-script-tests'].steps.find(({ run }) => run?.includes('rstest') === true);
  expect(tests?.run).toContain('scripts/tests/stage-demo-deploy-workflow.test.mts');
});

it('publishes rebuilt contracts before replacing running demo processes, but starts new artifact endpoints first', () => {
  const script = readFileSync(new URL('../demo/rebuild-one.sh', import.meta.url), 'utf-8');
  const newUnits = script.indexOf('RUNNING_UNITS=()');
  const publish = script.indexOf('start composition');
  const ready = script.indexOf('wait_http "http://127.0.0.1:$COMPOSITION_PORT/active"');
  const replace = script.indexOf('for id in ${RUNNING_UNITS[@]+');
  expect(newUnits).toBeGreaterThan(0);
  expect(publish).toBeGreaterThan(newUnits);
  expect(ready).toBeGreaterThan(publish);
  expect(replace).toBeGreaterThan(ready);
  expect(script.slice(newUnits, publish)).toContain('start_unit "$id"');
  expect(script.slice(replace)).toContain('stop_pid "$id"\n  start_unit "$id"');
});

it.effect('hashes shared build sources by exact content and path, without Git or output mtimes', () =>
  Effect.scoped(
    Effect.gen(function* checksSharedBuildDigest() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: 'demo-shared-digest-' });
      for (const owner of ['core-runtime', 'shared-contracts']) {
        yield* fs.makeDirectory(`${root}/packages/${owner}/src`, { recursive: true });
        yield* fs.writeFileString(`${root}/packages/${owner}/package.json`, '{}');
        yield* fs.writeFileString(`${root}/packages/${owner}/src/index.ts`, ORIGINAL_SHARED_SOURCE);
      }
      const original = yield* sharedBuildSourceDigest(root);
      expect(original).toMatch(/^[a-f0-9]{64}$/u);
      yield* fs.writeFileString(`${root}/packages/core-runtime/src/index.ts`, ORIGINAL_SHARED_SOURCE);
      expect(yield* sharedBuildSourceDigest(root)).toBe(original);
      yield* fs.makeDirectory(`${root}/packages/core-runtime/dist`);
      yield* fs.writeFileString(`${root}/packages/core-runtime/dist/ignored.js`, 'output is not source');
      expect(yield* sharedBuildSourceDigest(root)).toBe(original);
      yield* fs.writeFileString(`${root}/packages/shared-contracts/src/index.ts`, 'export const value = 2;');
      expect(yield* sharedBuildSourceDigest(root)).not.toBe(original);
      yield* fs.writeFileString(`${root}/packages/shared-contracts/src/index.ts`, ORIGINAL_SHARED_SOURCE);
      yield* fs.rename(`${root}/packages/core-runtime/src/index.ts`, `${root}/packages/core-runtime/src/renamed.ts`);
      expect(yield* sharedBuildSourceDigest(root)).not.toBe(original);
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it('rejects missing or stale shared-source stamps before honoring DEMO_SKIP_BUILD', () => {
  const script = readFileSync(new URL('../demo/up.sh', import.meta.url), 'utf-8');
  const selection = script.slice(script.indexOf('needs_build()'), script.indexOf('# The package'));
  const digestCheck = selection.indexOf('cat "$dir/dist/.ontos-shared-source-digest"');
  const skip = selection.indexOf(['[ "$', '{DEMO_SKIP_BUILD:-0}" = 1 ]'].join(''));
  expect(digestCheck).toBeGreaterThan(0);
  expect(skip).toBeGreaterThan(digestCheck);
  expect(selection.slice(digestCheck, skip)).toContain('|| return 0');
  const nativeBuild = script.indexOf('exec sh -c "$script"');
  const stamp = script.indexOf('>"$(dir_of "$id")/dist/.ontos-shared-source-digest"');
  expect(stamp).toBeGreaterThan(nativeBuild);
  expect(script.slice(nativeBuild, stamp)).toContain('= "$SHARED_SOURCE_DIGEST" ] &&');
});

it('expands a requested owner refresh to every stale served shared-source consumer before taking locks', () => {
  const script = readFileSync(new URL('../demo/rebuild-one.sh', import.meta.url), 'utf-8');
  const staleConsumers = script.indexOf(['for id in shell-super-app "$', '{SERVED[@]}"'].join(''));
  const locks = script.indexOf('for id in $(printf');
  expect(staleConsumers).toBeGreaterThan(0);
  expect(locks).toBeGreaterThan(staleConsumers);
  expect(script.slice(staleConsumers, locks)).toContain('.ontos-shared-source-digest');
  expect(script.slice(staleConsumers, locks)).toContain('set -- "$@" "$id"');
  const build = script.indexOf('exec sh -c "$script"');
  const stamp = script.indexOf('>"$dist/.ontos-shared-source-digest"');
  expect(stamp).toBeGreaterThan(build);
  expect(script.slice(build, stamp)).toContain('refusing to stamp or restart mixed artifacts');
});
