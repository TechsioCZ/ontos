import type { OperationalScope, ReadServiceFactory } from '@app/core-runtime';
import { findPostgresFailure } from '@app/core-runtime';
import { and, eq } from 'drizzle-orm';
import { Effect, Option, Schema } from 'effect';
import { createHash, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import type { AttributeDefinition, AttributeValue } from '../../shared/domain/attribute-values.ts';
import {
  AttributeDefinitionSchema,
  AttributeValueSchema,
  trustedUnitConversions,
} from '../../shared/domain/attribute-values.ts';
import type {
  AttributeUnitChangeAssessment,
  EvidencedAttributeValue,
} from '../../shared/domain/attribute-unit-change.ts';
import { assessAttributeUnitChange } from '../../shared/domain/attribute-unit-change.ts';
import type { CartOpenSelectionPopulationPort } from '../../shared/domain/catalog-open-selection-population.ts';
import { readCartOpenSelectionPopulation } from '../../shared/domain/catalog-open-selection-population.ts';
import type { CatalogResourceRefInput } from '../../shared/domain/catalog-revision-reference.ts';
import type { ColorDetails } from '../../shared/domain/color.ts';
import { ColorDetailsSchema } from '../../shared/domain/color.ts';
import type { AttributeDefinitionRef } from '../../shared/resources/attribute-definition.ts';
import type { ControlledAttributeValueRef } from '../../shared/resources/controlled-attribute-value.ts';
import {
  attributeDefinitionRevisions,
  attributeDefinitions,
  attributeValueItems,
  attributeValueRevisions,
  attributeValueSets,
  controlledAttributeValueRevisions,
  controlledAttributeValues,
  productTypeRevisionAttributes,
  productTypes,
  productVariantAxes,
  productVariants,
} from '../database/schema.ts';
import { CatalogPersistenceUnavailable } from './errors.ts';
import { AttributePersistenceNotFound } from './attribute-persistence-not-found.ts';

export { AttributePersistenceNotFound } from './attribute-persistence-not-found.ts';

type ScopedTransaction = Parameters<ReadServiceFactory<Readonly<Record<string, never>>>>[0];

export class AttributePersistenceConflict extends Schema.TaggedError<AttributePersistenceConflict>()(
  'AttributePersistenceConflict',
  {
    code: Schema.Literal('attribute_persistence_conflict'),
    conflict: Schema.Literals([
      'IDENTITY',
      'ACTION_INVOCATION_ID',
      'REVISION',
      'INVALID_STATE',
      'INVALID_INPUT',
      'REMEDIATION_REQUIRED',
      'OPEN_SELECTION_IMPACT_UNAVAILABLE',
    ]),
    reason: Schema.String,
    /** The typed unit-change assessment that blocks a rule revision until the owner remediates. */
    remediation: Schema.optionalKey(
      Schema.Struct({
        kind: Schema.Literals(['REMEDIATION_REQUIRED', 'INDETERMINATE', 'NEW_DEFINITION_REQUIRED']),
        reasons: Schema.Array(Schema.String),
        subjects: Schema.Array(Schema.String),
      }),
    ),
  },
) {}

const unavailable = (cause: unknown): CatalogPersistenceUnavailable => {
  const failure = new CatalogPersistenceUnavailable({
    code: 'catalog_persistence_unavailable',
    reason: 'Catalog persistence is temporarily unavailable',
  });
  Object.defineProperty(failure, 'cause', { configurable: true, value: cause });
  return failure;
};

export const mapAttributeWriteError = (
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Core's PostgreSQL classifier parses this opaque driver cause; only typed failures leave this adapter. expires: 2027-03-31.
  error: unknown,
): AttributePersistenceConflict | CatalogPersistenceUnavailable => {
  const uniqueViolationSqlState = ['23', '505'].join('');
  const violation = findPostgresFailure(
    error,
    ({ code, constraint }) =>
      code === uniqueViolationSqlState &&
      [
        'attribute_definitions_pkey',
        'controlled_attribute_values_pkey',
        'catalog_attribute_definitions_scope_id_uk',
        'catalog_controlled_values_scope_id_uk',
      ].includes(constraint ?? ''),
  );
  if (Option.isSome(violation)) {
    return new AttributePersistenceConflict({
      code: 'attribute_persistence_conflict',
      conflict: 'IDENTITY',
      reason: 'Attribute identity already exists',
    });
  }
  const invocation = findPostgresFailure(
    error,
    ({ code, constraint }) =>
      code === uniqueViolationSqlState &&
      [
        'catalog_attribute_definition_revisions_invocation_uk',
        'catalog_controlled_value_revisions_invocation_uk',
      ].includes(constraint ?? ''),
  );
  if (Option.isSome(invocation)) {
    return new AttributePersistenceConflict({
      code: 'attribute_persistence_conflict',
      conflict: 'ACTION_INVOCATION_ID',
      reason: 'Action invocation already recorded',
    });
  }
  return unavailable(error);
};

interface ChangeMetadata {
  readonly actionInvocationId: string;
  readonly effectiveAt: Date;
  readonly evidenceRefs?: readonly string[];
  readonly principalId: string;
  readonly reason: string;
}

export interface CreateAttributeDefinitionInput extends ChangeMetadata {
  readonly allowsNone: boolean;
  readonly allowsNotApplicable: boolean;
  readonly allowsUnknown: boolean;
  readonly applicableLevels: readonly ('PRODUCT' | 'VARIANT')[];
  readonly canonicalUnit?: string | null;
  readonly controlledValueKind?: 'GENERAL' | 'COLOR' | 'SIZE' | null | undefined;
  readonly decimalPlaces?: number | null;
  readonly maximumValue?: string | null;
  readonly meaning: string;
  readonly measuredQuantity?: string | null;
  readonly minimumValue?: string | null;
  readonly multiplicity: 'SINGLE' | 'MULTIPLE';
  readonly name: string;
  readonly valueKind: 'TEXT' | 'CONTROLLED' | 'MEASUREMENT';
}

export interface RenameAttributeDefinitionInput extends ChangeMetadata {
  readonly attributeDefinitionRef: AttributeDefinitionRef;
  readonly evidence: string;
  readonly expectedRevision: number;
  readonly name: string;
  readonly sameMeaning: true;
}

/** The open-selection check must be an authoritative owner-local read in this same transaction. */
export interface ReviseAttributeDefinitionRulesInput extends ChangeMetadata {
  readonly attributeDefinitionRef: AttributeDefinitionRef;
  readonly evidence: string;
  readonly expectedRevision: number;
  readonly proposed: AttributeRuleProposal;
  readonly sameMeaning: true;
}

export type AttributeRuleProposal = Pick<
  AttributeDefinition,
  'levels' | 'measurement' | 'multiplicity' | 'specialStates'
>;

const AttributeRuleProposalSchema = Schema.Struct({
  levels: AttributeDefinitionSchema.fields.levels,
  measurement: AttributeDefinitionSchema.fields.measurement,
  multiplicity: AttributeDefinitionSchema.fields.multiplicity,
  specialStates: AttributeDefinitionSchema.fields.specialStates,
});

export interface CreateControlledAttributeValueInput extends ChangeMetadata {
  readonly attributeDefinitionRef: AttributeDefinitionRef;
  readonly color?: ColorDetails | undefined;
  readonly meaning: string;
  readonly name: string;
  readonly specialization: 'GENERAL' | 'COLOR' | 'SIZE';
}

export interface ChangeControlledAttributeValueInput extends ChangeMetadata {
  readonly controlledValueRef: ControlledAttributeValueRef;
  readonly evidence: string;
  readonly expectedRevision: number;
}

export interface RenameControlledAttributeValueInput extends ChangeControlledAttributeValueInput {
  readonly localizedNames?: ColorDetails['localizedNames'] | undefined;
  readonly name: string;
  readonly sameMeaning: true;
}

export interface ReactivateControlledAttributeValueInput extends ChangeControlledAttributeValueInput {
  readonly currentMeaningConfirmed: true;
}

const conflict = (kind: AttributePersistenceConflict['conflict'], reason: string) =>
  new AttributePersistenceConflict({ code: 'attribute_persistence_conflict', conflict: kind, reason });
const notFound = (resource: 'DEFINITION' | 'CONTROLLED_VALUE') =>
  new AttributePersistenceNotFound({
    code: 'attribute_persistence_not_found',
    reason: 'Attribute resource not found',
    resource,
  });
const validText = (value: string, max: number) => value === value.trim() && value.length > 0 && value.length <= max;
const CATALOG_MODULE_ID = 'commerce.catalog';
const validRef = (ref: AttributeDefinitionRef | ControlledAttributeValueRef, tenantId: string, resourceType: string) =>
  ref.tenantId === tenantId && ref.moduleId === CATALOG_MODULE_ID && ref.resourceType === resourceType;
const validDefinitionRef = (ref: AttributeDefinitionRef, tenantId: string) =>
  validRef(ref, tenantId, 'commerce.catalog.attribute-definition');
const validControlledValueRef = (ref: ControlledAttributeValueRef, tenantId: string) =>
  validRef(ref, tenantId, 'commerce.catalog.controlled-attribute-value');
const validControlledInput = (input: CreateControlledAttributeValueInput, tenantId: string) =>
  validDefinitionRef(input.attributeDefinitionRef, tenantId) &&
  validText(input.name, 240) &&
  validText(input.meaning, 1000) &&
  validText(input.reason, 1000);
const hasColorMetadata = (input: CreateControlledAttributeValueInput) => input.color !== undefined;

const colorAfterLocalizedRename = (
  current: ColorDetails | null,
  specialization: string,
  localizedNames: ColorDetails['localizedNames'] | undefined,
): ColorDetails | undefined | null => {
  if (localizedNames === undefined) {
    return current ?? undefined;
  }
  if (specialization !== 'COLOR' || current === null) {
    return null;
  }
  const next = { ...current, localizedNames };
  return Schema.is(ColorDetailsSchema)(next) ? next : null;
};

export interface AttributeImpactSnapshot {
  readonly directProducts: readonly string[];
  readonly directVariants: readonly string[];
  readonly inheritedVariants: readonly string[];
  readonly productTypes: readonly string[];
  readonly variantAxisProducts: readonly string[];
}

const proposedRuleSnapshot = (proposed: AttributeRuleProposal) => ({
  allowsNone: proposed.specialStates.includes('NONE') ? 1 : 0,
  allowsNotApplicable: proposed.specialStates.includes('NOT_APPLICABLE') ? 1 : 0,
  allowsUnknown: proposed.specialStates.includes('UNKNOWN') ? 1 : 0,
  applicableLevels: [...proposed.levels].toSorted(),
  canonicalUnit: proposed.measurement?.canonicalUnit ?? null,
  decimalPlaces: proposed.measurement?.decimalPlaces ?? null,
  maximumValue: proposed.measurement?.maximum?.toString() ?? null,
  measuredQuantity: proposed.measurement?.quantity ?? null,
  minimumValue: proposed.measurement?.minimum?.toString() ?? null,
  multiplicity: proposed.multiplicity,
});

const currentRuleSnapshot = (current: typeof attributeDefinitions.$inferSelect) => ({
  allowsNone: current.allowsNone,
  allowsNotApplicable: current.allowsNotApplicable,
  allowsUnknown: current.allowsUnknown,
  applicableLevels: [...current.applicableLevels].toSorted(),
  canonicalUnit: current.canonicalUnit,
  decimalPlaces: current.decimalPlaces,
  maximumValue: current.maximumValue,
  measuredQuantity: current.measuredQuantity,
  minimumValue: current.minimumValue,
  multiplicity: current.multiplicity,
});

type DefinitionRow = typeof attributeDefinitions.$inferSelect;

const specialStatesOf = (row: DefinitionRow): AttributeDefinition['specialStates'] => [
  ...(row.allowsUnknown === 1 ? (['UNKNOWN'] as const) : []),
  ...(row.allowsNone === 1 ? (['NONE'] as const) : []),
  ...(row.allowsNotApplicable === 1 ? (['NOT_APPLICABLE'] as const) : []),
];

interface DecodedMeasurement {
  canonicalUnit: string | null;
  decimalPlaces: number | null;
  maximum?: number;
  minimum?: number;
  quantity: string | null;
}

/** A definition rebuilt from a row or proposal before the domain Schema validates it. */
interface DefinitionCandidate {
  label: string;
  levels: readonly string[];
  meaning: string;
  measurement?: DecodedMeasurement;
  multiplicity: string;
  ref: AttributeDefinitionRef;
  specialStates: readonly string[];
  valueKind: string;
}

const asDomainDefinition = (row: DefinitionRow, ref: AttributeDefinitionRef): AttributeDefinition | null => {
  const candidate: DefinitionCandidate = {
    label: row.name,
    levels: row.applicableLevels,
    meaning: row.meaning,
    multiplicity: row.multiplicity,
    ref,
    specialStates: specialStatesOf(row),
    valueKind: row.valueKind,
  };
  if (row.valueKind === 'MEASUREMENT') {
    const measurement: DecodedMeasurement = {
      canonicalUnit: row.canonicalUnit,
      decimalPlaces: row.decimalPlaces,
      quantity: row.measuredQuantity,
    };
    if (row.minimumValue !== null) {
      measurement.minimum = Number(row.minimumValue);
    }
    if (row.maximumValue !== null) {
      measurement.maximum = Number(row.maximumValue);
    }
    candidate.measurement = measurement;
  }
  return Schema.is(AttributeDefinitionSchema)(candidate) ? candidate : null;
};

const asProposedDefinition = (
  current: DefinitionRow,
  proposed: AttributeRuleProposal,
  ref: AttributeDefinitionRef,
): AttributeDefinition | null => {
  const candidate: DefinitionCandidate = {
    label: current.name,
    levels: proposed.levels,
    meaning: current.meaning,
    multiplicity: proposed.multiplicity,
    ref,
    specialStates: proposed.specialStates,
    valueKind: current.valueKind,
  };
  if (proposed.measurement !== undefined) {
    candidate.measurement = proposed.measurement;
  }
  return Schema.is(AttributeDefinitionSchema)(candidate) ? candidate : null;
};

const ProductTypeIdSchema = Schema.String.pipe(Schema.brand('CatalogProductTypeId'));

const ValueRevisionSnapshotSchema = Schema.Struct({
  attributeDefinitionRevision: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0)),
  classification: Schema.optionalKey(Schema.Unknown),
  productTypeId: ProductTypeIdSchema,
  productTypeRevision: Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0)),
  // oxlint-disable-next-line effect-native/no-nullable-schema-field -- The persisted JSONB snapshot uses null as the stored "no source Product value" sentinel and is spread back verbatim when a value revision is rewritten, so an Option decode would change the persisted round trip; owner: #434; tracking: #398; expires: 2027-03-31.
  sourceProductValueRevision: Schema.NullOr(Schema.Finite.check(Schema.isInt(), Schema.isGreaterThan(0))),
  values: Schema.Array(AttributeValueSchema),
});
type ValueRevisionSnapshot = typeof ValueRevisionSnapshotSchema.Type;

