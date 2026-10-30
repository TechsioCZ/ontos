import { AgentAppIdSchema } from '@app/shared-contracts/agent-proposals';
import { ContextAccess, OntosActionContractSchema } from '@app/core-runtime';
import { ActionAuthority } from '@app/core-runtime/actions/runtime-wiring';
import type { OntosActionContract } from '@app/core-runtime';
import { Effect, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { ActionPermissionCheckError } from '../../../../../packages/core-runtime/src/actions/errors.ts';
import { makeModuleContractFixture } from '../../../../../packages/core-runtime/src/testing/module-contract.ts';
import {
  AgentPlatformInvalid,
  assertAgentProposalsAuthorized,
  callerModuleAccess,
  proposalActionKey,
} from '../../../api/agent-platform/caller.ts';
import type { AgentPlatformCaller } from '../../../api/agent-platform/caller.ts';
import { loadActingAuthority } from '../../../api/oauth-connections/connection-service.ts';
import {
  makeInstalledModuleCatalogLoader,
  ShellInstalledModuleCatalog,
} from '../../../api/modules/installed-module-catalog.ts';
import { makeCompositionSnapshot } from '../../fixtures/application-composition.ts';

const moduleId = 'work.tasks';
const appId = AgentAppIdSchema.make('work-tasks');
const caller: AgentPlatformCaller = {
  legalName: 'Test company',
  principal: {
    authMethod: 'api_key',
    legalEntityId: '71000000-0000-4000-8000-000000000020',
    principalId: '72000000-0000-4000-8000-000000000020',
    tenantId: '70000000-0000-4000-8000-000000000020',
  },
};

const action = (
  actionKey: string,
  legalEntityScope: OntosActionContract['legalEntityScope'] = 'required',
): OntosActionContract =>
  Schema.decodeUnknownSync(OntosActionContractSchema)({
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
            expect(target).toMatchObject({
              legalEntityId: caller.principal.legalEntityId,
              principalId: caller.principal.principalId,
              tenantId: caller.principal.tenantId,
            });
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

it.effect(
  'offers approval-only MCP authority from graph policy without an audit profile or direct principal tuples',
  () =>
    Effect.gen(function* proposalScopedMcpConnection() {
      const installed = yield* catalog();
      const authority = yield* loadActingAuthority({
        actingKind: 'agent',
        actingPrincipalId: caller.principal.principalId,
        legalEntityId: caller.principal.legalEntityId,
        tenantId: caller.principal.tenantId,
      }).pipe(
        Effect.provideService(ShellInstalledModuleCatalog, { load: Effect.succeed(installed) }),
        Effect.provideService(ContextAccess, {
          legalEntities: () => Effect.die('Unexpected company check'),
          modules: ({ moduleIds }) => Effect.succeed(moduleIds.map((key) => ({ decision: 'allowed' as const, key }))),
          resources: () => Effect.die('Unexpected resource check'),
          tenants: () => Effect.die('Unexpected tenant check'),
        }),
        Effect.provideService(ActionAuthority, {
          checkActionAuthorities: (targets) =>
            Effect.succeed(
              targets.map((target) => ({ ...target, execute: 'denied' as const, propose: 'allowed' as const })),
            ),
          checkActionProposalPermission: () => Effect.die('Unexpected single check'),
        }),
      );
      expect(authority.policyCap).toBe('approval');
      expect([...authority.live.read]).toEqual([moduleId]);
      expect([...authority.live.write]).toEqual([moduleId]);
      expect(authority.offered).toEqual([{ label: moduleId, moduleId, read: true, write: true }]);
    }),
);

it.effect('never treats proposal authority as executable module authority', () =>
  Effect.gen(function* proposalCannotApprove() {
    const installed = yield* catalog();
    const rights = yield* callerModuleAccess(caller).pipe(
      Effect.provideService(ShellInstalledModuleCatalog, { load: Effect.succeed(installed) }),
      Effect.provideService(ContextAccess, {
        legalEntities: () => Effect.die('Unexpected company check'),
        modules: ({ moduleIds }) => Effect.succeed(moduleIds.map((key) => ({ decision: 'allowed' as const, key }))),
        resources: () => Effect.die('Unexpected resource check'),
        tenants: () => Effect.die('Unexpected tenant check'),
      }),
      Effect.provideService(ActionAuthority, {
        checkActionAuthorities: (targets) =>
          Effect.succeed(
            targets.map((target) => ({ ...target, execute: 'denied' as const, propose: 'allowed' as const })),
          ),
        checkActionProposalPermission: () => Effect.die('Unexpected single check'),
      }),
    );
    expect([...rights.access]).toEqual([moduleId]);
    expect([...rights.propose]).toEqual([moduleId]);
    expect(rights.write.size).toBe(0);
  }),
);
