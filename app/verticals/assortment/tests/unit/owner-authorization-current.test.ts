import { failClosedOwnerAuthorizationOverlay, OwnerAuthorizationOverlay } from '@app/core-runtime';
import type {
  OperationalScope,
  OwnerAuthorizationInput,
  OwnerAuthorizationOverlayService,
  ScopedTransactionExecutor,
} from '@app/core-runtime';
import { Context, DateTime, Effect, Layer, Option } from 'effect';
import { expect, it } from 'effect-rstest';
import { withAssortmentOwnerAuthorizationOverlay } from '../../api/index.ts';
import {
  assortmentAuthorizationCurrentForTransaction,
  assortmentCurrentnessFacts,
  assortmentCurrentnessTargetFromFacts,
  assortmentOwnerAuthorizationOverlay,
} from '../../src/services/assortment-currentness.ts';
import type { AssortmentCurrentnessTarget } from '../../src/services/assortment-currentness.ts';
import { historicalOwnerTarget } from '../../../../packages/core-runtime/tests/support/historical-owner-targets.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '30000000-0000-4000-8000-000000000001';
const scope = {
  authContextRef: 'owner-current-test',
  authMethod: 'session',
  correlationId: 'owner-current-test',
  legalEntityId,
  principalId: '20000000-0000-4000-8000-000000000001',
  tenantId,
} satisfies OperationalScope;
const at = new Date('2026-09-28T09:00:00.000Z');
const futureAt = new Date('2099-01-01T00:00:00.000Z');
const operationAt = DateTime.makeUnsafe(at);
const afterFutureAt = DateTime.makeUnsafe(futureAt);
const stableRule = {
  createdAt: at,
  stableCode: 'policy.example',
  stableRuleId: 'stable-rule-1',
  tenantId,
};
const stableRuleTarget = {
  moduleId: 'commerce.assortment',
  resourceId: 'stable-rule-1',
  resourceType: 'commerce.assortment.stable-rule',
  tenantId,
} as const;
const revisionTarget = {
  effect: 'ALLOW',
  kind: 'assortment_rule',
  mode: 'revision_create',
  purpose: 'PURCHASE',
  selectorKind: 'ALL',
  stableRule: stableRuleTarget,
} as const;

const query = <Rows extends readonly object[]>(rows: Rows | Effect.Effect<Rows, unknown>) => {
  const effect = (Effect.isEffect(rows) ? rows : Effect.succeed(rows)) as Effect.Effect<Rows> & {
    from: () => typeof effect;
    limit: () => typeof effect;
    where: () => typeof effect;
  };
  effect.from = () => effect;
  effect.limit = () => effect;
  effect.where = () => effect;
  return effect;
};
const transaction = (selects: readonly (readonly object[] | Effect.Effect<readonly object[], unknown>)[]) => {
  let index = 0;
  return {
    scope: { legalEntityId, tenantId },
    select: () => {
      const current = index;
      index += 1;
      return query(selects[current] ?? []);
    },
  } as unknown as ScopedTransactionExecutor;
};

it.effect('rejects an authorization scope that differs from the installed transaction scope', () =>
  Effect.gen(function* rejectsCrossScope() {
    const result = yield* assortmentAuthorizationCurrentForTransaction(transaction([[stableRule], []])).assess({
      operationAt,
      scope: { ...scope, tenantId: '90000000-0000-4000-8000-000000000009' },
      target: revisionTarget,
    });
    expect(result).toEqual({ reason: 'local_currentness_unavailable', status: 'UNAVAILABLE' });
  }),
);

it.effect('proves a current self-contained stable Rule and ALL revision target', () =>
  Effect.gen(function* currentRule() {
    const service = assortmentAuthorizationCurrentForTransaction(transaction([[stableRule], []]));
    const result = yield* service.assess({
      operationAt,
      scope,
      target: {
        kind: 'assortment_rule',
        mode: 'retire',
        stableRule: stableRuleTarget,
      },
    });
    expect(result.status).toBe('CURRENT');

    const revision = yield* assortmentAuthorizationCurrentForTransaction(transaction([[stableRule], []])).assess({
      operationAt,
      scope,
      target: revisionTarget,
    });
    expect(revision.status).toBe('CURRENT');
  }),
);

