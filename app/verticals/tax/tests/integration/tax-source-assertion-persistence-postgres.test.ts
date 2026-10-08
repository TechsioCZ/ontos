import { randomUUID } from 'node:crypto';

import { eq, sql } from 'drizzle-orm';
import { DateTime, Effect, Exit, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import type { TestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import { coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
import type { OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { EstablishTaxFactAuthorityContractPayloadSchema } from '../../shared/actions/tax-governance.ts';
import { RecordTaxSourceAssertionPayloadSchema } from '../../shared/actions/tax-source-assertion.ts';
import {
  SellingLegalEntityVatRegistrationStateRequestContractSchema,
  TaxSourceAssertionHistoryRequestContractSchema,
  TaxSourceConflictDetailRequestContractSchema,
} from '../../shared/domain/tax-source-read-contracts.ts';
import {
  taxFactAuthorityContractRevisions,
  taxFactAuthorityContracts,
  taxRelations,
  taxSourceAssertions,
  taxSourceConflicts,
} from '../../src/database/schema.ts';
import { taxAuthorityGovernancePersistenceForScope } from '../../src/services/tax-authority-governance.service.ts';
import { taxSourceAssertionPersistenceForScope } from '../../src/services/tax-source-assertion.service.ts';
import { taxSourceReadsForScope } from '../../src/services/tax-source-read.service.ts';

const tenantId = randomUUID();
const otherTenantId = randomUUID();
const sellerA = randomUUID();
const sellerB = randomUUID();
const principalId = randomUUID();
const FACT_FAMILY = 'SELLING_LEGAL_ENTITY_VAT_REGISTRATION';

const scopeFor = (tenant: string, legalEntityId: string): OperationalScope => ({
  authContextRef: `better-auth-session:${randomUUID()}`,
  authMethod: 'session',
  correlationId: randomUUID(),
  legalEntityId,
  principalId,
  tenantId: tenant,
});
const scopeA = scopeFor(tenantId, sellerA);
const scopeB = scopeFor(tenantId, sellerB);
const otherTenantScope = scopeFor(otherTenantId, sellerA);

type CoreTestDatabase = TestDatabaseFromClient<typeof coreRelations>;

const runScoped = <Value, Failure>(
  database: CoreTestDatabase,
  scope: OperationalScope,
  operation: (transaction: ScopedTransactionExecutor) => Effect.Effect<Value, Failure>,
) =>
  database.transaction((transaction) =>
    Effect.gen(function* runTaxOwnerScopedOperation() {
      const scopedTransaction = yield* installOperationalScope(transaction, scope);
      return yield* operation(scopedTransaction);
    }),
  );

/** Fixed trusted operation time, so authority coverage never depends on the wall clock. */
const operationTime = DateTime.toDateUtc(DateTime.makeUnsafe('2026-02-01T00:00:00.000Z'));

const invocation = (scope: OperationalScope, actionInvocationId: string = randomUUID(), at: Date = operationTime) => ({
  actionInvocationId,
  actorPrincipalId: principalId,
  legalEntityId: scope.legalEntityId ?? '',
  operationTime: at,
  tenantId: scope.tenantId,
});
const recordedAt = (value: string) => DateTime.toDateUtc(DateTime.makeUnsafe(value));

const contractRef = (resourceId: string) =>
  ({
    moduleId: 'commerce.tax',
    resourceId,
    resourceType: 'commerce.tax.tax-fact-authority-contract',
    tenantId,
  }) as const;
const conflictRef = (resourceId: string) =>
  ({ moduleId: 'commerce.tax', resourceId, resourceType: 'commerce.tax.tax-source-conflict', tenantId }) as const;

const assertionPayload = (overrides: Readonly<Record<string, string>> = {}) =>
  Schema.decodeEffect(RecordTaxSourceAssertionPayloadSchema)({
    factFamily: FACT_FAMILY,
    jurisdiction: 'CZ_DOMESTIC',
    provenanceRef: 'acceptance:source-assertion',
    reason: 'Record seller VAT registration evidence',
    registrationMeaning: 'REGISTERED',
    sourceAssertionKey: 'erp-assertion-1',
    sourceRecordRef: 'erp-record-1',
    sourceRef: 'erp.finance',
    validFrom: '2026-01-01T00:00:00.000Z',
    ...overrides,
  });

const AssertionIdSchema = Schema.String.pipe(Schema.brand('TaxTestSourceAssertionId'));
const ConflictIdSchema = Schema.String.pipe(Schema.brand('TaxTestSourceConflictId'));
const ContractIdSchema = Schema.String.pipe(Schema.brand('TaxTestContractId'));

const RecordedSchema = Schema.Struct({
  acceptanceOutcome: Schema.String,
  acceptanceReason: Schema.String,
  assertionId: AssertionIdSchema,
  authorityRole: Schema.String,
  conflictId: Schema.optionalKey(ConflictIdSchema),
  created: Schema.Boolean,
  eligibility: Schema.optionalKey(Schema.String),
  meaningFingerprint: Schema.String,
});

const cleanup = (admin: TestDatabaseFromClient<typeof taxRelations>) =>
  admin.transaction((transaction) =>
    Effect.gen(function* cleanupTaxSourceRows() {
      // Append-only triggers reject deletes; replica mode is the test-only escape for owned fixture rows.
      yield* transaction.execute(sql`set local session_replication_role = 'replica'`, 'objects');
      for (const tenant of [tenantId, otherTenantId]) {
        yield* transaction.delete(taxSourceConflicts).where(eq(taxSourceConflicts.tenantId, tenant));
        yield* transaction.delete(taxSourceAssertions).where(eq(taxSourceAssertions.tenantId, tenant));
        yield* transaction
          .delete(taxFactAuthorityContractRevisions)
          .where(eq(taxFactAuthorityContractRevisions.tenantId, tenant));
        yield* transaction.delete(taxFactAuthorityContracts).where(eq(taxFactAuthorityContracts.tenantId, tenant));
      }
    }),
  );

const acquireDatabases = Effect.gen(function* acquireTaxSourceTestDatabases() {
  const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
  const admin = yield* makeTestDatabaseFromClient(adminClient, taxRelations);
  // Owner services run as the least-privilege runtime role so forced RLS is part of every assertion.
  const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
  yield* cleanup(admin);
  yield* Effect.addFinalizer(() => cleanup(admin).pipe(Effect.orDie));
  return { admin, adminClient, runtime };
});

/**
 * A migration defect: a second System of Record contract the governed Action refuses to create, so it is written
 * directly with the given authority window.
 */
const insertDefectAuthority = (
  adminClient: Effect.Success<typeof testDatabaseClients>['admin'],
  stableCode: string,
  authority: Readonly<{ authorityFrom: string; authorityTo: string | null; systemOfRecordRef: string }>,
) =>
  Effect.gen(function* insertDefectAuthorityContract() {
    const defectInvocation = randomUUID();
    const [defectContract] = yield* adminClient.unsafe<{ id: string }>(
      `insert into tax.tax_fact_authority_contracts (tenant_id, legal_entity_id, fact_family, stable_code,
         action_invocation_id, actor_principal_id, idempotency_key, provenance_ref, reason)
       values ($1, $2, $3, $4, $5::uuid, $6, $5::text, 'acceptance:defect', 'Defect')
       returning tax_fact_authority_contract_id as id`,
      [tenantId, sellerA, FACT_FAMILY, stableCode, defectInvocation, principalId],
    );
    yield* adminClient.unsafe(
      `insert into tax.tax_fact_authority_contract_revisions (tenant_id, legal_entity_id, authority_from,
         authority_to, evidence_source_refs, revision_number, semantic_fingerprint, system_of_record_ref,
         tax_fact_authority_contract_id, action_invocation_id, actor_principal_id, idempotency_key,
         provenance_ref, reason)
       values ($1, $2, $3::timestamptz, $4::timestamptz, '[]'::jsonb, 1, $5, $6, $7, $8::uuid, $9, $8::text,
         'acceptance:defect', 'Defect')`,
      [
        tenantId,
        sellerA,
        authority.authorityFrom,
        authority.authorityTo,
        'f'.repeat(64),
        authority.systemOfRecordRef,
        defectContract?.id,
        defectInvocation,
        principalId,
      ],
    );
  });

const harness = (runtime: CoreTestDatabase, scope: OperationalScope = scopeA) => {
  const record = (
    payload: Effect.Success<ReturnType<typeof assertionPayload>>,
    actionInvocationId?: string,
    at?: Date,
  ) =>
    runScoped(runtime, scope, (transaction) =>
      taxSourceAssertionPersistenceForScope(transaction, scope).recordAssertion({
        ...payload,
        ...invocation(scope, actionInvocationId, at),
      }),
    );
  const recorded = (
    payload: Effect.Success<ReturnType<typeof assertionPayload>>,
    actionInvocationId?: string,
    at?: Date,
  ) => record(payload, actionInvocationId, at).pipe(Effect.flatMap(Schema.decodeUnknownEffect(RecordedSchema)));
  const reads = <Value, Failure>(
    operation: (read: ReturnType<typeof taxSourceReadsForScope>) => Effect.Effect<Value, Failure>,
  ) => runScoped(runtime, scope, (transaction) => operation(taxSourceReadsForScope(transaction, scope)));
  const stateAt = (evaluationTime: string) =>
    Schema.decodeEffect(SellingLegalEntityVatRegistrationStateRequestContractSchema)({ evaluationTime }).pipe(
      Effect.flatMap((request) => reads((read) => read.sellingLegalEntityVatRegistrationState(request))),
    );
  const history = () =>
    Schema.decodeEffect(TaxSourceAssertionHistoryRequestContractSchema)({ factFamily: FACT_FAMILY }).pipe(
      Effect.flatMap((request) => reads((read) => read.taxSourceAssertionHistory(request))),
    );
  const conflictDetail = (conflictId: string) =>
    Schema.decodeEffect(TaxSourceConflictDetailRequestContractSchema)({ conflictRef: conflictRef(conflictId) }).pipe(
      Effect.flatMap((request) => reads((read) => read.taxSourceConflictDetail(request))),
    );
  const establish = (
    stableCode: string,
    systemOfRecordRef: string,
    authority: Readonly<{ authorityFrom?: string; authorityTo?: string }> = {},
  ) =>
    Schema.decodeEffect(EstablishTaxFactAuthorityContractPayloadSchema)({
      authority: {
        authorityFrom: '2026-01-01T00:00:00.000Z',
        evidenceSourceRefs: ['tax.vies'],
        systemOfRecordRef,
        ...authority,
      },
      factFamily: FACT_FAMILY,
      provenanceRef: `acceptance:${stableCode}`,
      reason: 'Govern VAT registration authority',
      stableCode,
    }).pipe(
      Effect.flatMap((payload) =>
        runScoped(runtime, scope, (transaction) =>
          taxAuthorityGovernancePersistenceForScope(transaction, scope).establishContract({
            ...payload,
            ...invocation(scope),
          }),
        ),
      ),
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Struct({ contractId: ContractIdSchema }))),
    );
  const visibleAssertions = () =>
    runScoped(runtime, scope, (transaction) =>
      transaction.select({ id: taxSourceAssertions.taxSourceAssertionId }).from(taxSourceAssertions),
    );
  const visibleConflicts = () =>
    runScoped(runtime, scope, (transaction) =>
      transaction
        .select({ kind: taxSourceConflicts.conflictKind, status: taxSourceConflicts.status })
        .from(taxSourceConflicts),
    );
  return { conflictDetail, establish, history, record, recorded, stateAt, visibleAssertions, visibleConflicts };
};

it.live(
  '#958 F10-F11 F20 #959 F4-F6 replay is idempotent and a reused assertion identity is an integrity conflict',
  () =>
    Effect.scoped(
      Effect.gen(function* sourceAssertionIdentity() {
        const { runtime } = yield* acquireDatabases;
        const tax = harness(runtime);
        yield* tax.establish('vat-registration', 'erp.finance');
        const payload = yield* assertionPayload();
        const coreInvocation = randomUUID();

        const first = yield* tax.recorded(payload, coreInvocation);
        expect(first).toMatchObject({
          acceptanceOutcome: 'ACCEPTED',
          authorityRole: 'SYSTEM_OF_RECORD',
          created: true,
        });

        // Core-invocation replay returns the original outcome.
        expect(yield* tax.recorded(payload, coreInvocation)).toEqual({ ...first, created: false });
        // The same Core invocation with another meaning is idempotency reuse, never a new assertion.
        const reused = yield* tax.record(
          yield* assertionPayload({ validFrom: '2026-01-15T00:00:00.000Z' }),
          coreInvocation,
        );
        expect(reused).toEqual({ conflict: 'IDEMPOTENCY_REUSED', kind: 'conflict' });

        // A redelivery of the same immutable assertion through another invocation is a replay (#959 F4-F5).
        const redelivered = yield* tax.recorded(yield* assertionPayload({ deliveryRef: 'redelivery-2' }));
        expect(redelivered).toEqual({ ...first, created: false });

        // Same assertion key, different meaning: integrity conflict, no new assertion row (#958 F11, #959 F6).
        const changed = yield* assertionPayload({ validFrom: '2025-06-01T00:00:00.000Z' });
        const integrityInvocation = randomUUID();
        const integrity = yield* tax.recorded(changed, integrityInvocation);
        expect(integrity).toMatchObject({
          acceptanceOutcome: 'REJECTED',
          acceptanceReason: 'ASSERTION_IDENTITY_CONFLICT',
          assertionId: first.assertionId,
          authorityRole: 'NONE',
          created: true,
        });
        expect(yield* tax.visibleAssertions()).toEqual([{ id: first.assertionId }]);
        expect(yield* tax.visibleConflicts()).toEqual([{ kind: 'ASSERTION_INTEGRITY', status: 'OPEN' }]);
        // Replaying the conflicting delivery names the same conflict and records nothing new.
        expect(yield* tax.recorded(changed, integrityInvocation)).toEqual({ ...integrity, created: false });
        expect(yield* tax.recorded(changed)).toEqual({ ...integrity, created: false });
        expect(yield* tax.visibleConflicts()).toHaveLength(1);

        const detail = Option.getOrThrow(yield* tax.conflictDetail(integrity.conflictId ?? ''));
        expect(detail).toMatchObject({
          conflictKind: 'ASSERTION_INTEGRITY',
          detail: {
            deliveredFingerprint: integrity.meaningFingerprint,
            sourceAssertionKey: 'erp-assertion-1',
            sourceRef: 'erp.finance',
            storedFingerprint: first.meaningFingerprint,
          },
          status: 'OPEN',
        });
        expect(Option.getOrThrow(detail.subjectAssertion).assertionRef.resourceId).toBe(first.assertionId);
        expect(Option.isNone(detail.relatedAssertion)).toBe(true);

        // Same assertion key under another Source Record Reference is never a silent replay (#958 F8-F11).
        const otherRecord = yield* tax.recorded(yield* assertionPayload({ sourceRecordRef: 'erp-record-2' }));
        expect(otherRecord).toMatchObject({
          acceptanceOutcome: 'REJECTED',
          acceptanceReason: 'ASSERTION_IDENTITY_CONFLICT',
          assertionId: first.assertionId,
          created: true,
        });
        expect(otherRecord.conflictId).not.toBe(integrity.conflictId);
        expect(yield* tax.visibleAssertions()).toEqual([{ id: first.assertionId }]);
        expect(yield* tax.visibleConflicts()).toHaveLength(2);
      }),
    ),
);

it.live('#957 BDD valid source assertion passes acceptance and participates in owner-governed resolution', () =>
  Effect.scoped(
    Effect.gen(function* validSourceAssertionPassesAcceptance() {
      const { runtime } = yield* acquireDatabases;
      const tax = harness(runtime);
      // Exact subject, permitted source, known jurisdiction, validity and provenance.
      yield* tax.establish('vat-registration', 'erp.finance');
      const valid = yield* tax.recorded(yield* assertionPayload());
      expect(valid).toMatchObject({
        acceptanceOutcome: 'ACCEPTED',
        acceptanceReason: 'ACCEPTED',
        authorityRole: 'SYSTEM_OF_RECORD',
        created: true,
        eligibility: 'ELIGIBLE',
      });
      expect((yield* tax.history()).assertions[0]).toMatchObject({
        acceptanceOutcome: 'ACCEPTED',
        acceptanceReason: 'ACCEPTED',
      });
      const state = yield* tax.stateAt('2026-06-01T00:00:00.000Z');
      expect(state).toMatchObject({ reason: 'AUTHORITATIVE_POSITIVE', state: 'CURRENT_POSITIVE' });
      expect(state.basisAssertionRefs.map(({ resourceId }) => resourceId)).toEqual([valid.assertionId]);

      // Unknown validity meaning is never derived: the permitted source's assertion is UNVERIFIABLE (#957 F21, F29).
      const unknownEnd = yield* tax.recorded(
        yield* assertionPayload({ registrationMeaning: 'ENDED', sourceAssertionKey: 'erp-ended-without-end' }),
      );
      expect(unknownEnd).toMatchObject({
        acceptanceOutcome: 'UNVERIFIABLE',
        acceptanceReason: 'VALIDITY_UNKNOWN',
        eligibility: 'VALIDITY_UNKNOWN',
      });
      expect((yield* tax.stateAt('2026-06-01T00:00:00.000Z')).basisAssertionRefs).toEqual(state.basisAssertionRefs);
    }),
  ),
);

it.live(
  '#959 F8 F15-F19 F25 an assertion recorded before its authority contract decides once the contract covers E',
  () =>
    Effect.scoped(
      Effect.gen(function* contractlessAssertion() {
        const { runtime } = yield* acquireDatabases;
        const tax = harness(runtime);
        const recorded = yield* tax.recorded(
          yield* assertionPayload({ issuedAt: '2026-01-20T00:00:00.000Z', observedAt: '2026-01-21T00:00:00.000Z' }),
        );
        // Eligible, but no contract covers the claim: never ACCEPTED without a fact-level contract (#957 H, F29).
        expect(recorded).toMatchObject({
          acceptanceOutcome: 'UNVERIFIABLE',
          acceptanceReason: 'AUTHORITY_MISSING',
          authorityRole: 'NONE',
          created: true,
          eligibility: 'ELIGIBLE',
        });
        const { assertions, completeness } = yield* tax.history();
        expect(completeness.rowCount).toBe(1);
        expect(assertions[0]).toMatchObject({
          acceptanceOutcome: 'UNVERIFIABLE',
          acceptanceReason: 'AUTHORITY_MISSING',
          authorityContractRevisionId: Option.none(),
          authorityRole: 'NONE',
          eligibility: 'ELIGIBLE',
          sourceRecordRef: 'erp-record-1',
        });
        // Source times are echoed as given; validity is never derived from them (#958 F13-F16, F26).
        expect(assertions[0]?.observedAt).toEqual(Option.some(DateTime.makeUnsafe('2026-01-21T00:00:00.000Z')));
        expect(assertions[0]?.validTo).toEqual(Option.none());
        expect(yield* tax.stateAt('2026-06-01T00:00:00.000Z')).toMatchObject({
          authority: { outcome: 'AUTHORITY_MISSING' },
          reason: 'AUTHORITY_MISSING',
          state: 'UNKNOWN',
        });

        // The contract established afterwards makes the source the System of Record: the earlier assertion decides.
        yield* tax.establish('vat-registration', 'erp.finance');
        const current = yield* tax.stateAt('2026-06-01T00:00:00.000Z');
        expect(current).toMatchObject({ reason: 'AUTHORITATIVE_POSITIVE', state: 'CURRENT_POSITIVE' });
        expect(current.basisAssertionRefs.map(({ resourceId }) => resourceId)).toEqual([recorded.assertionId]);
        // The history evaluates acceptance at read time under the contract now covering the claim (#959 F25).
        expect((yield* tax.history()).assertions[0]).toMatchObject({
          acceptanceOutcome: 'ACCEPTED',
          acceptanceReason: 'ACCEPTED',
          authorityRole: 'NONE',
        });
        // A redelivery echoes the stored eligibility and recording-time provenance (#959 F4) with a fresh
        // evaluation: the changed authoritative state is a new evaluation, not a rewritten record (#959 F25).
        expect(
          yield* tax.recorded(
            yield* assertionPayload({ issuedAt: '2026-01-20T00:00:00.000Z', observedAt: '2026-01-21T00:00:00.000Z' }),
          ),
        ).toEqual({
          ...recorded,
          acceptanceOutcome: 'ACCEPTED',
          acceptanceReason: 'ACCEPTED',
          created: false,
        });
      }),
    ),
);

it.live('#959 F7-F9 F25 a late assertion of the former System of Record decides the instants before the handoff', () =>
  Effect.scoped(
    Effect.gen(function* lateAssertionOfFormerSystemOfRecord() {
      const { runtime } = yield* acquireDatabases;
      const tax = harness(runtime);
      // Authority handoff A → B at 2026-01-15; every assertion below is recorded on 2026-02-01, after it.
      yield* tax.establish('vat-registration', 'erp.finance', { authorityTo: '2026-01-15T00:00:00.000Z' });
      yield* tax.establish('vat-registration-next', 'erp.next', { authorityFrom: '2026-01-15T00:00:00.000Z' });
      const late = yield* tax.recorded(
        yield* assertionPayload({ validFrom: '2026-01-01T00:00:00.000Z', validTo: '2026-01-15T00:00:00.000Z' }),
      );
      // Recorded outside its authority window: no role at recording time, yet its source is the System of Record
      // over the claimed instants, so it is ACCEPTED (#959 F8, F25).
      expect(late).toMatchObject({ acceptanceOutcome: 'ACCEPTED', authorityRole: 'NONE', created: true });
      const beforeHandoff = yield* tax.stateAt('2026-01-10T00:00:00.000Z');
      expect(beforeHandoff).toMatchObject({
        authority: { systemOfRecordRef: Option.some('erp.finance') },
        reason: 'AUTHORITATIVE_POSITIVE',
        state: 'CURRENT_POSITIVE',
      });
      expect(beforeHandoff.basisAssertionRefs.map(({ resourceId }) => resourceId)).toEqual([late.assertionId]);
      // After the handoff the former System of Record no longer decides anything.
      expect(yield* tax.stateAt('2026-03-01T00:00:00.000Z')).toMatchObject({
        authority: { systemOfRecordRef: Option.some('erp.next') },
        basisAssertionRefs: [],
        reason: 'NO_AUTHORITATIVE_ASSERTION',
        state: 'UNKNOWN',
      });
    }),
  ),
);

it.live('#959 F8 F25 an assertion of the next System of Record recorded before its handoff decides after it', () =>
  Effect.scoped(
    Effect.gen(function* earlyAssertionOfNextSystemOfRecord() {
      const { runtime } = yield* acquireDatabases;
      const tax = harness(runtime);
      // Authority handoff A → B at 2026-03-01; the assertion of B is recorded on 2026-02-01, before it.
      yield* tax.establish('vat-registration', 'erp.finance', { authorityTo: '2026-03-01T00:00:00.000Z' });
      yield* tax.establish('vat-registration-next', 'erp.next', { authorityFrom: '2026-03-01T00:00:00.000Z' });
      const early = yield* tax.recorded(
        yield* assertionPayload({
          sourceAssertionKey: 'next-1',
          sourceRef: 'erp.next',
          validFrom: '2026-03-01T00:00:00Z',
        }),
      );
      expect(early).toMatchObject({ acceptanceOutcome: 'ACCEPTED', authorityRole: 'NONE', created: true });
      const afterHandoff = yield* tax.stateAt('2026-06-01T00:00:00.000Z');
      expect(afterHandoff).toMatchObject({
        authority: { systemOfRecordRef: Option.some('erp.next') },
        reason: 'AUTHORITATIVE_POSITIVE',
        state: 'CURRENT_POSITIVE',
      });
      expect(afterHandoff.basisAssertionRefs.map(({ resourceId }) => resourceId)).toEqual([early.assertionId]);
      expect((yield* tax.stateAt('2026-02-01T00:00:00.000Z')).reason).toBe('NO_AUTHORITATIVE_ASSERTION');
    }),
  ),
);

it.live(
  '#959 F1-F2 F10-F11 F25 conflicts compare sources only under the System of Record covering the contradicting instants',
  () =>
    Effect.scoped(
      Effect.gen(function* conflictsAcrossAuthorityHandoff() {
        const { runtime } = yield* acquireDatabases;
        const tax = harness(runtime);
        // Handoff S1 → S2 at 2026-03-01; VIES is evidence under both revisions.
        yield* tax.establish('vat-registration', 'erp.finance', { authorityTo: '2026-03-01T00:00:00.000Z' });
        yield* tax.establish('vat-registration-next', 'erp.next', { authorityFrom: '2026-03-01T00:00:00.000Z' });
        // S1 asserted an open registration while it was the System of Record.
        const formerRecord = yield* tax.recorded(
          yield* assertionPayload(),
          undefined,
          recordedAt('2026-02-01T00:00:00Z'),
        );
        expect(formerRecord.authorityRole).toBe('SYSTEM_OF_RECORD');
        const afterHandoff = recordedAt('2026-03-10T00:00:00Z');
        const current = yield* tax.recorded(
          yield* assertionPayload({
            registrationMeaning: 'NON_REGISTERED',
            sourceAssertionKey: 'next-1',
            sourceRef: 'erp.next',
            validFrom: '2026-03-01T00:00:00Z',
          }),
          undefined,
          afterHandoff,
        );
        expect(current.conflictId).toBeUndefined();
        // Evidence agreeing with the current System of Record: the superseded S1 claim is not a disagreement.
        const agreeing = yield* tax.recorded(
          yield* assertionPayload({
            registrationMeaning: 'NON_REGISTERED',
            sourceAssertionKey: 'vies-1',
            sourceRef: 'tax.vies',
            validFrom: '2026-03-01T00:00:00Z',
          }),
          undefined,
          afterHandoff,
        );
        expect(agreeing).toMatchObject({ authorityRole: 'EVIDENCE', created: true });
        expect(agreeing.conflictId).toBeUndefined();
        expect(yield* tax.visibleConflicts()).toEqual([]);

        // Evidence contradicting the CURRENT System of Record is an explicit disagreement with it.
        const contradicting = yield* tax.recorded(
          yield* assertionPayload({
            sourceAssertionKey: 'vies-2',
            sourceRef: 'tax.vies',
            validFrom: '2026-03-01T00:00:00Z',
          }),
          undefined,
          afterHandoff,
        );
        const disagreement = Option.getOrThrow(yield* tax.conflictDetail(contradicting.conflictId ?? ''));
        expect(disagreement.conflictKind).toBe('EVIDENCE_DISAGREEMENT');
        expect(Option.getOrThrow(disagreement.relatedAssertion).assertionRef.resourceId).toBe(current.assertionId);
        expect(yield* tax.visibleConflicts()).toEqual([{ kind: 'EVIDENCE_DISAGREEMENT', status: 'OPEN' }]);
        const state = yield* tax.stateAt('2026-06-01T00:00:00.000Z');
        expect(state).toMatchObject({ reason: 'AUTHORITATIVE_NEGATIVE', state: 'KNOWN_ENDED_OR_NON_REGISTERED' });
        expect(state.basisAssertionRefs.map(({ resourceId }) => resourceId)).toEqual([current.assertionId]);
        expect(state.evidenceDisagreementRefs.map(({ resourceId }) => resourceId)).toEqual([contradicting.assertionId]);
      }),
    ),
);

it.live(
  '#922 #925 #959 F2 F10-F11 F27-F28 seller VAT registration state follows the System of Record; evidence and configuration conflicts stay explicit',
  () =>
    Effect.scoped(
      Effect.gen(function* registrationStateEndToEnd() {
        const { adminClient, runtime } = yield* acquireDatabases;
        const tax = harness(runtime);
        const contract = yield* tax.establish('vat-registration', 'erp.finance');

        const positive = yield* tax.recorded(yield* assertionPayload());
        const current = yield* tax.stateAt('2026-06-01T00:00:00.000Z');
        expect(current).toMatchObject({
          authority: {
            contractRef: Option.some(contractRef(contract.contractId)),
            outcome: 'AUTHORITY_ESTABLISHED',
            systemOfRecordRef: Option.some('erp.finance'),
          },
          completeness: { rowCount: 1 },
          reason: 'AUTHORITATIVE_POSITIVE',
          state: 'CURRENT_POSITIVE',
        });
        expect(current.basisAssertionRefs.map(({ resourceId }) => resourceId)).toEqual([positive.assertionId]);

        // An evidence source disagrees: a conflict row, the authoritative state is unchanged (#959 F10, F27).
        const vies = yield* tax.recorded(
          yield* assertionPayload({
            registrationMeaning: 'NON_REGISTERED',
            sourceAssertionKey: 'vies-check-1',
            sourceRecordRef: 'vies-request-1',
            sourceRef: 'tax.vies',
            validFrom: '2026-03-01T00:00:00.000Z',
          }),
        );
        expect(vies).toMatchObject({ acceptanceOutcome: 'ACCEPTED', authorityRole: 'EVIDENCE', created: true });
        // A redelivery through a new invocation echoes the original outcome, including its first conflict (#959 F4).
        const viesRedelivered = yield* tax.recorded(
          yield* assertionPayload({
            deliveryRef: 'vies-redelivery-2',
            registrationMeaning: 'NON_REGISTERED',
            sourceAssertionKey: 'vies-check-1',
            sourceRecordRef: 'vies-request-1',
            sourceRef: 'tax.vies',
            validFrom: '2026-03-01T00:00:00.000Z',
          }),
        );
        expect(viesRedelivered).toEqual({ ...vies, created: false });
        const disagreement = Option.getOrThrow(yield* tax.conflictDetail(vies.conflictId ?? ''));
        expect(disagreement.conflictKind).toBe('EVIDENCE_DISAGREEMENT');
        expect(Option.getOrThrow(disagreement.subjectAssertion).assertionRef.resourceId).toBe(vies.assertionId);
        expect(Option.getOrThrow(disagreement.relatedAssertion).assertionRef.resourceId).toBe(positive.assertionId);
        const disputed = yield* tax.stateAt('2026-06-01T00:00:00.000Z');
        expect(disputed.state).toBe('CURRENT_POSITIVE');
        expect(disputed.evidenceDisagreementRefs.map(({ resourceId }) => resourceId)).toEqual([vies.assertionId]);

        // A source without a role for the fact family at E never decides nor disagrees there.
        const ares = yield* tax.recorded(
          yield* assertionPayload({
            registrationMeaning: 'NON_REGISTERED',
            sourceAssertionKey: 'ares-1',
            sourceRef: 'ares.registry',
          }),
        );
        // Covered by the contract over its whole claim but never permitted there (#957 F12, F27).
        expect(ares).toMatchObject({
          acceptanceOutcome: 'REJECTED',
          acceptanceReason: 'SOURCE_NOT_PERMITTED',
          authorityRole: 'NONE',
          created: true,
          eligibility: 'ELIGIBLE',
        });
        expect(ares.conflictId).toBeUndefined();
        const withUnpermitted = yield* tax.stateAt('2026-06-01T00:00:00.000Z');
        expect(withUnpermitted.state).toBe('CURRENT_POSITIVE');
        expect(withUnpermitted.basisAssertionRefs).toEqual(disputed.basisAssertionRefs);
        expect(withUnpermitted.evidenceDisagreementRefs).toEqual(disputed.evidenceDisagreementRefs);

        // The System of Record contradicts itself without correction semantics: UNRESOLVED (#925 F25).
        const contradiction = yield* tax.recorded(
          yield* assertionPayload({
            registrationMeaning: 'NON_REGISTERED',
            sourceAssertionKey: 'erp-assertion-2',
            validFrom: '2026-05-01T00:00:00.000Z',
          }),
        );
        expect(Option.getOrThrow(yield* tax.conflictDetail(contradiction.conflictId ?? '')).conflictKind).toBe(
          'INCOMPATIBLE_AUTHORITATIVE_ASSERTIONS',
        );
        expect(yield* tax.stateAt('2026-06-01T00:00:00.000Z')).toMatchObject({
          reason: 'INCOMPATIBLE_AUTHORITATIVE_ASSERTIONS',
          state: 'UNRESOLVED',
        });
        expect((yield* tax.stateAt('2026-04-01T00:00:00.000Z')).state).toBe('CURRENT_POSITIVE');

        // A migration defect leaves a second System of Record contract. No technical winner is chosen (#959 F2-F3,
        // F28).
        yield* insertDefectAuthority(adminClient, 'vat-registration-defect', {
          authorityFrom: '2026-01-01T00:00:00.000Z',
          authorityTo: null,
          systemOfRecordRef: 'ares.registry',
        });
        expect(yield* tax.stateAt('2026-06-01T00:00:00.000Z')).toMatchObject({
          authority: { contractRef: Option.none(), outcome: 'AUTHORITY_CONFLICT', systemOfRecordRef: Option.none() },
          reason: 'AUTHORITY_CONFIGURATION_CONFLICT',
          state: 'UNRESOLVED',
        });
        const underConflict = yield* tax.recorded(yield* assertionPayload({ sourceAssertionKey: 'erp-assertion-3' }));
        expect(underConflict).toMatchObject({
          acceptanceOutcome: 'NEEDS_REVIEW',
          acceptanceReason: 'AUTHORITY_CONFIGURATION_CONFLICT',
          authorityRole: 'NONE',
        });
        const configuration = Option.getOrThrow(yield* tax.conflictDetail(underConflict.conflictId ?? ''));
        expect(configuration).toMatchObject({
          conflictKind: 'AUTHORITY_CONFIGURATION',
          detail: { assertionId: underConflict.assertionId },
        });
        expect(configuration.detail.contractRevisionIds).toHaveLength(2);

        // The history keeps every assertion with its recording-time role, ordered by identity.
        const { assertions } = yield* tax.history();
        const ids = assertions.map(({ assertionRef }) => assertionRef.resourceId);
        expect(ids).toEqual(ids.toSorted((left, right) => left.localeCompare(right, 'en')));
        expect(assertions.map(({ authorityRole }) => authorityRole).toSorted()).toEqual([
          'EVIDENCE',
          'NONE',
          'NONE',
          'SYSTEM_OF_RECORD',
          'SYSTEM_OF_RECORD',
        ]);
        // Acceptance is evaluated at read time: the competing contract now covers every claim (#959 F2-F3, F25).
        expect(new Set(assertions.map(({ acceptanceOutcome }) => acceptanceOutcome))).toEqual(
          new Set(['NEEDS_REVIEW']),
        );
      }),
    ),
);

it.live('#959 F2-F3 F28 a configuration conflict is detected over the claimed validity, never at operation time', () =>
  Effect.scoped(
    Effect.gen(function* configurationConflictOverClaim() {
      const { adminClient, runtime } = yield* acquireDatabases;
      const tax = harness(runtime);
      yield* tax.establish('vat-registration', 'erp.finance');
      // Two defects: a past dual-authority window, and a current one opening after the clean period.
      yield* insertDefectAuthority(adminClient, 'vat-registration-past-defect', {
        authorityFrom: '2026-01-01T00:00:00.000Z',
        authorityTo: '2026-01-15T00:00:00.000Z',
        systemOfRecordRef: 'ares.registry',
      });
      yield* insertDefectAuthority(adminClient, 'vat-registration-current-defect', {
        authorityFrom: '2026-03-01T00:00:00.000Z',
        authorityTo: null,
        systemOfRecordRef: 'ares.registry',
      });

      // Recorded while one System of Record covers the operation time, claiming only the past overlap.
      const late = yield* tax.recorded(
        yield* assertionPayload({ sourceAssertionKey: 'erp-late', validTo: '2026-01-10T00:00:00.000Z' }),
      );
      expect(late).toMatchObject({
        acceptanceOutcome: 'NEEDS_REVIEW',
        acceptanceReason: 'AUTHORITY_CONFIGURATION_CONFLICT',
        authorityRole: 'SYSTEM_OF_RECORD',
      });
      const configuration = Option.getOrThrow(yield* tax.conflictDetail(late.conflictId ?? ''));
      expect(configuration).toMatchObject({
        conflictKind: 'AUTHORITY_CONFIGURATION',
        detail: { assertionId: late.assertionId },
      });
      expect(configuration.detail.contractRevisionIds).toHaveLength(2);

      // Recorded during the current overlap, claiming only the earlier clean period: accepted, no conflict.
      const clean = yield* tax.recorded(
        yield* assertionPayload({
          sourceAssertionKey: 'erp-clean',
          validFrom: '2026-01-20T00:00:00.000Z',
          validTo: '2026-02-15T00:00:00.000Z',
        }),
        undefined,
        recordedAt('2026-04-01T00:00:00.000Z'),
      );
      expect(clean).toMatchObject({
        acceptanceOutcome: 'ACCEPTED',
        acceptanceReason: 'ACCEPTED',
        authorityRole: 'NONE',
      });
      expect(clean.conflictId).toBeUndefined();
      expect(yield* tax.visibleConflicts()).toEqual([{ kind: 'AUTHORITY_CONFIGURATION', status: 'OPEN' }]);
    }),
  ),
);

it.live('#950 F24-F28 source evidence is isolated per Tenant and Selling Legal Entity by forced RLS', () =>
  Effect.scoped(
    Effect.gen(function* sourceEvidenceIsolation() {
      const { runtime } = yield* acquireDatabases;
      const sellerATax = harness(runtime, scopeA);
      yield* sellerATax.establish('vat-registration', 'erp.finance');
      const recorded = yield* sellerATax.recorded(yield* assertionPayload());
      const integrity = yield* sellerATax.recorded(yield* assertionPayload({ validFrom: '2025-01-01T00:00:00Z' }));

      for (const scope of [scopeB, otherTenantScope]) {
        const other = harness(runtime, scope);
        expect(yield* other.visibleAssertions()).toEqual([]);
        expect(yield* other.visibleConflicts()).toEqual([]);
        expect((yield* other.history()).assertions).toEqual([]);
        expect((yield* other.stateAt('2026-06-01T00:00:00.000Z')).state).toBe('UNKNOWN');
      }
      expect(Option.isNone(yield* harness(runtime, scopeB).conflictDetail(integrity.conflictId ?? ''))).toBe(true);
      // Seller B records its own assertion with the same source key; identities never cross sellers.
      const sellerBRecord = yield* harness(runtime, scopeB).recorded(yield* assertionPayload());
      // Seller A's contract never covers seller B: no authority, so never ACCEPTED (#957 H).
      expect(sellerBRecord).toMatchObject({
        acceptanceOutcome: 'UNVERIFIABLE',
        acceptanceReason: 'AUTHORITY_MISSING',
        authorityRole: 'NONE',
        created: true,
      });
      expect(sellerBRecord.assertionId).not.toBe(recorded.assertionId);

      // A payload cannot write into another seller's scope: the trusted scope decides.
      const forgedPayload = yield* assertionPayload({ sourceAssertionKey: 'forged' });
      const forged = yield* runScoped(runtime, scopeB, (transaction) =>
        taxSourceAssertionPersistenceForScope(transaction, scopeB).recordAssertion({
          ...forgedPayload,
          ...invocation(scopeA),
        }),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(forged)).toBe(true);
    }),
  ),
);

it.live('#958 F7-F9 #959 F12 source assertions and conflicts are immutable for the runtime role', () =>
  Effect.scoped(
    Effect.gen(function* sourceEvidenceImmutability() {
      const { runtime } = yield* acquireDatabases;
      const tax = harness(runtime);
      const recorded = yield* tax.recorded(yield* assertionPayload());
      yield* tax.recorded(yield* assertionPayload({ validFrom: '2025-01-01T00:00:00Z' }));
      const update = yield* runScoped(runtime, scopeA, (transaction) =>
        transaction
          .update(taxSourceAssertions)
          .set({ registrationMeaning: 'ENDED' })
          .where(eq(taxSourceAssertions.taxSourceAssertionId, recorded.assertionId)),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(update)).toBe(true);
      const remove = yield* runScoped(runtime, scopeA, (transaction) =>
        transaction.delete(taxSourceConflicts).where(eq(taxSourceConflicts.tenantId, tenantId)),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(remove)).toBe(true);
      const resolve = yield* runScoped(runtime, scopeA, (transaction) =>
        transaction
          .update(taxSourceConflicts)
          .set({ status: 'RESOLVED' })
          .where(eq(taxSourceConflicts.tenantId, tenantId)),
      ).pipe(Effect.exit);
      expect(Exit.isFailure(resolve)).toBe(true);
      expect(yield* tax.visibleConflicts()).toEqual([{ kind: 'ASSERTION_INTEGRITY', status: 'OPEN' }]);
      expect((yield* tax.history()).assertions[0]?.registrationMeaning).toBe('REGISTERED');
    }),
  ),
);
