import { Deferred, Effect, Fiber, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { attestOutboxWorkerHandlerContext } from '../../../../packages/core-runtime/src/outbox/definition.ts';
import {
  makeOutboxWorkerLegalEntityScopeFanout,
  makePostgresOutboxWorkerLegalEntityScopeBackend,
  OutboxWorkerLegalEntityScopeFanout,
} from '../../../../packages/core-runtime/src/outbox/legal-entity-scope-fanout.ts';
import { makeTestDatabase } from '../../../../packages/core-runtime/tests/support/database.ts';
import { CommitmentProtectionEffectRequestSchema } from '../../shared/domain/commitment-protection.ts';
import { OutboxPayloadSchema } from '../../shared/outbox/commerce-inventory-commitment-protection-establishment-requested-v1.ts';
import { makeCommitmentProtectionEstablishmentExecutionService } from '../../src/services/commitment-protection.service.ts';
import {
  commitmentProtectionLedgerIntent,
  inventoryEffectLedgerId,
} from '../../src/services/inventory-effect-ledger.service.ts';
import {
  CommitmentProtectionEstablishmentExecution,
  handleExecuteCommitmentProtectionEstablishment,
} from '../../src/workers/execute-commitment-protection-establishment.worker.ts';
import { makeInMemoryInventoryEffectLedger } from '../support/inventory-effect-ledger.ts';
import { buildInventoryOwnerAcceptanceBindingCorrectionLineage } from '../support/inventory-owner-acceptance-binding-correction.ts';

const revision = 'a'.repeat(64);
const legalEntityId = '12111111-1111-4111-8111-111111111111';
const requestedAt = '2026-09-25T10:10:00.000Z';

const exerciseWorkerFence = (retirePreparedRelease: boolean) =>
  Effect.gen(function* exerciseNativeWorkerAdmission() {
    const lineage = yield* buildInventoryOwnerAcceptanceBindingCorrectionLineage;
    const request = Schema.decodeUnknownSync(CommitmentProtectionEffectRequestSchema)({
      confirmation: lineage.confirmation,
      effectId: 'commitment-protection:worker-release-fence',
      legalEntityId,
      mutationId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      protectionRef: lineage.protection.ref,
      requestedAt,
      sourceActionInvocationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
    });
    const { tenantId } = request.confirmation.ref;
    const ledger = makeInMemoryInventoryEffectLedger(requestedAt);
    yield* ledger.claim(tenantId, inventoryEffectLedgerId(request.effectId), commitmentProtectionLedgerIntent(request));
    const preparedCommitted = yield* Deferred.make<null>();
    const resumePreparedWorker = yield* Deferred.make<null>();
    const statements: string[] = [];
    let activeRevision = revision;
    let transactionOpen = false;
    let admissions = 0;
    let commits = 0;
    let authorityCalls = 0;
    const database = yield* makeTestDatabase((statement) =>
      Effect.gen(function* executeNativePostgresProtocol() {
        statements.push(statement);
        if (/^begin/iu.test(statement)) {
          transactionOpen = true;
        }
        if (/^(?:commit|rollback)/iu.test(statement)) {
          transactionOpen = false;
        }
        if (/^commit/iu.test(statement)) {
          commits += 1;
          if (commits === 1 && retirePreparedRelease) {
            yield* Deferred.succeed(preparedCommitted, null);
            yield* Deferred.await(resumePreparedWorker);
          }
        }
        if (statement.includes("current_setting('transaction_isolation')")) {
          return [{ isolation: 'read committed' }];
        }
        if (statement.includes('from "core"."application_composition_authority"')) {
          admissions += 1;
          return [{ phase: 'draining', revision: activeRevision, subscriptionsJson: [], unexpired: true }];
        }
        if (statement.includes('set_config')) {
          return [{ legal_entity_id: legalEntityId, tenant_id: tenantId }];
        }
        if (statement.includes('from "core"."legal_entities"')) {
          return [{ legalEntityId, status: 'active', tenantId }];
        }
        return [];
      }),
    );
    const execution = makeCommitmentProtectionEstablishmentExecutionService({
      authority: {
        establish: (authorityRequest) =>
          Effect.sync(() => {
            expect(transactionOpen).toBe(true);
            expect(admissions).toBe(2);
            expect(commits).toBe(1);
            expect(authorityRequest.effectId).toBe(request.effectId);
            authorityCalls += 1;
            return {
              effectAbsenceProven: false as const,
              effectId: authorityRequest.effectId,
              kind: 'UNAVAILABLE' as const,
              recovery: 'VERIFY_OR_RECOVER_ORIGINAL_EFFECT' as const,
            };
          }),
      },
      confirmations: () => ({
        createOrRead: () => Effect.die('Unexpected confirmation write'),
        findByRef: () => Effect.die('Unexpected confirmation read'),
        findByReservationAttempt: () => Effect.die('Unexpected confirmation read'),
        readHistory: () => Effect.die('Unexpected confirmation history read'),
        saveRevision: () => Effect.die('Unexpected confirmation write'),
      }),
      finalizer: () => Effect.die('An unavailable external result must remain recoverable'),
      ledger: () => ledger,
      recoveryAuthority: { recoverOriginal: () => Effect.die('This is the original authority attempt') },
    });
    const context = attestOutboxWorkerHandlerContext({
      attemptNumber: 1,
      claimId: 'claim-original',
      compositionRevision: revision,
      consumerModuleKey: 'commerce.inventory',
      deliveryId: 'delivery-original',
      domainEventId: 'event-original',
      legalEntityScope: 'required',
      messageId: 'message-original',
      producerModuleKey: 'commerce.inventory',
      tenantId,
      tenantSequenceNo: 1n,
      topic: 'commerce.inventory.commitment-protection-establishment-requested.v1',
      workerKey: 'commerce.inventory.execute-commitment-protection-establishment',
    });
    const worker = handleExecuteCommitmentProtectionEstablishment(
      Schema.decodeUnknownSync(OutboxPayloadSchema)({ request }),
      context,
    ).pipe(
      Effect.provideService(CommitmentProtectionEstablishmentExecution, execution),
      Effect.provideService(
        OutboxWorkerLegalEntityScopeFanout,
        makeOutboxWorkerLegalEntityScopeFanout(makePostgresOutboxWorkerLegalEntityScopeBackend({ executor: database })),
      ),
      Effect.flip,
    );
    const running = yield* Effect.forkChild(worker);
    if (retirePreparedRelease) {
      yield* Deferred.await(preparedCommitted);
      const prepared = yield* ledger.recover(
        tenantId,
        inventoryEffectLedgerId(request.effectId),
        commitmentProtectionLedgerIntent(request),
      );
      expect(prepared.record.currentState).toBe('INDETERMINATE');
      // A recovered delivery can finish while this original handler is paused after its durable prepare.
      activeRevision = 'b'.repeat(64);
      yield* Deferred.succeed(resumePreparedWorker, null);
    }
    const failure = yield* Fiber.join(running);
    expect(admissions).toBe(2);
    expect(commits).toBe(1);
    expect(statements.filter((statement) => statement.includes('pg_advisory_xact_lock_shared'))).toHaveLength(2);
    expect(statements.filter((statement) => /^rollback/iu.test(statement))).toHaveLength(1);
    expect(transactionOpen).toBe(false);
    expect(authorityCalls).toBe(retirePreparedRelease ? 0 : 1);
    expect(
      Predicate.isTagged(
        failure,
        retirePreparedRelease ? 'OutboxWorkerLegalEntityScopeError' : 'CommitmentProtectionUnavailable',
      ),
    ).toBe(true);
  });

it.effect('rejects a paused prepared Worker before its external attempt after the pinned release retires', () =>
  exerciseWorkerFence(true),
);

it.effect('holds native release admission around the original authority attempt while draining', () =>
  exerciseWorkerFence(false),
);