const attributeValueItemRow = (
  value: AttributeValue,
  identity: { readonly attributeDefinitionId: string; readonly attributeValueSetId: string; readonly tenantId: string },
  ordinal: number,
): typeof attributeValueItems.$inferInsert => ({
  attributeDefinitionId: identity.attributeDefinitionId,
  attributeValueSetId: identity.attributeValueSetId,
  controlledAttributeValueId: value.kind === 'CONTROLLED' ? value.valueRef.resourceId : null,
  numericValue: value.kind === 'MEASUREMENT' ? String(value.amount) : null,
  ordinal,
  specialState: value.kind === 'SPECIAL' ? value.state : null,
  tenantId: identity.tenantId,
  textValue: value.kind === 'TEXT' ? value.text : null,
  unit: value.kind === 'MEASUREMENT' ? value.unit : null,
  valueKind: value.kind,
});

/**
 * One rule revision can migrate many value sets, while the append-only value revision ledger
 * requires a distinct Action invocation UUID for every row. Derive a stable UUIDv8 child identity
 * from the owning Action invocation and value-set identity so retries address the same revisions.
 */
const valueMigrationInvocationId = (actionInvocationId: string, attributeValueSetId: string): string => {
  const hex = createHash('sha256').update(actionInvocationId).update(':').update(attributeValueSetId).digest('hex');
  const variantNibble = ['8', '9', 'a', 'b'][Number.parseInt(hex.slice(16, 17), 16) % 4] ?? '8';
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variantNibble}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

