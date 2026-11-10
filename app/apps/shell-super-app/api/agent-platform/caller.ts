/** Trusted proposal callers and exact graph authority; profile labels never grant access. */
import type { AccessDeclaration, LegalEntityScope, OperationalScope, TrustedPrincipalContext } from '@app/core-runtime';
import {
  AccessDecisionGate,
  SubjectAccessInspection,
  SubjectInspectionUnavailable,
} from '@app/core-runtime/access/enforcement';
import type { SubjectInspectionInput } from '@app/core-runtime/access/enforcement';
import { ActionAuthority } from '@app/core-runtime/actions/runtime-wiring';
import type { AgentProposalSubmitRequest } from '@app/shared-contracts/agent-proposals';
import { Clock, Data, DateTime, Effect, Ref } from 'effect';

import { ShellInstalledModuleCatalog } from '../modules/installed-module-catalog.ts';
import type { ShellInstalledCatalog } from '../modules/installed-module-catalog.ts';
import { shellLegalEntityScope } from '../modules/shell-access-decisions.ts';
import { AgentPlatformInvalid } from './agent-platform-invalid.ts';
import { AgentStoreUnavailable } from './proposal-store.ts';

export { AgentPlatformInvalid } from './agent-platform-invalid.ts';

export interface AgentPlatformCaller {
  readonly legalName: string;
  readonly principal: TrustedPrincipalContext & { readonly legalEntityId: string };
  /**
   * The trusted scope this caller resolved at ingress. Every gate question of this caller runs in it, so the
   * Action-authority seam never rebuilds a scope of its own (O66) and never reads a tenant from a command body.
   */
  readonly scope: OperationalScope;
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
        return permissions.checkActionProposalPermission({ actionKey, scope: caller.scope }).pipe(
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

/** One capability carrier a module publishes: its declaration, the context it is asked in, and its owner. */
export interface ModuleCarrier {
  readonly declaration: AccessDeclaration | undefined;
  readonly legalEntityScope: LegalEntityScope;
  readonly moduleId: string;
}

/**
 * Every capability carrier one module publishes: its Actions and every Shell contribution it offers. A
 * module is visible to a principal exactly when the gate admits one of these — the module's own published
 * declarations, never a legacy `module_access` tuple, so a principal that holds only v2 grants sees its
 * modules and a read-only module stays visible through its read carriers.
 */
export const moduleCarriers = (installed: ShellInstalledCatalog): readonly ModuleCarrier[] => {
  const carriers: ModuleCarrier[] = [];
  for (const contract of installed.contracts) {
    const moduleId = contract.manifest.module.id;
    for (const action of contract.manifest.publicSurface.actions) {
      if (action.legalEntityScope !== 'forbidden' && action.accessDeclaration !== undefined) {
        carriers.push({ declaration: action.accessDeclaration, legalEntityScope: action.legalEntityScope, moduleId });
      }
    }
    const contributions = contract.manifest.publicSurface.shellContributions;
    for (const contribution of [
      ...contributions.navigation,
      ...contributions.pages,
      ...contributions.publicComponents,
      ...contributions.search,
      ...contributions.resourceDetails,
      ...contributions.timelines,
      ...contributions.reports,
      ...contributions.mediaAttachments,
    ]) {
      carriers.push({
        declaration: contribution.accessDeclaration,
        legalEntityScope: shellLegalEntityScope(contribution.accessDeclaration),
        moduleId,
      });
    }
  }
  return carriers;
};

/**
 * The modules a principal may use, and the ones whose Actions it may execute or propose. Visibility is the
 * one gate's answer over the modules' own published carriers (a projection hint, O25); `execute`/`propose`
 * are the same gate's answer over the modules' declared Actions, so the final authority for every Action and
 * read stays the gate's own and no legacy `ContextAccess` engine is consulted (O62, O67-Q5).
 */
export const callerModuleAccess = Effect.fn('AgentPlatform.callerModuleAccess')(
  function* callerModuleAccessEffect(caller: { readonly scope: OperationalScope }) {
    const installed = yield* (yield* ShellInstalledModuleCatalog).load.pipe(
      Effect.mapError((cause) => new AgentStoreUnavailable({ cause })),
    );
    const authority = yield* ActionAuthority;
    const gate = yield* AccessDecisionGate;
    const now = yield* DateTime.nowAsDate;
    const carriers = moduleCarriers(installed);
    const scopeWide: { readonly carrier: ModuleCarrier; readonly index: number }[] = [];
    const recordScoped: { readonly carrier: ModuleCarrier; readonly index: number }[] = [];
    for (const [index, carrier] of carriers.entries()) {
      const target =
        carrier.declaration?.kind === 'read' && carrier.declaration.selectors.length > 0 ? recordScoped : scopeWide;
      target.push({ carrier, index });
    }
    const questionFor = (carrier: ModuleCarrier) => ({
      carrier: { accessDeclaration: carrier.declaration },
      legalEntityScope: carrier.legalEntityScope,
      now,
      scope: caller.scope,
    });
    const batched = yield* gate.decideMany(scopeWide.map(({ carrier }) => questionFor(carrier)));
    if (batched.length !== scopeWide.length) {
      return yield* new AgentStoreUnavailable({ cause: 'Module authorization returned incomplete evidence' });
    }
    // Visibility for a selector-bearing read is a LIST question, not a targetless record decision.
    // The owner still applies the returned predicate when the actual read is dispatched.
    const listed = yield* Effect.forEach(
      recordScoped,
      ({ carrier }) => gate.list(questionFor(carrier)).pipe(Effect.map(({ decision }) => decision)),
      { concurrency: 1 },
    );
    const decisions = new Map<number, (typeof batched)[number]>();
    for (const [position, { index }] of scopeWide.entries()) {
      const decision = batched[position];
      if (decision !== undefined) {
        decisions.set(index, decision);
      }
    }
    for (const [position, { index }] of recordScoped.entries()) {
      const decision = listed[position];
      if (decision !== undefined) {
        decisions.set(index, decision);
      }
    }
    const access = new Set<string>();
    for (const [index, carrier] of carriers.entries()) {
      const decision = decisions.get(index);
      if (decision === undefined || decision.outcome === 'UNAVAILABLE') {
        return yield* new AgentStoreUnavailable({ cause: 'Module authorization is unavailable' });
      }
      if (decision.outcome === 'ALLOWED' || decision.outcome === 'NEEDS_APPROVAL') {
        access.add(carrier.moduleId);
      }
    }
    // A module's Actions are asked without a record: a record-scoped Action is conservatively not counted
    // as a global right, and its record-scoped admission stays the owner read's own gate (O9, O27).
    const actions = installed.contracts.flatMap(({ manifest }) =>
      manifest.publicSurface.actions.filter((action) => action.legalEntityScope !== 'forbidden'),
    );
    const decisionsByAction = yield* authority
      .checkActionAuthorities({
        actionKeys: [...new Set(actions.map(({ actionKey }) => actionKey))],
        scope: caller.scope,
      })
      .pipe(Effect.mapError((cause) => new AgentStoreUnavailable({ cause })));
    const executable = new Set(
      decisionsByAction.flatMap(({ actionKey, execute }) => (execute === 'allowed' ? [actionKey] : [])),
    );
    const proposable = new Set(
      decisionsByAction.flatMap(({ actionKey, propose }) => (propose === 'allowed' ? [actionKey] : [])),
    );
    for (const action of actions) {
      if (executable.has(action.actionKey) || proposable.has(action.actionKey)) {
        access.add(action.owningModuleId);
      }
    }
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

/** The inner steps of one subject read, in the order they run. */
export const SUBJECT_ACCESS_PHASES = ['modules', 'scope', 'capabilities'] as const;
export type SubjectAccessPhase = (typeof SUBJECT_ACCESS_PHASES)[number];

/**
 * Progress of one subject read: the step running now, each finished step's milliseconds and what was asked. Counts
 * and fixed names only, never an identity. Kept in a Ref, so a read that stalls or is cut off still names its step.
 */
export interface SubjectAccessTrace {
  /** Distinct Action keys asked about in the capability batch, each in both modes. */
  readonly actions: number;
  readonly active: SubjectAccessPhase | null;
  /** Module capability carriers asked about in the capability batch. */
  readonly carriers: number;
  readonly durations: Partial<Record<SubjectAccessPhase, number>>;
  /** Calls made to the subject inspection service; each is one composition-checked batch. */
  readonly inspectionCalls: number;
}

export const emptySubjectAccessTrace: SubjectAccessTrace = Object.freeze({
  actions: 0,
  active: null,
  carriers: 0,
  durations: {},
  inspectionCalls: 0,
});

const tracedPhase = Effect.fn('AgentPlatform.subjectAccessPhase')(function* tracedPhase<Value, Failure, Requirements>(
  trace: Ref.Ref<SubjectAccessTrace>,
  phase: SubjectAccessPhase,
  effect: Effect.Effect<Value, Failure, Requirements>,
) {
  yield* Ref.update(trace, (current) => ({ ...current, active: phase }));
  const startedAt = yield* Clock.currentTimeMillis;
  const value = yield* effect;
  const finishedAt = yield* Clock.currentTimeMillis;
  yield* Ref.update(trace, (current) => ({
    ...current,
    active: null,
    durations: { ...current.durations, [phase]: finishedAt - startedAt },
  }));
  return value;
});

const countInspection = (
  trace: Ref.Ref<SubjectAccessTrace>,
  counts: Partial<Pick<SubjectAccessTrace, 'actions' | 'carriers'>>,
) => Ref.update(trace, (current) => ({ ...current, ...counts, inspectionCalls: current.inspectionCalls + 1 }));

/**
 * Read-only connection-ceiling hints. No subject scope, credential or execution authority is returned; the installed
 * catalog is returned only so the caller names the modules from the same load the hints were taken against. Two
 * inspection calls, whatever the catalog size: the subject's scope, then every module carrier and every Action in one
 * batch.
 */
export const subjectModuleAccess = Effect.fn('AgentPlatform.subjectModuleAccess')(function* subjectModuleAccessEffect(
  input: SubjectInspectionInput,
  trace?: Ref.Ref<SubjectAccessTrace>,
) {
  const progress = trace ?? (yield* Ref.make(emptySubjectAccessTrace));
  const inspection = yield* SubjectAccessInspection;
  const installed = yield* tracedPhase(
    progress,
    'modules',
    (yield* ShellInstalledModuleCatalog).load.pipe(Effect.mapError((cause) => new AgentStoreUnavailable({ cause }))),
  );
  yield* countInspection(progress, {});
  const selected = yield* tracedPhase(progress, 'scope', inspection.scope(input));
  const access = new Set<string>();
  const propose = new Set<string>();
  const run = new Set<string>();
  if (selected.decision === 'denied') {
    return { access, inspectionOnly: true as const, installed, propose, run };
  }
  const carriers = moduleCarriers(installed);
  const actions = installed.contracts.flatMap(({ manifest }) =>
    manifest.publicSurface.actions.filter((action) => action.legalEntityScope !== 'forbidden'),
  );
  const actionKeys = [...new Set(actions.map(({ actionKey }) => actionKey))];
  yield* countInspection(progress, { actions: actionKeys.length, carriers: carriers.length });
  const inspected = yield* tracedPhase(
    progress,
    'capabilities',
    inspection.capabilities({
      ...input,
      actionKeys,
      questions: carriers.map((carrier) => ({
        carrier: { accessDeclaration: carrier.declaration },
        legalEntityScope: carrier.legalEntityScope,
        // Visibility for a selector-bearing read is a LIST question, not a targetless record decision.
        listing: carrier.declaration?.kind === 'read' && carrier.declaration.selectors.length > 0,
      })),
    }),
  );
  if (inspected.answers.length !== carriers.length) {
    return yield* new SubjectInspectionUnavailable({ reason: 'Module inspection returned incomplete authority' });
  }
  for (const [index, carrier] of carriers.entries()) {
    const outcome = inspected.answers[index]?.decision.outcome;
    if (outcome === undefined || outcome === 'UNAVAILABLE') {
      return yield* new SubjectInspectionUnavailable({ reason: 'Module inspection returned incomplete authority' });
    }
    if (outcome === 'ALLOWED' || outcome === 'NEEDS_APPROVAL') {
      access.add(carrier.moduleId);
    }
  }
  const byKey = new Map(inspected.authorities.map((authority) => [authority.actionKey, authority]));
  if (byKey.size !== actionKeys.length || actionKeys.some((key) => !byKey.has(key))) {
    return yield* new SubjectInspectionUnavailable({ reason: 'Action inspection returned incomplete authority' });
  }
  for (const action of actions) {
    const authority = byKey.get(action.actionKey);
    if (authority?.run === 'allowed') {
      run.add(action.owningModuleId);
      access.add(action.owningModuleId);
    }
    if (authority?.propose === 'allowed') {
      propose.add(action.owningModuleId);
      access.add(action.owningModuleId);
    }
  }
  return { access, inspectionOnly: true as const, installed, propose, run };
});
