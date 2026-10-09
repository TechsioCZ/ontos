import { failClosedOwnerAuthorizationOverlay, OwnerAuthorizationOverlay } from '@app/core-runtime';
import type {
  AssortmentPermissionAccessTarget,
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
  assortmentOwnerAuthorizationOverlay,
} from '../../src/services/owner-authorization-current.ts';

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
  permission: 'assortment.rule.revision.create',
  purpose: 'PURCHASE',
  selector: { kind: 'ALL' },
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
        permission: 'assortment.rule.retire',
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
        permission: 'assortment.rule.retire',
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
        permission: 'assortment.rule.retire',
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
        permission: 'assortment.rule.retire',
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
        permission: 'assortment.rule.retire',
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
      target: {
        ...revisionTarget,
        selector: {
          kind: 'PRODUCT',
          target: {
            moduleId: 'commerce.catalog',
            resourceId: 'product-1',
            resourceType: 'catalog.product',
          },
        },
      },
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
      permission: 'assortment.boundary.end',
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
      permission: 'assortment.binding.end',
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
  targets: readonly AssortmentPermissionAccessTarget[],
  overrides: Partial<OwnerAuthorizationInput> = {},
): OwnerAuthorizationInput => ({
  operation: 'action',
  operationAt,
  operationKey: 'commerce.assortment.rule.revision.create',
  owningModuleKey: 'commerce.assortment',
  scope,
  targets: targets.map((target) => ({ kind: 'assortment_permission', target })),
  ...overrides,
});

const configurationTarget = {
  kind: 'assortment_configuration',
  permission: 'assortment.configuration.read',
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
      permission: 'assortment.rule.retire',
      stableRule: stableRuleTarget,
    } as const;
    for (const target of [retireTarget, revisionTarget, configurationTarget]) {
      expect(
        yield* assortmentOwnerAuthorizationOverlay.authorize(transaction([[stableRule], []]), ownerInput([target])),
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
        ownerInput([revisionConfiguration], { operation: 'read' }),
      ),
    ).toBe('allowed');
  }),
);