interface ValueRewrite {
  readonly assessment: Extract<AttributeUnitChangeAssessment, { kind: 'CONVERTIBLE' }>;
  readonly set: typeof attributeValueSets.$inferSelect;
  readonly snapshot: ValueRevisionSnapshot;
  readonly subjectKey: string;
}

type ValueSetPlanFailureKind = Exclude<AttributeUnitChangeAssessment, { kind: 'CONVERTIBLE' }>['kind'];

type AttributeValueMigrationPlan =
  | { readonly kind: 'CONVERTIBLE'; readonly rewrites: readonly ValueRewrite[] }
  | {
      readonly kind: ValueSetPlanFailureKind;
      readonly reasons: readonly string[];
      readonly subjects: readonly string[];
    };

const valueMigrationSeverity = { INDETERMINATE: 1, NEW_DEFINITION_REQUIRED: 2, REMEDIATION_REQUIRED: 0 } as const;

/**
 * Assesses one recorded value set against a same-meaning rule revision. The caller folds every
 * subject so one nonconforming value never silently reinterprets the others; measured values are
 * only rewritten from an exact, evidenced conversion.
 */
const planValueSetMigration = Effect.fn('AttributePersistence.planValueSetMigration')(function* planValueSetMigration(
  transaction: ScopedTransaction,
  tenantId: string,
  attributeDefinitionRef: AttributeDefinitionRef,
  currentDefinition: AttributeDefinition,
  proposedDefinition: AttributeDefinition,
  set: typeof attributeValueSets.$inferSelect,
) {
  if (set.currentState !== 'SET') {
    return { outcome: 'SKIP' as const };
  }
  const subjectKey = set.variantId ?? set.productId;
  const subjectRef: CatalogResourceRefInput = {
    moduleId: CATALOG_MODULE_ID,
    resourceId: subjectKey,
    resourceType: set.variantId === null ? 'commerce.catalog.product' : 'commerce.catalog.variant',
    tenantId,
  };
  const [revisionRow] = yield* transaction
    .select()
    .from(attributeValueRevisions)
    .where(
      and(
        eq(attributeValueRevisions.tenantId, tenantId),
        eq(attributeValueRevisions.attributeValueSetId, set.attributeValueSetId),
        eq(attributeValueRevisions.revision, set.currentRevision),
      ),
    )
    .limit(1);
  const decoded =
    revisionRow === undefined
      ? Option.none()
      : Schema.decodeUnknownOption(ValueRevisionSnapshotSchema)(revisionRow.valueSnapshot);
  if (revisionRow === undefined || Option.isNone(decoded)) {
    return {
      failureKind: 'INDETERMINATE' as const,
      outcome: 'FAILURE' as const,
      reasons: ['Recorded value revision is absent'],
      subjectKey,
    };
  }
  const evidence = revisionRow.evidenceRefs.find((ref) => ref.trim().length > 0);
  if (evidence === undefined) {
    return {
      failureKind: 'INDETERMINATE' as const,
      outcome: 'FAILURE' as const,
      reasons: ['Recorded value evidence is absent'],
      subjectKey,
    };
  }
  const recorded: EvidencedAttributeValue[] = decoded.value.values.map((original, valueOrdinal) => ({
    original,
    provenance: {
      evidence,
      sourceDefinitionRef: attributeDefinitionRef,
      sourceDefinitionRevision: decoded.value.attributeDefinitionRevision,
      sourceUnit: original.kind === 'MEASUREMENT' ? original.unit : null,
      subjectRef,
      valueOrdinal,
    },
  }));
  const assessment = assessAttributeUnitChange(
    currentDefinition,
    proposedDefinition,
    subjectRef,
    decoded.value.attributeDefinitionRevision,
    recorded,
    trustedUnitConversions,
  );
  if (assessment.kind !== 'CONVERTIBLE') {
    return {
      failureKind: assessment.kind,
      outcome: 'FAILURE' as const,
      reasons: assessment.reasons,
      subjectKey,
    };
  }
  const needsRevision =
    currentDefinition.valueKind === 'MEASUREMENT' || !isDeepStrictEqual(assessment.converted, assessment.originals);
  return needsRevision
    ? { outcome: 'REWRITE' as const, rewrite: { assessment, set, snapshot: decoded.value, subjectKey } }
    : { outcome: 'SKIP' as const };
});

