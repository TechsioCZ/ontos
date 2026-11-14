import { NodeServices } from '@effect/platform-node';
import { ActionAuthority } from '@app/core-runtime/actions/runtime-wiring';
import { Effect, FileSystem, Option, Ref, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { callerModuleAccess, emptyCallerAccessTrace } from '../../api/agent-platform/caller.ts';
import { accessAdminTemplateLayer } from '../support/access-admin-real-gate-fixture.ts';
import {
  actionsOneAtATime,
  callerAccessOneAtATime,
  installedComposition,
  measured,
  queueReadActionKeys,
  reportOf,
  reportPath,
  sessionScope,
  sorted,
  withAuthorityCase,
} from './agent-caller-authority-full-catalog.fixture.ts';

it.layer(accessAdminTemplateLayer, { excludeTestServices: true, timeout: '900 seconds' })(
  'agent platform caller authority over the installed release',
  (suite) => {
    suite.effect(
      "asks a tenant owner's caller authority and a queue read's Action authority in batches, with identical answers and evidence",
      () =>
        withAuthorityCase('work.tasks', (authorityCase) =>
          Effect.gen(function* batchedCallerAuthority() {
            const snapshot = yield* installedComposition;
            const { companyId, owner, tenantId } = authorityCase;
            const ownerScope = (correlationId: string) =>
              sessionScope({ correlationId, legalEntityId: companyId, principalId: owner, tenantId });

            // (a) one caller authority load.
            const trace = yield* Ref.make(emptyCallerAccessTrace);
            const callerScope = yield* ownerScope('caller-authority-batch');
            const caller = yield* measured({
              authorityCase,
              correlationId: 'caller-authority-batch',
              read: callerModuleAccess({ scope: callerScope }, trace),
              snapshot,
            });
            const callerBefore = yield* measured({
              authorityCase,
              correlationId: 'caller-authority-single',
              read: callerAccessOneAtATime(yield* ownerScope('caller-authority-single')),
              snapshot,
            });
            // Every module of the release is installed and active in this tenant, so the filter removes nothing here.
            expect(sorted(caller.value.access)).toEqual(sorted(callerBefore.value.access));
            expect(sorted(caller.value.propose)).toEqual(sorted(callerBefore.value.propose));
            expect(sorted(caller.value.write)).toEqual(sorted(callerBefore.value.write));
            expect(caller.decisionRows).toBeGreaterThan(0);
            expect(caller.decisionRows).toBe(callerBefore.decisionRows);
            expect(caller.decisionRowContents).toEqual(callerBefore.decisionRowContents);
            expect(caller.transactions).toBeLessThan(callerBefore.transactions);

            // (b) the Action authority one proposal queue read asks; a decide runs that read twice.
            const queueScope = yield* ownerScope('queue-authority-batch');
            const queue = yield* measured({
              authorityCase,
              correlationId: 'queue-authority-batch',
              read: Effect.gen(function* batchedQueueAuthority() {
                const actionKeys = yield* queueReadActionKeys;
                return yield* (yield* ActionAuthority).checkActionAuthorities({ actionKeys, scope: queueScope });
              }),
              snapshot,
            });
            const queueBefore = yield* measured({
              authorityCase,
              correlationId: 'queue-authority-single',
              read: Effect.gen(function* singleQueueAuthority() {
                return yield* actionsOneAtATime(
                  yield* queueReadActionKeys,
                  yield* ownerScope('queue-authority-single'),
                );
              }),
              snapshot,
            });
            expect(queue.value).toEqual(queueBefore.value);
            expect(queue.decisionRows).toBe(queueBefore.decisionRows);
            expect(queue.decisionRowContents).toEqual(queueBefore.decisionRowContents);
            expect(queue.transactions).toBeLessThan(queueBefore.transactions);

            const path = yield* reportPath;
            if (Option.isSome(path)) {
              const fileSystem = yield* FileSystem.FileSystem;
              yield* fileSystem.writeFileString(
                path.value,
                yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))({
                  caller: { after: reportOf(caller), before: reportOf(callerBefore) },
                  modules: snapshot.composition.modules.length,
                  queue: { after: reportOf(queue), before: reportOf(queueBefore) },
                  queueActions: queue.value.length,
                  trace: yield* Ref.get(trace),
                }),
              );
            }
          }).pipe(Effect.provide(NodeServices.layer)),
        ),
      900_000,
    );
  },
);
