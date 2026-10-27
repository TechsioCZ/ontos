import { readFileSync } from 'node:fs';

import { NodeServices } from '@effect/platform-node';
import { Effect, Exit, FileSystem, Layer, Redacted, Schema } from 'effect';
import { sharedBuildSourceDigest } from '../demo/shared-build-source-digest.mts';
import { OpsShellLive, runCommand } from '../ops/ops-shell.mts';
import { expect, it } from 'effect-rstest';
import { parse } from 'yaml';

const StepSchema = Schema.Struct({
  'continue-on-error': Schema.optionalKey(Schema.Boolean),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  id: Schema.optionalKey(Schema.String),
  if: Schema.optionalKey(Schema.String),
  name: Schema.String,
  run: Schema.optionalKey(Schema.String),
  'timeout-minutes': Schema.optionalKey(Schema.Number),
  uses: Schema.optionalKey(Schema.String),
  with: Schema.optionalKey(
    Schema.Struct({
      'if-no-files-found': Schema.optionalKey(Schema.String),
      name: Schema.optionalKey(Schema.String),
      path: Schema.optionalKey(Schema.String),
    }),
  ),
  'working-directory': Schema.optionalKey(Schema.String),
});
const WorkflowSchema = Schema.Struct({
  jobs: Schema.Struct({
    build: Schema.Struct({ steps: Schema.Array(StepSchema) }),
    release: Schema.Struct({ steps: Schema.Array(StepSchema) }),
    'release-script-tests': Schema.Struct({ steps: Schema.Array(StepSchema) }),
    verify: Schema.Struct({ steps: Schema.Array(StepSchema), 'timeout-minutes': Schema.Number }),
  }),
});
const readJobs = () =>
  Schema.decodeUnknownSync(WorkflowSchema)(
    parse(readFileSync(new URL('../../../.github/workflows/stage-demo-deploy.yml', import.meta.url), 'utf-8')),
  ).jobs;

const localBootstrapScript = new URL('../demo/up.sh', import.meta.url);
const MIGRATE = 'Migrate every owner schema';
const POST_MIGRATION_BOOTSTRAP = 'Verify every migrated owner schema';
const READINESS = 'Inspect migration readiness before database preparation';
const INITIAL_BOOTSTRAP = 'Bootstrap every database identity before migrations';
const RECOVERY_CONFIG_CHECK = 'Validate canonical enrollment recovery host configuration';
const RECOVERY_CONFIG_APPLY = 'Provision canonical enrollment recovery host configuration';
const PUBLICATION = 'Publish the Application Composition';
const fullPublicationCondition = ['${{', '!inputs.outbox_only', '}}'].join(' ');
const freshMigrationCondition = ['${{', '!inputs.outbox_only && !inputs.continue_migrated_publication', '}}'].join(' ');
const ORIGINAL_SHARED_SOURCE = 'export const value = 1;';
const secretReference = (name: string) => ['${{', `secrets.${name}`, '}}'].join(' ');
const indexOf = (steps: readonly { readonly name: string }[], name: string) =>
  steps.findIndex((step) => step.name === name);

it('builds each unit reference graph before the native Cloudflare build on a fresh runner', () => {
  const { steps } = readJobs().build;
  const producerName = 'Build the unit typecheck reference graph';
  const producer = steps.find(({ name }) => name === producerName);
  expect(producer?.run).toBe(
    'mise exec -- pnpm exec ultramodern-create ultramodern typecheck --build "$UNIT_PATH/tsconfig.json"',
  );
  expect(producer?.['working-directory']).toBe('app');
  expect(producer?.if).toBeUndefined();
  expect(producer?.['continue-on-error']).toBeUndefined();
  expect(indexOf(steps, producerName)).toBeGreaterThan(indexOf(steps, 'Install the app workspace'));
  expect(indexOf(steps, 'Build and verify the unit for Cloudflare')).toBeGreaterThan(indexOf(steps, producerName));
});

