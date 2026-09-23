import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import type {
  CartOpenSelectionPopulationPort,
  CartOpenSelectionReference,
} from '../../shared/domain/catalog-open-selection-population.ts';
import {
  CartOpenSelectionPopulationUnavailable,
  CartOpenSelectionReferenceSchema,
} from '../../shared/domain/catalog-open-selection-population.ts';
import { CatalogResourceRefSchema } from '../../shared/domain/catalog-revision-reference.ts';
import type { CatalogSelectionCurrentFacts } from '../../shared/domain/catalog-selection-assessment.ts';
import {
  CatalogSelectionBasisSchema,
  CatalogSelectionMembershipSchema,
  CatalogSelectionSchema,
} from '../../shared/domain/catalog-selection-evidence.ts';
import type { CatalogSelection } from '../../shared/domain/catalog-selection-evidence.ts';
import { assembleCatalogSelectionEvidence } from '../../src/persistence/catalog-selection-evidence-service.ts';
import type { CatalogSelectionEvidenceServiceResult } from '../../src/persistence/catalog-selection-evidence-service.ts';
import {
  assessCatalogOpenSelectionSnapshot,
  catalogSelectionOpenPopulationImpactForScope,
} from '../../src/persistence/catalog-selection-open-population.ts';
import type { ConfigurationSelectionChange } from '../../src/persistence/catalog-selection-change-impact.ts';
import {
  packageActivationSelectionImpactForScope,
  productConfigurationSelectionImpactForScope,
  reassessOpenConfiguration,
  setCompositionSelectionImpactForScope,
} from '../../src/persistence/catalog-selection-change-impact.ts';
import type {
  CurrentConfigurationRevision,
  ProductConfigurationPersistence,
} from '../../src/persistence/product-configuration-persistence.ts';
import { PackageActivationUnavailable } from '../../src/persistence/package-activation-persistence.ts';
import { ProductConfigurationPersistenceUnavailable } from '../../src/persistence/product-configuration-persistence.ts';
import { SetCompositionPersistenceUnavailable } from '../../src/persistence/set-composition-persistence.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const assessedAt = '2026-09-18T12:00:00.000Z';
const productId = '22222222-2222-4222-8222-222222222222';
const variantId = '33333333-3333-4333-8333-333333333333';
const typeId = '44444444-4444-4444-8444-444444444444';
const valueSetId = '66666666-6666-4666-8666-666666666666';
const unitRuleId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const packageDefinitionId = '77777777-7777-4777-8777-777777777777';
const compositionId = '88888888-8888-4888-8888-888888888888';
const ref = (resourceType: string, resourceId: string) => ({
  moduleId: 'commerce.catalog' as const,
  resourceId,
  resourceType,
  tenantId,
});
const productRef = ref('commerce.catalog.product', productId);
const variantRef = ref('commerce.catalog.variant', variantId);
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    authContextRef: 'job:selection-change-impact:run:1',
    authMethod: 'system',
    principalId: '55555555-5555-4555-8555-555555555555',
    tenantId,
  }),
  correlationId: 'selection-change-impact',
};

const decodeSelection = Schema.decodeUnknownSync(CatalogSelectionSchema, { onExcessProperty: 'error' });
const decodeBasis = Schema.decodeUnknownSync(CatalogSelectionBasisSchema, { onExcessProperty: 'error' });
const decodeMembership = Schema.decodeUnknownSync(CatalogSelectionMembershipSchema, { onExcessProperty: 'error' });
const selection = decodeSelection({ productRef, variantRef });
const packageSelection = decodeSelection({
  packageOption: {
    contentRevision: { resourceRef: ref('commerce.catalog.package-definition', packageDefinitionId), revision: 1 },
    optionRef: ref('commerce.catalog.package-definition', packageDefinitionId),
  },
  productRef,
  variantRef,
});
const setSelection = decodeSelection({
  productRef,
  setComposition: { resourceRef: ref('commerce.catalog.set-composition', compositionId), revision: 1 },
  variantRef,
});
const fact = (role: string, source: ReturnType<typeof ref>, revision: number) =>
  decodeBasis({ role, source: { resourceRef: source, revision } });