it.effect('evaluates Rule retirement at the trusted operation time', () =>
  Effect.gen(function* retirementTime() {
    const futureRetirement = yield* assortmentAuthorizationCurrentForTransaction(
      transaction([[stableRule], [{ retiredAt: futureAt }]]),
    ).assess({
      operationAt,
      scope,
      target: {
        kind: 'assortment_rule',
        mode: 'retire',
        stableRule: stableRuleTarget,
      },
    });
    expect(futureRetirement.status).toBe('CURRENT');

    const effectiveRetirement = yield* assortmentAuthorizationCurrentForTransaction(
      transaction([[stableRule], [{ retiredAt: futureAt }]]),
    ).assess({
      operationAt: afterFutureAt,
      scope,
      target: {
        kind: 'assortment_rule',
        mode: 'retire',
        stableRule: stableRuleTarget,
      },
    });
    expect(effectiveRetirement).toEqual({ reason: 'rule_retired', status: 'NOT_CURRENT' });

    const retirementAtInstant = yield* assortmentAuthorizationCurrentForTransaction(
      transaction([[stableRule], [{ retiredAt: futureAt }]]),
    ).assess({
      operationAt: afterFutureAt,
      scope,
      target: {
        kind: 'assortment_rule',
        mode: 'retire',
        stableRule: stableRuleTarget,
      },
    });
    expect(retirementAtInstant).toEqual({ reason: 'rule_retired', status: 'NOT_CURRENT' });

    const unavailable = yield* assortmentAuthorizationCurrentForTransaction(transaction([])).assess({
      operationAt,
      scope,
      target: {
        kind: 'assortment_rule',
        mode: 'retire',
        stableRule: stableRuleTarget,
      },
    });
    expect(unavailable).toEqual({ reason: 'local_currentness_unavailable', status: 'UNAVAILABLE' });
  }),
);

it.effect('keeps Catalog-dependent Rule targets unavailable without foreign Currentness', () =>
  Effect.gen(function* foreignSelector() {
    const result = yield* assortmentAuthorizationCurrentForTransaction(transaction([[stableRule], []])).assess({
      operationAt,
      scope,
      target: { ...revisionTarget, selectorKind: 'PRODUCT' },
    });
    expect(result).toEqual({ reason: 'foreign_currentness_unavailable', status: 'UNAVAILABLE' });
  }),
);

