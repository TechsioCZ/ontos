import { NodeCrypto } from '@effect/platform-node';
import { eq, sql } from 'drizzle-orm';
import {
  Array as Arr,
  Context,
  Crypto,
  Data,
  DateTime,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Layer,
  Match,
  Option,
  Schema,
} from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import type { TestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import { coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
import type { DomainEventReference, OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import {
  FinalOrderTaxHandoffSchema,
  FinalizeOrderTaxPayloadSchema,
  FinalizeOrderTaxResultSchema,
  OrderSubmissionRefSchema,
} from '../../shared/actions/order-tax-finalization.ts';
import { FinalOrderTaxRequestSchema, FinalOrderTaxResponseSchema } from '../../shared/apis/final-order-tax.ts';
import { TaxGovernanceAuditEvidenceSchema, TaxGovernanceConflict } from '../../shared/domain/tax-governance-errors.ts';
import { SellerNotVatPayerTreatmentSchema } from '../../shared/domain/tax-kernel/tax-treatment.ts';
import { handleFinalizeOrderTax } from '../../src/actions/finalize-order-tax.action.ts';
import { readFinalOrderTax } from '../../src/api/final-order-tax.read.ts';
import type { FinalizeOrderTaxResult } from '../../shared/actions/order-tax-finalization.ts';
import {
  DeclareSellerVatRegimePayloadSchema,
  ImportSellerVatRegimeDeclarationsPayloadSchema,
} from '../../shared/actions/seller-vat-regime-declaration.ts';
import {
  CorrectTaxRuleRevisionPayloadSchema,
  CreateTaxRulePayloadSchema,
} from '../../shared/actions/tax-governance.ts';
import {
  TaxRuleMissingSchema,
  TaxCaseUnsupportedSchema,
  TaxNonSuccessOutcomeSchema,
  TaxStateIndeterminateSchema,
} from '../../shared/domain/tax-kernel/tax-non-success-outcome.ts';
import {
  taxOrderTaxFinalizations,
  taxRelations,
  taxRuleCorrections,
  taxRuleRevisionEndFacts,
  taxRuleRevisions,
  taxRules,
  taxSellerVatRegimeDeclarations,
} from '../../src/database/schema.ts';
import { taxGovernedReadsForScope } from '../../src/services/tax-governed-read.service.ts';
import { orderTaxFinalizationsForScope } from '../../src/services/order-tax-finalization.service.ts';
import { orderTaxIntentFingerprint } from '../../src/domain/order-tax-finalization.ts';
import { taxMeaningFingerprint } from '../../src/services/tax-governance-fingerprint.ts';
import { taxRuleGovernancePersistenceForScope } from '../../src/services/tax-rule-governance.service.ts';
import { sellerVatRegimeDeclarationsForScope } from '../../src/services/seller-vat-regime-declaration.service.ts';
import { occurrenceInput, purchaseBindingInput } from '../unit/tax-domain-fixtures.ts';
import {
  PRICING_RESULT_REF,
  evaluationRequestInput,
  eligibilityHandoff,
  grossLine,
  pricingLine,
  shippingCharge,
} from '../unit/tax-evaluation-fixtures.ts';

const T = '2026-06-01T10:00:00.000Z';

const nextUuid = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());
const invocationIdOr = (actionInvocationId: string | undefined) =>
  actionInvocationId === undefined ? nextUuid : Effect.succeed(actionInvocationId);

interface FixtureIdentity {
  readonly principalId: string;
  readonly tenantId: string;
}

const scopeFor = Effect.fnUntraced(function* fixtureScopeFor(
  identity: FixtureIdentity,
  legalEntityId: string,
  tenant: string = identity.tenantId,
) {
  const scope: OperationalScope = {
    authContextRef: `better-auth-session:${yield* nextUuid}`,
    authMethod: 'session',
    correlationId: yield* nextUuid,
    legalEntityId,
    principalId: identity.principalId,
    tenantId: tenant,
  };
  return scope;
});

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

const operationTime = DateTime.toDateUtc(DateTime.makeUnsafe('2026-02-01T00:00:00.000Z'));
const invocation = (scope: OperationalScope, actionInvocationId: string, at: Date = operationTime) => ({
  actionInvocationId,
  actorPrincipalId: scope.principalId,
  legalEntityId: scope.legalEntityId ?? '',
  operationTime: at,
  tenantId: scope.tenantId,
});

const actionContext = <Services>(
  scope: OperationalScope,
  services: Services,
  audit: unknown[],
  actionInvocationId: string,
) => {
  // The production collector owns this opaque reference; TAX adds no domain event, so it is never dereferenced.
  const eventReference: DomainEventReference = Schema.decodeSync(Schema.Any)({});
  return {
    actionInvocationId,
    addDomainEvent: () => Effect.succeed(eventReference),
    addOutboxMessage: () => Effect.void,
    compositionRevision: 'c'.repeat(64),
    recordAuditEvidence: (evidence: Readonly<Record<string, Schema.Json>>) => {
      audit.push(evidence);
      return Effect.void;
    },
    recordDataAccess: () => Effect.void,
    scope,
    services,
  };
};

const cleanup = (admin: TestDatabaseFromClient<typeof taxRelations>, tenantId: string) =>
  admin.transaction((transaction) =>
    Effect.gen(function* cleanupOrderTaxRows() {
      // Append-only triggers reject deletes; replica mode is the test-only escape for owned fixture rows.
      yield* transaction.execute(sql`set local session_replication_role = 'replica'`, 'objects');
      yield* transaction.delete(taxOrderTaxFinalizations).where(eq(taxOrderTaxFinalizations.tenantId, tenantId));
      yield* transaction.delete(taxRuleCorrections).where(eq(taxRuleCorrections.tenantId, tenantId));
      yield* transaction.delete(taxRuleRevisionEndFacts).where(eq(taxRuleRevisionEndFacts.tenantId, tenantId));
      yield* transaction.delete(taxRuleRevisions).where(eq(taxRuleRevisions.tenantId, tenantId));
      yield* transaction.delete(taxRules).where(eq(taxRules.tenantId, tenantId));
      yield* transaction
        .delete(taxSellerVatRegimeDeclarations)
        .where(eq(taxSellerVatRegimeDeclarations.tenantId, tenantId));
    }),
  );

const acquireDatabases = Effect.gen(function* acquireOrderTaxTestDatabases() {
  const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
  const admin = yield* makeTestDatabaseFromClient(adminClient, taxRelations);
  // Owner services run as the least-privilege runtime role so forced RLS is part of every assertion.
  const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
  const identity: FixtureIdentity = { principalId: yield* nextUuid, tenantId: yield* nextUuid };
  yield* cleanup(admin, identity.tenantId);
  yield* Effect.addFinalizer(() => cleanup(admin, identity.tenantId).pipe(Effect.orDie));
  return { adminClient, identity, runtime };
});

type EffectivePeriodInput = Readonly<{ effectiveFrom: string; effectiveTo?: string }>;
const LAUNCH_PERIOD: EffectivePeriodInput = { effectiveFrom: '2026-01-01T00:00:00.000Z' };

const RuleIdSchema = Schema.String.pipe(Schema.brand('TaxTestRuleId'));
const RevisionIdSchema = Schema.String.pipe(Schema.brand('TaxTestRevisionId'));
const DecisionIdSchema = Schema.String.pipe(Schema.brand('TaxTestDecisionId'));
const CreatedRuleSchema = Schema.Struct({ initialRevisionId: RevisionIdSchema, taxRuleId: RuleIdSchema });

/** One seller with governed TAX state, set up through the same owner services the Actions use. */
const seller = Effect.fnUntraced(function* sellerFixture(runtime: CoreTestDatabase, identity: FixtureIdentity) {
  const legalEntityId = yield* nextUuid;
  const scope = yield* scopeFor(identity, legalEntityId);
  const setUp = Effect.gen(function* setUpSeller() {
    const declaration = yield* Schema.decodeEffect(DeclareSellerVatRegimePayloadSchema)({
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      expectedCurrentRevision: 0,
      reason: 'Merchant-declared Czech VAT payer',
      regime: 'VAT_PAYER',
    });
    const setUpInvocationId = yield* nextUuid;
    yield* runScoped(runtime, scope, (transaction) =>
      sellerVatRegimeDeclarationsForScope(transaction, scope).declare({
        ...declaration,
        ...invocation(scope, setUpInvocationId),
      }),
    );
  });
  const createRule = (
    stableCode: string,
    taxClassificationCode: string,
    ratePercent: string,
    period: EffectivePeriodInput = LAUNCH_PERIOD,
  ) =>
    Effect.all({
      invocationId: nextUuid,
      payload: Schema.decodeEffect(CreateTaxRulePayloadSchema)({
        initialRevision: {
          compositionKind: 'EXCLUSIVE',
          ...period,
          jurisdiction: 'CZ_DOMESTIC',
          ratePercent,
          taxClassificationCode,
          treatmentCategory: 'TAXABLE',
        },
        meaningKind: 'VAT_RATE',
        provenanceRef: `acceptance:${stableCode}`,
        reason: 'Czech VAT rate',
        stableCode,
      }),
    }).pipe(
      Effect.flatMap(({ invocationId, payload }) =>
        runScoped(runtime, scope, (transaction) =>
          taxRuleGovernancePersistenceForScope(transaction, scope).createTaxRule({
            ...payload,
            ...invocation(scope, invocationId),
          }),
        ),
      ),
      Effect.flatMap(Schema.decodeUnknownEffect(CreatedRuleSchema)),
    );
  const launchRules = Effect.all(
    [createRule('cz.standard', 'cz-standard-goods', '21'), createRule('cz.reduced', 'cz-reduced-food', '12')],
    { concurrency: 1 },
  );
  const payload = (
    submissionRef: string,
    overrides: Parameters<typeof evaluationRequestInput>[0] = {},
    orderCommitmentTime = T,
  ) => {
    const purchase =
      overrides.purchase ??
      purchaseBindingInput(['o1', 'o2'], {
        sellingLegalEntityRef: legalEntityId,
        tenantId: identity.tenantId,
      });
    const { taxRelevantTime: _taxRelevantTime, ...candidate } = evaluationRequestInput({
      eligibility: eligibilityHandoff(purchase, orderCommitmentTime),
      purchase,
      ...overrides,
    });
    return Schema.decodeSync(FinalizeOrderTaxPayloadSchema)({
      candidate,
      orderCommitmentTime,
      provenanceRef: 'acceptance:finalize',
      reason: 'Final Order Tax at Order Commitment Time',
      submissionRef,
    });
  };
  const finalize = (input: ReturnType<typeof payload>, actionInvocationId?: string) =>
    invocationIdOr(actionInvocationId).pipe(
      Effect.flatMap((invocationId) =>
        runScoped(runtime, scope, (transaction) =>
          orderTaxFinalizationsForScope(transaction, scope).finalize({
            ...input,
            ...invocation(scope, invocationId),
          }),
        ),
      ),
    );
  const finalOrderTax = (submissionRef: string, readScope: OperationalScope = scope) =>
    runScoped(runtime, readScope, (transaction) =>
      orderTaxFinalizationsForScope(transaction, readScope).finalOrderTax({
        submissionRef: OrderSubmissionRefSchema.make(submissionRef),
      }),
    );
  const declare = (
    overrides: Partial<typeof DeclareSellerVatRegimePayloadSchema.Encoded> = {},
    actionInvocationId?: string,
  ) =>
    Effect.all({
      decoded: Schema.decodeEffect(DeclareSellerVatRegimePayloadSchema)({
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        expectedCurrentRevision: 0,
        regime: 'VAT_PAYER',
        ...overrides,
      }),
      invocationId: invocationIdOr(actionInvocationId),
    }).pipe(
      Effect.flatMap(({ decoded, invocationId }) =>
        runScoped(runtime, scope, (transaction) =>
          sellerVatRegimeDeclarationsForScope(transaction, scope).declare({
            ...decoded,
            ...invocation(scope, invocationId),
          }),
        ),
      ),
    );
  const importDeclarations = (input: typeof ImportSellerVatRegimeDeclarationsPayloadSchema.Encoded) =>
    Effect.all({
      decoded: Schema.decodeEffect(ImportSellerVatRegimeDeclarationsPayloadSchema)(input),
      invocationId: nextUuid,
    }).pipe(
      Effect.flatMap(({ decoded, invocationId }) =>
        runScoped(runtime, scope, (transaction) =>
          sellerVatRegimeDeclarationsForScope(transaction, scope).importDeclarations({
            ...decoded,
            ...invocation(scope, invocationId),
          }),
        ),
      ),
    );
  return {
    createRule,
    declare,
    finalize,
    finalOrderTax,
    importDeclarations,
    launchRules,
    legalEntityId,
    payload,
    scope,
    setUp,
  };
});

type Seller = Effect.Success<ReturnType<typeof seller>>;

const finalizeAction = (
  runtime: CoreTestDatabase,
  subject: Seller,
  payload: ReturnType<Seller['payload']>,
  actionInvocationId?: string,
) =>
  invocationIdOr(actionInvocationId).pipe(
    Effect.flatMap((invocationId) =>
      runScoped(runtime, subject.scope, (transaction) =>
        handleFinalizeOrderTax(
          payload,
          actionContext(subject.scope, orderTaxFinalizationsForScope(transaction, subject.scope), [], invocationId),
        ),
      ),
    ),
    Effect.flatMap(Schema.encodeEffect(FinalizeOrderTaxResultSchema)),
    Effect.flatMap(Schema.decodeUnknownEffect(FinalizeOrderTaxResultSchema)),
  );

type FinalizeOutcome = Effect.Success<ReturnType<Seller['finalize']>>;

/** The typed result of an accepted request; a governance conflict or not-found fails the test. */
const resultOf = (outcome: FinalizeOutcome): FinalizeOrderTaxResult => {
  if ('kind' in outcome) {
    throw new Error(`Expected a finalization result, got ${outcome.kind}`);
  }
  return outcome.result;
};

const FinalizedSchema = Schema.TaggedStruct('FINALIZED', {
  created: Schema.Boolean,
  handoff: Schema.Struct({
    outcome: Schema.Struct({
      decision: Schema.Struct({
        decisionId: DecisionIdSchema,
        declarationRevisionRef: Schema.Struct({ revision: Schema.Finite }),
        sellerVatRegime: Schema.Literals(['VAT_PAYER', 'NON_PAYER']),
      }),
    }),
  }),
});
const finalizedOf = (outcome: FinalizeOutcome) => Schema.decodeUnknownSync(FinalizedSchema)(resultOf(outcome));
const RejectedSchema = Schema.TaggedStruct('FINALIZATION_REJECTED', { reasons: Schema.Array(Schema.String) });
const NotFinalizedSchema = Schema.TaggedStruct('NOT_FINALIZED', { outcome: TaxNonSuccessOutcomeSchema });
const DeclaredSchema = Schema.TaggedStruct('DECLARED', { created: Schema.Boolean, revision: Schema.Finite });
const declaredOf = (outcome: Effect.Success<ReturnType<Seller['declare']>>) => {
  if ('kind' in outcome) {
    throw new Error(`Expected a declaration result, got ${outcome.kind}`);
  }
  return Schema.decodeUnknownSync(DeclaredSchema)(outcome.result);
};

// These tests wait on the live clock, so each stays a live registration and builds Node Crypto in its scope.
// Tests that poll with `Effect.sleep` provide the built services directly so the sleep stays visibly live-owned.
const nodeCryptoServices = Layer.build(NodeCrypto.layer);
const nodeCrypto = nodeCryptoServices.pipe(Effect.map((context) => Context.get(context, Crypto.Crypto)));

it.live('#944 F8-F13 #941 F2-F9 a final Order Tax is fixed at T, stored once and recovered unchanged', () =>
  Effect.scoped(
    Effect.gen(function* finalizationAcceptance() {
      const { identity, runtime } = yield* acquireDatabases;
      const subject = yield* seller(runtime, identity);
      yield* subject.setUp;
      yield* subject.launchRules;

      const submission = `submission-${yield* nextUuid}`;
      const invocationId = yield* nextUuid;
      const first = finalizedOf(yield* subject.finalize(subject.payload(submission), invocationId));
      expect(first.created).toBe(true);
      // The stored final's Decision carries its own sellerVatRegime and declarationRevisionRef (#943/#950).
      expect(first.handoff.outcome.decision.sellerVatRegime).toBe('VAT_PAYER');
      expect(first.handoff.outcome.decision.declarationRevisionRef.revision).toBe(1);
      const created = resultOf(yield* subject.finalize(subject.payload(submission), invocationId));
      // Core-invocation replay of the same request echoes the original (#955 G).
      expect(finalizedOf(yield* subject.finalize(subject.payload(submission), invocationId)).created).toBe(false);
      // The same Core invocation carrying another submission is a reused key, never a second final (#955 G).
      expect(yield* subject.finalize(subject.payload(`submission-${yield* nextUuid}`), invocationId)).toEqual({
        conflict: 'IDEMPOTENCY_REUSED',
        kind: 'conflict',
      });

      // An ordinary rule change after finalization (here: an overlapping rule) never reopens the final (#942 H,
      // #944 F20): the recovery reads no rule state and returns the same Decision.
      yield* subject.createRule('cz.reduced-duplicate', 'cz-reduced-food', '12');
      const recovered = finalizedOf(yield* subject.finalize(subject.payload(submission)));
      expect(recovered.created).toBe(false);
      expect(recovered.handoff.outcome.decision.decisionId).toBe(first.handoff.outcome.decision.decisionId);

      // The same submission with a changed intent is a conflict, never a second result (#944 F11).
      const changed = yield* subject.finalize(
        subject.payload(submission, {
          purchase: purchaseBindingInput(['o1', 'o2'], {
            purchaseDemandOccurrences: [
              { ...occurrenceInput('o1'), quantity: { amount: '2', unitRef: 'piece' } },
              occurrenceInput('o2'),
            ],
            sellingLegalEntityRef: subject.legalEntityId,
            tenantId: identity.tenantId,
          }),
        }),
      );
      expect(changed).toEqual({ conflict: 'SUBMISSION_INTENT_CHANGED', kind: 'conflict' });

      // Lost response: the final is recoverable by submission identity alone (#944 F10).
      const read = Option.getOrThrow(yield* subject.finalOrderTax(submission));
      expect(read.handoff.outcome.decision.decisionId).toBe(first.handoff.outcome.decision.decisionId);
      expect(DateTime.formatIso(read.handoff.outcome.decision.taxRelevantTime)).toBe(T);
      expect(read.handoff.foreignEvidenceOrigin).toBe('CALLER_SUPPLIED_UNVERIFIED');
      expect(read.governingRevisionCorrections).toEqual([]);
      expect(resultOf(yield* subject.finalize(subject.payload(submission)))).toMatchObject({ created: false });
      expect(created).toMatchObject({ created: false });
    }),
  ).pipe(Effect.provideServiceEffect(Crypto.Crypto, nodeCrypto)),
);

it.live('PO decision D3 on #907: a final Order Tax with a GROSS Shipping allocation round-trips through recovery', () =>
  Effect.scoped(
    Effect.gen(function* shippingFinalizationAcceptance() {
      const { identity, runtime } = yield* acquireDatabases;
      const subject = yield* seller(runtime, identity);
      yield* subject.setUp;
      yield* subject.launchRules;

      const submission = `submission-${yield* nextUuid}`;
      const shippingPayload = subject.payload(submission, {
        pricing: {
          pricingResultRef: PRICING_RESULT_REF,
          publishedLines: [grossLine('o1', '121.00'), grossLine('o2', '112.00')],
        },
        purchase: purchaseBindingInput(['o1', 'o2'], {
          sellingLegalEntityRef: subject.legalEntityId,
          shippingSourceRef: { revision: 1, shippingAmountId: 'shipping-1' },
          tenantId: identity.tenantId,
        }),
        shipping: { affectedOccurrenceIds: ['o1', 'o2'], source: shippingCharge('99.00') },
      });

      const result = Match.value(resultOf(yield* subject.finalize(shippingPayload))).pipe(
        Match.tag('FINALIZED', (finalized) => finalized),
        Match.orElse((unexpected) => {
          throw new Error(`Expected a FINALIZED result, got ${unexpected._tag}`);
        }),
      );
      expect(result.handoff.outcome.result.purchaseTaxTotal.amount).toBe('47.02');
      // The exact gross-weighted shares and the code-versioned allocation key, not just the rounded published
      // amounts, round-trip through the jsonb Decision store (#907 plan §5.4).
      expect(
        result.handoff.outcome.decision.shippingAllocation?.unitAllocations.map(
          ({ basisComponent, taxableSupplyUnitId }) => [
            taxableSupplyUnitId,
            basisComponent.amount,
            basisComponent.amountBasis,
            basisComponent.allocationKey,
          ],
        ),
      ).toEqual([
        [
          'taxable-supply-unit:o1',
          { denominator: '233', numerator: '11979' },
          'GROSS',
          { key: 'GROSS_LINE_VALUE', revision: 1 },
        ],
        [
          'taxable-supply-unit:o2',
          { denominator: '233', numerator: '11088' },
          'GROSS',
          { key: 'GROSS_LINE_VALUE', revision: 1 },
        ],
      ]);

      // Lost response: same-submission recovery returns the Shipping allocation unchanged (#944 F10).
      const recovered = Option.getOrThrow(yield* subject.finalOrderTax(submission));
      expect(recovered.handoff.outcome.decision.decisionId).toBe(result.handoff.outcome.decision.decisionId);
      expect(recovered.handoff.outcome.decision.shippingAllocation).toEqual(
        result.handoff.outcome.decision.shippingAllocation,
      );
    }),
  ).pipe(Effect.provideServiceEffect(Crypto.Crypto, nodeCrypto)),
);

it.live('907-Q07 #933 #937 a final Order Tax with a NET Shipping allocation keeps its NET basis through recovery', () =>
  Effect.scoped(
    Effect.gen(function* netShippingFinalizationAcceptance() {
      const { identity, runtime } = yield* acquireDatabases;
      const subject = yield* seller(runtime, identity);
      yield* subject.setUp;
      yield* subject.launchRules;

      const submission = `submission-${yield* nextUuid}`;
      const result = Match.value(
        resultOf(
          yield* subject.finalize(
            subject.payload(submission, {
              pricing: {
                pricingResultRef: PRICING_RESULT_REF,
                publishedLines: [pricingLine('o1', '100.00'), pricingLine('o2', '100.00')],
              },
              purchase: purchaseBindingInput(['o1', 'o2'], {
                sellingLegalEntityRef: subject.legalEntityId,
                shippingSourceRef: { revision: 1, shippingAmountId: 'shipping-1' },
                tenantId: identity.tenantId,
              }),
              shipping: { affectedOccurrenceIds: ['o1', 'o2'], source: shippingCharge('99.00', 'NET') },
            }),
          ),
        ),
      ).pipe(
        Match.tag('FINALIZED', (finalized) => finalized),
        Match.orElse((unexpected) => {
          throw new Error(`Expected a FINALIZED result, got ${unexpected._tag}`);
        }),
      );
      // NET shares 99 * 121/233 and 99 * 112/233, taxed share * r: 31.80 + 17.71 = 49.51 (GROSS would give 47.02).
      expect(result.handoff.outcome.result.purchaseTaxTotal.amount).toBe('49.51');
      expect(
        result.handoff.outcome.decision.shippingAllocation?.unitAllocations.map(
          ({ basisComponent, taxableSupplyUnitId }) => [
            taxableSupplyUnitId,
            basisComponent.amount,
            basisComponent.amountBasis,
          ],
        ),
      ).toEqual([
        ['taxable-supply-unit:o1', { denominator: '233', numerator: '11979' }, 'NET'],
        ['taxable-supply-unit:o2', { denominator: '233', numerator: '11088' }, 'NET'],
      ]);

      // The jsonb Decision store round-trips the NET basis; same-submission recovery returns it unchanged.
      const recovered = Option.getOrThrow(yield* subject.finalOrderTax(submission));
      expect(recovered.handoff.outcome.decision.decisionId).toBe(result.handoff.outcome.decision.decisionId);
      expect(recovered.handoff.outcome.decision.shippingAllocation).toEqual(
        result.handoff.outcome.decision.shippingAllocation,
      );
      expect(recovered.handoff.outcome.result.purchaseTaxTotal.amount).toBe('49.51');
    }),
  ).pipe(Effect.provideServiceEffect(Crypto.Crypto, nodeCrypto)),
);

it.live('#944 F12 a non-success stores nothing; the same submission finalizes once rules exist', () =>
  Effect.scoped(
    Effect.gen(function* nonSuccessAcceptance() {
      const { identity, runtime } = yield* acquireDatabases;
      const subject = yield* seller(runtime, identity);
      yield* subject.setUp;
      const submission = `submission-${yield* nextUuid}`;

      const missing = yield* Schema.decodeUnknownEffect(NotFinalizedSchema)(
        resultOf(yield* subject.finalize(subject.payload(submission))),
      );
      expect(missing.outcome).toEqual(TaxRuleMissingSchema.make({}));
      expect(Option.isNone(yield* subject.finalOrderTax(submission))).toBe(true);

      yield* subject.launchRules;
      expect(finalizedOf(yield* subject.finalize(subject.payload(submission))).created).toBe(true);
    }),
  ).pipe(Effect.provideServiceEffect(Crypto.Crypto, nodeCrypto)),
);

/** A controlled crash after the final is inserted and before its owner transaction commits (#963 §3.3). */
class CrashBeforeCommit extends Data.TaggedError('CrashBeforeCommit')<{ readonly reason: string }> {}

it.live(
  '#963 §3.3 a crash after the final insert and before commit leaves no final; the exact retry finalizes once at T',
  () =>
    Effect.scoped(
      Effect.gen(function* crashBeforeDurableFinal() {
        const { adminClient, identity, runtime } = yield* acquireDatabases;
        const subject = yield* seller(runtime, identity);
        yield* subject.setUp;
        yield* subject.launchRules;
        const submission = `submission-${yield* nextUuid}`;
        const invocationId = yield* nextUuid;
        const payload = subject.payload(submission);
        // A raw read past RLS and the owner service: every stored final of the submission, and whether it is at T.
        const storedFinals = adminClient.unsafe<{ at_t: boolean }>(
          `select order_commitment_time = $3::timestamptz as at_t
         from tax.tax_order_tax_finalizations
         where tenant_id = $1 and submission_ref = $2`,
          [identity.tenantId, submission, T],
        );

        // The real finalization service succeeds inside the owner transaction, which then crashes before commit.
        const crash = yield* runScoped(runtime, subject.scope, (transaction) =>
          Effect.gen(function* finalizeThenCrash() {
            const finals = orderTaxFinalizationsForScope(transaction, subject.scope);
            const inserted = finalizedOf(
              yield* finals.finalize({ ...payload, ...invocation(subject.scope, invocationId) }),
            );
            expect(inserted.created).toBe(true);
            const visible = yield* finals.finalOrderTax({ submissionRef: OrderSubmissionRefSchema.make(submission) });
            expect(Option.isSome(visible)).toBe(true);
            return yield* new CrashBeforeCommit({ reason: 'controlled crash before commit' });
          }),
        ).pipe(Effect.flip);
        expect(crash).toBeInstanceOf(CrashBeforeCommit);

        // Nothing became durable: neither recovery nor a raw read finds a final.
        expect(Option.isNone(yield* subject.finalOrderTax(submission))).toBe(true);
        expect(yield* storedFinals).toEqual([]);

        // The exact retry (same submission, frozen payload, T and invocation identity) finalizes exactly once at T.
        const retried = finalizedOf(yield* subject.finalize(payload, invocationId));
        expect(retried.created).toBe(true);
        expect(yield* storedFinals).toEqual([{ at_t: true }]);
        const recovered = Option.getOrThrow(yield* subject.finalOrderTax(submission));
        expect(recovered.handoff.outcome.decision.decisionId).toBe(retried.handoff.outcome.decision.decisionId);
        expect(DateTime.formatIso(recovered.handoff.orderCommitmentTime)).toBe(T);
        expect(DateTime.formatIso(recovered.handoff.outcome.decision.taxRelevantTime)).toBe(T);
      }),
    ).pipe(Effect.provideServiceEffect(Crypto.Crypto, nodeCrypto)),
);

it.live('#930 F11 F13 the final read names a later correction of a governing revision without refreshing it', () =>
  Effect.scoped(
    Effect.gen(function* correctionAcceptance() {
      const { identity, runtime } = yield* acquireDatabases;
      const subject = yield* seller(runtime, identity);
      yield* subject.setUp;
      const [standard] = yield* subject.launchRules;
      const submission = `submission-${yield* nextUuid}`;
      const first = finalizedOf(yield* subject.finalize(subject.payload(submission)));

      const history = yield* runScoped(runtime, subject.scope, (transaction) =>
        taxGovernedReadsForScope(transaction, subject.scope).taxRuleHistory({
          taxRuleRef: {
            moduleId: 'commerce.tax',
            resourceId: standard.taxRuleId,
            resourceType: 'commerce.tax.tax-rule',
            tenantId: identity.tenantId,
          },
        }),
      ).pipe(Effect.map(Option.getOrThrow));
      const correction = yield* Schema.decodeEffect(CorrectTaxRuleRevisionPayloadSchema)({
        confirmedAt: '2026-01-15T00:00:00.000Z',
        correctingContent: {
          compositionKind: 'EXCLUSIVE',
          effectiveFrom: '2026-01-01T00:00:00.000Z',
          jurisdiction: 'CZ_DOMESTIC',
          ratePercent: '21',
          taxClassificationCode: 'cz-standard-goods',
          treatmentCategory: 'TAXABLE',
        },
        expectedBasisFingerprint: history.basisFingerprint,
        provenanceRef: 'acceptance:correction',
        reason: 'Confirmed wrong for its period',
        wrongRevisionRef: {
          moduleId: 'commerce.tax',
          resourceId: standard.initialRevisionId,
          resourceType: 'commerce.tax.tax-rule-revision',
          tenantId: identity.tenantId,
        },
      });
      const correctionInvocationId = yield* nextUuid;
      yield* runScoped(runtime, subject.scope, (transaction) =>
        taxRuleGovernancePersistenceForScope(transaction, subject.scope).correctTaxRuleRevision({
          ...correction,
          ...invocation(subject.scope, correctionInvocationId),
        }),
      );

      const read = Option.getOrThrow(yield* subject.finalOrderTax(submission));
      expect(read.handoff.outcome.decision.decisionId).toBe(first.handoff.outcome.decision.decisionId);
      expect(read.governingRevisionCorrections.map(({ wrongRevisionRef }) => wrongRevisionRef.resourceId)).toEqual([
        standard.initialRevisionId,
      ]);
    }),
  ).pipe(Effect.provideServiceEffect(Crypto.Crypto, nodeCrypto)),
);

it.live('#950 F24 #944 F11 finals are scoped, immutable and converge under concurrent requests', () =>
  Effect.scoped(
    Effect.gen(function* isolationAcceptance() {
      const { adminClient, identity, runtime } = yield* acquireDatabases;
      const subject = yield* seller(runtime, identity);
      yield* subject.setUp;
      yield* subject.launchRules;
      const submission = `submission-${yield* nextUuid}`;

      const [left, right] = yield* Effect.all(
        [subject.finalize(subject.payload(submission)), subject.finalize(subject.payload(submission))],
        { concurrency: 2 },
      );
      const ids = [finalizedOf(left), finalizedOf(right)].map(({ handoff }) => handoff.outcome.decision.decisionId);
      expect(new Set(ids).size).toBe(1);
      expect([finalizedOf(left).created, finalizedOf(right).created].filter(Boolean)).toEqual([true]);

      // Another seller of the same tenant, or the same seller id under another tenant, cannot see the final.
      expect(Option.isNone(yield* subject.finalOrderTax(submission, yield* scopeFor(identity, yield* nextUuid)))).toBe(
        true,
      );
      expect(
        Option.isNone(
          yield* subject.finalOrderTax(submission, yield* scopeFor(identity, subject.legalEntityId, yield* nextUuid)),
        ),
      ).toBe(true);
      // A candidate naming another seller is invisible, even under a submission that already has a final.
      const foreignCandidate = subject.payload(submission, {
        purchase: purchaseBindingInput(['o1', 'o2'], {
          sellingLegalEntityRef: yield* nextUuid,
          tenantId: identity.tenantId,
        }),
      });
      expect(yield* subject.finalize(foreignCandidate)).toEqual({ kind: 'not_found' });

      // A future T is rejected, never evaluated, and stores nothing (#941 F3, step-5 FUTURE_TAX_RELEVANT_TIME).
      const futureSubmission = `submission-${yield* nextUuid}`;
      const future = resultOf(
        yield* subject.finalize(subject.payload(futureSubmission, {}, '2099-01-01T00:00:00.000Z')),
      );
      expect((yield* Schema.decodeUnknownEffect(RejectedSchema)(future)).reasons).toEqual(['FUTURE_TAX_RELEVANT_TIME']);
      expect(Option.isNone(yield* subject.finalOrderTax(futureSubmission))).toBe(true);

      // The stored final is append-only: neither rewritten nor deleted.
      const rewrite = (statement: string) =>
        Effect.exit(adminClient.unsafe(statement, [identity.tenantId, submission])).pipe(Effect.map(Exit.isFailure));
      expect(
        yield* rewrite(
          `update tax.tax_order_tax_finalizations set reason = 'rewritten' where tenant_id = $1 and submission_ref = $2`,
        ),
      ).toBe(true);
      expect(
        yield* rewrite(`delete from tax.tax_order_tax_finalizations where tenant_id = $1 and submission_ref = $2`),
      ).toBe(true);
      expect(Option.isSome(yield* subject.finalOrderTax(submission))).toBe(true);
    }),
  ).pipe(Effect.provideServiceEffect(Crypto.Crypto, nodeCrypto)),
);

it.live('#941 F5 F10 the final selects rules at T, not at the later Tax Evaluation Time', () =>
  Effect.scoped(
    Effect.gen(function* boundaryAcceptance() {
      const { identity, runtime } = yield* acquireDatabases;
      const subject = yield* seller(runtime, identity);
      yield* subject.setUp;
      // A rate boundary after T and before E: [Jan, Aug) at 21 %, [Aug, ...) at 23 %.
      const BOUNDARY = '2026-08-01T00:00:00.000Z';
      const [beforeBoundary, fromBoundary] = yield* Effect.all(
        [
          subject.createRule('cz.standard', 'cz-standard-goods', '21', {
            effectiveFrom: '2026-01-01T00:00:00.000Z',
            effectiveTo: BOUNDARY,
          }),
          subject.createRule('cz.standard-august', 'cz-standard-goods', '23', { effectiveFrom: BOUNDARY }),
          subject.createRule('cz.reduced', 'cz-reduced-food', '12'),
        ],
        { concurrency: 1 },
      );
      const governingRulesAt = Effect.fn('governingRulesAt')(function* governingRulesAtEffect(at: string) {
        const submission = `submission-${yield* nextUuid}`;
        finalizedOf(yield* subject.finalize(subject.payload(submission, {}, at)));
        const { handoff } = Option.getOrThrow(yield* subject.finalOrderTax(submission));
        expect(DateTime.formatIso(handoff.outcome.decision.taxRelevantTime)).toBe(at);
        return handoff.outcome.decision.units
          .filter(
            (unit): unit is Extract<typeof unit, { governingTaxRuleRevisionRef: unknown }> =>
              'governingTaxRuleRevisionRef' in unit,
          )
          .map(({ governingTaxRuleRevisionRef }) => governingTaxRuleRevisionRef.taxRuleId);
      });

      expect(yield* governingRulesAt(T)).toContain(beforeBoundary.taxRuleId);
      expect(yield* governingRulesAt(T)).not.toContain(fromBoundary.taxRuleId);
      // Half-open period: T exactly at the boundary belongs to the later rule only.
      expect(yield* governingRulesAt(BOUNDARY)).toContain(fromBoundary.taxRuleId);
      expect(yield* governingRulesAt(BOUNDARY)).not.toContain(beforeBoundary.taxRuleId);
    }),
  ).pipe(Effect.provideServiceEffect(Crypto.Crypto, nodeCrypto)),
);

it.live('Unit 10 C a backdated regime revision recorded after a final leaves the recovered final unchanged', () =>
  Effect.scoped(
    Effect.gen(function* backdatedRecoveryAcceptance() {
      const { identity, runtime } = yield* acquireDatabases;
      const subject = yield* seller(runtime, identity);
      yield* subject.setUp;
      yield* subject.launchRules;

      const submission = `submission-${yield* nextUuid}`;
      const first = finalizedOf(yield* subject.finalize(subject.payload(submission)));
      expect(first.created).toBe(true);

      // A later NON_PAYER revision, backdated before T, is recorded after the final; the same-submission recovery
      // reads no seller state and the already-stored Decision is unchanged (Unit 10 C; #942 H, #944 F20).
      const declared = declaredOf(
        yield* subject.declare(
          {
            confirmReplacesScheduled: true,
            effectiveFrom: '2026-01-01T00:00:00.000Z',
            expectedCurrentRevision: 1,
            reason: 'Backdated non-payer declaration after finalization',
            regime: 'NON_PAYER',
          },
          yield* nextUuid,
        ),
      );
      expect(declared.created).toBe(true);

      const recovered = finalizedOf(yield* subject.finalize(subject.payload(submission)));
      expect(recovered.created).toBe(false);
      expect(recovered.handoff.outcome.decision.decisionId).toBe(first.handoff.outcome.decision.decisionId);
      expect(recovered.handoff.outcome.decision.sellerVatRegime).toBe('VAT_PAYER');
      expect(recovered.handoff.outcome.decision.declarationRevisionRef.revision).toBe(1);
    }),
  ).pipe(Effect.provideServiceEffect(Crypto.Crypto, nodeCrypto)),
);

it.live('TAX907 F2 a public NON_PAYER final needs no classification and durably recovers zero tax at T', () =>
  Effect.scoped(
    Effect.gen(function* nonPayerFinalizationAcceptance() {
      const { adminClient, identity, runtime } = yield* acquireDatabases;
      const subject = yield* seller(runtime, identity);
      // Non-payer from the start: no setUp() VAT_PAYER declaration, so no rules need to exist.
      yield* subject.declare({ reason: 'Non-payer seller from launch', regime: 'NON_PAYER' });

      const submission = `submission-${yield* nextUuid}`;
      const payload = subject.payload(submission, { catalog: [] });
      const invocationId = yield* nextUuid;
      const finalize = (actionInvocationId: string) =>
        finalizeAction(runtime, subject, payload, actionInvocationId).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(FinalizedSchema)),
        );
      const final = yield* finalize(invocationId);
      expect(final.created).toBe(true);
      expect(final.handoff.outcome.decision.sellerVatRegime).toBe('NON_PAYER');
      expect(final.handoff.outcome.decision.declarationRevisionRef.revision).toBe(1);

      const rows = yield* adminClient.unsafe(
        `select outcome -> 'result' -> 'purchaseTaxTotal' ->> 'amount' as purchase_tax_total_amount,
                governing_rule_revisions
         from tax.tax_order_tax_finalizations
         where tenant_id = $1 and submission_ref = $2`,
        [identity.tenantId, submission],
      );
      expect(rows).toEqual([{ governing_rule_revisions: [], purchase_tax_total_amount: '0.00' }]);
      const replay = yield* finalize(invocationId);
      const retry = yield* finalize(yield* nextUuid);
      expect(replay.created).toBe(false);
      expect(retry.created).toBe(false);
      expect(retry.handoff.outcome.decision.decisionId).toBe(final.handoff.outcome.decision.decisionId);
      const recovered = Option.getOrThrow(yield* subject.finalOrderTax(submission));
      expect(recovered.handoff.outcome.result.purchaseTaxTotal).toEqual({ amount: '0.00', currency: 'CZK' });
      expect(
        recovered.handoff.outcome.decision.units.every(({ treatment }) =>
          Schema.is(SellerNotVatPayerTreatmentSchema)(treatment),
        ),
      ).toBe(true);
      expect(DateTime.formatIso(recovered.handoff.orderCommitmentTime)).toBe(T);
      expect(DateTime.formatIso(recovered.handoff.outcome.decision.taxRelevantTime)).toBe(T);
      expect(recovered.evidence.ruleSets).toEqual([]);
    }),
  ).pipe(Effect.provideServiceEffect(Crypto.Crypto, nodeCrypto)),
);

