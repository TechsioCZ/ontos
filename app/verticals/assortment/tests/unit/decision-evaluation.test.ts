import { expect, it } from 'effect-rstest';
import { Array as EffectArray, DateTime, Effect, Schema } from 'effect';

import {
  AssortmentDependencyFailureError,
  AssortmentCatalogSelectionSchema,
  AssortmentGovernedDecisionSchema,
  AssortmentOwnerModuleIdSchema,
  AssortmentPurchaseRequestSchema,
  AssortmentSetPurchaseCompositionSchema,
  AssortmentVisibilityRequestSchema,
} from '../../shared/domain/decision-contracts.ts';
import {
  AssortmentDecisionEvaluation,
  AssortmentDecisionEvaluationUnavailableLive,
  AssortmentPurchaseEvaluationRequestSchema,
  AssortmentVisibilityEvaluationRequestSchema,
  makeAssortmentDecisionEvaluation,
  assortmentPurchaseConstituentRequest,
  makeAssortmentDecisionEvaluationUnavailable,
} from '../../shared/domain/ports/decision-evaluation.ts';
import type {
  AssortmentDecisionEvidenceStore,
  AssortmentDecisionEvaluationDependencies,
  AssortmentDecisionSourcePort,
  AssortmentOwnedVisibilityDecision,
  AssortmentTrustedReadScope,
  AssortmentVisibilityEvaluationRequest,
} from '../../shared/domain/ports/decision-evaluation.ts';
import { AssortmentConsumerDecisionEvidenceReferenceSchema } from '../../shared/domain/consumer-evidence.ts';
import { assortmentDecisionRequestFingerprint } from '../../src/services/decision-evidence.repository.ts';

const tenantId = '018f8b4e-35a2-7b51-8d56-91a4f37d6a11';
const principalId = '018f8b4e-35a2-7b51-8d56-91a4f37d6a12';

const ref = (moduleId: string, resourceType: string, resourceId: string) => ({
  moduleId,
  resourceId,
  resourceType,
  tenantId,
});

const visibilityRequest = Schema.decodeUnknownSync(AssortmentVisibilityEvaluationRequestSchema)({
  decisionPurpose: 'VISIBILITY',
  productRef: ref('catalog.owner', 'catalog.product', 'product-1'),
  subject: {
    guestEvidence: {
      evidenceRef: ref('party.registry', 'party.registry.guest-evidence', 'guest-1'),
      ownerModuleId: 'party.registry',
    },
    kind: 'GUEST_PURCHASE_CONTEXT',
  },
  trustedContextRef: ref('commerce.gateway', 'commerce.gateway.trusted-context', 'context-1'),
});

const purchaseRequest = Schema.decodeUnknownSync(AssortmentPurchaseEvaluationRequestSchema)({
  constituent: {
    catalogSelection: {
      configuration: { kind: 'NONE' },
      productRef: ref('catalog.owner', 'catalog.product', 'product-1'),
      variantKind: 'ATOMIC',
      variantRef: ref('catalog.owner', 'catalog.variant', 'variant-1'),
    },
    role: 'TOP_LEVEL',
  },
  decisionPurpose: 'PURCHASE',
  subject: visibilityRequest.subject,
  trustedContextRef: visibilityRequest.trustedContextRef,
});

const scope = {
  correlationId: 'correlation-1',
  legalEntityId: 'legal-entity-1',
  principalId,
  tenantId,
};

const trustedContext = {
  channelRef: ref('commerce.channel', 'commerce.channel.channel', 'web'),
  operationTime: '2026-09-23T10:00:00.000Z',
  sellingLegalEntityRef: ref('commerce.legal-entity', 'commerce.legal-entity.selling-legal-entity', 'legal-entity-1'),
  tenantId,
};

const AssortmentGovernedDecisionTypeSchema = Schema.toType(AssortmentGovernedDecisionSchema);

const canonicalVisibilityRequest = Schema.decodeUnknownSync(AssortmentVisibilityRequestSchema)({
  decisionPurpose: 'VISIBILITY',
  productRef: visibilityRequest.productRef,
  subject: visibilityRequest.subject,
  trustedContext,
});

const canonicalPurchaseRequest = Schema.decodeUnknownSync(AssortmentPurchaseRequestSchema)({
  constituent: purchaseRequest.constituent,
  decisionPurpose: 'PURCHASE',
  subject: purchaseRequest.subject,
  trustedContext,
});

