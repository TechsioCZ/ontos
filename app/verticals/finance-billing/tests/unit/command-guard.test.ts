import { NodeCrypto } from '@effect/platform-node';
import { Crypto, DateTime, Effect, Layer, PlatformError, Predicate, Schema } from 'effect';
import { HttpServerRequest } from 'effect/http';
import { expect, it } from 'effect-rstest';
import {
  ActiveApplicationCompositionService,
  ContextAccess,
  agentGrantRelationships,
  ReadRuntime,
} from '@app/core-runtime';
import type { AgentGrantWritePolicy } from '@app/core-runtime';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { scriptedPgClientLayer } from '@app/core-runtime/testing/scripted-pg-client';
import { GatewayPrincipalVerifierConfiguration } from '@app/gateway-principal-verifier/server';
import { and, eq } from 'drizzle-orm';
import { Reactivity } from 'effect/reactivity';
import type { ApplyCommandPayload } from '../../shared/actions/apply-command.ts';
import { FinancePersistenceUnavailable } from '../../shared/actions/apply-command.ts';
import type { FinanceState, Invoice } from '../../shared/apis/records.ts';
import { applyCommandAction } from '../../src/actions/apply-command.action.ts';

import { transitionFinance } from '../../src/services/persistence.service.ts';
import type { FinanceValidators } from '../../src/services/persistence.service.ts';
import { FinanceReferenceValidators } from '../../src/services/reference-validation.ts';
import { financeBillingRegistration } from '../../vertical.registration.ts';
import { financeStates } from '../../src/database/schema.ts';
import { FinanceTaxRatesBaseline } from '../support/finance-tax-rates.ts';

const principal = {
  authBindingId: '10000000-0000-4000-8000-000000000001',
  authContextRef: 'api-key:finance-command-test',
  authMethod: 'api_key',
  legalEntityId: '30000000-0000-4000-8000-000000000001',
  principalId: '20000000-0000-4000-8000-000000000001',
  tenantId: '40000000-0000-4000-8000-000000000001',
} as const;
const counterpartyRef: Invoice['counterpartyRef'] = {
  moduleId: 'party.registry',
  resourceId: '50000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.counterparty',
  tenantId: principal.tenantId,
};
const payload: ApplyCommandPayload = {
  command: {
    _tag: 'CreateInvoiceDraft',
    counterpartyRef,
    currency: 'CZK',
    direction: 'INCOMING',
    documentNumber: 'NATIVE-EXECUTE-001',
    dueDate: '2026-11-07',
    issueDate: '2026-10-24',
    totalMinor: 420_000,
  },
  expectedRevision: 0,
};
const request = {
  payload,
  principal,
  registration: applyCommandAction,
  transport: { correlationId: 'finance-command-test', idempotencyKey: 'finance-command-once' },
};

// Only transaction-scoped owner services are bound below. The original reference preparation and
// the registered Action's canonical gate still run before its owner write.
const unused = () => Effect.die('Unexpected production-factory dependency');
const unusedProductionServices = Layer.mergeAll(
  Layer.succeed(ActiveApplicationCompositionService, { load: unused() }),
  Layer.succeed(ContextAccess, {
    legalEntities: unused,
    modules: unused,
    resources: unused,
    tenants: unused,
  }),
  Layer.succeed(GatewayPrincipalVerifierConfiguration, { configuration: unused() }),
  Layer.succeed(
    HttpServerRequest.HttpServerRequest,
    HttpServerRequest.fromWeb(new Request('https://ontos.test/actions')),
  ),
  Layer.succeed(ReadRuntime, { runRead: unused }),
  // Tests that reach reference preparation provide their own per-request validators.
  Layer.succeed(FinanceReferenceValidators, { forScope: unused }),
);
const profileActionGrants = (writePolicy: AgentGrantWritePolicy) =>
  agentGrantRelationships({
    actions: [applyCommandAction.descriptor],
    legalEntityId: principal.legalEntityId,
    legalEntityWriteRelations: new Map(),
    modules: [{ access: 'write', moduleId: 'finance.billing' }],
    principalId: principal.principalId,
    template: [],
    tenantId: principal.tenantId,
    writePolicy,
  }).filter((relationship) => relationship.resource?.objectType === 'action_grant');
