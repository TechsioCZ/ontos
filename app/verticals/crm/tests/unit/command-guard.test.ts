import { Effect, Layer, Predicate } from 'effect';
import { HttpServerRequest } from 'effect/http';
import { expect, it } from 'effect-rstest';
import { ActiveApplicationCompositionService, ContextAccess, agentGrantRelationships } from '@app/core-runtime';
import type { AgentGrantWritePolicy } from '@app/core-runtime';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { GatewayPrincipalVerifierConfiguration } from '@app/gateway-principal-verifier/server';
import type { ApplyCommandPayload } from '../../shared/actions/apply-command.ts';
import { applyCommandAction } from '../../src/actions/apply-command.action.ts';

const principal = {
  authBindingId: '10000000-0000-4000-8000-000000000001',
  authContextRef: 'api-key:crm-command-test',
  authMethod: 'api_key',
  legalEntityId: '30000000-0000-4000-8000-000000000001',
  principalId: '20000000-0000-4000-8000-000000000001',
  tenantId: '40000000-0000-4000-8000-000000000001',
} as const;
const payload: ApplyCommandPayload = {
  command: { _tag: 'UpdateClient', id: 'client-native-grant', patch: { name: 'Native grant client' } },
  expectedRevision: 0,
};
const request = {
  payload,
  principal,
  registration: applyCommandAction,
  transport: { correlationId: 'crm-command-test', idempotencyKey: 'crm-command-once' },
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
);
const profileActionGrants = (writePolicy: AgentGrantWritePolicy) =>
  agentGrantRelationships({
    actions: [applyCommandAction.descriptor],
    legalEntityId: principal.legalEntityId,
    legalEntityWriteRelations: new Map(),
    modules: [{ access: 'write', moduleId: 'demo.crm' }],
    principalId: principal.principalId,
    template: [],
    tenantId: principal.tenantId,
    writePolicy,
  }).filter((relationship) => relationship.resource?.objectType === 'action_grant');

it.effect('executes an API-key principal through the real Action when native execute is allowed', () =>
  Effect.gen(function* apiKeyCommand() {
    const calls: { readonly command: ApplyCommandPayload['command']; readonly invocationId: string }[] = [];
    expect(profileActionGrants('direct').map(({ relation }) => relation)).toEqual(['role']);
    const harness = yield* makeActionTestHarness({
      actionPermission: 'allowed',
      services: [
        bindActionTestServices(applyCommandAction, {
          apply: (command, expectedRevision, invocationId) =>
            Effect.sync(() => {
              calls.push({ command, invocationId });
              return { entityIds: ['client-native-grant'], revision: expectedRevision + 1 };
            }),
          loadAssignmentDirectory: unused,
          loadRecords: unused,
        }),
      ],
    });

    expect(yield* harness.runtime.runAction(request)).toEqual({ entityIds: ['client-native-grant'], revision: 1 });
    const snapshot = harness.snapshot();
    expect(calls).toEqual([{ command: payload.command, invocationId: snapshot.invocations[0]?.actionInvocationId }]);
    expect(applyCommandAction.descriptor.entrypoint.authorization).toEqual({
      kind: 'action_execution',
      provisioning: 'explicit',
    });
    expect(snapshot.invocations[0]?.principalId).toBe(principal.principalId);
    expect(snapshot.invocations[0]?.status).toBe('succeeded');
    expect(snapshot.transactionCount).toBe(1);
    expect(snapshot.committed).toHaveLength(1);
    expect(snapshot.stages).toContain('handler_executed');
  }).pipe(Effect.provide(unusedProductionServices)),
);

for (const authMethod of ['api_key', 'session'] as const) {
  it.effect(`native Action denial blocks an authenticated ${authMethod} principal before owner services`, () =>
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
    }).pipe(Effect.provide(unusedProductionServices)),
  );
}

it.effect('a proposal-only approval profile cannot execute CRM commands with an API key', () =>
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
  }).pipe(Effect.provide(unusedProductionServices)),
);

it.effect.each([
  { _tag: 'CreateClient', kind: 'organization', name: 'Firma' },
  { _tag: 'CreateClient', kind: 'organization', name: 'Firma', ownerSalespersonId: 'target' },
] as const)('fails closed before owner writes for an unverified explicit or actor-default assignment %j', (command) =>
  Effect.gen(function* unavailableAssignment() {
    const harness = yield* makeActionTestHarness({ actionPermission: 'allowed' });
    const failure = yield* harness.runtime
      .runAction({ ...request, payload: { ...payload, command } })
      .pipe(Effect.flip);
    expect(Predicate.isTagged(failure, 'ActionPolicyDenied')).toBe(true);
    expect(harness.snapshot().transactionCount).toBe(0);
    expect(harness.snapshot().stages).not.toContain('handler_executed');
  }).pipe(Effect.provide(unusedProductionServices)),
);
