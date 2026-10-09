import { expect, it } from 'effect-rstest';
import { Schema } from 'effect';

import {
  AssortmentCatalogSelectionSchema,
  AssortmentGovernedDecisionSchema,
  AssortmentMissingConfigurationError,
  AssortmentOwnerResourceRefSchema,
  AssortmentPurchaseConstituentSchema,
} from '../../shared/domain/decision-contracts.ts';
import { AssortmentSetCompositionResolutionSchema } from '../../shared/domain/ports/owner-evidence.ts';
import type { AssortmentPurchaseConstituent } from '../../shared/domain/decision-contracts.ts';
import {
  AssortmentSetPurchaseCompositionInputSchema,
  resolveAssortmentSetPurchase,
} from '../../shared/domain/set-purchase-composition.ts';

const tenantId = '018f8b4e-35a2-7b51-8d56-91a4f37d6a11';
const operationTime = '2026-09-22T10:00:00.000Z';

const ref = (moduleId: string, resourceType: string, resourceId: string) =>
  Schema.decodeUnknownSync(AssortmentOwnerResourceRefSchema)({
    moduleId,
    resourceId,
    resourceType,
    tenantId,
  });

const catalogRef = (resourceType: string, resourceId: string) => ref('catalog.owner', resourceType, resourceId);
const productRef = catalogRef('catalog.product', 'product-set');
const variantRef = (resourceId: string) => catalogRef('catalog.variant', resourceId);
const compositionRevision = (revision = 'composition-r1') => ({
  ownerModuleId: 'catalog.owner' as const,
  revision,
  sourceRef: catalogRef('catalog.set-composition-revision', revision),
});
const context = {
  channelRef: ref('commerce.channel', 'commerce.channel', 'web'),
  operationTime,
  sellingLegalEntityRef: ref('commerce.legal-entity', 'commerce.legal-entity', 'sle-1'),
  tenantId,
};
const subject = {
  kind: 'IDENTIFIED' as const,
  subject: {
    kind: 'RETAIL_CUSTOMER_PROFILE' as const,
    profileRef: ref('commerce.customer-context', 'commerce.customer-context.retail-customer-profile', 'profile-1'),
  },
};

const selection = (resourceId: string, variantKind: 'ATOMIC' | 'SET' = 'ATOMIC', revision = 'composition-r1') => {
  const base = {
    configuration: { kind: 'NONE' as const },
    productRef,
    variantKind,
    variantRef: variantRef(resourceId),
  };
  return Schema.decodeUnknownSync(AssortmentCatalogSelectionSchema)(
    variantKind === 'SET' ? { ...base, setCompositionRevision: compositionRevision(revision) } : base,
  );
};

const component = (resourceId: string) =>
  Schema.decodeUnknownSync(AssortmentPurchaseConstituentSchema)({
    catalogSelection: selection(resourceId),
    role: 'REQUIRED_COMPONENT',
  });

const configuredComponent = (resourceId: string, color: Schema.Json) =>
  Schema.decodeUnknownSync(AssortmentPurchaseConstituentSchema)({
    catalogSelection: {
      ...selection(resourceId),
      configuration: {
        definitionRevision: {
          ownerModuleId: 'catalog.owner',
          revision: 'definition-r1',
          sourceRef: catalogRef('catalog.product-configuration-definition', `definition-${resourceId}`),
        },
        kind: 'CONFIGURED',
        value: { color },
      },
    },
    role: 'REQUIRED_COMPONENT',
  });

const composition = (components: readonly ReturnType<typeof component>[], revision = 'composition-r1') =>
  Schema.decodeUnknownSync(AssortmentSetCompositionResolutionSchema)({
    composition: {
      requiredComponents: components,
      setCompositionRevision: compositionRevision(revision),
    },
    source: {
      evidenceRef: catalogRef('catalog.set-composition-evidence', `evidence-${revision}`),
      ownerModuleId: 'catalog.owner',
      sourceRevision: compositionRevision(revision),
    },
  });

const request = (components: readonly ReturnType<typeof component>[], revision = 'composition-r1') => ({
  constituent: {
    catalogSelection: selection('set-variant', 'SET', revision),
    role: 'TOP_LEVEL' as const,
  },
  decisionPurpose: 'PURCHASE' as const,
  setComposition: {
    requiredComponents: components,
    setCompositionRevision: compositionRevision(revision),
  },
  subject,
  trustedContext: context,
});

const input = (components: readonly ReturnType<typeof component>[], revision = 'composition-r1') => {
  const setRequest = request(components, revision);
  const setComposition = composition(components, revision);
  return Schema.decodeUnknownSync(AssortmentSetPurchaseCompositionInputSchema)({
    composition: setComposition,
    request: setRequest,
  });
};