it.live('907-Q09 #960 a final at T over imported MIGRATED source history succeeds and carries its revision ref', () =>
  Effect.scoped(
    Effect.gen(function* migratedFinalizationAcceptance() {
      const { adminClient, identity, runtime } = yield* acquireDatabases;
      const subject = yield* seller(runtime, identity);
      // Imported, never declared again by the merchant: non-payer first, payer covering T, a scheduled change after.
      yield* subject.importDeclarations({
        declarations: [
          { effectiveFrom: '2025-01-01T00:00:00.000Z', regime: 'NON_PAYER', sourceRecordRef: 'legacy:first' },
          { effectiveFrom: '2026-01-01T00:00:00.000Z', regime: 'VAT_PAYER', sourceRecordRef: 'legacy:payer' },
          { effectiveFrom: '2027-01-01T00:00:00.000Z', regime: 'NON_PAYER', sourceRecordRef: 'legacy:scheduled' },
        ],
        migrationRunRef: 'migration-run-1',
        migrationStartedAt: '2026-01-15T00:00:00.000Z',
      });
      yield* subject.launchRules;

      const submission = `submission-${yield* nextUuid}`;
      const final = finalizedOf(yield* subject.finalize(subject.payload(submission)));
      expect(final.created).toBe(true);
      expect(final.handoff.outcome.decision.sellerVatRegime).toBe('VAT_PAYER');
      expect(final.handoff.outcome.decision.declarationRevisionRef.revision).toBe(2);

      // The stored evidence names the selected imported revision; its provenance explains, it never gates.
      const rows = yield* adminClient.unsafe(
        `select evidence -> 'sellerVatRegime' -> 'selection' ->> 'provenance' as provenance,
                evidence -> 'sellerVatRegime' -> 'selection' ->> 'effectiveFromOrigin' as origin
         from tax.tax_order_tax_finalizations
         where tenant_id = $1 and submission_ref = $2`,
        [identity.tenantId, submission],
      );
      expect(rows).toEqual([{ origin: 'SOURCE', provenance: 'MIGRATED' }]);
    }),
  ).pipe(Effect.provideServiceEffect(Crypto.Crypto, nodeCrypto)),
);

