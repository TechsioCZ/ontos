// The operator form's expected revision: a save read before someone else's change is refused, never applied.
import { AgentPrincipalIdSchema } from '@app/shared-contracts/agent-proposals';
import { ActionRuntime, ReadRuntime } from '@app/core-runtime';
import type { OperationalScope, ReadRuntimeService } from '@app/core-runtime';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
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
import { administrationProjectionLayer, administrationScopeLayer } from './administration-runtime.fixture.ts';

const principal: ConnectionsCaller['principal'] = {
  authBindingId: '00000000-0000-4000-8000-000000000005',
  authContextRef: 'better-auth-session:directory-test',
  authenticationNamespaceId: STAFF_AUTHENTICATION_NAMESPACE_ID,
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
  people: [{ displayName: 'Jana', principalId: AgentPrincipalIdSchema.make(principal.principalId) }],
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
    const reconciledScopes: OperationalScope[] = [];
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
      administrationScopeLayer(request),
      administrationProjectionLayer(request, reconciled, reconciledScopes),
    );
    return {
      actions,
      directory: yield* CompanyDirectory.pipe(Effect.provide(CompanyDirectoryLive(request).pipe(Layer.provide(layer)))),
      principals,
      reconciled,
      reconciledScopes,
      transports,
    };
  });

it.effect('refuses a save read before another operator change, without an Action', () =>
  Effect.gen(function* staleExpectedRevision() {
    const current = snapshot([], { desiredOperatorPrincipalIds: [], revision: 3 });
    const test = yield* fixture(current);
    const failure = yield* Effect.flip(
      test.directory.replaceOperators({
        agentPrincipalId,
        context: 'operators-edited',
        expectedRevision: 2,
        operatorPrincipalIds: [principal.principalId],
        revokedConnections: 0,
        snapshot: current,
      }),
    );
    expect(Predicate.isTagged(failure, 'ConnectionsGone')).toBe(true);
    expect(test.actions.invocationCount()).toBe(0);
    expect(test.reconciled).toEqual([]);
  }),
);

it.effect('hands the expected revision to the Action, which checks it under its lock', () =>
  Effect.gen(function* currentExpectedRevision() {
    const desired = [principal.principalId];
    const test = yield* fixture(snapshot(desired, { desiredOperatorPrincipalIds: desired, revision: 4 }));
    yield* test.directory.replaceOperators({
      agentPrincipalId,
      context: 'operators-edited',
      expectedRevision: 3,
      operatorPrincipalIds: desired,
      revokedConnections: 0,
      snapshot: snapshot([], { desiredOperatorPrincipalIds: [], revision: 3 }),
    });
    expect(test.actions.payloads).toEqual([
      {
        agentPrincipalId,
        context: 'operators-edited',
        expectedRevision: 3,
        operatorPrincipalIds: desired,
        revokedConnections: 0,
      },
    ]);
  }),
);
