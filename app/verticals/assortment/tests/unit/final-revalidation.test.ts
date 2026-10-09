import { expect, it } from 'effect-rstest';
import { Effect, Schema } from 'effect';

import {
  AssortmentCatalogSelectionSchema,
  AssortmentDependencyFailureError,
  AssortmentOwnerModuleIdSchema,
  AssortmentOwnerResourceRefSchema,
  AssortmentPurchaseConstituentSchema,
} from '../../shared/domain/decision-contracts.ts';
import {
  AssortmentFactCurrentnessRequestSchema,
  AssortmentFactCurrentnessResultSchema,
  AssortmentSetCompletenessRequestSchema,
  AssortmentSetCompletenessResultSchema,
  AssortmentSetCompositionRequestSchema,
  AssortmentSetCompositionResolutionSchema,
} from '../../shared/domain/ports/owner-evidence.ts';
import {
  AssortmentRevalidationAttemptSchema,
  revalidateAssortmentAttempt,
  revalidateAssortmentConstituents,
} from '../../shared/domain/final-revalidation.ts';
import type { AssortmentFinalRevalidationOptions } from '../../shared/domain/final-revalidation.ts';

const tenantId = '018f8b4e-35a2-7b51-8d56-91a4f37d6a11';
const operationTime = '2026-09-22T10:00:00.000Z';

const ref = (moduleId: string, resourceType: string, resourceId: string) =>
  Schema.decodeUnknownSync(AssortmentOwnerResourceRefSchema)({
    moduleId,
    resourceId,
    resourceType,
    tenantId,
  });

const productRef = ref('catalog.owner', 'catalog.product', 'product-1');
const subject = {
  kind: 'IDENTIFIED' as const,
  subject: {
    kind: 'RETAIL_CUSTOMER_PROFILE' as const,
    profileRef: ref('commerce.customer-context', 'commerce.customer-context.retail-customer-profile', 'profile-1'),
  },
};
const trustedContext = {
  channelRef: ref('commerce.channel', 'commerce.channel', 'web'),
  operationTime,
  sellingLegalEntityRef: ref('commerce.legal-entity', 'commerce.legal-entity', 'sle-1'),
  tenantId,
};
const target = { kind: 'PRODUCT' as const, productRef };

const evidenceProof = (resourceId: string, resourceType = 'commerce.assortment.proof') => ({
  evidenceRef: ref('commerce.assortment', resourceType, resourceId),
  ownerModuleId: 'commerce.assortment' as const,
});

const factRequest = (resourceId: string, resourceType = 'commerce.assortment.fact') => ({
  ...Schema.decodeUnknownSync(AssortmentFactCurrentnessRequestSchema)({
    factRef: ref('commerce.assortment', resourceType, resourceId),
    observedAt: operationTime,
    tenantId,
  }),
});

const setRequest = (resourceId: string) => ({
  ...Schema.decodeUnknownSync(AssortmentSetCompletenessRequestSchema)({
    asOf: operationTime,
    predicate: 'all current governing facts',
    scope: 'exact-tenant-subject-purpose',
    scopeRef: ref('commerce.assortment', 'commerce.assortment.scope', resourceId),
    tenantId,
  }),
});

const makeAttempt = (options: {
  readonly fact?: ReturnType<typeof factRequest>;
  readonly factProof?: ReturnType<typeof evidenceProof>;
  readonly outcome?: 'ELIGIBLE' | 'INELIGIBLE';
  readonly set?: ReturnType<typeof setRequest>;
  readonly setProof?: ReturnType<typeof evidenceProof>;
}) =>
  Schema.decodeUnknownSync(AssortmentRevalidationAttemptSchema)({
    decision: {
      evidence: {
        factCurrentness:
          options.fact === undefined || options.factProof === undefined
            ? []
            : [
                {
                  factRef: options.fact.factRef,
                  proof: options.factProof,
                  state: 'CURRENT',
                },
              ],
        operationTime,
        setCompleteness:
          options.set === undefined || options.setProof === undefined
            ? []
            : [
                {
                  predicate: options.set.predicate,
                  proof: options.setProof,
                  scope: options.set.scope,
                  state: 'COMPLETE',
                },
              ],
        subject,
        target,
        trustedContext,
      },
      outcome: options.outcome ?? 'ELIGIBLE',
    },
    factRequests: options.fact === undefined ? [] : [{ ...options.fact, observedAt: operationTime }],
    setRequests: options.set === undefined ? [] : [{ ...options.set, asOf: operationTime }],
  });