const purchaseBasis = [
  fact('PRODUCT', productRef, 4),
  fact('VARIANT', variantRef, 2),
  fact('PRODUCT_TYPE', ref('commerce.catalog.product-type', typeId), 1),
  fact('VARIANT_AXIS', productRef, 3),
  fact('INHERITED_VALUE', ref('commerce.catalog.attribute-value-set', valueSetId), 5),
  fact('UNIT_RULE', ref('commerce.catalog.product-unit', unitRuleId), 6),
  fact('UNIT_TARGET_DIVISIBILITY', variantRef, 2),
];
const observedFacts: CatalogSelectionCurrentFacts = {
  assessedAt,
  basis: purchaseBasis,
  dependentFactsComplete: true,
  membership: decodeMembership({
    attestationId: 'catalog-membership-change-impact-1',
    observedAt: assessedAt,
    productRef,
    source: 'CATALOG_OWNER_CURRENT_READ',
    variant: { resourceRef: variantRef, revision: 2 },
  }),
  productLifecycle: 'ACTIVE',
  purpose: 'PURCHASE_ACCEPTANCE',
  selection,
  source: 'CATALOG_OWNER_CURRENT_READ',
  status: 'OBSERVED',
  variantLifecycle: 'ACTIVE',
};
const validResult = (): CatalogSelectionEvidenceServiceResult => {
  const assembly = assembleCatalogSelectionEvidence({
    current: observedFacts,
    purpose: 'PURCHASE_ACCEPTANCE',
    selection,
  });
  return { evidence: assembly.evidence, missingRoles: assembly.missingRoles };
};
const assessValid = () => Effect.succeed(validResult());
const assessInvalid = (): Effect.Effect<CatalogSelectionEvidenceServiceResult> =>
  Effect.succeed({ evidence: { kind: 'NOT_FOUND', requested: selection }, missingRoles: [] });

const populationEvidence = (
  selections: readonly CartOpenSelectionReference[],
  revisionToken = 'cart-population-1',
  observedAt = assessedAt,
) => ({ complete: true as const, observedAt, revisionToken, selections, tenantId });
const population = (selections: readonly CartOpenSelectionReference[]): CartOpenSelectionPopulationPort => ({
  read: () => Effect.succeed(populationEvidence(selections)),
});
const changingPopulation = <Response>(first: Response, ...later: readonly Response[]) => {
  const snapshots = [first, ...later];
  let reads = 0;
  return {
    port: {
      read: () =>
        Effect.sync(() => {
          const snapshot = snapshots[reads] ?? snapshots.at(-1);
          reads += 1;
          return snapshot;
        }),
    },
    readCount: () => reads,
  } satisfies { readonly port: CartOpenSelectionPopulationPort; readonly readCount: () => number };
};
const reference = (selectionId: string, value: CatalogSelection = selection): CartOpenSelectionReference =>
  Schema.decodeUnknownSync(CartOpenSelectionReferenceSchema)({ selection: value, selectionId });
const untouchedTransaction = {
  delete: () => Effect.die('must not write'),
  insert: () => Effect.die('must not write'),
  select: () => Effect.die('must not query'),
  update: () => Effect.die('must not write'),
};
// @ts-expect-error SAFETY: Every impact under test decides before any transaction read or write.
const transaction: Parameters<typeof productConfigurationPersistenceForScope>[0] = untouchedTransaction;
const definitionImpactInput = {
  definitionId: 'definition-1',
  effectiveFrom: new Date('2026-09-18T00:00:00.000Z'),
  previousRevision: 0,
  productId,
  proposed: { choices: [], compatibilityRules: [], measuredRules: [], optionAllowances: [] },
  proposedRevision: 1,
  tenantId,
};
const packageImpactInput = { packageDefinitionId, revision: 1, tenantId };
const setImpactInput = {
  at: new Date('2026-09-18T00:00:00.000Z'),
  compositionId,
  previousRevision: 1,
  tenantId,
};