const remediationConflict = (
  kind: 'INDETERMINATE' | 'NEW_DEFINITION_REQUIRED' | 'REMEDIATION_REQUIRED',
  reasons: readonly string[],
  subjects: readonly string[],
): AttributePersistenceConflict =>
  new AttributePersistenceConflict({
    code: 'attribute_persistence_conflict',
    conflict: 'REMEDIATION_REQUIRED',
    reason: reasons.join('; ') || 'Nonconforming values require explicit remediation',
    remediation: { kind, reasons: [...reasons], subjects: [...subjects] },
  });

const validRuleRevisionInput = (input: ReviseAttributeDefinitionRulesInput, tenantId: string): boolean =>
  validDefinitionRef(input.attributeDefinitionRef, tenantId) &&
  Schema.is(AttributeRuleProposalSchema)(input.proposed) &&
  input.sameMeaning &&
  validText(input.evidence, 1000) &&
  validText(input.reason, 1000);

const preservesDefinitionMeaning = (
  current: typeof attributeDefinitions.$inferSelect,
  proposed: AttributeRuleProposal,
): boolean =>
  proposed.measurement?.quantity === (current.measuredQuantity ?? undefined) &&
  (current.valueKind === 'MEASUREMENT') === (proposed.measurement !== undefined);

interface ImpactRows {
  readonly axisProductIds: readonly string[];
  readonly controlledValueId?: string | undefined;
  readonly items: readonly Pick<
    typeof attributeValueItems.$inferSelect,
    'attributeValueSetId' | 'controlledAttributeValueId'
  >[];
  readonly productTypeIds: readonly string[];
  readonly sets: readonly Pick<
    typeof attributeValueSets.$inferSelect,
    'attributeValueSetId' | 'productId' | 'variantId' | 'currentState'
  >[];
  readonly variants: readonly Pick<typeof productVariants.$inferSelect, 'productId' | 'variantId'>[];
}

/** A current impact is derived from live sets only; revision rows are never rewritten or counted as current. */
export const deriveAttributeImpact = (rows: ImpactRows): AttributeImpactSnapshot => {
  const matchingSetIds = new Set<string>();
  if (rows.controlledValueId !== undefined) {
    for (const item of rows.items) {
      if (item.controlledAttributeValueId === rows.controlledValueId) {
        matchingSetIds.add(item.attributeValueSetId);
      }
    }
  }
  const productSources = new Set<string>();
  const overriddenVariants = new Set<string>();
  const directVariants = new Set<string>();
  for (const set of rows.sets) {
    if (set.currentState !== 'SET') {
      continue;
    }
    const matches = rows.controlledValueId === undefined || matchingSetIds.has(set.attributeValueSetId);
    if (set.variantId === null) {
      if (matches) {
        productSources.add(set.productId);
      }
    } else {
      overriddenVariants.add(set.variantId);
      if (matches) {
        directVariants.add(set.variantId);
      }
    }
  }
  const inheritedVariants: string[] = [];
  for (const variant of rows.variants) {
    if (productSources.has(variant.productId) && !overriddenVariants.has(variant.variantId)) {
      inheritedVariants.push(variant.variantId);
    }
  }
  return {
    directProducts: [...productSources].toSorted(),
    directVariants: [...directVariants].toSorted(),
    inheritedVariants: inheritedVariants.toSorted(),
    productTypes: [...new Set(rows.productTypeIds)].toSorted(),
    variantAxisProducts: [...new Set(rows.axisProductIds)].toSorted(),
  };
};

