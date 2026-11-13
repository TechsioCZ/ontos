// A won opportunity the worker cannot or need not draft is an ordinary outcome of selling, not a system failure: its
// Outbox delivery completes. Run through Core's real Outbox runtime and repository on PostgreSQL, each business outcome
// leaves its delivery `done`, and the app host's startup gate (`scripts/zerops/outbox-dead-startup-gate.mts`, over
// `listDeadOutboxDeliveries`) still lets the next boot start. A system failure (no company keeps a ledger at all) stays
// pending for its retry, never dead on its first attempt.
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import type { OutboxWorkerLegalEntityScope } from '@app/core-runtime';
import { OutboxWorkerLegalEntityScopeFanout } from '@app/core-runtime/outbox/worker';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/sales-pipeline/outbox/opportunity-stage-changed';
import { eq } from 'drizzle-orm';
import { Crypto, DateTime, Effect, Layer, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeCoreDatabase } from '../../../../packages/core-runtime/src/db/client.ts';
import {
  actionInvocations,
  domainEvents,
  legalEntities,
  outboxDeliveries,
  outboxMessages,
  principals,
  tenantModuleStates,
  tenants,
} from '../../../../packages/core-runtime/src/db/schema.ts';
import { listDeadOutboxDeliveries } from '../../../../packages/core-runtime/src/outbox/dead-delivery-resolution.ts';
import { makeOutboxRepository } from '../../../../packages/core-runtime/src/outbox/repository.ts';
import { makeOutboxRuntime } from '../../../../packages/core-runtime/src/outbox/runtime.ts';
import { makeNativeOutboxWorkerFixture } from '../../../../packages/core-runtime/tests/support/outbox-worker-native-fixture.ts';
import { FinanceReferenceUnavailable } from '../../shared/actions/apply-command.ts';
import type { VatChoices } from '../../shared/apis/vat-choices.ts';
import { FinanceTaxRates } from '../../src/integrations/tax-rates.ts';
import { draftInvoiceFromWonOpportunityWorker } from '../../src/workers/draft-invoice-from-won-opportunity.worker.ts';
import {
  OpportunityInvoiceLedger,
  opportunityInvoiceLedgerLive,
  saveFinanceStateForWorkerRoutine,
} from '../../src/workers/opportunity-invoice-ledger.ts';
import { baselineVatChoices } from '../support/finance-tax-rates.ts';

const nativeServices = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);
const registration = draftInvoiceFromWonOpportunityWorker;
/** A stage change: from, to, and the Sales Pipeline revision it happened at. */
interface Stage {
  readonly from: string;
  readonly revision: number;
  readonly to: string;
}
const WON: Stage = { from: 'NEGOTIATION', revision: 1, to: 'WON' };
const LOST_AFTER_WON: Stage = { from: 'WON', revision: 2, to: 'LOST' };
const SaveParametersSchema = Schema.Tuple([Schema.Int, Schema.Unknown]);

/** The stored ledger row: its revision and its encoded finance state. */
interface StoredLedger {
  revision: number;
  state: unknown;
}

/** One company's finance ledger in memory, saved with a revision check exactly like the worker routines. */
const memoryLedger = (tenantId: string, company: string, keepsLedger: boolean): OutboxWorkerLegalEntityScope => {
  const ledger: StoredLedger = { revision: 0, state: { financialPlanEntries: [], invoices: [] } };
  return {
    completionPublisher: { publish: () => Effect.die('Invoice drafting must not publish completion evidence') },
    legalEntityId: company,
    routineInvoker: {
      invoke: (routine, parameters) => {
        if (!keepsLedger) {
          return Effect.succeed([]);
        }
        if (routine.routineKey === saveFinanceStateForWorkerRoutine.routineKey) {
          const [expected, state] = Schema.decodeUnknownSync(SaveParametersSchema)(parameters);
          if (expected !== ledger.revision) {
            return Effect.succeed([]);
          }
          ledger.revision += 1;
          ledger.state = state;
          return Effect.succeed(
            Schema.decodeUnknownSync(Schema.Array(routine.resultSchema))([{ revision: ledger.revision }]),
          );
        }
        return Effect.succeed(
          Schema.decodeUnknownSync(Schema.Array(routine.resultSchema))([
            { revision: ledger.revision, state: ledger.state },
          ]),
        );
      },
    },
    tenantId,
  };
};

const answering = (choices: () => VatChoices) =>
  FinanceTaxRates.of({
    choices: () => Effect.die('Tax is asked for the originator only'),
    choicesFor: () => Effect.succeed(choices()),
  });
const down = () =>
  Effect.fail(new FinanceReferenceUnavailable({ code: 'finance_reference_unavailable', reason: 'down' }));

