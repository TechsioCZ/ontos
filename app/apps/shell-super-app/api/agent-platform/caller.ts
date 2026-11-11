/** Trusted proposal callers and exact graph authority; profile labels never grant access. */
import type { AccessDeclaration, LegalEntityScope, OperationalScope, TrustedPrincipalContext } from '@app/core-runtime';
import { decideModuleStateAccess, TenantModuleStateService } from '@app/core-runtime';
import {
  AccessDecisionGate,
  SubjectAccessInspection,
  SubjectInspectionUnavailable,
} from '@app/core-runtime/access/enforcement';
import type { SubjectInspectionInput, SubjectInspectionStages } from '@app/core-runtime/access/enforcement';
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

/** The inner steps of one caller authority load, in the order they run. */
export const CALLER_ACCESS_PHASES = ['modules', 'carriers', 'lists', 'actions', 'states'] as const;
export type CallerAccessPhase = (typeof CALLER_ACCESS_PHASES)[number];

/**
 * Progress of one caller authority load: the step running now, each finished step's milliseconds and how much was
 * asked. Counts and fixed names only, never an identity. Kept in a Ref, so a load that stalls still names its step.
 */
export interface CallerAccessTrace {
  /** Distinct Action keys asked about in the one Action batch. */
  readonly actions: number;
  readonly active: CallerAccessPhase | null;
  /** Scope-wide module carriers asked about in the one carrier batch. */
  readonly carriers: number;
  readonly durations: Partial<Record<CallerAccessPhase, number>>;
  /** Gate calls made: one carrier batch, one LIST per record-scoped carrier, one Action batch. */
  readonly gateCalls: number;
  /** Record-scoped read carriers, each a LIST question. */
  readonly lists: number;
}

export const emptyCallerAccessTrace: CallerAccessTrace = Object.freeze({
  actions: 0,
  active: null,
  carriers: 0,
  durations: {},
  gateCalls: 0,
  lists: 0,
});

/** LIST questions in flight at once: the same bound the subject inspection batch uses on the shared pool. */
const LIST_CONCURRENCY = 2;