const deepFreeze = <Value>(value: Value): Value => {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
};

const decisionFor = (
  request: typeof canonicalVisibilityRequest | typeof canonicalPurchaseRequest,
  outcome: 'ELIGIBLE' | 'INELIGIBLE',
  targetConstituent?: typeof canonicalPurchaseRequest.constituent,
) =>
  deepFreeze(
    Schema.decodeUnknownSync(AssortmentGovernedDecisionTypeSchema)({
      evidence: {
        factCurrentness: [],
        operationTime: request.trustedContext.operationTime,
        setCompleteness: [],
        subject: request.subject,
        target:
          request.decisionPurpose === 'VISIBILITY'
            ? { kind: 'PRODUCT', productRef: request.productRef }
            : {
                kind: 'CATALOG_SELECTION',
                selection: (targetConstituent ?? request.constituent).catalogSelection,
              },
        trustedContext: request.trustedContext,
      },
      outcome,
    }),
  );

const makeSetPurchaseFixture = () => {
  const setCompositionRevision = {
    ownerModuleId: 'catalog.owner',
    revision: 'composition-1',
    sourceRef: ref('catalog.owner', 'catalog.set-composition-revision', 'composition-1'),
  };
  const component = {
    catalogSelection: {
      configuration: { kind: 'NONE' as const },
      productRef: ref('catalog.owner', 'catalog.product', 'component-1'),
      variantKind: 'ATOMIC' as const,
      variantRef: ref('catalog.owner', 'catalog.variant', 'component-variant-1'),
    },
    role: 'REQUIRED_COMPONENT' as const,
  };
  const secondComponent = {
    catalogSelection: {
      configuration: { kind: 'NONE' as const },
      productRef: ref('catalog.owner', 'catalog.product', 'component-2'),
      variantKind: 'ATOMIC' as const,
      variantRef: ref('catalog.owner', 'catalog.variant', 'component-variant-2'),
    },
    role: 'REQUIRED_COMPONENT' as const,
  };
  const decodedSetComposition = Schema.decodeUnknownSync(AssortmentSetPurchaseCompositionSchema)({
    requiredComponents: [component, secondComponent],
    setCompositionRevision,
  });
  const setSelection = {
    configuration: { kind: 'NONE' as const },
    productRef: ref('catalog.owner', 'catalog.product', 'set-product'),
    setCompositionRevision,
    variantKind: 'SET' as const,
    variantRef: ref('catalog.owner', 'catalog.variant', 'set-variant'),
  };
  const wireRequest = Schema.decodeUnknownSync(AssortmentPurchaseEvaluationRequestSchema)({
    ...purchaseRequest,
    constituent: { catalogSelection: setSelection, role: 'TOP_LEVEL' },
    setComposition: decodedSetComposition,
  });
  const internalRequest = Schema.decodeUnknownSync(AssortmentPurchaseRequestSchema)({
    ...wireRequest,
    trustedContext,
  });
  const setComposition = Schema.decodeUnknownSync(AssortmentSetPurchaseCompositionSchema)(
    internalRequest.setComposition,
  );
  return {
    constituents: [internalRequest.constituent, ...setComposition.requiredComponents],
    internalRequest,
    wireRequest,
  };
};

const indeterminateDecision = () =>
  deepFreeze(
    Schema.decodeUnknownSync(AssortmentGovernedDecisionSchema)({
      failure: {
        _tag: 'AssortmentMissingConfigurationError',
        code: 'MISSING_CONFIGURATION',
        safeReasonCode: 'MISSING_CONFIGURATION',
      },
      outcome: 'INDETERMINATE',
    }),
  );

const evidenceReference = (resourceId: string) =>
  Schema.decodeUnknownSync(AssortmentConsumerDecisionEvidenceReferenceSchema)({
    evidenceRef: ref('commerce.assortment', 'commerce.assortment.decision-evidence', resourceId),
    ownerModuleId: 'commerce.assortment',
  });

const dependenciesFor = (
  source: AssortmentDecisionSourcePort,
  persist: AssortmentDecisionEvidenceStore['persist'] = (input) =>
    Effect.succeed(
      evidenceReference(
        'constituent' in input ? input.constituent.catalogSelection.productRef.resourceId : 'evidence-1',
      ),
    ),
): AssortmentDecisionEvaluationDependencies => ({
  evidenceStore: { persist },
  source,
});

