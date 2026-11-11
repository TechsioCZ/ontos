import { AgentAppIdSchema } from '@app/shared-contracts/agent-proposals';
import type { AccessDeclarationInput, OntosActionContract, OperationalScope } from '@app/core-runtime';
import {
  OntosActionContractSchema,
  OntosModuleIdSchema,
  TenantModuleStateReadUnavailableError,
  TenantModuleStateService,
} from '@app/core-runtime';
import {
  AccessDecisionGate,
  makeTestAccessDecision,
  SubjectAccessInspection,
  SubjectInspectionUnavailable,
} from '@app/core-runtime/access/enforcement';
import type { SubjectInspectionStages } from '@app/core-runtime/access/enforcement';
import { ActionAuthority } from '@app/core-runtime/actions/runtime-wiring';
import { Cause, Deferred, Effect, Exit, Fiber, Layer, Predicate, Ref, Result, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';

import { ActionPermissionCheckError } from '../../../../../packages/core-runtime/src/actions/errors.ts';
import { accessDecisionUnavailable } from '../../../../../packages/core-runtime/src/access/decision/errors.ts';
import { makeModuleContractFixture } from '../../../../../packages/core-runtime/src/testing/module-contract.ts';
import {
  AgentPlatformInvalid,
  assertAgentProposalsAuthorized,
  callerModuleAccess,
  emptySubjectAccessTrace,
  moduleCarriers,
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
import { pageCarrierCatalog, subjectInspectionFixture } from '../oauth-connections-admin/subject-inspection.fixture.ts';

const moduleId = 'work.tasks';
const appId = AgentAppIdSchema.make('work-tasks');
const legalEntityId = '71000000-0000-4000-8000-000000000020';
const principalId = '72000000-0000-4000-8000-000000000020';
const tenantId = '70000000-0000-4000-8000-000000000020';
/** The tenant's own module states: the named modules installed and active, by default every module asked about. */
const tenantModuleStates = (installedModuleIds?: readonly string[]) =>
  Layer.mock(TenantModuleStateService, {
    getTenantModuleStates: (_tenantId, moduleKeys) =>
      Effect.succeed(
        moduleKeys
          .filter((moduleKey) => installedModuleIds?.includes(moduleKey) ?? true)
          .map((moduleKey) => ({ moduleKey: OntosModuleIdSchema.make(moduleKey), state: 'active' as const })),
      ),
  });

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
      Effect.provide(tenantModuleStates()),
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
      Effect.provide(tenantModuleStates()),
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
      Effect.provide(tenantModuleStates()),
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

it.effect('counts a module only while the tenant has it installed, whatever the gate answers', () =>
  Effect.gen(function* installedModulesOnly() {
    const installed = yield* catalogWithPageOnly();
    const rightsWith = (installedModuleIds: readonly string[]) =>
      callerModuleAccess(caller).pipe(
        Effect.provideService(ShellInstalledModuleCatalog, { load: Effect.succeed(installed) }),
        Effect.provide(tenantModuleStates(installedModuleIds)),
        Effect.provideService(AccessDecisionGate, gateAnswering('ALLOWED')),
        Effect.provideService(
          ActionAuthority,
          actionAuthority(() => ({ execute: 'allowed' as const, propose: 'allowed' as const })),
        ),
      );
    // A tenant owner is admitted on every administration declaration of the composition; the tenant's own state
    // decides whether the module is there at all.
    const absent = yield* rightsWith([]);
    expect([...absent.access]).toEqual([]);
    expect(absent.propose.size).toBe(0);
    expect(absent.write.size).toBe(0);
    const present = yield* rightsWith([moduleId]);
    expect([...present.access]).toEqual([moduleId]);
  }),
);

it.effect('keeps reading a read-only module but drops its write and proposal rights', () =>
  Effect.gen(function* readOnlyModuleState() {
    const installed = yield* catalog();
    const rights = yield* callerModuleAccess(caller).pipe(
      Effect.provideService(ShellInstalledModuleCatalog, { load: Effect.succeed(installed) }),
      Effect.provide(
        Layer.mock(TenantModuleStateService, {
          getTenantModuleStates: (_tenantId, moduleKeys) =>
            Effect.succeed(
              moduleKeys.map((moduleKey) => ({
                moduleKey: OntosModuleIdSchema.make(moduleKey),
                state: 'read_only' as const,
              })),
            ),
        }),
      ),
      Effect.provideService(AccessDecisionGate, gateAnswering('ALLOWED')),
      Effect.provideService(
        ActionAuthority,
        actionAuthority(() => ({ execute: 'allowed' as const, propose: 'allowed' as const })),
      ),
    );
    expect([...rights.access]).toEqual([moduleId]);
    expect(rights.write.size).toBe(0);
    expect(rights.propose.size).toBe(0);
  }),
);

it.effect('fails closed as unavailable when the tenant module states cannot be read', () =>
  Effect.gen(function* unreadableModuleState() {
    const installed = yield* catalog();
    const failure = yield* callerModuleAccess(caller).pipe(
      Effect.provideService(ShellInstalledModuleCatalog, { load: Effect.succeed(installed) }),
      Effect.provide(
        Layer.mock(TenantModuleStateService, {
          getTenantModuleStates: () =>
            Effect.fail(
              new TenantModuleStateReadUnavailableError({
                code: 'tenant_module_state_read_unavailable',
                reason: 'The module states are unreadable',
              }),
            ),
        }),
      ),
      Effect.provideService(AccessDecisionGate, gateAnswering('ALLOWED')),
      Effect.provideService(
        ActionAuthority,
        actionAuthority(() => ({ execute: 'allowed' as const, propose: 'allowed' as const })),
      ),
      Effect.flip,
    );
    expect(failure._tag).toBe('AgentStoreUnavailable');
  }),
);

it.effect('uses list admission for a record-scoped read instead of asking without its required target', () =>
  Effect.gen(function* recordScopedModuleVisibility() {
    const installed = yield* catalogWithPageOnly({ ...pageDeclaration, selectors: ['assigned'] });
    const gate = gateAnswering('ALLOWED');
    const rights = yield* callerModuleAccess(caller).pipe(
      Effect.provideService(ShellInstalledModuleCatalog, { load: Effect.succeed(installed) }),
      Effect.provide(tenantModuleStates()),
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
      Effect.provide(tenantModuleStates()),
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
      Effect.provide(tenantModuleStates()),
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

/** A module this tenant never installed; the composition still publishes its administration Action. */
const uninstalledModuleId = 'projects.core';

const catalogWithUninstalledAdministration = Effect.gen(function* uninstalledAdministrationCatalog() {
  const tasks = makeModuleContractFixture({ appId, moduleId });
  const projects = makeModuleContractFixture({ appId: 'projects-core', moduleId: uninstalledModuleId });
  const rebuild = Schema.decodeUnknownSync(OntosActionContractSchema)({
    accessDeclaration: {
      key: `${uninstalledModuleId}.search-index.rebuild`,
      kind: 'admin',
      modes: ['run'],
      placement: { group: 'search', level: 'manage' },
      risk: 'sensitive',
      selectors: [],
    },
    actionKey: `${uninstalledModuleId}.request-search-rebuild`,
    auditProfile: 'standard',
    entrypoint: {
      access: 'write',
      authorization: { kind: 'protected' },
      entrypointKey: `${uninstalledModuleId}.request-search-rebuild`,
      moduleKey: uninstalledModuleId,
      role: 'action',
      scope: 'tenant',
    },
    idempotency: 'required',
    legalEntityScope: 'required',
    owningModuleId: uninstalledModuleId,
    schemaVersion: '1',
  });
  const snapshot = yield* makeCompositionSnapshot([
    {
      ...tasks,
      manifest: {
        ...tasks.manifest,
        publicSurface: { ...tasks.manifest.publicSurface, actions: [action(`${moduleId}.apply-command`)] },
      },
    },
    {
      ...projects,
      manifest: { ...projects.manifest, publicSurface: { ...projects.manifest.publicSurface, actions: [rebuild] } },
    },
  ]);
  return { installed: yield* makeInstalledModuleCatalogLoader(Effect.succeed(snapshot)), snapshot };
});

it.effect('offers a tenant owner only the modules its tenant has installed, not every administration carrier', () =>
  Effect.gen(function* ownerOfOneModuleTenant() {
    const { installed, snapshot } = yield* catalogWithUninstalledAdministration;
    const taskKeys = installed.contracts.flatMap(({ manifest }) =>
      manifest.publicSurface.actions.flatMap(({ accessDeclaration, owningModuleId }) =>
        accessDeclaration === undefined || owningModuleId !== moduleId ? [] : [accessDeclaration.key],
      ),
    );
    // The stage verification account owns its own tenant: Core admits an owner on every `admin` declaration of
    // the composition, also of a module the tenant never installed. Its granted cells reach `work.tasks` only.
    const inspection = subjectInspectionFixture({
      capabilities: taskKeys.map((key) => ({ key, modes: ['run', 'propose'] })),
      installedModules: [moduleId],
      owners: [principalId],
      snapshot,
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
    expect(authority.offered.map((module) => [module.moduleId, module.write])).toEqual([[moduleId, true]]);
    expect(authority.policyCap).toBe('direct');
    // One state read for every module the gate answered, so no module escapes the tenant's own installation.
    expect(inspection.stateReads.map((read) => ({ ...read, moduleKeys: read.moduleKeys.toSorted() }))).toEqual([
      { moduleKeys: [uninstalledModuleId, moduleId].toSorted(), tenantId },
    ]);
  }),
);

/** The human's read rights of each carrier's capability, so every carrier is inspected. */
const readableCarriers = (ids: readonly string[]) =>
  ids.map((id) => ({ key: `${id}.page.open`, modes: ['run'] as const }));

/** The subject-only request the connection ceiling makes: the person in their own company. */
const humanRequest = {
  queryScope: { legalEntityId, tenantId },
  requesterScope: scope,
  subject: { principalId, tenantId },
};

it.effect('asks every carrier in one batch and keeps carrier order whatever finishes first', () =>
  Effect.gen(function* batchedCarriers() {
    const ids = ['alpha.pages', 'beta.pages', 'gamma.pages'];
    const { installed, snapshot } = yield* pageCarrierCatalog(ids);
    // Each read yields this many times before it finishes; alpha is first in carrier order and finishes last.
    const turns = new Map([
      ['alpha.pages.page.open', 6],
      ['beta.pages.page.open', 2],
      ['gamma.pages.page.open', 0],
    ]);
    const finished: string[] = [];
    const probe = { active: 0, finished, maxActive: 0 };
    const inspection = subjectInspectionFixture({
      capabilities: readableCarriers(ids),
      onCapabilityRead: (key) =>
        Effect.gen(function* holdCarrierRead() {
          probe.active += 1;
          probe.maxActive = Math.max(probe.maxActive, probe.active);
          yield* Effect.forEach(Array.from({ length: turns.get(key) ?? 0 }), () => Effect.yieldNow, { discard: true });
          probe.active -= 1;
          probe.finished.push(key);
        }),
      snapshot,
      subjects: [{ legalEntityId, principalId, tenantId }],
    });
    const trace = yield* Ref.make(emptySubjectAccessTrace);
    const result = yield* subjectModuleAccess(humanRequest, trace).pipe(
      Effect.provideService(ShellInstalledModuleCatalog, { load: Effect.succeed(installed) }),
      Effect.provide(inspection.layer),
    );
    // The carriers' intent reads overlap inside the one batch, never beyond the engine's own bound of eight.
    expect(probe.maxActive).toBeGreaterThan(1);
    expect(probe.maxActive).toBeLessThanOrEqual(8);
    // Access follows carrier order, not completion order: beta and gamma finished before alpha.
    expect(probe.finished.indexOf('alpha.pages.page.open')).toBeGreaterThan(
      probe.finished.indexOf('beta.pages.page.open'),
    );
    expect([...result.access]).toEqual(ids);
    const traced = yield* Ref.get(trace);
    // The scope, then the carriers and Actions in one batch: two inspection calls, whatever the carrier count.
    expect({ actions: traced.actions, active: traced.active, carriers: traced.carriers }).toEqual({
      actions: 0,
      active: null,
      carriers: 3,
    });
    expect(traced.inspectionCalls).toBe(2);
    expect(Object.keys(traced.durations).toSorted()).toEqual(['capabilities', 'modules', 'scope']);
  }),
);

/** Every scripted port call one subject read makes over `ids` page carriers, one readable. */
const roundTripsFor = (ids: readonly string[]) =>
  Effect.gen(function* roundTrips() {
    const { installed, snapshot } = yield* pageCarrierCatalog(ids);
    const inspection = subjectInspectionFixture({
      capabilities: readableCarriers(ids.slice(0, 1)),
      snapshot,
      subjects: [{ legalEntityId, principalId, tenantId }],
    });
    const result = yield* subjectModuleAccess(humanRequest).pipe(
      Effect.provideService(ShellInstalledModuleCatalog, { load: Effect.succeed(installed) }),
      Effect.provide(inspection.layer),
    );
    return { access: [...result.access], reads: inspection.reads };
  });

it.effect('makes a fixed number of identity, scope, engine and evidence round trips however many carriers exist', () =>
  Effect.gen(function* boundedRoundTrips() {
    const few = yield* roundTripsFor(['alpha.pages', 'beta.pages']);
    const many = yield* roundTripsFor(Array.from({ length: 24 }, (_, index) => `module${index}.pages`));
    expect(few.access).toEqual(['alpha.pages']);
    expect(many.access).toEqual(['module0.pages']);
    const fixed = ({ engine, evidenceWrites, facts, kind, scope: scopeReads }: typeof few.reads) => ({
      engine,
      evidenceWrites,
      facts,
      kind,
      scopeReads,
    });
    // The scope inspection and the one capability batch each resolve the subject once, and the batch asks the engine
    // once and writes its evidence once; only the per-capability intent reads follow the carrier count.
    expect(fixed(many.reads)).toEqual(fixed(few.reads));
    expect(many.reads.evidenceWrites).toBeLessThanOrEqual(1);
    expect(many.reads.engine).toBeLessThanOrEqual(2);
    // Every carrier that is not granted is a denial, and every denial keeps its evidence row.
    expect(many.reads.evidenceRows).toBe(23);
    expect(many.reads.cells).toBe(24);
  }),
);

it.effect('fails the whole carrier load when one carrier cannot be read, returning no partial access', () =>
  Effect.gen(function* oneUnreadableCarrier() {
    const ids = ['alpha.pages', 'beta.pages'];
    const { installed, snapshot } = yield* pageCarrierCatalog(ids);
    const inspection = subjectInspectionFixture({
      capabilities: readableCarriers(ids),
      onCapabilityRead: (key) =>
        key === 'beta.pages.page.open'
          ? Effect.fail(accessDecisionUnavailable('beta carrier unreadable'))
          : Effect.void,
      snapshot,
      subjects: [{ legalEntityId, principalId, tenantId }],
    });
    // The load is an Effect failure: nothing is returned, so the alpha carrier's access is not kept either.
    const failure = yield* subjectModuleAccess(humanRequest).pipe(
      Effect.provideService(ShellInstalledModuleCatalog, { load: Effect.succeed(installed) }),
      Effect.provide(inspection.layer),
      Effect.flip,
    );
    expect(Predicate.isTagged(failure, 'SubjectInspectionUnavailable')).toBe(true);
  }),
);

it.effect('loads the installed-module catalog once per subject read, however many carriers it inspects', () =>
  Effect.gen(function* catalogLoadedOnce() {
    const ids = ['alpha.pages', 'beta.pages', 'gamma.pages'];
    const { installed, snapshot } = yield* pageCarrierCatalog(ids);
    let loads = 0;
    const counted = {
      load: Effect.suspend(() => {
        loads += 1;
        return Effect.succeed(installed);
      }),
    };
    const inspection = subjectInspectionFixture({
      capabilities: readableCarriers(ids),
      snapshot,
      subjects: [{ legalEntityId, principalId, tenantId }],
    });
    const result = yield* subjectModuleAccess(humanRequest).pipe(
      Effect.provideService(ShellInstalledModuleCatalog, counted),
      Effect.provide(inspection.layer),
    );
    expect(loads).toBe(1);
    expect([...result.access]).toEqual(ids);
  }),
);

it.effect(
  'gives a denied subject no access and inspects no carrier or Action, while still loading the catalog once',
  () =>
    Effect.gen(function* deniedSubjectInspected() {
      const ids = ['alpha.pages', 'beta.pages'];
      const { installed, snapshot } = yield* pageCarrierCatalog(ids);
      let capabilityReads = 0;
      let loads = 0;
      const counted = {
        load: Effect.suspend(() => {
          loads += 1;
          return Effect.succeed(installed);
        }),
      };
      // No subject is registered, so the scope decision is denied and no capability is read.
      const inspection = subjectInspectionFixture({
        capabilities: readableCarriers(ids),
        onCapabilityRead: () =>
          Effect.sync(() => {
            capabilityReads += 1;
          }),
        snapshot,
        subjects: [],
      });
      const result = yield* subjectModuleAccess(humanRequest).pipe(
        Effect.provideService(ShellInstalledModuleCatalog, counted),
        Effect.provide(inspection.layer),
      );
      expect(result.access.size).toBe(0);
      expect(result.propose.size).toBe(0);
      expect(result.run.size).toBe(0);
      expect(result.inspectionOnly).toBe(true);
      expect(capabilityReads).toBe(0);
      expect(loads).toBe(1);
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

/** One routine run Action of `owner`, under an access key unique within that module. */
const moduleAction = (
  owner: string,
  actionKey: string,
  owningModuleId = owner,
  legalEntityScope: OntosActionContract['legalEntityScope'] = 'required',
): OntosActionContract => {
  actionFixtureSequence += 1;
  return Schema.decodeUnknownSync(OntosActionContractSchema)({
    accessDeclaration: {
      key: `${owningModuleId}.action-${actionFixtureSequence}.run`,
      kind: 'action',
      modes: ['run'],
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
      moduleKey: owningModuleId,
      role: 'action',
      scope: 'tenant',
    },
    idempotency: 'required',
    legalEntityScope,
    owningModuleId,
    schemaVersion: '1',
  });
};

/** Modules with the given Actions each (no other carrier), and every Action's access key in declaration order. */
const actionModulesCatalog = (modules: Readonly<Record<string, readonly OntosActionContract[]>>) =>
  Effect.gen(function* actionModules() {
    const snapshot = yield* makeCompositionSnapshot(
      Object.entries(modules).map(([id, actions]) => {
        const contract = makeModuleContractFixture({ appId: id.replaceAll('.', '-'), moduleId: id });
        return {
          ...contract,
          manifest: { ...contract.manifest, publicSurface: { ...contract.manifest.publicSurface, actions } },
        };
      }),
    );
    const installed = yield* makeInstalledModuleCatalogLoader(Effect.succeed(snapshot));
    const keyOf = new Map(
      Object.values(modules).flatMap((actions) =>
        actions.flatMap(({ accessDeclaration, actionKey }) =>
          accessDeclaration === undefined ? [] : [[actionKey, accessDeclaration.key] as const],
        ),
      ),
    );
    return { installed, keyOf, snapshot };
  });

/** The hints as they were asked before they stopped at the first admitted question: everything in one batch. */
const everythingAtOnce = Effect.gen(function* askEverything() {
  const inspection = yield* SubjectAccessInspection;
  const installed = yield* (yield* ShellInstalledModuleCatalog).load;
  yield* inspection.scope(humanRequest);
  const carriers = moduleCarriers(installed);
  const actions = installed.contracts.flatMap(({ manifest }) =>
    manifest.publicSurface.actions.filter((entry) => entry.legalEntityScope !== 'forbidden'),
  );
  const inspected = yield* inspection.capabilities({
    ...humanRequest,
    actionKeys: [...new Set(actions.map(({ actionKey }) => actionKey))],
    questions: carriers.map((carrier) => ({
      carrier: { accessDeclaration: carrier.declaration },
      legalEntityScope: carrier.legalEntityScope,
      listing: carrier.declaration?.kind === 'read' && carrier.declaration.selectors.length > 0,
    })),
  });
  const access = new Set<string>();
  const propose = new Set<string>();
  const run = new Set<string>();
  for (const [index, carrier] of carriers.entries()) {
    const outcome = inspected.answers[index]?.decision.outcome;
    if (outcome === 'ALLOWED' || outcome === 'NEEDS_APPROVAL') {
      access.add(carrier.moduleId);
    }
  }
  const byKey = new Map(inspected.authorities.map((authority) => [authority.actionKey, authority]));
  for (const { actionKey, owningModuleId } of actions) {
    const authority = byKey.get(actionKey);
    if (authority?.run === 'unavailable' || authority?.propose === 'unavailable') {
      return yield* new SubjectInspectionUnavailable({ reason: 'reference: unavailable authority' });
    }
    if (authority?.run === 'allowed') {
      run.add(owningModuleId);
      access.add(owningModuleId);
    }
    if (authority?.propose === 'allowed') {
      propose.add(owningModuleId);
      access.add(owningModuleId);
    }
  }
  return { access, propose, run };
});

const sortedHints = (hints: {
  readonly access: ReadonlySet<string>;
  readonly propose: ReadonlySet<string>;
  readonly run: ReadonlySet<string>;
}) => ({
  access: [...hints.access].toSorted(),
  propose: [...hints.propose].toSorted(),
  run: [...hints.run].toSorted(),
});

/** The two-phase hints and the everything-at-once reference over the same inspection: same sets or same failure. */
const bothHints = (
  installed: Effect.Success<ReturnType<typeof makeInstalledModuleCatalogLoader>>,
  inspection: ReturnType<typeof subjectInspectionFixture>,
) =>
  Effect.all([subjectModuleAccess(humanRequest).pipe(Effect.result), everythingAtOnce.pipe(Effect.result)], {
    concurrency: 1,
  }).pipe(
    Effect.provideService(ShellInstalledModuleCatalog, { load: Effect.succeed(installed) }),
    Effect.provide(inspection.layer),
  );

it.effect('fails the hints when the first batch cannot decide a key, although asking it again would succeed', () =>
  Effect.gen(function* firstBatchUnavailable() {
    // alpha's only allowed Action is its first key; beta allows both of its Actions.
    const { installed, keyOf, snapshot } = yield* actionModulesCatalog({
      'alpha.mod': [moduleAction('alpha.mod', 'alpha.mod.first'), moduleAction('alpha.mod', 'alpha.mod.second')],
      'beta.mod': [moduleAction('beta.mod', 'beta.mod.first'), moduleAction('beta.mod', 'beta.mod.second')],
    });
    const flaky = keyOf.get('alpha.mod.first') ?? '';
    let flakyReads = 0;
    const inspection = subjectInspectionFixture({
      capabilities: [flaky, keyOf.get('beta.mod.first') ?? '', keyOf.get('beta.mod.second') ?? ''].map((key) => ({
        key,
        modes: ['run'] as const,
      })),
      // Only the very first read of alpha's first key fails; any later read of it would succeed.
      onCapabilityRead: (key) =>
        Effect.suspend(() => {
          if (key !== flaky) {
            return Effect.void;
          }
          flakyReads += 1;
          return flakyReads === 1 ? Effect.fail(accessDecisionUnavailable('engine unavailable')) : Effect.void;
        }),
      snapshot,
      subjects: [{ legalEntityId, principalId, tenantId }],
    });
    const failure = yield* subjectModuleAccess(humanRequest).pipe(
      Effect.provideService(ShellInstalledModuleCatalog, { load: Effect.succeed(installed) }),
      Effect.provide(inspection.layer),
      Effect.flip,
    );
    // Never a description with alpha silently missing from run: the whole description is unavailable (503).
    expect(Predicate.isTagged(failure, 'SubjectInspectionUnavailable')).toBe(true);
    flakyReads = 0;
    const authority = yield* loadActingAuthority(scope, {
      actingKind: 'human',
      actingPrincipalId: principalId,
      legalEntityId,
      tenantId,
    }).pipe(
      Effect.provideService(ShellInstalledModuleCatalog, { load: Effect.succeed(installed) }),
      Effect.provide(inspection.layer),
      Effect.flip,
    );
    expect(Predicate.isTagged(authority, 'ConnectionUnavailable')).toBe(true);
  }),
);

it.effect('fails the hints, like the reference, when one key among allowed ones cannot be decided', () =>
  Effect.gen(function* oneUnavailableKey() {
    const { installed, keyOf, snapshot } = yield* actionModulesCatalog({
      'alpha.mod': [moduleAction('alpha.mod', 'alpha.mod.first'), moduleAction('alpha.mod', 'alpha.mod.second')],
      'beta.mod': [moduleAction('beta.mod', 'beta.mod.first'), moduleAction('beta.mod', 'beta.mod.second')],
    });
    // Every Action runs; nothing proposes, so every module stays open and its second key is asked too.
    const broken = keyOf.get('beta.mod.second') ?? '';
    const inspection = subjectInspectionFixture({
      capabilities: [...keyOf.values()].map((key) => ({ key, modes: ['run'] as const })),
      onCapabilityRead: (key) =>
        key === broken ? Effect.fail(accessDecisionUnavailable('one key unreadable')) : Effect.void,
      snapshot,
      subjects: [{ legalEntityId, principalId, tenantId }],
    });
    const [hints, reference] = yield* bothHints(installed, inspection);
    expect(Result.isFailure(hints) && Predicate.isTagged(hints.failure, 'SubjectInspectionUnavailable')).toBe(true);
    expect(Result.isFailure(reference) && Predicate.isTagged(reference.failure, 'SubjectInspectionUnavailable')).toBe(
      true,
    );
  }),
);

it.effect('answers an Action key that two modules declare exactly as asking everything does', () =>
  Effect.gen(function* sharedActionKey() {
    // beta's contract repeats alpha's Action (owned by alpha) besides one of its own.
    const shared = moduleAction('alpha.mod', 'alpha.mod.shared');
    const { installed, keyOf, snapshot } = yield* actionModulesCatalog({
      'alpha.mod': [shared],
      'beta.mod': [shared, moduleAction('beta.mod', 'beta.mod.own')],
    });
    const inspection = subjectInspectionFixture({
      capabilities: [{ key: keyOf.get('alpha.mod.shared') ?? '', modes: ['run'] as const }],
      snapshot,
      subjects: [{ legalEntityId, principalId, tenantId }],
    });
    const [hints, reference] = yield* bothHints(installed, inspection);
    expect(Result.isSuccess(hints) && Result.isSuccess(reference)).toBe(true);
    if (Result.isSuccess(hints) && Result.isSuccess(reference)) {
      expect(sortedHints(hints.success)).toEqual(sortedHints(reference.success));
      expect(sortedHints(hints.success).run).toEqual(['alpha.mod']);
    }
  }),
);

/** The same batch answer with one Action's run answer replaced by `unavailable`. */
type BatchAnswer = Effect.Success<ReturnType<(typeof SubjectAccessInspection)['Service']['capabilities']>>;

const withUnavailableRun = (answered: BatchAnswer, actionKey: string): BatchAnswer => ({
  ...answered,
  authorities: answered.authorities.map((authority) =>
    authority.actionKey === actionKey ? { ...authority, run: 'unavailable' as const } : authority,
  ),
});

/** Stages whose first capability batch answers `actionKey` unavailable; `batches` counts the batches asked. */
const unavailableInFirstBatch = (
  stages: SubjectInspectionStages,
  batches: { count: number },
  actionKey: string,
): SubjectInspectionStages => ({
  ...stages,
  capabilities: (asked) =>
    stages.capabilities(asked).pipe(
      Effect.map((answered) => {
        batches.count += 1;
        return batches.count > 1 ? answered : withUnavailableRun(answered, actionKey);
      }),
    ),
});

it.effect('never reads an unavailable first-batch Action answer as denied, even when the next batch would allow', () =>
  Effect.gen(function* unavailableAnswerFailsClosed() {
    const { installed, keyOf, snapshot } = yield* actionModulesCatalog({
      'alpha.mod': [moduleAction('alpha.mod', 'alpha.mod.first'), moduleAction('alpha.mod', 'alpha.mod.second')],
    });
    const inspection = subjectInspectionFixture({
      capabilities: [...keyOf.values()].map((key) => ({ key, modes: ['run'] as const })),
      snapshot,
      subjects: [{ legalEntityId, principalId, tenantId }],
    });
    // The first capability batch answers alpha's first key `unavailable`; a later batch would answer it allowed.
    const batches = { count: 0 };
    const answeringUnavailableOnce = Layer.effect(
      SubjectAccessInspection,
      Effect.gen(function* unavailableOnce() {
        const service = yield* SubjectAccessInspection;
        return {
          ...service,
          staged: (input, body) =>
            service.staged(input, (stages) => body(unavailableInFirstBatch(stages, batches, 'alpha.mod.first'))),
        };
      }),
    ).pipe(Layer.provideMerge(inspection.layer));
    const failure = yield* subjectModuleAccess(humanRequest).pipe(
      Effect.provideService(ShellInstalledModuleCatalog, { load: Effect.succeed(installed) }),
      Effect.provide(answeringUnavailableOnce),
      Effect.flip,
    );
    expect(Predicate.isTagged(failure, 'SubjectInspectionUnavailable')).toBe(true);
    expect(batches.count).toBe(1);
  }),
);

/**
 * The published stages without sharing: `staged` answered by the plain calls, each resolving the subject on its own
 * and writing its evidence before it answers. The reference a staged description must equal.
 */
type InspectionService = (typeof SubjectAccessInspection)['Service'];

/** Stages answered by the plain calls of `service`; only the verified revision comes from the staged inspection. */
const plainStagesOf = (
  service: InspectionService,
  input: Parameters<InspectionService['staged']>[0],
  revision: string,
): SubjectInspectionStages => ({
  capabilities: (asked) => service.capabilities({ ...input, ...asked }),
  prepare: () => Effect.void,
  revision,
  scope: service.scope(input),
});

const plainStages = (inspection: ReturnType<typeof subjectInspectionFixture>) =>
  Layer.effect(
    SubjectAccessInspection,
    Effect.gen(function* plainStagedInspection() {
      const service = yield* SubjectAccessInspection;
      return {
        ...service,
        staged: (input, body) => service.staged(input, ({ revision }) => body(plainStagesOf(service, input, revision))),
      };
    }),
  ).pipe(Layer.provideMerge(inspection.layer));

it.effect('writes the same evidence as the unshared stages when the second batch fails', () =>
  Effect.gen(function* evidenceOfAFailedDescription() {
    // alpha's first Action is refused (a refusal leaves evidence); its second key cannot be read in batch two.
    const { installed, keyOf, snapshot } = yield* actionModulesCatalog({
      'alpha.mod': [moduleAction('alpha.mod', 'alpha.mod.first'), moduleAction('alpha.mod', 'alpha.mod.second')],
    });
    const broken = keyOf.get('alpha.mod.second') ?? '';
    const fixture = () =>
      subjectInspectionFixture({
        capabilities: [{ key: broken, modes: ['run'] as const }],
        onCapabilityRead: (key) =>
          key === broken ? Effect.fail(accessDecisionUnavailable('second key unreadable')) : Effect.void,
        snapshot,
        subjects: [{ legalEntityId, principalId, tenantId }],
      });
    const shared = fixture();
    const unshared = fixture();
    const catalogLoad = { load: Effect.succeed(installed) };
    const failure = yield* subjectModuleAccess(humanRequest).pipe(
      Effect.provideService(ShellInstalledModuleCatalog, catalogLoad),
      Effect.provide(shared.layer),
      Effect.flip,
    );
    const reference = yield* subjectModuleAccess(humanRequest).pipe(
      Effect.provideService(ShellInstalledModuleCatalog, catalogLoad),
      Effect.provide(plainStages(unshared)),
      Effect.flip,
    );
    expect(Predicate.isTagged(failure, 'SubjectInspectionUnavailable')).toBe(true);
    expect(Predicate.isTagged(reference, 'SubjectInspectionUnavailable')).toBe(true);
    // Every row of every decision taken is written, before the hints fail, exactly as the unshared stages write them.
    expect(shared.reads.evidenceRows).toBeGreaterThan(0);
    expect({ rows: shared.reads.evidenceRows, writes: shared.reads.evidenceWrites }).toEqual({
      rows: unshared.reads.evidenceRows,
      writes: unshared.reads.evidenceWrites,
    });
  }),
);

/** Two modules of two Actions each, nobody granted: every asked Action is refused, so both batches leave evidence. */
const refusedTwoBatchCatalog = actionModulesCatalog({
  'alpha.mod': [moduleAction('alpha.mod', 'alpha.mod.first'), moduleAction('alpha.mod', 'alpha.mod.second')],
  'beta.mod': [moduleAction('beta.mod', 'beta.mod.first'), moduleAction('beta.mod', 'beta.mod.second')],
});

/** Moves the test clock 5 ms at a time, letting forked work run in between, until `done` holds (at most 1 s). */
const advanceUntil = (done: () => boolean, step = 0): Effect.Effect<void> =>
  step >= 200 || done()
    ? Effect.void
    : Effect.yieldNow.pipe(
        Effect.andThen(TestClock.adjust('5 millis')),
        Effect.andThen(Effect.suspend(() => advanceUntil(done, step + 1))),
      );

/** Moves the test clock until `fiber` has finished (at most 1 s of test time). */
const advanceUntilDone = (fiber: Fiber.Fiber<unknown, unknown>) => advanceUntil(() => fiber.pollUnsafe() !== undefined);

/** The evidence rows of each write a full description of `refusedTwoBatchCatalog` makes, without any write hook. */
const referenceWrites = Effect.gen(function* referenceWrites() {
  const { installed, snapshot } = yield* refusedTwoBatchCatalog;
  const inspection = subjectInspectionFixture({ snapshot, subjects: [{ legalEntityId, principalId, tenantId }] });
  yield* subjectModuleAccess(humanRequest).pipe(
    Effect.provideService(ShellInstalledModuleCatalog, { load: Effect.succeed(installed) }),
    Effect.provide(inspection.layer),
  );
  return { first: inspection.writtenRows.get(1) ?? -1, second: inspection.writtenRows.get(2) ?? -1 };
});

it.effect('a failed evidence write never cancels the other batch write: every write settles before the failure', () =>
  Effect.gen(function* failedWriteDoesNotCancel() {
    const reference = yield* referenceWrites;
    const { installed, snapshot } = yield* refusedTwoBatchCatalog;
    // Batch one's write fails after 20 ms; batch two's write, already started, needs 60 ms and succeeds.
    const inspection = subjectInspectionFixture({
      onEvidenceWrite: (write) =>
        write === 1
          ? Effect.sleep('20 millis').pipe(Effect.andThen(Effect.fail(accessDecisionUnavailable('write refused'))))
          : Effect.sleep('60 millis'),
      snapshot,
      subjects: [{ legalEntityId, principalId, tenantId }],
    });
    const described = yield* subjectModuleAccess(humanRequest).pipe(
      Effect.provideService(ShellInstalledModuleCatalog, { load: Effect.succeed(installed) }),
      Effect.provide(inspection.layer),
      Effect.flip,
      Effect.forkChild,
    );
    yield* advanceUntilDone(described);
    const failure = yield* Fiber.join(described);
    expect(Predicate.isTagged(failure, 'SubjectInspectionUnavailable')).toBe(true);
    // Batch two's rows were written in full, exactly as an undisturbed description writes them.
    expect(reference.second).toBeGreaterThan(0);
    expect([...inspection.writtenRows]).toEqual([[2, reference.second]]);
  }),
);

it.effect('a request that goes away mid-description still lets every started evidence write settle', () =>
  Effect.gen(function* abortedDescription() {
    const reference = yield* referenceWrites;
    const { installed, snapshot } = yield* refusedTwoBatchCatalog;
    const writesStarted = { count: 0 };
    const inspection = subjectInspectionFixture({
      onEvidenceWrite: () =>
        Effect.sync(() => {
          writesStarted.count += 1;
        }).pipe(Effect.andThen(Effect.sleep('50 millis'))),
      snapshot,
      subjects: [{ legalEntityId, principalId, tenantId }],
    });
    const fiber = yield* subjectModuleAccess(humanRequest).pipe(
      Effect.provideService(ShellInstalledModuleCatalog, { load: Effect.succeed(installed) }),
      Effect.provide(inspection.layer),
      Effect.forkChild,
    );
    // Both batches have run and their writes are in flight when the request is cut off. The interruption waits for
    // the started writes, which settle once their 50 ms have passed.
    yield* advanceUntil(() => inspection.writtenRows.size === 0 && writesStarted.count === 2);
    const interruption = yield* Effect.forkChild(Fiber.interrupt(fiber));
    yield* advanceUntilDone(interruption);
    yield* Fiber.join(interruption);
    // No answer is returned, but every started write committed: both batches' rows are there.
    expect([...inspection.writtenRows]).toEqual([
      [1, reference.first],
      [2, reference.second],
    ]);
  }),
);

it.effect('fails the description when an evidence write outlives its deadline, and never answers without it', () =>
  Effect.gen(function* boundedWrite() {
    const { installed, snapshot } = yield* refusedTwoBatchCatalog;
    // Batch one's write waits a minute (an exhausted pool, say); nothing but its own deadline can end that wait.
    const inspection = subjectInspectionFixture({
      onEvidenceWrite: (write) => (write === 1 ? Effect.sleep('60 seconds') : Effect.void),
      snapshot,
      subjects: [{ legalEntityId, principalId, tenantId }],
    });
    const described = yield* subjectModuleAccess(humanRequest).pipe(
      Effect.provideService(ShellInstalledModuleCatalog, { load: Effect.succeed(installed) }),
      Effect.provide(inspection.layer),
      Effect.flip,
      Effect.forkChild,
    );
    yield* advanceUntil(() => inspection.writtenRows.has(2));
    yield* TestClock.adjust('10 seconds');
    yield* advanceUntilDone(described);
    const answeredByDeadline = described.pollUnsafe() !== undefined;
    // Let a write the deadline did not end finish, so the test never hangs on it.
    yield* TestClock.adjust('60 seconds');
    yield* advanceUntilDone(described);
    expect(answeredByDeadline).toBe(true);
    const failure = yield* Fiber.join(described);
    expect(Predicate.isTagged(failure, 'SubjectInspectionUnavailable')).toBe(true);
    expect(inspection.writtenRows.has(1)).toBe(false);
  }),
);

/** A module with one Action asked in the tenant context and one asked in the company. */
const tenantAndCompanyCatalog = actionModulesCatalog({
  'alpha.mod': [
    moduleAction('alpha.mod', 'alpha.mod.tenant-wide', 'alpha.mod', 'optional'),
    moduleAction('alpha.mod', 'alpha.mod.in-company'),
  ],
});
const otherCompany = '71000000-0000-4000-8000-000000000099';

it.effect(
  'answers a denied scope as denied, with the plain path evidence, although preparing another context failed',
  () =>
    Effect.gen(function* preparedFailureUnderDeniedScope() {
      const { installed, snapshot } = yield* tenantAndCompanyCatalog;
      // The person belongs to another company, so the scope check denies; the tenant context cannot even be read.
      const fixture = () =>
        subjectInspectionFixture({
          onScopeRead: (_principal, company) =>
            company === undefined ? Effect.fail(accessDecisionUnavailable('tenant context unreadable')) : Effect.void,
          snapshot,
          subjects: [{ legalEntityId: otherCompany, principalId, tenantId }],
        });
      const staged = fixture();
      const unshared = fixture();
      const catalogLoad = { load: Effect.succeed(installed) };
      const hints = yield* subjectModuleAccess(humanRequest).pipe(
        Effect.provideService(ShellInstalledModuleCatalog, catalogLoad),
        Effect.provide(staged.layer),
      );
      const reference = yield* subjectModuleAccess(humanRequest).pipe(
        Effect.provideService(ShellInstalledModuleCatalog, catalogLoad),
        Effect.provide(plainStages(unshared)),
      );
      expect(sortedHints(hints)).toEqual({ access: [], propose: [], run: [] });
      expect(sortedHints(hints)).toEqual(sortedHints(reference));
      expect(staged.reads.evidenceRows).toBe(unshared.reads.evidenceRows);
    }),
);

it.effect('a scope check waiting on a shared resolution gets its own answer when the preparing caller fails', () =>
  Effect.gen(function* preparingCallerFails() {
    const { snapshot } = yield* tenantAndCompanyCatalog;
    // The company read is slow; the tenant context fails at once. Preparing starts both before the scope check asks.
    const fixture = subjectInspectionFixture({
      onScopeRead: (_principal, company) =>
        company === undefined
          ? Effect.fail(accessDecisionUnavailable('tenant context unreadable'))
          : Effect.forEach(Array.from({ length: 20 }), () => Effect.yieldNow, { discard: true }),
      snapshot,
      subjects: [{ legalEntityId: otherCompany, principalId, tenantId }],
    });
    const outcome = yield* Effect.gen(function* stagedScope() {
      const inspection = yield* SubjectAccessInspection;
      return yield* inspection.staged(humanRequest, (stages) =>
        Effect.all(
          [
            stages.prepare({ actionKeys: ['alpha.mod.tenant-wide', 'alpha.mod.in-company'], questions: [] }),
            stages.scope,
          ],
          { concurrency: 2 },
        ),
      );
    }).pipe(Effect.provide(fixture.layer), Effect.exit);
    // The scope check answers as alone: the person is not in this company. Never an interruption or a failure.
    expect(Exit.isSuccess(outcome) ? outcome.value[1].decision : Cause.pretty(outcome.cause)).toBe('denied');
  }),
);

it.effect('a waiter on a shared resolution gets a definite answer when the caller that started it is interrupted', () =>
  Effect.gen(function* firstCallerInterrupted() {
    const { snapshot } = yield* tenantAndCompanyCatalog;
    const entered = yield* Deferred.make<boolean>();
    const release = yield* Deferred.make<boolean>();
    const fixture = subjectInspectionFixture({
      // The company read waits until the test releases it.
      onScopeRead: (_principal, company) =>
        company === undefined
          ? Effect.void
          : Deferred.succeed(entered, true).pipe(Effect.andThen(Deferred.await(release)), Effect.asVoid),
      snapshot,
      subjects: [{ legalEntityId, principalId, tenantId }],
    });
    const outcome = yield* Effect.gen(function* twoCallers() {
      const inspection = yield* SubjectAccessInspection;
      return yield* inspection.staged(humanRequest, (stages) =>
        Effect.gen(function* interruptTheFirst() {
          const first = yield* Effect.forkChild(stages.scope);
          yield* Deferred.await(entered);
          const second = yield* Effect.forkChild(stages.scope.pipe(Effect.timeout('1 second'), Effect.exit));
          yield* Fiber.interrupt(first);
          yield* Deferred.succeed(release, true);
          // A hang would end at the timeout, never stall the suite.
          yield* TestClock.adjust('2 seconds');
          return yield* Fiber.join(second);
        }),
      );
    }).pipe(Effect.provide(fixture.layer));
    expect(Exit.isSuccess(outcome) ? outcome.value.decision : Cause.pretty(outcome.cause)).toBe('allowed');
  }),
);

it.effect('refuses hints when a release is published between the installed catalogue and the staged inspection', () =>
  Effect.gen(function* releaseChangedUnderneath() {
    // The caller loaded the installed catalogue of one release; the inspection answers in the next one.
    const { installed } = yield* actionModulesCatalog({ 'alpha.mod': [moduleAction('alpha.mod', 'alpha.mod.first')] });
    const { snapshot: published } = yield* actionModulesCatalog({
      'alpha.mod': [moduleAction('alpha.mod', 'alpha.mod.first'), moduleAction('alpha.mod', 'alpha.mod.second')],
    });
    expect(published.composition.revision).not.toBe(installed.composition.revision);
    const inspection = subjectInspectionFixture({
      snapshot: published,
      subjects: [{ legalEntityId, principalId, tenantId }],
    });
    const failure = yield* subjectModuleAccess(humanRequest).pipe(
      Effect.provideService(ShellInstalledModuleCatalog, { load: Effect.succeed(installed) }),
      Effect.provide(inspection.layer),
      Effect.flip,
    );
    expect(Predicate.isTagged(failure, 'SubjectInspectionUnavailable')).toBe(true);
    // Refused before any question: nothing was decided, so nothing was recorded.
    expect(inspection.reads.evidenceWrites).toBe(0);
  }),
);
