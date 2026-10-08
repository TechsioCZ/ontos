import { expect, it } from 'effect-rstest';
import { Effect, Option, Predicate, Schema } from 'effect';
import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import { AcceptPaymentTermSourceStatementPayloadSchema } from '../../shared/domain/payment-term-source.ts';
import {
  acceptPaymentTermSourceStatementAction,
  handleAcceptPaymentTermSourceStatement,
} from '../../src/actions/accept-payment-term-source-statement.action.ts';
import {
  configurePaymentTermSourceAuthorityAction,
  handleConfigurePaymentTermSourceAuthority,
} from '../../src/actions/configure-payment-term-source-authority.action.ts';

import { PaymentTermDefinitionSchema } from '../../shared/domain/payment-term.ts';
import { PaymentTermSourceStatementResponseSchema } from '../../shared/apis/payment-term-source-statement.ts';
import { PaymentTermSourceRecordHistoryResponseSchema } from '../../shared/apis/payment-term-source-record-history.ts';
import { readPaymentTermSourceRecordHistory } from '../../src/api/payment-term-source-record-history.read.ts';
import { readPaymentTermSourceStatement } from '../../src/api/payment-term-source-statement.read.ts';

const scope = {
  authMethod: 'session' as const,
  correlationId: 'correlation',
  legalEntityId: '88888888-8888-4888-8888-888888888888',
  principalId: '44444444-4444-4444-8444-444444444444',
  tenantId: '11111111-1111-4111-8111-111111111111',
};
const statement = AcceptPaymentTermSourceStatementPayloadSchema.make({
  businessObservedAt: '2026-10-07T10:00:00.000Z',
  externalBusinessSystemId: 'erp-primary',
  integrationRoute: 'erp-definitions',
  mapping: { kind: 'EXISTING', paymentTermId: '22222222-2222-4222-8222-222222222222' },
  namespace: 'invoice-terms',
  reason: 'Authoritative source statement',
  semantics: { evidence: 'Unsupported provider condition', kind: 'UNSUPPORTED' },
  sourceCode: 'NET14',
  sourceRecordId: 'term-14',
  sourceRevision: 1,
  sourceStatementId: 'statement-1',
});
const unused = () => Effect.die('unexpected service invocation');
it.effect(
  'source Action uses trusted Principal and emits one event-linked outbox only for newly retained decisions',
  () =>
    Effect.gen(function* sourceActionEvidence() {
      for (const changed of [true, false]) {
        const collector = createActionCollector(
          acceptPaymentTermSourceStatementAction.descriptor.domainEvents,
          'payment.term-catalog',
          acceptPaymentTermSourceStatementAction.descriptor.accessEvidencePolicy,
          acceptPaymentTermSourceStatementAction.descriptor.auditEvidenceSchema,
        );
        const result = yield* handleAcceptPaymentTermSourceStatement(statement, {
          actionInvocationId: '33333333-3333-4333-8333-333333333333',
          ...collector,
          compositionRevision: 'a'.repeat(64),
          scope,
          services: {
            acceptSourceStatement: (input) => {
              expect(input.actingPrincipalId).toBe(scope.principalId);
              return Effect.succeed({
                canonicalCreated: false,
                changed,
                result: {
                  _tag: 'REJECTED',
                  reason: 'UNSUPPORTED_SEMANTICS',
                  sourceRevision: 1,
                  sourceStatementId: 'statement-1',
                },
              });
            },
            configureSourceAuthority: unused,
            getSourceRecordHistory: unused,
            getSourceStatement: unused,
          },
        });
        expect(Predicate.isTagged(result, 'REJECTED')).toBe(true);
        const evidence = collector.snapshot();
        expect(evidence.domainEvents).toHaveLength(changed ? 1 : 0);
        expect(evidence.outboxMessages).toHaveLength(changed ? 1 : 0);
        if (changed) {
          expect(evidence.outboxMessages[0]?.domainEventIndex).toBe(0);
        }
      }
    }),
);
it.effect('authority optimistic conflict has no configuration event or outbox', () =>
  Effect.gen(function* sourceActionEvidence() {
    const collector = createActionCollector(
      configurePaymentTermSourceAuthorityAction.descriptor.domainEvents,
      'payment.term-catalog',
      configurePaymentTermSourceAuthorityAction.descriptor.accessEvidencePolicy,
      configurePaymentTermSourceAuthorityAction.descriptor.auditEvidenceSchema,
    );
    const result = yield* handleConfigurePaymentTermSourceAuthority(
      {
        expectedRevision: 1,
        externalBusinessSystemId: 'erp-primary',
        ingestPrincipalId: scope.principalId,
        integrationRoute: 'erp-definitions',
        namespace: 'invoice-terms',
        reason: 'Govern source authority',
      },
      {
        actionInvocationId: '33333333-3333-4333-8333-333333333333',
        ...collector,
        compositionRevision: 'a'.repeat(64),
        scope,
        services: {
          acceptSourceStatement: unused,
          configureSourceAuthority: () => Effect.succeed({ _tag: 'revision_conflict', actualRevision: 2 }),
          getSourceRecordHistory: unused,
          getSourceStatement: unused,
        },
      },
    );
    expect(Predicate.isTagged(result, 'revision_conflict')).toBe(true);
    if (Predicate.isTagged(result, 'revision_conflict')) {
      expect(result.actualRevision).toBe(2);
    }
    expect(collector.snapshot().outboxMessages).toEqual([]);
    expect(collector.snapshot().domainEvents).toEqual([]);
  }),
);
it('new source semantics refuse legacy instant meaning and never infer meaning from external code', () => {
  const decode = Schema.decodeUnknownOption(AcceptPaymentTermSourceStatementPayloadSchema);
  expect(
    decode({
      ...statement,
      semantics: {
        calculationRuleVersion: 1,
        calendarRule: 'CALENDAR_DAYS_UTC',
        days: 14,
        dueDateAnchor: 'INVOICE_ISSUED_AT',
        kind: 'NET_DAYS',
      },
    }),
  ).toEqual(Option.none());
  expect(
    Option.isSome(
      decode({
        ...statement,
        semantics: {
          calculationRuleVersion: 2,
          calendarRule: 'CALENDAR_DAYS',
          days: Number.MAX_SAFE_INTEGER,
          dueDateAnchor: 'INVOICE_ISSUE_DATE',
          kind: 'NET_DAYS',
        },
      }),
    ),
  ).toBe(true);
});