it.live('Unit 10 C a seller with nothing declared cannot finalize', () =>
  Effect.scoped(
    Effect.gen(function* notDeclaredFinalizationAcceptance() {
      const { identity, runtime } = yield* acquireDatabases;
      const subject = yield* seller(runtime, identity);
      // Deliberately skip setUp(): no VAT regime has ever been declared for this seller.
      const submission = `submission-${yield* nextUuid}`;

      const notFinalized = yield* Schema.decodeUnknownEffect(NotFinalizedSchema)(
        resultOf(yield* subject.finalize(subject.payload(submission))),
      );
      expect(notFinalized.outcome).toEqual(TaxStateIndeterminateSchema.make({}));
      expect(Option.isNone(yield* subject.finalOrderTax(submission))).toBe(true);
    }),
  ).pipe(Effect.provideServiceEffect(Crypto.Crypto, nodeCrypto)),
);

it.live('Unit 10 C a declare concurrent with finalize serializes on the seller lock', () =>
  Effect.scoped(
    Effect.gen(function* concurrentDeclareAcceptanceLive() {
      const services = yield* nodeCryptoServices;
      yield* Effect.gen(function* concurrentDeclareAcceptance() {
        const { adminClient, identity, runtime } = yield* acquireDatabases;
        const subject = yield* seller(runtime, identity);
        yield* subject.setUp;
        yield* subject.launchRules;

        // Forced interleaving: the declare takes the seller lock exclusively and holds its transaction open on
        // `release` so the finalize is provably still blocked behind it (not merely racing and happening to win).
        const lockHeld = yield* Deferred.make<null>();
        const release = yield* Deferred.make<null>();
        const lockInvocationId = yield* nextUuid;
        const decoded = yield* Schema.decodeEffect(DeclareSellerVatRegimePayloadSchema)({
          confirmReplacesScheduled: true,
          effectiveFrom: '2026-01-01T00:00:00.000Z',
          expectedCurrentRevision: 1,
          reason: 'Declaration holding the seller lock during a finalize',
          regime: 'NON_PAYER',
        });
        const holdSellerLock = Deferred.succeed(lockHeld, null).pipe(Effect.andThen(Deferred.await(release)));
        const declareFiber = yield* runScoped(runtime, subject.scope, (transaction) =>
          sellerVatRegimeDeclarationsForScope(transaction, subject.scope)
            .declare({ ...decoded, ...invocation(subject.scope, lockInvocationId) })
            .pipe(Effect.tap(() => holdSellerLock)),
        ).pipe(Effect.forkChild);

        yield* Deferred.await(lockHeld);
        const submission = `submission-${yield* nextUuid}`;
        const finalizeFiber = yield* subject.finalize(subject.payload(submission)).pipe(Effect.forkChild);

        // The exclusive advisory xact lock `tax-scope:<tenantId>:<legalEntityId>:SELLER_VAT_REGIME_DECLARATION`
        // (tax-governance-persistence.ts `lockTaxScopeKey`) is held until the declare's transaction commits; finalize
        // takes it `'shared'` only on the evaluating path (order-tax-finalization.service.ts L281), so it must wait.
        const lockKey = `tax-scope:${identity.tenantId}:${subject.legalEntityId}:SELLER_VAT_REGIME_DECLARATION`;
        let waiterSeen = false;
        for (let observation = 0; observation < 50 && !waiterSeen; observation += 1) {
          const [row] = yield* adminClient.unsafe<{ waiting: number }>(
            `select count(*)::int as waiting from pg_locks
             where locktype = 'advisory' and not granted
               and ((classid::bigint << 32) | objid::bigint) = hashtextextended($1, 0)`,
            [lockKey],
          );
          waiterSeen = (row?.waiting ?? 0) >= 1;
          if (!waiterSeen) {
            yield* Effect.sleep('100 millis');
          }
        }
        // A non-granted waiter on that key means the finalize has not completed before the declare's commit: it is
        // genuinely blocked on the seller lock, not merely slower.
        expect(waiterSeen).toBe(true);

        yield* Deferred.succeed(release, null);
        const declareOutcome = yield* Fiber.join(declareFiber);
        const finalizeOutcome = yield* Fiber.join(finalizeFiber);

        // Forced order (Fable MINOR 1): the finalize waits for the declare's commit and then reads its revision,
        // never a mix and never the pre-declare state (#950 F24, Unit 10 C).
        const declared = declaredOf(declareOutcome);
        expect(declared.created).toBe(true);
        expect(declared.revision).toBe(2);
        const final = finalizedOf(finalizeOutcome);
        expect(final.handoff.outcome.decision.sellerVatRegime).toBe('NON_PAYER');
        expect(final.handoff.outcome.decision.declarationRevisionRef.revision).toBe(2);
      }).pipe(Effect.provide(services));
    }),
  ),
);

