import { expect, it } from 'effect-rstest';
import { DateTime, Effect, Layer, Option, Redacted, Schema } from 'effect';
import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import { ReadHandlerNotFound } from '@app/core-runtime';
import type { PaymentTermDefinition } from '../../shared/domain/payment-term.ts';
import {
  PaymentTermAffectedUseAssessmentRejected,
  PaymentTermAffectedUseAssessmentUnavailable,
  PaymentTermInUse,
  PaymentTermNotFound,
  PaymentTermRevisionConflict,
} from '../../shared/domain/payment-term-errors.ts';
import type { PaymentTermRef } from '../../shared/resources/payment-term.ts';
import {
  createPaymentTermAction,
  handleCreatePaymentTerm,
} from '../../src/actions/create-payment-term.action.ts';
import {
  correctPaymentTermAction,
  handleCorrectPaymentTerm,
} from '../../src/actions/correct-payment-term.action.ts';
import {
  handleReconcilePaymentTermReference,
  reconcilePaymentTermReferenceAction,
} from '../../src/actions/reconcile-payment-term-reference.action.ts';
import {
  handleRetirePaymentTerm,
  retirePaymentTermAction,
} from '../../src/actions/retire-payment-term.action.ts';
import type { RetirePaymentTermServices } from '../../src/actions/retire-payment-term.action.ts';
import { readCurrentPaymentTerms } from '../../src/api/current-payment-terms.read.ts';
import { readPaymentTermHistory } from '../../src/api/payment-term-history.read.ts';
import {
  CustomerContextGatewayCredentialService,
  customerPaymentTermAffectedUseAuthority,
  customerPaymentTermAffectedUseAuthorityFromEnvironment,
} from '../../src/integrations/customer-payment-term-affected-use.ts';
import type { PaymentTermCatalogPersistence } from '../../src/persistence/payment-term-catalog-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const paymentTermRef = (resourceId: string): PaymentTermRef => ({
  moduleId: 'payment.term-catalog',
  resourceId,
  resourceType: 'payment.term-catalog.payment-term',
  tenantId,
});
const ref = paymentTermRef('22222222-2222-4222-8222-222222222222');
const provenance = {
  actionInvocationId: '33333333-3333-4333-8333-333333333333',
  actorPrincipalId: '44444444-4444-4444-8444-444444444444',
  at: '2026-09-09T10:00:00.000Z',
  reason: 'Catalog governance',
} as const;
const active: PaymentTermDefinition = {
  code: 'NET_30',
  compatibleWith: ['customer-payment-terms.v1'],
  compatibilityId: 'net_days.invoice_issued_at.calendar_days_utc.v1',
  created: provenance,
  definitionRevisionId: '55555555-5555-4555-8555-555555555555',
  description: 'Due thirty days after invoice issue.',
  lifecycle: {
    effectiveFrom: '2026-01-01T00:00:00.000Z',
    effectiveTo: null,
    state: 'ACTIVE',
  },
  metadataRevision: 1,
  name: 'Net 30',
  paymentTermRef: ref,
  retired: null,
  semanticFingerprint: 'a'.repeat(64),
  semanticRevisionId: '66666666-6666-4666-8666-666666666666',
  semantics: {
    calculationRuleVersion: 1,
    calendarRule: 'CALENDAR_DAYS_UTC',
    days: 30,
    dueDateAnchor: 'INVOICE_ISSUED_AT',
    kind: 'NET_DAYS',
  },
  updated: provenance,
};
const retired: PaymentTermDefinition = {
  ...active,
  lifecycle: {
    ...active.lifecycle,
    effectiveTo: '2026-10-01T00:00:00.000Z',
    state: 'RETIRED',
  },
  retired: { ...provenance, at: '2026-09-09T11:00:00.000Z' },
};

const unused = () => Effect.die('unused test service');
const services = (overrides: Partial<RetirePaymentTermServices>): RetirePaymentTermServices => ({
  correct: unused,
  create: unused,
  getCurrent: () => Effect.succeed(Option.some(active)),
  getHistory: () =>
    Effect.succeed(Option.some({ aliases: [], lifecycle: [], revisions: [active] })),
  listCurrent: () => Effect.succeed({ definitions: [active], truncated: false }),
  reconcile: unused,
  resolveReference: unused,
  retire: unused,
  verifyRetirementGovernance: ({ claimedAssessment, claimedDisposition }) =>
    Effect.succeed({ assessment: claimedAssessment, disposition: claimedDisposition }),
  ...overrides,
});