const verifyFact = (request: ReturnType<typeof factRequest>, proof: ReturnType<typeof evidenceProof>) =>
  Schema.decodeUnknownSync(AssortmentFactCurrentnessResultSchema)({
    evidence: {
      factRef: request.factRef,
      proof,
      state: 'CURRENT',
    },
    observedAt: operationTime,
  });

const verifySet = (proof: ReturnType<typeof evidenceProof>) =>
  Schema.decodeUnknownSync(AssortmentSetCompletenessResultSchema)({
    evidence: {
      predicate: 'all current governing facts',
      proof,
      scope: 'exact-tenant-subject-purpose',
      state: 'COMPLETE',
    },
  });

const ownerEvidence = (options: {
  readonly factProof?: (request: ReturnType<typeof factRequest>) => ReturnType<typeof evidenceProof>;
  readonly setProof?: (request: ReturnType<typeof setRequest>) => ReturnType<typeof evidenceProof>;
}): AssortmentFinalRevalidationOptions['ownerEvidence'] => ({
  resolveSetComposition: () => Effect.die('composition resolver not configured'),
  verifyFactCurrentness: (request: ReturnType<typeof factRequest>) =>
    Effect.succeed(verifyFact(request, options.factProof?.(request) ?? evidenceProof('fact-proof'))),
  verifySetCompleteness: (request: ReturnType<typeof setRequest>) =>
    Effect.succeed(verifySet(options.setProof?.(request) ?? evidenceProof('set-proof'))),
});

const evaluate = (options: Parameters<typeof revalidateAssortmentAttempt>[0]) => revalidateAssortmentAttempt(options);

it.effect('publishes only after every material fact and set proof remains unchanged', () =>
  Effect.gen(function* publishesAfterEveryProofRemainsCurrent() {
    const fact = factRequest('boundary-proof');
    const set = setRequest('boundary-scope');
    const proof = evidenceProof('proof-1');
    const result = yield* evaluate({
      buildAttempt: () => Effect.succeed(makeAttempt({ fact, factProof: proof, set, setProof: proof })),
      maxAttempts: 2,
      ownerEvidence: ownerEvidence({ factProof: () => proof, setProof: () => proof }),
    });

    expect(result).toMatchObject({ attempts: 1, decision: { outcome: 'ELIGIBLE' }, kind: 'PUBLISHED' });
  }),
);

it.effect('discards changed Boundary, Candidate, Category, and Membership proofs', () =>
  Effect.all(
    (
      [
        ['boundary', 'commerce.assortment.boundary-fact'],
        ['candidate', 'commerce.assortment.candidate-fact'],
        ['category', 'catalog.category-classification-fact'],
        ['membership', 'commerce.customer-context.membership-fact'],
      ] as const
    ).map((proofCase) => {
      const [, resourceType] = proofCase;
      return Effect.gen(function* rerunsTheCompleteAttempt() {
        const fact = factRequest('fact-1', resourceType);
        const oldProof = evidenceProof('old-proof');
        const newProof = evidenceProof('new-proof');
        let builds = 0;
        const result = yield* evaluate({
          buildAttempt: () => {
            builds += 1;
            const proof = builds === 1 ? oldProof : newProof;
            return Effect.succeed(makeAttempt({ fact, factProof: proof }));
          },
          maxAttempts: 2,
          ownerEvidence: ownerEvidence({ factProof: () => newProof }),
        });

        expect(result).toMatchObject({ attempts: 2, decision: { outcome: 'ELIGIBLE' }, kind: 'PUBLISHED' });
        expect(builds).toBe(2);
      });
    }),
  ),
);

it.effect('does not retry when maxAttempts is one and publishes no stale decision evidence', () =>
  Effect.gen(function* stopsAtOneAttempt() {
    const fact = factRequest('fact-1');
    let builds = 0;
    const result = yield* evaluate({
      buildAttempt: () => {
        builds += 1;
        return Effect.succeed(makeAttempt({ fact, factProof: evidenceProof('old-proof') }));
      },
      maxAttempts: 1,
      ownerEvidence: ownerEvidence({ factProof: () => evidenceProof('new-proof') }),
    });

    expect(result).toMatchObject({ attempts: 1, decision: { outcome: 'INDETERMINATE' }, kind: 'INDETERMINATE' });
    if (result.kind === 'INDETERMINATE') {
      expect('evidence' in result.decision ? result.decision.evidence : undefined).toBeUndefined();
    }
    expect(builds).toBe(1);
  }),
);

