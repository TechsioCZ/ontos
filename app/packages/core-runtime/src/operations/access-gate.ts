import { Context, Effect, Option } from 'effect';

import { AccessPrincipalKindSource } from '../access/enforcement/actor.ts';
import type { AccessPrincipalKinds, PrincipalKindQuery } from '../access/enforcement/actor.ts';
import { AccessDecisionLog } from '../access/enforcement/decision-log.ts';
import type { AccessDecisionLogEntry, AccessDecisionLogWriter } from '../access/enforcement/decision-log.ts';
import { LegalEntityCandidates } from '../access/enforcement/legal-entities.ts';
import type { AccessLegalEntityCandidates } from '../access/enforcement/legal-entities.ts';
import { AccessWorkloadBindingSource } from '../access/enforcement/workload-port.ts';
import type { AccessWorkloadBindings, WorkloadBindingQuery } from '../access/enforcement/workload-port.ts';
import type {
  AccessDecisionPorts,
  GateInput,
  ListGateInput,
  SelectableLegalEntitiesInput,
} from '../access/enforcement/contract.ts';
import { AccessDecisionGate } from '../access/enforcement/contract.ts';
import { withOptional } from '../access/decision/optional.ts';
import { AccessIntent } from '../access/decision/authority.ts';
import type { AccessIntentSource } from '../access/decision/authority.ts';
import { DecisionCheck } from '../access/decision/engine.ts';
import type { DecisionCheckPort, ListAccessResolution } from '../access/decision/engine.ts';
import type { AccessDecision } from '../access/decision/contract.ts';
import type { AccessDecisionUnavailable } from '../access/decision/errors.ts';
import type { LegalEntityId } from '../access/ids.ts';
import type { CoreTransaction } from '../db/types.ts';
import type { OperationalScope } from './context.ts';

/**
 * The gate as a runtime asks it: the five enforcement ports are bound once, when the runtime is
 * wired, so a request path carries no service requirement of its own. A composition that forgets a
 * port fails where the seam is bound instead of at the first protected request (CUTOVER-PLAN §3.1
 * step 8). Every answer stays the gate's own — ALLOWED, NEEDS_APPROVAL, DENIED or UNAVAILABLE — and
 * nothing here reads the clock or invents a reason.
 */
export interface BoundAccessGate {
  /**
   * The one decision of this request. `transaction` is a transaction the caller already owns (O75):
   * the owner phase of an Action decides inside the transaction its write commits with, so every
   * port read of that decision joins it instead of opening a second connection. A caller without a
   * transaction leaves it out and the decision reads in a transaction of the request scope.
   */
  readonly decide: (input: GateInput, transaction?: CoreTransaction) => Effect.Effect<AccessDecision>;
  /**
   * A list, search or history page: the owner applies the returned predicate in its own query (O25).
   * `transaction` joins a transaction the caller already owns, exactly as for `decide`.
   */
  readonly list: (input: ListGateInput, transaction?: CoreTransaction) => Effect.Effect<ListAccessResolution>;
  /**
   * The companies whose context this actor may select (O28). An unreadable authority stays a typed
   * failure, so the caller answers a retryable 503 and never "none".
   */
  readonly selectableLegalEntities: (
    input: SelectableLegalEntitiesInput,
  ) => Effect.Effect<readonly LegalEntityId[], AccessDecisionUnavailable>;
}

/**
 * The seam's own questions before this composition provides their ports: the shape a deployment's
 * `AccessDecisionLive` and a suite's scripted double both answer.
 */
export interface UnboundAccessGate {
  readonly decide: (input: GateInput) => Effect.Effect<AccessDecision, never, AccessDecisionRequirements>;
  readonly list: (input: ListGateInput) => Effect.Effect<ListAccessResolution, never, AccessDecisionRequirements>;
  /**
   * The same seam over other ports (O75): a binding that joins a caller's transaction rebinds the
   * gate to ports that read through it. A gate that carries no ports of its own leaves it out.
   */
  readonly rebind?: (ports: AccessDecisionPorts) => UnboundAccessGate;
  readonly selectableLegalEntities: (
    input: SelectableLegalEntitiesInput,
  ) => Effect.Effect<readonly LegalEntityId[], AccessDecisionUnavailable, AccessDecisionRequirements>;
}

/** The ports the seam reads through context; named so a composition cannot forget one. */
export type AccessDecisionRequirements =
  | AccessIntent
  | AccessDecisionLog
  | AccessPrincipalKindSource
  | DecisionCheck
  | LegalEntityCandidates;

/** The ports one composition binds; naming them keeps a missing port a type error, not a 500. */
export interface AccessEnforcementPorts {
  readonly candidates: AccessLegalEntityCandidates;
  readonly check: DecisionCheckPort;
  readonly decisionLog: AccessDecisionLogWriter;
  /**
   * The intent source, not a resolved authority: the gate asks it for one port per request scope
   * (O66), which is exactly what the seam's service reads.
   */
  readonly intent: AccessIntentSource;
  readonly principalKinds: AccessPrincipalKinds;
  /**
   * The registered workload identities of the acting principal (O73). Optional so a composition that
   * only ever decides human or agent requests stays valid; the seam then admits no workload.
   */
  readonly workloadBindings?: AccessWorkloadBindings;
}