it.effect('evaluates Boundary intervals and keeps live foreign references unavailable', () =>
  Effect.gen(function* boundaryEnd() {
    const boundary = {
      channelResourceId: 'channel-1',
      closedBoundaryId: 'boundary-1',
      effectiveFrom: at,
      legalEntityId,
      marketResourceId: null,
      purpose: 'PURCHASE',
      semanticFingerprint: 'b'.repeat(64),
      storefrontResourceId: null,
      subjectKind: 'COUNTERPARTY',
      subjectResourceId: 'counterparty-1',
      tenantId,
    };
    const target = {
      boundary: {
        moduleId: 'commerce.assortment',
        resourceId: 'boundary-1',
        resourceType: 'commerce.assortment.closed-assortment-boundary',
        tenantId,
      },
      kind: 'assortment_boundary',
      mode: 'end',
    } as const;
    const ended = yield* assortmentAuthorizationCurrentForTransaction(
      transaction([[boundary], [{ effectiveTo: futureAt }]]),
    ).assess({ operationAt, scope, target });
    expect(ended).toEqual({ reason: 'foreign_currentness_unavailable', status: 'UNAVAILABLE' });

    const effectiveEnd = yield* assortmentAuthorizationCurrentForTransaction(
      transaction([[boundary], [{ effectiveTo: futureAt }]]),
    ).assess({ operationAt: afterFutureAt, scope, target });
    expect(effectiveEnd).toEqual({ reason: 'resource_ended', status: 'NOT_CURRENT' });

    const notYetEffective = yield* assortmentAuthorizationCurrentForTransaction(
      transaction([[{ ...boundary, effectiveFrom: futureAt }], []]),
    ).assess({ operationAt, scope, target });
    expect(notYetEffective).toEqual({ reason: 'resource_not_yet_effective', status: 'NOT_CURRENT' });

    const startsAtInstant = yield* assortmentAuthorizationCurrentForTransaction(
      transaction([[{ ...boundary, effectiveFrom: futureAt }], []]),
    ).assess({ operationAt: afterFutureAt, scope, target });
    expect(startsAtInstant).toEqual({ reason: 'foreign_currentness_unavailable', status: 'UNAVAILABLE' });

    const active = yield* assortmentAuthorizationCurrentForTransaction(transaction([[boundary], []])).assess({
      operationAt,
      scope,
      target,
    });
    expect(active).toEqual({ reason: 'foreign_currentness_unavailable', status: 'UNAVAILABLE' });
  }),
);

it.effect('evaluates Binding intervals while preserving foreign failure for active rows', () =>
  Effect.gen(function* bindingEnd() {
    const binding = {
      applicabilityBindingId: 'binding-1',
      bindingKind: 'SHARED',
      channelResourceId: 'channel-1',
      customerGroupResourceId: null,
      effectiveFrom: at,
      legalEntityId,
      marketResourceId: null,
      ruleRevisionId: 'rule-revision-1',
      storefrontResourceId: null,
      subjectKind: null,
      subjectResourceId: null,
      tenantId,
    };
    const revision = {
      effect: 'ALLOW',
      purpose: 'PURCHASE',
      recordedAt: at,
      revisionNumber: 1,
      ruleRevisionId: 'rule-revision-1',
      selectorKind: 'ALL',
      semanticFingerprint: 'a'.repeat(64),
      tenantId,
    };
    const target = {
      binding: {
        moduleId: 'commerce.assortment',
        resourceId: 'binding-1',
        resourceType: 'commerce.assortment.applicability-binding',
        tenantId,
      },
      kind: 'assortment_binding',
      mode: 'end',
    } as const;
    const ended = yield* assortmentAuthorizationCurrentForTransaction(
      transaction([[binding], [revision], [{ effectiveTo: futureAt }]]),
    ).assess({ operationAt, scope, target });
    expect(ended).toEqual({ reason: 'foreign_currentness_unavailable', status: 'UNAVAILABLE' });

    const effectiveEnd = yield* assortmentAuthorizationCurrentForTransaction(
      transaction([[binding], [revision], [{ effectiveTo: futureAt }]]),
    ).assess({ operationAt: afterFutureAt, scope, target });
    expect(effectiveEnd).toEqual({ reason: 'resource_ended', status: 'NOT_CURRENT' });

    const notYetEffective = yield* assortmentAuthorizationCurrentForTransaction(
      transaction([[{ ...binding, effectiveFrom: futureAt }], [revision], []]),
    ).assess({ operationAt, scope, target });
    expect(notYetEffective).toEqual({ reason: 'resource_not_yet_effective', status: 'NOT_CURRENT' });

    const active = yield* assortmentAuthorizationCurrentForTransaction(transaction([[binding], [revision], []])).assess(
      { operationAt, scope, target },
    );
    expect(active).toEqual({ reason: 'foreign_currentness_unavailable', status: 'UNAVAILABLE' });
  }),
);