const callerPhase = Effect.fn('AgentPlatform.callerAccessPhase')(function* callerPhase<Value, Failure, Requirements>(
  trace: Ref.Ref<CallerAccessTrace>,
  phase: CallerAccessPhase,
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

/**
 * The modules a principal may use, and the ones whose Actions it may execute or propose. Visibility is the
 * one gate's answer over the modules' own published carriers (a projection hint, O25); `execute`/`propose`
 * are the same gate's answer over the modules' declared Actions, so the final authority for every Action and
 * read stays the gate's own and no legacy `ContextAccess` engine is consulted (O62, O67-Q5).
 *
 * Every scope-wide carrier is one gate batch and every Action another, each one engine snapshot; a record-scoped
 * read stays its own LIST question. A module counts only while the tenant's own state admits that access, exactly as
 * its entrypoints are gated: the gate answers over the whole composition, and a tenant owner is admitted on every
 * administration declaration, also of a module this tenant never installed.
 */
export const callerModuleAccess = Effect.fn('AgentPlatform.callerModuleAccess')(function* callerModuleAccessEffect(
  caller: { readonly scope: OperationalScope },
  trace?: Ref.Ref<CallerAccessTrace>,
) {
  const progress = trace ?? (yield* Ref.make(emptyCallerAccessTrace));
  const installed = yield* callerPhase(
    progress,
    'modules',
    (yield* ShellInstalledModuleCatalog).load.pipe(Effect.mapError((cause) => new AgentStoreUnavailable({ cause }))),
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
  yield* Ref.update(progress, (current) => ({
    ...current,
    carriers: scopeWide.length,
    gateCalls: current.gateCalls + 1 + recordScoped.length,
    lists: recordScoped.length,
  }));
  const batched = yield* callerPhase(
    progress,
    'carriers',
    gate.decideMany(scopeWide.map(({ carrier }) => questionFor(carrier))),
  );
  if (batched.length !== scopeWide.length) {
    return yield* new AgentStoreUnavailable({ cause: 'Module authorization returned incomplete evidence' });
  }
  // Visibility for a selector-bearing read is a LIST question, not a targetless record decision.
  // The owner still applies the returned predicate when the actual read is dispatched.
  const listed = yield* callerPhase(
    progress,
    'lists',
    Effect.forEach(
      recordScoped,
      ({ carrier }) => gate.list(questionFor(carrier)).pipe(Effect.map(({ decision }) => decision)),
      { concurrency: LIST_CONCURRENCY },
    ),
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
  const visible = new Set<string>();
  for (const [index, carrier] of carriers.entries()) {
    const decision = decisions.get(index);
    if (decision === undefined || decision.outcome === 'UNAVAILABLE') {
      return yield* new AgentStoreUnavailable({ cause: 'Module authorization is unavailable' });
    }
    if (decision.outcome === 'ALLOWED' || decision.outcome === 'NEEDS_APPROVAL') {
      visible.add(carrier.moduleId);
    }
  }
  // A module's Actions are asked without a record: a record-scoped Action is conservatively not counted
  // as a global right, and its record-scoped admission stays the owner read's own gate (O9, O27).
  const actions = installed.contracts.flatMap(({ manifest }) =>
    manifest.publicSurface.actions.filter((action) => action.legalEntityScope !== 'forbidden'),
  );
  const actionKeys = [...new Set(actions.map(({ actionKey }) => actionKey))];
  yield* Ref.update(progress, (current) => ({
    ...current,
    actions: actionKeys.length,
    gateCalls: current.gateCalls + 1,
  }));
  const decisionsByAction = yield* callerPhase(
    progress,
    'actions',
    authority
      .checkActionAuthorities({ actionKeys, scope: caller.scope })
      .pipe(Effect.mapError((cause) => new AgentStoreUnavailable({ cause }))),
  );
  const executable = new Set(
    decisionsByAction.flatMap(({ actionKey, execute }) => (execute === 'allowed' ? [actionKey] : [])),
  );
  const proposable = new Set(
    decisionsByAction.flatMap(({ actionKey, propose }) => (propose === 'allowed' ? [actionKey] : [])),
  );
  for (const action of actions) {
    if (executable.has(action.actionKey) || proposable.has(action.actionKey)) {
      visible.add(action.owningModuleId);
    }
  }
  const proposeAnswered = new Set(
    actions.flatMap(({ actionKey, owningModuleId }) => (proposable.has(actionKey) ? [owningModuleId] : [])),
  );
  const writeAnswered = new Set(
    actions.flatMap(({ actionKey, owningModuleId }) => (executable.has(actionKey) ? [owningModuleId] : [])),
  );
  const states = yield* callerPhase(
    progress,
    'states',
    (yield* TenantModuleStateService)
      .getTenantModuleStates(caller.scope.tenantId, [...visible])
      .pipe(Effect.mapError((cause) => new AgentStoreUnavailable({ cause }))),
  );
  const stateOf = new Map(states.map(({ moduleKey, state }) => [moduleKey, state]));
  const admitted = (modules: ReadonlySet<string>, access: 'read' | 'write'): Set<string> =>
    new Set(
      [...modules].filter((moduleId) => decideModuleStateAccess(stateOf.get(moduleId) ?? null, access) === 'allow'),
    );
  return {
    access: admitted(visible, 'read'),
    propose: admitted(proposeAnswered, 'write'),
    write: admitted(writeAnswered, 'write'),
  };
});

/** The inner steps of one subject read, in the order they run. */
export const SUBJECT_ACCESS_PHASES = ['modules', 'scope', 'capabilities'] as const;
export type SubjectAccessPhase = (typeof SUBJECT_ACCESS_PHASES)[number];

/**
 * Progress of one subject read: the step running now, each finished step's milliseconds and what was asked. Counts
 * and fixed names only, never an identity. Kept in a Ref, so a read that stalls or is cut off still names its step.
 */
export interface SubjectAccessTrace {
  /** Distinct Action keys asked about in the capability batches, each in both modes. */
  readonly actions: number;
  readonly active: SubjectAccessPhase | null;
  /** Module capability carriers asked about in the capability batches. */
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
) =>
  Ref.update(trace, (current) => ({
    ...current,
    actions: current.actions + (counts.actions ?? 0),
    carriers: current.carriers + (counts.carriers ?? 0),
    inspectionCalls: current.inspectionCalls + 1,
  }));

/** One carrier asked as a capability question. Visibility of a selector-bearing read is a LIST question. */
const carrierQuestion = (carrier: ModuleCarrier) => ({
  carrier: { accessDeclaration: carrier.declaration },
  legalEntityScope: carrier.legalEntityScope,
  listing: carrier.declaration?.kind === 'read' && carrier.declaration.selectors.length > 0,
});

/** The scope, then the first Action of every module, then what is still open; the sets fill as answers arrive. */
const askInStages = Effect.fn('AgentPlatform.subjectAccessStages')(function* askInStages(context: {
  readonly access: Set<string>;
  readonly input: SubjectInspectionInput;
  readonly installed: ShellInstalledCatalog;
  readonly progress: Ref.Ref<SubjectAccessTrace>;
  readonly propose: Set<string>;
  readonly run: Set<string>;
  readonly stages: SubjectInspectionStages;
}) {
  const { access, installed, progress, propose, run, stages } = context;
  const carriers = moduleCarriers(installed);
  const actions = installed.contracts.flatMap(({ manifest }) =>
    manifest.publicSurface.actions.filter((action) => action.legalEntityScope !== 'forbidden'),
  );
  yield* countInspection(progress, {});
  // While the scope is inspected, the subject is resolved in every company context the batches may ask in; nothing
  // is decided or recorded there, and preparing never fails: a context that cannot be resolved fails only the batch
  // that asks it, exactly where resolving it in that batch would have failed.
  const [selected] = yield* Effect.all(
    [
      tracedPhase(progress, 'scope', stages.scope),
      stages.prepare({
        actionKeys: [...new Set(actions.map(({ actionKey }) => actionKey))],
        questions: carriers.map(carrierQuestion),
      }),
    ],
    { concurrency: 2 },
  );
  if (selected.decision === 'denied') {
    return 'denied' as const;
  }
  // Every distinct Action key with the modules that own it, and each module's keys in declaration order.
  const ownersOf = new Map<string, Set<string>>();
  const keysOf = new Map<string, string[]>();
  for (const { actionKey, owningModuleId } of actions) {
    const owners = ownersOf.get(actionKey) ?? new Set<string>();
    owners.add(owningModuleId);
    ownersOf.set(actionKey, owners);
    const keys = keysOf.get(owningModuleId) ?? [];
    if (!keys.includes(actionKey)) {
      keys.push(actionKey);
    }
    keysOf.set(owningModuleId, keys);
  }
  const ask = Effect.fn('AgentPlatform.subjectCapabilityBatch')(function* ask(
    actionKeys: readonly string[],
    asked: readonly ModuleCarrier[],
  ) {
    yield* countInspection(progress, { actions: actionKeys.length, carriers: asked.length });
    const inspected = yield* stages.capabilities({
      actionKeys,
      questions: asked.map(carrierQuestion),
    });
    if (inspected.answers.length !== asked.length) {
      return yield* new SubjectInspectionUnavailable({ reason: 'Module inspection returned incomplete authority' });
    }
    for (const [index, carrier] of asked.entries()) {
      const outcome = inspected.answers[index]?.decision.outcome;
      if (outcome === undefined || outcome === 'UNAVAILABLE') {
        return yield* new SubjectInspectionUnavailable({ reason: 'Module inspection returned incomplete authority' });
      }
      if (outcome === 'ALLOWED' || outcome === 'NEEDS_APPROVAL') {
        access.add(carrier.moduleId);
      }
    }
    const byKey = new Map(inspected.authorities.map((authority) => [authority.actionKey, authority]));
    // An unavailable answer is never a denial: a key the hints could not decide fails the whole description, exactly
    // as asking everything at once fails it, instead of leaving its module out of run or propose.
    if (
      byKey.size !== actionKeys.length ||
      actionKeys.some((key) => !byKey.has(key)) ||
      inspected.authorities.some((authority) => authority.propose === 'unavailable' || authority.run === 'unavailable')
    ) {
      return yield* new SubjectInspectionUnavailable({ reason: 'Action inspection returned incomplete authority' });
    }
    for (const [actionKey, authority] of byKey) {
      for (const owner of ownersOf.get(actionKey) ?? []) {
        if (authority.run === 'allowed') {
          run.add(owner);
          access.add(owner);
        }
        if (authority.propose === 'allowed') {
          propose.add(owner);
          access.add(owner);
        }
      }
    }
    return actionKeys.length + asked.length;
  });
  const firstKeys = [...new Set([...keysOf.values()].flatMap((keys) => keys.slice(0, 1)))];
  const settled = (moduleId: string) => run.has(moduleId) && propose.has(moduleId);
  yield* tracedPhase(
    progress,
    'capabilities',
    Effect.gen(function* askOpenQuestions() {
      if (firstKeys.length > 0) {
        yield* ask(firstKeys, []);
      }
      const openKeys = [
        ...new Set([...keysOf].flatMap(([moduleId, keys]) => (settled(moduleId) ? [] : keys.slice(1)))),
      ];
      const openCarriers = carriers.filter(({ moduleId }) => !access.has(moduleId));
      if (openKeys.length === 0 && openCarriers.length === 0) {
        return firstKeys.length > 0 ? 1 : 0;
      }
      yield* ask(openKeys, openCarriers);
      return firstKeys.length > 0 ? 2 : 1;
    }),
  );
  return 'described' as const;
});

/**
 * Read-only connection-ceiling hints. No subject scope, credential or execution authority is returned; the installed
 * catalog is returned only so the caller names the modules from the same load the hints were taken against.
 *
 * A module is usable, writable or proposable as soon as ONE of its carriers or Actions is admitted, so the hints ask
 * only what can still change them: first one Action of every module (both modes), then the remaining Actions of a
 * module whose run or propose answer is still open and the carriers of a module that is not yet usable. The sets are
 * exactly those of asking everything; each asked question is decided and evidenced as alone. At most three inspection
 * calls, whatever the catalog size: the subject's scope and one or two capability batches. Executing an Action never
 * relies on these hints; the gate decides it on its own.
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
  const access = new Set<string>();
  const propose = new Set<string>();
  const run = new Set<string>();
  // The scope and both batches are stages of ONE inspection: one subject resolution per company context and one
  // composition-revision check for the whole description, as when everything was asked in one batch.
  yield* inspection.staged(input, (stages) =>
    askInStages({ access, input, installed, progress, propose, run, stages }),
  );
  return { access, inspectionOnly: true as const, installed, propose, run };
});