it.layer(nativeServices, { excludeTestServices: true })('won opportunity Outbox settlement', (suite) => {
  suite.effect('no business outcome leaves a dead delivery behind; the next boot starts', () =>
    Effect.gen(function* settlement() {
      const crypto = yield* Crypto.Crypto;
      const uuid = crypto.randomUUIDv4();
      const tenantId = yield* uuid;
      const company = yield* uuid;
      const otherCompany = yield* uuid;
      const principalId = yield* uuid;
      // A database of its own: the composition authority is global, and other suites publish theirs meanwhile.
      const isolated = yield* makeIsolatedNativeDatabaseFixture({
        mode: 'empty',
        purpose: 'finance-won-opportunity-settlement',
      });
      yield* isolated.migrateCoreSchema();
      const claimFixture = makeNativeOutboxWorkerFixture([registration]);
      yield* isolated.publishInitialComposition(yield* claimFixture.authority.load);
      const { executor } = yield* makeCoreDatabase(isolated.connections.runtime);
      const { executor: admin } = yield* makeCoreDatabase(isolated.connections.admin);
      yield* executor.insert(tenants).values({
        defaultLocale: 'cs',
        name: 'Won opportunity settlement',
        slug: `won-settlement-${tenantId}`,
        status: 'active',
        tenantId,
      });
      for (const legalEntityId of [company, otherCompany]) {
        yield* executor.insert(legalEntities).values({
          legalEntityId,
          legalName: `Firma ${legalEntityId}`,
          registrationCountry: 'CZ',
          registrationNumber: `WON-${legalEntityId}`,
          status: 'active',
          tenantId,
        });
      }
      yield* executor
        .insert(principals)
        .values({ displayName: 'Obchodník', kind: 'human', principalId, status: 'active', tenantId });
      yield* executor
        .insert(tenantModuleStates)
        .values({ moduleKey: registration.descriptor.consumerModuleKey, state: 'active', tenantId });
      const repository = makeOutboxRepository(executor, crypto);
      const compositionRevision = claimFixture.revision;

      /** A stage change Sales Pipeline published from the person's action in `eventCompany` (none when null). */
      const publish = Effect.fn('WonSettlement.publish')(function* publish(
        payload: typeof OutboxPayloadSchema.Encoded,
        eventCompany: string | null,
      ) {
        const now = yield* DateTime.nowAsDate;
        const [invocation] = yield* executor
          .insert(actionInvocations)
          .values({
            actionKey: 'demo.sales-pipeline.apply-command',
            authMethod: 'session',
            correlationId: `won-settlement-${payload.revision}`,
            legalEntityId: eventCompany,
            principalId,
            requestHash: `won-settlement-${yield* uuid}`,
            status: 'succeeded',
            tenantId,
          })
          .returning({ id: actionInvocations.actionInvocationId });
        const [event] = yield* executor
          .insert(domainEvents)
          .values({
            actionInvocationId: invocation?.id,
            eventType: outboxTopic,
            legalEntityId: eventCompany,
            payloadJson: payload,
            producerModuleKey: outboxProducerModuleKey,
            subjectModuleKey: outboxProducerModuleKey,
            subjectResourceId: payload.opportunityId,
            subjectResourceType: 'opportunity',
            tenantId,
          })
          .returning({ id: domainEvents.domainEventId });
        const [message] = yield* executor
          .insert(outboxMessages)
          .values({
            domainEventId: Option.getOrThrow(Option.fromNullishOr(event)).id,
            matchedAt: now,
            payloadJson: payload,
            producerModuleKey: outboxProducerModuleKey,
            tenantId,
            topic: outboxTopic,
          })
          .returning({ id: outboxMessages.outboxMessageId });
        const [delivery] = yield* executor
          .insert(outboxDeliveries)
          .values({
            availableAt: now,
            consumerModuleKey: registration.descriptor.consumerModuleKey,
            outboxMessageId: Option.getOrThrow(Option.fromNullishOr(message)).id,
            workerKey: registration.descriptor.workerKey,
          })
          .returning({ id: outboxDeliveries.outboxDeliveryId });
        return Option.getOrThrow(Option.fromNullishOr(delivery)).id;
      });
      /** One cycle of Core's Outbox over the pending delivery, with Tax and the companies' ledgers as given. */
      const cycle = (tax: FinanceTaxRates['Service'], scopes: readonly OutboxWorkerLegalEntityScope[]) =>
        Effect.gen(function* runOutboxCycle() {
          const now = DateTime.makeUnsafe(yield* DateTime.nowAsDate).pipe(
            DateTime.add({ seconds: 1 }),
            DateTime.toDateUtc,
          );
          return yield* claimFixture.bind(
            [registration],
            makeOutboxRuntime(repository).runCycle({
              claimOwner: 'won-opportunity-settlement',
              compositionRevision,
              maxDeliveries: 1,
              now,
              registrations: [registration],
              subscriptions: [registration.descriptor],
            }),
          );
        }).pipe(
          Effect.provideService(FinanceTaxRates, tax),
          Effect.provideService(OpportunityInvoiceLedger, opportunityInvoiceLedgerLive),
          Effect.provideService(OutboxWorkerLegalEntityScopeFanout, {
            forEachScope: (_claim, observe) => Effect.forEach(scopes, observe, { discard: true }),
          }),
        );
      const statusOf = (deliveryId: string) =>
        admin
          .select({ status: outboxDeliveries.status })
          .from(outboxDeliveries)
          .where(eq(outboxDeliveries.outboxDeliveryId, deliveryId))
          .pipe(Effect.map(([row]) => row?.status));
      // The app host's startup gate (scripts/zerops/outbox-dead-startup-gate.mts:35-42) starts the boot only when this
      // query (`listDeadOutboxDeliveries`, all Tenants there; this Tenant here) finds no dead delivery.
      const deadNow = listDeadOutboxDeliveries(admin, { limit: 10, tenantId });

      const taxDown = FinanceTaxRates.of({ choices: down, choicesFor: down });
      const today = DateTime.formatIsoDateUtc(yield* DateTime.now);
      const fourDaysAgo = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { days: 4 }));
      const nowIso = DateTime.formatIso(yield* DateTime.now);
      /** The stage change as Sales Pipeline encodes it (decoded and encoded again, so it is a valid message). */
      const message = (opportunityId: string, vatRate: number, changedAt: string, moved: Stage = WON) =>
        Schema.encodeSync(OutboxPayloadSchema)(
          Schema.decodeUnknownSync(OutboxPayloadSchema)({
            amountMinor: 100_000,
            changedAt,
            currency: 'CZK',
            fromStage: moved.from,
            lines: [
              { productId: opportunityId, productName: 'Roční servis', quantity: 1, unitPriceMinor: 100_000, vatRate },
            ],
            opportunityId,
            partyId: principalId,
            revision: moved.revision,
            toStage: moved.to,
          }),
        );
      const ownLedger = () => memoryLedger(tenantId, company, true);

      const leftWonLedger = ownLedger();
      const leftWonOpportunity = yield* uuid;
      const cases: readonly {
        readonly code: string;
        readonly company: string | null;
        readonly payload: typeof OutboxPayloadSchema.Encoded;
        readonly scopes: readonly OutboxWorkerLegalEntityScope[];
        readonly tax: FinanceTaxRates['Service'];
      }[] = [
        {
          code: 'VAT_NOT_SET_UP',
          company,
          payload: message(yield* uuid, 21, fourDaysAgo),
          scopes: [ownLedger()],
          tax: answering(() => baselineVatChoices(tenantId, today, 'NOT_DECLARED')),
        },
        {
          code: 'TAX_STILL_UNAVAILABLE',
          company,
          payload: message(yield* uuid, 21, fourDaysAgo),
          scopes: [ownLedger()],
          tax: taxDown,
        },
        {
          code: 'FINANCE_REJECTED',
          company,
          payload: message(yield* uuid, 10, nowIso),
          scopes: [ownLedger()],
          tax: answering(() => baselineVatChoices(tenantId, today)),
        },
        {
          code: 'OPPORTUNITY_COMPANY_WITHOUT_LEDGER',
          company,
          payload: message(yield* uuid, 21, nowIso),
          scopes: [memoryLedger(tenantId, otherCompany, true), memoryLedger(tenantId, company, false)],
          tax: taxDown,
        },
        {
          code: 'OPPORTUNITY_WITHOUT_COMPANY',
          company: null,
          payload: message(yield* uuid, 21, nowIso),
          scopes: [ownLedger()],
          tax: taxDown,
        },
        // Lost at revision 2, then the older won message (revision 1) arrives: nothing to draft.
        {
          code: 'left WON (recorded)',
          company,
          payload: message(leftWonOpportunity, 21, nowIso, LOST_AFTER_WON),
          scopes: [leftWonLedger],
          tax: taxDown,
        },
        {
          code: 'OPPORTUNITY_NO_LONGER_WON',
          company,
          payload: message(leftWonOpportunity, 21, nowIso),
          scopes: [leftWonLedger],
          tax: taxDown,
        },
      ];
      for (const entry of cases) {
        const deliveryId = yield* publish(entry.payload, entry.company);
        const result = yield* cycle(entry.tax, entry.scopes);
        expect([entry.code, result.succeeded, result.dead, yield* statusOf(deliveryId)]).toEqual([
          entry.code,
          1,
          0,
          'done',
        ]);
        expect([entry.code, yield* deadNow]).toEqual([entry.code, []]);
      }

      // A system failure keeps its retry: no company keeps a ledger at all. Pending, never dead on its first attempt.
      const systemFailure = yield* publish(message(yield* uuid, 21, nowIso), company);
      const failed = yield* cycle(taxDown, [memoryLedger(tenantId, company, false)]);
      expect([failed.retried, failed.dead, yield* statusOf(systemFailure)]).toEqual([1, 0, 'pending']);
      expect(yield* deadNow).toEqual([]);
    }),
  );
});