/** Transaction-scoped current impact for a future #479 attestation; open selections require a separate authority. */
const inspectAttributeImpactForScope = Effect.fn('AttributePersistence.inspectAttributeImpactForScope')(
  function* inspectAttributeImpact(
    transaction: ScopedTransaction,
    scope: OperationalScope,
    attributeDefinitionRef: AttributeDefinitionRef,
    controlledValueRef?: ControlledAttributeValueRef,
  ) {
    const { tenantId } = scope;
    if (
      !validDefinitionRef(attributeDefinitionRef, tenantId) ||
      (controlledValueRef !== undefined && !validControlledValueRef(controlledValueRef, tenantId))
    ) {
      return yield* conflict('INVALID_INPUT', 'Attribute impact reference is outside the trusted Tenant');
    }
    const definitionId = attributeDefinitionRef.resourceId;
    const [definition] = yield* transaction
      .select({ attributeDefinitionId: attributeDefinitions.attributeDefinitionId })
      .from(attributeDefinitions)
      .where(
        and(eq(attributeDefinitions.tenantId, tenantId), eq(attributeDefinitions.attributeDefinitionId, definitionId)),
      )
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (definition === undefined) {
      return yield* notFound('DEFINITION');
    }
    if (controlledValueRef !== undefined) {
      const [value] = yield* transaction
        .select({ attributeDefinitionId: controlledAttributeValues.attributeDefinitionId })
        .from(controlledAttributeValues)
        .where(
          and(
            eq(controlledAttributeValues.tenantId, tenantId),
            eq(controlledAttributeValues.controlledAttributeValueId, controlledValueRef.resourceId),
          ),
        )
        .limit(1)
        .pipe(Effect.mapError(unavailable));
      if (value === undefined || value.attributeDefinitionId !== definitionId) {
        return yield* notFound('CONTROLLED_VALUE');
      }
    }
    const { axes, items, sets, typeRules, types, variants } = yield* Effect.all(
      {
        axes: transaction
          .select({ productId: productVariantAxes.productId })
          .from(productVariantAxes)
          .where(
            and(eq(productVariantAxes.tenantId, tenantId), eq(productVariantAxes.attributeDefinitionId, definitionId)),
          )
          .pipe(Effect.mapError(unavailable)),
        items: transaction
          .select({
            attributeValueSetId: attributeValueItems.attributeValueSetId,
            controlledAttributeValueId: attributeValueItems.controlledAttributeValueId,
          })
          .from(attributeValueItems)
          .where(
            and(
              eq(attributeValueItems.tenantId, tenantId),
              eq(attributeValueItems.attributeDefinitionId, definitionId),
            ),
          )
          .pipe(Effect.mapError(unavailable)),
        sets: transaction
          .select({
            attributeValueSetId: attributeValueSets.attributeValueSetId,
            currentState: attributeValueSets.currentState,
            productId: attributeValueSets.productId,
            variantId: attributeValueSets.variantId,
          })
          .from(attributeValueSets)
          .where(
            and(eq(attributeValueSets.tenantId, tenantId), eq(attributeValueSets.attributeDefinitionId, definitionId)),
          )
          .pipe(Effect.mapError(unavailable)),
        typeRules: transaction
          .select({
            productTypeId: productTypeRevisionAttributes.productTypeId,
            revision: productTypeRevisionAttributes.revision,
          })
          .from(productTypeRevisionAttributes)
          .where(
            and(
              eq(productTypeRevisionAttributes.tenantId, tenantId),
              eq(productTypeRevisionAttributes.attributeDefinitionId, definitionId),
            ),
          )
          .pipe(Effect.mapError(unavailable)),
        types: transaction
          .select({ currentRevision: productTypes.currentRevision, productTypeId: productTypes.productTypeId })
          .from(productTypes)
          .where(eq(productTypes.tenantId, tenantId))
          .pipe(Effect.mapError(unavailable)),
        variants: transaction
          .select({ productId: productVariants.productId, variantId: productVariants.variantId })
          .from(productVariants)
          .where(eq(productVariants.tenantId, tenantId))
          .pipe(Effect.mapError(unavailable)),
      },
      { concurrency: 6 },
    );
    const currentTypeRevisions = new Set(types.map((type) => `${type.productTypeId}:${type.currentRevision}`));
    const productTypeIds: string[] = [];
    for (const rule of typeRules) {
      if (currentTypeRevisions.has(`${rule.productTypeId}:${rule.revision}`)) {
        productTypeIds.push(rule.productTypeId);
      }
    }
    return deriveAttributeImpact({
      axisProductIds: axes.map((axis) => axis.productId),
      controlledValueId: controlledValueRef?.resourceId,
      items,
      productTypeIds,
      sets,
      variants,
    });
  },
);