const ownerInput = (
  target: AssortmentCurrentnessTarget | undefined,
  overrides: Partial<OwnerAuthorizationInput> = {},
): OwnerAuthorizationInput => {
  const request: OwnerAuthorizationInput = {
    capabilityKey: 'commerce.assortment.rule.revision.create',
    operation: 'action',
    operationAt,
    operationKey: 'commerce.assortment.rule.revision.create',
    owningModuleKey: 'commerce.assortment',
    scope,
    targets: [],
  };
  const ownerFacts = target === undefined ? {} : { ownerFacts: assortmentCurrentnessFacts(target) };
  return { ...request, ...ownerFacts, ...overrides };
};

const ruleRef = {
  moduleId: 'commerce.assortment',
  resourceId: 'stable-rule-1',
  resourceType: 'commerce.assortment.stable-rule',
} as const;
const revisionRef = {
  moduleId: 'commerce.assortment',
  resourceId: 'rule-revision-1',
  resourceType: 'commerce.assortment.rule-revision',
} as const;
const bindingRef = {
  moduleId: 'commerce.assortment',
  resourceId: 'binding-1',
  resourceType: 'commerce.assortment.applicability-binding',
} as const;
const boundaryRef = {
  moduleId: 'commerce.assortment',
  resourceId: 'boundary-1',
  resourceType: 'commerce.assortment.closed-assortment-boundary',
} as const;

it('round-trips every Current question through the owner facts the descriptor declares', () => {
  const targets: readonly AssortmentCurrentnessTarget[] = [
    { kind: 'assortment_configuration', resource: ruleRef },
    { kind: 'assortment_decision' },
    { kind: 'assortment_rule', mode: 'create', selectorKind: 'PRODUCT' },
    { kind: 'assortment_fixture', selectorKind: 'PRODUCT' },
    { kind: 'assortment_rule', mode: 'revision_create', selectorKind: 'ALL', stableRule: ruleRef },
    { kind: 'assortment_rule', mode: 'retire', stableRule: ruleRef },
    { kind: 'assortment_binding', mode: 'create', ruleRevision: revisionRef },
    { binding: bindingRef, kind: 'assortment_binding', mode: 'end' },
    { binding: bindingRef, kind: 'assortment_binding', mode: 'replace', ruleRevision: revisionRef },
    { kind: 'assortment_boundary', mode: 'create' },
    { boundary: boundaryRef, kind: 'assortment_boundary', mode: 'end' },
    { boundary: boundaryRef, kind: 'assortment_boundary', mode: 'replace' },
  ];
  for (const target of targets) {
    expect(assortmentCurrentnessTargetFromFacts(assortmentCurrentnessFacts(target))).toStrictEqual(target);
  }
});

it('never invents a Current question from incomplete or unknown owner facts', () => {
  expect(assortmentCurrentnessTargetFromFacts()).toBeUndefined();
  expect(assortmentCurrentnessTargetFromFacts({})).toBeUndefined();
  expect(assortmentCurrentnessTargetFromFacts({ 'assortment.currentness.kind': 'assortment_unknown' })).toBeUndefined();
  expect(
    assortmentCurrentnessTargetFromFacts({
      'assortment.currentness.kind': 'assortment_rule',
      'assortment.currentness.mode': 'retire',
    }),
  ).toBeUndefined();
  expect(
    assortmentCurrentnessTargetFromFacts({
      'assortment.currentness.kind': 'assortment_binding',
      'assortment.currentness.mode': 'replace',
      'assortment.currentness.recordId': bindingRef.resourceId,
      'assortment.currentness.recordModuleKey': bindingRef.moduleId,
      'assortment.currentness.recordType': bindingRef.resourceType,
    }),
  ).toBeUndefined();
});

const configurationTarget = {
  kind: 'assortment_configuration',
  resource: stableRuleTarget,
} as const;
const allRevision = {
  effect: 'ALLOW',
  purpose: 'PURCHASE',
  recordedAt: at,
  revisionNumber: 1,
  ruleRevisionId: 'rule-revision-1',
  selectorKind: 'ALL',
  semanticFingerprint: 'a'.repeat(64),
  tenantId,
};