const retirementPayload = {
  affectedUseAssessment: {
    currentCustomerEntitlementCount: 0,
    evidenceReference: 'commerce-payment-use:revision-7',
    observedAt: '2026-09-09T10:00:00.000Z',
    openPurchaseCount: 0,
  },
  affectedUseDisposition: { kind: 'REJECT_IF_IN_USE' as const },
  effectiveAt: '2026-10-01T00:00:00.000Z',
  expectedMetadataRevision: 1,
  paymentTermRef: ref,
  reason: 'Retire from new commercial use',
};

const scope = {
  authMethod: 'session' as const,
  correlationId: 'correlation',
  legalEntityId: '88888888-8888-4888-8888-888888888888',
  principalId: provenance.actorPrincipalId,
  tenantId,
};

const context = (
  catalog: RetirePaymentTermServices,
  counters: { audits: number; events: number; outboxes: number; reads: number },
): Parameters<typeof handleRetirePaymentTerm>[1] => {
  const collector = createActionCollector(
    retirePaymentTermAction.descriptor.domainEvents,
    'payment.term-catalog',
    retirePaymentTermAction.descriptor.accessEvidencePolicy,
    retirePaymentTermAction.descriptor.auditEvidenceSchema,
  );
  return {
    actionInvocationId: '77777777-7777-4777-8777-777777777777',
    addDomainEvent: (event) => {
      counters.events += 1;
      return collector.addDomainEvent(event);
    },
    addOutboxMessage: (event, message) => {
      counters.outboxes += 1;
      return collector.addOutboxMessage(event, message);
    },
    recordAuditEvidence: () => {
      counters.audits += 1;
      return Effect.void;
    },
    recordDataAccess: () => {
      counters.reads += 1;
      return Effect.void;
    },
    scope,
    services: catalog,
  };
};