it.effect('governed source recovery read returns FOUND with exact retained result or MISSING', () =>
  Effect.gen(function* sourceStatementRecovery() {
    const result = {
      _tag: 'REJECTED' as const,
      reason: 'UNSUPPORTED_SEMANTICS' as const,
      sourceRevision: 1,
      sourceStatementId: statement.sourceStatementId,
    };
    const found = yield* readPaymentTermSourceStatement(statement, {
      acceptSourceStatement: unused,
      configureSourceAuthority: unused,
      getSourceRecordHistory: unused,
      getSourceStatement: () => Effect.succeed(Option.some(result)),
    });
    expect(Schema.is(PaymentTermSourceStatementResponseSchema)(found)).toBe(true);
    if (Predicate.isTagged(found, 'FOUND')) {
      expect(found.result).toBe(result);
    } else {
      expect.fail('Retained source result was lost');
    }
    const missing = yield* readPaymentTermSourceStatement(statement, {
      acceptSourceStatement: unused,
      configureSourceAuthority: unused,
      getSourceRecordHistory: unused,
      getSourceStatement: () => Effect.succeed(Option.none()),
    });
    expect(Predicate.isTagged(missing, 'MISSING')).toBe(true);
  }),
);
it.effect('governed source-record history publishes bounded decision identity without private ledger ids', () =>
  Effect.gen(function* sourceRecordHistory() {
    const result = {
      _tag: 'REJECTED' as const,
      reason: 'UNSUPPORTED_SEMANTICS' as const,
      sourceRevision: 3,
      sourceStatementId: 'statement-3',
    };
    const decision = {
      authorityRevision: 2,
      businessObservedAt: statement.businessObservedAt,
      recordedAt: statement.businessObservedAt,
      result,
      sourceCode: statement.sourceCode,
      sourceRevision: 3,
      sourceStatementId: 'statement-3',
      supersededBySourceStatementId: Option.none(),
      supersedesSourceStatementId: Option.none(),
    };
    const history = {
      currentAccepted: Option.none(),
      decisions: [decision],
      highestObserved: decision,
      sourceRecord: {
        externalBusinessSystemId: statement.externalBusinessSystemId,
        integrationRoute: statement.integrationRoute,
        namespace: statement.namespace,
        sourceRecordId: statement.sourceRecordId,
      },
      truncated: false,
    };
    const read = yield* readPaymentTermSourceRecordHistory(
      { ...history.sourceRecord, limit: 25 },
      {
        acceptSourceStatement: unused,
        configureSourceAuthority: unused,
        getSourceRecordHistory: () => Effect.succeed(Option.some(history)),
        getSourceStatement: unused,
      },
    );
    expect(Schema.is(PaymentTermSourceRecordHistoryResponseSchema)(read)).toBe(true);
    expect(read).not.toHaveProperty('sourceStatementLedgerId');
    expect(read.highestObserved.sourceStatementId).toBe('statement-3');
  }),
);
it.effect(
  'actual canonical source creation emits original create and statement outboxes once; replay emits neither',
  () =>
    Effect.gen(function* sourceCanonicalCreation() {
      const provenance = {
        actionInvocationId: '33333333-3333-4333-8333-333333333333',
        actorPrincipalId: scope.principalId,
        at: '2026-10-07T10:00:00.000Z',
        reason: 'Create source canonical definition',
      };
      const definition = Schema.decodeUnknownSync(PaymentTermDefinitionSchema)({
        code: 'IMMEDIATE',
        compatibilityId: 'immediate.v2',
        created: provenance,
        definitionRevisionId: '55555555-5555-4555-8555-555555555555',
        description: 'No deferred net-days credit term',
        lifecycle: { effectiveFrom: provenance.at, effectiveTo: null, state: 'ACTIVE' },
        metadataRevision: 1,
        name: 'Immediate',
        paymentTermRef: {
          moduleId: 'payment.term-catalog',
          resourceId: '22222222-2222-4222-8222-222222222222',
          resourceType: 'payment.term-catalog.payment-term',
          tenantId: scope.tenantId,
        },
        retired: null,
        semanticFingerprint: 'a'.repeat(64),
        semanticRevisionId: '66666666-6666-4666-8666-666666666666',
        semantics: { calculationRuleVersion: 2, calendarRule: 'NOT_APPLICABLE', kind: 'IMMEDIATE' },
        updated: provenance,
      });
      const payload = {
        ...statement,
        mapping: {
          activeFrom: provenance.at,
          code: definition.code,
          description: definition.description,
          kind: 'CREATE' as const,
          name: definition.name,
        },
        semantics: {
          calculationRuleVersion: 2 as const,
          calendarRule: 'NOT_APPLICABLE' as const,
          kind: 'IMMEDIATE' as const,
        },
      };
      for (const changed of [true, false]) {
        const collector = createActionCollector(
          acceptPaymentTermSourceStatementAction.descriptor.domainEvents,
          'payment.term-catalog',
          acceptPaymentTermSourceStatementAction.descriptor.accessEvidencePolicy,
          acceptPaymentTermSourceStatementAction.descriptor.auditEvidenceSchema,
        );
        yield* handleAcceptPaymentTermSourceStatement(payload, {
          actionInvocationId: provenance.actionInvocationId,
          ...collector,
          compositionRevision: 'a'.repeat(64),
          scope,
          services: {
            acceptSourceStatement: () =>
              Effect.succeed({
                canonicalCreated: changed,
                changed,
                result: {
                  _tag: 'ACCEPTED',
                  authorityRevision: 1,
                  definition,
                  receivedAt: provenance.at,
                  sourceRevision: 1,
                  sourceStatementId: statement.sourceStatementId,
                },
              }),
            configureSourceAuthority: unused,
            getSourceRecordHistory: unused,
            getSourceStatement: unused,
          },
        });
        const evidence = collector.snapshot();
        expect(evidence.outboxMessages).toHaveLength(changed ? 2 : 0);
        expect(evidence.domainEvents).toHaveLength(changed ? 2 : 0);
        if (changed) {
          expect(evidence.domainEvents.map((event) => event.eventType)).toEqual([
            'payment.term-catalog.payment-term-created.v1',
            'payment.term-catalog.source-statement-decided.v1',
          ]);
          expect(evidence.outboxMessages.map((message) => message.domainEventIndex)).toEqual([0, 1]);
        }
      }
    }),
);
