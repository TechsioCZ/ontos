import { Context, Effect, Layer, Predicate } from 'effect';

import { AccessPrincipalKindSource } from '../access/enforcement/actor.ts';
import { AccessDecisionGate } from '../access/enforcement/contract.ts';
import type {
  AccessDecisionService,
  GateInput,
  ListGateInput,
  SelectableLegalEntitiesInput,
} from '../access/enforcement/contract.ts';
import { AccessDecisionLog } from '../access/enforcement/decision-log.ts';
import { AccessDecisionLive } from '../access/enforcement/service.ts';
import { makeAccessAuthorityCurrentness } from '../access/enforcement/currentness.ts';
import { AccessWorkloadBindingSource } from '../access/enforcement/workload-port.ts';
import { AccessIntent } from '../access/decision/authority.ts';
import { LegalEntityCandidates } from '../access/enforcement/legal-entities.ts';
import { makeTestAccessDecision } from '../access/enforcement/testing.ts';
import type { TestAccessDecision, TestAccessDecisionSpec } from '../access/enforcement/testing.ts';
import { accessDecisionUnavailable } from '../access/decision/errors.ts';
import type { AccessDecision } from '../access/decision/contract.ts';
import { DecisionCheck } from '../access/decision/engine.ts';
import type { ListAccessResolution } from '../access/decision/engine.ts';
import { LegalEntityIdSchema } from '../access/ids.ts';
import type { BoundAccessGate, AccessEnforcementPorts } from '../operations/access-gate.ts';
import { bindAccessGate } from '../operations/access-gate.ts';
import type { OperationalScope, OperationalScopeAccess } from '../operations/context.ts';

/** The closed set of answers a suite may script for a protected entrypoint. */
export const TEST_ACCESS_OUTCOMES = ['allowed', 'denied', 'needs_approval', 'unavailable'] as const;
export type TestAccessOutcome = (typeof TEST_ACCESS_OUTCOMES)[number];

const OUTCOME_OF = {
  allowed: 'ALLOWED',
  denied: 'DENIED',
  needs_approval: 'NEEDS_APPROVAL',
  unavailable: 'UNAVAILABLE',
} as const satisfies Readonly<Record<TestAccessOutcome, AccessDecision['outcome']>>;

/** The reason code each scripted outcome carries, in the engine's own vocabulary. */
const REASON_OF = {
  allowed: 'allow.granted',
  denied: 'deny.insufficient_grant',
  needs_approval: 'approval.required',
  unavailable: 'unavailable.intent',
} as const satisfies Readonly<Record<TestAccessOutcome, string>>;

/**
 * Scripted answers for a suite: one outcome for every declaration, or a per-capability-key map. The
 * default is a denial, so a suite that forgets to state its authority never inherits an allow.
 */
export const testAccessSpecOf = (
  access?: TestAccessOutcome | Readonly<Record<string, TestAccessOutcome>>,
): TestAccessDecisionSpec =>
  Predicate.isString(access)
    ? { defaultAnswer: { outcome: OUTCOME_OF[access] } }
    : {
        answers: Object.fromEntries(
          Object.entries(access ?? {}).map(([key, outcome]) => [key, { outcome: OUTCOME_OF[outcome] }]),
        ),
        defaultAnswer: { outcome: 'DENIED' },
      };

/**
 * The enforcement ports a scripted double never reads. They are inert on purpose: a double that
 * reached the intent reader or the check port would not be a double. The runner provides them so the
 * binding is honest, and a real composition provides the live layers instead.
 */
const inertPortAnswer = () => Effect.fail(accessDecisionUnavailable('The scripted gate reads no authority'));

/** The one authority the inert source answers with; it reads nothing, so every answer is the same. */
const inertAuthority = Object.freeze({
  readCells: inertPortAnswer,
  readCompanyOwnership: inertPortAnswer,
  readConnection: inertPortAnswer,
  readScope: inertPortAnswer,
  readTeamIds: inertPortAnswer,
});