const dependencyFailure = () =>
  new AssortmentDependencyFailureError({
    code: 'DEPENDENCY_FAILURE',
    ownerModuleId: Schema.decodeUnknownSync(AssortmentOwnerModuleIdSchema)('commerce.assortment'),
    retryable: true,
    safeReasonCode: 'DEPENDENCY_UNAVAILABLE',
  });

const visibilitySource = (
  decision: AssortmentOwnedVisibilityDecision['decision'],
  reason?: 'BOUNDARY_EXCLUDED' | 'RULE_DENIED',
  observed?: ObservedSourceCall,
): AssortmentDecisionSourcePort => ({
  resolvePurchase: () => Effect.fail(dependencyFailure()),
  resolveVisibility: (request, sourceScope) => {
    if (observed !== undefined) {
      observed.request = request;
      observed.scope = sourceScope;
    }
    const result = {
      decision,
      request: canonicalVisibilityRequest,
    };
    return reason === undefined ? Effect.succeed(result) : Effect.succeed({ ...result, safeReasonCode: reason });
  },
});

interface ObservedSourceCall {
  request?: AssortmentVisibilityEvaluationRequest;
  scope?: AssortmentTrustedReadScope;
}

it.effect('fails closed when Boundary/Candidate owner sources are unavailable', () =>
  Effect.gen(function* failClosed() {
    const evaluation = makeAssortmentDecisionEvaluationUnavailable();
    const visibility = yield* evaluation.evaluateVisibility(visibilityRequest, scope);
    const purchase = yield* evaluation.evaluatePurchase(purchaseRequest, scope);

    expect(visibility).toEqual({
      outcome: 'INDETERMINATE',
      retryable: true,
      safeReasonCode: 'DEPENDENCY_UNAVAILABLE',
    });
    expect(purchase.decision).toEqual(visibility);
    expect(purchase.consumerEvidence).toBeUndefined();
  }),
);

it.effect('redacts injected Visibility outcomes and preserves trusted source identity', () =>
  Effect.gen(function* injectedVisibilityMatrix() {
    const observed: ObservedSourceCall = {};
    const eligible = makeAssortmentDecisionEvaluation(
      dependenciesFor(visibilitySource(decisionFor(canonicalVisibilityRequest, 'ELIGIBLE'), undefined, observed)),
    );
    const eligibleResult = yield* eligible.evaluateVisibility(visibilityRequest, scope);
    expect(eligibleResult).toEqual({ outcome: 'ELIGIBLE', retryable: false });
    expect(observed.request).toBe(visibilityRequest);
    expect(observed.scope).toBe(scope);

    const ineligible = makeAssortmentDecisionEvaluation(
      dependenciesFor(visibilitySource(decisionFor(canonicalVisibilityRequest, 'INELIGIBLE'), 'RULE_DENIED')),
    );
    const ineligibleResult = yield* ineligible.evaluateVisibility(visibilityRequest, scope);
    expect(ineligibleResult).toEqual({
      outcome: 'INELIGIBLE',
      retryable: false,
      safeReasonCode: 'RULE_DENIED',
    });

    const indeterminateSource: AssortmentDecisionSourcePort = {
      resolvePurchase: () => Effect.fail(dependencyFailure()),
      resolveVisibility: () =>
        Effect.succeed({
          decision: indeterminateDecision(),
          request: canonicalVisibilityRequest,
        }),
    };
    const indeterminate = makeAssortmentDecisionEvaluation(dependenciesFor(indeterminateSource));
    const indeterminateResult = yield* indeterminate.evaluateVisibility(visibilityRequest, scope);
    expect(indeterminateResult).toEqual({
      outcome: 'INDETERMINATE',
      retryable: false,
      safeReasonCode: 'MISSING_CONFIGURATION',
    });
  }),
);