it('runs every owner migration through the native lifecycle on the private network before upload or publication', () => {
  const { steps } = readJobs().release;
  const migrate = steps.find(({ name }) => name === MIGRATE);
  expect(migrate?.run).toBe('mise exec -- pnpm exec node scripts/stage-demo-migrate.mts');
  expect(migrate?.['working-directory']).toBe('app');
  expect(migrate?.['timeout-minutes']).toBeGreaterThan(0);
  // Fresh releases migrate; the guarded continuation publishes an already completed migration.
  expect(migrate?.if).toBe(freshMigrationCondition);
  expect(migrate?.['continue-on-error']).toBeUndefined();
  expect(indexOf(steps, 'Write the initial cutover receipt')).toBeGreaterThanOrEqual(0);
  expect(indexOf(steps, 'Write the initial cutover receipt')).toBeLessThan(indexOf(steps, MIGRATE));
  expect(indexOf(steps, MIGRATE)).toBeGreaterThan(indexOf(steps, INITIAL_BOOTSTRAP));
  expect(indexOf(steps, POST_MIGRATION_BOOTSTRAP)).toBeGreaterThan(indexOf(steps, MIGRATE));
  const connect = steps.findIndex(({ id }) => id === 'composition-vpn');
  expect(connect).toBeGreaterThanOrEqual(0);
  expect(indexOf(steps, READINESS)).toBeGreaterThan(connect);
  expect(indexOf(steps, READINESS)).toBeLessThan(indexOf(steps, INITIAL_BOOTSTRAP));
  expect(steps.find(({ name }) => name === POST_MIGRATION_BOOTSTRAP)?.run).toBe('mise exec -- pnpm db:verify');
  expect(indexOf(steps, MIGRATE)).toBeGreaterThan(connect);
  for (const later of [
    'Upload every immutable release Worker',
    PUBLICATION,
    'Activate the Shell ingress',
    'Deploy the AKROS storefront',
  ]) {
    expect(indexOf(steps, later)).toBeGreaterThan(indexOf(steps, MIGRATE));
  }
});

it('keeps exact-published-revision outbox retries out of the schema migration and identity bootstrap lifecycle', () => {
  const { steps } = readJobs().release;
  const outboxRetry = 'Require the exact published revision for an outbox-only retry';
  const verifyRevision = steps.find(({ name }) => name === outboxRetry);
  expect(verifyRevision?.if).toBe('inputs.outbox_only');
  expect(verifyRevision?.['continue-on-error']).toBeUndefined();
  expect(verifyRevision?.run).toContain('"$published" != "$GITHUB_SHA"');
  expect(indexOf(steps, outboxRetry)).toBeGreaterThanOrEqual(0);
  expect(indexOf(steps, 'Push the outbox worker host')).toBeGreaterThan(indexOf(steps, outboxRetry));
  for (const name of [INITIAL_BOOTSTRAP, MIGRATE, POST_MIGRATION_BOOTSTRAP]) {
    const step = steps.find((candidate) => candidate.name === name);
    expect(step?.if).toBe(name === POST_MIGRATION_BOOTSTRAP ? fullPublicationCondition : freshMigrationCondition);
    expect(step?.['continue-on-error']).toBeUndefined();
    expect(indexOf(steps, name)).toBeGreaterThan(indexOf(steps, outboxRetry));
  }
});

it('retains full native publication after the separately guarded completed-migration continuation', () => {
  const { steps } = readJobs().release;
  const continuationName = 'Continue publication of the completed owner migration';
  const continuation = steps.find(({ name }) => name === continuationName);
  expect(continuation?.if).toBe('inputs.continue_migrated_publication && !inputs.outbox_only');
  expect(continuation?.['continue-on-error']).toBeUndefined();
  expect(continuation?.run).toBe('mise exec -- pnpm exec node scripts/stage-demo-migrate.mts --continue-publication');
  for (const name of [POST_MIGRATION_BOOTSTRAP, PUBLICATION]) {
    expect(steps.find((step) => step.name === name)?.if).toBe(fullPublicationCondition);
    expect(indexOf(steps, name)).toBeGreaterThan(indexOf(steps, continuationName));
  }
});