export const inertAccessEnforcementPorts = (): AccessEnforcementPorts =>
  Object.freeze({
    candidates: Object.freeze({ listCandidateIds: () => Effect.succeed([]) }),
    check: Object.freeze({ checkBulk: inertPortAnswer }),
    decisionLog: Object.freeze({ record: () => Effect.void }),
    intent: Object.freeze({
      authorityFor: () => inertAuthority,
      // Prepared Action authority joins the caller's transaction (O75). The inert source has no rows to
      // join, so its joined answer is the same inert authority; a binding without it fails closed.
      joined: () => Object.freeze({ authorityFor: () => inertAuthority }),
    }),
    principalKinds: Object.freeze({ readKind: inertPortAnswer }),
    workloadBindings: Object.freeze({
      readActiveWorkloadKeys: inertPortAnswer,
      readCompanyDeclaration: inertPortAnswer,
    }),
  });

/**
 * A scripted gate reads no ports, so its answers hold whichever ports a binding rebinds it to. The
 * binding already keeps such a gate when `rebind` is absent; a prepared Action authority requires the
 * method to exist, so a scripted gate states that identity explicitly instead of leaving it out.
 */
type ScriptedGate = Omit<AccessDecisionService, 'rebind'>;

export const withScriptedRebind = (gate: ScriptedGate): AccessDecisionService =>
  Object.freeze({ ...gate, rebind: () => withScriptedRebind(gate) });

/** A bound gate plus the double's own record of what it was asked, for the runner suites. */
export interface TestBoundAccessGate {
  readonly accessDecision: TestAccessDecision;
  readonly bound: BoundAccessGate;
}

export const makeTestBoundAccessGate = (
  spec: TestAccessDecisionSpec = {},
  ports: AccessEnforcementPorts = inertAccessEnforcementPorts(),
): TestBoundAccessGate => {
  // The scripted double states its own rebind, which a prepared Action authority needs.
  const accessDecision: TestAccessDecision = makeTestAccessDecision(spec);
  return Object.freeze({ accessDecision, bound: bindAccessGate(accessDecision, ports) });
};

/**
 * An owner fixture proving prepared Action execution supplies genuine decision ports, not scripted
 * ALLOWED answers. Joined intent and currentness are mandatory; none is inferred from a grant.
 */
export type CanonicalActionTestAccessPorts = AccessEnforcementPorts & {
  readonly currentness: NonNullable<AccessEnforcementPorts['currentness']>;
  readonly intent: AccessEnforcementPorts['intent'] & {
    readonly joined: NonNullable<AccessEnforcementPorts['intent']['joined']>;
  };
};

/**
 * Public fixture composition of the shipped gate and its persisted-revision preparation contract.
 * The fixture owns its authority/check/currentness sources. This helper creates no authority,
 * invents no snapshot, and never teaches the scripted outcome double to cache an ALLOWED verdict.
 */
export const makeCanonicalActionTestAccessGate = (ports: CanonicalActionTestAccessPorts) =>
  Effect.scoped(
    Effect.gen(function* canonicalActionTestAccessGate() {
      const platform = Context.make(AccessIntent, ports.intent).pipe(
        Context.add(AccessDecisionLog, ports.decisionLog),
        Context.add(AccessPrincipalKindSource, ports.principalKinds),
        Context.add(DecisionCheck, ports.check),
        Context.add(LegalEntityCandidates, ports.candidates),
      );
      const configured =
        ports.workloadBindings === undefined
          ? platform
          : Context.add(platform, AccessWorkloadBindingSource, ports.workloadBindings);
      const context = yield* Layer.build(AccessDecisionLive).pipe(Effect.provideContext(configured));
      return bindAccessGate(Context.get(context, AccessDecisionGate), ports);
    }),
  );

/**
 * Uses the production scoped SQL fence/revision reader over the fixture's real Core executor.
 * The caller supplies explicit persisted rows and ordinary authority/check ports. Missing, Changing
 * or unreadable fence rows fail closed; this constructor supplies no authority or synthetic lease.
 */
export const makePersistedActionTestAccessGate = (input: {
  readonly database: Parameters<typeof makeAccessAuthorityCurrentness>[0];
  readonly ports: Omit<CanonicalActionTestAccessPorts, 'currentness'>;
}) =>
  makeCanonicalActionTestAccessGate({
    ...input.ports,
    currentness: makeAccessAuthorityCurrentness(input.database),
  });