it.effect('fails closed when injected Visibility ownership or evidence targets drift from the wire request', () =>
  Effect.gen(function* rejectsVisibilityDrift() {
    const driftProductRef = Schema.decodeUnknownSync(AssortmentVisibilityRequestSchema.fields.productRef)(
      ref('catalog.owner', 'catalog.product', 'product-2'),
    );
    const mismatchedRequest: typeof canonicalVisibilityRequest = {
      ...canonicalVisibilityRequest,
      productRef: driftProductRef,
    };
    const requestDrift = makeAssortmentDecisionEvaluation(
      dependenciesFor({
        resolvePurchase: () => Effect.fail(dependencyFailure()),
        resolveVisibility: () =>
          Effect.succeed({
            decision: decisionFor(canonicalVisibilityRequest, 'ELIGIBLE'),
            request: mismatchedRequest,
          }),
      }),
    );
    expect(yield* requestDrift.evaluateVisibility(visibilityRequest, scope)).toEqual({
      outcome: 'INDETERMINATE',
      retryable: true,
      safeReasonCode: 'DEPENDENCY_UNAVAILABLE',
    });

    const evidenceDriftRequest = mismatchedRequest;
    const evidenceDrift = makeAssortmentDecisionEvaluation(
      dependenciesFor({
        resolvePurchase: () => Effect.fail(dependencyFailure()),
        resolveVisibility: () =>
          Effect.succeed({
            decision: decisionFor(evidenceDriftRequest, 'ELIGIBLE'),
            request: canonicalVisibilityRequest,
          }),
      }),
    );
    expect(yield* evidenceDrift.evaluateVisibility(visibilityRequest, scope)).toEqual({
      outcome: 'INDETERMINATE',
      retryable: true,
      safeReasonCode: 'DEPENDENCY_UNAVAILABLE',
    });
  }),
);

it.effect('persists bounded evidence for an eligible non-Set PURCHASE', () =>
  Effect.gen(function* eligiblePurchase() {
    const persisted: string[] = [];
    const source: AssortmentDecisionSourcePort = {
      resolvePurchase: () =>
        Effect.succeed({
          constituents: [
            {
              constituent: canonicalPurchaseRequest.constituent,
              decision: decisionFor(canonicalPurchaseRequest, 'ELIGIBLE'),
              request: canonicalPurchaseRequest,
            },
          ],
          decision: decisionFor(canonicalPurchaseRequest, 'ELIGIBLE'),
          request: canonicalPurchaseRequest,
        }),
      resolveVisibility: () => Effect.fail(dependencyFailure()),
    };
    const evaluation = makeAssortmentDecisionEvaluation(
      dependenciesFor(source, (input) => {
        const id = 'constituent' in input ? input.constituent.catalogSelection.variantRef.resourceId : 'visibility';
        persisted.push(id);
        return Effect.succeed(evidenceReference(`evidence-${id}`));
      }),
    );
    const result = yield* evaluation.evaluatePurchase(purchaseRequest, scope);
    expect(result.decision).toEqual({ outcome: 'ELIGIBLE', retryable: false });
    expect(result.consumerEvidence?.evaluatedConstituents).toHaveLength(1);
    expect(persisted).toEqual(['variant-1']);
  }),
);

it.effect('requires and persists every pinned Set constituent before positive PURCHASE', () =>
  Effect.gen(function* eligibleSetPurchase() {
    const { constituents, internalRequest, wireRequest } = makeSetPurchaseFixture();
    const persisted: string[] = [];
    const source: AssortmentDecisionSourcePort = {
      resolvePurchase: () =>
        Effect.succeed({
          constituents: constituents.map((constituent) => ({
            constituent,
            decision: decisionFor(internalRequest, 'ELIGIBLE', constituent),
            request: assortmentPurchaseConstituentRequest(internalRequest, constituent),
          })),
          decision: decisionFor(internalRequest, 'ELIGIBLE'),
          request: internalRequest,
        }),
      resolveVisibility: () => Effect.fail(dependencyFailure()),
    };
    const evaluation = makeAssortmentDecisionEvaluation(
      dependenciesFor(source, (input) => {
        const id = 'constituent' in input ? input.constituent.catalogSelection.variantRef.resourceId : 'visibility';
        persisted.push(id);
        return Effect.succeed(evidenceReference(`set-evidence-${id}`));
      }),
    );
    const result = yield* evaluation.evaluatePurchase(wireRequest, scope);
    expect(result.decision).toEqual({ outcome: 'ELIGIBLE', retryable: false });
    expect(result.consumerEvidence?.evaluatedConstituents).toHaveLength(3);
    expect(persisted).toEqual(['set-variant', 'component-variant-1', 'component-variant-2']);
  }),
);

