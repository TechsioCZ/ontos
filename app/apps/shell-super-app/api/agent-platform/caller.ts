/** Trusted proposal callers and exact graph authority; profile labels never grant access. */
import { ContextAccess } from '@app/core-runtime';
import { ActionAuthority } from '@app/core-runtime/actions/runtime-wiring';
import type { TrustedPrincipalContext } from '@app/core-runtime';
import type { AgentProposalSubmitRequest } from '@app/shared-contracts/agent-proposals';
import { Data, Effect } from 'effect';

import { ShellInstalledModuleCatalog } from '../modules/installed-module-catalog.ts';
import type { ShellInstalledCatalog } from '../modules/installed-module-catalog.ts';
import { AgentPlatformInvalid } from './agent-platform-invalid.ts';
import { AgentStoreUnavailable } from './proposal-store.ts';

export { AgentPlatformInvalid } from './agent-platform-invalid.ts';

export interface AgentPlatformCaller {
  readonly legalName: string;
  readonly principal: TrustedPrincipalContext & { readonly legalEntityId: string };
}

/** Czech `reason` is returned to the client as the problem detail (HTTP 403). */
export class AgentPlatformForbidden extends Data.TaggedError('AgentPlatformForbidden')<{ readonly reason: string }> {}

/** Resolve a named HTTP Action from its owning published contract, never from an Action-key ownership prefix. */
export const proposalActionKey = (
  installed: ShellInstalledCatalog,
  appId: string,
  actionSlug: string,
): string | undefined => {
  const release = installed.composition.modules.find((module) => module.deployment.appId === appId);
  const contract = installed.getByDeploymentAppId(appId);
  if (release === undefined || contract === undefined) {
    return undefined;
  }
  const matching = contract.manifest.publicSurface.actions.filter((action) => {
    // The Action HTTP generator strips the declared owner's prefix when forming a slug.
    // Ownership itself is the contract's owningModuleId, not this URL spelling rule.
    const prefix = `${action.owningModuleId}.`;
    const slug = action.actionKey.startsWith(prefix) ? action.actionKey.slice(prefix.length) : action.actionKey;
    return action.owningModuleId === release.moduleId && action.legalEntityScope !== 'forbidden' && slug === actionSlug;
  });
  return matching.length === 1 ? matching.at(0)?.actionKey : undefined;
};

/** Check every exact Action before replay lookup, review reads, or persistence, for both API-key and MCP submissions. */
export const assertAgentProposalsAuthorized = Effect.fn('AgentPlatform.assertAgentProposalsAuthorized')(
  function* assertAgentProposalsAuthorizedEffect(
    caller: AgentPlatformCaller,
    proposals: readonly Pick<AgentProposalSubmitRequest['proposals'][number], 'appId' | 'actionSlug'>[],
  ) {
    const installed = yield* (yield* ShellInstalledModuleCatalog).load.pipe(
      Effect.mapError((cause) => new AgentStoreUnavailable({ cause })),
    );
    const permissions = yield* ActionAuthority;
    yield* Effect.forEach(
      proposals,
      (proposal): Effect.Effect<void, AgentPlatformInvalid | AgentPlatformForbidden | AgentStoreUnavailable> => {
        const actionKey = proposalActionKey(installed, proposal.appId, proposal.actionSlug ?? 'apply-command');
        if (actionKey === undefined) {
          return Effect.fail(
            new AgentPlatformInvalid({ reason: 'Návrh neodkazuje na jednoznačnou akci publikovaného modulu.' }),
          );
        }
        return permissions
          .checkActionProposalPermission({
            actionKey,
            legalEntityId: caller.principal.legalEntityId,
            principalId: caller.principal.principalId,
            tenantId: caller.principal.tenantId,
          })
          .pipe(
            Effect.mapError((cause) => new AgentStoreUnavailable({ cause })),
            Effect.flatMap((decision) =>
              decision === 'allowed'
                ? Effect.void
                : Effect.fail(
                    new AgentPlatformForbidden({ reason: 'Agent nemá oprávnění navrhnout tuto změnu v této firmě.' }),
                  ),
            ),
          );
      },
      { concurrency: 2, discard: true },
    );
  },
);

/** Module visibility and the presence of executable Actions come from fully consistent scoped graph checks. */
export const callerModuleAccess = Effect.fn('AgentPlatform.callerModuleAccess')(
  function* callerModuleAccessEffect(caller: {
    readonly principal: Pick<AgentPlatformCaller['principal'], 'legalEntityId' | 'principalId' | 'tenantId'>;
  }) {
    const installed = yield* (yield* ShellInstalledModuleCatalog).load.pipe(
      Effect.mapError((cause) => new AgentStoreUnavailable({ cause })),
    );
    const context = yield* ContextAccess;
    const authority = yield* ActionAuthority;
    const { legalEntityId, principalId, tenantId } = caller.principal;
    const modules = yield* context.modules({
      legalEntityId,
      moduleIds: installed.composition.modules.map(({ moduleId }) => moduleId),
      principalId,
      tenantId,
    });
    if (modules.some(({ decision }) => decision === 'unavailable')) {
      return yield* new AgentStoreUnavailable({ cause: 'Module authorization is unavailable' });
    }
    const access = new Set(modules.flatMap(({ decision, key }) => (decision === 'allowed' ? [key] : [])));
    const actions = installed.contracts.flatMap(({ manifest }) =>
      manifest.publicSurface.actions.flatMap((action) =>
        action.legalEntityScope !== 'forbidden' && access.has(action.owningModuleId) ? [action] : [],
      ),
    );
    const decisions = yield* authority
      .checkActionAuthorities(
        actions.map(({ actionKey }) => ({
          actionKey,
          legalEntityId,
          principalId,
          tenantId,
        })),
      )
      .pipe(Effect.mapError((cause) => new AgentStoreUnavailable({ cause })));
    const executable = new Set(
      decisions.flatMap(({ actionKey, execute }) => (execute === 'allowed' ? [actionKey] : [])),
    );
    const proposable = new Set(
      decisions.flatMap(({ actionKey, propose }) => (propose === 'allowed' ? [actionKey] : [])),
    );
    return {
      access,
      propose: new Set(
        actions.flatMap(({ actionKey, owningModuleId }) => (proposable.has(actionKey) ? [owningModuleId] : [])),
      ),
      write: new Set(
        actions.flatMap(({ actionKey, owningModuleId }) => (executable.has(actionKey) ? [owningModuleId] : [])),
      ),
    };
  },
);
