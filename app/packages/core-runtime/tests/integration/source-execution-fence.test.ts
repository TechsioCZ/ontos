import { NodeServices } from '@effect/platform-node';
import { Crypto, Deferred, Effect, Exit, Fiber, Layer } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import { makeIsolatedNativeDatabaseFixture } from '../../src/testing/isolated-native-database.ts';
import { makeTestPgClient, makeTestPgSession } from '../support/database.ts';
import {
  freshOutboxWorkerCompositionSnapshot,
  makeOutboxWorkerComposition,
} from '../support/outbox-worker-composition.ts';

it.layer(Layer.mergeAll(NodeServices.layer, TestClock.layer()), { excludeTestServices: true })(
  'Native source execution fence',
  (suite) => {
    suite.effect('orders enrollment deactivation with receiving writes and only reopens the exact enrollment', () =>
      Effect.scoped(
        Effect.gen(function* gateRevocationBarrier() {
          const crypto = yield* Crypto.Crypto;
          const snapshot = yield* freshOutboxWorkerCompositionSnapshot(
            makeOutboxWorkerComposition([
              { appId: 'source-gate-proof', buildMarker: 'source-gate-proof', moduleId: 'core.shell' },
            ]),
          );
          const fixture = yield* makeIsolatedNativeDatabaseFixture({
            compositionSnapshot: snapshot,
            mode: 'schema-only',
            purpose: 'implementation-1096-registered-workload-gateway',
          });
          const admin = yield* makeTestPgClient(fixture.connections.admin.connectionString);
          const publisher = yield* makeTestPgSession(fixture.connections.admin.connectionString);
          const owner = yield* makeTestPgSession(fixture.connections.runtime.connectionString);
          const tenantId = yield* crypto.randomUUIDv4();
          const gateId = yield* crypto.randomUUIDv4();
          const legacyAdmissionId = yield* crypto.randomUUIDv4();
          const freshAdmissionId = yield* crypto.randomUUIDv4();
          const principalId = yield* crypto.randomUUIDv4();
          const actionKey = 'core.shell.admit-gated-fixture';
          const ownerKey = 'core.shell';
          const publishStatement = 'select trust.publish_source_execution_gate($1,$2,$3,$4,null,$5,$6,$7,$8)';
          const publish = (active: boolean, replaceEnrollment = false) =>
            publisher.unsafe(publishStatement, [
              tenantId,
              gateId,
              ownerKey,
              principalId,
              'revision-1',
              'mapping-1',
              active,
              replaceEnrollment,
            ]);
          const admitWithoutGate = (admissionId: string) =>
            owner.unsafe<{ readonly allowed: boolean }>('select * from trust.open_source_execution_fence($1,$2)', [
              tenantId,
              admissionId,
            ]);
          const tryWrite = (admissionId: string) =>
            owner.unsafe<{ readonly allowed: boolean }>('select trust.lock_source_execution_fence($1,$2) as allowed', [
              tenantId,
              admissionId,
            ]);
          const setOwnerScope = owner.unsafe("select set_config('ontos.tenant_id',$1,true)", [tenantId]);
          const currentWriteAllowed = (admissionId: string) =>
            owner.withTransaction(setOwnerScope.pipe(Effect.andThen(tryWrite(admissionId))));

          yield* admin.unsafe(
            "insert into core.tenants(tenant_id,slug,name,status,default_locale) values($1,$2,'Gate proof','active','cs')",
            [tenantId, `gate-${tenantId}`],
          );
          yield* admin.unsafe(
            "insert into core.principals(principal_id,tenant_id,kind,status,display_name) values($1,$2,'integration','active','Gate original')",
            [principalId, tenantId],
          );
          for (const admissionId of [legacyAdmissionId, freshAdmissionId]) {
            yield* admin.unsafe(
              "insert into core.action_invocations(action_invocation_id,tenant_id,principal_id,action_key,status,request_hash) values($1,$2,$3,$4,'running',$5)",
              [admissionId, tenantId, principalId, actionKey, 'a'.repeat(64)],
            );
          }
          expect(
            yield* owner.withTransaction(setOwnerScope.pipe(Effect.andThen(admitWithoutGate(legacyAdmissionId)))),
          ).toEqual([{ allowed: true }]);
          yield* admin.unsafe("update core.action_invocations set status='succeeded' where action_invocation_id=$1", [
            legacyAdmissionId,
          ]);
          yield* admin.unsafe('select trust.register_source_execution_gated_action($1,$2)', [actionKey, ownerKey]);
          yield* publish(true);
          expect(yield* currentWriteAllowed(legacyAdmissionId)).toEqual([{ allowed: false }]);
          expect(
            yield* owner.withTransaction(setOwnerScope.pipe(Effect.andThen(admitWithoutGate(freshAdmissionId)))),
          ).toEqual([{ allowed: false }]);
          const admitWithGate = (mappingVersion: string) =>
            owner.withTransaction(
              setOwnerScope.pipe(
                Effect.andThen(
                  owner.unsafe('select * from trust.open_source_execution_fence($1,$2,$3,$4,$5)', [
                    tenantId,
                    freshAdmissionId,
                    gateId,
                    'revision-1',
                    mappingVersion,
                  ]),
                ),
              ),
            );
          expect(yield* admitWithGate('wrong-mapping')).toEqual([{ allowed: false }]);
          expect(yield* admitWithGate('mapping-1')).toEqual([{ allowed: true }]);
          yield* admin.unsafe("update core.action_invocations set status='succeeded' where action_invocation_id=$1", [
            freshAdmissionId,
          ]);
          const authority = yield* owner.unsafe(
            `select has_function_privilege(current_user,
                 'trust.publish_source_execution_gate(uuid,uuid,text,uuid,uuid,text,text,boolean,boolean)','EXECUTE')
                 as publish,
                 has_table_privilege(current_user,'core.source_execution_gates','UPDATE') as update_gate,
                 has_table_privilege(current_user,'core.source_execution_gate_actions','DELETE') as delete_policy,
                 has_table_privilege(current_user,'core.source_execution_fences','UPDATE') as update_fence`,
          );
          expect(authority).toEqual([
            { delete_policy: false, publish: false, update_fence: false, update_gate: false },
          ]);

          const held = yield* Deferred.make<number>();
          const release = yield* Deferred.make<string>();
          const publishing = yield* Deferred.make<number>();
          const ownerWrite = yield* Effect.forkChild(
            owner.withTransaction(
              Effect.gen(function* holdGateThroughCommit() {
                yield* setOwnerScope;
                expect(yield* tryWrite(freshAdmissionId)).toEqual([{ allowed: true }]);
                const [backend] = yield* owner.unsafe<{ readonly pid: number }>('select pg_backend_pid() as pid');
                expect(backend).toBeDefined();
                if (backend !== undefined) {
                  yield* Deferred.succeed(held, backend.pid);
                }
                yield* Deferred.await(release);
              }),
            ),
          );
          const ownerPid = yield* Deferred.await(held);
          const revoke = yield* Effect.forkChild(
            publisher.withTransaction(
              Effect.gen(function* deactivateEnrolledGate() {
                const [backend] = yield* publisher.unsafe<{ readonly pid: number }>('select pg_backend_pid() as pid');
                expect(backend).toBeDefined();
                if (backend !== undefined) {
                  yield* Deferred.succeed(publishing, backend.pid);
                }
                yield* publish(false);
              }),
            ),
          );
          const publisherPid = yield* Deferred.await(publishing);
          yield* admin
            .unsafe<{ readonly blocked: boolean }>(
              'select $1::integer = any(pg_blocking_pids($2::integer)) as blocked',
              [ownerPid, publisherPid],
            )
            .pipe(Effect.repeat({ until: (rows) => rows[0]?.blocked === true }), Effect.timeout('5 seconds'));
          yield* Deferred.succeed(release, 'released');
          yield* Fiber.join(ownerWrite);
          yield* Fiber.join(revoke);
          expect(yield* currentWriteAllowed(freshAdmissionId)).toEqual([{ allowed: false }]);
          const historical = yield* owner.withTransaction(
            setOwnerScope.pipe(
              Effect.andThen(
                owner.unsafe('select fence_state from trust.read_source_execution_fence($1,$2)', [
                  tenantId,
                  freshAdmissionId,
                ]),
              ),
            ),
          );
          expect(historical).toEqual([{ fence_state: 'open' }]);
          yield* publish(true);
          expect(yield* currentWriteAllowed(freshAdmissionId)).toEqual([{ allowed: true }]);
          yield* publish(true, true);
          expect(yield* currentWriteAllowed(freshAdmissionId)).toEqual([{ allowed: false }]);
        }),
      ).pipe(TestClock.withLive),
    );
    suite.effect(
      'waits for an actual in-flight owner transaction and rejects a stale admission after cancellation',
      () =>
        Effect.scoped(
          Effect.gen(function* sourceExecutionFenceBarrier() {
            const crypto = yield* Crypto.Crypto;
            const snapshot = yield* freshOutboxWorkerCompositionSnapshot(
              makeOutboxWorkerComposition([
                { appId: 'source-fence-proof', buildMarker: 'source-fence-proof', moduleId: 'core.shell' },
              ]),
            );
            const fixture = yield* makeIsolatedNativeDatabaseFixture({
              compositionSnapshot: snapshot,
              mode: 'schema-only',
              purpose: 'implementation-1096-registered-workload-gateway',
            });
            const admin = yield* makeTestPgClient(fixture.connections.admin.connectionString);
            const owner = yield* makeTestPgSession(fixture.connections.runtime.connectionString);
            const retention = yield* makeTestPgSession(fixture.connections.runtime.connectionString);
            const proofReader = yield* makeTestPgSession(fixture.connections.runtime.connectionString);
            const tenantId = yield* crypto.randomUUIDv4();
            const otherTenant = yield* crypto.randomUUIDv4();
            const admissionId = yield* crypto.randomUUIDv4();
            const originalPrincipalId = yield* crypto.randomUUIDv4();
            yield* admin.unsafe(
              "insert into core.tenants(tenant_id,slug,name,status,default_locale) values($1,$2,'Fence proof','active','cs')",
              [tenantId, `fence-${tenantId}`],
            );
            yield* admin.unsafe(
              "insert into core.principals(principal_id,tenant_id,kind,status,display_name) values($1,$2,'integration','active','Fence original')",
              [originalPrincipalId, tenantId],
            );
            yield* admin.unsafe(
              "insert into core.action_invocations(action_invocation_id,tenant_id,principal_id,action_key,status,request_hash) values($1,$2,$4,'core.shell.admit-fixture','running',$3)",
              [admissionId, tenantId, 'a'.repeat(64), originalPrincipalId],
            );
            yield* proofReader.withTransaction(
              Effect.gen(function* runningAdmissionIsNotProof() {
                yield* proofReader.unsafe("select set_config('ontos.tenant_id',$1,true)", [tenantId]);
                expect(
                  yield* proofReader.unsafe('select * from trust.read_source_execution_fence($1,$2)', [
                    tenantId,
                    admissionId,
                  ]),
                ).toEqual([]);
              }),
            );
            yield* owner.withTransaction(
              Effect.gen(function* openFenceInAdmissionTransaction() {
                yield* owner.unsafe("select set_config('ontos.tenant_id',$1,true)", [tenantId]);
                expect(
                  (yield* owner.unsafe<{ readonly allowed: boolean }>(
                    'select * from trust.open_source_execution_fence($1,$2)',
                    [tenantId, admissionId],
                  ))[0]?.allowed,
                ).toBe(true);
              }),
            );
            yield* admin.unsafe("update core.action_invocations set status='succeeded' where action_invocation_id=$1", [
              admissionId,
            ]);
            yield* owner.withTransaction(
              Effect.gen(function* verifyScopedReadRoutineColumn() {
                yield* owner.unsafe("select set_config('ontos.tenant_id',$1,true)", [tenantId]);
                const rows = yield* owner.unsafe<{ readonly lock_source_execution_fence: boolean }>(
                  'select * from trust.lock_source_execution_fence($1,$2)',
                  [tenantId, admissionId],
                );
                expect(rows).toEqual([{ lock_source_execution_fence: true }]);
              }),
            );
            const holding = yield* Deferred.make<number>();
            const release = yield* Deferred.make<string>();
            const waiter = yield* Deferred.make<number>();
            const ownerFiber = yield* Effect.forkChild(
              owner.withTransaction(
                Effect.gen(function* holdFenceThroughOwnerCommit() {
                  yield* owner.unsafe("select set_config('ontos.tenant_id',$1,true)", [tenantId]);
                  const pid = (yield* owner.unsafe<{ readonly pid: number }>('select pg_backend_pid() as pid'))[0]?.pid;
                  if (pid === undefined) {
                    throw new Error('Missing owner backend');
                  }
                  expect(
                    (yield* owner.unsafe<{ readonly allowed: boolean }>(
                      'select trust.lock_source_execution_fence($1,$2) as allowed',
                      [tenantId, admissionId],
                    ))[0]?.allowed,
                  ).toBe(true);
                  yield* Deferred.succeed(holding, pid);
                  yield* Deferred.await(release);
                }),
              ),
            );
            const holderPid = yield* Deferred.await(holding);
            const cancellation = yield* Effect.forkChild(
              retention.withTransaction(
                Effect.gen(function* cancelBeforePayloadPurge() {
                  yield* retention.unsafe("select set_config('ontos.tenant_id',$1,true)", [tenantId]);
                  const pid = (yield* retention.unsafe<{ readonly pid: number }>('select pg_backend_pid() as pid'))[0]
                    ?.pid;
                  if (pid === undefined) {
                    throw new Error('Missing cancellation backend');
                  }
                  yield* Deferred.succeed(waiter, pid);
                  const rows = yield* retention.unsafe<{ readonly allowed: boolean }>(
                    'select * from trust.cancel_source_execution_fence($1,$2)',
                    [tenantId, admissionId],
                  );
                  expect(rows[0]?.allowed).toBe(true);
                }),
              ),
            );
            const waiterPid = yield* Deferred.await(waiter);
            yield* admin
              .unsafe<{ readonly blocked: boolean }>(
                'select $1::integer = any(pg_blocking_pids($2::integer)) as blocked',
                [holderPid, waiterPid],
              )
              .pipe(Effect.repeat({ until: (rows) => rows[0]?.blocked === true }), Effect.timeout('5 seconds'));
            // Cancellation cannot return and purge while the actual owner transaction is in flight.
            expect(
              (yield* admin.unsafe<{ readonly state: string }>(
                'select state from core.source_execution_fences where tenant_id=$1 and admission_invocation_id=$2',
                [tenantId, admissionId],
              ))[0]?.state,
            ).toBe('open');
            // The cancellation is already queued for this row. A new SHARE lock here would deadlock a nested owner proof.
            yield* proofReader.withTransaction(
              Effect.gen(function* nestedSnapshotDoesNotQueueBehindCancellation() {
                yield* proofReader.unsafe("select set_config('ontos.tenant_id',$1,true)", [tenantId]);
                yield* proofReader.unsafe("set local statement_timeout='1000ms'");
                expect(
                  yield* proofReader.unsafe('select * from trust.read_source_execution_fence($1,$2)', [
                    tenantId,
                    admissionId,
                  ]),
                ).toEqual([
                  {
                    action_key: 'core.shell.admit-fixture',
                    admission_invocation_id: admissionId,
                    fence_state: 'open',
                    legal_entity_id: null,
                    original_principal_id: originalPrincipalId,
                  },
                ]);
              }),
            );
            yield* Deferred.succeed(release, 'released');
            yield* Fiber.join(ownerFiber);
            yield* Fiber.join(cancellation);
            yield* proofReader.withTransaction(
              Effect.gen(function* cancelledSnapshotRemainsFactual() {
                yield* proofReader.unsafe("select set_config('ontos.tenant_id',$1,true)", [tenantId]);
                expect(
                  (yield* proofReader.unsafe<{ readonly fence_state: string }>(
                    'select * from trust.read_source_execution_fence($1,$2)',
                    [tenantId, admissionId],
                  ))[0]?.fence_state,
                ).toBe('cancelled');
                expect(
                  yield* proofReader.unsafe('select * from trust.read_source_execution_fence($1,$2)', [
                    tenantId,
                    yield* crypto.randomUUIDv4(),
                  ]),
                ).toEqual([]);
                yield* proofReader.unsafe("select set_config('ontos.legal_entity_id',$1,true)", [originalPrincipalId]);
                expect(
                  yield* proofReader.unsafe('select * from trust.read_source_execution_fence($1,$2)', [
                    tenantId,
                    admissionId,
                  ]),
                ).toEqual([]);
              }),
            );
            yield* owner.withTransaction(
              Effect.gen(function* staleMintedAdmissionCannotStart() {
                yield* owner.unsafe("select set_config('ontos.tenant_id',$1,true)", [tenantId]);
                expect(
                  (yield* owner.unsafe<{ readonly allowed: boolean }>(
                    'select trust.lock_source_execution_fence($1,$2) as allowed',
                    [tenantId, admissionId],
                  ))[0]?.allowed,
                ).toBe(false);
                expect(
                  (yield* owner.unsafe<{ readonly allowed: boolean }>(
                    'select * from trust.open_source_execution_fence($1,$2)',
                    [tenantId, admissionId],
                  ))[0]?.allowed,
                ).toBe(false);
              }),
            );
            const foreignScope = yield* Effect.exit(
              owner.withTransaction(
                Effect.gen(function* foreignFenceRefusal() {
                  yield* owner.unsafe("select set_config('ontos.tenant_id',$1,true)", [otherTenant]);
                  return yield* owner.unsafe('select * from trust.cancel_source_execution_fence($1,$2)', [
                    tenantId,
                    admissionId,
                  ]);
                }),
              ),
            );
            expect(Exit.isFailure(foreignScope)).toBe(true);
          }),
        ).pipe(TestClock.withLive),
    );
  },
);