it.effect('uses Core operationAt for retired Rule denial and permits a not-yet-effective retirement', () =>
  Effect.gen(function* overlayTrustedTime() {
    expect(
      yield* assortmentOwnerAuthorizationOverlay.authorize(
        transaction([[stableRule], [{ retiredAt: futureAt }]]),
        ownerInput([revisionTarget]),
      ),
    ).toBe('allowed');
    expect(
      yield* assortmentOwnerAuthorizationOverlay.authorize(
        transaction([[stableRule], [{ retiredAt: futureAt }]]),
        ownerInput([revisionTarget], { operationAt: afterFutureAt }),
      ),
    ).toBe('denied');
    expect(yield* assortmentOwnerAuthorizationOverlay.authorize(transaction([]), ownerInput([revisionTarget]))).toBe(
      'unavailable',
    );
    expect(
      yield* assortmentOwnerAuthorizationOverlay.authorize(
        transaction([Effect.fail('owner persistence unavailable')]),
        ownerInput([revisionTarget]),
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
      permission: 'assortment.boundary.end',
    } as const;
    expect(
      yield* assortmentOwnerAuthorizationOverlay.authorize(transaction([[boundary], []]), ownerInput([target])),
    ).toBe('denied');
    expect(
      yield* assortmentOwnerAuthorizationOverlay.authorize(
        transaction([[{ ...boundary, effectiveFrom: at }], [{ effectiveTo: futureAt }]]),
        ownerInput([target], { operationAt: afterFutureAt }),
      ),
    ).toBe('denied');
    expect(
      yield* assortmentOwnerAuthorizationOverlay.authorize(
        transaction([[{ ...boundary, effectiveFrom: at }], []]),
        ownerInput([target]),
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
      expect(
        yield* assortmentOwnerAuthorizationOverlay.authorize(noReads, ownerInput([revisionTarget], overrides)),
      ).toBe('unavailable');
    }
    const { legalEntityId: _legalEntityId, ...tenantScope } = scope;
    const tenantTransaction = { ...noReads, scope: { tenantId } } as ScopedTransactionExecutor;
    expect(
      yield* assortmentOwnerAuthorizationOverlay.authorize(
        tenantTransaction,
        ownerInput([configurationTarget], { scope: tenantScope }),
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
      permission: 'assortment.binding.end',
    } as const;
    expect(
      yield* assortmentOwnerAuthorizationOverlay.authorize(
        transaction([[binding], [allRevision], []]),
        ownerInput([target]),
      ),
    ).toBe('unavailable');
  }),
);

it.effect('keeps proposed creation and Catalog-dependent or decision targets unavailable', () =>
  Effect.gen(function* unresolvedOwnerTargets() {
    const product = {
      moduleId: 'commerce.catalog',
      resourceId: 'product-1',
      resourceType: 'catalog.product',
    };
    const channel = { moduleId: 'commerce.channel', resourceId: 'channel-1', resourceType: 'commerce.channel.channel' };
    const targets: readonly AssortmentPermissionAccessTarget[] = [
      {
        effect: 'ALLOW',
        kind: 'assortment_rule',
        mode: 'create',
        permission: 'assortment.rule.create',
        purpose: 'PURCHASE',
        selector: { kind: 'ALL' },
        stableCode: 'proposed.rule',
      },
      { ...revisionTarget, selector: { kind: 'PRODUCT', target: product } },
      {
        catalogSelection: product,
        commercialScope: { channel },
        kind: 'assortment_decision',
        permission: 'assortment.decision.explain',
        purpose: 'VISIBILITY',
        subject: { kind: 'GUEST' },
      },
    ];
    for (const target of targets) {
      expect(
        yield* assortmentOwnerAuthorizationOverlay.authorize(transaction([[stableRule], []]), ownerInput([target])),
      ).toBe('unavailable');
    }
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
        ownerInput([
          {
            ...configurationTarget,
            resource: {
              moduleId: 'commerce.assortment',
              resourceId: 'rule-revision-1',
              resourceType: 'commerce.assortment.rule-revision',
            },
          },
        ]),
      ),
    ).toBe('unavailable');
  }),
);

it.effect('requires every alternative Current instead of borrowing Currentness across target grants', () =>
  Effect.gen(function* allAlternativesMustBeCurrent() {
    const secondRule = { ...stableRule, stableCode: 'policy.second', stableRuleId: 'stable-rule-2' };
    const secondTarget = { ...revisionTarget, stableRule: { ...stableRuleTarget, resourceId: 'stable-rule-2' } };
    const foreign = {
      ...revisionTarget,
      selector: {
        kind: 'PRODUCT',
        target: { moduleId: 'commerce.catalog', resourceId: 'product-1', resourceType: 'catalog.product' },
      },
    } as const;
    for (const targets of [
      [revisionTarget, foreign],
      [foreign, revisionTarget],
    ]) {
      expect(
        yield* assortmentOwnerAuthorizationOverlay.authorize(
          transaction([[stableRule], [], [stableRule], []]),
          ownerInput(targets),
        ),
      ).toBe('unavailable');
    }
    expect(
      yield* assortmentOwnerAuthorizationOverlay.authorize(
        transaction([[stableRule], [], [secondRule], [{ retiredAt: at }]]),
        ownerInput([revisionTarget, secondTarget]),
      ),
    ).toBe('denied');
    expect(
      yield* assortmentOwnerAuthorizationOverlay.authorize(
        transaction([[stableRule], [], [secondRule], []]),
        ownerInput([revisionTarget, secondTarget]),
      ),
    ).toBe('allowed');
  }),
);

it.effect('preserves Core fallback continuity for neutral targets and refuses other business targets', () =>
  Effect.gen(function* neutralFallback() {
    const noReads = transaction([Effect.die(new Error('Fallback targets must not query Assortment state'))]);
    const neutral: OwnerAuthorizationInput = ownerInput([], {
      owningModuleKey: 'core.modules',
      targets: [
        { kind: 'tenant', permission: 'access', tenantId },
        { kind: 'module', moduleId: 'commerce.assortment' },
        { kind: 'legal_entity', legalEntityId },
        { kind: 'resource', permission: 'read', resource: stableRuleTarget },
      ],
    });
    expect(yield* assortmentOwnerAuthorizationOverlay.authorize(noReads, neutral)).toBe(
      yield* failClosedOwnerAuthorizationOverlay.authorize(noReads, neutral),
    );
    expect(yield* assortmentOwnerAuthorizationOverlay.authorize(noReads, neutral)).toBe('allowed');
    const business = {
      kind: 'business_permission',
      permission: 'counterparty.read',
      target: { counterpartyId: 'counterparty-1', kind: 'counterparty', legalEntityId, tenantId },
    } as const;
    for (const targets of [
      [business],
      [business, { kind: 'assortment_permission' as const, target: revisionTarget }],
    ]) {
      expect(yield* assortmentOwnerAuthorizationOverlay.authorize(noReads, ownerInput([], { targets }))).toBe(
        'unavailable',
      );
    }
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
      expect(
        yield* omitted.authorize(transaction([[stableRule], []]), ownerInput([revisionTarget], { operation })),
      ).toBe('unavailable');
      const installed = yield* InstalledOwnerRuntime.pipe(
        Effect.provide(withAssortmentOwnerAuthorizationOverlay(runtime)),
      );
      expect(
        yield* installed.authorize(transaction([[stableRule], []]), ownerInput([revisionTarget], { operation })),
      ).toBe('allowed');
      expect(yield* installed.authorize(transaction([]), ownerInput([revisionTarget], { operation }))).toBe(
        'unavailable',
      );
    }
  }),
);