const decisionEvidence = (constituent: AssortmentPurchaseConstituent) => ({
  factCurrentness: [],
  operationTime,
  setCompleteness: [],
  subject,
  target: { kind: 'CATALOG_SELECTION' as const, selection: constituent.catalogSelection },
  trustedContext: context,
});

const decision = (constituent: AssortmentPurchaseConstituent, outcome: 'ELIGIBLE' | 'INELIGIBLE' | 'INDETERMINATE') => {
  if (outcome === 'INDETERMINATE') {
    return Schema.decodeUnknownSync(AssortmentGovernedDecisionSchema)({
      failure: new AssortmentMissingConfigurationError({
        code: 'MISSING_CONFIGURATION',
        safeReasonCode: 'MISSING_CONFIGURATION',
      }),
      outcome,
    });
  }
  return Schema.decodeUnknownSync(AssortmentGovernedDecisionSchema)({
    evidence: decisionEvidence(constituent),
    outcome,
  });
};

it('evaluates the pinned top-level Set and every required component conjunctively', () => {
  const components = [component('component-a'), component('component-b')];
  const calls: string[] = [];
  const result = resolveAssortmentSetPurchase(input(components), (constituent) => {
    calls.push(constituent.constituent.catalogSelection.variantRef.resourceId);
    return decision(constituent.constituent, 'ELIGIBLE');
  });
  expect(result).toMatchObject({ kind: 'ELIGIBLE' });
  expect(calls).toHaveLength(3);
  expect(new Set(calls)).toEqual(new Set(['set-variant', 'component-a', 'component-b']));
  if (result.kind === 'ELIGIBLE') {
    expect(result.evidence.evaluated).toHaveLength(3);
  }
});

it('returns INDETERMINATE only after all constituents are evaluated when no deny exists', () => {
  const components = [component('component-a'), component('component-b')];
  const result = resolveAssortmentSetPurchase(input(components), (constituent) =>
    decision(
      constituent.constituent,
      constituent.constituent.catalogSelection.variantRef.resourceId === 'component-b' ? 'INDETERMINATE' : 'ELIGIBLE',
    ),
  );
  expect(result).toMatchObject({ kind: 'INDETERMINATE', reason: 'CONSTITUENT_INDETERMINATE' });
  if (result.kind === 'INDETERMINATE' && 'evidence' in result) {
    expect(result.evidence.evaluated).toHaveLength(3);
  }
});

it('short-circuits on an authoritative INELIGIBLE without fabricating sibling decisions', () => {
  const components = [component('component-a'), component('component-b')];
  const calls: string[] = [];
  const result = resolveAssortmentSetPurchase(input(components), (constituent) => {
    const { resourceId } = constituent.constituent.catalogSelection.variantRef;
    calls.push(resourceId);
    return decision(constituent.constituent, resourceId === 'component-a' ? 'INELIGIBLE' : 'ELIGIBLE');
  });
  expect(result).toMatchObject({ kind: 'INELIGIBLE' });
  if (result.kind === 'INELIGIBLE') {
    expect(result.evidence.evaluated).toHaveLength(1);
    expect(result.evidence.evaluated[0]?.constituent.catalogSelection.variantRef.resourceId).toBe('component-a');
  }
  expect(calls).toEqual(['component-a']);
});

it('is independent of required-component row order and preserves deterministic evaluated evidence', () => {
  const first = resolveAssortmentSetPurchase(input([component('component-a'), component('component-b')]), (item) =>
    decision(item.constituent, 'ELIGIBLE'),
  );
  const second = resolveAssortmentSetPurchase(input([component('component-b'), component('component-a')]), (item) =>
    decision(item.constituent, 'ELIGIBLE'),
  );
  expect(first).toMatchObject({ kind: 'ELIGIBLE' });
  expect(second).toMatchObject({ kind: 'ELIGIBLE' });
  if (first.kind === 'ELIGIBLE' && second.kind === 'ELIGIBLE') {
    expect(first.evidence.evaluated.map((item) => item.constituent.catalogSelection.variantRef.resourceId)).toEqual(
      second.evidence.evaluated.map((item) => item.constituent.catalogSelection.variantRef.resourceId),
    );
  }
});

