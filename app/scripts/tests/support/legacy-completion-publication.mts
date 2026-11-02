import { NodeServices } from '@effect/platform-node';
import { Context, DateTime, Effect, Layer, Option, Schema } from 'effect';
import { expect } from 'effect-rstest';

import {
  LegacyCompletionPublication,
  LegacyCompletionPublicationError,
  LegacyCompletionTransactionIdSchema,
} from '../../../packages/core-runtime/src/modules/legacy-completion-publication.ts';
import type {
  LegacyCompletionOwnerResult,
  LegacyCompletionOwnerVerifier,
  LegacyCompletionPublicationObservation,
  LegacyCompletionRetainedObservation,
} from '../../../packages/core-runtime/src/modules/legacy-completion-publication.ts';

export const LegacyPublicationControlSchema = Schema.Literals([
  'missing',
  'empty',
  'unknown',
  'unresolved',
  'nonempty',
  'wrong-database',
  'replayed-binding',
  'replayed-reference',
  'empty-reference',
  'retention-failed',
  'expired',
]);
export type LegacyPublicationControl = typeof LegacyPublicationControlSchema.Type;

class LeasedOwnerTransaction extends Context.Service<LeasedOwnerTransaction, string>()('Test/LeasedOwnerTransaction') {}

/** Scripted native transport only; the production Core verifier and transaction lifecycle remain real. */
export const legacyCompletionPublicationFixture = (events: string[], control?: LegacyPublicationControl) => {
  const runtimeTarget = { databaseName: 'publication_test', host: 'publication.test', port: 5432, user: 'runtime' };
  const ownerBinding = {
    databaseName: runtimeTarget.databaseName,
    databaseOid: '42',
    databaseUser: 'owner_admin',
    observedAt: DateTime.makeUnsafe('2026-10-02T16:02:00.000Z'),
    runtimeRoleOid: '43',
    runtimeTarget,
    runtimeUser: runtimeTarget.user,
    systemIdentifier: control === 'wrong-database' ? 'other-system' : 'publication-system',
    transactionId: Schema.decodeUnknownSync(LegacyCompletionTransactionIdSchema)('owner-transaction'),
  };
  const observations: LegacyCompletionPublicationObservation[] = [];
  const retained: LegacyCompletionRetainedObservation[] = [];
  let transaction = 0;
  let emptyTopicObserved = false;
  let freshnessChecks = 0;
  const acquireOwnerLease = Effect.sync(() => {
    events.push('OWNER ACQUIRE');
  });
  const releaseOwnerLease = Effect.sync(() => {
    events.push('OWNER RELEASE');
  });
  const verify = (observation: LegacyCompletionPublicationObservation) =>
    Effect.gen(function* verifyExplicitEmptyOwnerTopic() {
      observations.push(observation);
      events.push('OWNER VERIFY');
      const ownerTransaction = yield* Effect.serviceOption(LeasedOwnerTransaction);
      if (Option.isNone(ownerTransaction) || ownerTransaction.value !== ownerBinding.transactionId) {
        return yield* new LegacyCompletionPublicationError({ reason: 'The owner transaction context was lost' });
      }
      // This fixture proves only the explicitly queried empty owner topic, never arbitrary work.
      if (!emptyTopicObserved || !observation.complete || observation.messages.length !== 0) {
        return yield* new LegacyCompletionPublicationError({ reason: 'Test owner evidence is incomplete or nonempty' });
      }
      emptyTopicObserved = false;
      let { evidenceReference } = observation;
      if (control === 'replayed-reference') {
        evidenceReference = 'prior-observation';
      }
      if (control === 'empty-reference') {
        evidenceReference = '';
      }
      let status: LegacyCompletionOwnerResult['status'] = 'VERIFIED_ABSENT';
      if (control === 'unknown') {
        status = 'UNKNOWN';
      }
      if (control === 'unresolved') {
        status = 'UNRESOLVED';
      }
      const result: LegacyCompletionOwnerResult = {
        binding: control === 'replayed-binding' ? { ...observation.binding } : observation.binding,
        evidenceReference,
        status,
      };
      return result;
    });
  const withLease: LegacyCompletionOwnerVerifier['withLease'] = (transition) =>
    Effect.scoped(
      Effect.gen(function* holdTestOwnerLease() {
        yield* Effect.acquireRelease(acquireOwnerLease, () => releaseOwnerLease);
        return yield* transition({ binding: ownerBinding, verify }).pipe(
          Effect.provideService(LeasedOwnerTransaction, ownerBinding.transactionId),
        );
      }),
    );
  const service: (typeof LegacyCompletionPublication)['Service'] = {
    owners: control === 'empty' ? [] : [{ producerModuleKey: 'fixture.owner', topic: 'fixture.completed', withLease }],
    retainEvidence: (observation) =>
      Effect.gen(function* retainTestOwnerEvidence() {
        events.push('OWNER RETAIN');
        if (control === 'retention-failed') {
          return yield* new LegacyCompletionPublicationError({ reason: 'Test evidence retention failed' });
        }
        retained.push(observation);
        return yield* Effect.void;
      }),
    runtimeTarget,
    runtimeUser: runtimeTarget.user,
  };
  return {
    freshnessChecks: () => freshnessChecks,
    layer:
      control === 'missing'
        ? NodeServices.layer
        : Layer.merge(NodeServices.layer, Layer.succeed(LegacyCompletionPublication, service)),
    observations,
    retained,
    sqlResponse: (sql: string, params: readonly unknown[]) => {
      if (sql.includes('as "completionSchemaInstalled"')) {
        return [{ completionSchemaInstalled: true }];
      }
      // The rich identity query also contains `as isolation`; it must win over generic isolation handling.
      if (sql.includes('pg_control_system()')) {
        expect(params).toContain(runtimeTarget.user);
        transaction += 1;
        return [
          {
            administrative: true,
            clockValue: '2026-10-02T16:02:00.000Z',
            databaseName: runtimeTarget.databaseName,
            databaseOid: '42',
            databaseUser: 'core_admin',
            isolation: 'read committed',
            runtimeRoleOid: '43',
            safeRuntime: true,
            systemIdentifier: 'publication-system',
            transactionId: `core-${transaction}`,
          },
        ];
      }
      if (sql.startsWith('select') && sql.includes('from "core"."outbox_messages"') && sql.includes('"payload_json"')) {
        expect(params).toContain('fixture.owner');
        expect(params).toContain('fixture.completed');
        emptyTopicObserved = control !== 'nonempty';
        if (control === 'nonempty') {
          return [
            {
              completionConsumerModuleKey: null,
              completionOriginalRevision: null,
              outboxMessageId: 'legacy-message',
              payloadJson: {},
              tenantId: 'legacy-tenant',
            },
          ];
        }
        events.push('OWNER EMPTY TOPIC');
        return [];
      }
      if (sql.includes("interval '30 seconds' as valid")) {
        freshnessChecks += 1;
        return [{ valid: control !== 'expired' }];
      }
      return null;
    },
  };
};