it.effect('accepts an authoritative Set deny prefix without fabricating sibling outcomes', () =>
  Effect.gen(function* earlySetDeny() {
    const { constituents, internalRequest, wireRequest } = makeSetPurchaseFixture();
    const prefix = constituents.slice(0, 2);
    const denied = decisionFor(internalRequest, 'INELIGIBLE');
    const source: AssortmentDecisionSourcePort = {
      resolvePurchase: () =>
        Effect.succeed({
          constituents: prefix.map((constituent, index) => ({
            constituent,
            decision: decisionFor(internalRequest, index === 0 ? 'ELIGIBLE' : 'INELIGIBLE', constituent),
            request: assortmentPurchaseConstituentRequest(internalRequest, constituent),
          })),
          decision: denied,
          request: internalRequest,
          safeReasonCode: 'RULE_DENIED',
        }),
      resolveVisibility: () => Effect.fail(dependencyFailure()),
    };
    const persisted: string[] = [];
    const evaluation = makeAssortmentDecisionEvaluation(
      dependenciesFor(source, (input) => {
        const id = 'constituent' in input ? input.constituent.catalogSelection.variantRef.resourceId : 'visibility';
        persisted.push(id);
        return Effect.succeed(evidenceReference(`early-deny-${id}`));
      }),
    );

    const result = yield* evaluation.evaluatePurchase(wireRequest, scope);
    expect(result.decision).toEqual({
      outcome: 'INELIGIBLE',
      retryable: false,
      safeReasonCode: 'RULE_DENIED',
    });
    expect(result.consumerEvidence?.composedOutcome).toBe('INELIGIBLE');
    expect(result.consumerEvidence?.evaluatedConstituents.map((item) => item.constituent)).toEqual(prefix);
    expect(persisted).toEqual(['set-variant', 'component-variant-1']);
  }),
);

it.effect('fails closed when injected Set constituents or composed PURCHASE outcome drift', () =>
  Effect.gen(function* rejectsSetDrift() {
    const { constituents, internalRequest, wireRequest } = makeSetPurchaseFixture();
    const tamperedSelection = Schema.decodeUnknownSync(AssortmentCatalogSelectionSchema)({
      ...constituents[1]?.catalogSelection,
      productRef: ref('catalog.owner', 'catalog.product', 'tampered-component'),
    });
    const source = (
      componentDecision: 'valid' | 'outcome-drift' | 'omitted' | 'duplicated',
    ): AssortmentDecisionSourcePort => ({
      resolvePurchase: () =>
        Effect.succeed({
          constituents: (() => {
            if (componentDecision === 'omitted') {
              return constituents.slice(0, -1);
            }
            if (componentDecision === 'duplicated') {
              return [...constituents.slice(0, 2), ...constituents.slice(1, 2)];
            }
            return constituents;
          })().map((constituent, index) => ({
            constituent:
              index === 1 && componentDecision === 'valid'
                ? { ...constituent, catalogSelection: tamperedSelection }
                : constituent,
            decision: decisionFor(
              internalRequest,
              index === 1 && componentDecision === 'outcome-drift' ? 'INELIGIBLE' : 'ELIGIBLE',
              constituent,
            ),
            request: assortmentPurchaseConstituentRequest(internalRequest, constituent),
          })),
          decision: decisionFor(internalRequest, 'ELIGIBLE'),
          request: internalRequest,
        }),
      resolveVisibility: () => Effect.fail(dependencyFailure()),
    });

    for (const componentDecision of ['valid', 'outcome-drift', 'omitted', 'duplicated'] as const) {
      const result = yield* makeAssortmentDecisionEvaluation(
        dependenciesFor(source(componentDecision)),
      ).evaluatePurchase(wireRequest, scope);
      expect(result).toEqual({
        decision: {
          outcome: 'INDETERMINATE',
          retryable: true,
          safeReasonCode: 'DEPENDENCY_UNAVAILABLE',
        },
      });
    }
  }),
);