it('migrates the Commerce portal realm with the runtime and administrator database pair', () => {
  const migrate = readJobs().release.steps.find(({ name }) => name === MIGRATE);
  expect(migrate?.env).toEqual({
    COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL: secretReference('DATABASE_ADMIN_URL'),
    COMMERCE_PORTAL_AUTH_DATABASE_URL: secretReference('DATABASE_URL'),
  });
  const verify = readJobs().release.steps.find(({ name }) => name === POST_MIGRATION_BOOTSTRAP);
  expect(verify?.env).toEqual(migrate?.env);
});

it('checks canonical recovery configuration before database mutation and provisions it before host deployment', () => {
  const { steps } = readJobs().release;
  const check = steps.find(({ name }) => name === RECOVERY_CONFIG_CHECK);
  const provision = steps.find(({ name }) => name === RECOVERY_CONFIG_APPLY);
  expect(check?.run).toBe('mise exec -- pnpm exec node scripts/ops/enrollment-recovery-host-config.mts check');
  expect(check?.env).toEqual({
    ALL_RELEASE_SECRETS: secretReference('DEMO_IMMUTABLE_RELEASE_SECRETS'),
    ZEROPS_MIGRATOR_SERVICE_ID: ['${{', 'vars.ZEROPS_MIGRATOR_SERVICE_ID', '}}'].join(' '),
    ZEROPS_OUTBOX_WORKER_HOST_SERVICE_ID: ['${{', 'vars.ZEROPS_OUTBOX_WORKER_HOST_SERVICE_ID', '}}'].join(' '),
  });
  expect(provision?.env).toEqual(check?.env);
  expect(provision?.run?.split('\n').filter(Boolean)).toEqual([
    'mise exec -- pnpm exec node scripts/ops/enrollment-recovery-host-config.mts apply',
    'mise exec -- pnpm exec node scripts/ops/enrollment-recovery-host-config.mts verify',
  ]);
  expect(indexOf(steps, RECOVERY_CONFIG_CHECK)).toBeLessThan(indexOf(steps, INITIAL_BOOTSTRAP));
  expect(indexOf(steps, RECOVERY_CONFIG_CHECK)).toBeLessThan(indexOf(steps, READINESS));
  expect(indexOf(steps, RECOVERY_CONFIG_APPLY)).toBeGreaterThan(indexOf(steps, PUBLICATION));
  expect(indexOf(steps, RECOVERY_CONFIG_APPLY)).toBeLessThan(indexOf(steps, 'Push the outbox worker host'));
  for (const step of [check, provision]) {
    expect(step?.if).toBeUndefined();
    expect(step?.['continue-on-error']).toBeUndefined();
  }
});

it('runs this workflow test with the release script tests that gate the release job', () => {
  const tests = readJobs()['release-script-tests'].steps.find(({ run }) => run?.includes('rstest') === true);
  for (const name of [
    'stage-demo-deploy-workflow',
    'stage-demo-migrate',
    'stage-deploy-diagnostics',
    'application-composition-authority-publication',
    'application-composition-release-lifecycle',
    'bootstrap-runtime-role',
    'database-login-roles',
    'enrollment-recovery-host-config',
    'typecheck-project-references',
    'reconcile-stage-service-grants',
    'verification-context',
    'mcp-proof-transport',
  ]) {
    expect(tests?.run).toContain(`scripts/tests/${name}.test.mts`);
  }
});