const configurationDefinitionId = '99999999-9999-4999-8999-999999999999';
const configurationUnitId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const configurationDefinitionRef = ref('commerce.catalog.configuration-definition', configurationDefinitionId);
const configurationUnitRef = Schema.decodeUnknownSync(CatalogResourceRefSchema)(
  ref('commerce.catalog.unit', configurationUnitId),
);
const configurationSelection = decodeSelection({
  configuration: {
    choices: [
      { choiceKey: 'mount', value: 'A' },
      { choiceKey: 'length', unit: { resourceRef: configurationUnitRef, revision: 1 }, value: '83' },
    ],
    definition: { resourceRef: configurationDefinitionRef, revision: 1 },
    productRef,
    variantRef,
  },
  productRef,
  variantRef,
});
const configurationReference = reference('cart-open-configuration', configurationSelection);
const configurationEffectiveFrom = new Date('2026-09-01T00:00:00.000Z');
const reassessmentAt = new Date('2026-09-18T00:00:00.000Z');
const configurationChoices = (
  mountOptions: readonly { readonly label: string; readonly meaning: string; readonly optionKey: string }[],
): CurrentConfigurationRevision['choices'] => [
  {
    choiceKey: 'mount',
    kind: 'SINGLE_CHOICE',
    label: 'Mount',
    meaning: 'Mounting type',
    options: mountOptions,
    required: true,
  },
  {
    choiceKey: 'length',
    kind: 'MEASURED_VALUE',
    label: 'Length',
    meaning: 'Cut length',
    required: true,
    unitId: configurationUnitId,
    unitRevision: 1,
  },
];
const committedConfiguration: CurrentConfigurationRevision = {
  choices: configurationChoices([
    { label: 'A', meaning: 'A mounting part', optionKey: 'A' },
    { label: 'B', meaning: 'B mounting part', optionKey: 'B' },
  ]),
  compatibilityRules: [],
  definitionEvidenceRefs: ['owner:configuration-definition:1'],
  definitionId: configurationDefinitionId,
  effectiveFrom: configurationEffectiveFrom,
  measuredRules: [
    {
      choiceKey: 'length',
      evidenceRefs: ['owner:measured-rule:1'],
      maximum: '120',
      maximumInclusive: true,
      minimum: '0',
      minimumInclusive: false,
    },
  ],
  optionAllowances: [
    { allowed: true, choiceKey: 'mount', evidenceRefs: ['owner:allowance:1'], optionKey: 'A' },
    { allowed: false, choiceKey: 'mount', evidenceRefs: ['owner:allowance:1'], optionKey: 'B' },
  ],
  productId,
  revision: 1,
  ruleCombination: 'CONJUNCTION_ONLY',
  units: [
    {
      dimension: 'length',
      effectiveFrom: configurationEffectiveFrom,
      evidenceRefs: ['owner:unit:1'],
      lifecycleState: 'ACTIVE',
      meaning: 'Centimetre',
      ref: configurationUnitRef,
      revision: 1,
    },
  ],
};
const changeInput = (proposedChoices: CurrentConfigurationRevision['choices']): ConfigurationSelectionChange => ({
  definitionId: configurationDefinitionId,
  effectiveFrom: reassessmentAt,
  previousRevision: 1,
  productId,
  proposed: {
    choices: proposedChoices,
    compatibilityRules: committedConfiguration.compatibilityRules,
    measuredRules: committedConfiguration.measuredRules,
    optionAllowances: committedConfiguration.optionAllowances,
  },
  proposedRevision: 2,
  tenantId,
});
const materialConfigurationChange = changeInput(
  configurationChoices([{ label: 'B', meaning: 'B mounting part', optionKey: 'B' }]),
);
const displayOnlyConfigurationChange = changeInput(
  configurationChoices([
    { label: 'A (display only)', meaning: 'A mounting part', optionKey: 'A' },
    { label: 'B (display only)', meaning: 'B mounting part', optionKey: 'B' },
  ]),
);
const meaningChangingConfigurationChange = changeInput(
  configurationChoices([
    { label: 'A', meaning: 'A different mounting part', optionKey: 'A' },
    { label: 'B', meaning: 'B mounting part', optionKey: 'B' },
  ]),
);
const configurationPersistence = (
  revision: CurrentConfigurationRevision | undefined,
): ProductConfigurationPersistence => ({
  publish: () => Effect.die('configuration impact must not publish'),
  readCurrent: () => Effect.succeed(revision === undefined ? Option.none() : Option.some(revision)),
});
const absentConfiguration: ProductConfigurationPersistence = {
  publish: () => Effect.die('configuration impact must not publish'),
  readCurrent: () => Effect.succeed(Option.none()),
};
describe('Catalog open-selection population impact (#479 wiring)', () => {
  it.effect('fails closed when the Cart owner population port is absent', () =>
    Effect.gen(function* absentPort() {
      const impact = catalogSelectionOpenPopulationImpactForScope(transaction, scope);
      const impacted = yield* impact.assess({ purpose: 'PURCHASE_ACCEPTANCE' });
      expect(impacted).toMatchObject({ kind: 'POPULATION_UNAVAILABLE' });
    }),
  );

  it.effect('propagates a failing Cart owner read as a typed owner error', () =>
    Effect.gen(function* failingOwnerRead() {
      const failing: CartOpenSelectionPopulationPort = {
        read: () =>
          Effect.fail(
            new CartOpenSelectionPopulationUnavailable({
              code: 'cart_open_selection_population_unavailable',
              reason: 'Cart is unavailable',
            }),
          ),
      };
      const impact = catalogSelectionOpenPopulationImpactForScope(transaction, scope, failing);
      const failure = yield* Effect.flip(impact.assess({ purpose: 'PURCHASE_ACCEPTANCE' }));
      expect(failure).toBeInstanceOf(CartOpenSelectionPopulationUnavailable);
    }),
  );

  it.effect('proves an empty but owner-confirmed population', () =>
    Effect.gen(function* emptyPopulation() {
      const snapshot = yield* assessCatalogOpenSelectionSnapshot({
        assess: assessInvalid,
        purpose: 'PURCHASE_ACCEPTANCE',
        snapshot: {
          complete: true,
          observedAt: assessedAt,
          revisionToken: 'cart-population-empty',
          selections: [],
          tenantId,
        },
      });
      expect(snapshot).toEqual({ evidence: [], kind: 'PROVEN' });
    }),
  );

  it.effect('blocks when an affected open selection has no Current-VALID Catalog evidence', () =>
    Effect.gen(function* invalidEvidence() {
      const snapshot = yield* assessCatalogOpenSelectionSnapshot({
        assess: assessInvalid,
        purpose: 'PURCHASE_ACCEPTANCE',
        snapshot: {
          complete: true,
          observedAt: assessedAt,
          revisionToken: 'cart-population-1',
          selections: [reference('cart-open-1')],
          tenantId,
        },
      });
      expect(snapshot).toMatchObject({ kind: 'NOT_PROVEN' });
    }),
  );

  it.effect('proves a complete population whose affected selections are Current-VALID', () =>
    Effect.gen(function* validEvidence() {
      const snapshot = yield* assessCatalogOpenSelectionSnapshot({
        assess: assessValid,
        purpose: 'PURCHASE_ACCEPTANCE',
        snapshot: {
          complete: true,
          observedAt: assessedAt,
          revisionToken: 'cart-population-1',
          selections: [reference('cart-open-1')],
          tenantId,
        },
      });
      expect(snapshot.kind).toBe('PROVEN');
    }),
  );

  it.effect('keeps every Catalog path fail-closed without an injected owner population', () =>
    Effect.gen(function* absentPopulationAllPaths() {
      const config = productConfigurationSelectionImpactForScope(transaction, scope);
      const configFailure = yield* Effect.flip(config.verify(definitionImpactInput));
      expect(configFailure).toBeInstanceOf(ProductConfigurationPersistenceUnavailable);
      const packageImpact = packageActivationSelectionImpactForScope(transaction, scope);
      const packageFailure = yield* Effect.flip(packageImpact.verify(packageImpactInput));
      expect(packageFailure).toBeInstanceOf(PackageActivationUnavailable);
      const setImpact = setCompositionSelectionImpactForScope(transaction, scope);
      const setFailure = yield* Effect.flip(setImpact.verify(setImpactInput));
      expect(setFailure).toBeInstanceOf(SetCompositionPersistenceUnavailable);
    }),
  );

  it.effect('succeeds when the caller supplies a complete owner population and Catalog evidence is VALID', () =>
    Effect.gen(function* provenPopulation() {
      const empty = population([]);
      const packageImpact = packageActivationSelectionImpactForScope(transaction, scope, empty, assessInvalid);
      expect(yield* packageImpact.verify(packageImpactInput)).toBe(true);
      const setImpact = setCompositionSelectionImpactForScope(transaction, scope, empty, assessInvalid);
      expect(yield* setImpact.verify(setImpactInput)).toBe(true);
      const provenPackage = packageActivationSelectionImpactForScope(
        transaction,
        scope,
        population([reference('cart-open-1', packageSelection)]),
        assessValid,
      );
      expect(yield* provenPackage.verify(packageImpactInput)).toBe(true);
    }),
  );

  it.effect('blocks an affected Package or Set transition when Catalog evidence is not VALID', () =>
    Effect.gen(function* blockedEvidence() {
      const packageImpact = packageActivationSelectionImpactForScope(
        transaction,
        scope,
        population([reference('cart-open-package', packageSelection)]),
        assessInvalid,
      );
      expect(yield* packageImpact.verify(packageImpactInput)).toBe(false);
      const setImpact = setCompositionSelectionImpactForScope(
        transaction,
        scope,
        population([reference('cart-open-set', setSelection)]),
        assessInvalid,
      );
      expect(yield* setImpact.verify(setImpactInput)).toBe(false);
    }),
  );

  it('exposes the exact Cart owner port and Catalog evidence seam', () => {
    const port: CartOpenSelectionPopulationPort = population([]);
    expect(port).toHaveProperty('read');
    expect(catalogSelectionOpenPopulationImpactForScope).toBeDefined();
  });
});