it.effect('keeps an authoritative PURCHASE deny bounded and degrades evidence-store failure', () =>
  Effect.gen(function* deniedPurchase() {
    const deniedDecision = decisionFor(canonicalPurchaseRequest, 'INELIGIBLE');
    const source: AssortmentDecisionSourcePort = {
      resolvePurchase: () =>
        Effect.succeed({
          constituents: [
            {
              constituent: canonicalPurchaseRequest.constituent,
              decision: deniedDecision,
              request: canonicalPurchaseRequest,
            },
          ],
          decision: deniedDecision,
          request: canonicalPurchaseRequest,
          safeReasonCode: 'BOUNDARY_EXCLUDED',
        }),
      resolveVisibility: () => Effect.fail(dependencyFailure()),
    };
    const denied = makeAssortmentDecisionEvaluation(dependenciesFor(source));
    const deniedResult = yield* denied.evaluatePurchase(purchaseRequest, scope);
    expect(deniedResult.decision).toEqual({
      outcome: 'INELIGIBLE',
      retryable: false,
      safeReasonCode: 'BOUNDARY_EXCLUDED',
    });
    expect(deniedResult.consumerEvidence?.evaluatedConstituents).toHaveLength(1);

    const storeFailure = makeAssortmentDecisionEvaluation(
      dependenciesFor(source, () => Effect.fail(dependencyFailure())),
    );
    const unavailable = yield* storeFailure.evaluatePurchase(purchaseRequest, scope);
    expect(unavailable).toEqual({
      decision: {
        outcome: 'INDETERMINATE',
        retryable: true,
        safeReasonCode: 'DEPENDENCY_UNAVAILABLE',
      },
    });
  }),
);

it.effect('rejects malformed and shallow-frozen owner evidence', () =>
  Effect.gen(function* rejectsMutableEvidence() {
    const malformed: AssortmentDecisionSourcePort = {
      resolvePurchase: () => Effect.fail(dependencyFailure()),
      resolveVisibility: () =>
        Effect.succeed({
          // SAFETY: malformed owner data is intentional; the facade must reject it before projection.
          decision: { evidence: { factCurrentness: [] }, outcome: 'ELIGIBLE' } as never,
          request: canonicalVisibilityRequest,
        }),
    };
    const malformedResult = yield* makeAssortmentDecisionEvaluation(dependenciesFor(malformed)).evaluateVisibility(
      visibilityRequest,
      scope,
    );
    expect(malformedResult).toEqual({
      outcome: 'INDETERMINATE',
      retryable: true,
      safeReasonCode: 'DEPENDENCY_UNAVAILABLE',
    });

    const deeplyValid = decisionFor(canonicalVisibilityRequest, 'ELIGIBLE');
    const validEvidence = yield* deeplyValid.evidence === undefined
      ? Effect.fail(dependencyFailure())
      : Effect.succeed(deeplyValid.evidence);
    const shallow = Object.freeze({
      evidence: {
        ...validEvidence,
        trustedContext: { ...validEvidence.trustedContext },
      },
      outcome: 'ELIGIBLE' as const,
    });
    const shallowSource = visibilitySource(shallow);
    const result = yield* makeAssortmentDecisionEvaluation(dependenciesFor(shallowSource)).evaluateVisibility(
      visibilityRequest,
      scope,
    );
    expect(result).toEqual({
      outcome: 'INDETERMINATE',
      retryable: true,
      safeReasonCode: 'DEPENDENCY_UNAVAILABLE',
    });
  }),
);

it.effect('rejects requests whose actor is not the trusted gateway principal', () =>
  Effect.gen(function* rejectsCallerAuthoredTrust() {
    const evaluation = makeAssortmentDecisionEvaluationUnavailable();
    const invalid = yield* Effect.flip(
      evaluation.evaluateVisibility(
        { ...visibilityRequest, principalRef: { principalId, tenantId } },
        { ...scope, principalId: '018f8b4e-35a2-7b51-8d56-91a4f37d6a13' },
      ),
    );
    expect(invalid.reason).toBe('TRUSTED_SCOPE_MISMATCH');
  }),
);

it('does not accept caller-authored trusted context fields in the wire contract', () => {
  expect(() =>
    Schema.decodeUnknownSync(AssortmentVisibilityEvaluationRequestSchema, { onExcessProperty: 'error' })({
      ...visibilityRequest,
      trustedContext: {
        channelRef: ref('commerce.channel', 'commerce.channel', 'web'),
        operationTime: '2026-09-23T10:00:00.000Z',
        sellingLegalEntityRef: ref('commerce.legal-entity', 'commerce.legal-entity', 'legal-entity-1'),
        tenantId,
      },
    }),
  ).toThrow();
});

