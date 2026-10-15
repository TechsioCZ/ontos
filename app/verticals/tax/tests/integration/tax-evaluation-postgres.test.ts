import { NodeCrypto } from '@effect/platform-node';
import type { PgClient } from '@effect/sql-pg';
import { ContextAccess, ReadRuntime, toContextPermissionAccessKey } from '@app/core-runtime';
import { makeGovernedReadHttpHandler } from '@app/core-runtime/http/governed-read';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { makeGovernedReadProblems } from '@app/shared-contracts/server/effect-bff-runtime';
import { RequestSchemaProblemLive } from '@app/shared-contracts/server/http-error-seam';
import { HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { eq, sql } from 'drizzle-orm';
import { Context, Crypto, DateTime, Effect, Layer, Match, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { FetchHttpClient } from 'effect/http';

import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import type { TestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import { coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
import type { ContextAccessService, OperationalScope, ScopedTransactionExecutor } from '@app/core-runtime';
import { CreateTaxRulePayloadSchema } from '../../shared/actions/tax-governance.ts';
import {
  DeclareSellerVatRegimePayloadSchema,
  ImportSellerVatRegimeDeclarationsPayloadSchema,
} from '../../shared/actions/seller-vat-regime-declaration.ts';
import {
  TaxEvaluationApi,
  TaxEvaluationAuthenticationProblemSchema,
  TaxEvaluationForbiddenProblemSchema,
  TaxEvaluationInternalProblemSchema,
  TaxEvaluationInvalidProblemSchema,
  TaxEvaluationNotFoundProblemSchema,
  TaxEvaluationPolicyConflictProblemSchema,
  TaxEvaluationPolicyProblemSchema,
  TaxEvaluationRequestSchema,
  TaxEvaluationResponseSchema,
  TaxEvaluationUnavailableProblemSchema,
} from '../../shared/apis/tax-evaluation.ts';
import type { TaxEvaluationResponse } from '../../shared/apis/tax-evaluation.ts';
import { executeTaxEvaluationWithAuthorization } from '../../src/api/tax-evaluation-client.ts';
import { readTaxEvaluation, taxEvaluationRead } from '../../src/api/tax-evaluation.read.ts';
import type { SellerVatRegimeAtInstantSelection } from '../../shared/domain/seller-vat-regime-contracts.ts';
import {
  taxRelations,
  taxRuleCorrections,
  taxRuleRevisionEndFacts,
  taxRuleRevisions,
  taxRules,
  taxSellerVatRegimeDeclarations,
} from '../../src/database/schema.ts';
import { LineCommercialValueBasisSchema } from '../../shared/domain/tax-kernel/taxable-basis.ts';
import { CustomerSafeSellerNotVatPayerSchema } from '../../src/domain/customer-safe-tax-projection.ts';
import { TaxableTreatmentSchema } from '../../src/domain/tax-treatment.ts';
import {
  TaxCaseUnsupportedSchema,
  TaxDependencyUnavailableSchema,
  TaxRuleMissingSchema,
  TaxRuleOverlapSchema,
  TaxStateIndeterminateSchema,
} from '../../src/domain/tax-non-success-outcome.ts';
import { TaxOutcomeSuccessSchema } from '../../src/domain/tax-outcome.ts';
import type { TaxOutcome } from '../../src/domain/tax-outcome.ts';
import { taxEvaluationForScope, taxEvaluationFromReads } from '../../src/services/tax-evaluation.service.ts';
import type { TaxEvaluationReads } from '../../src/services/tax-evaluation.service.ts';
import { taxGovernedReadsForScope } from '../../src/services/tax-governed-read.service.ts';
import { taxRuleGovernancePersistenceForScope } from '../../src/services/tax-rule-governance.service.ts';
import { sellerVatRegimeDeclarationsForScope } from '../../src/services/seller-vat-regime-declaration.service.ts';
import type { SellerVatRegimeDeclarations } from '../../src/services/seller-vat-regime-declaration.service.ts';
import {
  PRICING_RESULT_REF,
  STANDARD_CODE,
  catalogEntry,
  decodeEvaluationRequest,
  eligibilityHandoff,
  evaluationRequestInput,
  grossLine,
  pricingLine,
  shippingCharge,
} from '../unit/tax-evaluation-fixtures.ts';
import { occurrenceInput, purchaseBindingInput } from '../unit/tax-domain-fixtures.ts';

const nextUuid = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4);

interface FixtureIdentity {
  readonly principalId: string;
  readonly tenantId: string;
}

const scopeFor = (identity: FixtureIdentity, legalEntityId: string) =>
  Effect.gen(function* makeTaxEvaluationScope() {
    const [authBindingId, authContextId, correlationId] = yield* Effect.all([nextUuid, nextUuid, nextUuid]);
    const scope: OperationalScope = {
      authBindingId,
      authContextRef: `better-auth-session:${authContextId}`,
      authMethod: 'session',
      correlationId,
      legalEntityId,
      principalId: identity.principalId,
      tenantId: identity.tenantId,
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

/** Fixed trusted operation time for governed setup; evaluation itself uses the real server clock. */
const operationTime = DateTime.toDateUtc(DateTime.makeUnsafe('2026-02-01T00:00:00.000Z'));
const invocation = (scope: OperationalScope, at = operationTime) =>
  nextUuid.pipe(
    Effect.map((actionInvocationId) => ({
      actionInvocationId,
      actorPrincipalId: scope.principalId,
      legalEntityId: scope.legalEntityId ?? '',
      operationTime: at,
      tenantId: scope.tenantId,
    })),
  );

const cleanup = (admin: TestDatabaseFromClient<typeof taxRelations>, tenantId: string) =>
  admin.transaction((transaction) =>
    Effect.gen(function* cleanupTaxEvaluationRows() {
      // Append-only triggers reject deletes; replica mode is the test-only escape for owned fixture rows.
      yield* transaction.execute(sql`set local session_replication_role = 'replica'`, 'objects');
      yield* transaction.delete(taxRuleCorrections).where(eq(taxRuleCorrections.tenantId, tenantId));
      yield* transaction.delete(taxRuleRevisionEndFacts).where(eq(taxRuleRevisionEndFacts.tenantId, tenantId));
      yield* transaction.delete(taxRuleRevisions).where(eq(taxRuleRevisions.tenantId, tenantId));
      yield* transaction.delete(taxRules).where(eq(taxRules.tenantId, tenantId));
      yield* transaction
        .delete(taxSellerVatRegimeDeclarations)
        .where(eq(taxSellerVatRegimeDeclarations.tenantId, tenantId));
    }),
  );

const acquireDatabases = Effect.gen(function* acquireTaxEvaluationTestDatabases() {
  const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
  const admin = yield* makeTestDatabaseFromClient(adminClient, taxRelations);
  // Owner services run as the least-privilege runtime role so forced RLS is part of every assertion.
  const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
  const [tenantId, principalId] = yield* Effect.all([nextUuid, nextUuid]);
  yield* cleanup(admin, tenantId);
  yield* Effect.addFinalizer(() => cleanup(admin, tenantId).pipe(Effect.orDie));
  return { admin, identity: { principalId, tenantId }, runtime, runtimeClient };
});

const evaluationProblems = makeGovernedReadProblems({
  authentication: TaxEvaluationAuthenticationProblemSchema,
  forbidden: TaxEvaluationForbiddenProblemSchema,
  internal: TaxEvaluationInternalProblemSchema,
  invalid: TaxEvaluationInvalidProblemSchema,
  notFound: TaxEvaluationNotFoundProblemSchema,
  policyConflict: TaxEvaluationPolicyConflictProblemSchema,
  policyIneligible: TaxEvaluationPolicyProblemSchema,
  unavailable: TaxEvaluationUnavailableProblemSchema,
});

const positionalRow = (row: readonly unknown[]) => Object.fromEntries(row.map((value, index) => [index, value]));

/**
 * Existing HTTP test seam: controlled authentication and Core admission/evidence SQL, actual Read Runtime and
 * original TAX registration. Owner SQL reaches native PostgreSQL as the runtime role with forced RLS and the
 * harness's validated scope. This proves serialization and persisted TAX state, not deployment authentication.
 */
const evaluationHttp = Effect.fn('TaxEvaluationTest.evaluationHttp')(function* evaluationHttp(
  runtimeClient: PgClient.PgClient,
  scope: OperationalScope,
) {
  const harness = yield* makeReadTestHarness({
    executeOwnerQuery: (query) =>
      runtimeClient.withTransaction(
        runtimeClient
          .unsafe("select set_config('ontos.tenant_id', $1, true), set_config('ontos.legal_entity_id', $2, true)", [
            query.scope.tenantId,
            query.scope.legalEntityId,
          ])
          .pipe(
            Effect.andThen(runtimeClient.unsafe(query.sql, [...query.params]).values),
            // Drizzle selects repeated column names in joins. Preserve every positional value for its mapper.
            Effect.map((rows) => rows.map(positionalRow)),
          ),
      ),
    operationTime,
    ownerAuthorizationDecision: 'allowed',
    permissionDecision: 'allowed',
    scope,
  });
  const builtContext = yield* Layer.build(harness.layer);
  Object.assign(Context.get(builtContext, ContextAccess), {
    contextPermissions: ({ targets }: Parameters<NonNullable<ContextAccessService['contextPermissions']>>[0]) =>
      Effect.succeed(
        targets.map((target) => ({ decision: 'allowed' as const, key: toContextPermissionAccessKey(target) })),
      ),
  });
  const handlers = HttpApiBuilder.group(TaxEvaluationApi, 'taxEvaluation', (routes) =>
    routes.handle(
      'execute',
      makeGovernedReadHttpHandler({
        authenticatePrincipal: () => Effect.succeed(scope),
        problems: evaluationProblems,
        registration: taxEvaluationRead,
      }),
    ),
  );
  const server = yield* Effect.acquireRelease(
    Effect.sync(() =>
      HttpRouter.toWebHandler(
        HttpApiBuilder.layer(TaxEvaluationApi).pipe(
          Layer.provide(handlers),
          Layer.provideMerge(RequestSchemaProblemLive),
          Layer.provide(Layer.succeed(ReadRuntime, harness.runtime)),
          Layer.provide(HttpServer.layerServices),
        ),
        { disableLogger: true },
      ),
    ),
    (ownedServer) => Effect.promise(() => ownedServer.dispose()).pipe(Effect.orDie),
  );
  const requestContext = Context.make(ReadRuntime, harness.runtime);
  const wireRequests: unknown[] = [];
  const statuses: number[] = [];
  const routerFetch: typeof fetch = (url, init) => {
    const request = new Request(url, init);
    return request
      .clone()
      .json()
      .then((payload) => {
        wireRequests.push(payload);
        return server.handler(request, requestContext);
      })
      .then((response) => {
        statuses.push(response.status);
        return response;
      });
  };
  const run = (wire: typeof TaxEvaluationRequestSchema.Encoded) =>
    Schema.decodeEffect(TaxEvaluationRequestSchema)(wire).pipe(
      Effect.flatMap((payload) =>
        executeTaxEvaluationWithAuthorization(payload, 'Bearer controlled', scope.correlationId, {
          baseUrl: 'https://tax.example',
        }),
      ),
      Effect.provideService(FetchHttpClient.Fetch, routerFetch),
    );
  const raw = (jsonText: string) =>
    Effect.promise(() =>
      server.handler(
        new Request('https://tax.example/reads/tax-evaluation', {
          body: jsonText,
          headers: { 'content-type': 'application/json' },
          method: 'POST',
        }),
        requestContext,
      ),
    );
  return { raw, run, snapshot: harness.snapshot, statuses, wireRequests };
});

type AdminTestDatabase = TestDatabaseFromClient<typeof taxRelations>;

/** Commits the next VAT_PAYER revision (effective before T) from a separate admin transaction on every run. */
const concurrentRevisionWriter = (admin: AdminTestDatabase, scope: OperationalScope, crypto: Crypto.Crypto) => {
  const state = { head: 1 };
  return Effect.suspend(() => {
    state.head += 1;
    return Effect.all([crypto.randomUUIDv4, crypto.randomUUIDv4]);
  }).pipe(
    Effect.flatMap(([actionInvocationId, idempotencyKey]) =>
      admin.insert(taxSellerVatRegimeDeclarations).values({
        actionInvocationId,
        actorPrincipalId: scope.principalId,
        effectiveFrom: DateTime.toDateUtc(DateTime.makeUnsafe('2026-03-01T00:00:00.000Z')),
        idempotencyKey,
        intentFingerprint: '0'.repeat(64),
        legalEntityId: scope.legalEntityId ?? '',
        provenance: 'MERCHANT_DECLARED',
        reason: 'Concurrent declaration committed between two observations of one evaluation (Unit 10 C)',
        recordedAt: operationTime,
        regime: 'VAT_PAYER',
        replacesScheduled: false,
        revision: state.head,
        tenantId: scope.tenantId,
      }),
    ),
    Effect.orDie,
  );
};

/** The real declaration reads, except that the numbered `atInstant` observations first run the concurrent writer. */
const racingDeclarations = (
  declarations: SellerVatRegimeDeclarations,
  racedObservations: ReadonlySet<number>,
  concurrentWriter: Effect.Effect<unknown>,
): TaxEvaluationReads['declarations'] => {
  const state = { observation: 0 };
  return {
    atInstant: (request) =>
      Effect.suspend(() => {
        state.observation += 1;
        return racedObservations.has(state.observation)
          ? concurrentWriter.pipe(Effect.andThen(declarations.atInstant(request)))
          : declarations.atInstant(request);
      }),
  };
};

/** Governed TAX setup of one seller, through the same owner services the Actions use. */
const seller = Effect.fnUntraced(function* makeSeller(runtime: CoreTestDatabase, identity: FixtureIdentity) {
  const crypto = yield* Crypto.Crypto;
  const legalEntityId = yield* nextUuid;
  const scope = yield* scopeFor(identity, legalEntityId);
  const { tenantId } = identity;
  const declare = Effect.fnUntraced(function* declareAction(
    overrides: Partial<typeof DeclareSellerVatRegimePayloadSchema.Encoded> = {},
  ) {
    const payload = yield* Schema.decodeEffect(DeclareSellerVatRegimePayloadSchema)({
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      expectedCurrentRevision: 0,
      reason: 'Merchant-declared backdated effect for acceptance fixtures',
      regime: 'VAT_PAYER',
      ...overrides,
    });
    const actionInvocation = yield* invocation(scope);
    return yield* runScoped(runtime, scope, (transaction) =>
      sellerVatRegimeDeclarationsForScope(transaction, scope).declare({
        ...payload,
        ...actionInvocation,
      }),
    );
  });
  const importDeclarations = Effect.fnUntraced(function* importDeclarationsAction(
    input: typeof ImportSellerVatRegimeDeclarationsPayloadSchema.Encoded,
  ) {
    const decoded = yield* Schema.decodeEffect(ImportSellerVatRegimeDeclarationsPayloadSchema)(input);
    const actionInvocation = yield* invocation(scope);
    return yield* runScoped(runtime, scope, (transaction) =>
      sellerVatRegimeDeclarationsForScope(transaction, scope).importDeclarations({
        ...decoded,
        ...actionInvocation,
      }),
    );
  });
  const declareVatPayer = () => declare({ regime: 'VAT_PAYER' });
  const declareNonPayer = () => declare({ reason: 'Merchant-declared non-payer', regime: 'NON_PAYER' });
  const createRule = Effect.fnUntraced(function* createRuleAction(
    stableCode: string,
    taxClassificationCode: string,
    ratePercent: string,
  ) {
    const payload = yield* Schema.decodeEffect(CreateTaxRulePayloadSchema)({
      initialRevision: {
        compositionKind: 'EXCLUSIVE',
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        jurisdiction: 'CZ_DOMESTIC',
        ratePercent,
        taxClassificationCode,
        treatmentCategory: 'TAXABLE',
      },
      meaningKind: 'VAT_RATE',
      provenanceRef: `acceptance:${stableCode}`,
      reason: 'Czech VAT rate',
      stableCode,
    });
    const actionInvocation = yield* invocation(scope);
    return yield* runScoped(runtime, scope, (transaction) =>
      taxRuleGovernancePersistenceForScope(transaction, scope).createTaxRule({ ...payload, ...actionInvocation }),
    );
  });
  const evaluate = (overrides: Parameters<typeof evaluationRequestInput>[0] = {}) =>
    runScoped(runtime, scope, (transaction) =>
      taxEvaluationForScope(transaction, scope).evaluate(
        decodeEvaluationRequest(
          evaluationRequestInput({
            purchase: purchaseBindingInput(['o1', 'o2'], { sellingLegalEntityRef: legalEntityId, tenantId }),
            taxRelevantTime: '2026-06-01T00:00:00.000Z',
            ...overrides,
          }),
        ),
      ),
    );
  /**
   * #961 F1 H1: the public read handler over persisted TAX state. The wire request decodes through the public
   * `TaxEvaluationRequestSchema`, and the response round-trips through the public `TaxEvaluationResponseSchema`.
   */
  const readPublic = (overrides: Parameters<typeof evaluationRequestInput>[0] = {}) =>
    Schema.decodeEffect(TaxEvaluationRequestSchema)(
      evaluationRequestInput({
        purchase: purchaseBindingInput(['o1', 'o2'], { sellingLegalEntityRef: legalEntityId, tenantId }),
        taxRelevantTime: '2026-06-01T00:00:00.000Z',
        ...overrides,
      }),
    ).pipe(
      Effect.flatMap((request) =>
        runScoped(runtime, scope, (transaction) =>
          readTaxEvaluation(request, {
            readKey: 'commerce.tax.api.tax-evaluation',
            scope,
            services: { evaluations: taxEvaluationForScope(transaction, scope) },
          }),
        ),
      ),
      Effect.flatMap(({ result }) => Schema.encodeEffect(TaxEvaluationResponseSchema)(result)),
      Effect.flatMap(Schema.decodeUnknownEffect(TaxEvaluationResponseSchema)),
      Effect.asSome,
    );
  /**
   * The production evaluation whose declaration observations race a concurrent writer: before each numbered
   * `atInstant` observation in `racedObservations`, a separate admin transaction commits the next VAT_PAYER revision
   * effective before T, so the evaluation's next read (READ COMMITTED) sees a new declaration head (Unit 10 C).
   */
  const evaluateRacing = (admin: AdminTestDatabase, racedObservations: ReadonlySet<number>) =>
    runScoped(runtime, scope, (transaction) =>
      taxEvaluationFromReads(
        {
          declarations: racingDeclarations(
            sellerVatRegimeDeclarationsForScope(transaction, scope),
            racedObservations,
            concurrentRevisionWriter(admin, scope, crypto),
          ),
          governed: taxGovernedReadsForScope(transaction, scope),
        },
        scope,
      ).evaluate(
        decodeEvaluationRequest(
          evaluationRequestInput({
            purchase: purchaseBindingInput(['o1', 'o2'], { sellingLegalEntityRef: legalEntityId, tenantId }),
            taxRelevantTime: '2026-06-01T00:00:00.000Z',
          }),
        ),
      ),
    );
  const launchRules = Effect.all([
    createRule('cz.standard', 'cz-standard-goods', '21'),
    createRule('cz.reduced', 'cz-reduced-food', '12'),
  ]);
  return {
    createRule,
    declare,
    declareNonPayer,
    declareVatPayer,
    evaluate,
    evaluateRacing,
    importDeclarations,
    launchRules,
    legalEntityId,
    readPublic,
    scope,
  };
});

const EvaluatedSchema = Schema.TaggedStruct('EVALUATED', {});
const isEvaluated = Schema.is(EvaluatedSchema);
const isRejected = Schema.is(
  Schema.TaggedStruct('TAX_EVALUATION_REQUEST_REJECTED', { reasons: Schema.Array(Schema.String) }),
);
const isSuccess = Schema.is(TaxOutcomeSuccessSchema);

const evaluatedOf = (response: Option.Option<TaxEvaluationResponse>) => {
  const value = Option.getOrThrow(response);
  if (!isEvaluated(value)) {
    throw new Error('Expected an evaluated response');
  }
  return value;
};
const outcomeOf = (response: Option.Option<TaxEvaluationResponse>): TaxOutcome => evaluatedOf(response).outcome;
/** The declared regime of one evidence selection; throws on `NOT_DECLARED`, which every caller here excludes. */
const declaredRegimeOf = (selection: SellerVatRegimeAtInstantSelection) =>
  Match.value(selection).pipe(
    Match.tag('DECLARED', ({ regime }) => regime),
    Match.tag('NOT_DECLARED', () => {
      throw new Error('Expected a DECLARED Seller VAT Regime selection');
    }),
    Match.exhaustive,
  );

const decisionIdOf = (response: Option.Option<TaxEvaluationResponse>) => {
  const outcome = outcomeOf(response);
  if (!isSuccess(outcome)) {
    throw new Error('Expected a successful Tax Outcome');
  }
  return outcome.decision.decisionId;
};

const evaluationWireFor = (scope: OperationalScope) =>
  evaluationRequestInput({
    purchase: purchaseBindingInput(['o1', 'o2'], {
      sellingLegalEntityRef: scope.legalEntityId ?? '',
      tenantId: scope.tenantId,
    }),
    taxRelevantTime: '2026-06-01T00:00:00.000Z',
  });

/** The declaration revision one evidence selection names; throws on `NOT_DECLARED`, which every caller excludes. */
const selectedRevisionOf = (selection: SellerVatRegimeAtInstantSelection) =>
  Match.value(selection).pipe(
    Match.tag('DECLARED', ({ declarationRevisionRef }) => declarationRevisionRef.revision),
    Match.tag('NOT_DECLARED', () => {
      throw new Error('Expected a DECLARED Seller VAT Regime selection');
    }),
    Match.exhaustive,
  );

const CreatedRuleIdSchema = Schema.Struct({ taxRuleId: Schema.String.pipe(Schema.brand('TaxTestRuleId')) });
const successOf = (response: Option.Option<TaxEvaluationResponse>) => {
  const outcome = outcomeOf(response);
  if (!isSuccess(outcome)) {
    throw new Error('Expected a successful Tax Outcome');
  }
  return outcome;
};
const publishedByUnit = (response: Option.Option<TaxEvaluationResponse>) =>
  successOf(response).result.units.map(({ publishedTaxAmount, taxableSupplyUnitId }) => [
    taxableSupplyUnitId,
    publishedTaxAmount.amount,
  ]);
const centsOf = (amount: string) => BigInt(amount.replace('.', ''));

// Each test stays a live registration against real PostgreSQL and builds Node Crypto in its scope.
const nodeCrypto = Layer.build(NodeCrypto.layer).pipe(Effect.map((context) => Context.get(context, Crypto.Crypto)));

it.live('#907 F1 ordinary eligibility survives generated HTTP serialization and persisted TAX evaluation', () =>
  Effect.scoped(
    Effect.gen(function* ordinaryEligibilityHttp() {
      const { identity, runtime, runtimeClient } = yield* acquireDatabases;
      const subject = yield* seller(runtime, identity);
      yield* subject.declareVatPayer();
      yield* subject.launchRules;
      const http = yield* evaluationHttp(runtimeClient, subject.scope);
      const wire = evaluationWireFor(subject.scope);

      const response = yield* http.run(wire);
      expect(http.statuses).toEqual([200]);
      expect(http.wireRequests).toEqual([wire]);
      const evaluated = evaluatedOf(Option.some(response));
      expect(evaluated.evidence.foreignEvidenceOrigin).toBe('CALLER_SUPPLIED_UNVERIFIED');
      expect(isSuccess(evaluated.outcome)).toBe(true);
      expect(evaluated.outcome).toMatchObject({
        result: { purchaseTaxTotal: { amount: '270.00', currency: 'CZK' } },
      });
      expect(http.snapshot().evidenceWrites).toBe(1);
      expect(http.snapshot().ownerQueries.length).toBeGreaterThan(0);
    }),
  ).pipe(Effect.provideServiceEffect(Crypto.Crypto, nodeCrypto)),
);

it.live('#907 F2 HTTP omits rate classification for a persisted NON_PAYER without reading TAX rules', () =>
  Effect.scoped(
    Effect.gen(function* nonPayerHttp() {
      const { identity, runtime, runtimeClient } = yield* acquireDatabases;
      const subject = yield* seller(runtime, identity);
      yield* subject.declareNonPayer();
      const http = yield* evaluationHttp(runtimeClient, subject.scope);
      const wire = evaluationWireFor(subject.scope);
      Reflect.deleteProperty(wire, 'catalog');

      const response = yield* http.run(wire);
      expect(http.statuses).toEqual([200]);
      expect(http.wireRequests).toEqual([wire]);
      const evaluated = evaluatedOf(Option.some(response));
      expect(evaluated.evidence.foreignEvidenceOrigin).toBe('CALLER_SUPPLIED_UNVERIFIED');
      expect(evaluated.evidence.ruleSets).toEqual([]);
      expect(declaredRegimeOf(evaluated.evidence.sellerVatRegime.selection)).toBe('NON_PAYER');
      expect(isSuccess(evaluated.outcome)).toBe(true);
      expect(evaluated.outcome).toMatchObject({ result: { purchaseTaxTotal: { amount: '0.00', currency: 'CZK' } } });
      expect(Schema.is(CustomerSafeSellerNotVatPayerSchema)(evaluated.customerSafe)).toBe(true);
      const { outcome } = evaluated;
      if (isSuccess(outcome)) {
        expect(outcome.decision.units.map(({ treatment }) => treatment)).toEqual([
          { _tag: 'SELLER_NOT_VAT_PAYER' },
          { _tag: 'SELLER_NOT_VAT_PAYER' },
        ]);
      }
      expect(http.snapshot().evidenceWrites).toBe(1);
      expect(http.snapshot().ownerQueries.every(({ sql: queryText }) => !queryText.includes('tax_rule'))).toBe(true);
    }),
  ).pipe(Effect.provideServiceEffect(Crypto.Crypto, nodeCrypto)),
);

it.live('#907 F1 HTTP preserves unsupported and missing eligibility for both persisted seller regimes', () =>
  Effect.scoped(
    Effect.gen(function* eligibilityFailuresHttp() {
      const { identity, runtime, runtimeClient } = yield* acquireDatabases;
      for (const sellerRegime of ['VAT_PAYER', 'NON_PAYER'] as const) {
        const subject = yield* seller(runtime, identity);
        yield* subject.declare({ regime: sellerRegime });
        const http = yield* evaluationHttp(runtimeClient, subject.scope);
        const wire = evaluationWireFor(subject.scope);
        Reflect.deleteProperty(wire, 'catalog');
        const eligibility = eligibilityHandoff(wire.purchase, wire.taxRelevantTime);
        const unsupported = yield* http.run({
          ...wire,
          eligibility: { ...eligibility, requiredTaxRegimes: ['REVERSE_CHARGE'] },
        });
        const unsupportedEvaluated = evaluatedOf(Option.some(unsupported));
        expect(Schema.is(TaxCaseUnsupportedSchema)(unsupportedEvaluated.outcome)).toBe(true);
        expect(unsupportedEvaluated.outcome).toMatchObject({ unsupportedRequirement: 'REVERSE_CHARGE' });
        Reflect.deleteProperty(wire, 'eligibility');
        const missing = yield* http.run(wire);
        expect(Schema.is(TaxStateIndeterminateSchema)(evaluatedOf(Option.some(missing)).outcome)).toBe(true);
        expect(http.statuses).toEqual([200, 200]);
        expect(http.snapshot().evidenceWrites).toBe(2);
      }
    }),
  ).pipe(Effect.provideServiceEffect(Crypto.Crypto, nodeCrypto)),
);

it.live('#907 F1 malformed eligibility is an HTTP 400 before Core or TAX reads execute', () =>
  Effect.scoped(
    Effect.gen(function* malformedEligibilityHttp() {
      const { identity, runtime, runtimeClient } = yield* acquireDatabases;
      const subject = yield* seller(runtime, identity);
      const http = yield* evaluationHttp(runtimeClient, subject.scope);
      const wire = evaluationWireFor(subject.scope);
      const jsonText = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))({
        ...wire,
        eligibility: { ...wire.eligibility, taxRelevantTime: Date.parse('2026-06-01T00:00:00.000Z') },
      });
      const response = yield* http.raw(jsonText);
      expect(response.status).toBe(400);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
      expect(http.snapshot().ownerQueries).toEqual([]);
      expect(http.snapshot().evidenceWrites).toBe(0);
    }),
  ).pipe(Effect.provideServiceEffect(Crypto.Crypto, nodeCrypto)),
);

it.live('#942 #936 #941 a VAT_PAYER seller publishes one rated Decision and Result from complete rule state', () =>
  Effect.scoped(
    Effect.gen(function* prospectiveEvaluationAcceptance() {
      const { identity, runtime } = yield* acquireDatabases;
      const subject = yield* seller(runtime, identity);
      yield* subject.declareVatPayer();
      yield* subject.launchRules;

      const response = yield* subject.evaluate();
      const evaluated = evaluatedOf(response);
      const { outcome } = evaluated;

      expect(isSuccess(outcome) && outcome.result.purchaseTaxTotal).toEqual({ amount: '270.00', currency: 'CZK' });
      expect(evaluated.customerSafe).toMatchObject({ purchaseTaxTotal: { amount: '270.00', currency: 'CZK' } });
      expect(evaluated.evidence.foreignEvidenceOrigin).toBe('CALLER_SUPPLIED_UNVERIFIED');
      expect(evaluated.evidence.attempts).toBe(1);
      expect(declaredRegimeOf(evaluated.evidence.sellerVatRegime.selection)).toBe('VAT_PAYER');
      expect(
        evaluated.evidence.ruleSets.map(({ outcome: ruleSetOutcome, rowCount, taxClassificationCode }) => [
          taxClassificationCode,
          ruleSetOutcome,
          rowCount,
        ]),
      ).toEqual([
        ['cz-reduced-food', 'SELECTED', 1],
        ['cz-standard-goods', 'SELECTED', 1],
      ]);
      // Tax Evaluation Time is trusted server time, never the caller's Tax-Relevant Time (#941 F1, F3).
      expect(DateTime.isGreaterThan(evaluated.evidence.taxEvaluationTime, evaluated.evidence.taxRelevantTime)).toBe(
        true,
      );
      // #942 F23 the same complete state and input give the same Decision identity.
      expect(decisionIdOf(yield* subject.evaluate())).toBe(decisionIdOf(response));
    }),
  ).pipe(Effect.provideServiceEffect(Crypto.Crypto, nodeCrypto)),
);

it.live(
  'Unit 10 C a NON_PAYER seller publishes a zero-tax Decision with no rule read and the non-payer projection',
  () =>
    Effect.scoped(
      Effect.gen(function* nonPayerAcceptance() {
        const { identity, runtime } = yield* acquireDatabases;
        const subject = yield* seller(runtime, identity);
        yield* subject.declareNonPayer();
        // No Tax Rules exist at all; a NON_PAYER seller makes no rule read and still succeeds (#942 F5, F9-F21).

        const response = yield* subject.evaluate();
        const evaluated = evaluatedOf(response);
        const { outcome } = evaluated;

        expect(isSuccess(outcome) && outcome.result.purchaseTaxTotal).toEqual({ amount: '0.00', currency: 'CZK' });
        expect(evaluated.evidence.ruleSets).toEqual([]);
        expect(declaredRegimeOf(evaluated.evidence.sellerVatRegime.selection)).toBe('NON_PAYER');
        expect(Schema.is(CustomerSafeSellerNotVatPayerSchema)(evaluated.customerSafe)).toBe(true);
      }),
    ).pipe(Effect.provideServiceEffect(Crypto.Crypto, nodeCrypto)),
);

it.live('Unit 10 C a seller with nothing declared is indeterminate, never a stored final meaning', () =>
  Effect.scoped(
    Effect.gen(function* notDeclaredAcceptance() {
      const { identity, runtime } = yield* acquireDatabases;
      const subject = yield* seller(runtime, identity);
      yield* subject.launchRules;

      const response = yield* subject.evaluate();
      expect(outcomeOf(response)).toEqual(TaxStateIndeterminateSchema.make({}));
      expect(evaluatedOf(response).evidence.notDeterminedBecause).toBe('SELLER_VAT_REGIME_NOT_DECLARED');
    }),
  ).pipe(Effect.provideServiceEffect(Crypto.Crypto, nodeCrypto)),
);

it.live(
  '907-Q09 #960 an imported current-only declaration evaluates like a direct one from the migration start, never before it',
  () =>
    Effect.scoped(
      Effect.gen(function* migratedEvaluationAcceptance() {
        const { identity, runtime } = yield* acquireDatabases;
        const subject = yield* seller(runtime, identity);
        yield* subject.importDeclarations({
          declarations: [{ regime: 'VAT_PAYER', sourceRecordRef: 'legacy:current' }],
          migrationRunRef: 'migration-run-1',
          migrationStartedAt: '2026-01-15T00:00:00.000Z',
        });
        yield* subject.launchRules;

        const response = yield* subject.evaluate();
        const outcome = outcomeOf(response);
        if (!isSuccess(outcome)) {
          throw new Error('Expected a successful Tax Outcome');
        }
        expect(outcome.decision.sellerVatRegime).toBe('VAT_PAYER');
        expect(outcome.decision.declarationRevisionRef).toEqual({ revision: 1 });
        expect(evaluatedOf(response).evidence.sellerVatRegime.selection).toMatchObject({
          effectiveFromOrigin: 'MIGRATION_START',
          provenance: 'MIGRATED',
        });

        // No fabricated history: before the migration start the seller is not declared, so nothing is guessed.
        const before = yield* subject.evaluate({ taxRelevantTime: '2026-01-14T00:00:00.000Z' });
        expect(outcomeOf(before)).toEqual(TaxStateIndeterminateSchema.make({}));
        expect(evaluatedOf(before).evidence.notDeterminedBecause).toBe('SELLER_VAT_REGIME_NOT_DECLARED');
      }),
    ).pipe(Effect.provideServiceEffect(Crypto.Crypto, nodeCrypto)),
);

it.live('#942 F12-F15 #938 a VAT_PAYER seller with incomplete or conflicting rule state keeps its typed meaning', () =>
  Effect.scoped(
    Effect.gen(function* nonSuccessAcceptance() {
      const { identity, runtime } = yield* acquireDatabases;

      const missing = yield* seller(runtime, identity);
      yield* missing.declareVatPayer();
      yield* missing.createRule('cz.standard', 'cz-standard-goods', '21');
      // The reduced code has a complete, authoritative and empty applicable set.
      expect(outcomeOf(yield* missing.evaluate())).toEqual(TaxRuleMissingSchema.make({}));

      const overlapping = yield* seller(runtime, identity);
      yield* overlapping.declareVatPayer();
      yield* overlapping.launchRules;
      yield* overlapping.createRule('cz.standard-duplicate', 'cz-standard-goods', '21');
      expect(outcomeOf(yield* overlapping.evaluate())).toEqual(TaxRuleOverlapSchema.make({}));
    }),
  ).pipe(Effect.provideServiceEffect(Crypto.Crypto, nodeCrypto)),
);

it.live('Unit 10 C a regime revision effective after T but recorded before E still selects the regime at T', () =>
  Effect.scoped(
    Effect.gen(function* regimeAtTAcceptance() {
      const { identity, runtime } = yield* acquireDatabases;
      const subject = yield* seller(runtime, identity);
      yield* subject.declareVatPayer();
      yield* subject.launchRules;

      // T is in June; a NON_PAYER revision becomes effective in August, recorded now (well before E).
      yield* subject.declare({
        confirmReplacesScheduled: true,
        effectiveFrom: '2026-08-01T00:00:00.000Z',
        expectedCurrentRevision: 1,
        regime: 'NON_PAYER',
      });

      const response = yield* subject.evaluate({ taxRelevantTime: '2026-06-01T00:00:00.000Z' });
      const evaluated = evaluatedOf(response);
      expect(isSuccess(evaluated.outcome) && evaluated.outcome.result.purchaseTaxTotal).toEqual({
        amount: '270.00',
        currency: 'CZK',
      });
      expect(declaredRegimeOf(evaluated.evidence.sellerVatRegime.selection)).toBe('VAT_PAYER');
      expect(evaluated.evidence.sellerVatRegime.headRevision).toBe(2);
    }),
  ).pipe(Effect.provideServiceEffect(Crypto.Crypto, nodeCrypto)),
);

it.live('Unit 10 C #942 F17-F18 a declaration head that moves between observations discards the candidate', () =>
  Effect.scoped(
    Effect.gen(function* sellerHeadDiscardAcceptance() {
      const { admin, identity, runtime } = yield* acquireDatabases;
      const subject = yield* seller(runtime, identity);
      yield* subject.declareVatPayer();
      yield* subject.launchRules;

      // Revision 2 commits between attempt 1's two observations; attempt 2 observes it on both and publishes.
      const evaluated = evaluatedOf(yield* subject.evaluateRacing(admin, new Set([2])));
      expect(evaluated.evidence.attempts).toBe(2);
      expect(evaluated.evidence.discarded).toEqual([{ attempt: 1, discardedBecause: 'SELLER_VAT_REGIME_CHANGED' }]);
      expect(evaluated.evidence.exhausted).toBeUndefined();
      // The published candidate rests on the refreshed selection, never on attempt 1's revision 1.
      expect(evaluated.evidence.sellerVatRegime.headRevision).toBe(2);
      expect(selectedRevisionOf(evaluated.evidence.sellerVatRegime.selection)).toBe(2);
      const { outcome } = evaluated;
      expect(isSuccess(outcome) && outcome.decision.declarationRevisionRef.revision).toBe(2);
    }),
  ).pipe(Effect.provideServiceEffect(Crypto.Crypto, nodeCrypto)),
);

it.live('Unit 10 C #942 F19 a declaration head that moves within every attempt exhausts as indeterminate', () =>
  Effect.scoped(
    Effect.gen(function* sellerHeadExhaustionAcceptance() {
      const { admin, identity, runtime } = yield* acquireDatabases;
      const subject = yield* seller(runtime, identity);
      yield* subject.declareVatPayer();
      yield* subject.launchRules;

      // A new revision commits between the two observations of each of the three bounded attempts.
      const evaluated = evaluatedOf(yield* subject.evaluateRacing(admin, new Set([2, 4, 6])));
      expect(evaluated.outcome).toEqual(TaxStateIndeterminateSchema.make({}));
      expect(evaluated.evidence.exhausted).toBe('EVALUATION_RACE_UNRESOLVED');
      expect(evaluated.evidence.attempts).toBe(3);
      expect(evaluated.evidence.discarded).toEqual([
        { attempt: 1, discardedBecause: 'SELLER_VAT_REGIME_CHANGED' },
        { attempt: 2, discardedBecause: 'SELLER_VAT_REGIME_CHANGED' },
        { attempt: 3, discardedBecause: 'SELLER_VAT_REGIME_CHANGED' },
      ]);
      // The evidence names the last observed head, kept only as evidence and never published as a candidate.
      expect(evaluated.evidence.sellerVatRegime.headRevision).toBe(4);
      expect(selectedRevisionOf(evaluated.evidence.sellerVatRegime.selection)).toBe(4);
    }),
  ).pipe(Effect.provideServiceEffect(Crypto.Crypto, nodeCrypto)),
);

it.live('#950 F24 #942 F22 the trusted scope and a future Tax-Relevant Time bound every evaluation', () =>
  Effect.scoped(
    Effect.gen(function* scopeAndTimeAcceptance() {
      const { identity, runtime } = yield* acquireDatabases;
      const subject = yield* seller(runtime, identity);
      yield* subject.declareVatPayer();
      yield* subject.launchRules;

      // A purchase naming another Selling Legal Entity is not visible in this scope.
      const foreign = yield* subject.evaluate({
        purchase: purchaseBindingInput(['o1', 'o2'], {
          sellingLegalEntityRef: yield* nextUuid,
          tenantId: identity.tenantId,
        }),
      });
      expect(Option.isNone(foreign)).toBe(true);
      // A purchase naming another Tenant is not visible either, whatever its seller (#950 F24).
      const otherTenant = yield* subject.evaluate({
        purchase: purchaseBindingInput(['o1', 'o2'], {
          sellingLegalEntityRef: subject.legalEntityId,
          tenantId: yield* nextUuid,
        }),
      });
      expect(Option.isNone(otherTenant)).toBe(true);

      const future = Option.getOrThrow(yield* subject.evaluate({ taxRelevantTime: '2099-01-01T00:00:00.000Z' }));
      expect(isRejected(future) && future.reasons).toEqual(['FUTURE_TAX_RELEVANT_TIME']);

      // Supplied classification must bind; absent payer classification is material state, not a purchase defect.
      const incompleteClassification = yield* subject.evaluate({
        catalog: [catalogEntry('o1', 'cz-standard-goods')],
      });
      expect(Schema.is(TaxStateIndeterminateSchema)(outcomeOf(incompleteClassification))).toBe(true);
      const unbound = Option.getOrThrow(
        yield* subject.evaluate({ catalog: [catalogEntry('foreign-occurrence', 'cz-standard-goods')] }),
      );
      expect(isRejected(unbound) && unbound.reasons).toEqual(['STRUCTURAL_BINDING_INVALID']);
    }),
  ).pipe(Effect.provideServiceEffect(Crypto.Crypto, nodeCrypto)),
);

it.live(
  'PO decision D3 on #907: a GROSS Shipping allocation evaluates from real reads and repeats deterministically',
  () =>
    Effect.scoped(
      Effect.gen(function* shippingAllocationAcceptance() {
        const { identity, runtime } = yield* acquireDatabases;
        const subject = yield* seller(runtime, identity);
        yield* subject.declareVatPayer();
        yield* subject.launchRules;

        const shippingRequest = {
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
        } as const;

        const response = yield* subject.evaluate(shippingRequest);
        const outcome = outcomeOf(response);
        if (!isSuccess(outcome)) {
          throw new Error('Expected a successful Tax Outcome');
        }
        expect(outcome.result.purchaseTaxTotal.amount).toBe('47.02');
        // The exact gross-weighted shares (99 * 121/233, 99 * 112/233) and the code-versioned allocation key
        // are on the Decision, not just the rounded published amounts (#907 plan §5.4). Storage and same-submission
        // recovery of the final are covered by `order-tax-finalization-postgres.test.ts`.
        expect(
          outcome.decision.shippingAllocation?.unitAllocations.map(({ basisComponent, taxableSupplyUnitId }) => [
            taxableSupplyUnitId,
            basisComponent.amount,
            basisComponent.amountBasis,
            basisComponent.allocationKey,
          ]),
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

        // Repeat-evaluation determinism (#942 F23): the identical input and state give back the same Decision
        // identity and the identical Shipping allocation and Result.
        const replay = yield* subject.evaluate(shippingRequest);
        const replayOutcome = outcomeOf(replay);
        if (!isSuccess(replayOutcome)) {
          throw new Error('Expected a successful Tax Outcome');
        }
        expect(replayOutcome.decision.decisionId).toBe(outcome.decision.decisionId);
        expect(replayOutcome.decision.shippingAllocation).toEqual(outcome.decision.shippingAllocation);
        expect(replayOutcome.result.purchaseTaxTotal).toEqual(outcome.result.purchaseTaxTotal);
      }),
    ).pipe(Effect.provideServiceEffect(Crypto.Crypto, nodeCrypto)),
);

it.live('907-Q07 #933 a payer NET Shipping charge over NET lines evaluates from real reads in its own NET basis', () =>
  Effect.scoped(
    Effect.gen(function* netShippingAcceptance() {
      const { identity, runtime } = yield* acquireDatabases;
      const subject = yield* seller(runtime, identity);
      yield* subject.declareVatPayer();
      yield* subject.launchRules;

      const outcome = outcomeOf(
        yield* subject.evaluate({
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
      );
      if (!isSuccess(outcome)) {
        throw new Error('Expected a successful Tax Outcome');
      }
      // Gross weights 100 * 1.21 = 121 and 100 * 1.12 = 112; NET shares 99 * 121/233 and 99 * 112/233.
      expect(
        outcome.decision.shippingAllocation?.unitAllocations.map(({ basisComponent, taxableSupplyUnitId }) => [
          taxableSupplyUnitId,
          basisComponent.amount,
          basisComponent.amountBasis,
        ]),
      ).toEqual([
        ['taxable-supply-unit:o1', { denominator: '233', numerator: '11979' }, 'NET'],
        ['taxable-supply-unit:o2', { denominator: '233', numerator: '11088' }, 'NET'],
      ]);
      // o1 21 + 11979/233 * 21/100 = 740859/23300 -> 31.80; o2 12 + 11088/233 * 12/100 = 103164/5825 -> 17.71.
      expect(
        outcome.result.units.map(({ publishedTaxAmount, taxableSupplyUnitId }) => [
          taxableSupplyUnitId,
          publishedTaxAmount.amount,
        ]),
      ).toEqual([
        ['taxable-supply-unit:o1', '31.80'],
        ['taxable-supply-unit:o2', '17.71'],
      ]);
      expect(outcome.result.purchaseTaxTotal.amount).toBe('49.51');
    }),
  ).pipe(Effect.provideServiceEffect(Crypto.Crypto, nodeCrypto)),
);

it.live('#961 scenario 1: ordinary B2C for a declared VAT_PAYER seller through the public read handler', () =>
  Effect.scoped(
    Effect.gen(function* ordinaryB2cScenario() {
      const { identity, runtime } = yield* acquireDatabases;
      const subject = yield* seller(runtime, identity);
      yield* subject.declareVatPayer();
      const ruleIds = (yield* Schema.decodeUnknownEffect(Schema.Array(CreatedRuleIdSchema))(yield* subject.launchRules))
        .map(({ taxRuleId }) => taxRuleId)
        .toSorted();

      const response = yield* subject.readPublic();
      const evaluated = evaluatedOf(response);
      const outcome = successOf(response);

      // One Taxable Supply Unit per purchase occurrence, each rounded separately.
      expect(publishedByUnit(response)).toEqual([
        ['taxable-supply-unit:o1', '210.00'],
        ['taxable-supply-unit:o2', '60.00'],
      ]);
      // The total is the exact sum of the published unit amounts.
      const unitSum = outcome.result.units.reduce(
        (sum, { publishedTaxAmount }) => sum + centsOf(publishedTaxAmount.amount),
        0n,
      );
      expect(centsOf(outcome.result.purchaseTaxTotal.amount)).toBe(unitSum);
      // The evidence names the governing persisted Tax Rule revisions and the declared Seller VAT Regime revision.
      expect(
        outcome.decision.units
          .map((unit) => ('governingTaxRuleRevisionRef' in unit ? unit.governingTaxRuleRevisionRef : undefined))
          .map((ref) => `${ref?.taxRuleId}@${ref?.revision}`)
          .toSorted(),
      ).toEqual(ruleIds.map((taxRuleId) => `${taxRuleId}@1`).toSorted());
      expect(outcome.decision.sellerVatRegime).toBe('VAT_PAYER');
      expect(outcome.decision.declarationRevisionRef.revision).toBe(1);
      expect(declaredRegimeOf(evaluated.evidence.sellerVatRegime.selection)).toBe('VAT_PAYER');
      expect(evaluated.evidence.foreignEvidenceOrigin).toBe('CALLER_SUPPLIED_UNVERIFIED');
    }),
  ).pipe(Effect.provideServiceEffect(Crypto.Crypto, nodeCrypto)),
);

it.live('#961 scenario 2: ordinary B2B with no buyer VAT status has the same success meaning as B2C', () =>
  Effect.scoped(
    Effect.gen(function* ordinaryB2bScenario() {
      const { identity, runtime } = yield* acquireDatabases;
      const subject = yield* seller(runtime, identity);
      yield* subject.declareVatPayer();
      yield* subject.launchRules;

      const b2c = yield* subject.readPublic();
      const b2b = yield* subject.readPublic({
        purchase: purchaseBindingInput(['o1', 'o2'], {
          purchasingSubject: { _tag: 'COUNTERPARTY', counterpartyRef: 'counterparty-1' },
          sellingLegalEntityRef: subject.legalEntityId,
          tenantId: identity.tenantId,
          traceabilityContext: { channel: 'B2B', storefrontRef: 'storefront-1' },
        }),
      });

      expect(publishedByUnit(b2b)).toEqual(publishedByUnit(b2c));
      expect(successOf(b2b).result.purchaseTaxTotal).toEqual({ amount: '270.00', currency: 'CZK' });
      expect(evaluatedOf(b2b).evidence.foreignEvidenceOrigin).toBe('CALLER_SUPPLIED_UNVERIFIED');
    }),
  ).pipe(Effect.provideServiceEffect(Crypto.Crypto, nodeCrypto)),
);

it.live('#961 scenario 3: two equal-valued distinct occurrences at 21 % stay two units, each rounded separately', () =>
  Effect.scoped(
    Effect.gen(function* equalOccurrencesScenario() {
      const { identity, runtime } = yield* acquireDatabases;
      const subject = yield* seller(runtime, identity);
      yield* subject.declareVatPayer();
      yield* subject.launchRules;

      const response = yield* subject.readPublic({
        catalog: [catalogEntry('o1', STANDARD_CODE), catalogEntry('o2', STANDARD_CODE)],
        pricing: {
          pricingResultRef: PRICING_RESULT_REF,
          publishedLines: [pricingLine('o1', '0.03'), pricingLine('o2', '0.03')],
        },
      });

      // 0.03 * 21 % = 0.0063 per unit rounds to 0.01 each; a merged 0.06 base would publish 0.01 in total.
      expect(publishedByUnit(response)).toEqual([
        ['taxable-supply-unit:o1', '0.01'],
        ['taxable-supply-unit:o2', '0.01'],
      ]);
      expect(successOf(response).result.purchaseTaxTotal).toEqual({ amount: '0.02', currency: 'CZK' });
    }),
  ).pipe(Effect.provideServiceEffect(Crypto.Crypto, nodeCrypto)),
);

it.live('#961 scenario 4: a supported whole-treatment Set is one Taxable Supply Unit with no component prices', () =>
  Effect.scoped(
    Effect.gen(function* wholeTreatmentSetScenario() {
      const { identity, runtime } = yield* acquireDatabases;
      const subject = yield* seller(runtime, identity);
      yield* subject.declareVatPayer();
      yield* subject.launchRules;

      const setSelection = {
        productRef: 'product-1',
        setCompositionRevisionRef: { revision: 1, setCompositionId: 'set-1' },
        variantRef: 'variant-1',
      };
      const response = yield* subject.readPublic({
        catalog: [catalogEntry('o1', STANDARD_CODE, { catalogSelection: setSelection })],
        pricing: { pricingResultRef: PRICING_RESULT_REF, publishedLines: [pricingLine('o1', '1000.00')] },
        purchase: purchaseBindingInput(['o1'], {
          purchaseDemandOccurrences: [{ ...occurrenceInput('o1'), catalogSelection: setSelection }],
          sellingLegalEntityRef: subject.legalEntityId,
          tenantId: identity.tenantId,
        }),
        setSupplyMeanings: [{ meaning: 'WHOLE_TREATMENT_SET', occurrenceId: 'o1' }],
      });

      const outcome = successOf(response);
      expect(publishedByUnit(response)).toEqual([['taxable-supply-unit:o1', '210.00']]);
      const [unit] = outcome.decision.units;
      expect(
        Match.value(unit.taxableSupplyUnit.mapping).pipe(
          Match.tag('WHOLE_TREATMENT_SET', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
      // The Set's own published line is the only basis component: no component prices enter the unit.
      expect(unit.taxableBasisInterpretation.components).toHaveLength(1);
      expect(Schema.is(LineCommercialValueBasisSchema)(unit.taxableBasisInterpretation.components[0])).toBe(true);
    }),
  ).pipe(Effect.provideServiceEffect(Crypto.Crypto, nodeCrypto)),
);

it.live('#961 scenario 5: a complete empty rule state for a supported case is TAX_RULE_MISSING, never 0 CZK', () =>
  Effect.scoped(
    Effect.gen(function* completeEmptyScenario() {
      const { identity, runtime } = yield* acquireDatabases;
      const subject = yield* seller(runtime, identity);
      yield* subject.declareVatPayer();

      const response = yield* subject.readPublic();
      expect(outcomeOf(response)).toEqual(TaxRuleMissingSchema.make({}));
      expect(evaluatedOf(response).evidence.ruleSets.map(({ outcome, rowCount }) => [outcome, rowCount])).toEqual([
        ['TAX_RULE_MISSING', 0],
        ['TAX_RULE_MISSING', 0],
      ]);
    }),
  ).pipe(Effect.provideServiceEffect(Crypto.Crypto, nodeCrypto)),
);

it.live('#961 scenario 6: an unavailable delivery destination is TAX_DEPENDENCY_UNAVAILABLE, never a CZ fallback', () =>
  Effect.scoped(
    Effect.gen(function* unavailableSourceScenario() {
      const { identity, runtime } = yield* acquireDatabases;
      const subject = yield* seller(runtime, identity);
      yield* subject.declareVatPayer();
      yield* subject.launchRules;

      const response = yield* subject.readPublic({
        places: {
          ...evaluationRequestInput().places,
          deliveryDestination: { _tag: 'NOT_ESTABLISHED', state: 'UNAVAILABLE' },
        },
      });
      expect(outcomeOf(response)).toEqual(TaxDependencyUnavailableSchema.make({}));
    }),
  ).pipe(Effect.provideServiceEffect(Crypto.Crypto, nodeCrypto)),
);

it.live(
  '#961 scenario 7: a known non-CZ destination with rules present is TAX_CASE_UNSUPPORTED, no domestic fallback',
  () =>
    Effect.scoped(
      Effect.gen(function* nonCzechDestinationScenario() {
        const { identity, runtime } = yield* acquireDatabases;
        const subject = yield* seller(runtime, identity);
        yield* subject.declareVatPayer();
        yield* subject.launchRules;

        const response = yield* subject.readPublic({
          places: {
            ...evaluationRequestInput().places,
            deliveryDestination: { _tag: 'OWNER_RESOLVED', countryCode: 'DE', ownerEvidenceRef: 'delivery-de' },
          },
        });
        expect(outcomeOf(response)).toEqual(
          TaxCaseUnsupportedSchema.make({ unsupportedRequirement: 'NON_CZECH_DOMESTIC_TAX_PLACE' }),
        );
      }),
    ).pipe(Effect.provideServiceEffect(Crypto.Crypto, nodeCrypto)),
);

it.live('#961 scenario 8: a NON_PAYER seller succeeds as non-payer and an undeclared seller is indeterminate', () =>
  Effect.scoped(
    Effect.gen(function* sellerRegimeScenario() {
      const { identity, runtime } = yield* acquireDatabases;
      const nonPayer = yield* seller(runtime, identity);
      yield* nonPayer.declareNonPayer();
      const undeclared = yield* seller(runtime, identity);
      yield* undeclared.launchRules;

      const nonPayerResponse = yield* nonPayer.readPublic();
      expect(successOf(nonPayerResponse).decision.sellerVatRegime).toBe('NON_PAYER');
      expect(successOf(nonPayerResponse).result.purchaseTaxTotal).toEqual({ amount: '0.00', currency: 'CZK' });
      expect(Schema.is(CustomerSafeSellerNotVatPayerSchema)(evaluatedOf(nonPayerResponse).customerSafe)).toBe(true);

      const undeclaredResponse = yield* undeclared.readPublic();
      expect(outcomeOf(undeclaredResponse)).toEqual(TaxStateIndeterminateSchema.make({}));
      expect(evaluatedOf(undeclaredResponse).evidence.notDeterminedBecause).toBe('SELLER_VAT_REGIME_NOT_DECLARED');
    }),
  ).pipe(Effect.provideServiceEffect(Crypto.Crypto, nodeCrypto)),
);

it.live('#961 scenario 10: a supported 0.00 CZK line is a successful taxable 0.00 with its persisted rule', () =>
  Effect.scoped(
    Effect.gen(function* taxableZeroScenario() {
      const { identity, runtime } = yield* acquireDatabases;
      const subject = yield* seller(runtime, identity);
      yield* subject.declareVatPayer();
      yield* subject.launchRules;

      const response = yield* subject.readPublic({
        catalog: [catalogEntry('o1', STANDARD_CODE)],
        pricing: { pricingResultRef: PRICING_RESULT_REF, publishedLines: [pricingLine('o1', '0.00')] },
        purchase: purchaseBindingInput(['o1'], {
          sellingLegalEntityRef: subject.legalEntityId,
          tenantId: identity.tenantId,
        }),
      });

      // Zero follows from a taxable Decision at 21 % under a persisted rule: not zero-rate, exempt or non-payer.
      const outcome = successOf(response);
      expect(publishedByUnit(response)).toEqual([['taxable-supply-unit:o1', '0.00']]);
      expect(outcome.decision.sellerVatRegime).toBe('VAT_PAYER');
      const [unit] = outcome.decision.units;
      expect(Schema.is(TaxableTreatmentSchema)(unit.treatment)).toBe(true);
      expect('governingTaxRuleRevisionRef' in unit && unit.governingTaxRuleRevisionRef.revision).toBe(1);
      expect(Schema.is(CustomerSafeSellerNotVatPayerSchema)(evaluatedOf(response).customerSafe)).toBe(false);
    }),
  ).pipe(Effect.provideServiceEffect(Crypto.Crypto, nodeCrypto)),
);
