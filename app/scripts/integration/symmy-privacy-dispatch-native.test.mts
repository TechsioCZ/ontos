import { GatewayContextV2ClaimsSchema } from '@app/shared-contracts';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { executeDispatchPrivacyMeasureWithAuthorization } from '@app/privacy/api/client';
import { PrivacyMeasureHandoffSchema } from '@app/privacy/domain/privacy-measure-handoff';
import { seedMeasureExecutionNativeFixture } from '@app/privacy/testing/measure-execution-native';
import { SymmyJobStatusResponseSchema } from '@app/symmy-integration/api/symmy-job-status';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { assert, expect, it } from 'effect-rstest';
import { Duration, Effect, Exit, Layer, Option, Redacted, Schema } from 'effect';
import { FetchHttpClient, HttpBody } from 'effect/http';
import { Reactivity } from 'effect/reactivity';

import {
  makePrivacyDispatchNativeFixture,
  observePrivacyDispatchUntil,
  privateIntentMarker,
  PrivacyDispatchNativeFailure,
} from './support/symmy-privacy-dispatch-fixture.mts';

const services = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
  Layer.provideMerge(Reactivity.layer),
  Layer.provideMerge(FetchHttpClient.layer),
);
const publicJwksSchema = Schema.Struct({
  keys: Schema.Array(
    Schema.Struct({
      alg: Schema.Literal('EdDSA'),
      crv: Schema.Literal('Ed25519'),
      kid: Schema.String,
      kty: Schema.Literal('OKP'),
      use: Schema.Literal('sig'),
      x: Schema.String,
    }),
  ),
});
const actionId = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('PrivacyDispatchNativeActionId'));
const symmyApp = 'symmy-integration';
const retentionPath = '/symmy-integration-api/symmy-integration/actions/execute-symmy-retention';
const observationSchema = Schema.Tuple([
  Schema.Struct({
    admission_id: Schema.OptionFromNullOr(actionId),
    effects: Schema.Int,
    fence: Schema.OptionFromNullOr(Schema.String),
    owner_commands: Schema.Int,
    private_present: Schema.Boolean,
    settled: Schema.Int,
    source_action: Schema.OptionFromNullOr(Schema.String),
    source_status: Schema.OptionFromNullOr(Schema.String),
    tombstones: Schema.Int,
  }),
]);
const observation = (admin: PgClient.PgClient, tenantId: string, jobId: string) =>
  admin`select j.admission_invocation_id as admission_id,
    (select count(*)::integer from symmy_integration.job_effects e where e.tenant_id=j.tenant_id and e.job_id=j.job_id) as effects,
    (select f.state from core.source_execution_fences f where f.tenant_id=j.tenant_id and f.admission_invocation_id=j.admission_invocation_id) as fence,
    (select count(*)::integer from core.action_invocations a where a.tenant_id=j.tenant_id and a.action_key='commerce.catalog.create-product' and a.status='succeeded') as owner_commands,
    position(${privateIntentMarker} in concat_ws('',j.execution_plan::text,(select string_agg(e.effect::text||coalesce(e.resolved_effect::text,''),'') from symmy_integration.job_effects e where e.tenant_id=j.tenant_id and e.job_id=j.job_id)))>0 as private_present,
    (select count(*)::integer from symmy_integration.job_effects e where e.tenant_id=j.tenant_id and e.job_id=j.job_id and e.state='settled') as settled,
    (select a.action_key from core.action_invocations a where a.tenant_id=j.tenant_id and a.action_invocation_id=j.admission_invocation_id) as source_action,
    (select a.status from core.action_invocations a where a.tenant_id=j.tenant_id and a.action_invocation_id=j.admission_invocation_id) as source_status,
    (select count(*)::integer from symmy_integration.job_retention_tombstones t where t.tenant_id=j.tenant_id and t.job_id=j.job_id) as tombstones
    from symmy_integration.import_jobs j where j.tenant_id=${tenantId} and j.job_id=${jobId}`.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(observationSchema)),
    Effect.map(([row]) => row),
  );