/** The actual production Action binding for native fixture layers, without a testing substitute. */
export { bindLiveActionAccessGate } from '../operations/access-gate.ts';

/** The gate a runner receives when a suite scripts outcomes instead of a full decision spec. */
export const makeScriptedBoundAccessGate = (
  access?: TestAccessOutcome | Readonly<Record<string, TestAccessOutcome>>,
): TestBoundAccessGate => makeTestBoundAccessGate(testAccessSpecOf(access));

const scopeDecisionOf = (outcome: TestAccessOutcome): AccessDecision => ({
  evidence: [],
  outcome: OUTCOME_OF[outcome],
  reasons: [{ code: REASON_OF[outcome] }],
  selectors: [],
});

/**
 * The two scope questions a suite scripts: whether the impersonator still holds the capability, and
 * which companies this person may select (O28). An `unavailable` scope answers both as unavailable.
 */
export const makeTestOperationalScopeAccess = (
  input: {
    readonly decision?: TestAccessOutcome;
    /** The companies this person may select; the default is exactly the one the request selected. */
    readonly legalEntityIds?: (scope: OperationalScope) => readonly string[];
  } = {},
): OperationalScopeAccess => {
  const decision = input.decision ?? 'allowed';
  const legalEntityIds =
    input.legalEntityIds ??
    ((scope: OperationalScope) => (scope.legalEntityId === undefined ? [] : [scope.legalEntityId]));
  return Object.freeze({
    decide: () => Effect.succeed(scopeDecisionOf(decision)),
    selectableLegalEntities: ({ scope }) =>
      decision === 'unavailable'
        ? Effect.fail(accessDecisionUnavailable('The scripted scope authority is unavailable'))
        : Effect.succeed(
            decision === 'allowed'
              ? legalEntityIds(scope).map((legalEntityId) => LegalEntityIdSchema.make(legalEntityId))
              : [],
          ),
  });
};

/** A bound gate that never answers: the composition that forgot to install one (fail closed). */
export const unavailableBoundAccessGate: BoundAccessGate = Object.freeze({
  decide: () => Effect.succeed(scopeDecisionOf('unavailable')),
  list: () => Effect.succeed({ decision: scopeDecisionOf('unavailable') }),
  selectableLegalEntities: () => Effect.succeed([]),
});

/** The services a suite's own access gate provides, in the order a composition resolves them. */
export type TestAccessGateLayers = Layer.Layer<
  | AccessDecisionGate
  | AccessDecisionLog
  | AccessIntent
  | AccessPrincipalKindSource
  | DecisionCheck
  | LegalEntityCandidates
>;

/**
 * The script a suite gives its gate: which principals hold nothing, which hold everything but one
 * capability, which companies are selectable, and any per-declaration answers (C25).
 */
export interface TestAccessGateScript {
  /**
   * Principals who hold no assignment for one capability while still belonging to the tenant and the
   * company: the v2 shape of a person the fixture calls "not permitted" (the company stays
   * selectable, the capability does not).
   */
  readonly capabilityDeniedPrincipalIds?: readonly string[];
  /**
   * Principals who hold nothing at all. A native suite seeds no access intent, so a person the fixture
   * calls "denied" would have no assignment and would select no company either (O28); this names
   * that fact instead of reading a SpiceDB tuple v2 no longer consults.
   */
  readonly deniedPrincipalIds?: readonly string[];
  /**
   * The two scope questions, when a suite scripts them itself (O28). It replaces the scripted
   * answers of `decide` and `selectableLegalEntities` after the principal refusals below; `list` and
   * `decideMany` keep answering from `spec`.
   */
  readonly scopeAccess?: OperationalScopeAccess;
  /**
   * The companies the actor may select (O28). The scope resolver asks the same seam, so a suite whose
   * requests carry a company must name them here; the default echoes exactly the company the request
   * selected, which is what a fixture that creates its own company expects.
   */
  readonly selectableLegalEntityIds?: readonly string[];
  /** Scripted answers per declaration key; anything unnamed falls back to its fail-closed default. */
  readonly spec?: TestAccessDecisionSpec;
  /** Answers every question as an unreadable authority, so a suite can prove the 503 path (O48b). */
  readonly unavailable?: boolean;
}

