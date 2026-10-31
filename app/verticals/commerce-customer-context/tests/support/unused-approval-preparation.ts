import { NodeCrypto } from '@effect/platform-node';
import { ContextAccess } from '@app/core-runtime';
import { Effect, Layer } from 'effect';
import { ProfileCounterpartyRoleEligibilityResolverFactory } from '../../src/profile-counterparty-role-eligibility.ts';
import { PurchaseApprovalCurrentnessFactory } from '../../shared/domain/purchase-approval-currentness-port.ts';
import { PurchaseLimitEvaluationSourceFactory } from '../../shared/domain/purchase-limit-evaluation.ts';
import { PurchaseLimitEvaluationCurrentnessPort } from '../../shared/domain/purchase-limit-evaluation-currentness-port.ts';
import { PurchaseApprovalTriggerEvidenceSourceFactory } from '../../src/services/purchase-approval-trigger-evidence-source.ts';

const unexpectedAuthorization = 'A direct-handler unit must not query production authorization';

/** Direct-handler tests replace owner services explicitly; unexpected production acquisition must fail. */
export const unusedApprovalPreparationLayer = Layer.mergeAll(
  NodeCrypto.layer,
  Layer.succeed(PurchaseApprovalTriggerEvidenceSourceFactory, {
    make: () => Effect.die('A direct-handler unit must not acquire production approval evidence'),
  }),
  Layer.succeed(PurchaseApprovalCurrentnessFactory, {
    make: () => ({
      resolveRevalidation: () => Effect.die('A direct-handler unit must not revalidate production approval evidence'),
    }),
  }),
  Layer.succeed(PurchaseLimitEvaluationSourceFactory, {
    make: () => Effect.die('A direct-handler unit must not acquire production purchase limits'),
  }),
  Layer.succeed(PurchaseLimitEvaluationCurrentnessPort, {
    resolveCandidate: () => Effect.die('A direct-handler unit must not query production candidate currentness'),
    resolveCurrent: () => Effect.die('A direct-handler unit must not query production currentness'),
  }),
  Layer.succeed(ProfileCounterpartyRoleEligibilityResolverFactory, {
    make: () => () => Effect.die('A direct-handler unit must not resolve a production Counterparty role'),
  }),
  Layer.succeed(ContextAccess, {
    businessPermissions: () => Effect.die(unexpectedAuthorization),
    legalEntities: () => Effect.die(unexpectedAuthorization),
    modules: () => Effect.die(unexpectedAuthorization),
    resources: () => Effect.die(unexpectedAuthorization),
    tenants: () => Effect.die(unexpectedAuthorization),
  }),
);