it.effect('exposes the runtime service as an explicit fail-closed layer', () =>
  Effect.gen(function* serviceLayer() {
    const result = yield* AssortmentDecisionEvaluation.pipe(
      Effect.flatMap((evaluation) => evaluation.evaluateVisibility(visibilityRequest, scope)),
      Effect.provide(AssortmentDecisionEvaluationUnavailableLive),
    );
    expect(result.outcome).toBe('INDETERMINATE');
  }),
);

it('binds Decision Evidence fingerprints to the full pinned Set composition', () => {
  const setCompositionRevision = {
    ownerModuleId: 'catalog.owner',
    revision: 'composition-1',
    sourceRef: ref('catalog.owner', 'catalog.set-composition-revision', 'composition-1'),
  };
  const topLevelSelection = Schema.decodeUnknownSync(AssortmentCatalogSelectionSchema)({
    configuration: { kind: 'NONE' },
    productRef: ref('catalog.owner', 'catalog.product', 'set-product'),
    setCompositionRevision,
    variantKind: 'SET',
    variantRef: ref('catalog.owner', 'catalog.variant', 'set-variant'),
  });
  const composition = (componentId: string) =>
    Schema.decodeUnknownSync(AssortmentSetPurchaseCompositionSchema)({
      requiredComponents: [
        {
          catalogSelection: {
            configuration: { kind: 'NONE' },
            productRef: ref('catalog.owner', 'catalog.product', componentId),
            variantKind: 'ATOMIC',
            variantRef: ref('catalog.owner', 'catalog.variant', `${componentId}-variant`),
          },
          role: 'REQUIRED_COMPONENT',
        },
      ],
      setCompositionRevision,
    });
  const requestFor = (componentId: string) =>
    Schema.decodeUnknownSync(AssortmentPurchaseRequestSchema)({
      constituent: { catalogSelection: topLevelSelection, role: 'TOP_LEVEL' },
      decisionPurpose: 'PURCHASE',
      setComposition: composition(componentId),
      subject: canonicalPurchaseRequest.subject,
      trustedContext,
    });

  expect(assortmentDecisionRequestFingerprint(requestFor('component-1'))).not.toStrictEqual(
    assortmentDecisionRequestFingerprint(requestFor('component-2')),
  );
});

it.effect('retains actual unknowns when any exact Set constituent denies the conjunction', () =>
  Effect.gen(function* mixedSetDeny() {
    for (const mode of ['root-unknown', 'component-unknown', 'root-unevaluated'] as const) {
      const { constituents, internalRequest, wireRequest } = makeSetPurchaseFixture();
      let evaluated = constituents;
      if (mode === 'root-unknown') {
        evaluated = constituents.slice(0, 2);
      } else if (mode === 'root-unevaluated') {
        evaluated = constituents.slice(1);
      }
      const unknownIndex = mode === 'component-unknown' ? 1 : 0;
      const persisted: string[] = [];
      const source: AssortmentDecisionSourcePort = {
        resolvePurchase: () =>
          Effect.succeed({
            constituents: evaluated.map((constituent, index) => ({
              constituent,
              decision:
                index === unknownIndex
                  ? indeterminateDecision()
                  : decisionFor(
                      internalRequest,
                      index === evaluated.length - 1 ? 'INELIGIBLE' : 'ELIGIBLE',
                      constituent,
                    ),
              request: assortmentPurchaseConstituentRequest(internalRequest, constituent),
            })),
            decision: decisionFor(internalRequest, 'INELIGIBLE'),
            request: internalRequest,
          }),
        resolveVisibility: () => Effect.fail(dependencyFailure()),
      };
      const result = yield* makeAssortmentDecisionEvaluation(
        dependenciesFor(source, (input) => {
          const id = 'constituent' in input ? input.constituent.catalogSelection.variantRef.resourceId : 'visibility';
          persisted.push(id);
          return Effect.succeed(evidenceReference(`mixed-${id}`));
        }),
      ).evaluatePurchase(wireRequest, scope);
      expect(result.decision).toEqual({ outcome: 'INELIGIBLE', retryable: false, safeReasonCode: 'RULE_DENIED' });
      expect(result.consumerEvidence?.evaluatedConstituents.map((item) => item.constituent)).toEqual(evaluated);
      const unknown = result.consumerEvidence?.evaluatedConstituents[unknownIndex];
      expect(unknown).toEqual({
        constituent: evaluated[unknownIndex],
        outcome: 'INDETERMINATE',
        retryable: false,
        safeReasonCode: 'MISSING_CONFIGURATION',
      });
      expect(unknown !== undefined && 'decisionEvidence' in unknown).toBe(false);
      expect(persisted).toEqual(
        evaluated
          .filter((_, index) => index !== unknownIndex)
          .map((item) => item.catalogSelection.variantRef.resourceId),
      );
      const failedStore = yield* makeAssortmentDecisionEvaluation(
        dependenciesFor(source, () => Effect.fail(dependencyFailure())),
      ).evaluatePurchase(wireRequest, scope);
      expect(failedStore.decision.outcome).toBe('INDETERMINATE');
      expect(failedStore.consumerEvidence).toBeUndefined();
    }
  }),
);