/** The ports resolved from a composition's own layers, in the order a failure should name them. */
export const AccessEnforcementPortsLive = Effect.gen(function* resolveAccessEnforcementPorts() {
  const [intent, candidates, check, decisionLog, principalKinds] = yield* Effect.all(
    [AccessIntent, LegalEntityCandidates, DecisionCheck, AccessDecisionLog, AccessPrincipalKindSource] as const,
    { concurrency: 5 },
  );
  // The registry is optional: a composition that binds none admits no workload and fails closed (O73).
  const workloadBindings = yield* Effect.serviceOption(AccessWorkloadBindingSource);
  return Object.freeze(
    withOptional(
      { candidates, check, decisionLog, intent, principalKinds },
      'workloadBindings',
      Option.getOrUndefined(workloadBindings),
    ),
  );
});

/**
 * The same ports, over a transaction a caller already owns (O75). Every read that can join does:
 * the intent loader is rebuilt over the transaction through its own `callerTransactions` factory, and
 * the actor, evidence and company ports are asked with that transaction, so an owner-phase decision
 * is proved from the rows, cells and memberships the transaction its write commits with sees. The
 * engine port is a transport, not a database read, so it is passed through unchanged.
 *
 * This is a derivation, never a detection: the transaction is the caller's explicit argument, and a
 * joined read keeps the caller's own snapshot instead of claiming one it did not open. A caller
 * without a transaction keeps the request source, whose reads open their own REPEATABLE READ
 * transaction per call.
 */
export const joinAccessEnforcementPorts = (
  ports: AccessEnforcementPorts,
  transaction: CoreTransaction,
): AccessEnforcementPorts => {
  const { workloadBindings } = ports;
  const joined = {
    candidates: Object.freeze({
      listCandidateIds: (scope: OperationalScope) => ports.candidates.listCandidateIds(scope, transaction),
    }),
    check: ports.check,
    decisionLog: Object.freeze({
      record: (entry: AccessDecisionLogEntry) => ports.decisionLog.record(entry, transaction),
    }),
    // The intent source joins through its own factory: a composition whose loader can join answers
    // over the transaction, and one whose loader cannot keeps the request source it already has.
    intent: ports.intent.joined?.(transaction) ?? ports.intent,
    principalKinds: Object.freeze({
      readKind: (query: PrincipalKindQuery) => ports.principalKinds.readKind(query, transaction),
    }),
  };
  return Object.freeze(
    workloadBindings === undefined
      ? joined
      : {
          ...joined,
          workloadBindings: Object.freeze({
            readActiveWorkloadKeys: (query: WorkloadBindingQuery) =>
              workloadBindings.readActiveWorkloadKeys(query, transaction),
          }),
        },
  );
};

const contextOf = (ports: AccessEnforcementPorts) => {
  const base = Context.make(AccessIntent, ports.intent).pipe(
    Context.add(AccessDecisionLog, ports.decisionLog),
    Context.add(AccessPrincipalKindSource, ports.principalKinds),
    Context.add(DecisionCheck, ports.check),
    Context.add(LegalEntityCandidates, ports.candidates),
  );
  // The registry is not part of the seam's own requirements: the gate reads it through its ports,
  // never from context, so a scripted gate needs no registry at all (O73).
  return ports.workloadBindings === undefined
    ? base
    : Context.add(base, AccessWorkloadBindingSource, ports.workloadBindings);
};

/** The ports the seam's own service takes, from the ports this binding holds. */
const decisionPortsOf = (ports: AccessEnforcementPorts): AccessDecisionPorts =>
  withOptional(
    {
      authorityFor: ports.intent.authorityFor,
      check: ports.check,
      decisionLog: ports.decisionLog,
      legalEntities: ports.candidates,
      principalKinds: ports.principalKinds,
    },
    'workloadBindings',
    ports.workloadBindings,
  );

/**
 * The gate bound to these ports. The gate itself is the seam's own service (`AccessDecisionLive` in
 * a deployment, a scripted double in a suite); the ports are what this composition provides.
 */
export const bindAccessGate = (gate: UnboundAccessGate, ports: AccessEnforcementPorts): BoundAccessGate => {
  const context = contextOf(ports);
  // The request read isolation is the default: only a caller that hands its own transaction gets the
  // joined ports, so a preflight or a standalone decision keeps opening its own scoped read.
  const boundTo = (transaction: CoreTransaction | undefined) => {
    if (transaction === undefined) {
      return { context, seam: gate };
    }
    const joinedPorts = joinAccessEnforcementPorts(ports, transaction);
    // A gate that can rebind is proved from the caller's transaction; a scripted gate that cannot
    // keeps answering itself, because it reads no ports at all.
    return { context: contextOf(joinedPorts), seam: gate.rebind?.(decisionPortsOf(joinedPorts)) ?? gate };
  };
  return Object.freeze({
    decide: (input: GateInput, transaction?: CoreTransaction) => {
      const bound = boundTo(transaction);
      return bound.seam.decide(input).pipe(Effect.provideContext(bound.context));
    },
    list: (input: ListGateInput, transaction?: CoreTransaction) => {
      const bound = boundTo(transaction);
      return bound.seam.list(input).pipe(Effect.provideContext(bound.context));
    },
    selectableLegalEntities: (input: SelectableLegalEntitiesInput) =>
      gate.selectableLegalEntities(input).pipe(Effect.provideContext(context)),
  });
};

/** The runtime's own wiring: the seam from the tag, the ports from the layers it is built with. */
export const bindLiveAccessGate = Effect.gen(function* bindAccessGateFromLayers() {
  const [gate, ports] = yield* Effect.all([AccessDecisionGate, AccessEnforcementPortsLive], { concurrency: 2 });
  return bindAccessGate(gate, ports);
});