const countSchema = Schema.Tuple([Schema.Struct({ count: Schema.Int })]);
const barrierSchema = Schema.Tuple([Schema.Struct({ blocked: Schema.Boolean })]);
const backendSchema = Schema.Tuple([Schema.Struct({ backend: Schema.Int })]);
const startedSchema = Schema.Tuple([Schema.Struct({ started: Schema.String })]);
const retainedInvocationSchema = Schema.Tuple([Schema.Struct({ invocation_id: actionId, status: Schema.String })]);
const rollbackSchema = Schema.Tuple([Schema.Struct({ receipts: Schema.Int, status: Schema.String })]);
const dataAccessSchema = Schema.Tuple([
  Schema.Struct({
    action_invocation_id: actionId,
    evidence_capture_mode: Schema.Literal('metadata_only'),
    evidence_payload_json: Schema.Null,
    legal_entity_id: actionId,
    principal_id: actionId,
    query_hash: Schema.String,
    serving_module_key: Schema.Literal('integration.symmy'),
    target_module_key: Schema.Literal('integration.symmy'),
    target_resource_id: Schema.String,
    target_resource_type: Schema.Literal('integration.symmy.import-job'),
  }),
]);
const retentionDeniedDiagnosticSchema = Schema.fromJsonString(
  Schema.Struct({
    path: Schema.Literal(retentionPath),
    problem: Schema.Struct({
      _tag: Schema.Literal('ExecuteSymmyRetentionActionForbiddenProblem'),
      code: Schema.Literal('action_permission_denied'),
      status: Schema.Literal(403),
    }),
    status: Schema.Literal(403),
    type: Schema.Literal('owner-http-problem'),
  }),
);
const retentionConflictSummarySchema = Schema.Struct({
  code: Schema.Literal('retention_conflict'),
  path: Schema.Literal(retentionPath),
  problem: Schema.Literal('ExecuteSymmyRetentionActionConflictProblem'),
  status: Schema.Literal(409),
});
const ownerProblemDiagnosticSchema = Schema.fromJsonString(
  Schema.Struct({
    path: Schema.String,
    problem: Schema.Struct({
      _tag: Schema.String,
      code: Schema.optionalKey(Schema.String),
      status: Schema.Int,
    }),
    status: Schema.Int,
    type: Schema.Literal('owner-http-problem'),
  }),
);
const ownerProblems = (diagnostic: Effect.Effect<string> | undefined) =>
  diagnostic === undefined
    ? Effect.succeed([])
    : diagnostic.pipe(
        Effect.map((text) =>
          text.split('\n').flatMap((line) => {
            const decoded = Schema.decodeUnknownOption(ownerProblemDiagnosticSchema)(line);
            return Option.isSome(decoded)
              ? [
                  {
                    code: decoded.value.problem.code,
                    path: decoded.value.path,
                    problem: decoded.value.problem._tag,
                    status: decoded.value.status,
                  },
                ]
              : [];
          }),
        ),
      );
const retentionPermissionAttemptSchema = Schema.Tuple([Schema.Struct({ failures: Schema.Int, refused: Schema.Int })]);
const refusedRetention = (admin: PgClient.PgClient, tenantId: string) =>
  admin`select
    (select count(*)::integer from core.action_invocations where tenant_id=${tenantId} and action_key='integration.symmy.execute-symmy-retention' and status='rejected') as refused,
    (select count(*)::integer from core.outbox_attempts a join core.outbox_deliveries d on d.outbox_delivery_id=a.outbox_delivery_id join core.outbox_messages m on m.outbox_message_id=d.outbox_message_id
      where m.tenant_id=${tenantId} and d.worker_key='integration.symmy.symmy-job-privacy-dispatch' and a.finished_at is not null and a.error_message is not null) as failures`.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(retentionPermissionAttemptSchema)),
    Effect.map(([row]) => row),
  );
const emittedDispatches = (admin: PgClient.PgClient, tenantId: string) =>
  admin`select count(*)::integer as count from core.outbox_messages where tenant_id=${tenantId} and producer_module_key='privacy.core' and topic='privacy.measure.dispatched'`.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(countSchema)),
    Effect.map(([row]) => row.count),
  );