it.effect('rejects root-bound component evidence and accepts complete evaluations in either order', () =>
  Effect.gen(function* exactComponentRequests() {
    const { constituents, internalRequest, wireRequest } = makeSetPurchaseFixture();
    for (const rootBound of [true, false]) {
      const source: AssortmentDecisionSourcePort = {
        resolvePurchase: () =>
          Effect.succeed({
            constituents: EffectArray.reverse(constituents).map((constituent) => ({
              constituent,
              decision: decisionFor(internalRequest, 'ELIGIBLE', constituent),
              request: rootBound ? internalRequest : assortmentPurchaseConstituentRequest(internalRequest, constituent),
            })),
            decision: decisionFor(internalRequest, 'ELIGIBLE'),
            request: internalRequest,
          }),
        resolveVisibility: () => Effect.fail(dependencyFailure()),
      };
      const result = yield* makeAssortmentDecisionEvaluation(dependenciesFor(source)).evaluatePurchase(
        wireRequest,
        scope,
      );
      expect(result.decision.outcome).toBe(rootBound ? 'INDETERMINATE' : 'ELIGIBLE');
    }
    const [, component] = constituents;
    if (component === undefined) {
      throw new Error('expected a pinned component');
    }
    const ownRequest = assortmentPurchaseConstituentRequest(internalRequest, component);
    expect(Schema.is(AssortmentPurchaseRequestSchema)(ownRequest)).toBe(true);
    expect(Schema.is(AssortmentPurchaseEvaluationRequestSchema)({ ...wireRequest, constituent: component })).toBe(
      false,
    );
    expect(
      Schema.is(AssortmentPurchaseRequestSchema)({ ...ownRequest, setComposition: internalRequest.setComposition }),
    ).toBe(false);
  }),
);

it.effect('compares separately decoded evidence instants by value for known and unknown results', () =>
  Effect.gen(function* equivalentEvidenceInstants() {
    const successful = decisionFor(canonicalVisibilityRequest, 'ELIGIBLE');
    if (successful.evidence === undefined) {
      throw new Error('expected successful fixture evidence');
    }
    for (const known of [true, false]) {
      for (const changedInstant of [false, true]) {
        const epoch = DateTime.toEpochMillis(canonicalVisibilityRequest.trustedContext.operationTime);
        const separatelyDecodedTime = Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)(
          new Date(epoch + (changedInstant ? 1 : 0)).toISOString(),
        );
        expect(separatelyDecodedTime).not.toBe(canonicalVisibilityRequest.trustedContext.operationTime);
        const actual = deepFreeze(
          Schema.decodeUnknownSync(Schema.toType(AssortmentGovernedDecisionSchema))({
            ...(known ? successful : indeterminateDecision()),
            evidence: { ...successful.evidence, operationTime: separatelyDecodedTime },
          }),
        );
        const result = yield* makeAssortmentDecisionEvaluation(
          dependenciesFor(visibilitySource(actual)),
        ).evaluateVisibility(visibilityRequest, scope);
        if (changedInstant) {
          expect(result).toMatchObject({ outcome: 'INDETERMINATE', safeReasonCode: 'DEPENDENCY_UNAVAILABLE' });
        } else {
          expect(result).toEqual(
            known
              ? { outcome: 'ELIGIBLE', retryable: false }
              : { outcome: 'INDETERMINATE', retryable: false, safeReasonCode: 'MISSING_CONFIGURATION' },
          );
        }
      }
    }
  }),
);
