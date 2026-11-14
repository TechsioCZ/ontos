import path from 'node:path';

import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { ChildProcess } from 'effect/process';
import { parse } from 'yaml';

import { collectToolingProcess } from '../tests/tooling-process-fixture.mts';
import { DeliveryPlanSchema } from './delivery-plan.mts';
import type { DeliveryService } from './delivery-plan.mts';

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
        ['n1', 'app', 'storefront', 'shop'].filter((service) => services.some((selected) => selected === service)).map(
          (service) =>
            `${service}-id|${service === 'n1' ? 'n1' : service === 'app' ? 'app' : 'storefront'}|${HEAD}|${service === 'app' ? 'none' : 'app/.zerops-prebuilt.tar.zst'}`,
        ),
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
it.effect('keeps verification mandatory for changed services and records sources only after successful proof', () =>
  Effect.gen(function* workflowGates() {
    const fs = yield* FileSystem.FileSystem;
    const source = yield* fs.readFileString(
      path.resolve(import.meta.dirname, '../../../.github/workflows/zerops-stage.yml'),
    );
    const workflow = yield* Schema.decodeUnknownEffect(WorkflowSchema)(parse(source));
    expect(workflow.jobs.build?.if).toBe("needs.plan.outputs.app == 'true'");
    expect(workflow.jobs.verify?.if).toBe("always() && needs.deploy.result == 'success'");
    expect(workflow.jobs.record?.if).toContain("needs.verify.result == 'success'");
    for (const name of [
      'Download the unit builds',
      'Pack the unit builds for the push',
      'Sync the owner secret bundle to the app service',
    ]) {
      expect(workflow.jobs.deploy?.steps.find((step) => step.name === name)?.if).toBe(
        "needs.plan.outputs.app == 'true'",
      );
    }
    expect(workflow.jobs.verify?.steps.some((step) => step.run?.includes('stage-demo-verify.mjs') === true)).toBe(true);
    expect(workflow.jobs.verify?.steps.some((step) => step.run?.includes('prove-mcp-oauth.mts') === true)).toBe(true);
    expect(source).toContain('zerops-verified-delivery');
    expect(source).toContain('fetch-depth: 0');
    expect(source).toContain(`ZEROPS_FORCE_BUILD: \${{ needs.plan.outputs.full }}`);
    const buildScript = yield* fs.readFileString(path.join(import.meta.dirname, 'build-app.sh'));
    expect(buildScript).toContain('node "$root/scripts/zerops/delivery-plan-cli.mts" digests >"$ZEROPS_UNIT_DIGESTS"');
    expect(buildScript).toContain('export ZEROPS_UNIT_DIGESTS');
    expect(buildScript).toContain(`[ "\${ZEROPS_FORCE_BUILD:-false}" != true ] || return 1`);
    expect(source).toContain("needs.plan.outputs.app == 'false' || needs.build.result == 'success'");
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
