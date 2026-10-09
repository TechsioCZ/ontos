import type {
  ActiveApplicationCompositionServiceContract,
  ActiveApplicationCompositionSnapshot,
} from '@app/core-runtime';
import { ActiveApplicationCompositionService, ReadHandlerUnavailable } from '@app/core-runtime';
import { MarketAffectedUseSourceEvidenceSchema } from '@app/customer-market-retirement-contracts';
import type {
  MarketAffectedUseAssessmentRequest,
  MarketAffectedUseSourceEvidence,
} from '@app/customer-market-retirement-contracts';
import { createHash } from 'node:crypto';
import { DateTime, Effect, Layer, Schema } from 'effect';

import { MarketReferenceOwnerDeploymentStateAuthorityService } from '../src/api/market-affected-use-assessment.read.ts';
import type { MarketReferenceOwnerDeploymentStateAuthority } from '../src/api/market-affected-use-assessment.read.ts';

const marketReferenceOwnerModuleIds = ['commerce.cart', 'commerce.order'] as const;

const unavailable = (reason: string, cause?: unknown): ReadHandlerUnavailable => {
  const failure = new ReadHandlerUnavailable({
    code: 'read_handler_unavailable',
    reason,
  });
  if (cause !== undefined) {
    Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  }
  return failure;
};

const absentOwnerEvidence = (
  moduleId: (typeof marketReferenceOwnerModuleIds)[number],
  snapshot: ActiveApplicationCompositionSnapshot,
): Effect.Effect<MarketAffectedUseSourceEvidence, ReadHandlerUnavailable> => {
  const { revision } = snapshot.composition;
  const sourceId = `application-composition:${moduleId}:UNIMPLEMENTED`;
  return Schema.decodeEffect(MarketAffectedUseSourceEvidenceSchema)({
    completenessEvidence: {
      nextApplicabilityBoundary: DateTime.formatIso(snapshot.validUntil),
      observedAt: DateTime.formatIso(snapshot.observedAt),
      ownerRevision: revision,
      scope: {
        declaredScopeRef: `application-composition:${revision}`,
        kind: 'SAFELY_BROADER_SCOPE',
        predicateRef: `application-composition:module:${moduleId}:absent`,
      },
    },
    currentness: 'CURRENT',
    digest: createHash('sha256').update(`${revision}\0${moduleId}\0UNIMPLEMENTED`).digest('hex'),
    generation: revision,
    ownerRevision: revision,
    sourceId,
  }).pipe(
    Effect.mapError((cause) => unavailable(`Application Composition evidence for ${moduleId} is invalid`, cause)),
  );
};

export const makeApplicationCompositionMarketReferenceOwnerDeploymentStateAuthority = (
  load: ActiveApplicationCompositionServiceContract['load'],
): MarketReferenceOwnerDeploymentStateAuthority => ({
  proveReferenceOwnerStates: Effect.fn(
    'ApplicationCompositionMarketReferenceOwnerDeploymentStateAuthority.proveReferenceOwnerStates',
  )(function* proveReferenceOwnerStates(_input: MarketAffectedUseAssessmentRequest) {
    const snapshot = yield* load.pipe(
      Effect.mapError((cause) => unavailable('Authoritative Application Composition evidence is unavailable', cause)),
    );
    const installedOwner = marketReferenceOwnerModuleIds.find((moduleId) =>
      snapshot.composition.modules.some((module) => module.moduleId === moduleId),
    );
    if (installedOwner !== undefined) {
      return yield* unavailable(
        `Market-reference owner ${installedOwner} is installed but its affected-use provider is unavailable`,
      );
    }
    const sourceEvidence = yield* Effect.forEach(
      marketReferenceOwnerModuleIds,
      (moduleId) => absentOwnerEvidence(moduleId, snapshot),
      { concurrency: 1 },
    );
    return Object.freeze({ sourceEvidence: Object.freeze(sourceEvidence) });
  }),
});

export const applicationCompositionMarketReferenceOwnerDeploymentStateAuthorityLive = Layer.effect(
  MarketReferenceOwnerDeploymentStateAuthorityService,
  ActiveApplicationCompositionService.pipe(
    Effect.map(({ load }) => makeApplicationCompositionMarketReferenceOwnerDeploymentStateAuthority(load)),
  ),
);
