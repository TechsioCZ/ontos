import { DefinePricePayloadSchema } from '@app/pricing/actions/define-price';
import { LegalEntityIdSchema } from '@app/core-runtime/access/ids';
import { PrincipalIdSchema } from '@app/core-runtime/auth/external-identity-contracts';
import {
  SymmyEffectOutcomeSchema,
  SymmyItemOutcomeSchema,
  SymmyOwnerEffectRefSchema,
  SymmySourceRecordRefSchema,
} from '@app/shared-contracts/symmy';
import { Schema } from 'effect';

import { SymmyJobLifecyclePolicyRefSchema } from './symmy-job-notification.ts';
import { SymmyDurableJobRouteKeySchema, SymmyJobIdSchema } from './symmy-job-identities.ts';
import {
  SymmyCatalogPricingInventoryIntentSchema,
  SymmyCatalogPricingInventoryReceiptSchema,
} from './symmy-catalog-pricing-inventory-intents.ts';
import {
  SymmyPartyCommerceIntentSchema,
  SymmyPartyCommerceOwnerReceiptSchema,
} from './symmy-party-commerce-intents.ts';

export const SymmyOwnerIntentSchema = Schema.Union([
  SymmyCatalogPricingInventoryIntentSchema,
  SymmyPartyCommerceIntentSchema,
]);
export const SymmyOwnerReceiptSchema = Schema.Union([
  SymmyCatalogPricingInventoryReceiptSchema,
  SymmyPartyCommerceOwnerReceiptSchema,
]);
export type SymmyOwnerReceipt = typeof SymmyOwnerReceiptSchema.Type;

const key = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/u));
const effectKeySchema = key.pipe(Schema.brand('SymmyExecutionEffectKey'));
const itemKeySchema = key.pipe(Schema.brand('SymmyExecutionItemKey'));
const dependencySchema = Schema.Union([
  effectKeySchema,
  Schema.Struct({ effectKey: effectKeySchema, itemKey: itemKeySchema }),
]);
const { itemId: itemIdSchema } = SymmyItemOutcomeSchema.fields;
const routeIdSchema = Schema.String.check(Schema.isUUID()).pipe(Schema.brand('SymmyExecutionRouteId'));
const source = Schema.Struct({
  entityKind: SymmySourceRecordRefSchema.fields.entityKind,
  issuerId: SymmySourceRecordRefSchema.fields.issuerId,
  sourceNamespace: SymmySourceRecordRefSchema.fields.sourceNamespace,
  sourceRecordId: SymmySourceRecordRefSchema.fields.sourceRecordId,
});
const unsupportedBranchSchema = Schema.Struct({
  branchKey: key.pipe(Schema.brand('SymmyUnsupportedBranchKey')),
  kind: Schema.Literals(['TaxHint', 'AssortmentHint', 'ReservedQuantityHint']),
});
const unsupportedBranches = Schema.optionalKey(
  Schema.Array(unsupportedBranchSchema).check(
    Schema.isMaxLength(3),
    Schema.makeFilter(
      (branches) =>
        (new Set(branches.map(({ branchKey }) => branchKey)).size === branches.length &&
          new Set(branches.map(({ kind }) => kind)).size === branches.length) ||
        'Unsupported branch meanings and keys must be distinct',
    ),
  ),
);
const pinnedUnsupportedBranches = Schema.optionalKey(
  Schema.Array(
    Schema.Struct({
      ...unsupportedBranchSchema.fields,
      branchId: Schema.String.check(Schema.isUUID()).pipe(Schema.brand('SymmyUnsupportedBranchId')),
    }),
  ).check(Schema.isMaxLength(3)),
);

const effectDefinition = Schema.Struct({
  dependsOn: Schema.optionalKey(Schema.Array(dependencySchema).check(Schema.isMaxLength(511))),
  effectKey: effectKeySchema,
  intent: Schema.optionalKey(SymmyOwnerIntentSchema),
  operation: SymmyOwnerEffectRefSchema.fields.operation,
  originalTarget: SymmyOwnerEffectRefSchema.fields.originalTarget,
});
const selectorSchema = Schema.Struct({
  kind: Schema.Literals(['CUSTOMER_GROUP', 'PRICE_GROUP']),
  source: SymmySourceRecordRefSchema,
  target: SymmyOwnerEffectRefSchema.fields.originalTarget,
}).check(
  Schema.makeFilter(
    ({ target }) => target !== undefined || 'A configured selector must name its exact native owner target',
  ),
);

const identity = (itemKey: string, effectKey: string) => `${itemKey}\u0000${effectKey}`;