const queryCompilationLayer = scriptedPgClientLayer(Effect.die('Query compilation must not acquire SQL')).pipe(
  Layer.provide(Reactivity.layer),
);

it.layer(Layer.mergeAll(unusedProductionServices, NodeCrypto.layer, queryCompilationLayer, FinanceTaxRatesBaseline))(
  'Finance command authorization',
  (suite) => {
    suite.effect('executes an API-key principal through the real Action when native execute is allowed', () =>
      Effect.gen(function* apiKeyCommand() {
        const saved: FinanceState[] = [];
        expect(profileActionGrants('direct').map(({ relation }) => relation)).toEqual(['role']);
        const transition = yield* transitionFinance(
          { financialPlanEntries: [], invoices: [] },
          payload.command,
          { legalEntityId: principal.legalEntityId, tenantId: principal.tenantId },
          { invoice: () => Effect.void },
          {
            attemptId: principal.authBindingId,
            now: DateTime.makeUnsafe('2026-11-02T00:00:00Z'),
            principalId: principal.principalId,
            resourceId: principal.authBindingId,
          },
        );
        // Compile the exact owner SELECT with the native Drizzle driver. This client never executes:
        // the registered preparation below runs that SQL through Core's read-only snapshot fixture.
        const queryBuilder = yield* testCoreDatabase;
        const snapshotQuery = queryBuilder
          .select({ revision: financeStates.revision, state: financeStates.state })
          .from(financeStates)
          .where(
            and(
              eq(financeStates.tenantId, principal.tenantId),
              eq(financeStates.legalEntityId, principal.legalEntityId),
            ),
          )
          .limit(1)
          .toSQL();
        const harness = yield* makeActionTestHarness({
          access: 'allowed',
          ownerRegistration: financeBillingRegistration,
          preparationReads: [
            {
              execute: ({ params, scope }) => {
                expect(scope).toEqual({ legalEntityId: principal.legalEntityId, tenantId: principal.tenantId });
                expect(params).toEqual(snapshotQuery.params);
                return Effect.succeed([{ revision: 0, state: { financialPlanEntries: [], invoices: [] } }]);
              },
              sql: snapshotQuery.sql,
            },
          ],
          services: [
            bindActionTestServices(applyCommandAction, {
              load: () => Effect.succeed({ revision: 0, state: { financialPlanEntries: [], invoices: [] } }),
              loadDocument: unused,
              loadSearchStateRow: unused,
              loadStateRow: unused,
              prepared: { payload, transition },
              save: (state, revision) =>
                Effect.sync(() => {
                  saved.push(state);
                  return revision + 1;
                }),
              writeDocument: () => Effect.void,
            }),
          ],
        });

        let referenceChecks = 0;
        const validators: FinanceValidators = {
          invoice: (invoice) =>
            Effect.sync(() => {
              expect(invoice.counterpartyRef).toEqual(counterpartyRef);
              expect(harness.snapshot().transactionCount).toBe(1);
              expect(saved).toEqual([]);
              referenceChecks += 1;
            }),
        };
        const result = yield* harness.runtime.runAction(request).pipe(
          Effect.provideService(FinanceReferenceValidators, {
            forScope: (scope) =>
              Effect.sync(() => {
                expect(scope.legalEntityId).toBe(principal.legalEntityId);
                expect(scope.tenantId).toBe(principal.tenantId);
                return validators;
              }),
          }),
        );
        expect(result).toMatchObject({
          changed: true,
          invoice: { businessState: 'DRAFT', documentNumber: 'NATIVE-EXECUTE-001', totalMinor: 420_000 },
          revision: 1,
        });
        const snapshot = harness.snapshot();
        expect(saved).toHaveLength(1);
        expect(saved[0]?.invoices).toHaveLength(1);
        expect(applyCommandAction.descriptor.entrypoint.authorization).toEqual({ kind: 'protected' });
        expect(snapshot.invocations[0]?.principalId).toBe(principal.principalId);
        expect(snapshot.invocations[0]?.status).toBe('succeeded');
        expect(snapshot.transactionCount).toBe(2);
        expect(snapshot.preparationQueries).toHaveLength(1);
        expect(referenceChecks).toBeGreaterThan(0);
        expect(snapshot.committed).toHaveLength(1);
        expect(snapshot.stages).toContain('handler_executed');
      }),
    );

    suite.effect('reports native UUID failure as Finance persistence unavailability without saving the ledger', () =>
      Effect.gen(function* uuidFailure() {
        const crypto = yield* Crypto.Crypto;
        const cause = PlatformError.systemError({ _tag: 'Unknown', method: 'randomUUIDv4', module: 'Crypto' });
        const harness = yield* makeActionTestHarness({
          access: 'allowed',
          ownerRegistration: financeBillingRegistration,
        });
        const failure = yield* harness.runtime.runAction(request).pipe(
          Effect.provideService(FinanceReferenceValidators, {
            forScope: () => Effect.succeed<FinanceValidators>({ invoice: () => Effect.void }),
          }),
          Effect.provideService(Crypto.Crypto, Crypto.Crypto.of({ ...crypto, randomUUIDv4: () => Effect.fail(cause) })),
          Effect.flip,
        );
        expect(Schema.is(FinancePersistenceUnavailable)(failure)).toBe(true);
        expect(failure).toMatchObject({
          code: 'finance_persistence_unavailable',
          reason: 'Finance persistence is temporarily unavailable',
        });
        expect(harness.snapshot().committed).toHaveLength(0);
      }),
    );

    for (const authMethod of ['api_key', 'session'] as const) {
      suite.effect(`native Action denial blocks an authenticated ${authMethod} principal before owner services`, () =>
        Effect.gen(function* nativeDenial() {
          const harness = yield* makeActionTestHarness({
            access: 'denied',
            ownerRegistration: financeBillingRegistration,
          });
          const failure = yield* harness.runtime
            .runAction({ ...request, principal: { ...principal, authMethod } })
            .pipe(Effect.flip);
          const snapshot = harness.snapshot();

          expect(Predicate.isTagged(failure, 'ActionPermissionDenied')).toBe(true);
          expect(snapshot.permissionDenials).toHaveLength(1);
          expect(snapshot.invocations[0]?.status).toBe('rejected');
          expect(snapshot.transactionCount).toBe(0);
          expect(snapshot.committed).toHaveLength(0);
          expect(snapshot.stages).not.toContain('handler_executed');
        }),
      );
    }

    suite.effect('a proposal-only approval profile cannot execute billing commands with an API key', () =>
      Effect.gen(function* approvalProfile() {
        // The actual profile materializer grants propose only, never execute. The harness scripts
        // the native execute denial; this unit test does not evaluate the SpiceDB schema itself.
        expect(profileActionGrants('approval').map(({ relation }) => relation)).toEqual(['proposer_role']);
        const harness = yield* makeActionTestHarness({
          access: 'denied',
          ownerRegistration: financeBillingRegistration,
        });
        const failure = yield* harness.runtime.runAction(request).pipe(Effect.flip);
        const snapshot = harness.snapshot();

        expect(Predicate.isTagged(failure, 'ActionPermissionDenied')).toBe(true);
        expect(snapshot.transactionCount).toBe(0);
        expect(snapshot.committed).toHaveLength(0);
        expect(snapshot.stages).not.toContain('handler_executed');
      }),
    );
  },
);
