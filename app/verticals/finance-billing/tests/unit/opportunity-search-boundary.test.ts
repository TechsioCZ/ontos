import { NodeCrypto } from '@effect/platform-node';
import {
  CoreSearchProjectionInvalid,
  CoreSearchQuerySchema,
  makeInMemoryCoreSearchProjectionStore,
} from '@app/core-runtime';
import type { OutboxWorkerHandlerContext, OutboxWorkerLegalEntityScope } from '@app/core-runtime';
import { OutboxWorkerLegalEntityScopeFanout } from '@app/core-runtime/outbox/worker';
import {
  attestOutboxWorkerHandlerContext,
  isVerifiedOutboxWorkerHandlerContext,
} from '@app/core-runtime/testing/outbox';
import {
  OutboxPayloadSchema,
  outboxProducerModuleKey,
  outboxTopic,
} from '@app/sales-pipeline/outbox/opportunity-stage-changed';
import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { InvoiceSchema } from '../../shared/apis/records.ts';
import { financeBillingMcpContribution } from '../../shared/mcp/contribution.ts';
import { searchIngestionRegistrations } from '../../src/services/search-projection.ts';
import {
  draftInvoiceFromWonOpportunityWorker,
  handleDraftInvoiceFromWonOpportunity,
} from '../../src/workers/draft-invoice-from-won-opportunity.worker.ts';
import { FinanceTaxRates } from '../../src/integrations/tax-rates.ts';
import { OpportunityInvoiceLedger } from '../../src/workers/opportunity-invoice-ledger.ts';

const tenantId = '20000000-0000-4000-8000-000000000001';
const legalEntityId = '30000000-0000-4000-8000-000000000001';
const invoiceId = '40000000-0000-4000-8000-000000000001';
const opportunityId = '40000000-0000-4000-8000-000000000002';
const partyId = '40000000-0000-4000-8000-000000000003';
const moduleKey = 'finance.billing';
const ref = { moduleId: moduleKey, resourceId: invoiceId, resourceType: 'finance.billing.invoice', tenantId };
const foreignClaim: OutboxWorkerHandlerContext = attestOutboxWorkerHandlerContext({
  attemptNumber: 1,
  claimId: '50000000-0000-4000-8000-000000000001',
  compositionRevision: 'a'.repeat(64),
  consumerModuleKey: moduleKey,
  deliveryId: '50000000-0000-4000-8000-000000000002',
  domainEventId: '50000000-0000-4000-8000-000000000003',
  legalEntityScope: 'required',
  messageId: '50000000-0000-4000-8000-000000000004',
  // The sales-pipeline invocation that marked the opportunity won; Finance asks Tax for it.
  originatorInvocationId: '50000000-0000-4000-8000-000000000005',
  // The company that invocation acted in, as Core recorded it: the invoice is drafted there.
  originatorLegalEntityId: legalEntityId,
  producerModuleKey: outboxProducerModuleKey,
  tenantId,
  tenantSequenceNo: 1n,
  topic: outboxTopic,
  workerKey: draftInvoiceFromWonOpportunityWorker.descriptor.workerKey,
});
const ownerClaim: OutboxWorkerHandlerContext = attestOutboxWorkerHandlerContext({
  attemptNumber: 1,
  claimId: '60000000-0000-4000-8000-000000000001',
  compositionRevision: 'a'.repeat(64),
  consumerModuleKey: moduleKey,
  deliveryId: '60000000-0000-4000-8000-000000000002',
  domainEventId: '60000000-0000-4000-8000-000000000003',
  legalEntityScope: 'required',
  messageId: '60000000-0000-4000-8000-000000000004',
  producerModuleKey: moduleKey,
  tenantId,
  tenantSequenceNo: 2n,
  topic: 'finance.billing.search-changed.v1',
  workerKey: 'finance.billing.project-search',
});

