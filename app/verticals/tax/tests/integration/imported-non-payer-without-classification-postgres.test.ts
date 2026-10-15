import { randomUUID } from 'node:crypto';

import { ContextAccess, ReadRuntime, toContextPermissionAccessKey } from '@app/core-runtime';
import type {
  ContextAccessService,
  DomainEventReference,
  OperationalScope,
  ScopedTransactionExecutor,
} from '@app/core-runtime';
import { makeGovernedReadHttpHandler } from '@app/core-runtime/http/governed-read';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import type { PgClient } from '@effect/sql-pg';
import { makeGovernedReadProblems } from '@app/shared-contracts/server/effect-bff-runtime';
import { RequestSchemaProblemLive } from '@app/shared-contracts/server/http-error-seam';
import { HttpApiBuilder, HttpRouter, HttpServer } from '@modern-js/bff-effect/effect-edge';
import { eq, sql } from 'drizzle-orm';
import { Context, DateTime, Effect, Layer, Match, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { FetchHttpClient } from 'effect/http';

import { coreRelations } from '../../../../packages/core-runtime/src/db/schema.ts';
import { installOperationalScope } from '../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import type { TestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import {
  FinalizeOrderTaxPayloadSchema,
  FinalizeOrderTaxResultSchema,
} from '../../shared/actions/order-tax-finalization.ts';
import {
  ImportSellerVatRegimeDeclarationsPayloadSchema,
  ImportSellerVatRegimeDeclarationsResultSchema,
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
import { TaxEvaluationEvidenceSchema } from '../../shared/domain/tax-evaluation-contracts.ts';
import { SellerNotVatPayerTreatmentSchema } from '../../shared/domain/tax-kernel/tax-treatment.ts';
import { TaxOutcomeSuccessSchema } from '../../shared/domain/tax-kernel/tax-outcome.ts';
import { handleFinalizeOrderTax } from '../../src/actions/finalize-order-tax.action.ts';
import { handleImportSellerVatRegimeDeclarations } from '../../src/actions/import-seller-vat-regime-declarations.action.ts';
import { executeTaxEvaluationWithAuthorization } from '../../src/api/tax-evaluation-client.ts';
import { taxEvaluationRead } from '../../src/api/tax-evaluation.read.ts';
import { taxOrderTaxFinalizations, taxRelations, taxSellerVatRegimeDeclarations } from '../../src/database/schema.ts';
import { orderTaxFinalizationsForScope } from '../../src/services/order-tax-finalization.service.ts';
import { sellerVatRegimeDeclarationsForScope } from '../../src/services/seller-vat-regime-declaration.service.ts';
import { purchaseBindingInput } from '../unit/tax-domain-fixtures.ts';
import { evaluationRequestInput } from '../unit/tax-evaluation-fixtures.ts';

const tenantId = randomUUID();
const legalEntityId = randomUUID();
const T = '2026-06-01T10:00:00.000Z';
const scope: OperationalScope = {
  authBindingId: randomUUID(),
  authContextRef: `better-auth-session:${randomUUID()}`,
  authMethod: 'session',
  correlationId: randomUUID(),
  legalEntityId,
  principalId: randomUUID(),
  tenantId,
};
type CoreTestDatabase = TestDatabaseFromClient<typeof coreRelations>;

const runScoped = <Value, Failure>(
  database: CoreTestDatabase,
  operation: (transaction: ScopedTransactionExecutor) => Effect.Effect<Value, Failure>,
) => database.transaction((transaction) => installOperationalScope(transaction, scope).pipe(Effect.flatMap(operation)));

/** Trusted Action admission/collector seam; owner persistence is native PostgreSQL, not a scripted service. */
const actionContext = <Services>(services: Services) => {
  const eventReference: DomainEventReference = Schema.decodeSync(Schema.Any)({});
  return {
    actionInvocationId: randomUUID(),
    addDomainEvent: () => Effect.succeed(eventReference),
    addOutboxMessage: () => Effect.void,
    compositionRevision: 'c'.repeat(64),
    recordAuditEvidence: () => Effect.void,
    recordDataAccess: () => Effect.void,
    scope,
    services,
  };
};

const cleanup = (admin: TestDatabaseFromClient<typeof taxRelations>) =>
  admin.transaction((transaction) =>
    Effect.gen(function* cleanupImportedNonPayerFixtures() {
      yield* transaction.execute(sql`set local session_replication_role = 'replica'`, 'objects');
      yield* transaction.delete(taxOrderTaxFinalizations).where(eq(taxOrderTaxFinalizations.tenantId, tenantId));
      yield* transaction
        .delete(taxSellerVatRegimeDeclarations)
        .where(eq(taxSellerVatRegimeDeclarations.tenantId, tenantId));
    }),
  );

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
 * Generated HTTP contract/client and real Read Runtime/TAX registration. Authentication and Core admission SQL
 * are controlled test boundaries; only TAX SQL reaches native PostgreSQL with the least-privilege runtime role.
 * The named foreign-owner fixtures remain CALLER_SUPPLIED_UNVERIFIED, not actual owner integration.
 */
const evaluationHttp = Effect.fn('ImportedNonPayerTest.evaluationHttp')(function* evaluationHttp(
  runtimeClient: PgClient.PgClient,
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
            Effect.map((rows) => rows.map(positionalRow)),
          ),
      ),
    operationTime: DateTime.toDateUtc(DateTime.makeUnsafe('2026-02-01T00:00:00.000Z')),
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
  const statuses: number[] = [];
  const routerFetch: typeof fetch = (url, init) =>
    server.handler(new Request(url, init), requestContext).then((response) => {
      statuses.push(response.status);
      return response;
    });
  const run = (payload: typeof TaxEvaluationRequestSchema.Type) =>
    executeTaxEvaluationWithAuthorization(payload, 'Bearer controlled', scope.correlationId, {
      baseUrl: 'https://tax.example',
    }).pipe(Effect.provideService(FetchHttpClient.Fetch, routerFetch));
  return { run, snapshot: harness.snapshot, statuses };
});