/** A Core-shaped Action handler context over real Postgres services; audit evidence is captured, no event is added. */

it.live('TAX907 F1 × F2 unsupported or missing material eligibility never stores an ordinary or zero-tax final', () =>
  Effect.scoped(
    Effect.gen(function* unsupportedFinalization() {
      const { adminClient, identity, runtime } = yield* acquireDatabases;
      for (const regime of ['VAT_PAYER', 'NON_PAYER'] as const) {
        const subject = yield* seller(runtime, identity);
        yield* subject.declare({ regime });
        if (regime === 'VAT_PAYER') {
          yield* subject.launchRules;
        }
        const purchase = purchaseBindingInput(['o1', 'o2'], {
          sellingLegalEntityRef: subject.legalEntityId,
          tenantId: identity.tenantId,
        });
        const submissions: string[] = [];
        for (const requiredRegime of ['REVERSE_CHARGE', 'OSS', 'EXPORT'] as const) {
          const submission = `submission-${yield* nextUuid}`;
          submissions.push(submission);
          const result = yield* finalizeAction(
            runtime,
            subject,
            subject.payload(submission, {
              catalog: regime === 'NON_PAYER' ? [] : (evaluationRequestInput().catalog ?? []),
              eligibility: { ...eligibilityHandoff(purchase, T), requiredTaxRegimes: [requiredRegime] },
            }),
          );
          const notFinalized = yield* Schema.decodeUnknownEffect(NotFinalizedSchema)(result);
          expect(notFinalized.outcome).toEqual(
            TaxCaseUnsupportedSchema.make({ unsupportedRequirement: requiredRegime }),
          );
        }
        const submission = `submission-${yield* nextUuid}`;
        submissions.push(submission);
        const currentPayload = subject.payload(submission, regime === 'NON_PAYER' ? { catalog: [] } : {});
        const { eligibility: _eligibility, ...legacyCandidate } = currentPayload.candidate;
        const missingPayload = yield* Schema.decodeEffect(FinalizeOrderTaxPayloadSchema)({
          ...currentPayload,
          candidate: legacyCandidate,
        });
        const missing = yield* Schema.decodeUnknownEffect(NotFinalizedSchema)(
          yield* finalizeAction(runtime, subject, missingPayload),
        );
        expect(missing.outcome).toEqual(TaxStateIndeterminateSchema.make({}));
        for (const rejectedSubmission of submissions) {
          expect(Option.isNone(yield* subject.finalOrderTax(rejectedSubmission))).toBe(true);
        }
        const rows = yield* adminClient.unsafe(
          `select submission_ref from tax.tax_order_tax_finalizations where tenant_id = $1 and legal_entity_id = $2`,
          [identity.tenantId, subject.legalEntityId],
        );
        expect(rows).toEqual([]);
      }
    }),
  ).pipe(Effect.provideServiceEffect(Crypto.Crypto, nodeCrypto)),
);

