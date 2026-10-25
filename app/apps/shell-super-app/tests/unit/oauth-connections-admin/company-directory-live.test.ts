import { ActionRuntime, ReadRuntime } from '@app/core-runtime';
import type { ReadRuntimeService } from '@app/core-runtime';
import { ActionAuthorizationLifecycle } from '@app/core-runtime/outbox/core-system-worker';
import { Effect, Layer, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeModuleContractFixture } from '../../../../../packages/core-runtime/src/testing/module-contract.ts';
import {
  makeInstalledModuleCatalogLoader,
  ShellInstalledModuleCatalog,
} from '../../../api/modules/installed-module-catalog.ts';
import { CompanyDirectoryLive } from '../../../api/oauth-connections-admin/company-directory-live.ts';
import { CompanyDirectory } from '../../../api/oauth-connections-admin/company-directory.ts';
import type { CompanyDirectoryRequest } from '../../../api/oauth-connections-admin/company-directory.ts';
import type { CompanyDirectorySnapshot, ConnectionsCaller } from '../../../api/oauth-connections-admin/ports.ts';
import { makeCompositionSnapshot } from '../../fixtures/application-composition.ts';
import { actionSuccess, makeActionRuntimeDouble } from '../../support/action-runtime-double.ts';

const principal: ConnectionsCaller['principal'] = {
  authBindingId: '00000000-0000-4000-8000-000000000005',
  authContextRef: 'better-auth-session:directory-test',
  authenticationNamespaceId: 'test.staff.better-auth.v1',
  authMethod: 'session',
  legalEntityId: '00000000-0000-4000-8000-000000000002',
  principalId: '00000000-0000-4000-8000-000000000003',
  tenantId: '00000000-0000-4000-8000-000000000001',
};
const agentPrincipalId = '00000000-0000-4000-8000-000000000004';
const transport = { correlationId: 'directory-command', idempotencyKey: 'request-command' };
const defaultRequest: CompanyDirectoryRequest = { principal, transport };
const snapshot = (
  operators: readonly string[],
  command: { readonly desiredOperatorPrincipalIds: readonly string[]; readonly revision: number } | null = null,
): CompanyDirectorySnapshot => ({
  agents: [
    {
      description: null,
      displayName: 'Agent',
      hasProfile: false,
      modules: [],
      operatorCommand: command,
      operatorPrincipalIds: operators,
      ownerPrincipalId: null,
      principalId: agentPrincipalId,
      status: 'active',
      writePolicy: 'read_only',
    },
  ],
  members: [agentPrincipalId, principal.principalId],
  people: [{ displayName: 'Jana', principalId: principal.principalId }],
});
const fixture = (confirmed: CompanyDirectorySnapshot, request: CompanyDirectoryRequest = defaultRequest) =>
  Effect.gen(function* directoryFixture() {
    const composition = yield* makeCompositionSnapshot([
      makeModuleContractFixture({ appId: 'work-tasks', moduleId: 'work.tasks' }),
    ]);
    const installed = yield* makeInstalledModuleCatalogLoader(Effect.succeed(composition));
    const actions = makeActionRuntimeDouble([actionSuccess({ agentPrincipalId, projection: 'pending', revision: 1 })]);
    const principals: unknown[] = [];
    const transports: unknown[] = [];
    const reconciled: string[] = [];
    const reads: ReadRuntimeService = {
      runRead: (input) => {
        principals.push(input.principal);
        transports.push(input.transport);
        return Schema.decodeUnknownEffect(input.registration.descriptor.resultSchema)(confirmed).pipe(Effect.orDie);
      },
    };
    const layer = Layer.mergeAll(
      Layer.succeed(ReadRuntime, reads),
      Layer.succeed(ActionRuntime, actions.runtime),
      Layer.succeed(ShellInstalledModuleCatalog, { load: Effect.succeed(installed) }),
      Layer.succeed(ActionAuthorizationLifecycle, {
        reconcilePrincipal: (_tenant, agentId) =>
          Effect.sync(() => {
            reconciled.push(agentId);
          }),
        reconcileScopedRoleMembership: () => Effect.die('Unexpected role reconciliation'),
        reconcileTenant: () => Effect.die('Unexpected tenant reconciliation'),
      }),
    );
    return {
      actions,
      directory: yield* CompanyDirectory.pipe(Effect.provide(CompanyDirectoryLive(request).pipe(Layer.provide(layer)))),
      principals,
      reconciled,
      transports,
    };
  });

it.effect('suppresses equal-set commands and audit even when input contains duplicate IDs', () =>
  Effect.gen(function* equalSet() {
    const current = snapshot([principal.principalId]);
    const test = yield* fixture(current);
    yield* test.directory.replaceOperators({
      agentPrincipalId,
      context: 'operators-edited',
      operatorPrincipalIds: [principal.principalId, principal.principalId],
      revokedConnections: 0,
      snapshot: current,
    });
    expect(test.actions.invocationCount()).toBe(0);
    expect(test.reconciled).toEqual([]);
  }),
);

it.effect('resumes a matching pending native command without a second Action', () =>
  Effect.gen(function* pendingCommand() {
    const desired = [principal.principalId];
    const command = { desiredOperatorPrincipalIds: desired, revision: 7 };
    const test = yield* fixture(snapshot(desired, command));
    yield* test.directory.replaceOperators({
      agentPrincipalId,
      context: 'agent-created',
      operatorPrincipalIds: desired,
      revokedConnections: 0,
      snapshot: snapshot([], command),
    });
    expect(test.actions.invocationCount()).toBe(0);
    expect(test.reconciled).toEqual([agentPrincipalId]);
    expect(test.principals[0]).toBe(principal);
    expect(test.transports).toEqual([{ correlationId: transport.correlationId }]);
  }),
);