const EvaluatedSuccessSchema = Schema.TaggedStruct('EVALUATED', {
  evidence: TaxEvaluationEvidenceSchema,
  outcome: TaxOutcomeSuccessSchema,
});

it.live(
  'E03 imported NON_PAYER without TAX_CATEGORY evaluates over public HTTP and finalizes from persisted import',
  () =>
    Effect.scoped(
      Effect.gen(function* importedNonPayerWithoutClassification() {
        const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
        const admin = yield* makeTestDatabaseFromClient(adminClient, taxRelations);
        const runtime = yield* makeTestDatabaseFromClient(runtimeClient, coreRelations);
        yield* cleanup(admin);
        yield* Effect.addFinalizer(() => cleanup(admin).pipe(Effect.orDie));
        const importPayload = yield* Schema.decodeEffect(ImportSellerVatRegimeDeclarationsPayloadSchema)({
          declarations: [{ regime: 'NON_PAYER', sourceRecordRef: 'legacy:non-payer-without-tax-category' }],
          migrationRunRef: 'e03:source-import',
          migrationStartedAt: '2026-01-15T00:00:00.000Z',
        });
        const importDeclarations = runScoped(runtime, (transaction) =>
          handleImportSellerVatRegimeDeclarations(
            importPayload,
            actionContext(sellerVatRegimeDeclarationsForScope(transaction, scope)),
          ),
        ).pipe(Effect.flatMap(Schema.encodeEffect(ImportSellerVatRegimeDeclarationsResultSchema)));
        expect(yield* importDeclarations).toMatchObject({ created: true });
        expect(yield* importDeclarations).toMatchObject({ created: false });
        const sourceRows = yield* adminClient.unsafe(
          `select regime, provenance, effective_from_origin, source_record_ref
       from tax.tax_seller_vat_regime_declarations where tenant_id = $1 and legal_entity_id = $2`,
          [tenantId, legalEntityId],
        );
        expect(sourceRows).toEqual([
          {
            effective_from_origin: 'MIGRATION_START',
            provenance: 'MIGRATED',
            regime: 'NON_PAYER',
            source_record_ref: 'legacy:non-payer-without-tax-category',
          },
        ]);

        const { catalog: _catalog, ...withoutClassification } = evaluationRequestInput({
          purchase: purchaseBindingInput(['o1', 'o2'], { sellingLegalEntityRef: legalEntityId, tenantId }),
          taxRelevantTime: T,
        });
        const request = yield* Schema.decodeEffect(TaxEvaluationRequestSchema)(withoutClassification);
        expect(request).not.toHaveProperty('catalog');
        const http = yield* evaluationHttp(runtimeClient);
        const evaluated = yield* http
          .run(request)
          .pipe(
            Effect.flatMap(Schema.encodeEffect(TaxEvaluationResponseSchema)),
            Effect.flatMap(Schema.decodeUnknownEffect(EvaluatedSuccessSchema)),
          );
        expect(http.statuses).toEqual([200]);
        expect(evaluated.outcome.decision.purchaseBinding).toEqual(request.purchase);
        expect(evaluated.outcome.decision.sellerVatRegime).toBe('NON_PAYER');
        expect(evaluated.outcome.decision.declarationRevisionRef).toEqual({ revision: 1 });
        expect(evaluated.outcome.result.purchaseTaxTotal).toEqual({ amount: '0.00', currency: 'CZK' });
        expect(
          evaluated.outcome.decision.units.every(({ treatment }) =>
            Schema.is(SellerNotVatPayerTreatmentSchema)(treatment),
          ),
        ).toBe(true);
        expect(
          evaluated.outcome.decision.units.every(
            (unit) => !('taxClassification' in unit) && !('governingTaxRuleRevisionRef' in unit),
          ),
        ).toBe(true);
        expect(evaluated.evidence.sellerVatRegime.selection).toMatchObject({
          effectiveFromOrigin: 'MIGRATION_START',
          provenance: 'MIGRATED',
        });
        expect(evaluated.evidence.foreignEvidenceOrigin).toBe('CALLER_SUPPLIED_UNVERIFIED');
        expect(evaluated.evidence.ruleSets).toEqual([]);
        expect(http.snapshot().ownerQueries.some((query) => /tax_rules|tax_rule_revisions/iu.test(query.sql))).toBe(
          false,
        );

        const { taxRelevantTime: _taxRelevantTime, ...candidate } = withoutClassification;
        const submissionRef = `e03:submission:${randomUUID()}`;
        const finalPayload = yield* Schema.decodeEffect(FinalizeOrderTaxPayloadSchema)({
          candidate,
          orderCommitmentTime: T,
          provenanceRef: 'e03:acceptance',
          reason: 'Imported non-payer final',
          submissionRef,
        });
        const final = yield* runScoped(runtime, (transaction) =>
          handleFinalizeOrderTax(finalPayload, actionContext(orderTaxFinalizationsForScope(transaction, scope))),
        ).pipe(
          Effect.flatMap(Schema.encodeEffect(FinalizeOrderTaxResultSchema)),
          Effect.flatMap(Schema.decodeUnknownEffect(FinalizeOrderTaxResultSchema)),
        );
        const finalized = yield* Match.value(final).pipe(
          Match.tag('FINALIZED', (value) => Effect.succeed(value)),
          Match.orElse(() => Effect.die(new Error('Expected an imported non-payer final'))),
        );
        expect(finalized.created).toBe(true);
        expect(finalized.handoff.outcome.decision.purchaseBinding).toEqual(request.purchase);
        expect(finalized.handoff.outcome.decision.sellerVatRegime).toBe('NON_PAYER');
        expect(finalized.handoff.outcome.result.purchaseTaxTotal).toEqual({ amount: '0.00', currency: 'CZK' });
        expect(DateTime.formatIso(finalized.handoff.orderCommitmentTime)).toBe(T);
        expect(finalized.evidence.sellerVatRegime.selection).toMatchObject({ provenance: 'MIGRATED' });
        expect(finalized.evidence.ruleSets).toEqual([]);
        const recovered = yield* runScoped(runtime, (transaction) =>
          orderTaxFinalizationsForScope(transaction, scope).finalOrderTax({
            submissionRef: finalPayload.submissionRef,
          }),
        ).pipe(Effect.map(Option.getOrThrow));
        expect(recovered.handoff).toEqual(finalized.handoff);
        const finalRows = yield* adminClient.unsafe(
          `select outcome -> 'result' -> 'purchaseTaxTotal' ->> 'amount' as tax_amount, governing_rule_revisions
       from tax.tax_order_tax_finalizations where tenant_id = $1 and submission_ref = $2`,
          [tenantId, submissionRef],
        );
        expect(finalRows).toEqual([{ governing_rule_revisions: [], tax_amount: '0.00' }]);
      }),
    ),
);