it.effect('allows only currently provable local Rule and ALL Revision targets through the overlay', () =>
  Effect.gen(function* allowsOwnedCurrent() {
    const retireTarget = {
      kind: 'assortment_rule',
      mode: 'retire',
      stableRule: stableRuleTarget,
    } as const;
    for (const target of [retireTarget, revisionTarget, configurationTarget]) {
      expect(
        yield* assortmentOwnerAuthorizationOverlay.authorize(transaction([[stableRule], []]), ownerInput(target)),
      ).toBe('allowed');
    }
    const revisionConfiguration = {
      ...configurationTarget,
      resource: {
        moduleId: 'commerce.assortment',
        resourceId: 'rule-revision-1',
        resourceType: 'commerce.assortment.rule-revision',
      },
    } as const;
    expect(
      yield* assortmentOwnerAuthorizationOverlay.authorize(
        transaction([[allRevision]]),
        ownerInput(revisionConfiguration, { operation: 'read' }),
      ),
    ).toBe('allowed');
  }),
);

it.effect('uses Core operationAt for retired Rule denial and permits a not-yet-effective retirement', () =>
  Effect.gen(function* overlayTrustedTime() {
    expect(
      yield* assortmentOwnerAuthorizationOverlay.authorize(
        transaction([[stableRule], [{ retiredAt: futureAt }]]),
        ownerInput(revisionTarget),
      ),
    ).toBe('allowed');
    expect(
      yield* assortmentOwnerAuthorizationOverlay.authorize(
        transaction([[stableRule], [{ retiredAt: futureAt }]]),
        ownerInput(revisionTarget, { operationAt: afterFutureAt }),
      ),
    ).toBe('denied');
    expect(yield* assortmentOwnerAuthorizationOverlay.authorize(transaction([]), ownerInput(revisionTarget))).toBe(
      'unavailable',
    );
    expect(
      yield* assortmentOwnerAuthorizationOverlay.authorize(
        transaction([Effect.fail('owner persistence unavailable')]),
        ownerInput(revisionTarget),
      ),
    ).toBe('unavailable');
  }),
);

it.effect('denies known future or ended Boundary state without promoting live foreign state', () =>
  Effect.gen(function* overlayBoundaryTime() {
    const boundary = {
      channelResourceId: 'channel-1',
      closedBoundaryId: 'boundary-1',
      effectiveFrom: futureAt,
      legalEntityId,
      marketResourceId: null,
      purpose: 'PURCHASE',
      semanticFingerprint: 'b'.repeat(64),
      storefrontResourceId: null,
      subjectKind: 'COUNTERPARTY',
      subjectResourceId: 'counterparty-1',
      tenantId,
    };
    const target = {
      boundary: {
        moduleId: 'commerce.assortment',
        resourceId: 'boundary-1',
        resourceType: 'commerce.assortment.closed-assortment-boundary',
      },
      kind: 'assortment_boundary',
      mode: 'end',
    } as const;
    expect(
      yield* assortmentOwnerAuthorizationOverlay.authorize(transaction([[boundary], []]), ownerInput(target)),
    ).toBe('denied');
    expect(
      yield* assortmentOwnerAuthorizationOverlay.authorize(
        transaction([[{ ...boundary, effectiveFrom: at }], [{ effectiveTo: futureAt }]]),
        ownerInput(target, { operationAt: afterFutureAt }),
      ),
    ).toBe('denied');
    expect(
      yield* assortmentOwnerAuthorizationOverlay.authorize(
        transaction([[{ ...boundary, effectiveFrom: at }], []]),
        ownerInput(target),
      ),
    ).toBe('unavailable');
  }),
);