/** All methods run only on the Core-owned, tenant-scoped Action transaction. */
export const attributePersistenceForScope = (
  transaction: ScopedTransaction,
  scope: OperationalScope,
  authoritativeBasis: {
    /**
     * Injected #479 Cart owner contract for the complete open-selection population. Catalog owns no
     * durable population of its own; an absent or failing port stays a typed unavailable outcome and
     * never becomes "no open selections".
     */
    readonly openSelections?: CartOpenSelectionPopulationPort;
  } = {},
) => {
  const { tenantId } = scope;
  const createDefinition = Effect.fn('AttributePersistence.createDefinition')(function* createDefinition(
    input: CreateAttributeDefinitionInput,
  ) {
    if (!validText(input.name, 240) || !validText(input.meaning, 1000) || !validText(input.reason, 1000)) {
      return yield* conflict('INVALID_INPUT', 'Invalid attribute definition input');
    }
    if (
      input.applicableLevels.length < 1 ||
      input.applicableLevels.length > 2 ||
      new Set(input.applicableLevels).size !== input.applicableLevels.length ||
      input.applicableLevels.some((level) => level !== 'PRODUCT' && level !== 'VARIANT')
    ) {
      return yield* conflict('INVALID_INPUT', 'Invalid attribute applicability levels');
    }
    if (
      (input.valueKind === 'CONTROLLED') !==
      (input.controlledValueKind !== null && input.controlledValueKind !== undefined)
    ) {
      return yield* conflict('INVALID_INPUT', 'Controlled definition specialization is missing or inapplicable');
    }
    const attributeDefinitionId = randomUUID();
    const snapshot = {
      allowsNone: input.allowsNone ? 1 : 0,
      allowsNotApplicable: input.allowsNotApplicable ? 1 : 0,
      allowsUnknown: input.allowsUnknown ? 1 : 0,
      applicableLevels: [...input.applicableLevels],
      attributeDefinitionId,
      canonicalUnit: input.canonicalUnit ?? null,
      controlledValueKind: input.controlledValueKind ?? null,
      decimalPlaces: input.decimalPlaces ?? null,
      maximumValue: input.maximumValue ?? null,
      meaning: input.meaning,
      measuredQuantity: input.measuredQuantity ?? null,
      minimumValue: input.minimumValue ?? null,
      multiplicity: input.multiplicity,
      name: input.name,
      tenantId,
      valueKind: input.valueKind,
    };
    yield* transaction
      .insert(attributeDefinitions)
      .values({
        ...snapshot,
        createdByActionInvocationId: input.actionInvocationId,
        createdByPrincipalId: input.principalId,
        currentRevision: 1,
      })
      .pipe(Effect.mapError(mapAttributeWriteError));
    yield* transaction
      .insert(attributeDefinitionRevisions)
      .values({
        ...snapshot,
        actingPrincipalId: input.principalId,
        actionInvocationId: input.actionInvocationId,
        effectiveAt: input.effectiveAt,
        evidenceRefs: [...(input.evidenceRefs ?? [])],
        reason: input.reason,
        revision: 1,
      })
      .pipe(Effect.mapError(mapAttributeWriteError));
    return {
      attributeDefinitionRef: {
        moduleId: CATALOG_MODULE_ID,
        resourceId: attributeDefinitionId,
        resourceType: 'commerce.catalog.attribute-definition' as const,
        tenantId,
      },
      revision: 1,
    };
  });

  const renameDefinition = Effect.fn('AttributePersistence.renameDefinition')(function* renameDefinition(
    input: RenameAttributeDefinitionInput,
  ) {
    if (!validDefinitionRef(input.attributeDefinitionRef, tenantId)) {
      return yield* conflict('INVALID_INPUT', 'Attribute reference is outside the trusted Tenant');
    }
    if (
      !input.sameMeaning ||
      !validText(input.evidence, 1000) ||
      !validText(input.name, 240) ||
      !validText(input.reason, 1000)
    ) {
      return yield* conflict('INVALID_INPUT', 'Rename requires evidence of unchanged meaning');
    }
    const id = input.attributeDefinitionRef.resourceId;
    const [current] = yield* transaction
      .select()
      .from(attributeDefinitions)
      .where(and(eq(attributeDefinitions.tenantId, tenantId), eq(attributeDefinitions.attributeDefinitionId, id)))
      .for('update')
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (current === undefined) {
      return yield* notFound('DEFINITION');
    }
    if (current.currentRevision !== input.expectedRevision) {
      return yield* conflict('REVISION', 'Attribute definition revision changed');
    }
    if (current.name === input.name) {
      return {
        attributeDefinitionRef: input.attributeDefinitionRef,
        changed: false,
        revision: current.currentRevision,
      };
    }
    const revision = current.currentRevision + 1;
    yield* transaction
      .update(attributeDefinitions)
      .set({ currentRevision: revision, name: input.name })
      .where(and(eq(attributeDefinitions.tenantId, tenantId), eq(attributeDefinitions.attributeDefinitionId, id)))
      .pipe(Effect.mapError(mapAttributeWriteError));
    yield* transaction
      .insert(attributeDefinitionRevisions)
      .values({
        actingPrincipalId: input.principalId,
        actionInvocationId: input.actionInvocationId,
        allowsNone: current.allowsNone,
        allowsNotApplicable: current.allowsNotApplicable,
        allowsUnknown: current.allowsUnknown,
        applicableLevels: current.applicableLevels,
        attributeDefinitionId: id,
        canonicalUnit: current.canonicalUnit,
        controlledValueKind: current.controlledValueKind,
        decimalPlaces: current.decimalPlaces,
        effectiveAt: input.effectiveAt,
        evidenceRefs: [...(input.evidenceRefs ?? []), input.evidence],
        maximumValue: current.maximumValue,
        meaning: current.meaning,
        measuredQuantity: current.measuredQuantity,
        minimumValue: current.minimumValue,
        multiplicity: current.multiplicity,
        name: input.name,
        reason: input.reason,
        revision,
        tenantId,
        valueKind: current.valueKind,
      })
      .pipe(Effect.mapError(mapAttributeWriteError));
    return { attributeDefinitionRef: input.attributeDefinitionRef, changed: true, revision };
  });

  const planValueMigration = Effect.fn('AttributePersistence.planValueMigration')(function* planValueMigration(
    attributeDefinitionRef: AttributeDefinitionRef,
    currentDefinition: AttributeDefinition,
    proposedDefinition: AttributeDefinition,
  ): Effect.fn.Return<AttributeValueMigrationPlan, unknown> {
    const definitionId = attributeDefinitionRef.resourceId;
    const sets = yield* transaction
      .select()
      .from(attributeValueSets)
      .where(
        and(eq(attributeValueSets.tenantId, tenantId), eq(attributeValueSets.attributeDefinitionId, definitionId)),
      );
    const plans = yield* Effect.forEach(
      sets,
      (set) =>
        planValueSetMigration(
          transaction,
          tenantId,
          attributeDefinitionRef,
          currentDefinition,
          proposedDefinition,
          set,
        ),
      { concurrency: 1 },
    );
    const rewrites = plans.flatMap((plan) => (plan.outcome === 'REWRITE' ? [plan.rewrite] : []));
    const failures = plans.flatMap((plan) => (plan.outcome === 'FAILURE' ? [plan] : []));
    if (failures.length === 0) {
      return { kind: 'CONVERTIBLE' as const, rewrites };
    }
    const failureKinds = failures.map((failure) => failure.failureKind);
    const [highestKind] = failureKinds.toSorted(
      (left, right) => valueMigrationSeverity[right] - valueMigrationSeverity[left],
    );
    return {
      kind: highestKind ?? 'REMEDIATION_REQUIRED',
      reasons: failures.flatMap((failure) => failure.reasons),
      subjects: [...new Set(failures.map((failure) => failure.subjectKey))],
    };
  }, Effect.mapError(unavailable));

  const migrateValueSet = Effect.fn('AttributePersistence.migrateValueSet')(function* migrateValueSet(
    input: ReviseAttributeDefinitionRulesInput,
    rewrite: ValueRewrite,
    definitionRevision: number,
  ) {
    const setId = rewrite.set.attributeValueSetId;
    const nextSetRevision = rewrite.set.currentRevision + 1;
    yield* transaction
      .delete(attributeValueItems)
      .where(and(eq(attributeValueItems.tenantId, tenantId), eq(attributeValueItems.attributeValueSetId, setId)));
    yield* transaction
      .insert(attributeValueItems)
      .values(
        rewrite.assessment.converted.map((value, ordinal) =>
          attributeValueItemRow(
            value,
            { attributeDefinitionId: input.attributeDefinitionRef.resourceId, attributeValueSetId: setId, tenantId },
            ordinal,
          ),
        ),
      );
    yield* transaction
      .update(attributeValueSets)
      .set({ currentRevision: nextSetRevision })
      .where(and(eq(attributeValueSets.tenantId, tenantId), eq(attributeValueSets.attributeValueSetId, setId)));
    yield* transaction.insert(attributeValueRevisions).values({
      actingPrincipalId: input.principalId,
      actionInvocationId: valueMigrationInvocationId(input.actionInvocationId, setId),
      attributeValueSetId: setId,
      changeKind: 'SET',
      evidenceRefs: [...(input.evidenceRefs ?? []), input.evidence],
      reason: input.reason,
      revision: nextSetRevision,
      tenantId,
      valueSnapshot: {
        ...rewrite.snapshot,
        attributeDefinitionRevision: definitionRevision,
        values: rewrite.assessment.converted,
      },
    });
  }, Effect.mapError(mapAttributeWriteError));

  const reviseDefinitionRules = Effect.fn('AttributePersistence.reviseDefinitionRules')(function* reviseDefinitionRules(
    input: ReviseAttributeDefinitionRulesInput,
  ) {
    if (!validRuleRevisionInput(input, tenantId)) {
      return yield* conflict('INVALID_INPUT', 'Rule revision requires a valid same-meaning proposal and evidence');
    }
    const id = input.attributeDefinitionRef.resourceId;
    const [current] = yield* transaction
      .select()
      .from(attributeDefinitions)
      .where(and(eq(attributeDefinitions.tenantId, tenantId), eq(attributeDefinitions.attributeDefinitionId, id)))
      .for('update')
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (current === undefined) {
      return yield* notFound('DEFINITION');
    }
    if (current.currentRevision !== input.expectedRevision) {
      return yield* conflict('REVISION', 'Attribute definition revision changed');
    }
    const { proposed } = input;
    if (
      !preservesDefinitionMeaning(current, proposed) ||
      !Schema.is(AttributeDefinitionSchema)({
        ...proposed,
        label: current.name,
        meaning: current.meaning,
        ref: input.attributeDefinitionRef,
        valueKind: current.valueKind,
      })
    ) {
      return yield* conflict('INVALID_INPUT', 'Changed meaning or value kind requires a new definition');
    }
    const currentDefinition = asDomainDefinition(current, input.attributeDefinitionRef);
    const proposedDefinition = asProposedDefinition(current, proposed, input.attributeDefinitionRef);
    if (currentDefinition === null || proposedDefinition === null) {
      return yield* conflict('INVALID_INPUT', 'Changed meaning or value kind requires a new definition');
    }
    const proposedRules = proposedRuleSnapshot(proposed);
    if (isDeepStrictEqual(proposedRules, currentRuleSnapshot(current))) {
      return {
        attributeDefinitionRef: input.attributeDefinitionRef,
        changed: false,
        revision: current.currentRevision,
      };
    }
    const { openSelections } = authoritativeBasis;
    if (openSelections === undefined) {
      return yield* conflict(
        'OPEN_SELECTION_IMPACT_UNAVAILABLE',
        'Owner-confirmed Cart open-selection population is unavailable; Attribute Definition rules cannot change',
      );
    }
    const population = yield* readCartOpenSelectionPopulation(openSelections, tenantId).pipe(
      Effect.catchTag('CartOpenSelectionPopulationUnavailable', (failure) =>
        Effect.fail(
          conflict('OPEN_SELECTION_IMPACT_UNAVAILABLE', `Open-selection population is unavailable: ${failure.reason}`),
        ),
      ),
    );
    // Preserve owner-first ordering so an invalid foreign attestation cannot trigger Catalog scans.
    // oxlint-disable-next-line effect-native/no-sequential-independent-yields -- Security boundary ordering is deliberate.
    const impact = yield* inspectAttributeImpactForScope(transaction, scope, input.attributeDefinitionRef);
    const impactedProducts = new Set(impact.directProducts);
    const impactedVariants = new Set([...impact.directVariants, ...impact.inheritedVariants]);
    if (
      population.selections.some(
        (reference) =>
          (reference.selection.productRef.moduleId === CATALOG_MODULE_ID &&
            impactedProducts.has(reference.selection.productRef.resourceId)) ||
          impactedVariants.has(reference.selection.variantRef.resourceId),
      )
    ) {
      return yield* conflict(
        'REMEDIATION_REQUIRED',
        'Affected open selections require Current reassessment before Attribute Definition rules can change',
      );
    }
    const revision = current.currentRevision + 1;
    const plan = yield* planValueMigration(input.attributeDefinitionRef, currentDefinition, proposedDefinition);
    if (plan.kind !== 'CONVERTIBLE') {
      return yield* remediationConflict(plan.kind, plan.reasons, plan.subjects);
    }
    yield* Effect.forEach(plan.rewrites, (rewrite) => migrateValueSet(input, rewrite, revision), { concurrency: 1 });
    const rules = proposedRules;
    yield* transaction
      .update(attributeDefinitions)
      .set({ ...rules, currentRevision: revision })
      .where(and(eq(attributeDefinitions.tenantId, tenantId), eq(attributeDefinitions.attributeDefinitionId, id)))
      .pipe(Effect.mapError(mapAttributeWriteError));
    yield* transaction
      .insert(attributeDefinitionRevisions)
      .values({
        ...rules,
        actingPrincipalId: input.principalId,
        actionInvocationId: input.actionInvocationId,
        attributeDefinitionId: id,
        controlledValueKind: current.controlledValueKind,
        effectiveAt: input.effectiveAt,
        evidenceRefs: [...(input.evidenceRefs ?? []), input.evidence],
        meaning: current.meaning,
        name: current.name,
        reason: input.reason,
        revision,
        tenantId,
        valueKind: current.valueKind,
      })
      .pipe(Effect.mapError(mapAttributeWriteError));
    return { attributeDefinitionRef: input.attributeDefinitionRef, changed: true, revision };
  });

  const createControlledValue = Effect.fn('AttributePersistence.createControlledValue')(function* createControlledValue(
    input: CreateControlledAttributeValueInput,
  ) {
    if (!validControlledInput(input, tenantId)) {
      return yield* conflict('INVALID_INPUT', 'Invalid controlled value input');
    }
    if ((input.specialization === 'COLOR') !== hasColorMetadata(input)) {
      return yield* conflict('INVALID_INPUT', 'Color metadata does not match specialization');
    }
    if (input.color !== undefined && !Schema.is(ColorDetailsSchema)(input.color)) {
      return yield* conflict('INVALID_INPUT', 'Color distinction evidence is invalid');
    }
    const [definition] = yield* transaction
      .select({
        controlledValueKind: attributeDefinitions.controlledValueKind,
        valueKind: attributeDefinitions.valueKind,
      })
      .from(attributeDefinitions)
      .where(
        and(
          eq(attributeDefinitions.tenantId, tenantId),
          eq(attributeDefinitions.attributeDefinitionId, input.attributeDefinitionRef.resourceId),
        ),
      )
      .for('update')
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (definition === undefined) {
      return yield* notFound('DEFINITION');
    }
    if (definition.valueKind !== 'CONTROLLED') {
      return yield* conflict('INVALID_STATE', 'Definition does not own controlled values');
    }
    if (definition.controlledValueKind !== input.specialization) {
      return yield* conflict('INVALID_STATE', 'Controlled value specialization differs from its definition');
    }
    const controlledAttributeValueId = randomUUID();
    const snapshot = {
      attributeDefinitionId: input.attributeDefinitionRef.resourceId,
      colorDetails: input.color ?? null,
      colorGroup: input.color?.groupName ?? null,
      controlledAttributeValueId,
      lifecycleState: 'ACTIVE',
      meaning: input.meaning,
      name: input.name,
      previewEvidenceRef: null,
      previewHex: input.color?.preview?.kind === 'HEX' ? input.color.preview.hex : null,
      specialization: input.specialization,
      swatchCode:
        input.color?.distinctionEvidence.kind === 'SWATCH' ? input.color.distinctionEvidence.designation : null,
      swatchSystem: input.color?.distinctionEvidence.kind === 'SWATCH' ? input.color.distinctionEvidence.system : null,
      tenantId,
    };
    yield* transaction
      .insert(controlledAttributeValues)
      .values({
        ...snapshot,
        createdByActionInvocationId: input.actionInvocationId,
        createdByPrincipalId: input.principalId,
        currentRevision: 1,
      })
      .pipe(Effect.mapError(mapAttributeWriteError));
    yield* transaction
      .insert(controlledAttributeValueRevisions)
      .values({
        ...snapshot,
        actingPrincipalId: input.principalId,
        actionInvocationId: input.actionInvocationId,
        effectiveAt: input.effectiveAt,
        evidenceRefs: [...(input.evidenceRefs ?? [])],
        reason: input.reason,
        revision: 1,
      })
      .pipe(Effect.mapError(mapAttributeWriteError));
    return {
      controlledValueRef: {
        moduleId: CATALOG_MODULE_ID,
        resourceId: controlledAttributeValueId,
        resourceType: 'commerce.catalog.controlled-attribute-value' as const,
        tenantId,
      },
      revision: 1,
    };
  });

  const changeValue = Effect.fn('AttributePersistence.changeValue')(function* changeValue(
    input: ChangeControlledAttributeValueInput,
    change: { lifecycleState?: 'ACTIVE' | 'RETIRED'; localizedNames?: ColorDetails['localizedNames']; name?: string },
  ) {
    if (
      !validControlledValueRef(input.controlledValueRef, tenantId) ||
      !validText(input.evidence, 1000) ||
      !validText(input.reason, 1000)
    ) {
      return yield* conflict('INVALID_INPUT', 'Controlled value change requires evidence');
    }
    const id = input.controlledValueRef.resourceId;
    const [current] = yield* transaction
      .select()
      .from(controlledAttributeValues)
      .where(
        and(
          eq(controlledAttributeValues.tenantId, tenantId),
          eq(controlledAttributeValues.controlledAttributeValueId, id),
        ),
      )
      .for('update')
      .limit(1)
      .pipe(Effect.mapError(unavailable));
    if (current === undefined) {
      return yield* notFound('CONTROLLED_VALUE');
    }
    if (current.currentRevision !== input.expectedRevision) {
      return yield* conflict('REVISION', 'Controlled value revision changed');
    }
    const name = change.name ?? current.name;
    const lifecycleState = change.lifecycleState ?? current.lifecycleState;
    const previousColor = current.colorDetails ?? undefined;
    const color = colorAfterLocalizedRename(current.colorDetails, current.specialization, change.localizedNames);
    if (color === null) {
      return yield* conflict('INVALID_INPUT', 'Localized Color rename requires valid existing Color details');
    }
    if (name === current.name && lifecycleState === current.lifecycleState && isDeepStrictEqual(color, previousColor)) {
      return {
        changed: false,
        controlledValueRef: input.controlledValueRef,
        lifecycle: current.lifecycleState,
        revision: current.currentRevision,
      };
    }
    const revision = current.currentRevision + 1;
    yield* transaction
      .update(controlledAttributeValues)
      .set({ colorDetails: color ?? null, currentRevision: revision, lifecycleState, name })
      .where(
        and(
          eq(controlledAttributeValues.tenantId, tenantId),
          eq(controlledAttributeValues.controlledAttributeValueId, id),
        ),
      )
      .pipe(Effect.mapError(mapAttributeWriteError));
    yield* transaction
      .insert(controlledAttributeValueRevisions)
      .values({
        actingPrincipalId: input.principalId,
        actionInvocationId: input.actionInvocationId,
        attributeDefinitionId: current.attributeDefinitionId,
        colorDetails: color ?? null,
        colorGroup: current.colorGroup,
        controlledAttributeValueId: id,
        effectiveAt: input.effectiveAt,
        evidenceRefs: [...(input.evidenceRefs ?? []), input.evidence],
        lifecycleState,
        meaning: current.meaning,
        name,
        previewEvidenceRef: current.previewEvidenceRef,
        previewHex: current.previewHex,
        reason: input.reason,
        revision,
        specialization: current.specialization,
        swatchCode: current.swatchCode,
        swatchSystem: current.swatchSystem,
        tenantId,
      })
      .pipe(Effect.mapError(mapAttributeWriteError));
    return { changed: true, controlledValueRef: input.controlledValueRef, lifecycle: lifecycleState, revision };
  });

  return Effect.succeed({
    createControlledValue,
    createDefinition,
    reactivateControlledValue: (input: ReactivateControlledAttributeValueInput) =>
      input.currentMeaningConfirmed
        ? changeValue(input, { lifecycleState: 'ACTIVE' })
        : Effect.fail(conflict('INVALID_INPUT', 'Reactivation requires current meaning confirmation')),
    renameControlledValue: (input: RenameControlledAttributeValueInput) =>
      input.sameMeaning && validText(input.name, 240)
        ? changeValue(input, { localizedNames: input.localizedNames, name: input.name })
        : Effect.fail(conflict('INVALID_INPUT', 'Rename requires unchanged meaning and a valid name')),
    renameDefinition,
    retireControlledValue: (input: ChangeControlledAttributeValueInput) =>
      changeValue(input, { lifecycleState: 'RETIRED' }),
    reviseDefinitionRules,
  });
};

export type AttributePersistence = Effect.Success<ReturnType<typeof attributePersistenceForScope>>;
