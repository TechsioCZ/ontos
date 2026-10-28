import { readFileSync } from 'node:fs';

import { NodeServices } from '@effect/platform-node';
import { Effect, Exit, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { parse } from 'yaml';

import { OpsShellLive, runCommand } from '../ops/ops-shell.mts';

const StepSchema = Schema.Struct({
  'continue-on-error': Schema.optionalKey(Schema.Boolean),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  id: Schema.optionalKey(Schema.String),
  if: Schema.optionalKey(Schema.String),
  name: Schema.String,
  run: Schema.optionalKey(Schema.String),
  uses: Schema.optionalKey(Schema.String),
  with: Schema.optionalKey(
    Schema.Struct({
      'cli-path': Schema.optionalKey(Schema.String),
      operation: Schema.optionalKey(Schema.String),
      'state-directory': Schema.optionalKey(Schema.String),
    }),
  ),
});
const workflow = Schema.decodeUnknownSync(
  Schema.Struct({
    jobs: Schema.Struct({
      plan: Schema.Struct({ if: Schema.String }),
      'profile-recovery': Schema.Struct({
        concurrency: Schema.Struct({ 'cancel-in-progress': Schema.Boolean, group: Schema.String }),
        environment: Schema.Struct({ deployment: Schema.Boolean, name: Schema.String }),
        if: Schema.String,
        needs: Schema.optionalKey(Schema.Unknown),
        steps: Schema.Array(StepSchema),
        'timeout-minutes': Schema.Number,
      }),
      release: Schema.Struct({ if: Schema.String }),
      'release-script-tests': Schema.Struct({ steps: Schema.Array(StepSchema) }),
    }),
    on: Schema.Struct({
      workflow_dispatch: Schema.Struct({
        inputs: Schema.Struct({
          profile_recovery_approval_sha256: Schema.Struct({ default: Schema.String }),
          profile_recovery_mode: Schema.Struct({
            default: Schema.String,
            options: Schema.Array(Schema.String),
            type: Schema.String,
          }),
        }),
      }),
    }),
  }),
)(parse(readFileSync(new URL('../../../.github/workflows/stage-demo-deploy.yml', import.meta.url), 'utf-8')));
const recovery = workflow.jobs['profile-recovery'];
const step = (name: string) =>
  Schema.decodeUnknownSync(StepSchema)(recovery.steps.find((candidate) => candidate.name === name));
const position = (name: string) => recovery.steps.findIndex((candidate) => candidate.name === name);
const OPERATOR_GATE = 'Require an isolated manual operator request on demo';
const OPERATOR_RUN = 'Run only the exact admitted profile recovery';
const OPERATOR_TEST = 'Test the bounded operator command before stage access';
const OPERATOR_CONNECT = 'Connect the operator to the private database network';
const OPERATOR_CLEANUP = "Clear only the operator runner's private network";

it('makes recovery an explicit manual choice with no build dependency or accidental deployment record', () => {
  expect(workflow.on.workflow_dispatch.inputs.profile_recovery_mode).toEqual({
    default: 'none',
    options: ['none', 'check', 'reconcile'],
    type: 'choice',
  });
  expect(workflow.on.workflow_dispatch.inputs.profile_recovery_approval_sha256.default).toBe('');
  expect(recovery.if).toBe("github.event_name == 'workflow_dispatch' && inputs.profile_recovery_mode != 'none'");
  expect(recovery.needs).toBeUndefined();
  expect(recovery.environment).toEqual({ deployment: false, name: 'stage-edge' });
  expect(recovery.concurrency).toEqual({ 'cancel-in-progress': false, group: 'zerops-stage' });
  expect(recovery['timeout-minutes']).toBe(15);
});

it('keeps recovery out of both normal deployment entry paths', () => {
  expect(workflow.jobs.plan.if).toContain("inputs.profile_recovery_mode == 'none'");
  expect(workflow.jobs.release.if).toContain(
    "github.event_name == 'workflow_dispatch' && inputs.outbox_only && inputs.profile_recovery_mode == 'none'",
  );
});

it('tests the operator before access and supplies only existing credentials without migrations or publication', () => {
  expect(position(OPERATOR_GATE)).toBe(0);
  expect(position(OPERATOR_TEST)).toBeLessThan(position(OPERATOR_CONNECT));
  expect(position(OPERATOR_CONNECT)).toBeLessThan(position(OPERATOR_RUN));
  expect(position('Load existing database identity credentials without changing them')).toBeLessThan(
    position(OPERATOR_RUN),
  );
  const commands = recovery.steps.map(({ run }) => run ?? '').join('\n');
  for (const forbidden of [
    'db:migrate',
    'db:bootstrap',
    '--continue-publication',
    'enrollment-recovery-host-config.mts apply',
    'immutable-application-release.mts',
    'cloudflare:deploy',
    'zcli push',
  ]) {
    expect(commands).not.toContain(forbidden);
  }
  expect(commands).toContain('database-identities.mts --github-environment-file "$GITHUB_ENV"');
  for (const candidate of recovery.steps) {
    expect(candidate['continue-on-error']).toBeUndefined();
  }
});

it('passes operator data only as environment values and masks the derived workload credential', () => {
  const run = step(OPERATOR_RUN);
  expect(run.env?.ONTOS_STAGE_PROFILE_RECOVERY_REQUEST_JSON).toBe(
    ['${{', 'inputs.profile_recovery_request', '}}'].join(' '),
  );
  expect(run.env?.ONTOS_STAGE_PROFILE_RECOVERY_SOURCE_REVISION).toBe(['${{', 'github.sha', '}}'].join(' '));
  expect(run.run).not.toContain('${{');
  expect(run.run).toContain('unset ALL_RELEASE_SECRETS');
  expect(run.run).toContain(String.raw`printf '::add-mask::%s\n' "$masked_key"`);
  expect(run.run).toContain(
    'mise exec -- pnpm exec node verticals/commerce-customer-context/scripts/recover-admitted-retail-profile.mts',
  );
  expect(run.run).not.toContain('GITHUB_ENV');
});

it('clears only its own VPN through an always cleanup with the exact connection outputs', () => {
  const cleanup = step(OPERATOR_CLEANUP);
  expect(cleanup.if).toBe("always() && steps.recovery-vpn.outputs.state-directory != ''");
  expect(cleanup.uses).toBe('./.github/actions/zerops-vpn');
  expect(cleanup.with?.operation).toBe('clear');
  expect(cleanup.with?.['state-directory']).toBe(['${{', 'steps.recovery-vpn.outputs.state-directory', '}}'].join(' '));
  expect(cleanup.with?.['cli-path']).toBe(['${{', 'steps.recovery-vpn.outputs.cli-path', '}}'].join(' '));
  expect(position(OPERATOR_CLEANUP)).toBeGreaterThan(position(OPERATOR_RUN));
});

it('gates future releases and recovery runs on the operator and workflow tests', () => {
  for (const tests of [
    step(OPERATOR_TEST).run,
    workflow.jobs['release-script-tests'].steps.find(({ run }) => run?.includes('rstest') === true)?.run,
  ]) {
    expect(tests).toContain('scripts/tests/recover-admitted-retail-profile.test.mts');
    expect(tests).toContain('scripts/tests/recover-admitted-customer-directory.test.mts');
    expect(tests).toContain('scripts/tests/stage-profile-recovery-workflow.test.mts');
  }
});

const approvalSha256 = 'a'.repeat(64);
for (const example of [
  { digest: '', mode: 'check', passes: true },
  { digest: approvalSha256, mode: 'reconcile', passes: true },
  { digest: approvalSha256, mode: 'check', passes: false },
  { digest: '', mode: 'reconcile', passes: false },
  { digest: 'not-an-approval', mode: 'reconcile', passes: false },
  { digest: '', mode: 'unknown', passes: false },
  { deploy: 'true', digest: '', mode: 'check', passes: false },
  { digest: '', mode: 'check', outbox: 'true', passes: false },
  { continuation: 'true', digest: '', mode: 'check', passes: false },
  { branch: 'refs/heads/main', digest: '', mode: 'check', passes: false },
  { digest: '', mode: 'check', passes: true, transition: 'party-customer-enroll' },
  { digest: approvalSha256, mode: 'reconcile', passes: true, transition: 'party-customer-enroll' },
  { digest: '', mode: 'check', passes: false, transition: 'party.customer.enroll' },
  { digest: '', mode: 'check', passes: false, transition: '' },
]) {
  it.effect(`the real operator shell gate handles ${JSON.stringify(example)}`, () =>
    Effect.gen(function* verifyOperatorGate() {
      const command = Schema.decodeUnknownSync(Schema.String)(step(OPERATOR_GATE).run);
      const exit = yield* runCommand({
        args: ['-e', '-u', '-o', 'pipefail', '-c', command],
        captureProviderFailure: true,
        command: 'bash',
        env: {
          APPROVAL_SHA256: Redacted.make(example.digest),
          CONTINUE_MIGRATED: Redacted.make(example.continuation ?? 'false'),
          DEPLOY: Redacted.make(example.deploy ?? 'false'),
          GITHUB_REF: Redacted.make(example.branch ?? 'refs/heads/demo/sales-crm'),
          OUTBOX_ONLY: Redacted.make(example.outbox ?? 'false'),
          RECOVERY_MODE: Redacted.make(example.mode),
          RECOVERY_TRANSITION: Redacted.make(example.transition ?? 'ensure-retail-customer-profile'),
        },
      }).pipe(Effect.exit);
      expect(Exit.isSuccess(exit)).toBe(example.passes);
    }).pipe(Effect.provide(OpsShellLive), Effect.provide(NodeServices.layer)),
  );
}
