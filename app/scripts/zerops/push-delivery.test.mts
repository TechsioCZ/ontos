import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess } from 'effect/process';
import { parse } from 'yaml';

import { collectToolingProcess } from '../tests/tooling-process-fixture.mts';
import { DeliveryPlanSchema } from './delivery-plan.mts';
import type { DeliveryService } from './delivery-plan.mts';

/** The Zerops setup a pushed service deploys from; both AKROS services share the storefront setup. */
const setupOf = (service: string) => (service === 'app' || service === 'n1' ? service : 'storefront');

const HEAD = 'b'.repeat(40);
const fakePush = `#!/usr/bin/env bash
printf '%s|%s|%s|%s\\n' "$1" "$2" "$3" "\${PUSH_EXCLUDE:-none}" >>"$RUNNER_TEMP/calls"
echo 'build and deploy process test-process'
[ "\${FAIL_SERVICE:-}" != "$1" ]
`;
const fixture = (services: readonly DeliveryService[]) =>
  Effect.gen(function* deliveryFixture() {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped();
    const script = path.join(directory, 'push-delivery.sh');
    yield* fs.copyFile(path.join(import.meta.dirname, 'push-delivery.sh'), script);
    yield* fs.writeFileString(path.join(directory, 'push-service.sh'), fakePush);
    const plan = path.join(directory, 'plan.json');
    const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(DeliveryPlanSchema))({
      affectedUnits: [],
      base: HEAD,
      changedPaths: [],
      full: false,
      migrations: [],
      reasons: [],
      receipt: {
        lastAttempt: { runAttempt: 1, runId: 1, sourceRevision: HEAD },
        runAttempt: 1,
        runId: 1,
        schemaVersion: 1,
        services: { app: HEAD, shop: HEAD, storefront: HEAD },
        validatedHead: HEAD,
      },
      schemaVersion: 1,
      services,
      sourceRevision: HEAD,
    });
    yield* fs.writeFileString(plan, encoded);
    const env = {
      GITHUB_SHA: HEAD,
      RUNNER_TEMP: directory,
      ZEROPS_APP_SERVICE_ID: 'app-id',
      ZEROPS_N1_STOREFRONT_SERVICE_ID: 'n1-id',
      ZEROPS_SHOP_STOREFRONT_SERVICE_ID: 'shop-id',
      ZEROPS_STOREFRONT_SERVICE_ID: 'storefront-id',
    };
    return { directory, env, plan, script };
  });