for (const example of [
  { exitCode: 0, passes: true, reason: 'drained', status: 'ready' },
  { exitCode: 1, passes: false, reason: 'drained', status: 'ready' },
  { exitCode: 1, passes: true, reason: 'pending-work', status: 'blocked' },
  { exitCode: 137, passes: false, reason: 'pending-work', status: 'blocked' },
  { exitCode: 1, passes: true, reason: 'authority-sealed', status: 'blocked' },
  { exitCode: 1, passes: true, reason: 'authority-missing', status: 'unknown' },
  { exitCode: 130, passes: false, reason: 'authority-missing', status: 'unknown' },
  { exitCode: 1, passes: false, reason: 'authority-expired', status: 'blocked' },
  { exitCode: 1, passes: false, reason: 'replacement-publication-required', status: 'blocked' },
  { exitCode: 1, passes: false, reason: 'diagnostic-timeout', status: 'unknown' },
  { exitCode: 1, passes: false, reason: 'diagnostic-unavailable', status: 'unknown' },
  { exitCode: 1, passes: false, reason: 'untrusted-reason', status: 'untrusted-status' },
]) {
  it.effect(
    `the actual workflow readiness gate handles ${example.status}/${example.reason}/exit-${example.exitCode}`,
    () =>
      Effect.scoped(
        Effect.gen(function* runWorkflowReadinessGate() {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({ prefix: 'stage-readiness-gate-' });
          const input = `${directory}/readiness.json`;
          const summary = `${directory}/summary.md`;
          yield* fs.writeFileString(
            input,
            `${JSON.stringify({ advisoryOnly: true, reason: example.reason, status: example.status })}\n`,
          );
          const step = readJobs().release.steps.find(({ name }) => name === READINESS);
          const program = step?.run?.match(/<<'NODE'\n(?<program>[\s\S]+)\nNODE/u)?.groups?.program;
          expect(program).toBeDefined();
          const outcome = yield* runCommand({
            args: ['--input-type=module', '-', input, String(example.exitCode)],
            command: 'node',
            cwd: new URL('../..', import.meta.url).pathname.replace(/\/$/u, ''),
            env: { GITHUB_STEP_SUMMARY: Redacted.make(summary) },
            stdin: Redacted.make(program ?? ''),
          }).pipe(Effect.exit);
          expect(Exit.isSuccess(outcome)).toBe(example.passes);
          if (example.status === 'untrusted-status') {
            const rendered = yield* fs.readFileString(summary);
            expect(rendered).toContain('diagnostic-unavailable');
            expect(rendered).not.toContain('untrusted-');
            expect(rendered).not.toContain('migration authorized');
          } else {
            // The real CLI owns its complete summary; a valid record must not be rendered twice.
            expect(yield* fs.exists(summary)).toBe(false);
          }
        }),
      ).pipe(Effect.provide(OpsShellLive.pipe(Layer.provideMerge(NodeServices.layer)))),
  );
}

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

const sharedSourceFixture = Effect.gen(function* sharedSourceFixture() {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: 'demo-shared-digest-' });
  for (const owner of ['core-runtime', 'shared-contracts']) {
    yield* fs.makeDirectory(`${root}/packages/${owner}/src`, { recursive: true });
    yield* fs.writeFileString(`${root}/packages/${owner}/package.json`, '{}');
    yield* fs.writeFileString(`${root}/packages/${owner}/src/index.ts`, ORIGINAL_SHARED_SOURCE);
  }
  return root;
});