it.effect('rejects wrong owner or installed scope and preserves the existing no-Legal-Entity configuration guard', () =>
  Effect.gen(function* overlayScopeGuards() {
    const noReads = transaction([Effect.die(new Error('Scope guards must run before owner reads'))]);
    for (const overrides of [
      { owningModuleKey: 'commerce.catalog' },
      { scope: { ...scope, tenantId: '90000000-0000-4000-8000-000000000009' } },
      { scope: { ...scope, legalEntityId: '90000000-0000-4000-8000-000000000009' } },
    ]) {
      expect(yield* assortmentOwnerAuthorizationOverlay.authorize(noReads, ownerInput(revisionTarget, overrides))).toBe(
        'unavailable',
      );
    }
    const { legalEntityId: _legalEntityId, ...tenantScope } = scope;
    const tenantTransaction = { ...noReads, scope: { tenantId } } as ScopedTransactionExecutor;
    expect(
      yield* assortmentOwnerAuthorizationOverlay.authorize(
        tenantTransaction,
        ownerInput(configurationTarget, { scope: tenantScope }),
      ),
    ).toBe('unavailable');
  }),
);

it.effect('keeps live Binding state unavailable even when its Revision is self-contained', () =>
  Effect.gen(function* liveBindingNeedsForeignCurrentness() {
    const binding = {
      applicabilityBindingId: 'binding-1',
      bindingKind: 'SHARED',
      channelResourceId: 'channel-1',
      customerGroupResourceId: null,
      effectiveFrom: at,
      legalEntityId,
      marketResourceId: null,
      ruleRevisionId: 'rule-revision-1',
      storefrontResourceId: null,
      subjectKind: null,
      subjectResourceId: null,
      tenantId,
    };
    const target = {
      binding: {
        moduleId: 'commerce.assortment',
        resourceId: 'binding-1',
        resourceType: 'commerce.assortment.applicability-binding',
        tenantId,
      },
      kind: 'assortment_binding',
      mode: 'end',
    } as const;
    expect(
      yield* assortmentOwnerAuthorizationOverlay.authorize(
        transaction([[binding], [allRevision], []]),
        ownerInput(target),
      ),
    ).toBe('unavailable');
  }),
);

it.effect('keeps proposed creation, Catalog-dependent and decision questions unavailable', () =>
  Effect.gen(function* unresolvedOwnerTargets() {
    const targets: readonly AssortmentCurrentnessTarget[] = [
      { kind: 'assortment_rule', mode: 'create', selectorKind: 'ALL' },
      { kind: 'assortment_fixture', selectorKind: 'PRODUCT' },
      { ...revisionTarget, selectorKind: 'PRODUCT' },
      { kind: 'assortment_decision' },
      { kind: 'assortment_boundary', mode: 'create' },
    ];
    for (const target of targets) {
      expect(
        yield* assortmentOwnerAuthorizationOverlay.authorize(transaction([[stableRule], []]), ownerInput(target)),
      ).toBe('unavailable');
    }
    // A Revision whose selector is Catalog-dependent proves no Current meaning for this owner yet.
    expect(
      yield* assortmentOwnerAuthorizationOverlay.authorize(
        transaction([
          [
            {
              ...allRevision,
              selectorKind: 'PRODUCT',
              selectorTargetOwnerModuleId: 'commerce.catalog',
              selectorTargetResourceId: 'product-1',
              selectorTargetResourceType: 'catalog.product',
            },
          ],
        ]),
        ownerInput({
          ...configurationTarget,
          resource: {
            moduleId: 'commerce.assortment',
            resourceId: 'rule-revision-1',
            resourceType: 'commerce.assortment.rule-revision',
          },
        }),
      ),
    ).toBe('unavailable');
  }),
);

