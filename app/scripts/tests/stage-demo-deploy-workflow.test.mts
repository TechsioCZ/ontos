import { readFileSync } from 'node:fs';

import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Layer, Schema } from 'effect';
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
  'working-directory': Schema.optionalKey(Schema.String),
});
const WorkflowSchema = Schema.Struct({
  jobs: Schema.Struct({
    release: Schema.Struct({ steps: Schema.Array(StepSchema) }),
    'release-script-tests': Schema.Struct({ steps: Schema.Array(StepSchema) }),
    verify: Schema.Struct({ steps: Schema.Array(StepSchema) }),
  }),
});
const readJobs = () =>
  Schema.decodeUnknownSync(WorkflowSchema)(
    parse(readFileSync(new URL('../../../.github/workflows/stage-demo-deploy.yml', import.meta.url), 'utf-8')),
  ).jobs;

const localBootstrapScript = new URL('../demo/up.sh', import.meta.url);
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
  for (const name of [
    'stage-demo-deploy-workflow',
    'reconcile-stage-service-grants',
    'verification-context',
    'mcp-proof-transport',
  ]) {
    expect(tests?.run).toContain(`scripts/tests/${name}.test.mts`);
  }
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

it('bootstraps native Privacy after workload configuration and publishes returned refs before Commerce restart', () => {
  const script = readFileSync(localBootstrapScript, 'utf-8');
  const defaults = /^DEFAULT_VERTICALS="(?<owners>[^"]+)"/mu.exec(script)?.groups?.owners?.split(' ');
  expect(defaults).toContain('privacy');
  const portal = script.indexOf('step commerce-portal');
  const callbackReload = script.indexOf('ONTOS_PRIVACY_GATEWAY_API_KEY', portal);
  const privacyRestart = script.indexOf('restart_server privacy verticals/privacy', callbackReload);
  const seed = script.indexOf('step privacy-marketing env', privacyRestart);
  const refsReload = script.indexOf('reload_env_keys COMMERCE_MARKETING_PURPOSE_ID', seed);
  const commerceRestart = script.indexOf('restart_server commerce-customer-context', refsReload);
  expect(portal).toBeGreaterThan(0);
  expect(callbackReload).toBeGreaterThan(portal);
  expect(privacyRestart).toBeGreaterThan(callbackReload);
  expect(seed).toBeGreaterThan(privacyRestart);
  expect(refsReload).toBeGreaterThan(seed);
  expect(commerceRestart).toBeGreaterThan(refsReload);
  expect(script.slice(seed, refsReload)).toContain('scripts/demo/privacy-marketing.mts --apply');
  expect(script.slice(seed, refsReload)).toContain(
    '--checkpoint "$SCRATCH/privacy-marketing.json" --env-file "$APP/.env"',
  );
  expect(script.slice(refsReload, commerceRestart)).toContain('COMMERCE_MARKETING_NOTICE_VERSION_ID');
  const setup = readFileSync(new URL('../demo/privacy-marketing.mts', import.meta.url), 'utf-8');
  expect(setup).toContain('const { email, principalId: governanceOwnerId } = privacyMarketingOperator');
  expect(setup).toContain('const target = { legalEntityId: akrosDemoLegalEntityId, shellUrl, tenantId: demoTenantId }');
  expect(setup).not.toContain('ONTOS_DEMO_SEED_EMAIL');
  expect(setup).not.toContain('ONTOS_DEMO_SEED_GOVERNANCE_OWNER_ID');
  expect(setup).toContain("checkpoint.phase === 'PURPOSE_PENDING' || checkpoint.phase === 'NOTICE_PENDING'");
  expect(setup).toContain("if (checkpoint.phase === 'EMPTY')");
  expect(setup).toContain("if (checkpoint.phase === 'PURPOSE_CREATED')");
  expect(setup).toContain('return yield* verifyRecords(client, checkpoint)');
  expect(setup).not.toContain('record-consent-decision');
  expect(setup).not.toContain('writeAiRelationships');
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

it('reconciles service grants and the isolated verification context after migrations and before publication', () => {
  const { steps } = readJobs().release;
  const name = 'Reconcile storefront, Commerce and Privacy service grants';
  const reconcile = steps.find((step) => step.name === name);
  expect(indexOf(steps, name)).toBeGreaterThan(indexOf(steps, MIGRATE));
  expect(indexOf(steps, name)).toBeLessThan(indexOf(steps, 'Upload every immutable release Worker'));
  expect(reconcile?.if).toBeUndefined();
  expect(reconcile?.['continue-on-error']).toBeUndefined();
  expect(reconcile?.env?.ZEROPS_TOKEN).toBe(secretReference('ZEROPS_TOKEN'));
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
