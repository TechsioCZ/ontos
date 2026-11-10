import {
  AccessDecisionGate,
  AccessDecisionLog,
  AccessIntent,
  AccessPrincipalKindSource,
  LegalEntityCandidates,
  makeTestAccessDecision,
} from '@app/core-runtime/access/enforcement';
import type { AccessDecisionService, TestAccessDecision, TestGateAnswer } from '@app/core-runtime/access/enforcement';
import {
  inertAccessEnforcementPorts,
  makeTestOperationalScopeAccess,
  withScriptedRebind,
} from '@app/core-runtime/testing/access-gate';
import { Layer } from 'effect';

import { DecisionCheck } from '../../../../packages/core-runtime/src/access/decision/engine.ts';

/**
 * The one access gate for the native completion suites. They prove Privacy completion publication
 * and drain against real PostgreSQL, not authorization: the isolated database carries no access
 * intent and talks to no SpiceDB, so a live gate could only answer UNAVAILABLE. The seam is
 * therefore scripted exactly as the Core test harness scripts it (C04), while the runtime still asks
 * the real one question per protected entrypoint (an unscripted capability is DENIED, never allowed).
 */
export interface PrivacyCompletionAccessGate {
  /** The gate's own record of what the runtime asked, for a suite that asserts the carrier. */
  readonly asked: Pick<TestAccessDecision, 'askedDecisions' | 'askedLists'>;
  /** `AccessDecisionGate` plus the five enforcement ports the live runtime binds at wiring time. */
  readonly layer: Layer.Layer<
    | AccessDecisionGate
    | AccessDecisionLog
    | AccessIntent
    | AccessPrincipalKindSource
    | DecisionCheck
    | LegalEntityCandidates
  >;
}

export const makePrivacyCompletionAccessGate = (
  outcome: TestGateAnswer['outcome'] = 'ALLOWED',
): PrivacyCompletionAccessGate => {
  const gate = makeTestAccessDecision({ defaultAnswer: { outcome } });
  // The trusted scope resolver asks the same seam which companies this actor may select (O28). The
  // fixture creates the company at runtime, so the scope authority answers exactly the company the
  // request itself selected; only an explicit denial would refuse it.
  const scopeAccess = makeTestOperationalScopeAccess();
  const ports = inertAccessEnforcementPorts();
  // The scripted gate reads no ports, so it states its rebind: a prepared Action authority needs one.
  const service: AccessDecisionService = withScriptedRebind({
    decide: gate.decide,
    decideMany: gate.decideMany,
    list: gate.list,
    selectableLegalEntities: scopeAccess.selectableLegalEntities,
  });
  return Object.freeze({
    asked: gate,
    layer: Layer.mergeAll(
      Layer.succeed(AccessDecisionGate, service),
      Layer.succeed(AccessIntent, ports.intent),
      Layer.succeed(AccessDecisionLog, ports.decisionLog),
      Layer.succeed(AccessPrincipalKindSource, ports.principalKinds),
      Layer.succeed(DecisionCheck, ports.check),
      Layer.succeed(LegalEntityCandidates, ports.candidates),
    ),
  });
};