for (const services of [
  ['app'],
  ['storefront', 'shop'],
  ['app', 'storefront', 'shop'],
  ['app', 'storefront', 'shop', 'n1'],
] satisfies (readonly DeliveryService[])[]) {
  it.effect(`pushes only the selected services ${services.join(',')}`, () =>
    Effect.gen(function* selectivePush() {
      const fs = yield* FileSystem.FileSystem;
      const context = yield* fixture(services);
      const result = yield* collectToolingProcess(
        ChildProcess.make('bash', [context.script, context.plan], { env: context.env, extendEnv: true }),
      );
      expect(result.status).toBe(0);
      const calls = (yield* fs.readFileString(path.join(context.directory, 'calls'))).trim().split('\n');
      expect(calls).toEqual(
        ['n1', 'app', 'storefront', 'shop']
          .filter((service) => services.some((selected) => selected === service))
          .map((service) => `${service}-id|${setupOf(service)}|${HEAD}|none`),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
}
it.effect('rejects a missing selected service ID before ANY service push', () =>
  Effect.gen(function* missingServiceId() {
    const fs = yield* FileSystem.FileSystem;
    const context = yield* fixture(['app', 'storefront', 'shop']);
    const result = yield* collectToolingProcess(
      ChildProcess.make('bash', [context.script, context.plan], {
        env: { ...context.env, ZEROPS_SHOP_STOREFRONT_SERVICE_ID: '' },
        extendEnv: true,
      }),
    );
    expect(result.status).not.toBe(0);
    expect(yield* fs.exists(path.join(context.directory, 'calls'))).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it.effect('rejects a stale plan before ANY service push', () =>
  Effect.gen(function* staleSourcePlan() {
    const fs = yield* FileSystem.FileSystem;
    const context = yield* fixture(['app']);
    const result = yield* collectToolingProcess(
      ChildProcess.make('bash', [context.script, context.plan], {
        env: { ...context.env, GITHUB_SHA: 'c'.repeat(40) },
        extendEnv: true,
      }),
    );
    expect(result.status).not.toBe(0);
    expect(yield* fs.exists(path.join(context.directory, 'calls'))).toBe(false);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
it.effect('reports a failed service and still waits for all already started deployments', () =>
  Effect.gen(function* failedService() {
    const context = yield* fixture(['app', 'storefront', 'shop']);
    const result = yield* collectToolingProcess(
      ChildProcess.make('bash', [context.script, context.plan], {
        env: { ...context.env, FAIL_SERVICE: 'app-id' },
        extendEnv: true,
      }),
    );
    expect(result.status).not.toBe(0);
    expect(result.stdout).toContain('::group::push app');
    expect(result.stdout).toContain('::group::push shop');
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

const KEEP_APP_CONDITION = "needs.plan.outputs.app == 'true'";

const WorkflowSchema = Schema.Struct({
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({
      if: Schema.optionalKey(Schema.String),
      needs: Schema.optionalKey(Schema.Array(Schema.String)),
      steps: Schema.Array(
        Schema.Struct({
          if: Schema.optionalKey(Schema.String),
          name: Schema.optionalKey(Schema.String),
          run: Schema.optionalKey(Schema.String),
        }),
      ),
    }),
  ),
  permissions: Schema.Struct({ contents: Schema.Literal('read') }),
});
type StageWorkflow = typeof WorkflowSchema.Type;

/** A storefront deploy job: kept storefronts only re-verify; selected ones push their own checked runner archive. */
const expectStorefrontDeployJob = (workflow: StageWorkflow, service: string) => {
  const job = workflow.jobs[`deploy_${service}`];
  expect(job?.needs).toEqual(['plan', 'deploy', 'build_storefronts']);
  // A kept storefront only re-verifies; a selected one deploys only after the runner build ran.
  expect(job?.if).toContain(`needs.plan.outputs.${service} != 'true'`);
  expect(job?.if).toContain("needs.build_storefronts.result == 'success'");
  expect(workflow.jobs.record?.if).toContain(`needs.deploy_${service}.result == 'success'`);
  // Its own archive, checked against this commit and setup, before the push mutates anything.
  const steps = job?.steps ?? [];
  const index = (name: string) => steps.findIndex((step) => step.name === name);
  const setup = service === 'n1' ? 'n1' : 'storefront';
  const refuse = steps[index('Refuse an archive from another revision or setup')];
  expect(refuse?.if).toBe(`needs.plan.outputs.${service} == 'true'`);
  expect(refuse?.run).toContain(`--arg setup '${setup}'`);
  expect(refuse?.run).toContain('.sourceRevision == $sha and .setup == $setup');
  expect(refuse?.run).toContain('sha256sum -c -');
  expect(index(`Take the ${setup} archive built on the runner`)).toBeGreaterThan(-1);
  expect(index(`Take the ${setup} archive built on the runner`)).toBeLessThan(index(refuse?.name ?? ''));
  expect(index(refuse?.name ?? '')).toBeLessThan(index('Push only services whose inputs changed'));
};

/** The storefront runner build waits only for the plan and packs exactly what the deploy jobs check. */
const expectStorefrontRunnerBuild = (workflow: StageWorkflow, source: string) => {
  // The runner build depends only on the plan, never on the app shards, and builds only selected storefronts.
  expect(workflow.jobs.build_storefronts?.needs).toEqual(['plan']);
  expect(workflow.jobs.build_storefronts?.if).toContain("needs.plan.outputs.n1 == 'true'");
  expect(workflow.jobs.build_storefronts?.if).toContain("needs.plan.outputs.shop == 'true'");
  expect(workflow.jobs.deploy_app?.needs).not.toContain('build_storefronts');
  expect(workflow.jobs.verify?.needs).not.toContain('build_storefronts');
  const storefrontBuild = workflow.jobs.build_storefronts?.steps ?? [];
  expect(storefrontBuild.map((step) => step.name)).toEqual([
    'Checkout',
    'Install the app workspace',
    "Restore Next's compiler cache",
    'Typecheck with tsrs',
    'Build the standalone server',
    "Save Next's compiler cache",
    'Pack the standalone server with its manifest',
    'Upload the storefront archive',
  ]);
  const pack = storefrontBuild.find((step) => step.name === 'Pack the standalone server with its manifest');
  expect(pack?.run).toContain("-name '*.node' -print");
  expect(pack?.run).toContain("-type l -lname '/*' -print");
  expect(pack?.run).toContain('sourceRevision: $sourceRevision');
  expect(source).toContain(`name: zerops-storefront-\${{ matrix.setup }}`);
  expect(source).toContain('zerops-verified-delivery');
  expect(source).toContain('fetch-depth: 0');
  expect(source).toContain('STOREFRONT RUNNER PREBUILD (lane STOREFRONT)');
  expect(source).toContain(`ZEROPS_FORCE_BUILD: \${{ needs.plan.outputs.full }}`);
};

it.effect('keeps verification mandatory for changed services and records sources only after successful proof', () =>
  Effect.gen(function* workflowGates() {
    const fs = yield* FileSystem.FileSystem;
    const source = yield* fs.readFileString(
      path.resolve(import.meta.dirname, '../../../.github/workflows/zerops-stage.yml'),
    );
    const workflow = yield* Schema.decodeUnknownEffect(WorkflowSchema)(parse(source));
    expect(workflow.jobs.build?.if).toBe(KEEP_APP_CONDITION);
    expect(workflow.jobs.verify?.needs).toEqual(['plan', 'deploy', 'deploy_app']);
    expect(workflow.jobs.verify?.if).toContain("needs.deploy_app.result == 'success'");
    expect(workflow.jobs.record?.if).toContain("needs.verify.result == 'success'");
    for (const name of ['Download the unit builds', 'Pack the unit builds for the push']) {
      expect(workflow.jobs.deploy_app?.steps.find((step) => step.name === name)?.if).toBe(KEEP_APP_CONDITION);
    }
    expect(
      workflow.jobs.deploy?.steps.find((step) => step.name === 'Sync the owner secret bundle to the app service')?.if,
    ).toBe(KEEP_APP_CONDITION);
    expect(workflow.jobs.deploy?.needs).toEqual(['plan']);
    expect(workflow.jobs.deploy_app?.needs).toEqual(['plan', 'deploy', 'build']);
    expect(workflow.jobs.verify?.steps.some((step) => step.run?.includes('verify-service.mjs app') === true)).toBe(
      true,
    );
    expect(workflow.jobs.verify?.steps.some((step) => step.run?.includes('prove-mcp-oauth.mts') === true)).toBe(true);
    for (const service of ['storefront', 'shop', 'n1']) {
      expectStorefrontDeployJob(workflow, service);
    }
    expectStorefrontRunnerBuild(workflow, source);
    const buildScript = yield* fs.readFileString(path.join(import.meta.dirname, 'build-app.sh'));
    expect(buildScript).toContain('node "$root/scripts/zerops/delivery-plan-cli.mts" digests >"$ZEROPS_UNIT_DIGESTS"');
    expect(buildScript).toContain('export ZEROPS_UNIT_DIGESTS');
    expect(buildScript).toContain(`[ "\${ZEROPS_FORCE_BUILD:-false}" != true ] || return 1`);
    expect(workflow.jobs.deploy_app?.if).toContain("needs.build.result == 'success'");
    expect(source).toContain(`AKROS_TEST_BASE_URL: \${{ env.STAGE_SHOP_URL }}`);
    expect(source).toContain(
      `NEWSLETTER_PURPOSE_READ_FILE: \${{ runner.temp }}/newsletter-native/processing-purposes.json`,
    );
    expect(source).toContain(`NEWSLETTER_NOTICE_READ_FILE: \${{ runner.temp }}/newsletter-native/notice-versions.json`);
    expect(source).toContain(`NEWSLETTER_PURPOSE_ID: \${{ vars.NEWSLETTER_PURPOSE_ID }}`);
    expect(source).toContain(`NEWSLETTER_NOTICE_ID: \${{ vars.NEWSLETTER_NOTICE_ID }}`);
    expect(source).toContain("steps.newsletter-evidence.outcome == 'success'");
    expect(source).toContain(
      "steps.newsletter-evidence.outcome == 'failure' || steps.newsletter-proof.outcome == 'failure'",
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