it.effect('rejects a non-positive maxAttempts before building any attempt', () =>
  Effect.gen(function* rejectsInvalidAttemptLimits() {
    let builds = 0;
    const failure = yield* Effect.flip(
      evaluate({
        buildAttempt: () => {
          builds += 1;
          return Effect.succeed(makeAttempt({}));
        },
        maxAttempts: 0,
        ownerEvidence: ownerEvidence({}),
      }),
    );
    expect(failure).toBeDefined();
    expect(builds).toBe(0);
  }),
);

it.effect('exhausts after exactly maxAttempts when revisions keep changing', () =>
  Effect.gen(function* exhaustsAtTheConfiguredLimit() {
    const fact = factRequest('fact-1');
    let builds = 0;
    const result = yield* evaluate({
      buildAttempt: () => {
        builds += 1;
        return Effect.succeed(makeAttempt({ fact, factProof: evidenceProof(`proof-${builds}`) }));
      },
      maxAttempts: 3,
      ownerEvidence: ownerEvidence({ factProof: () => evidenceProof('different-proof') }),
    });

    expect(result).toMatchObject({ attempts: 3, decision: { outcome: 'INDETERMINATE' }, kind: 'INDETERMINATE' });
    expect(builds).toBe(3);
  }),
);

it.effect('revalidates an authoritative deny before allowing deny short-circuit publication', () =>
  Effect.gen(function* revalidatesAnAuthoritativeDeny() {
    const fact = factRequest('deny-fact');
    const oldProof = evidenceProof('old-proof');
    const newProof = evidenceProof('new-proof');
    let builds = 0;
    let verifications = 0;
    const result = yield* evaluate({
      buildAttempt: () => {
        builds += 1;
        return Effect.succeed(
          makeAttempt({ fact, factProof: builds === 1 ? oldProof : newProof, outcome: 'INELIGIBLE' }),
        );
      },
      maxAttempts: 2,
      ownerEvidence: {
        ...ownerEvidence({ factProof: () => newProof }),
        verifyFactCurrentness: (request) => {
          verifications += 1;
          return Effect.succeed(verifyFact(request, newProof));
        },
      },
    });

    expect(result).toMatchObject({ attempts: 2, decision: { outcome: 'INELIGIBLE' }, kind: 'PUBLISHED' });
    expect(verifications).toBe(2);
  }),
);

it.effect('returns typed dependency failure without retrying or retaining stale evidence', () =>
  Effect.gen(function* stopsOnDependencyFailure() {
    let builds = 0;
    const failure = new AssortmentDependencyFailureError({
      code: 'DEPENDENCY_FAILURE',
      ownerModuleId: Schema.decodeUnknownSync(AssortmentOwnerModuleIdSchema)('catalog.owner'),
      retryable: true,
      safeReasonCode: 'DEPENDENCY_UNAVAILABLE',
    });
    const result = yield* evaluate({
      buildAttempt: () => {
        builds += 1;
        return Effect.succeed(makeAttempt({ fact: factRequest('fact-1'), factProof: evidenceProof('proof-1') }));
      },
      maxAttempts: 3,
      ownerEvidence: {
        ...ownerEvidence({}),
        verifyFactCurrentness: () => Effect.fail(failure),
      },
    });

    expect(result).toMatchObject({ attempts: 1, decision: { outcome: 'INDETERMINATE' }, kind: 'INDETERMINATE' });
    if (result.kind === 'INDETERMINATE') {
      expect('failure' in result.decision && Schema.is(AssortmentDependencyFailureError)(result.decision.failure)).toBe(
        true,
      );
      expect('evidence' in result.decision ? result.decision.evidence : undefined).toBeUndefined();
    }
    expect(builds).toBe(1);
  }),
);