it.effect('requires both ends of a Replacement to be Current', () =>
  Effect.gen(function* replacementConjunction() {
    const binding = {
      applicabilityBindingId: 'binding-1',
      bindingKind: 'SHARED',
      channelResourceId: 'channel-1',
      customerGroupResourceId: null,
      effectiveFrom: at,
      legalEntityId,
      marketResourceId: null,
      ruleRevisionId: 'rule-revision-1',
      storefrontResourceId: null,
      subjectKind: null,
      subjectResourceId: null,
      tenantId,
    };
    const replacement = {
      binding: {
        moduleId: 'commerce.assortment',
        resourceId: 'binding-1',
        resourceType: 'commerce.assortment.applicability-binding',
      },
      kind: 'assortment_binding',
      mode: 'replace',
      ruleRevision: {
        moduleId: 'commerce.assortment',
        resourceId: 'rule-revision-1',
        resourceType: 'commerce.assortment.rule-revision',
      },
    } as const;
    // The live Binding itself carries foreign references, so the replacement stays unavailable even
    // though its own Revision target cannot be proven either: one unprovable end is never ignored.
    expect(
      yield* assortmentOwnerAuthorizationOverlay.authorize(
        transaction([[binding], [allRevision], []]),
        ownerInput(replacement),
      ),
    ).toBe('unavailable');
    expect(
      yield* assortmentOwnerAuthorizationOverlay.authorize(
        transaction([Effect.fail('owner persistence unavailable')]),
        ownerInput(replacement),
      ),
    ).toBe('unavailable');
  }),
);

it.effect('leaves owner-neutral operations to the gate and fails closed on an unplaceable owner target', () =>
  Effect.gen(function* neutralFallback() {
    const noReads = transaction([Effect.die(new Error('Owner-neutral operations must not query Assortment state'))]);
    const neutral = ownerInput(undefined, { owningModuleKey: 'core.modules' });
    expect(yield* assortmentOwnerAuthorizationOverlay.authorize(noReads, neutral)).toBe(
      yield* failClosedOwnerAuthorizationOverlay.authorize(noReads, neutral),
    );
    expect(yield* assortmentOwnerAuthorizationOverlay.authorize(noReads, neutral)).toBe('allowed');
    // A leftover owner-held target the owner cannot place keeps Core's fail-closed default.
    const leftover = ownerInput(undefined, {
      targets: [
        {
          kind: 'owner_permission',
          target: historicalOwnerTarget('counterparty.read', {
            counterpartyId: 'counterparty-1',
            kind: 'counterparty',
            legalEntityId,
            tenantId,
          }),
        },
      ],
    });
    expect(yield* assortmentOwnerAuthorizationOverlay.authorize(noReads, leftover)).toBe('unavailable');
  }),
);

class InstalledOwnerRuntime extends Context.Service<InstalledOwnerRuntime, OwnerAuthorizationOverlayService>()(
  'assortment.tests/InstalledOwnerRuntime',
) {}

it.effect('installs the real owner overlay through the production read and action layer provision seam', () =>
  Effect.gen(function* productionOverlayProvision() {
    for (const operation of ['read', 'action'] as const) {
      const runtime = Layer.effect(
        InstalledOwnerRuntime,
        Effect.serviceOption(OwnerAuthorizationOverlay).pipe(
          Effect.map(Option.getOrElse(() => failClosedOwnerAuthorizationOverlay)),
        ),
      );
      const omitted = yield* InstalledOwnerRuntime.pipe(Effect.provide(runtime));
      // Without the owner adapter Core's own fail-closed default answers, and the Assortment rule is
      // the only owner-held state this module had: no adapter means no Assortment Current question.
      expect(yield* omitted.authorize(transaction([[stableRule], []]), ownerInput(revisionTarget, { operation }))).toBe(
        'allowed',
      );
      const installed = yield* InstalledOwnerRuntime.pipe(
        Effect.provide(withAssortmentOwnerAuthorizationOverlay(runtime)),
      );
      expect(
        yield* installed.authorize(transaction([[stableRule], []]), ownerInput(revisionTarget, { operation })),
      ).toBe('allowed');
      expect(yield* installed.authorize(transaction([]), ownerInput(revisionTarget, { operation }))).toBe(
        'unavailable',
      );
    }
  }),
);