/** Named cross-item edges are explicit; array order never chooses a source or owner target. */
export const symmyPlanDependenciesValid = (
  items: readonly {
    readonly effects: readonly {
      readonly dependsOn?: readonly (string | { readonly effectKey: string; readonly itemKey: string })[];
      readonly effectKey: string;
    }[];
    readonly itemKey: string;
  }[],
): boolean => {
  const nodes = items.flatMap((item) => item.effects.map((effect) => ({ itemKey: item.itemKey, ...effect })));
  const remaining = new Map(nodes.map((node) => [identity(node.itemKey, node.effectKey), node]));
  if (remaining.size !== nodes.length) {
    return false;
  }
  const edges = (node: (typeof nodes)[number]) =>
    (node.dependsOn ?? []).map((dependency) =>
      Schema.is(Schema.String)(dependency)
        ? identity(node.itemKey, dependency)
        : identity(dependency.itemKey, dependency.effectKey),
    );
  if (
    nodes.some((node) => {
      const dependencies = edges(node);
      return (
        new Set(dependencies).size !== dependencies.length ||
        dependencies.some(
          (dependency) => dependency === identity(node.itemKey, node.effectKey) || !remaining.has(dependency),
        )
      );
    })
  ) {
    return false;
  }
  const visited = new Set<string>();
  for (const _node of nodes) {
    for (const [id, node] of remaining) {
      if (edges(node).every((dependency) => visited.has(dependency))) {
        visited.add(id);
        remaining.delete(id);
      }
    }
  }
  return remaining.size === 0;
};

/** Operator-owned synthetic source plans. No request payload can register or change one. */
export const SymmyFixtureExecutionPlanSchema = Schema.Struct({
  inventoryBackendId: Schema.optionalKey(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed()).pipe(
      Schema.brand('SymmyInventoryBackendId'),
    ),
  ),
  items: Schema.NonEmptyArray(
    Schema.Struct({
      effects: Schema.NonEmptyArray(effectDefinition).check(Schema.isMaxLength(32)),
      itemKey: itemKeySchema,
      source,
      sourceOccurrenceId: Schema.optionalKey(
        Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300), Schema.isTrimmed()).pipe(
          Schema.brand('SymmySourceOccurrenceId'),
        ),
      ),
      unsupportedBranches,
    }),
  ).check(Schema.isMaxLength(16)),
  pricingSourceSystem: Schema.optionalKey(
    DefinePricePayloadSchema.fields.sourceAssertion.fields.sourceRecord.fields.sourceSystem,
  ),
  selector: Schema.optionalKey(selectorSchema),
  sourceMappingVersion: Schema.optionalKey(SymmyOwnerEffectRefSchema.fields.mappingVersion),
  sourceRouteId: Schema.optionalKey(routeIdSchema),
  sourceRouteRevision: Schema.optionalKey(SymmyOwnerEffectRefSchema.fields.routeRevision),
}).check(
  Schema.makeFilter(
    ({ items }) =>
      (new Set(items.map(({ itemKey }) => itemKey)).size === items.length && symmyPlanDependenciesValid(items)) ||
      'Fixture item and effect keys must be distinct within their scope',
  ),
);
/** Explicit normalized internal business inputs; real Symmy wire acceptance is separate. */
export const SymmyInternalExecutionPlanSchema = SymmyFixtureExecutionPlanSchema.check(
  Schema.makeFilter(
    ({
      inventoryBackendId,
      items,
      pricingSourceSystem,
      selector,
      sourceMappingVersion,
      sourceRouteId,
      sourceRouteRevision,
    }) =>
      (inventoryBackendId === undefined &&
        pricingSourceSystem === undefined &&
        sourceRouteId === undefined &&
        sourceRouteRevision === undefined &&
        sourceMappingVersion === undefined &&
        selector === undefined &&
        items.every(
          ({ effects, sourceOccurrenceId }) =>
            sourceOccurrenceId !== undefined && effects.every(({ intent }) => intent !== undefined),
        )) ||
      'Every internal owner effect requires a finite typed intent',
  ),
);

type SymmyFixtureExecutionPlanDecoded = typeof SymmyFixtureExecutionPlanSchema.Type;
export interface SymmyFixtureExecutionPlan extends SymmyFixtureExecutionPlanDecoded {
  readonly items: SymmyFixtureExecutionPlanDecoded['items'];
}

export const SymmyPinnedEffectSchema = Schema.Struct({
  authContextRef: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
  dependsOn: effectDefinition.fields.dependsOn,
  effectKey: effectKeySchema,
  executorBindingIncarnation: Schema.optionalKey(Schema.String.check(Schema.isMinLength(1))),
  executorPrincipalId: Schema.optionalKey(PrincipalIdSchema),
  intent: effectDefinition.fields.intent,
  itemId: itemIdSchema,
  originalInvocationId: Schema.optionalKey(
    Schema.String.check(Schema.isUUID()).pipe(Schema.brand('SymmyOwnerActionInvocationId')),
  ),
  originalInvocationStatus: Schema.optionalKey(Schema.String),
  ref: SymmyOwnerEffectRefSchema,
  requestHash: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))),
});
type SymmyPinnedEffectDecoded = typeof SymmyPinnedEffectSchema.Type;
export interface SymmyPinnedEffect extends SymmyPinnedEffectDecoded {
  readonly ref: SymmyPinnedEffectDecoded['ref'];
}