it.live('TAX907 F1 final eligibility is frozen, retry order is immaterial and changed material intent conflicts', () =>
  Effect.scoped(
    Effect.gen(function* frozenEligibilityFinalization() {
      const { adminClient, identity, runtime } = yield* acquireDatabases;
      const subject = yield* seller(runtime, identity);
      yield* subject.setUp;
      yield* subject.launchRules;
      const submission = `submission-${yield* nextUuid}`;
      const payload = subject.payload(submission);
      const [left, right] = yield* Effect.all(
        [finalizeAction(runtime, subject, payload), finalizeAction(runtime, subject, payload)],
        { concurrency: 2 },
      );
      const first = yield* Schema.decodeUnknownEffect(FinalizedSchema)(left);
      const second = yield* Schema.decodeUnknownEffect(FinalizedSchema)(right);
      expect(first.handoff.outcome.decision.decisionId).toBe(second.handoff.outcome.decision.decisionId);
      expect([first.created, second.created].filter(Boolean)).toEqual([true]);
      const rows = yield* adminClient.unsafe(
        `select order_commitment_time = $3::timestamptz as at_t, evidence -> 'eligibility' as eligibility
         from tax.tax_order_tax_finalizations where tenant_id = $1 and submission_ref = $2`,
        [identity.tenantId, submission, T],
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        at_t: true,
        eligibility: {
          foreignEvidenceOrigin: 'CALLER_SUPPLIED_UNVERIFIED',
          observation: {
            _tag: 'CURRENT',
            requiredTaxRegimes: ['ORDINARY_DOMESTIC'],
            taxRelevantTime: T,
          },
        },
      });
      const purchase = purchaseBindingInput(['o1', 'o2'], {
        sellingLegalEntityRef: subject.legalEntityId,
        tenantId: identity.tenantId,
      });
      const changed = subject.payload(submission, {
        eligibility: { ...eligibilityHandoff(purchase, T), requiredTaxRegimes: ['REVERSE_CHARGE'] },
      });
      const conflict = yield* finalizeAction(runtime, subject, changed).pipe(Effect.flip);
      expect(Schema.is(TaxGovernanceConflict)(conflict)).toBe(true);
      expect(conflict).toMatchObject({ conflict: 'SUBMISSION_INTENT_CHANGED' });
      yield* subject.createRule('cz.standard-overlap', 'cz-standard-goods', '21');
      const retry = yield* Schema.decodeUnknownEffect(FinalizedSchema)(
        yield* finalizeAction(runtime, subject, payload),
      );
      expect(retry.created).toBe(false);
      const reordered = subject.payload(submission, {
        eligibility: eligibilityHandoff(
          {
            ...purchase,
            purchaseDemandOccurrences: Arr.reverse(purchase.purchaseDemandOccurrences),
          },
          T,
        ),
      });
      const reorderedRetry = yield* Schema.decodeUnknownEffect(FinalizedSchema)(
        yield* finalizeAction(runtime, subject, reordered),
      );
      expect(reorderedRetry.created).toBe(false);
      const recovered = Option.getOrThrow(yield* subject.finalOrderTax(submission));
      expect(recovered.handoff.outcome.decision.decisionId).toBe(first.handoff.outcome.decision.decisionId);
      expect(DateTime.formatIso(recovered.handoff.orderCommitmentTime)).toBe(T);
      expect(recovered.evidence.eligibility).toBeDefined();
    }),
  ).pipe(Effect.provideServiceEffect(Crypto.Crypto, nodeCrypto)),
);