it.effect('preserves the original authentication carrier through Read and native Action', () =>
  Effect.gen(function* trustedCarrier() {
    const desired = [principal.principalId];
    const test = yield* fixture(snapshot(desired, { desiredOperatorPrincipalIds: desired, revision: 1 }));
    yield* test.directory.replaceOperators({
      agentPrincipalId,
      context: 'operators-edited',
      operatorPrincipalIds: desired,
      revokedConnections: 2,
      snapshot: snapshot([]),
    });
    expect(test.actions.invocationCount()).toBe(1);
    expect(test.actions.principals[0]).toBe(principal);
    expect(test.principals[0]).toBe(principal);
    expect(test.actions.payloads).toEqual([
      {
        agentPrincipalId,
        context: 'operators-edited',
        expectedRevision: 0,
        operatorPrincipalIds: desired,
        revokedConnections: 2,
      },
    ]);
  }),
);

it.effect('does not return success when the committed command has not reached the graph', () =>
  Effect.gen(function* unconfirmedProjection() {
    const desired = [principal.principalId];
    const command = { desiredOperatorPrincipalIds: desired, revision: 1 };
    const test = yield* fixture(snapshot([], command));
    const failure = yield* Effect.flip(
      test.directory.replaceOperators({
        agentPrincipalId,
        context: 'operators-edited',
        operatorPrincipalIds: desired,
        revokedConnections: 0,
        snapshot: snapshot([], command),
      }),
    );
    expect(Predicate.isTagged(failure, 'ConnectionsUnavailable')).toBe(true);
    expect(test.actions.invocationCount()).toBe(0);
    expect(test.reconciled).toEqual([agentPrincipalId]);
  }),
);

it.effect('supersedes a contrary pending command even if the graph already looks equal', () =>
  Effect.gen(function* contraryPending() {
    const desired = [principal.principalId];
    const test = yield* fixture(snapshot(desired, { desiredOperatorPrincipalIds: desired, revision: 3 }));
    yield* test.directory.replaceOperators({
      agentPrincipalId,
      context: 'operators-edited',
      operatorPrincipalIds: desired,
      revokedConnections: 0,
      snapshot: snapshot(desired, { desiredOperatorPrincipalIds: [], revision: 2 }),
    });
    expect(test.actions.invocationCount()).toBe(1);
    expect(test.actions.payloads).toEqual([
      {
        agentPrincipalId,
        context: 'operators-edited',
        expectedRevision: 2,
        operatorPrincipalIds: desired,
        revokedConnections: 0,
      },
    ]);
  }),
);

it.effect('preserves the Schema failure when operator command encoding fails', () =>
  Effect.gen(function* encodingFailureCause() {
    const test = yield* fixture(snapshot([]));
    const failure = yield* Effect.flip(
      test.directory.replaceOperators({
        agentPrincipalId,
        context: 'operators-edited',
        operatorPrincipalIds: [principal.principalId],
        revokedConnections: -1,
        snapshot: snapshot([]),
      }),
    );
    expect(Predicate.isTagged(failure, 'ConnectionsInvalid')).toBe(true);
    if (Predicate.isTagged(failure, 'ConnectionsInvalid')) {
      expect(Predicate.isTagged(failure.cause, 'SchemaError')).toBe(true);
    }
    expect(test.actions.invocationCount()).toBe(0);
    expect(test.reconciled).toEqual([]);
  }),
);

it.effect('uses the tenant-global command revision with the original selected-company carrier', () =>
  Effect.gen(function* tenantGlobalRevision() {
    const selectedPrincipal = { ...principal, legalEntityId: '00000000-0000-4000-8000-000000000006' };
    const desired = [principal.principalId];
    const test = yield* fixture(snapshot(desired, { desiredOperatorPrincipalIds: desired, revision: 42 }), {
      principal: selectedPrincipal,
      transport,
    });
    yield* test.directory.replaceOperators({
      agentPrincipalId,
      context: 'operators-edited',
      operatorPrincipalIds: desired,
      revokedConnections: 0,
      snapshot: snapshot([], { desiredOperatorPrincipalIds: [], revision: 41 }),
    });
    expect(test.actions.payloads).toEqual([
      {
        agentPrincipalId,
        context: 'operators-edited',
        expectedRevision: 41,
        operatorPrincipalIds: desired,
        revokedConnections: 0,
      },
    ]);
    expect(test.actions.principals[0]).toBe(selectedPrincipal);
    expect(test.principals[0]).toBe(selectedPrincipal);
  }),
);

it.effect('keeps request-bound services isolated across selected companies', () =>
  Effect.gen(function* requestIsolation() {
    const otherPrincipal = { ...principal, legalEntityId: '00000000-0000-4000-8000-000000000006' };
    const first = yield* fixture(snapshot([]));
    const second = yield* fixture(snapshot([]), { principal: otherPrincipal, transport });
    yield* second.directory.snapshot();
    yield* first.directory.snapshot();
    expect(first.principals).toEqual([principal]);
    expect(second.principals).toEqual([otherPrincipal]);
    expect(first.principals[0]).toBe(principal);
    expect(second.principals[0]).toBe(otherPrincipal);
  }),
);