it.effect('real Core store rejects an attested finance consumer mutating as a foreign producer without data loss', () =>
  Effect.gen(function* foreignProducerCannotProject() {
    const store = makeInMemoryCoreSearchProjectionStore();
    const document = {
      archived: false,
      facets: [],
      metadata: [],
      projectionVersion: '1',
      ref,
      searchableText: ['FV-2026-101'],
      selectedLegalEntityId: legalEntityId,
      title: 'FV-2026-101',
    };
    const replacement = {
      documents: [document],
      moduleId: moduleKey,
      rebuildVersion: '1',
      resourceType: ref.resourceType,
      tenantId,
    };
    expect(isVerifiedOutboxWorkerHandlerContext(foreignClaim)).toBe(true);
    expect(foreignClaim.consumerModuleKey).toBe(moduleKey);
    yield* store.replace(replacement, ownerClaim);
    const replacementFailure = yield* store
      .replace({ ...replacement, documents: [], rebuildVersion: '2' }, foreignClaim)
      .pipe(Effect.flip);
    expect(Schema.is(CoreSearchProjectionInvalid)(replacementFailure)).toBe(true);
    const mutationFailure = yield* store
      .apply(
        { document: { ...document, projectionVersion: '2', title: 'Foreign overwrite' }, kind: 'upsert' },
        foreignClaim,
      )
      .pipe(Effect.flip);
    expect(Schema.is(CoreSearchProjectionInvalid)(mutationFailure)).toBe(true);
    const deleteFailure = yield* store
      .apply({ kind: 'delete', projectionVersion: '2', ref }, foreignClaim)
      .pipe(Effect.flip);
    expect(Schema.is(CoreSearchProjectionInvalid)(deleteFailure)).toBe(true);
    const query = yield* Schema.decodeUnknownEffect(CoreSearchQuerySchema)({
      includeArchived: false,
      moduleId: moduleKey,
      query: 'FV',
      resourceType: ref.resourceType,
      selectedLegalEntityId: legalEntityId,
      tenantId,
    });
    const candidates = yield* store.queryCandidates(query, {
      authContextRef: 'job:finance-boundary-test',
      authMethod: 'system',
      correlationId: 'finance-boundary-test',
      legalEntityId,
      principalId: '70000000-0000-4000-8000-000000000001',
      tenantId,
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.title).toBe(document.title);
  }),
);

const committedDraft = Effect.gen(function* committedDraftDoesNotProject() {
  const payload = yield* Schema.decodeEffect(OutboxPayloadSchema)({
    amountMinor: 100,
    changedAt: '2026-11-02T00:00:00.000Z',
    currency: 'CZK',
    fromStage: 'NEGOTIATION',
    lines: [{ productId: invoiceId, productName: 'Servis', quantity: 1, unitPriceMinor: 100, vatRate: 21 }],
    opportunityId,
    partyId,
    revision: 1,
    toStage: 'WON',
  });
  const invoice = yield* Schema.decodeUnknownEffect(InvoiceSchema)({
    accountingCorrelation: 'test',
    accountingSyncState: 'NOT_SYNCED',
    businessState: 'DRAFT',
    counterpartyRef: {
      moduleId: 'party.registry',
      resourceId: partyId,
      resourceType: 'party.registry.counterparty',
      tenantId,
    },
    createdAt: '2026-11-02T00:00:00.000Z',
    currency: 'CZK',
    direction: 'OUTGOING',
    documentNumber: 'FV-2026-101',
    dueDate: '2026-11-16',
    issueDate: '2026-11-02',
    paidMinor: 0,
    paymentState: 'UNPAID',
    ref,
    totalMinor: 121,
    updatedAt: '2026-11-02T00:00:00.000Z',
  });
  const scope: OutboxWorkerLegalEntityScope = {
    completionPublisher: { publish: () => Effect.die('This draft has no approved completion saga intent') },
    legalEntityId,
    routineInvoker: { invoke: () => Effect.die('The ledger service owns its SQL') },
    tenantId,
  };
  let commits = 0;
  let drafts = 0;
  const draft = handleDraftInvoiceFromWonOpportunity(payload, foreignClaim).pipe(
    // The ledger below stands in for Finance's; it never asks Tax.
    Effect.provideService(
      FinanceTaxRates,
      FinanceTaxRates.of({
        choices: () => Effect.die('The stand-in ledger never asks Tax'),
        choicesFor: () => Effect.die('The stand-in ledger never asks Tax'),
      }),
    ),
    Effect.provideService(OpportunityInvoiceLedger, {
      draft: (actualScope, command, originator) =>
        Effect.sync(() => {
          expect(actualScope).toBe(scope);
          expect(command.opportunityId).toBe(opportunityId);
          expect(originator).toEqual({
            actionInvocationId: '50000000-0000-4000-8000-000000000005',
            compositionRevision: 'a'.repeat(64),
          });
          drafts += 1;
          return Option.some(invoice);
        }),
      endVatWait: () => Effect.die('The fake Tax answers every opportunity'),
      holds: () => Effect.die('The opportunity company is the only scope'),
      recordLeftWon: () => Effect.die('A won message records no move out of WON'),
      vatNotReady: () => Effect.die('The fake Tax answers every opportunity'),
    }),
    Effect.provideService(OutboxWorkerLegalEntityScopeFanout, {
      forEachScope: (claim, observe) => {
        expect(claim).toBe(foreignClaim);
        return observe(scope).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              commits += 1;
            }),
          ),
        );
      },
    }),
  );
  yield* draft;
  yield* draft;
  expect(commits).toBe(2);
  expect(drafts).toBe(2);
});

it.layer(NodeCrypto.layer)('Opportunity worker cryptography', (suite) => {
  suite.effect(
    'WON drafting and redelivery succeed after scope commit without a search projector or publisher',
    () => committedDraft,
  );
});

it('keeps only finance-owned search ingestion and the existing MCP rebuild Action', () => {
  expect(searchIngestionRegistrations.map(({ producerModuleKey }) => producerModuleKey)).toEqual([
    moduleKey,
    moduleKey,
  ]);
  expect(searchIngestionRegistrations.map(({ workerKey }) => workerKey)).not.toContain(foreignClaim.workerKey);
  expect(Object.keys(financeBillingMcpContribution.actions ?? {})).toEqual(['request-search-rebuild']);
});
