import { AgentAppIdSchema } from '@app/shared-contracts/agent-proposals';
import type { AccessDeclarationInput, OntosActionContract, OperationalScope } from '@app/core-runtime';
import { OntosActionContractSchema } from '@app/core-runtime';
import { AccessDecisionGate, makeTestAccessDecision } from '@app/core-runtime/access/enforcement';
import { ActionAuthority } from '@app/core-runtime/actions/runtime-wiring';
import { Effect, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { ActionPermissionCheckError } from '../../../../../packages/core-runtime/src/actions/errors.ts';
import { makeModuleContractFixture } from '../../../../../packages/core-runtime/src/testing/module-contract.ts';
import {
  AgentPlatformInvalid,
  assertAgentProposalsAuthorized,
  callerModuleAccess,
  proposalActionKey,
  subjectModuleAccess,
} from '../../../api/agent-platform/caller.ts';
import type { AgentPlatformCaller } from '../../../api/agent-platform/caller.ts';
import { loadActingAuthority } from '../../../api/oauth-connections/connection-service.ts';
import {
  makeInstalledModuleCatalogLoader,
  ShellInstalledModuleCatalog,
} from '../../../api/modules/installed-module-catalog.ts';
import { makeCompositionSnapshot } from '../../fixtures/application-composition.ts';
import { subjectInspectionFixture } from '../oauth-connections-admin/subject-inspection.fixture.ts';

const moduleId = 'work.tasks';
const appId = AgentAppIdSchema.make('work-tasks');
const legalEntityId = '71000000-0000-4000-8000-000000000020';
const principalId = '72000000-0000-4000-8000-000000000020';
const tenantId = '70000000-0000-4000-8000-000000000020';
/** The caller's own resolved trusted scope; every gate question is asked in a scope derived from it. */
const scope: OperationalScope = {
  authMethod: 'api_key',
  correlationId: 'caller-test',
  legalEntityId,
  principalId,
  tenantId,
};
const caller: AgentPlatformCaller = {
  legalName: 'Test company',
  principal: {
    authMethod: 'api_key',
    legalEntityId,
    principalId,
    tenantId,
  },
  scope,
};

/** An Action authority that answers every Action with one decision, in the scope it was asked in. */
const actionAuthority = (
  answer: (actionKey: string) => { readonly execute: 'allowed' | 'denied'; readonly propose: 'allowed' | 'denied' },
) => ({
  checkActionAuthorities: (input: { readonly actionKeys: readonly string[]; readonly scope: OperationalScope }) =>
    Effect.succeed(input.actionKeys.map((actionKey) => ({ actionKey, ...answer(actionKey) }))),
  checkActionProposalPermission: () => Effect.die('Unexpected single check'),
});

/**
 * A published Action's own capability (O62): a protected Action entrypoint must carry its declaration,
 * so each fixture Action declares one under its owning module. The sequence keeps the keys unique within
 * the module, because a module may not declare the same access key twice.
 */
let actionFixtureSequence = 0;
const action = (
  actionKey: string,
  legalEntityScope: OntosActionContract['legalEntityScope'] = 'required',
  modes: readonly ('propose' | 'run')[] = ['run'],
): OntosActionContract => {
  actionFixtureSequence += 1;
  return Schema.decodeUnknownSync(OntosActionContractSchema)({
    accessDeclaration: {
      key: `${moduleId}.action-${actionFixtureSequence}.run`,
      kind: 'action',
      modes,
      placement: { group: 'actions', level: 'extended' },
      risk: 'routine',
      selectors: [],
    },
    actionKey,
    auditProfile: 'standard',
    entrypoint: {
      access: 'write',
      authorization: { kind: 'action_execution', provisioning: 'tenant_membership_default' },
      entrypointKey: actionKey,
      moduleKey: moduleId,
      role: 'action',
      scope: 'tenant',
    },
    idempotency: 'required',
    legalEntityScope,
    owningModuleId: moduleId,
    schemaVersion: '1',
  });
};

const catalog = (actions: readonly OntosActionContract[] = [action(`${moduleId}.apply-command`)]) =>
  Effect.gen(function* publishedCatalog() {
    const contract = makeModuleContractFixture({ appId, moduleId });
    const snapshot = yield* makeCompositionSnapshot([
      {
        ...contract,
        manifest: {
          ...contract.manifest,
          publicSurface: { ...contract.manifest.publicSurface, actions },
        },
      },
    ]);
    return yield* makeInstalledModuleCatalogLoader(Effect.succeed(snapshot));
  });

it.effect('resolves exact published Action ownership and its generated HTTP spelling', () =>
  Effect.gen(function* exactPublishedOwner() {
    const installed = yield* catalog([action(`${moduleId}.apply-command`), action('unrelated-key.update')]);
    expect(proposalActionKey(installed, appId, 'apply-command')).toBe(`${moduleId}.apply-command`);
    expect(proposalActionKey(installed, appId, 'unrelated-key.update')).toBe('unrelated-key.update');
    expect(proposalActionKey(installed, 'another-app', 'apply-command')).toBeUndefined();
    expect(proposalActionKey(installed, appId, 'missing')).toBeUndefined();
  }),
);

it.effect('rejects ambiguous HTTP slugs and tenant-only Actions in a company proposal', () =>
  Effect.gen(function* unambiguousCompanyAction() {
    const installed = yield* catalog([
      action(`${moduleId}.other.update`),
      action('other.update'),
      action(`${moduleId}.tenant-change`, 'forbidden'),
    ]);
    expect(proposalActionKey(installed, appId, 'other.update')).toBeUndefined();
    expect(proposalActionKey(installed, appId, 'tenant-change')).toBeUndefined();
  }),
);

it.effect('checks every proposal against the exact trusted principal and company without execute authority', () =>
  Effect.gen(function* proposalOnlyAuthority() {
    const installed = yield* catalog([action(`${moduleId}.apply-command`), action(`${moduleId}.rename`)]);
    const checked: string[] = [];
    yield* assertAgentProposalsAuthorized(caller, [{ appId }, { actionSlug: 'rename', appId }]).pipe(
      Effect.provideService(ShellInstalledModuleCatalog, { load: Effect.succeed(installed) }),
      Effect.provideService(ActionAuthority, {
        checkActionAuthorities: () => Effect.die('Unexpected bulk check'),
        checkActionProposalPermission: (target) =>
          Effect.sync(() => {
            // The question runs in the caller's own resolved scope, never a rebuilt scalar identity (O66).
            expect(target.scope).toBe(caller.scope);
            checked.push(target.actionKey);
            return 'allowed' as const;
          }),
      }),
    );
    expect(checked.toSorted()).toEqual([`${moduleId}.apply-command`, `${moduleId}.rename`]);
  }),
);

it.effect('fails unknown Actions before consulting graph authority', () =>
  Effect.gen(function* unknownAction() {
    const installed = yield* catalog();
    const failure = yield* Effect.flip(
      assertAgentProposalsAuthorized(caller, [{ actionSlug: 'missing', appId }]).pipe(
        Effect.provideService(ShellInstalledModuleCatalog, { load: Effect.succeed(installed) }),
        Effect.provideService(ActionAuthority, {
          checkActionAuthorities: () => Effect.die('Unexpected bulk check'),
          checkActionProposalPermission: () => Effect.die('Unexpected graph check'),
        }),
      ),
    );
    expect(failure).toBeInstanceOf(AgentPlatformInvalid);
  }),
);

it.effect('denies revoked proposal rights and distinguishes graph failure from denial', () =>
  Effect.gen(function* proposalFailureClassification() {
    const installed = yield* catalog();
    for (const [decision, tag] of [
      [Effect.succeed('denied' as const), 'AgentPlatformForbidden'],
      [
        Effect.fail(new ActionPermissionCheckError({ code: 'action_permission_check_failed', reason: 'unavailable' })),
        'AgentStoreUnavailable',
      ],
    ] as const) {
      const failure = yield* Effect.flip(
        assertAgentProposalsAuthorized(caller, [{ appId }]).pipe(
          Effect.provideService(ShellInstalledModuleCatalog, { load: Effect.succeed(installed) }),
          Effect.provideService(ActionAuthority, {
            checkActionAuthorities: () => Effect.die('Unexpected bulk check'),
            checkActionProposalPermission: () => decision,
          }),
        ),
      );
      expect(Predicate.isTagged(failure, tag)).toBe(true);
    }
  }),
);

/** The gate answers every declared carrier with one outcome; the visibility hint is its own answer. */
const gateAnswering = (outcome: 'ALLOWED' | 'DENIED') => makeTestAccessDecision({ defaultAnswer: { outcome } });

it.effect('preserves the authenticated requester scope for visibility and exact Action authority', () =>
  Effect.gen(function* originalCallerScope() {
    const installed = yield* catalog();
    const gate = gateAnswering('ALLOWED');
    const authenticatedScope: OperationalScope = {
      ...scope,
      authBindingId: '74000000-0000-4000-8000-000000000040',
      authContextRef: 'better-auth-api-key:original-caller',
      authenticationNamespaceId: 'test.staff.better-auth.v1',
    };
    const actionScopes: OperationalScope[] = [];
    const rights = yield* callerModuleAccess({ scope: authenticatedScope }).pipe(
      Effect.provideService(ShellInstalledModuleCatalog, { load: Effect.succeed(installed) }),
      Effect.provideService(AccessDecisionGate, gate),
      Effect.provideService(ActionAuthority, {
        checkActionAuthorities: (input) => {
          actionScopes.push(input.scope);
          return Effect.succeed(
            input.actionKeys.map((actionKey) => ({
              actionKey,
              execute: 'allowed' as const,
              propose: 'allowed' as const,
            })),
          );
        },
        checkActionProposalPermission: () => Effect.die('Unexpected single check'),
      }),
    );
    expect([...rights.access]).toEqual([moduleId]);
    expect(gate.askedDecisions.length).toBeGreaterThan(0);
    expect(gate.askedDecisions.every((input) => input.scope === authenticatedScope)).toBe(true);
    expect(actionScopes).toHaveLength(1);
    expect(actionScopes[0]).toBe(authenticatedScope);
  }),
);

it.effect(
  'keeps OAuth agents without a credential-bound connection unavailable instead of advertising MCP authority',
  () =>
    Effect.gen(function* unprovisionedMcpConnection() {
      const installed = yield* catalog();
      const inspection = subjectInspectionFixture({
        snapshot: yield* makeCompositionSnapshot(installed.contracts),
        subjects: [{ kind: 'agent', legalEntityId, principalId, tenantId }],
      });
      const failure = yield* loadActingAuthority(scope, {
        actingKind: 'agent',
        actingPrincipalId: caller.principal.principalId,
        legalEntityId: caller.principal.legalEntityId,
        tenantId,
      }).pipe(
        Effect.provideService(ShellInstalledModuleCatalog, { load: Effect.succeed(installed) }),
        Effect.provide(inspection.layer),
        Effect.flip,
      );
      expect(failure).toMatchObject({
        _tag: 'ConnectionUnavailable',
        cause: { _tag: 'SubjectInspectionUnavailable' },
      });
      expect(inspection.requesterScopes).toEqual([]);
    }),
);

it.effect('never treats proposal authority as executable module authority', () =>
  Effect.gen(function* proposalCannotApprove() {
    const installed = yield* catalog();
    const rights = yield* callerModuleAccess(caller).pipe(
      Effect.provideService(ShellInstalledModuleCatalog, { load: Effect.succeed(installed) }),
      Effect.provideService(AccessDecisionGate, gateAnswering('ALLOWED')),
      Effect.provideService(
        ActionAuthority,
        actionAuthority(() => ({ execute: 'denied' as const, propose: 'allowed' as const })),
      ),
    );
    expect([...rights.access]).toEqual([moduleId]);
    expect([...rights.propose]).toEqual([moduleId]);
    expect(rights.write.size).toBe(0);
  }),
);

/** One read page carrier: a module whose only capability is reading stays visible through it. */
const pageDeclaration: AccessDeclarationInput = {
  key: `${moduleId}.page.open`,
  kind: 'read',
  modes: ['run'],
  placement: { group: 'pages', level: 'basic' },
  risk: 'routine',
  selectors: [],
};

const catalogWithPageOnly = (declaration: AccessDeclarationInput = pageDeclaration) =>
  Effect.gen(function* pageOnlyCatalog() {
    const contract = makeModuleContractFixture({ appId, moduleId });
    const snapshot = yield* makeCompositionSnapshot([
      {
        ...contract,
        manifest: {
          ...contract.manifest,
          publicSurface: {
            ...contract.manifest.publicSurface,
            actions: [],
            components: [{ expose: './PageHome', key: `${moduleId}.page-home`, mfBoundaryId: 'verticalworktasks' }],
            shellContributions: {
              ...contract.manifest.publicSurface.shellContributions,
              pages: [
                {
                  accessDeclaration: declaration,
                  componentKey: `${moduleId}.page-home`,
                  contributionKey: `${moduleId}.page.home`,
                  entrypoint: {
                    access: 'read',
                    authorization: { kind: 'protected' },
                    entrypointKey: `${moduleId}.page.home`,
                    moduleKey: moduleId,
                    role: 'page',
                    scope: 'tenant',
                  },
                  expose: './PageHome',
                  routePath: '/work-tasks',
                },
              ],
            },
          },
        },
      },
    ]);
    return yield* makeInstalledModuleCatalogLoader(Effect.succeed(snapshot));
  });

it.effect('keeps a read-only module visible through its own read carrier, with no write or proposal rights', () =>
  Effect.gen(function* readOnlyModuleVisible() {
    const installed = yield* catalogWithPageOnly();
    const rights = yield* callerModuleAccess(caller).pipe(
      Effect.provideService(ShellInstalledModuleCatalog, { load: Effect.succeed(installed) }),
      Effect.provideService(AccessDecisionGate, gateAnswering('ALLOWED')),
      Effect.provideService(
        ActionAuthority,
        actionAuthority(() => ({ execute: 'denied' as const, propose: 'denied' as const })),
      ),
    );
    expect([...rights.access]).toEqual([moduleId]);
    expect(rights.propose.size).toBe(0);
    expect(rights.write.size).toBe(0);
  }),
);

it.effect('uses list admission for a record-scoped read instead of asking without its required target', () =>
  Effect.gen(function* recordScopedModuleVisibility() {
    const installed = yield* catalogWithPageOnly({ ...pageDeclaration, selectors: ['assigned'] });
    const gate = gateAnswering('ALLOWED');
    const rights = yield* callerModuleAccess(caller).pipe(
      Effect.provideService(ShellInstalledModuleCatalog, { load: Effect.succeed(installed) }),
      Effect.provideService(AccessDecisionGate, gate),
      Effect.provideService(
        ActionAuthority,
        actionAuthority(() => ({ execute: 'denied' as const, propose: 'denied' as const })),
      ),
    );
    expect([...rights.access]).toEqual([moduleId]);
    expect(gate.askedLists).toHaveLength(1);
    expect(gate.askedDecisions).toHaveLength(0);
    expect(gate.askedLists[0]?.scope).toBe(scope);
  }),
);

it.effect('sees a module for a principal that holds only v2 grants and no legacy module tuple', () =>
  Effect.gen(function* v2OnlyPrincipal() {
    const installed = yield* catalog();
    const rights = yield* callerModuleAccess(caller).pipe(
      Effect.provideService(ShellInstalledModuleCatalog, { load: Effect.succeed(installed) }),
      // The gate admits the module's own carriers; no legacy `module_access` read is consulted at all.
      Effect.provideService(AccessDecisionGate, gateAnswering('ALLOWED')),
      Effect.provideService(
        ActionAuthority,
        actionAuthority(() => ({ execute: 'allowed' as const, propose: 'allowed' as const })),
      ),
    );
    expect([...rights.access]).toEqual([moduleId]);
    expect([...rights.write]).toEqual([moduleId]);
  }),
);

it.effect('denies a revoked or wrong-tenant acting principal that the gate refuses', () =>
  Effect.gen(function* refusedActorDenied() {
    const installed = yield* catalog();
    const rights = yield* callerModuleAccess(caller).pipe(
      Effect.provideService(ShellInstalledModuleCatalog, { load: Effect.succeed(installed) }),
      Effect.provideService(AccessDecisionGate, gateAnswering('DENIED')),
      Effect.provideService(
        ActionAuthority,
        actionAuthority(() => ({ execute: 'denied' as const, propose: 'denied' as const })),
      ),
    );
    expect(rights.access.size).toBe(0);
    expect(rights.propose.size).toBe(0);
    expect(rights.write.size).toBe(0);
  }),
);

it.effect('inspects candidate list visibility while every Core port retains the original authenticated requester', () =>
  Effect.gen(function* readonlySubjectList() {
    const installed = yield* catalogWithPageOnly({ ...pageDeclaration, selectors: ['assigned'] });
    const actingPrincipalId = '73000000-0000-4000-8000-000000000030';
    const requesterScope: OperationalScope = {
      ...scope,
      authBindingId: '74000000-0000-4000-8000-000000000040',
      authContextRef: 'better-auth-api-key:readonly-requester',
      authenticationNamespaceId: 'test.staff.better-auth.v1',
    };
    const inspection = subjectInspectionFixture({
      capabilities: [{ key: pageDeclaration.key, modes: ['run'], selector: 'assigned' }],
      snapshot: yield* makeCompositionSnapshot(installed.contracts),
      subjects: [{ legalEntityId, principalId: actingPrincipalId, tenantId }],
    });
    const hints = yield* subjectModuleAccess({
      queryScope: { legalEntityId, tenantId },
      requesterScope,
      subject: { principalId: actingPrincipalId, tenantId },
    }).pipe(
      Effect.provideService(ShellInstalledModuleCatalog, { load: Effect.succeed(installed) }),
      Effect.provide(inspection.layer),
    );
    expect(hints.inspectionOnly).toBe(true);
    expect([...hints.access]).toEqual([moduleId]);
    expect(hints.run.size).toBe(0);
    expect(hints.propose.size).toBe(0);
    expect('scope' in hints).toBe(false);
    expect(inspection.requesterScopes.length).toBeGreaterThan(0);
    expect(inspection.requesterScopes.every((observed) => observed === requesterScope)).toBe(true);
    expect(requesterScope.principalId).toBe(principalId);
  }),
);

it.effect('projects current human Action modes without turning the result into execution authority', () =>
  Effect.gen(function* readonlyActionModes() {
    const installed = yield* catalog();
    const declarations = installed.contracts.flatMap(({ manifest }) =>
      manifest.publicSurface.actions.flatMap(({ accessDeclaration }) =>
        accessDeclaration === undefined ? [] : [accessDeclaration],
      ),
    );
    const inspection = subjectInspectionFixture({
      capabilities: declarations.map(({ key }) => ({ key, modes: ['run'] })),
      snapshot: yield* makeCompositionSnapshot(installed.contracts),
      subjects: [{ legalEntityId, principalId, tenantId }],
    });
    const authority = yield* loadActingAuthority(scope, {
      actingKind: 'human',
      actingPrincipalId: principalId,
      legalEntityId,
      tenantId,
    }).pipe(
      Effect.provideService(ShellInstalledModuleCatalog, { load: Effect.succeed(installed) }),
      Effect.provide(inspection.layer),
    );
    expect([...authority.live.read]).toEqual([moduleId]);
    expect([...authority.live.write]).toEqual([moduleId]);
    expect(authority.policyCap).toBe('direct');
    expect(inspection.requesterScopes.every((observed) => observed === scope)).toBe(true);
  }),
);

it.effect('caps the human write ceiling at approval while a module is proposable but not executable', () =>
  Effect.gen(function* proposeOnlyCeiling() {
    // The Action declares both modes; the person holds only the proposal right, so `run` is denied.
    const installed = yield* catalog([action(`${moduleId}.apply-command`, 'required', ['propose', 'run'])]);
    const declarations = installed.contracts.flatMap(({ manifest }) =>
      manifest.publicSurface.actions.flatMap(({ accessDeclaration }) =>
        accessDeclaration === undefined ? [] : [accessDeclaration],
      ),
    );
    const inspection = subjectInspectionFixture({
      capabilities: declarations.map(({ key }) => ({ key, modes: ['propose'] })),
      snapshot: yield* makeCompositionSnapshot(installed.contracts),
      subjects: [{ legalEntityId, principalId, tenantId }],
    });
    const authority = yield* loadActingAuthority(scope, {
      actingKind: 'human',
      actingPrincipalId: principalId,
      legalEntityId,
      tenantId,
    }).pipe(
      Effect.provideService(ShellInstalledModuleCatalog, { load: Effect.succeed(installed) }),
      Effect.provide(inspection.layer),
    );
    // The module stays offered for proposals, but no direct write is possible, so the ceiling is approval.
    expect([...authority.live.write]).toEqual([moduleId]);
    expect(authority.policyCap).toBe('approval');
    expect(authority.offered.map((module) => [module.moduleId, module.write])).toEqual([[moduleId, true]]);
  }),
);

it.effect('denies a foreign-tenant subject without changing the requester tenant', () =>
  Effect.gen(function* foreignSubject() {
    const installed = yield* catalogWithPageOnly();
    const foreignTenant = '70000000-0000-4000-8000-000000000099';
    const inspection = subjectInspectionFixture({
      capabilities: [{ key: pageDeclaration.key, modes: ['run'] }],
      snapshot: yield* makeCompositionSnapshot(installed.contracts),
      subjects: [{ legalEntityId, principalId, tenantId: foreignTenant }],
    });
    const hints = yield* subjectModuleAccess({
      queryScope: { legalEntityId, tenantId },
      requesterScope: scope,
      subject: { principalId, tenantId: foreignTenant },
    }).pipe(
      Effect.provideService(ShellInstalledModuleCatalog, { load: Effect.succeed(installed) }),
      Effect.provide(inspection.layer),
    );
    expect(hints.inspectionOnly).toBe(true);
    expect(hints.access.size).toBe(0);
    expect(hints.run.size).toBe(0);
    expect(hints.propose.size).toBe(0);
    expect(scope.tenantId).toBe(tenantId);
  }),
);