it('rejects a composition source that does not exactly match the request pinned revision', () => {
  const components = [component('component-a')];
  const setRequest = request(components, 'composition-r1');
  const mismatchedSource = composition(components, 'composition-r2');
  const result = resolveAssortmentSetPurchase(
    Schema.decodeUnknownSync(AssortmentSetPurchaseCompositionInputSchema)({
      composition: mismatchedSource,
      request: setRequest,
    }),
    (item) => decision(item.constituent, 'ELIGIBLE'),
  );
  expect(result).toEqual({ kind: 'INDETERMINATE', reason: 'COMPOSITION_REVISION_MISMATCH' });
});

it('rejects an owner source whose revision evidence is unrelated to the pinned composition', () => {
  const components = [component('component-a')];
  const setRequest = request(components, 'composition-r1');
  const validComposition = composition(components, 'composition-r1');
  const unrelatedSource = {
    ...validComposition,
    source: {
      ...validComposition.source,
      sourceRevision: compositionRevision('composition-r2'),
    },
  };
  const result = resolveAssortmentSetPurchase(
    Schema.decodeUnknownSync(AssortmentSetPurchaseCompositionInputSchema)({
      composition: unrelatedSource,
      request: setRequest,
    }),
    (item) => decision(item.constituent, 'ELIGIBLE'),
  );
  expect(result).toEqual({ kind: 'INDETERMINATE', reason: 'COMPOSITION_REVISION_MISMATCH' });
});

it('rejects a valid-looking constituent decision that carries sibling evidence', () => {
  const components = [component('component-a'), component('component-b')];
  const result = resolveAssortmentSetPurchase(input(components), () => decision(component('component-b'), 'ELIGIBLE'));
  expect(result).toEqual({ kind: 'INDETERMINATE', reason: 'CONSTITUENT_RESOLUTION_INVALID' });
});

it('uses full configured-selection meaning for deterministic short-circuit ordering', () => {
  const red = configuredComponent('configured-component', 'red');
  const blue = configuredComponent('configured-component', 'blue');
  const resolve = (components: readonly ReturnType<typeof configuredComponent>[]) =>
    resolveAssortmentSetPurchase(input(components), (item) => {
      const { configuration } = item.constituent.catalogSelection;
      const color = configuration.kind === 'CONFIGURED' ? configuration.value.color : undefined;
      return decision(item.constituent, color === 'red' ? 'INELIGIBLE' : 'ELIGIBLE');
    });
  const first = resolve([red, blue]);
  const second = resolve([blue, red]);
  expect(first).toMatchObject({ kind: 'INELIGIBLE' });
  expect(second).toMatchObject({ kind: 'INELIGIBLE' });
  if (first.kind === 'INELIGIBLE' && second.kind === 'INELIGIBLE') {
    expect(first.evidence.evaluated).toHaveLength(2);
    expect(second.evidence.evaluated).toHaveLength(2);
  }

  const nullValue = configuredComponent('collision-component', null);
  const stringValue = configuredComponent('collision-component', 'null');
  const numberValue = configuredComponent('collision-number', 1);
  const numberStringValue = configuredComponent('collision-number', '1');
  const collisionResolve = (components: readonly ReturnType<typeof configuredComponent>[]) =>
    resolveAssortmentSetPurchase(input(components), (item) => {
      const { configuration } = item.constituent.catalogSelection;
      const value = configuration.kind === 'CONFIGURED' ? configuration.value.color : undefined;
      return decision(item.constituent, value === null || value === 1 ? 'INELIGIBLE' : 'ELIGIBLE');
    });
  const nullCollision = collisionResolve([stringValue, nullValue]);
  const numberCollision = collisionResolve([numberStringValue, numberValue]);
  expect(nullCollision).toMatchObject({ kind: 'INELIGIBLE' });
  expect(numberCollision).toMatchObject({ kind: 'INELIGIBLE' });
  if (nullCollision.kind === 'INELIGIBLE' && numberCollision.kind === 'INELIGIBLE') {
    expect(nullCollision.evidence.evaluated).toHaveLength(2);
    expect(numberCollision.evidence.evaluated).toHaveLength(2);
  }
});

it('rejects VISIBILITY composition attempts before invoking the constituent resolver', () => {
  const visibilityRequest = {
    decisionPurpose: 'VISIBILITY',
    productRef,
    subject,
    trustedContext: context,
  };
  const result = resolveAssortmentSetPurchase(
    Schema.decodeUnknownSync(AssortmentSetPurchaseCompositionInputSchema)({
      composition: composition([component('component-a')]),
      request: visibilityRequest,
    }),
    () => {
      throw new Error('resolver must not run for VISIBILITY');
    },
  );
  expect(result).toEqual({ kind: 'INDETERMINATE', reason: 'VISIBILITY_NOT_SUPPORTED' });
});