it.effect('attaches create, correction, and reconciliation outbox messages to their events', () =>
  Effect.gen(function* attachedOutboxMessages() {
    const createCollector = createActionCollector(
      createPaymentTermAction.descriptor.domainEvents,
      'payment.term-catalog',
      createPaymentTermAction.descriptor.accessEvidencePolicy,
      createPaymentTermAction.descriptor.auditEvidenceSchema,
    );
    yield* handleCreatePaymentTerm(
      {
        activeFrom: active.lifecycle.effectiveFrom,
        code: active.code,
        description: active.description,
        name: active.name,
        reason: provenance.reason,
        semantics: active.semantics,
      },
      {
        actionInvocationId: provenance.actionInvocationId,
        addDomainEvent: createCollector.addDomainEvent,
        addOutboxMessage: createCollector.addOutboxMessage,
        recordAuditEvidence: createCollector.recordAuditEvidence,
        recordDataAccess: createCollector.recordDataAccess,
        scope,
        services: services({
          create: () => Effect.succeed({ _tag: 'created', definition: active }),
        }),
      },
    );

    const corrected = {
      ...active,
      definitionRevisionId: '99999999-9999-4999-8999-999999999999',
      description: 'Clarified Net 30 wording.',
      metadataRevision: 2,
      updated: { ...provenance, at: '2026-09-09T12:00:00.000Z' },
    } satisfies PaymentTermDefinition;
    const correctCollector = createActionCollector(
      correctPaymentTermAction.descriptor.domainEvents,
      'payment.term-catalog',
      correctPaymentTermAction.descriptor.accessEvidencePolicy,
      correctPaymentTermAction.descriptor.auditEvidenceSchema,
    );
    yield* handleCorrectPaymentTerm(
      {
        description: corrected.description,
        expectedMetadataRevision: 1,
        name: corrected.name,
        paymentTermRef: ref,
        reason: provenance.reason,
      },
      {
        actionInvocationId: provenance.actionInvocationId,
        addDomainEvent: correctCollector.addDomainEvent,
        addOutboxMessage: correctCollector.addOutboxMessage,
        recordAuditEvidence: correctCollector.recordAuditEvidence,
        recordDataAccess: correctCollector.recordDataAccess,
        scope,
        services: services({
          correct: () => Effect.succeed({ _tag: 'corrected', definition: corrected }),
        }),
      },
    );

    const aliasRef = paymentTermRef('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const reconcileCollector = createActionCollector(
      reconcilePaymentTermReferenceAction.descriptor.domainEvents,
      'payment.term-catalog',
      reconcilePaymentTermReferenceAction.descriptor.accessEvidencePolicy,
      reconcilePaymentTermReferenceAction.descriptor.auditEvidenceSchema,
    );
    yield* handleReconcilePaymentTermReference(
      {
        aliasPaymentTermRef: aliasRef,
        canonicalPaymentTermRef: ref,
        expectedAliasMetadataRevision: 1,
        expectedCanonicalMetadataRevision: 1,
        reason: provenance.reason,
      },
      {
        actionInvocationId: provenance.actionInvocationId,
        addDomainEvent: reconcileCollector.addDomainEvent,
        addOutboxMessage: reconcileCollector.addOutboxMessage,
        recordAuditEvidence: reconcileCollector.recordAuditEvidence,
        recordDataAccess: reconcileCollector.recordDataAccess,
        scope,
        services: services({
          reconcile: () =>
            Effect.succeed({
              _tag: 'reconciled',
              alias: { aliasRef, canonicalRef: ref, reconciled: provenance },
            }),
        }),
      },
    );

    const retireCollector = createActionCollector(
      retirePaymentTermAction.descriptor.domainEvents,
      'payment.term-catalog',
      retirePaymentTermAction.descriptor.accessEvidencePolicy,
      retirePaymentTermAction.descriptor.auditEvidenceSchema,
    );
    yield* handleRetirePaymentTerm(retirementPayload, {
      actionInvocationId: provenance.actionInvocationId,
      addDomainEvent: retireCollector.addDomainEvent,
      addOutboxMessage: retireCollector.addOutboxMessage,
      recordAuditEvidence: retireCollector.recordAuditEvidence,
      recordDataAccess: retireCollector.recordDataAccess,
      scope,
      services: services({
        retire: () => Effect.succeed({ _tag: 'retired', definition: retired }),
      }),
    });

    const expectations = [
      [createCollector.snapshot(), 'payment.term-catalog.payment-term-created.v1'],
      [correctCollector.snapshot(), 'payment.term-catalog.payment-term-metadata-corrected.v1'],
      [reconcileCollector.snapshot(), 'payment.term-catalog.payment-term-reference-reconciled.v1'],
      [retireCollector.snapshot(), 'payment.term-catalog.payment-term-retired.v1'],
    ] as const;
    for (const [evidence, eventType] of expectations) {
      expect(evidence.outboxMessages).toHaveLength(1);
      const domainEventIndex = evidence.outboxMessages[0]?.domainEventIndex;
      expect(domainEventIndex).toBe(0);
      expect(evidence.domainEvents[domainEventIndex ?? -1]?.eventType).toBe(eventType);
    }
  }),
);

it.effect('short-circuits invalid persistence identifiers before owner storage', () =>
  Effect.gen(function* invalidReferenceShortCircuit() {
    const invalidRef = paymentTermRef('not-a-uuid');
    let storageCalls = 0;
    const guardedServices = services({
      getCurrent: () => {
        storageCalls += 1;
        return Effect.succeed(Option.some(active));
      },
      getHistory: () => {
        storageCalls += 1;
        return Effect.succeed(Option.none());
      },
      reconcile: () => {
        storageCalls += 1;
        return Effect.die('invalid reference reached reconciliation persistence');
      },
      resolveReference: () => {
        storageCalls += 1;
        return Effect.die('invalid reference reached resolution persistence');
      },
    });
    const emptyCollector = createActionCollector(
      correctPaymentTermAction.descriptor.domainEvents,
      'payment.term-catalog',
      correctPaymentTermAction.descriptor.accessEvidencePolicy,
      correctPaymentTermAction.descriptor.auditEvidenceSchema,
    );
    const correctFailure = yield* handleCorrectPaymentTerm(
      {
        description: active.description,
        expectedMetadataRevision: 1,
        name: active.name,
        paymentTermRef: invalidRef,
        reason: provenance.reason,
      },
      {
        actionInvocationId: provenance.actionInvocationId,
        addDomainEvent: emptyCollector.addDomainEvent,
        addOutboxMessage: emptyCollector.addOutboxMessage,
        recordAuditEvidence: emptyCollector.recordAuditEvidence,
        recordDataAccess: emptyCollector.recordDataAccess,
        scope,
        services: guardedServices,
      },
    ).pipe(Effect.flip);
    const retireFailure = yield* handleRetirePaymentTerm(
      { ...retirementPayload, paymentTermRef: invalidRef },
      context(guardedServices, { audits: 0, events: 0, outboxes: 0, reads: 0 }),
    ).pipe(Effect.flip);
    const reconcileFailure = yield* handleReconcilePaymentTermReference(
      {
        aliasPaymentTermRef: invalidRef,
        canonicalPaymentTermRef: ref,
        expectedAliasMetadataRevision: 1,
        expectedCanonicalMetadataRevision: 1,
        reason: provenance.reason,
      },
      {
        actionInvocationId: provenance.actionInvocationId,
        addDomainEvent: emptyCollector.addDomainEvent,
        addOutboxMessage: emptyCollector.addOutboxMessage,
        recordAuditEvidence: emptyCollector.recordAuditEvidence,
        recordDataAccess: emptyCollector.recordDataAccess,
        scope,
        services: guardedServices,
      },
    ).pipe(Effect.flip);
    const historyFailure = yield* readPaymentTermHistory(
      { paymentTermRef: invalidRef },
      tenantId,
      guardedServices,
    ).pipe(Effect.flip);
    const current = yield* readCurrentPaymentTerms(
      {
        at: '2026-09-09T10:00:00.000Z',
        limit: 1,
        references: [{ paymentTermRef: invalidRef }],
      },
      tenantId,
      guardedServices,
    );

    expect(Schema.is(PaymentTermNotFound)(correctFailure)).toBe(true);
    expect(Schema.is(PaymentTermNotFound)(retireFailure)).toBe(true);
    expect(Schema.is(PaymentTermNotFound)(reconcileFailure)).toBe(true);
    expect(Schema.is(ReadHandlerNotFound)(historyFailure)).toBe(true);
    expect(current.referenceOutcomes[0]?.kind).toBe('MISSING');
    expect(storageCalls).toBe(0);
  }),
);

