import { Effect, Layer, Predicate } from 'effect';
import { HttpServerRequest } from 'effect/unstable/http';
import { expect, it } from 'effect-rstest';
import {
  ActiveApplicationCompositionService,
  ContextAccess,
  agentGrantRelationships,
  ReadRuntime,
} from '@app/core-runtime';
import type { AgentGrantWritePolicy } from '@app/core-runtime';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { GatewayPrincipalVerifierConfiguration } from '@app/gateway-principal-verifier/server';
import type { ApplyCommandPayload } from '../../shared/actions/apply-command.ts';
import type { FinanceState } from '../../shared/apis/records.ts';
import { applyCommandAction } from '../../src/actions/apply-command.action.ts';

const principal = {
  authBindingId: '10000000-0000-4000-8000-000000000001',
  authContextRef: 'api-key:finance-command-test',
  authMethod: 'api_key',
  legalEntityId: '30000000-0000-4000-8000-000000000001',
  principalId: '20000000-0000-4000-8000-000000000001',
  tenantId: '40000000-0000-4000-8000-000000000001',
} as const;
const payload: ApplyCommandPayload = {
  command: {
    _tag: 'CreateInvoiceDraft',
    counterpartyRef: {
      moduleId: 'party.registry',
      resourceId: '50000000-0000-4000-8000-000000000001',
      resourceType: 'party.registry.counterparty',
      tenantId: principal.tenantId,
    },
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

// Owner services are bound below. These production-factory requirements must never be used;
// the real Action runtime has its own authorization and transaction boundaries in the harness.
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

it.layer(unusedProductionServices)('Finance command authorization', (suite) => {
  suite.effect('executes an API-key principal through the real Action when native execute is allowed', () =>
    Effect.gen(function* apiKeyCommand() {
      const saved: FinanceState[] = [];
      expect(profileActionGrants('direct').map(({ relation }) => relation)).toEqual(['role']);
      const harness = yield* makeActionTestHarness({
        actionPermission: 'allowed',
        services: [
          bindActionTestServices(applyCommandAction, {
            load: () => Effect.succeed({ revision: 0, state: { financialPlanEntries: [], invoices: [] } }),
            loadDocument: unused,
            loadStateRow: unused,
            save: (state, revision) =>
              Effect.sync(() => {
                saved.push(state);
                return revision + 1;
              }),
            validators: { invoice: () => Effect.void },
            writeDocument: () => Effect.void,
          }),
        ],
      });

      expect(yield* harness.runtime.runAction(request)).toMatchObject({
        changed: true,
        invoice: { businessState: 'DRAFT', documentNumber: 'NATIVE-EXECUTE-001', totalMinor: 420_000 },
        revision: 1,
      });
      const snapshot = harness.snapshot();
      expect(saved).toHaveLength(1);
      expect(saved[0]?.invoices).toHaveLength(1);
      expect(applyCommandAction.descriptor.entrypoint.authorization).toEqual({
        kind: 'action_execution',
        provisioning: 'explicit',
      });
      expect(snapshot.invocations[0]?.principalId).toBe(principal.principalId);
      expect(snapshot.invocations[0]?.status).toBe('succeeded');
      expect(snapshot.transactionCount).toBe(1);
      expect(snapshot.committed).toHaveLength(1);
      expect(snapshot.stages).toContain('handler_executed');
    }),
  );

  for (const authMethod of ['api_key', 'session'] as const) {
    suite.effect(`native Action denial blocks an authenticated ${authMethod} principal before owner services`, () =>
      Effect.gen(function* nativeDenial() {
        const harness = yield* makeActionTestHarness({ actionPermission: 'denied' });
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
      const harness = yield* makeActionTestHarness({ actionPermission: 'denied' });
      const failure = yield* harness.runtime.runAction(request).pipe(Effect.flip);
      const snapshot = harness.snapshot();

      expect(Predicate.isTagged(failure, 'ActionPermissionDenied')).toBe(true);
      expect(snapshot.transactionCount).toBe(0);
      expect(snapshot.committed).toHaveLength(0);
      expect(snapshot.stages).not.toContain('handler_executed');
    }),
  );
});