it.effect('hashes shared build sources by exact content and path, without Git or output mtimes', () =>
  Effect.scoped(
    Effect.gen(function* checksSharedBuildDigest() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* sharedSourceFixture;
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
  const script = readFileSync(localBootstrapScript, 'utf-8');
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

it.effect('a real MCP schema source change forces the native Bash build selector despite DEMO_SKIP_BUILD=1', () =>
  Effect.scoped(
    Effect.gen(function* executesSkipBuildRegression() {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* sharedSourceFixture;
      yield* fs.makeDirectory(`${root}/unit/dist`, { recursive: true });
      yield* fs.writeFileString(`${root}/unit/dist/contract.json`, '{}');
      const script = readFileSync(localBootstrapScript, 'utf-8');
      const selector = script.slice(script.indexOf('needs_build()'), script.indexOf('# The package'));
      const command = [
        'set -eu',
        'SHARED_SOURCE_DIGEST="$1"',
        'STAMP_DIR=stamps',
        'DEMO_SKIP_BUILD=1',
        'DEMO_REBUILD=0',
        'dir_of() { printf "%s" "$1"; }',
        'contract_of() { printf "%s/dist/contract.json" "$1"; }',
        selector,
        'if needs_build unit; then printf rebuild; else printf reuse; fi',
      ].join('\n');
      const select = (digest: string) =>
        runCommand({
          args: ['-c', command, 'demo-build-selector-test', digest],
          command: 'bash',
          cwd: root,
        });
      const original = yield* sharedBuildSourceDigest(root);
      expect(yield* select(original)).toBe('rebuild');
      yield* fs.writeFileString(`${root}/unit/dist/.ontos-shared-source-digest`, `${original}\n`);
      expect(yield* select(original)).toBe('reuse');
      yield* fs.writeFileString(
        `${root}/packages/core-runtime/src/index.ts`,
        'export const mcp = { recordLinks: true, agentAdministrationPage: true };',
      );
      const changed = yield* sharedBuildSourceDigest(root);
      expect(changed).not.toBe(original);
      expect(yield* select(changed)).toBe('rebuild');
    }),
  ).pipe(Effect.provide(OpsShellLive.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it('restarts Commerce for the direct demo newsletter without Privacy provisioning or copied catalog IDs', () => {
  const script = readFileSync(localBootstrapScript, 'utf-8');
  const defaults = /^DEFAULT_VERTICALS="(?<owners>[^"]+)"/mu.exec(script)?.groups?.owners?.split(' ');
  expect(defaults).toContain('privacy');
  const portal = script.indexOf('step commerce-portal');
  const callbackReload = script.indexOf('ONTOS_PRIVACY_GATEWAY_API_KEY', portal);
  const shellRestart = script.indexOf('restart_server shell-super-app apps/shell-super-app', callbackReload);
  const commerceRestart = script.indexOf('restart_server commerce-customer-context', shellRestart);
  expect(portal).toBeGreaterThan(0);
  expect(callbackReload).toBeGreaterThan(portal);
  expect(shellRestart).toBeGreaterThan(callbackReload);
  expect(commerceRestart).toBeGreaterThan(shellRestart);
  expect(script).not.toContain('restart_server privacy verticals/privacy');
  expect(script).not.toContain('step privacy-marketing');
  expect(script).not.toContain('scripts/demo/privacy-marketing.mts');
  expect(script).not.toContain('reload_env_keys COMMERCE_MARKETING_PURPOSE_ID');
  expect(script).not.toContain('COMMERCE_MARKETING_NOTICE_VERSION_ID');
  expect(script.slice(commerceRestart)).toContain(
    'wait_http "http://127.0.0.1:$(port_of commerce-customer-context)/.well-known/ontos-module-manifest.json"',
  );
});

it.effect(
  'reloads only generated owner refs and callback credentials in real Bash without retaining removed values',
  () =>
    Effect.scoped(
      Effect.gen(function* reloadGeneratedConfiguration() {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.makeTempDirectoryScoped({ prefix: 'demo-privacy-config-' });
        yield* fs.writeFileString(
          `${root}/.env`,
          [
            'COMMERCE_MARKETING_PURPOSE_ID=current-owner-purpose',
            'ONTOS_PRIVACY_GATEWAY_API_KEY=current-callback',
            'UNRELATED_CONFIGURATION=file-value',
          ].join('\n'),
        );
        const script = readFileSync(localBootstrapScript, 'utf-8');
        const functions = script.slice(script.indexOf('load_env()'), script.indexOf('# Native release identity'));
        const command = [
          'set -euo pipefail',
          'APP="$1"',
          functions,
          'export COMMERCE_MARKETING_PURPOSE_ID=previous-purpose ONTOS_PRIVACY_GATEWAY_API_KEY=previous-callback',
          'export COMMERCE_MARKETING_NOTICE_ID=removed-notice UNRELATED_CONFIGURATION=operator-value',
          'load_env',
          '[ "$COMMERCE_MARKETING_PURPOSE_ID" = previous-purpose ]',
          'reload_env_keys COMMERCE_MARKETING_PURPOSE_ID ONTOS_PRIVACY_GATEWAY_API_KEY COMMERCE_MARKETING_NOTICE_ID',
          '[ "$COMMERCE_MARKETING_PURPOSE_ID" = current-owner-purpose ]',
          '[ "$ONTOS_PRIVACY_GATEWAY_API_KEY" = current-callback ]',
          ['[ -z "$', '{COMMERCE_MARKETING_NOTICE_ID+x}" ]'].join(''),
          '[ "$UNRELATED_CONFIGURATION" = operator-value ]',
          'reload_env_keys COMMERCE_MARKETING_PURPOSE_ID ONTOS_PRIVACY_GATEWAY_API_KEY',
          '[ "$COMMERCE_MARKETING_PURPOSE_ID" = current-owner-purpose ]',
          '[ "$ONTOS_PRIVACY_GATEWAY_API_KEY" = current-callback ]',
          'printf verified',
        ].join('\n');
        expect(
          yield* runCommand({ args: ['-c', command, 'privacy-config-test', root], command: 'bash', cwd: root }),
        ).toBe('verified');
      }),
    ).pipe(Effect.provide(OpsShellLive.pipe(Layer.provideMerge(NodeServices.layer)))),
);

it('keeps the real MCP propose/reject proof outside every customer demo tenant', () => {
  const proof = readJobs().verify.steps.find(({ run }) => run?.includes('prove-mcp-oauth.mts') === true);
  expect(proof?.run).toContain('--variant=1 --verification');
  expect(proof?.run).not.toContain('--variant=all');
  expect(proof?.run).not.toContain('--keep');
});

it('runs the existing newsletter browser proof after Chromium even if timing fails, but not on outbox-only retries', () => {
  const { verify } = readJobs();
  const { steps } = verify;
  const proofName = 'Prove the native newsletter grant and withdrawal';
  const proof = steps.find(({ name }) => name === proofName);
  const timingName = 'Time /cs, OAuth metadata and the storefront home';
  const timing = steps.find(({ name }) => name === timingName);
  const fixture = readJobs().release.steps.find(({ name }) => name === 'Prepare the native demo customer fixture');
  expect(fixture?.if).toBe(fullPublicationCondition);
  expect(proof?.if).toBe('(success() || failure()) && !inputs.outbox_only');
  expect(proof?.['continue-on-error']).toBeUndefined();
  expect(proof?.['working-directory']).toBe('app');
  expect(proof?.env).toEqual({
    AKROS_EVIDENCE_DIR: ['${{', 'runner.temp', '}}/newsletter-consent'].join(' '),
    AKROS_TEST_BASE_URL: ['${{', 'env.STAGE_STOREFRONT_URL', '}}'].join(' '),
  });
  const mcp = steps.find(({ name }) => name === 'Prove MCP over OAuth end to end');
  expect(proof?.run?.split('\n')[0]).toBe(mcp?.run?.split('\n')[0]);
  expect(proof?.run).toContain('export E2E_PLAYWRIGHT_MODULE');
  expect(proof?.run).toContain('mise exec -- node akros-storefront/tests/browser/newsletter-consent.mjs');
  expect(indexOf(steps, proofName)).toBeGreaterThan(
    indexOf(steps, 'Install headless Chromium for the OAuth consent screens'),
  );
  expect(indexOf(steps, proofName)).toBeGreaterThan(indexOf(steps, timingName));
  expect(timing?.run).toBe('mise exec -- node scripts/ops/stage-demo-verify.mjs');
  expect(timing?.['continue-on-error']).toBeUndefined();
  expect(timing?.env).toBeUndefined();
  expect(verify['timeout-minutes']).toBe(20);
});

it('uploads only runner-temp newsletter screenshots even when the browser proof fails', () => {
  const { steps } = readJobs().verify;
  const uploadName = 'Upload the newsletter screenshots';
  const upload = steps.find(({ name }) => name === uploadName);
  expect(upload?.if).toBe('always() && !inputs.outbox_only');
  expect(upload?.uses).toMatch(/^actions\/upload-artifact@/u);
  expect(upload?.with).toEqual({
    'if-no-files-found': 'ignore',
    name: 'newsletter-consent',
    path: ['${{', 'runner.temp', '}}/newsletter-consent/*.png'].join(' '),
  });
  expect(indexOf(steps, uploadName)).toBeGreaterThan(
    indexOf(steps, 'Prove the native newsletter grant and withdrawal'),
  );
});

it('reconciles service grants and the isolated verification context after migrations and before publication', () => {
  const { steps } = readJobs().release;
  const name = 'Reconcile storefront, Commerce and Privacy service grants';
  const reconcile = steps.find((step) => step.name === name);
  expect(indexOf(steps, name)).toBeGreaterThan(indexOf(steps, MIGRATE));
  expect(indexOf(steps, name)).toBeLessThan(indexOf(steps, 'Upload every immutable release Worker'));
  expect(reconcile?.if).toBeUndefined();
  expect(reconcile?.['continue-on-error']).toBeUndefined();
  expect(reconcile?.env?.ZEROPS_TOKEN).toBe(secretReference('ZEROPS_TOKEN'));
  expect(reconcile?.env?.ONTOS_ACTIVE_APPLICATION_COMPOSITION_READ_TOKEN).toBe(secretReference('CLOUDFLARE_API_TOKEN'));
  expect(reconcile?.env?.BETTER_AUTH_URL).toBe(['${{', 'env.STAGE_SHELL_URL', '}}'].join(' '));
  expect(reconcile?.run?.match(/--zerops --(?:check|apply|verify)/gu)).toEqual([
    '--zerops --check',
    '--zerops --apply',
    '--zerops --verify',
  ]);
  const script = readFileSync(new URL('../demo/reconcile-stage-service-grants.mts', import.meta.url), 'utf-8');
  const apply = script.indexOf("if (mode === 'apply') {");
  const native = script.indexOf('yield* reconcileStageServicePrincipals(stageServicePrincipals(), provider)', apply);
  const verification = script.indexOf('yield* ensureStageVerification(configuration)', apply);
  expect(native).toBeGreaterThan(apply);
  expect(verification).toBeGreaterThan(native);
  expect(script.indexOf('yield* reconcileStagePermissionSchema(rpc, mode)')).toBeLessThan(apply);
  expect(script).toContain("SPICEDB_ENDPOINT: 'spicedb:50051'");
  expect(script).toContain('...verificationGrants');
  const bootstrap = readFileSync(new URL('../demo/ensure-stage-verification.mts', import.meta.url), 'utf-8');
  expect(bootstrap).toContain('apps/shell-super-app/scripts/bootstrap-stage-accounts.mts');
  expect(bootstrap).toContain('mode: 0o600');
  expect(bootstrap).toContain('makeTempDirectoryScoped');
  expect(bootstrap).not.toContain('bootstrap-context.mts');
});

it('never extracts a secret into the step environment and masks its value before any command', () => {
  const reconcile = readJobs().release.steps.find(
    ({ name }) => name === 'Reconcile storefront, Commerce and Privacy service grants',
  );
  expect(reconcile?.env?.BETTER_AUTH_SECRET).toBeUndefined();
  expect(reconcile?.env?.ALL_RELEASE_SECRETS).toBe(secretReference('DEMO_IMMUTABLE_RELEASE_SECRETS'));
  expect(Object.values(reconcile?.env ?? {}).some((value) => value.includes('fromJSON'))).toBe(false);
  expect(reconcile?.run).toContain('echo "::add-mask::$BETTER_AUTH_SECRET"');
  expect(reconcile?.run).toContain('export BETTER_AUTH_SECRET');
  expect(reconcile?.run?.indexOf('::add-mask::')).toBeLessThan(reconcile?.run?.indexOf('mise exec') ?? 0);
});

it('publishes the cold-start composition before the sales reset discovers live Action ownership', () => {
  const script = readFileSync(localBootstrapScript, 'utf-8');
  const ready = script.indexOf('wait_http "http://127.0.0.1:$COMPOSITION_PORT/active"');
  const sales = script.indexOf('step demo-reset-sales pnpm_ demo:reset:sales');
  const verify = script.indexOf('step db-verify pnpm_ db:verify');
  const worker = script.indexOf('start outbox-worker-host');
  expect(ready).toBeGreaterThan(0);
  expect(sales).toBeGreaterThan(ready);
  expect(verify).toBeGreaterThan(sales);
  expect(worker).toBeGreaterThan(sales);
  expect(script.lastIndexOf('step demo-reset-sales')).toBe(sales);
  expect(script.slice(ready, sales)).toContain(['[ "$', '{DEMO_RESET:-1}" != 0 ]'].join(''));
});