it.live('TAX907 F1 legacy persisted finals recover without invented eligibility or live recomputation', () =>
  Effect.scoped(
    Effect.gen(function* historicalFinalizationRecovery() {
      const { adminClient, identity, runtime } = yield* acquireDatabases;
      const subject = yield* seller(runtime, identity);
      yield* subject.setUp;
      yield* subject.launchRules;
      const submission = `submission-${yield* nextUuid}`;
      const currentPayload = subject.payload(submission);
      const { eligibility: _eligibility, ...legacyCandidate } = currentPayload.candidate;
      const legacyPayload = { ...currentPayload, candidate: legacyCandidate };
      const first = yield* Schema.decodeUnknownEffect(FinalizedSchema)(
        yield* finalizeAction(runtime, subject, currentPayload),
      );
      const oldFingerprint = orderTaxIntentFingerprint(
        legacyCandidate,
        currentPayload.orderCommitmentTime,
        taxMeaningFingerprint,
      );
      const admin = yield* makeTestDatabaseFromClient(adminClient, taxRelations);
      // Build the exact pre-F1 row shape in a test-owned fixture; normal writes remain append-only.
      yield* admin.transaction((transaction) =>
        Effect.gen(function* installHistoricalFinalFixture() {
          yield* transaction.execute(sql`set local session_replication_role = 'replica'`, 'objects');
          yield* transaction.execute(
            sql`
            update tax.tax_order_tax_finalizations
            set evidence = evidence - 'eligibility', intent_fingerprint = ${oldFingerprint}
            where tenant_id = ${identity.tenantId} and submission_ref = ${submission}
          `,
            'objects',
          );
        }),
      );

      // Both current rule and seller state would now produce another answer if recovery reevaluated.
      yield* subject.createRule('cz.standard-overlap', 'cz-standard-goods', '21');
      yield* subject.declare({
        confirmReplacesScheduled: true,
        expectedCurrentRevision: 1,
        regime: 'NON_PAYER',
      });
      const recovered = Option.getOrThrow(yield* subject.finalOrderTax(submission));
      const wire = yield* Schema.encodeEffect(FinalOrderTaxResponseSchema)(recovered);
      expect(wire.evidence).not.toHaveProperty('eligibility');
      expect(wire.handoff.outcome.decision.decisionId).toBe(first.handoff.outcome.decision.decisionId);
      expect(wire.handoff.outcome.decision.sellerVatRegime).toBe('VAT_PAYER');
      expect(wire.handoff.outcome.result.purchaseTaxTotal).toEqual({ amount: '270.00', currency: 'CZK' });
      expect(wire.handoff.orderCommitmentTime).toBe(T);
      expect(wire.handoff.foreignEvidenceOrigin).toBe('CALLER_SUPPLIED_UNVERIFIED');
      const retry = yield* finalizeAction(runtime, subject, legacyPayload);
      expect((yield* Schema.decodeUnknownEffect(FinalizedSchema)(retry)).created).toBe(false);
      expect(yield* Schema.encodeEffect(FinalizeOrderTaxResultSchema)(retry)).not.toHaveProperty(
        'evidence.eligibility',
      );
      const changed = yield* finalizeAction(runtime, subject, currentPayload).pipe(Effect.flip);
      expect(Schema.is(TaxGovernanceConflict)(changed)).toBe(true);
      expect(changed).toMatchObject({ conflict: 'SUBMISSION_INTENT_CHANGED' });
      // Historical recovery still obeys current tenant and seller scope enforced by real PostgreSQL RLS.
      expect(Option.isNone(yield* subject.finalOrderTax(submission, yield* scopeFor(identity, yield* nextUuid)))).toBe(
        true,
      );
      expect(
        Option.isNone(
          yield* subject.finalOrderTax(submission, yield* scopeFor(identity, subject.legalEntityId, yield* nextUuid)),
        ),
      ).toBe(true);
      const rows = yield* adminClient.unsafe(
        `select intent_fingerprint, evidence ? 'eligibility' as has_eligibility
         from tax.tax_order_tax_finalizations where tenant_id = $1 and submission_ref = $2`,
        [identity.tenantId, submission],
      );
      expect(rows).toEqual([{ has_eligibility: false, intent_fingerprint: oldFingerprint }]);
    }),
  ).pipe(Effect.provideServiceEffect(Crypto.Crypto, nodeCrypto)),
);