export const SymmyPinnedJobPlanSchema = Schema.Struct({
  inventoryBackendId: SymmyFixtureExecutionPlanSchema.fields.inventoryBackendId,
  items: Schema.NonEmptyArray(
    Schema.Struct({
      effects: Schema.NonEmptyArray(SymmyPinnedEffectSchema).check(Schema.isMaxLength(32)),
      itemId: itemIdSchema,
      itemKey: itemKeySchema,
      unsupportedBranches: pinnedUnsupportedBranches,
    }),
  ).check(Schema.isMaxLength(16)),
  pricingSourceSystem: SymmyFixtureExecutionPlanSchema.fields.pricingSourceSystem,
  selector: Schema.optionalKey(selectorSchema),
  sourceMappingVersion: Schema.optionalKey(SymmyOwnerEffectRefSchema.fields.mappingVersion),
  sourceRouteId: Schema.optionalKey(routeIdSchema),
  sourceRouteRevision: Schema.optionalKey(SymmyOwnerEffectRefSchema.fields.routeRevision),
}).check(
  Schema.makeFilter(({ items }) => {
    const effects = items.flatMap((item) => item.effects);
    return (
      (new Set(items.map(({ itemId }) => itemId)).size === items.length &&
        new Set(items.map(({ itemKey }) => itemKey)).size === items.length &&
        new Set(effects.map(({ ref }) => ref.effectId)).size === effects.length &&
        symmyPlanDependenciesValid(items) &&
        items.every((item) => item.effects.every((effect) => effect.itemId === item.itemId))) ||
      'Pinned item and effect identities must be distinct and preserve item grouping'
    );
  }),
);
type SymmyPinnedJobPlanDecoded = typeof SymmyPinnedJobPlanSchema.Type;
export interface SymmyPinnedJobPlan extends SymmyPinnedJobPlanDecoded {
  readonly items: SymmyPinnedJobPlanDecoded['items'];
}

export const SymmyExecutionEffectStateSchema = Schema.Struct({
  effect: SymmyPinnedEffectSchema,
  outcome: Schema.OptionFromNullOr(SymmyEffectOutcomeSchema),
  ownerAuthContextRef: Schema.optionalKey(
    Schema.OptionFromNullOr(Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(500))),
  ),
  ownerExecutorPrincipalId: Schema.optionalKey(Schema.OptionFromNullOr(PrincipalIdSchema)),
  ownerInvocationId: Schema.optionalKey(
    Schema.OptionFromNullOr(Schema.String.check(Schema.isUUID()).pipe(Schema.brand('SymmyOwnerActionInvocationId'))),
  ),
  ownerReceipt: Schema.optionalKey(Schema.OptionFromNullOr(SymmyOwnerReceiptSchema)),
  ownerRequestHash: Schema.optionalKey(
    Schema.OptionFromNullOr(Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u))),
  ),
  resolvedEffect: Schema.optionalKey(Schema.OptionFromNullOr(SymmyPinnedEffectSchema)),
  state: Schema.Literals(['planned', 'attempting', 'indeterminate', 'blocked', 'settled']),
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export const SymmyExecutionJobSchema = Schema.Struct({
  effects: Schema.Array(SymmyExecutionEffectStateSchema),
  jobId: SymmyJobIdSchema,
  legalEntityId: Schema.OptionFromNullOr(LegalEntityIdSchema),
  lifecyclePolicy: Schema.optionalKey(Schema.OptionFromNullOr(SymmyJobLifecyclePolicyRefSchema)),
  mappingVersion: Schema.String,
  originalPrincipalId: PrincipalIdSchema,
  plan: SymmyPinnedJobPlanSchema,
  routeId: routeIdSchema,
  routeKey: Schema.optionalKey(SymmyDurableJobRouteKeySchema),
  routeRevision: Schema.String,
});
export type SymmyExecutionJob = typeof SymmyExecutionJobSchema.Type;

export const SymmyEffectClaimSchema = Schema.Struct({
  effect: Schema.OptionFromNullOr(SymmyPinnedEffectSchema),
  mode: Schema.Literals(['execute', 'recover', 'settled', 'busy', 'blocked']),
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type SymmyEffectClaim = typeof SymmyEffectClaimSchema.Type;
export type SymmyExecutionOutcome = typeof SymmyEffectOutcomeSchema.Type;

export const SymmyJobExecutionProjectionSchema = Schema.Struct({
  items: Schema.Array(SymmyItemOutcomeSchema),
  jobId: SymmyJobIdSchema,
  phase: Schema.Literals([
    'admitted',
    'running',
    'blocked',
    'completed_all',
    'completed_partial',
    'completed_none',
    'indeterminate',
  ]),
});

const unsupportedBranchOwners = {
  AssortmentHint: 'commerce.assortment',
  ReservedQuantityHint: 'commerce.inventory',
  TaxHint: 'commerce.tax',
} as const;

/** Unsupported source hints are immutable safe outcomes, never fictitious executable owner operations. */
export const projectSymmyUnsupportedBranches = (
  item: SymmyPinnedJobPlan['items'][number],
): readonly SymmyExecutionOutcome[] =>
  (item.unsupportedBranches ?? []).map((branch) => ({
    branchId: branch.branchId,
    owner: unsupportedBranchOwners[branch.kind],
    reason: branch.kind === 'ReservedQuantityHint' ? 'unsupported_meaning' : 'owner_not_activated',
    status: 'unsupported',
  }));