it.live(
  'INTERNAL actual Privacy dispatch enforces Tenant retention authority, rechecks concurrent holds and reports native execution receipts',
  () =>
    Effect.scoped(
      Effect.gen(function* actualPrivacyDispatch() {
        const fixture = yield* makePrivacyDispatchNativeFixture();
        yield* Effect.logInfo({ stage: 'privacy-dispatch-native-fixture-ready' });
        yield* Effect.addFinalizer((exit) =>
          Exit.isFailure(exit)
            ? Effect.gen(function* safeIntegrationDiagnostics() {
                const deliveries = yield* fixture.admin`select d.worker_key,d.status,d.attempts_count,
            (select a.error_message from core.outbox_attempts a where a.outbox_delivery_id=d.outbox_delivery_id order by a.started_at desc limit 1) as last_error
            from core.outbox_deliveries d join core.outbox_messages m on m.outbox_message_id=d.outbox_message_id where m.tenant_id=${fixture.tenantId} order by d.created_at limit 12`;
                const invocations =
                  yield* fixture.admin`select action_key,status from core.action_invocations where tenant_id=${fixture.tenantId} order by started_at desc limit 32`;
                const privacy = fixture.diagnostics.get('privacy');
                const symmy = fixture.diagnostics.get(symmyApp);
                yield* Effect.logError({
                  deliveries,
                  invocations,
                  privacy: privacy === undefined ? '' : yield* privacy,
                  shell: yield* fixture.shell
                    .gatewayDiagnostics()
                    .pipe(Effect.timeoutOption(Duration.seconds(2)), Effect.map(Option.getOrElse(() => []))),
                  stage: 'native-privacy-dispatch-failure',
                  symmy: symmy === undefined ? '' : yield* symmy,
                  worker: yield* fixture.worker.diagnostic,
                });
              }).pipe(
                Effect.catchCause(() => Effect.logError({ stage: 'native-privacy-dispatch-diagnostic-unavailable' })),
              )
            : Effect.void,
        );
        expect(fixture.companyOnlyAssignments).toEqual({ companies: 1, tenants: 0 });
        const positive = yield* fixture.submit('INTERNAL_PRIVACY_DISPATCH_POSITIVE');
        const positiveJobId = positive.receipt.jobId;
        const ready = yield* observePrivacyDispatchUntil(
          'The actual source owner command did not settle before governance dispatch',
          observation(fixture.admin, fixture.tenantId, positiveJobId),
          ({ effects, settled }) => effects > 0 && effects === settled,
        );
        expect(ready.private_present).toBe(true);
        expect(Option.isSome(ready.admission_id)).toBe(true);
        expect(Option.getOrNull(ready.fence)).toBe('open');
        expect(ready.owner_commands).toBe(1);
        expect(Option.getOrNull(ready.source_action)).toBe('integration.symmy.admit-symmy-job');
        expect(Option.getOrNull(ready.source_status)).toBe('succeeded');
        yield* Effect.logInfo({ stage: 'privacy-dispatch-source-settled' });
        const target = `integration.symmy.job:${positiveJobId}`;
        const governance = yield* seedMeasureExecutionNativeFixture({
          connections: fixture.isolated.connections,
          contentScopeRef: `${target}#integration.symmy.job-intent`,
          governancePrincipalId: fixture.human.principalId,
          legalEntityId: fixture.legalEntityId,
          resourceRef: target,
          tenantId: fixture.tenantId,
        });
        const dispatch = Effect.fn('PrivacyDispatchNative.dispatch')(function* dispatch(
          handoff: typeof PrivacyMeasureHandoffSchema.Type,
          idempotencyKey: string,
        ) {
          const gateway = yield* fixture.shell.issueFixtureSetupGateway({
            audience: 'privacy',
            legalEntityId: fixture.legalEntityId,
          });
          // Verify the genuine issued assertion without redeeming, changing or constructing any authority.
          const jwks = yield* Schema.decodeUnknownEffect(Schema.fromJsonString(publicJwksSchema))(
            fixture.shell.publicJwks,
          );
          const verified = yield* Effect.tryPromise({
            catch: (cause) =>
              Object.defineProperty(
                new PrivacyDispatchNativeFailure({ reason: 'Actual Privacy assertion signature verification failed' }),
                'cause',
                { value: Redacted.make(cause) },
              ),
            try: () =>
              jwtVerify(gateway.token, createLocalJWKSet({ keys: [...jwks.keys] }), {
                algorithms: ['EdDSA'],
                audience: 'privacy',
                issuer: fixture.shell.issuer,
              }),
          });
          const claims = yield* Schema.decodeUnknownEffect(GatewayContextV2ClaimsSchema)(verified.payload);
          expect(claims.principal.legalEntityId).toBe(fixture.legalEntityId);
          expect(claims.principal.principalId).toBe(fixture.human.principalId);
          const result = yield* executeDispatchPrivacyMeasureWithAuthorization(
            { handoff },
            `Bearer ${gateway.token}`,
            `INTERNAL_PRIVACY_DISPATCH:${handoff.measureId}`,
            {
              baseUrl: new URL('/privacy-api', `http://127.0.0.1:${fixture.ports.get('privacy')}/`),
              compositionRevision: fixture.snapshot.composition.revision,
              idempotencyKey,
            },
          ).pipe(
            Effect.tapError((cause) =>
              Effect.gen(function* safeDispatchDiagnostics() {
                const code = Schema.decodeUnknownOption(Schema.Struct({ code: Schema.optionalKey(Schema.String) }))(
                  cause,
                );
                const owner = fixture.diagnostics.get('privacy');
                const invocations = yield* fixture.admin<{
                  action_key: string;
                  status: string;
                }>`select action_key,status from core.action_invocations where tenant_id=${fixture.tenantId} order by started_at`;
                yield* Effect.logError({
                  code: Option.isSome(code) ? code.value.code : 'typed-transport-failure',
                  invocations,
                  owner: owner === undefined ? 'no-owner-diagnostic' : yield* owner,
                  shell: yield* fixture.shell.gatewayDiagnostics(),
                });
              }),
            ),
          );
          assert.isTrue(Schema.is(PrivacyMeasureHandoffSchema)(result));
          // The signature remains valid; native one-use redemption must reject a second use before business replay.
          const reusedNonce = yield* executeDispatchPrivacyMeasureWithAuthorization(
            { handoff },
            `Bearer ${gateway.token}`,
            `INTERNAL_PRIVACY_DISPATCH:${handoff.measureId}`,
            {
              baseUrl: new URL('/privacy-api', `http://127.0.0.1:${fixture.ports.get('privacy')}/`),
              compositionRevision: fixture.snapshot.composition.revision,
              idempotencyKey,
            },
          ).pipe(
            Effect.as(false),
            Effect.catchTag('DispatchPrivacyMeasureActionAuthenticationProblem', () => Effect.succeed(true)),
          );
          expect(reusedNonce).toBe(true);
          return result;
        });
        yield* dispatch(governance.handoff, 'INTERNAL_PRIVACY_DISPATCH_COORDINATOR_FIRST');
        const dispatchEvidence = yield* governance.observe();
        if (Option.isNone(dispatchEvidence.dispatch)) {
          return yield* new PrivacyDispatchNativeFailure({
            reason: 'The actual dispatch did not retain its source evidence',
          });
        }
        expect(dispatchEvidence.dispatch.value.compositionRevision).toBe(fixture.snapshot.composition.revision);
        expect(dispatchEvidence.dispatch.value.invocationId).not.toBeNull();
        const permissionAttempt = yield* observePrivacyDispatchUntil(
          'The actual consumer did not attempt the company-only permission boundary',
          refusedRetention(fixture.admin, fixture.tenantId),
          ({ failures, refused }) => failures > 0 || refused > 0,
        );
        const gatewayDenied = (yield* fixture.shell
          .gatewayDiagnostics()
          .pipe(Effect.timeoutOption(Duration.seconds(2)), Effect.map(Option.getOrElse(() => [])))).some(
          ({ problem, status }) => status === 403 && problem !== 'success',
        );
        const symmyDiagnostic = fixture.diagnostics.get(symmyApp);
        const ownerDenied =
          symmyDiagnostic !== undefined &&
          (yield* symmyDiagnostic)
            .split('\n')
            .some((line) => Option.isSome(Schema.decodeUnknownOption(retentionDeniedDiagnosticSchema)(line)));
        if (permissionAttempt.refused === 0 && !gatewayDenied && !ownerDenied) {
          return yield* new PrivacyDispatchNativeFailure({
            reason: 'The actual consumer failed before reaching the protected retention permission boundary',
          });
        }
        const denied = yield* observation(fixture.admin, fixture.tenantId, positiveJobId);
        expect(denied.private_present).toBe(true);
        expect(denied.tombstones).toBe(0);
        expect(Option.getOrNull(denied.fence)).toBe('open');
        yield* Effect.logInfo({ stage: 'privacy-dispatch-company-only-denied' });
        // This native access grant is written and projected through Core; no gate or HTTP response is replaced.
        yield* fixture.grantHuman(true);
        yield* Effect.logInfo({ stage: 'privacy-dispatch-tenant-grant-projected' });
        const nativeReceiptObservation = governance.observe().pipe(
          Effect.tap(() =>
            Effect.gen(function* failOnNativeInternalProblem() {
              const problems = yield* ownerProblems(symmyDiagnostic);
              if (
                problems.some(
                  ({ problem, status }) => status === 500 && problem === 'ExecuteSymmyRetentionActionInternalProblem',
                )
              ) {
                yield* Effect.logError({
                  privacy: yield* ownerProblems(fixture.diagnostics.get('privacy')),
                  stage: 'privacy-dispatch-retention-internal-failure',
                  symmy: symmyDiagnostic === undefined ? '' : yield* symmyDiagnostic,
                });
                return yield* new PrivacyDispatchNativeFailure({
                  reason: 'The actual retention handler returned an internal Problem',
                });
              }
              return yield* Effect.void;
            }),
          ),
        );
        yield* observePrivacyDispatchUntil(
          'The actual consumer did not durably report its successful native owner receipt',
          nativeReceiptObservation,
          ({ outcomes }) => outcomes.some(({ status }) => status === 'SUCCEEDED'),
        );
        const erased = yield* observation(fixture.admin, fixture.tenantId, positiveJobId);
        expect(erased.private_present).toBe(false);
        expect(erased.tombstones).toBe(1);
        expect(Option.getOrNull(erased.fence)).toBe('cancelled');
        expect(erased.admission_id).toEqual(ready.admission_id);
        expect(erased.owner_commands).toBe(1);
        const [audited] = yield* fixture.admin`select e.action_invocation_id,e.legal_entity_id,e.principal_id,
          e.serving_module_key,e.target_module_key,e.target_resource_type,e.target_resource_id,
          e.evidence_capture_mode,e.evidence_payload_json,e.query_hash
          from core.data_access_events e join symmy_integration.privacy_measure_executions p
            on p.tenant_id=e.tenant_id and p.action_invocation_id=e.action_invocation_id
          where p.tenant_id=${fixture.tenantId} and p.resource_id=${positiveJobId} and p.outcome->>'status'='SUCCEEDED'`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(dataAccessSchema)),
        );
        expect(audited.target_resource_id).toBe(positiveJobId);
        expect(audited.legal_entity_id).toBe(fixture.legalEntityId);
        expect(audited.principal_id).toBe(fixture.human.principalId);
        expect(audited.query_hash).toContain(`data-target:TENANT:privacy-governance:${fixture.legalEntityId}`);
        yield* Effect.logInfo({ stage: 'privacy-dispatch-native-purge-reported' });
        const completed = yield* governance.observe();
        expect(JSON.stringify(completed.outcomes)).not.toContain(privateIntentMarker);
        expect(completed.outcomes).toMatchObject([
          { includedResourceRefs: [target], remainingResourceRefs: [], status: 'SUCCEEDED' },
        ]);
        const beforeReplay = yield* emittedDispatches(fixture.admin, fixture.tenantId);
        yield* dispatch(governance.handoff, 'INTERNAL_PRIVACY_DISPATCH_COORDINATOR_REPLAY');
        expect(yield* emittedDispatches(fixture.admin, fixture.tenantId)).toBe(beforeReplay);
        const replay = yield* fixture.client.post(`${fixture.shell.baseUrl}/api/symmy/v1/products/batch`, {
          body: yield* HttpBody.json(positive.payload),
          headers: {
            'idempotency-key': 'INTERNAL_PRIVACY_DISPATCH_POSITIVE',
            'x-api-key': Redacted.value(fixture.sourceKey.secret),
          },
        });
        expect(replay.status).toBe(202);
        const replayed = yield* replay.json.pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.Struct({
                jobId: SymmyJobStatusResponseSchema.members[0].fields.jobId,
                status: Schema.Literal('admitted'),
              }),
            ),
          ),
        );
        expect(replayed.jobId).toBe(positiveJobId);
        expect((yield* observation(fixture.admin, fixture.tenantId, positiveJobId)).owner_commands).toBe(1);

        const protectedJob = yield* fixture.submit('INTERNAL_PRIVACY_DISPATCH_HOLD');
        const protectedJobId = protectedJob.receipt.jobId;
        yield* observePrivacyDispatchUntil(
          'The second actual source owner command did not settle',
          observation(fixture.admin, fixture.tenantId, protectedJobId),
          ({ effects, settled }) => effects > 0 && effects === settled,
        );
        const protectedTarget = `integration.symmy.job:${protectedJobId}`;
        const held = yield* seedMeasureExecutionNativeFixture({
          connections: fixture.isolated.connections,
          contentScopeRef: `${protectedTarget}#integration.symmy.job-intent`,
          governancePrincipalId: fixture.human.principalId,
          legalEntityId: fixture.legalEntityId,
          resourceRef: protectedTarget,
          tenantId: fixture.tenantId,
        });
        yield* held.setHold(true);
        yield* dispatch(held.handoff, 'INTERNAL_PRIVACY_DISPATCH_COORDINATOR_HOLD');
        yield* observePrivacyDispatchUntil(
          'The fresh native hold did not block the actual retention attempt',
          held.observe(),
          ({ outcomes }) => outcomes.some(({ status }) => status === 'BLOCKED'),
        );
        const blocked = yield* observation(fixture.admin, fixture.tenantId, protectedJobId);
        expect(blocked.private_present).toBe(true);
        expect(blocked.tombstones).toBe(0);
        expect(Option.getOrNull(blocked.fence)).toBe('open');
        expect(blocked.owner_commands).toBe(2);
        yield* Effect.logInfo({ stage: 'privacy-dispatch-current-hold-reported' });
        yield* held.setHold(false);
        yield* observePrivacyDispatchUntil(
          'The retained blocked handoff did not recheck current hold state and finish through the actual consumer',
          held.observe(),
          ({ outcomes }) => outcomes.some(({ status }) => status === 'SUCCEEDED'),
        );
        const afterHold = yield* observation(fixture.admin, fixture.tenantId, protectedJobId);
        expect(afterHold.private_present).toBe(false);
        expect(afterHold.tombstones).toBe(1);
        expect(Option.getOrNull(afterHold.fence)).toBe('cancelled');
        expect(afterHold.owner_commands).toBe(2);
        yield* Effect.logInfo({ stage: 'privacy-dispatch-released-hold-reported' });
        const heldReceipt = yield* held.observe();
        expect(heldReceipt.outcomes.map(({ status }) => status)).toEqual(['BLOCKED', 'SUCCEEDED']);

        // A current hold arriving while cancellation waits must invalidate the earlier authority check.
        expect((yield* ownerProblems(symmyDiagnostic)).some(Schema.is(retentionConflictSummarySchema))).toBe(false);
        yield* Effect.logInfo({ stage: 'privacy-dispatch-no-earlier-retention-conflict' });
        const racedJob = yield* fixture.submit('INTERNAL_PRIVACY_DISPATCH_HOLD_RACE');
        const racedJobId = racedJob.receipt.jobId;
        const racedReady = yield* observePrivacyDispatchUntil(
          'The concurrent-hold source owner command did not settle',
          observation(fixture.admin, fixture.tenantId, racedJobId),
          ({ effects, settled }) => effects > 0 && effects === settled,
        );
        const racedTarget = `integration.symmy.job:${racedJobId}`;
        const raced = yield* seedMeasureExecutionNativeFixture({
          connections: fixture.isolated.connections,
          contentScopeRef: `${racedTarget}#integration.symmy.job-intent`,
          governancePrincipalId: fixture.human.principalId,
          legalEntityId: fixture.legalEntityId,
          resourceRef: racedTarget,
          tenantId: fixture.tenantId,
        });
        const [{ started }] = yield* fixture.admin`select clock_timestamp()::text as started`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(startedSchema)),
        );
        const waitingInvocation = yield* fixture.admin.withTransaction(
          Effect.gen(function* realSourceFenceBarrier() {
            const [{ backend }] = yield* fixture.admin`select pg_backend_pid() as backend`.pipe(
              Effect.flatMap(Schema.decodeUnknownEffect(backendSchema)),
            );
            const locked = yield* fixture.admin`select admission_invocation_id from core.source_execution_fences
              where tenant_id=${fixture.tenantId} and admission_invocation_id=${Option.getOrNull(racedReady.admission_id)} and state='open' for share`;
            expect(locked).toHaveLength(1);
            yield* dispatch(raced.handoff, 'INTERNAL_PRIVACY_DISPATCH_COORDINATOR_HOLD_RACE');
            yield* observePrivacyDispatchUntil(
              'The actual retention cancellation did not wait for the native source execution SHARE lock',
              fixture.admin`select exists(select 1 from pg_stat_activity where ${backend}=any(pg_blocking_pids(pid))) as blocked`.pipe(
                Effect.flatMap(Schema.decodeUnknownEffect(barrierSchema)),
                Effect.map(([row]) => row.blocked),
              ),
              (isWaiting) => isWaiting,
            );
            yield* Effect.logInfo({ stage: 'privacy-dispatch-cancellation-waiting-on-share' });
            const [invocation] = yield* fixture.admin`select action_invocation_id as invocation_id,status
              from core.action_invocations where tenant_id=${fixture.tenantId}
                and action_key='integration.symmy.execute-symmy-retention' and started_at>=${started}::timestamptz
              order by started_at`.pipe(Effect.flatMap(Schema.decodeUnknownEffect(retainedInvocationSchema)));
            yield* raced.setHold(true);
            yield* Effect.logInfo({ stage: 'privacy-dispatch-concurrent-hold-committed' });
            return invocation;
          }),
        );
        yield* observePrivacyDispatchUntil(
          'The changed current hold did not reject the blocked cancellation with its declared conflict',
          ownerProblems(symmyDiagnostic),
          (problems) => problems.some(Schema.is(retentionConflictSummarySchema)),
        );
        const [rolledBack] = yield* fixture.admin`select a.status,
            (select count(*)::integer from symmy_integration.privacy_measure_executions r
              where r.tenant_id=a.tenant_id and r.action_invocation_id=a.action_invocation_id) as receipts
            from core.action_invocations a where a.tenant_id=${fixture.tenantId}
              and a.action_invocation_id=${waitingInvocation.invocation_id}`.pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(rollbackSchema)),
        );
        expect(rolledBack.status).not.toBe('succeeded');
        expect(rolledBack.receipts).toBe(0);
        yield* observePrivacyDispatchUntil(
          'The next actual delivery did not truthfully report the newly active hold',
          raced.observe(),
          ({ outcomes }) => outcomes.some(({ status }) => status === 'BLOCKED'),
        );
        const afterRace = yield* observation(fixture.admin, fixture.tenantId, racedJobId);
        expect(afterRace.private_present).toBe(true);
        expect(afterRace.tombstones).toBe(0);
        expect(Option.getOrNull(afterRace.fence)).toBe('open');
        expect(afterRace.owner_commands).toBe(3);
        return yield* Effect.void;
      }),
    ).pipe(
      Effect.provide(services),
      Effect.mapError((cause) =>
        Schema.is(PrivacyDispatchNativeFailure)(cause)
          ? cause
          : new PrivacyDispatchNativeFailure({
              cause: Redacted.make(cause),
              reason: 'The actual Privacy dispatch integration failed; inspect the bounded diagnostic evidence',
            }),
      ),
    ),
  360_000,
);