describe('Catalog configuration change impact (#479 wiring)', () => {
  const currentPopulation = {
    observedAt: reassessmentAt.toISOString(),
    revisionToken: 'cart-population-1',
  };

  it.effect('invalidates an open selection when the proposed revision removes its chosen option', () =>
    Effect.gen(function* materialConfigurationRevision() {
      expect(
        yield* reassessOpenConfiguration(
          configurationPersistence(committedConfiguration),
          currentPopulation,
          materialConfigurationChange,
          configurationReference,
        ),
      ).toBe(false);
    }),
  );

  it.effect('keeps a display-only configuration revision Current with owner equivalence evidence', () =>
    Effect.gen(function* displayOnlyConfigurationRevision() {
      expect(
        yield* reassessOpenConfiguration(
          configurationPersistence(committedConfiguration),
          currentPopulation,
          displayOnlyConfigurationChange,
          configurationReference,
        ),
      ).toBe(true);
    }),
  );

  it.effect('fails closed when the Cart population was observed at a different assessment instant', () =>
    Effect.gen(function* stalePopulationObservation() {
      expect(
        yield* reassessOpenConfiguration(
          configurationPersistence(committedConfiguration),
          { ...currentPopulation, observedAt: '2026-09-17T23:59:59.999Z' },
          displayOnlyConfigurationChange,
          configurationReference,
        ),
      ).toBe(false);
    }),
  );

  it.effect('fails closed when the same option key has different owner-recorded meaning', () =>
    Effect.gen(function* changedConfigurationMeaning() {
      expect(
        yield* reassessOpenConfiguration(
          configurationPersistence(committedConfiguration),
          currentPopulation,
          meaningChangingConfigurationChange,
          configurationReference,
        ),
      ).toBe(false);
    }),
  );

  it.effect('fails closed when the committed Configuration revision is absent or not the pinned revision', () =>
    Effect.gen(function* unavailableConfigurationRevision() {
      expect(
        yield* reassessOpenConfiguration(
          absentConfiguration,
          currentPopulation,
          displayOnlyConfigurationChange,
          configurationReference,
        ),
      ).toBe(false);
      expect(
        yield* reassessOpenConfiguration(
          configurationPersistence({ ...committedConfiguration, revision: 2 }),
          currentPopulation,
          displayOnlyConfigurationChange,
          configurationReference,
        ),
      ).toBe(false);
    }),
  );

  it.effect('blocks an affected configuration publication when Catalog evidence is not VALID', () =>
    Effect.gen(function* blockedConfigurationEvidence() {
      const impact = productConfigurationSelectionImpactForScope(
        transaction,
        scope,
        population([configurationReference]),
        assessInvalid,
      );
      expect(yield* impact.verify(displayOnlyConfigurationChange)).toBe(false);
    }),
  );

  it.effect('re-reads the complete Cart population and rejects a changed revision token', () =>
    Effect.gen(function* changingPopulationRevision() {
      const initial = populationEvidence([], 'cart-population-before');
      const changed = populationEvidence([], 'cart-population-after');
      const owner = changingPopulation(initial, changed);
      const impact = productConfigurationSelectionImpactForScope(transaction, scope, owner.port, assessInvalid);
      expect(yield* impact.verify(definitionImpactInput)).toBe(false);
      expect(owner.readCount()).toBe(2);
    }),
  );

  it.effect('accepts only the same twice-decoded complete Cart population scope', () =>
    Effect.gen(function* stablePopulationRevision() {
      const stable = populationEvidence([], 'cart-population-stable');
      const owner = changingPopulation(stable, stable);
      const impact = productConfigurationSelectionImpactForScope(transaction, scope, owner.port, assessInvalid);
      expect(yield* impact.verify(definitionImpactInput)).toBe(true);
      expect(owner.readCount()).toBe(2);

      const incomplete = changingPopulation(stable, { ...stable, complete: false });
      const invalidImpact = productConfigurationSelectionImpactForScope(
        transaction,
        scope,
        incomplete.port,
        assessInvalid,
      );
      const failure = yield* Effect.flip(invalidImpact.verify(definitionImpactInput));
      expect(failure).toBeInstanceOf(ProductConfigurationPersistenceUnavailable);
      expect(incomplete.readCount()).toBe(2);
    }),
  );
});