/**
 * The one access gate as a native suite wires it: the whole enforcement assembly (the seam plus the
 * five ports it decides through) over a scripted decision, so a suite proves its own owner path and
 * never reads authority (CUTOVER-PLAN §3.1 step 8). One factory for every module lane: the copies it
 * replaces differed only in how they scripted "this person holds nothing".
 *
 * The refusals are the three shapes a fixture actually needs, and they stay fail-closed: an
 * unavailable authority answers nothing as allowed, a principal with no assignment is refused and
 * selects no company (O28), and a principal without this capability is refused while its company
 * selection still answers (so the request reaches the owner path the suite is proving).
 */
export const makeTestAccessGateLayers = (options: TestAccessGateScript = {}): TestAccessGateLayers => {
  const ports = inertAccessEnforcementPorts();
  const { capabilityDeniedPrincipalIds, deniedPrincipalIds, scopeAccess, selectableLegalEntityIds, spec } = options;
  const unavailable = options.unavailable === true || spec?.unavailable === true;
  const denied = new Set(deniedPrincipalIds);
  const capabilityDenied = new Set(capabilityDeniedPrincipalIds);
  const scripted = makeTestAccessDecision({ ...spec, unavailable });
  const refusedEveryCapability = (principalId: string): boolean => denied.has(principalId);
  const refusedThisCapability = (principalId: string): boolean =>
    refusedEveryCapability(principalId) || capabilityDenied.has(principalId);

  const decideOf = (input: GateInput): Effect.Effect<AccessDecision> => {
    if (unavailable) {
      return Effect.succeed(scopeDecisionOf('unavailable'));
    }
    if (refusedThisCapability(input.scope.principalId)) {
      return Effect.succeed(scopeDecisionOf('denied'));
    }
    return scopeAccess?.decide(input) ?? scripted.decide(input);
  };

  const listOf = (input: ListGateInput): Effect.Effect<ListAccessResolution> => {
    if (unavailable) {
      return Effect.succeed({ decision: scopeDecisionOf('unavailable') });
    }
    if (refusedThisCapability(input.scope.principalId)) {
      // A refusal carries no owner predicate: it never widens into an unfiltered read (O25).
      return Effect.succeed({ decision: scopeDecisionOf('denied') });
    }
    return scripted.list(input);
  };

  // A scripted gate reads no ports, so it states its rebind: a prepared Action authority needs one to prove currentness.
  const gate = withScriptedRebind({
    decide: decideOf,
    decideMany: (input) => Effect.forEach(input, decideOf, { concurrency: 1 }),
    list: listOf,
    listMany: (input: readonly ListGateInput[]) => Effect.forEach(input, listOf, { concurrency: 1 }),
    selectableLegalEntities: (input: SelectableLegalEntitiesInput) => {
      if (unavailable) {
        // An unreadable authority stays a typed failure, so the caller answers a retryable 503.
        return Effect.fail(accessDecisionUnavailable('The scripted scope authority is unavailable'));
      }
      if (refusedEveryCapability(input.scope.principalId)) {
        // No assignment means no company: the scope resolution itself is refused (O28).
        return Effect.succeed([]);
      }
      if (scopeAccess !== undefined) {
        return scopeAccess.selectableLegalEntities(input);
      }
      if (selectableLegalEntityIds !== undefined) {
        return Effect.succeed(selectableLegalEntityIds.map((legalEntityId) => LegalEntityIdSchema.make(legalEntityId)));
      }
      const { legalEntityId: selected } = input.scope;
      return Effect.succeed(selected === undefined ? [] : [LegalEntityIdSchema.make(selected)]);
    },
  });

  return Layer.mergeAll(
    Layer.succeed(AccessDecisionGate, gate),
    Layer.succeed(AccessIntent, ports.intent),
    Layer.succeed(AccessDecisionLog, ports.decisionLog),
    Layer.succeed(AccessPrincipalKindSource, ports.principalKinds),
    Layer.succeed(DecisionCheck, ports.check),
    Layer.succeed(LegalEntityCandidates, ports.candidates),
  );
};
