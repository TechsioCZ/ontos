import { ActiveApplicationCompositionService } from '@app/core-runtime';
import type { ActiveApplicationCompositionSnapshot, OperationalScope } from '@app/core-runtime';
import { makeOwnerActionApprovalsLive } from '@app/core-runtime/access/approvals/owner-runtime';
import {
  AccessDecisionGate,
  AccessDecisionLog,
  AccessIntent,
  AccessPrincipalKindSource,
  DecisionCheck,
  LegalEntityCandidates,
} from '@app/core-runtime/access/enforcement';
import { inertAccessEnforcementPorts, makeTestBoundAccessGate } from '@app/core-runtime/testing/access-gate';
import { makeReadTestHarness } from '@app/core-runtime/testing/reads';
import { NodeCrypto } from '@effect/platform-node';
import { DateTime, Effect, Layer } from 'effect';

import { ultramodernDeliveryUnit } from '../../shared/ultramodern-build.ts';
import { commerceCustomerContextRegistration } from '../../vertical.registration.ts';

/**
 * Root assembly tests have scripted business runtimes, not a pool. Construct the real approval
 * provider from one explicitly denied case context. Any attempt to read SQL or approval authority
 * fails, rather than supplying a successful approval stub to satisfy the new root requirement.
 */
export const makeRootOwnerApprovals = Effect.fn('CommerceCustomerContextRootTest.ownerApprovals')(
  function* rootOwnerApprovals(snapshot: ActiveApplicationCompositionSnapshot, scope: OperationalScope) {
    const cryptoContext = yield* Layer.build(NodeCrypto.layer);
    const ports = inertAccessEnforcementPorts();
    const gate = makeTestBoundAccessGate({ defaultAnswer: { outcome: 'DENIED' } }, ports);
    const applicationComposition = { load: Effect.succeed(snapshot) };
    const harness = yield* makeReadTestHarness({
      accessDecision: gate.bound,
      applicationComposition,
      compositionRevision: snapshot.composition.revision,
      executeOwnerQuery: () => Effect.die('Root assembly must not perform owner or approval SQL'),
      expectedDeployment: ultramodernDeliveryUnit,
      operationTime: yield* DateTime.nowAsDate,
      ownerRegistration: commerceCustomerContextRegistration,
      scope,
    }).pipe(Effect.provideContext(cryptoContext));
    return yield* Layer.build(
      makeOwnerActionApprovalsLive(ultramodernDeliveryUnit, commerceCustomerContextRegistration).pipe(
        Layer.provide(
          Layer.mergeAll(
            harness.ownerServices,
            Layer.succeed(ActiveApplicationCompositionService, applicationComposition),
            Layer.succeed(AccessDecisionGate, gate.accessDecision),
            Layer.succeed(AccessDecisionLog, ports.decisionLog),
            Layer.succeed(AccessIntent, ports.intent),
            Layer.succeed(AccessPrincipalKindSource, ports.principalKinds),
            Layer.succeed(DecisionCheck, ports.check),
            Layer.succeed(LegalEntityCandidates, ports.candidates),
          ),
        ),
        Layer.provide(Layer.succeedContext(cryptoContext)),
      ),
    );
  },
);