it.effect('keeps correction and reconciliation replays silent', () =>
  Effect.gen(function* silentMutationReplays() {
    const correctCollector = createActionCollector(
      correctPaymentTermAction.descriptor.domainEvents,
      'payment.term-catalog',
      correctPaymentTermAction.descriptor.accessEvidencePolicy,
      correctPaymentTermAction.descriptor.auditEvidenceSchema,
    );
    const correction = yield* handleCorrectPaymentTerm(
      {
        description: active.description,
        expectedMetadataRevision: 1,
        name: active.name,
        paymentTermRef: ref,
        reason: provenance.reason,
      },
      {
        actionInvocationId: provenance.actionInvocationId,
        addDomainEvent: correctCollector.addDomainEvent,
        addOutboxMessage: correctCollector.addOutboxMessage,
        recordAuditEvidence: correctCollector.recordAuditEvidence,
        recordDataAccess: correctCollector.recordDataAccess,
        scope,
        services: services({}),
      },
    );
    const reconcileCollector = createActionCollector(
      reconcilePaymentTermReferenceAction.descriptor.domainEvents,
      'payment.term-catalog',
      reconcilePaymentTermReferenceAction.descriptor.accessEvidencePolicy,
      reconcilePaymentTermReferenceAction.descriptor.auditEvidenceSchema,
    );
    const reconciliation = yield* handleReconcilePaymentTermReference(
      {
        aliasPaymentTermRef: paymentTermRef('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
        canonicalPaymentTermRef: ref,
        expectedAliasMetadataRevision: 1,
        expectedCanonicalMetadataRevision: 1,
        reason: provenance.reason,
      },
      {
        actionInvocationId: provenance.actionInvocationId,
        addDomainEvent: reconcileCollector.addDomainEvent,
        addOutboxMessage: reconcileCollector.addOutboxMessage,
        recordAuditEvidence: reconcileCollector.recordAuditEvidence,
        recordDataAccess: reconcileCollector.recordDataAccess,
        scope,
        services: services({
          reconcile: () =>
            Effect.succeed({
              _tag: 'already_reconciled',
              canonicalPaymentTermId: ref.resourceId,
            }),
        }),
      },
    );

    expect(correction.changed).toBe(false);
    expect(reconciliation.changed).toBe(false);
    expect(correctCollector.snapshot().domainEvents).toHaveLength(0);
    expect(correctCollector.snapshot().outboxMessages).toHaveLength(0);
    expect(reconcileCollector.snapshot().domainEvents).toHaveLength(0);
    expect(reconcileCollector.snapshot().outboxMessages).toHaveLength(0);
  }),
);

it.effect('blocks retirement in use without explicit migration or grace', () =>
  Effect.gen(function* blocksRetirementInUse() {
    let retireCalls = 0;
    const counters = { audits: 0, events: 0, outboxes: 0, reads: 0 };
    const failure = yield* handleRetirePaymentTerm(
      {
        ...retirementPayload,
        affectedUseAssessment: {
          ...retirementPayload.affectedUseAssessment,
          currentCustomerEntitlementCount: 2,
        },
      },
      context(
        services({
          retire: () => {
            retireCalls += 1;
            return Effect.succeed({ _tag: 'retired', definition: retired });
          },
        }),
        counters,
      ),
    ).pipe(Effect.flip);

    expect(Schema.is(PaymentTermInUse)(failure)).toBe(true);
    expect(retireCalls).toBe(0);
    expect(counters).toEqual({ audits: 0, events: 0, outboxes: 0, reads: 0 });
  }),
);

it.effect('inventories canonical and reconciled alias references before retirement', () =>
  Effect.gen(function* inventoriesAliases() {
    const aliasRef = paymentTermRef('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    let assessedRefs: readonly PaymentTermRef[] = [];
    yield* handleRetirePaymentTerm(
      retirementPayload,
      context(
        services({
          getHistory: () =>
            Effect.succeed(
              Option.some({
                aliases: [
                  {
                    aliasRef,
                    canonicalRef: ref,
                    reconciled: provenance,
                  },
                ],
                lifecycle: [],
                revisions: [active],
              }),
            ),
          retire: () => Effect.succeed({ _tag: 'retired', definition: retired }),
          verifyRetirementGovernance: ({
            claimedAssessment,
            claimedDisposition,
            equivalentPaymentTermRefs,
          }) => {
            assessedRefs = equivalentPaymentTermRefs;
            return Effect.succeed({
              assessment: claimedAssessment,
              disposition: claimedDisposition,
            });
          },
        }),
        { audits: 0, events: 0, outboxes: 0, reads: 0 },
      ),
    );

    expect(assessedRefs).toEqual([ref, aliasRef]);
  }),
);

it.effect('adapts retirement governance to the Customer owner public assessment client', () =>
  Effect.gen(function* publicAffectedUseAuthority() {
    const aliasRef = paymentTermRef('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    let sentEquivalentRefs: readonly PaymentTermRef[] = [];
    const authority = customerPaymentTermAffectedUseAuthority(
      'retire-payment-term:correlation',
      (request) => {
        sentEquivalentRefs = request.equivalentPaymentTermRefs;
        return Effect.succeed({
          assessment: request.claimedAssessment,
          disposition: request.claimedDisposition,
          kind: 'VERIFIED' as const,
        });
      },
    );
    const result = yield* authority.verifyRetirementGovernance({
      claimedAssessment: retirementPayload.affectedUseAssessment,
      claimedDisposition: retirementPayload.affectedUseDisposition,
      effectiveAt: retirementPayload.effectiveAt,
      equivalentPaymentTermRefs: [ref, aliasRef],
      paymentTermRef: ref,
    });

    expect(result).toEqual({
      assessment: retirementPayload.affectedUseAssessment,
      disposition: retirementPayload.affectedUseDisposition,
    });
    expect(sentEquivalentRefs).toEqual([aliasRef]);
  }),
);

it.effect('maps affected-use rejection and transport failure to typed retirement errors', () =>
  Effect.gen(function* publicAffectedUseFailures() {
    const governanceInput = {
      claimedAssessment: retirementPayload.affectedUseAssessment,
      claimedDisposition: retirementPayload.affectedUseDisposition,
      effectiveAt: retirementPayload.effectiveAt,
      equivalentPaymentTermRefs: [ref],
      paymentTermRef: ref,
    };
    const rejected = yield* customerPaymentTermAffectedUseAuthority('correlation', () =>
      Effect.succeed({ kind: 'REJECTED' as const, reason: 'Disposition is not authoritative' }),
    )
      .verifyRetirementGovernance(governanceInput)
      .pipe(Effect.flip);
    const unavailable = yield* customerPaymentTermAffectedUseAuthority('correlation', () =>
      Effect.fail(new Error('transport unavailable')),
    )
      .verifyRetirementGovernance(governanceInput)
      .pipe(Effect.flip);

    expect(Schema.is(PaymentTermAffectedUseAssessmentRejected)(rejected)).toBe(true);
    expect(Schema.is(PaymentTermAffectedUseAssessmentUnavailable)(unavailable)).toBe(true);
  }),
);

it.effect('requires a server-owned gateway credential for production affected-use calls', () =>
  Effect.gen(function* serverCredential() {
    let authorization = '';
    const authority = yield* customerPaymentTermAffectedUseAuthorityFromEnvironment(
      'retire-payment-term:correlation',
      (request, credential) => {
        authorization = Redacted.value(credential);
        return Effect.succeed({
          assessment: request.claimedAssessment,
          disposition: request.claimedDisposition,
          kind: 'VERIFIED' as const,
        });
      },
    ).pipe(
      Effect.provide(
        Layer.succeed(CustomerContextGatewayCredentialService, {
          issue: () => Effect.succeed(Redacted.make('Bearer server-issued')),
        }),
      ),
    );
    yield* authority.verifyRetirementGovernance({
      claimedAssessment: retirementPayload.affectedUseAssessment,
      claimedDisposition: retirementPayload.affectedUseDisposition,
      effectiveAt: retirementPayload.effectiveAt,
      equivalentPaymentTermRefs: [ref],
      paymentTermRef: ref,
    });

    expect(authorization).toBe('Bearer server-issued');
  }),
);

it.effect('fails closed when affected-use or migration authority rejects caller claims', () =>
  Effect.gen(function* rejectsForgedEvidence() {
    let retireCalls = 0;
    const counters = { audits: 0, events: 0, outboxes: 0, reads: 0 };
    const failure = yield* handleRetirePaymentTerm(
      {
        ...retirementPayload,
        affectedUseDisposition: {
          kind: 'EXPLICIT_MIGRATION',
          migrationReference: 'caller-invented:migration',
        },
      },
      context(
        services({
          retire: () => {
            retireCalls += 1;
            return Effect.succeed({ _tag: 'retired', definition: retired });
          },
          verifyRetirementGovernance: () =>
            Effect.fail(
              new PaymentTermAffectedUseAssessmentRejected({
                code: 'payment_term_affected_use_assessment_rejected',
                reason: 'Evidence is forged, stale, or does not cover this Payment Term',
              }),
            ),
        }),
        counters,
      ),
    ).pipe(Effect.flip);

    expect(Schema.is(PaymentTermAffectedUseAssessmentRejected)(failure)).toBe(true);
    expect(retireCalls).toBe(0);
    expect(counters).toEqual({ audits: 0, events: 0, outboxes: 0, reads: 0 });
  }),
);

it.effect('retirement retry records audit and read evidence without a duplicate event', () =>
  Effect.gen(function* idempotentRetirement() {
    const counters = { audits: 0, events: 0, outboxes: 0, reads: 0 };
    const result = yield* handleRetirePaymentTerm(
      retirementPayload,
      context(
        services({
          getCurrent: () => Effect.succeed(Option.some(retired)),
          retire: () =>
            Effect.succeed({
              _tag: 'already_retired',
              retiredEffectiveAt: retirementPayload.effectiveAt,
            }),
        }),
        counters,
      ),
    );

    expect(result.changed).toBe(false);
    expect(counters).toEqual({ audits: 1, events: 0, outboxes: 0, reads: 3 });
  }),
);

it.effect('stale retirement loses the concurrency race before persistence', () =>
  Effect.gen(function* staleRetirement() {
    let retireCalls = 0;
    const counters = { audits: 0, events: 0, outboxes: 0, reads: 0 };
    const failure = yield* handleRetirePaymentTerm(
      retirementPayload,
      context(
        services({
          getCurrent: () => Effect.succeed(Option.some({ ...active, metadataRevision: 2 })),
          retire: () => {
            retireCalls += 1;
            return Effect.succeed({ _tag: 'retired', definition: retired });
          },
        }),
        counters,
      ),
    ).pipe(Effect.flip);

    expect(Schema.is(PaymentTermRevisionConflict)(failure)).toBe(true);
    expect(retireCalls).toBe(0);
    expect(counters).toEqual({ audits: 0, events: 0, outboxes: 0, reads: 0 });
  }),
);

it.effect('explicit migration permits retirement in use and emits one audited event', () =>
  Effect.gen(function* migratedRetirement() {
    const counters = { audits: 0, events: 0, outboxes: 0, reads: 0 };
    const result = yield* handleRetirePaymentTerm(
      {
        ...retirementPayload,
        affectedUseAssessment: {
          ...retirementPayload.affectedUseAssessment,
          openPurchaseCount: 3,
        },
        affectedUseDisposition: {
          kind: 'EXPLICIT_MIGRATION',
          migrationReference: 'commerce-migration:payment-term-7',
        },
      },
      context(
        services({ retire: () => Effect.succeed({ _tag: 'retired', definition: retired }) }),
        counters,
      ),
    );

    expect(result.changed).toBe(true);
    expect(counters).toEqual({ audits: 1, events: 1, outboxes: 1, reads: 3 });
  }),
);

it.effect('current read separates effective and observed time and preserves incompatibility', () =>
  Effect.gen(function* currentReadEvidence() {
    const result = yield* readCurrentPaymentTerms(
      {
        at: '2026-09-09T10:00:00.000Z',
        limit: 50,
        references: [
          {
            expectedSemanticRevisionId: '99999999-9999-4999-8999-999999999999',
            paymentTermRef: ref,
          },
          {
            paymentTermRef: paymentTermRef('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
          },
        ],
      },
      tenantId,
      services({
        resolveReference: (paymentTermId) =>
          Effect.succeed(
            paymentTermId === ref.resourceId
              ? {
                  _tag: 'resolved' as const,
                  canonicalPaymentTermId: ref.resourceId,
                  definition: active,
                  requestedPaymentTermId: ref.resourceId,
                }
              : {
                  _tag: 'broken_alias' as const,
                  reason: 'cycle' as const,
                  requestedPaymentTermId: paymentTermId,
                },
          ),
      }),
    );

    expect(result.effectiveAt).toBe('2026-09-09T10:00:00.000Z');
    expect(result.observedAt).not.toBe(result.effectiveAt);
    expect(result.referenceOutcomes[0]?.kind).toBe('INCOMPATIBLE');
    expect(result.referenceOutcomes[1]?.kind).toBe('BROKEN');
    expect(result.truncated).toBe(false);
    expect(Option.isSome(DateTime.make(result.observedAt))).toBe(true);
  }),
);

it.effect(
  'preserves an equivalent reconciled alias semantic revision for existing references',
  () =>
    Effect.gen(function* preservesAliasRevision() {
      const aliasRef = paymentTermRef('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      const aliasSemanticRevisionId = '77777777-7777-4777-8777-777777777777';
      const incompatibleSemanticRevisionId = '99999999-9999-4999-8999-999999999999';
      const aliasDefinition: PaymentTermDefinition = {
        ...active,
        definitionRevisionId: '88888888-8888-4888-8888-888888888888',
        paymentTermRef: aliasRef,
        semanticRevisionId: aliasSemanticRevisionId,
      };
      const result = yield* readCurrentPaymentTerms(
        {
          at: '2026-09-09T10:00:00.000Z',
          limit: 50,
          references: [
            { expectedSemanticRevisionId: aliasSemanticRevisionId, paymentTermRef: aliasRef },
            {
              expectedSemanticRevisionId: incompatibleSemanticRevisionId,
              paymentTermRef: aliasRef,
            },
          ],
        },
        tenantId,
        services({
          getHistory: () =>
            Effect.succeed(
              Option.some({
                aliases: [{ aliasRef, canonicalRef: ref, reconciled: provenance }],
                lifecycle: [],
                revisions: [
                  aliasDefinition,
                  {
                    ...aliasDefinition,
                    semanticFingerprint: 'b'.repeat(64),
                    semanticRevisionId: incompatibleSemanticRevisionId,
                  },
                ],
              }),
            ),
          resolveReference: () =>
            Effect.succeed({
              _tag: 'resolved' as const,
              canonicalPaymentTermId: ref.resourceId,
              definition: active,
              requestedPaymentTermId: aliasRef.resourceId,
            }),
        }),
      );

      expect(result.referenceOutcomes[0]).toEqual({
        definition: aliasDefinition,
        kind: 'USABLE',
        requestedPaymentTermRef: aliasRef,
      });
      expect(result.referenceOutcomes[1]?.kind).toBe('INCOMPATIBLE');
    }),
);

it.effect('preserves exact alias semantics without bypassing canonical retirement', () =>
  Effect.gen(function* preservesRetiredAliasRevision() {
    const aliasRef = paymentTermRef('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const aliasDefinition: PaymentTermDefinition = {
      ...active,
      definitionRevisionId: '88888888-8888-4888-8888-888888888888',
      paymentTermRef: aliasRef,
      semanticRevisionId: '77777777-7777-4777-8777-777777777777',
    };
    const result = yield* readCurrentPaymentTerms(
      {
        at: '2026-10-02T10:00:00.000Z',
        limit: 50,
        references: [
          {
            expectedSemanticRevisionId: aliasDefinition.semanticRevisionId,
            paymentTermRef: aliasRef,
          },
        ],
      },
      tenantId,
      services({
        getHistory: () =>
          Effect.succeed(
            Option.some({
              aliases: [{ aliasRef, canonicalRef: ref, reconciled: provenance }],
              lifecycle: [],
              revisions: [aliasDefinition],
            }),
          ),
        resolveReference: () =>
          Effect.succeed({
            _tag: 'retired' as const,
            canonicalPaymentTermId: ref.resourceId,
            definition: retired,
            requestedPaymentTermId: aliasRef.resourceId,
          }),
      }),
    );

    expect(result.referenceOutcomes[0]).toEqual({
      definition: {
        ...aliasDefinition,
        lifecycle: retired.lifecycle,
        retired: retired.retired,
      },
      kind: 'RETIRED',
      requestedPaymentTermRef: aliasRef,
    });
  }),
);

it.effect('does not bypass canonical or exact alias activation', () =>
  Effect.gen(function* exactAliasLifecycle() {
    const earlyAliasRef = paymentTermRef('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const lateAliasRef = paymentTermRef('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
    const earlyAlias: PaymentTermDefinition = {
      ...active,
      lifecycle: { ...active.lifecycle, effectiveFrom: '2025-01-01T00:00:00.000Z' },
      paymentTermRef: earlyAliasRef,
      semanticRevisionId: '77777777-7777-4777-8777-777777777777',
    };
    const lateAlias: PaymentTermDefinition = {
      ...active,
      lifecycle: { ...active.lifecycle, effectiveFrom: '2027-01-01T00:00:00.000Z' },
      paymentTermRef: lateAliasRef,
      semanticRevisionId: '88888888-8888-4888-8888-888888888888',
    };
    const result = yield* readCurrentPaymentTerms(
      {
        at: '2025-06-01T00:00:00.000Z',
        limit: 50,
        references: [
          {
            expectedSemanticRevisionId: earlyAlias.semanticRevisionId,
            paymentTermRef: earlyAliasRef,
          },
          {
            expectedSemanticRevisionId: lateAlias.semanticRevisionId,
            paymentTermRef: lateAliasRef,
          },
        ],
      },
      tenantId,
      services({
        getHistory: (paymentTermId) =>
          Effect.succeed(
            Option.some({
              aliases: [],
              lifecycle: [],
              revisions: [paymentTermId === earlyAliasRef.resourceId ? earlyAlias : lateAlias],
            }),
          ),
        resolveReference: (paymentTermId) =>
          Effect.succeed({
            _tag: 'not_yet_active' as const,
            activeFrom: active.lifecycle.effectiveFrom,
            canonicalPaymentTermId: ref.resourceId,
            definition: active,
            requestedPaymentTermId: paymentTermId,
          }),
      }),
    );

    expect(result.referenceOutcomes[0]?.kind).toBe('BROKEN');
    expect(result.referenceOutcomes[1]?.kind).toBe('BROKEN');
  }),
);

it.effect('current read exposes truncation instead of silently capping the catalog', () =>
  Effect.gen(function* currentReadPagination() {
    const result = yield* readCurrentPaymentTerms(
      { at: '2026-09-09T10:00:00.000Z', limit: 1, references: [] },
      tenantId,
      services({
        listCurrent: () => Effect.succeed({ definitions: [active], truncated: true }),
      }),
    );

    expect(result.current).toHaveLength(1);
    expect(result.truncated).toBe(true);
  }),
);

it.effect('history selects one exact definition revision and retains alias evidence', () =>
  Effect.gen(function* exactHistory() {
    const aliasRef = paymentTermRef('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
    const result = yield* readPaymentTermHistory(
      { definitionRevisionId: active.definitionRevisionId, paymentTermRef: aliasRef },
      tenantId,
      services({
        getHistory: () =>
          Effect.succeed(
            Option.some({
              aliases: [{ aliasRef, canonicalRef: ref, reconciled: provenance }],
              lifecycle: [],
              revisions: [
                active,
                { ...active, definitionRevisionId: provenance.actionInvocationId },
              ],
            }),
          ),
      }),
    );

    expect(result.canonicalPaymentTermRef).toEqual(ref);
    expect(result.revisions).toEqual([active]);
    expect(result.aliases).toHaveLength(1);
  }),
);