it.effect('reruns only affected constituents and fans out a shared proof race independently', () =>
  Effect.gen(function* rerunsAffectedConstituents() {
    const oldProof = evidenceProof('shared-old');
    const newProof = evidenceProof('shared-new');
    const buildCounts = new Map<string, number>();
    const makeConstituent = (key: string, proof: ReturnType<typeof evidenceProof>) => ({
      buildAttempt: () => {
        const count = (buildCounts.get(key) ?? 0) + 1;
        buildCounts.set(key, count);
        return Effect.succeed(
          makeAttempt({
            fact: factRequest(key),
            factProof: key === 'affected' && count > 1 ? newProof : proof,
          }),
        );
      },
      key,
      maxAttempts: 2,
      ownerEvidence: ownerEvidence({
        factProof: (request) => (request.factRef.resourceId === 'affected' ? newProof : oldProof),
      }),
    });
    const affectedOnly = yield* revalidateAssortmentConstituents([
      makeConstituent('affected', oldProof),
      makeConstituent('stable', oldProof),
    ]);

    expect(affectedOnly.every((item) => item.result.kind === 'PUBLISHED')).toBe(true);
    expect(buildCounts).toEqual(
      new Map([
        ['affected', 2],
        ['stable', 1],
      ]),
    );

    const sharedCounts = new Map<string, number>();
    const shared = (key: string) => ({
      buildAttempt: () => {
        const count = (sharedCounts.get(key) ?? 0) + 1;
        sharedCounts.set(key, count);
        return Effect.succeed(makeAttempt({ fact: factRequest('shared'), factProof: count > 1 ? newProof : oldProof }));
      },
      key,
      maxAttempts: 2,
      ownerEvidence: ownerEvidence({ factProof: () => newProof }),
    });
    const fanout = yield* revalidateAssortmentConstituents([shared('one'), shared('two')]);
    expect(fanout.every((item) => item.result.kind === 'PUBLISHED')).toBe(true);
    expect(sharedCounts).toEqual(
      new Map([
        ['one', 2],
        ['two', 2],
      ]),
    );
  }),
);

it.effect('reruns the whole attempt when the pinned Set Composition revision changes', () =>
  Effect.gen(function* rerunsWhenCompositionRevisionChanges() {
    const compositionRef = (revision: string) => ({
      ownerModuleId: 'catalog.owner' as const,
      revision,
      sourceRef: ref('catalog.owner', 'catalog.set-composition-revision', revision),
    });
    const setSelection = (revision: string) =>
      Schema.decodeUnknownSync(AssortmentCatalogSelectionSchema)({
        configuration: { kind: 'NONE' },
        productRef,
        setCompositionRevision: compositionRef(revision),
        variantKind: 'SET',
        variantRef: ref('catalog.owner', 'catalog.variant', 'set-variant'),
      });
    const component = Schema.decodeUnknownSync(AssortmentPurchaseConstituentSchema)({
      catalogSelection: {
        configuration: { kind: 'NONE' },
        productRef,
        variantKind: 'ATOMIC',
        variantRef: ref('catalog.owner', 'catalog.variant', 'component'),
      },
      role: 'REQUIRED_COMPONENT',
    });
    const composition = (revision: string) =>
      Schema.decodeUnknownSync(AssortmentSetCompositionResolutionSchema)({
        composition: { requiredComponents: [component], setCompositionRevision: compositionRef(revision) },
        source: {
          evidenceRef: ref('catalog.owner', 'catalog.set-composition-evidence', revision),
          ownerModuleId: 'catalog.owner',
          sourceRevision: compositionRef(revision),
        },
      });
    let builds = 0;
    const result = yield* evaluate({
      buildAttempt: () => {
        builds += 1;
        const revision = builds === 1 ? 'revision-1' : 'revision-2';
        const selection = setSelection(revision);
        const compositionRequest = Schema.decodeUnknownSync(AssortmentSetCompositionRequestSchema)({
          selection,
          tenantId,
        });
        return Effect.succeed({
          ...makeAttempt({}),
          compositionRequest,
          compositionResolution: composition(revision),
        });
      },
      maxAttempts: 2,
      ownerEvidence: {
        ...ownerEvidence({}),
        resolveSetComposition: (_request) => Effect.succeed(composition('revision-2')),
      },
    });

    expect(result).toMatchObject({ attempts: 2, decision: { outcome: 'ELIGIBLE' }, kind: 'PUBLISHED' });
    expect(builds).toBe(2);
  }),
);