it.live('#961 scenario 9: the finalize Action and final read handlers persist, recover and hand off the final', () =>
  Effect.scoped(
    Effect.gen(function* publicFinalizeScenario() {
      const { identity, runtime } = yield* acquireDatabases;
      const subject = yield* seller(runtime, identity);
      yield* subject.setUp;
      yield* subject.launchRules;

      const submission = `submission-${yield* nextUuid}`;
      // The wire payload decodes through the public `FinalizeOrderTaxPayloadSchema` (inside `subject.payload`).
      const payload = subject.payload(submission);
      const audit: unknown[] = [];
      const invocationId = yield* nextUuid;
      const finalizeThroughHandler = (actionInvocationId: string) =>
        runScoped(runtime, subject.scope, (transaction) =>
          handleFinalizeOrderTax(
            payload,
            actionContext(
              subject.scope,
              orderTaxFinalizationsForScope(transaction, subject.scope),
              audit,
              actionInvocationId,
            ),
          ),
        ).pipe(
          Effect.flatMap((result) => Schema.encodeEffect(FinalizeOrderTaxResultSchema)(result)),
          Effect.flatMap(Schema.decodeUnknownEffect(FinalizedSchema)),
        );

      const first = yield* finalizeThroughHandler(invocationId);
      expect(first.created).toBe(true);
      // One audit record is captured for the created final (#950 F45-F47).
      expect(yield* Schema.decodeUnknownEffect(Schema.Array(TaxGovernanceAuditEvidenceSchema))(audit)).toHaveLength(1);

      // A retry of the same submission under a new Core invocation recovers the stored final (#944 F10).
      const retry = yield* finalizeThroughHandler(yield* nextUuid);
      expect(retry.created).toBe(false);
      expect(retry.handoff.outcome.decision.decisionId).toBe(first.handoff.outcome.decision.decisionId);

      // Lost-response recovery through the public read handler and its wire schemas.
      const request = yield* Schema.decodeEffect(FinalOrderTaxRequestSchema)({ submissionRef: submission });
      const recovered = yield* runScoped(runtime, subject.scope, (transaction) =>
        readFinalOrderTax(request, {
          readKey: 'commerce.tax.api.final-order-tax',
          scope: subject.scope,
          services: { finalizations: orderTaxFinalizationsForScope(transaction, subject.scope) },
        }),
      ).pipe(
        Effect.flatMap(({ result }) => Schema.encodeEffect(FinalOrderTaxResponseSchema)(result)),
        Effect.flatMap(Schema.decodeUnknownEffect(FinalOrderTaxResponseSchema)),
      );

      // The #330 Bundle content is exactly the public handoff: final at T, submission, unverified foreign evidence.
      const handoff = yield* Schema.encodeEffect(FinalOrderTaxHandoffSchema)(recovered.handoff).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(FinalOrderTaxHandoffSchema)),
      );
      expect(handoff.submissionRef).toBe(submission);
      expect(DateTime.formatIso(handoff.orderCommitmentTime)).toBe(T);
      expect(handoff.foreignEvidenceOrigin).toBe('CALLER_SUPPLIED_UNVERIFIED');
      expect(handoff.outcome.decision.decisionId).toBe(first.handoff.outcome.decision.decisionId);
      expect(handoff.outcome.result.purchaseTaxTotal).toEqual({ amount: '270.00', currency: 'CZK' });
    }),
  ).pipe(Effect.provideServiceEffect(Crypto.Crypto, nodeCrypto)),
);
