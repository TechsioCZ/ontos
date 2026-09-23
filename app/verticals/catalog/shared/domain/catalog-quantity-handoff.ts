import { Option, Result, Schema } from 'effect';
import { OwnerVerifiableSetCompletenessEvidenceSchema } from '@app/shared-contracts';

import { assessCatalogSelection } from './catalog-selection-assessment.ts';
import type { CatalogSelectionCurrentFacts } from './catalog-selection-assessment.ts';
import {
  CatalogSelectionRevisionSchema,
  CatalogSelectionSchema,
  CatalogSelectionValidEvidenceSchema,
} from './catalog-selection-evidence.ts';
import type { CatalogSelection, CatalogSelectionEvidence } from './catalog-selection-evidence.ts';
import type { CatalogResourceRef } from './catalog-revision-reference.ts';
import {
  CatalogResourceRefSchema,
  CatalogRevisionNumberSchema,
  sameCatalogRevisionReference,
} from './catalog-revision-reference.ts';
import { resolvePackageContent } from './package-content.ts';
import type { PackageContentRevision, PackageResolution } from './package-content.ts';
import type { QuantityNormalization } from './purchase-quantity.ts';
import { VariantExactFormSchema } from './variant-exact-form.ts';

const quantityText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed());
const CatalogQuantityTargetIdSchema = Schema.String.check(Schema.isUUID(), Schema.isTrimmed()).pipe(
  Schema.brand('CatalogQuantityTargetId'),
  Schema.decodeTo(Schema.String),
);
const CatalogQuantityTenantIdSchema = Schema.String.check(Schema.isUUID(), Schema.isTrimmed()).pipe(
  Schema.brand('CatalogQuantityTenantId'),
  Schema.decodeTo(Schema.String),
);
const CatalogQuantityUnitIdSchema = Schema.String.check(Schema.isUUID(), Schema.isTrimmed()).pipe(
  Schema.brand('CatalogQuantityUnitId'),
  Schema.decodeTo(Schema.String),
);
const CatalogQuantityConfigurationKeySchema = quantityText.pipe(
  Schema.brand('CatalogQuantityConfigurationKey'),
  Schema.decodeTo(quantityText),
);
const validQuantitySchema = Schema.Struct({
  changed: Schema.Boolean,
  notice: Schema.Union([Schema.Literal('ROUNDED'), Schema.Null]),
  requested: quantityText,
  resulting: quantityText,
  rounding: Schema.Literals(['UP', 'DOWN', 'HALF_UP']),
  status: Schema.Literal('VALID'),
  step: quantityText,
  targetId: CatalogQuantityTargetIdSchema,
  tenantId: CatalogQuantityTenantIdSchema,
  unitId: CatalogQuantityUnitIdSchema,
  unitRuleRevision: Schema.Int.check(Schema.isBetween({ maximum: 2_147_483_647, minimum: 1 })),
});
const packageResolutionSchema = Schema.Struct({
  amount: quantityText,
  path: Schema.Array(CatalogSelectionRevisionSchema),
  status: Schema.Literal('VALID'),
  unitRef: CatalogResourceRefSchema,
});
const packageContentRevisionSchema = Schema.Struct({
  amount: quantityText,
  configurationKey: Schema.optionalKey(CatalogQuantityConfigurationKeySchema),
  form: VariantExactFormSchema,
  lower: Schema.optionalKey(Schema.Struct({ count: quantityText, revision: CatalogSelectionRevisionSchema })),
  reference: CatalogSelectionRevisionSchema,
  setComposition: Schema.optionalKey(CatalogSelectionRevisionSchema),
  unitRef: CatalogResourceRefSchema,
});

const CatalogQuantityHandoffCoreReadySchema = Schema.Struct({
  divisible: Schema.Boolean,
  evidence: CatalogSelectionValidEvidenceSchema,
  packageContent: Schema.optionalKey(packageResolutionSchema),
  packageRevision: Schema.optionalKey(packageContentRevisionSchema),
  quantity: validQuantitySchema,
  selection: CatalogSelectionSchema,
  status: Schema.Literal('READY'),
  unitRef: CatalogResourceRefSchema,
});
type CatalogQuantityHandoffCoreReady = typeof CatalogQuantityHandoffCoreReadySchema.Type;

const CatalogQuantityHandoffFailureSchema = Schema.Struct({
  reason: Schema.String,
  status: Schema.Literals(['INVALID', 'UNVERIFIABLE', 'STALE']),
});

const ownerReference = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1000), Schema.isTrimmed());
const CatalogEquivalentSelectionKeySchema = ownerReference.pipe(
  Schema.brand('CatalogEquivalentSelectionKey'),
  Schema.decodeTo(ownerReference),
);
export const CatalogQuantityBasisSchema = Schema.Struct({
  targetDivisibilityRevision: Schema.Int.check(Schema.isBetween({ maximum: 2_147_483_647, minimum: 1 })),
  targetRef: CatalogResourceRefSchema,
  unitRef: CatalogResourceRefSchema,
  unitRuleRevision: Schema.Int.check(Schema.isBetween({ maximum: 2_147_483_647, minimum: 1 })),
}).check(
  Schema.makeFilter(({ targetRef, unitRef }) =>
    targetRef.tenantId === unitRef.tenantId ? undefined : 'Quantity target and Unit must share one Tenant',
  ),
);
export type CatalogQuantityBasis = typeof CatalogQuantityBasisSchema.Type;

const CatalogQuantityHandoffReadySchema = Schema.Struct({
  ...CatalogQuantityHandoffCoreReadySchema.fields,
  completeness: Schema.toEncoded(OwnerVerifiableSetCompletenessEvidenceSchema),
  equivalentSelectionKey: CatalogEquivalentSelectionKeySchema,
  hierarchyRevision: ownerReference,
  ownerRevision: ownerReference,
  quantityBasis: CatalogQuantityBasisSchema,
});
export type CatalogQuantityHandoffReady = typeof CatalogQuantityHandoffReadySchema.Type;

/** Public Commerce handoff: exact Catalog facts and evidence, without a customer policy verdict. */
export const CatalogQuantityHandoffSchema = Schema.Union([
  CatalogQuantityHandoffReadySchema,
  CatalogQuantityHandoffFailureSchema,
]);
export type CatalogQuantityHandoff = typeof CatalogQuantityHandoffSchema.Type;
type CatalogQuantityHandoffCore = CatalogQuantityHandoffCoreReady | typeof CatalogQuantityHandoffFailureSchema.Type;

const sameSelection = Schema.toEquivalence(CatalogSelectionSchema);
const matchesQuantityIdentity = (input: {
  readonly quantity: Extract<QuantityNormalization, { status: 'VALID' }>;
  readonly selection: CatalogSelection;
  readonly unitRef: CatalogResourceRef;
}): boolean =>
  input.unitRef.tenantId === input.selection.productRef.tenantId &&
  input.quantity.tenantId === input.selection.productRef.tenantId &&
  input.quantity.unitId === input.unitRef.resourceId &&
  input.quantity.targetId ===
    (input.selection.packageOption?.optionRef.resourceId ?? input.selection.variantRef.resourceId);

const sameRef = (left: CatalogResourceRef, right: CatalogResourceRef): boolean =>
  left.moduleId === right.moduleId &&
  left.resourceType === right.resourceType &&
  left.resourceId === right.resourceId &&
  left.tenantId === right.tenantId;

const positiveDecimal = (value: string): { readonly coefficient: bigint; readonly scale: number } | null => {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(value)) {
    return null;
  }
  const [whole = '', fraction = ''] = value.split('.');
  const coefficient = BigInt(`${whole}${fraction}`);
  return coefficient > 0n ? { coefficient, scale: fraction.length } : null;
};

const matchesConvertedAmount = (
  quantity: Extract<QuantityNormalization, { status: 'VALID' }>,
  content: Extract<PackageResolution, { status: 'VALID' }>,
  revision: PackageContentRevision,
): boolean => {
  const count = positiveDecimal(quantity.resulting);
  const perPackage = positiveDecimal(revision.amount);
  const total = positiveDecimal(content.amount);
  return (
    count !== null &&
    count.scale === 0 &&
    perPackage !== null &&
    total !== null &&
    count.coefficient * perPackage.coefficient * 10n ** BigInt(total.scale) ===
      total.coefficient * 10n ** BigInt(perPackage.scale)
  );
};

const matchesPackageSubject = (
  selection: CatalogSelection,
  content: Extract<PackageResolution, { status: 'VALID' }>,
  revision: PackageContentRevision,
  configurationKey: string | undefined,
): boolean =>
  sameRef(revision.form.productRef, selection.productRef) &&
  sameRef(revision.form.variantRef, selection.variantRef) &&
  sameRef(revision.unitRef, content.unitRef) &&
  revision.configurationKey === configurationKey &&
  (selection.setComposition === undefined
    ? revision.setComposition === undefined
    : revision.setComposition !== undefined &&
      sameCatalogRevisionReference(revision.setComposition, selection.setComposition));

const matchesPackage = (
  selection: CatalogSelection,
  content: Extract<PackageResolution, { status: 'VALID' }> | undefined,
  revision: PackageContentRevision | undefined,
  configurationKey: string | undefined,
): boolean => {
  if (selection.packageOption === undefined) {
    return content === undefined && revision === undefined;
  }
  if (content === undefined || revision === undefined) {
    return false;
  }
  const pinned = selection.packageOption.contentRevision;
  const [first] = content.path;
  return (
    first !== undefined &&
    sameCatalogRevisionReference(first, pinned) &&
    sameCatalogRevisionReference(revision.reference, pinned) &&
    matchesPackageSubject(selection, content, revision, configurationKey)
  );
};

const hasPackagePathBasis = (input: HandoffInput): boolean =>
  input.evidence.status === 'VALID' &&
  (input.packageContent?.status !== 'VALID' ||
    input.packageContent.path.every(
      (reference) =>
        input.evidence.status === 'VALID' &&
        input.evidence.basis.some(
          ({ role, source, subject }) =>
            role === 'PACKAGE_CONTENT' && subject === undefined && sameCatalogRevisionReference(source, reference),
        ),
    ));

interface HandoffInput {
  /** Owner-issued canonical key for the selected configuration; not inferred from display choices. */
  readonly configurationKey?: string;
  /** Owner-issued revision of the selected Variant or Package Definition divisibility fact. */
  readonly divisibilityRevision: number;
  readonly divisible: boolean;
  readonly evidence: CatalogSelectionEvidence;
  readonly packageContent?: PackageResolution;
  readonly packageRevision?: PackageContentRevision;
  readonly quantity: QuantityNormalization;
  readonly selection: CatalogSelection;
  readonly unitRef: CatalogResourceRef;
}

const hasQuantityBasis = (input: HandoffInput): boolean => {
  if (input.evidence.status !== 'VALID' || input.quantity.status !== 'VALID') {
    return false;
  }
  const { basis } = input.evidence;
  const { unitRuleRevision } = input.quantity;
  const target = input.selection.packageOption?.optionRef ?? input.selection.variantRef;
  return (
    Number.isSafeInteger(input.divisibilityRevision) &&
    input.divisibilityRevision > 0 &&
    basis.some(
      ({ role, source, subject }) =>
        role === 'UNIT_RULE' &&
        subject === undefined &&
        sameRef(source.resourceRef, input.unitRef) &&
        source.revision === unitRuleRevision,
    ) &&
    basis.some(
      ({ role, source, subject }) =>
        role === 'UNIT_TARGET_DIVISIBILITY' &&
        subject === undefined &&
        sameRef(source.resourceRef, target) &&
        source.revision === input.divisibilityRevision,
    )
  );
};

const packageFailure = (input: HandoffInput): Exclude<CatalogQuantityHandoffCore, { status: 'READY' }> | null => {
  if (input.packageContent?.status === 'INVALID') {
    return { reason: input.packageContent.reason, status: 'INVALID' };
  }
  if (input.packageContent?.status === 'UNVERIFIABLE') {
    return { reason: input.packageContent.reason, status: 'UNVERIFIABLE' };
  }
  if (
    input.selection.packageOption !== undefined &&
    (input.packageContent === undefined ||
      input.packageRevision === undefined ||
      (input.selection.configuration !== undefined && input.configurationKey === undefined))
  ) {
    return { reason: 'Exact package content or configuration identity is missing', status: 'UNVERIFIABLE' };
  }
  const validPackageContent = input.packageContent?.status === 'VALID' ? input.packageContent : undefined;
  return matchesPackage(input.selection, validPackageContent, input.packageRevision, input.configurationKey)
    ? null
    : { reason: 'Package content does not match the selected exact revision', status: 'STALE' };
};

/** Assemble facts only for the same exact selection; Commerce #333 owns customer-specific rules. */
export const prepareCatalogQuantityHandoff = (input: HandoffInput): CatalogQuantityHandoffCore => {
  if (input.evidence.status === 'INDETERMINATE') {
    return { reason: input.evidence.reason, status: 'UNVERIFIABLE' };
  }
  if (input.evidence.status === 'INVALID') {
    return { reason: input.evidence.reason, status: 'INVALID' };
  }
  if (input.quantity.status === 'REPREPARE_REQUIRED') {
    return { reason: input.quantity.reason, status: 'STALE' };
  }
  if (input.quantity.status !== 'VALID') {
    return { reason: input.quantity.reason, status: input.quantity.status === 'INVALID' ? 'INVALID' : 'UNVERIFIABLE' };
  }
  if (!sameSelection(input.selection, input.evidence.selection)) {
    return { reason: 'Selection evidence describes a different exact selection', status: 'STALE' };
  }
  if (!matchesQuantityIdentity({ quantity: input.quantity, selection: input.selection, unitRef: input.unitRef })) {
    return { reason: 'Quantity, Unit, and selection target must agree', status: 'INVALID' };
  }
  if (!hasQuantityBasis(input)) {
    return { reason: 'Exact Unit rule and target divisibility revisions are not evidenced', status: 'UNVERIFIABLE' };
  }
  const failure = packageFailure(input);
  if (failure !== null) {
    return failure;
  }
  if (!hasPackagePathBasis(input)) {
    return { reason: 'Exact lower Package Content Revision basis is missing', status: 'UNVERIFIABLE' };
  }
  if (
    input.selection.packageOption !== undefined &&
    input.packageContent?.status === 'VALID' &&
    input.packageRevision !== undefined &&
    !matchesConvertedAmount(input.quantity, input.packageContent, input.packageRevision)
  ) {
    return { reason: 'Package content does not equal the prepared number of exact packages', status: 'STALE' };
  }
  const ready: CatalogQuantityHandoffCoreReady = {
    divisible: input.divisible,
    evidence: input.evidence,
    quantity: input.quantity,
    selection: input.selection,
    status: 'READY',
    unitRef: input.unitRef,
  };
  if (input.packageContent?.status === 'VALID') {
    return input.packageRevision === undefined
      ? { reason: 'Exact Package Content Revision is missing', status: 'UNVERIFIABLE' }
      : { ...ready, packageContent: input.packageContent, packageRevision: input.packageRevision };
  }
  return ready;
};

/** One exact owner-issued Package Content path step; mirrors the persisted immutable revision. */
export interface CatalogQuantityPackageContentStep {
  readonly amount: string;
  readonly configurationKey: string | null;
  readonly lowerCount: string | null;
  readonly packageDefinitionId: string;
  readonly revision: number;
  readonly unitId: string;
}

/**
 * Minimal owner-issued facts a Catalog seam must supply. It carries no customer profile, allowed
 * quantity, minimum, or multiple; those belong to Commerce #333.
 */
export interface CatalogQuantityHandoffBasisFacts {
  readonly contentPath: readonly CatalogQuantityPackageContentStep[];
  readonly productRevision: number;
  readonly setCompositionRevision?: number;
  readonly unit: {
    readonly divisible: boolean;
    readonly id: string;
    readonly rounding: 'UP' | 'DOWN' | 'HALF_UP';
    readonly ruleRevision: number;
    readonly step: string;
    readonly targetDivisibilityRevision: number;
  };
  readonly variantRevision: number;
}

const xorBigInt = (left: bigint, right: bigint): bigint => {
  let leftRemainder = left;
  let place = 1n;
  let result = 0n;
  let rightRemainder = right;
  while (leftRemainder > 0n || rightRemainder > 0n) {
    if (leftRemainder % 2n !== rightRemainder % 2n) {
      result += place;
    }
    leftRemainder /= 2n;
    rightRemainder /= 2n;
    place *= 2n;
  }
  return result;
};

const fingerprint = (value: string): string => {
  let hash = 14_695_981_039_346_656_037n;
  for (const character of value) {
    hash = xorBigInt(hash, BigInt(character.codePointAt(0) ?? 0));
    hash = BigInt.asUintN(64, hash * 1_099_511_628_211n);
  }
  return hash.toString(16).padStart(16, '0');
};

const encodeIdentityResult = Schema.encodeResult(Schema.fromJsonString(Schema.Unknown));
const encodeIdentity = <Value>(value: Value): string => Result.getOrThrow(encodeIdentityResult(value));

const resourceIdentity = (ref: CatalogResourceRef): string =>
  [ref.moduleId, ref.resourceType, ref.resourceId, ref.tenantId].join('|');

const selectionIdentity = (selection: CatalogSelection): string =>
  encodeIdentity({
    configuration:
      selection.configuration === undefined
        ? null
        : {
            choices: [...selection.configuration.choices]
              .map((choice) => ({
                attributeDefinition:
                  choice.attributeDefinition === undefined
                    ? null
                    : [resourceIdentity(choice.attributeDefinition.resourceRef), choice.attributeDefinition.revision],
                choiceKey: choice.choiceKey,
                unit:
                  choice.unit === undefined ? null : [resourceIdentity(choice.unit.resourceRef), choice.unit.revision],
                value: choice.value,
              }))
              .toSorted((left, right) => left.choiceKey.localeCompare(right.choiceKey)),
            definition: [
              resourceIdentity(selection.configuration.definition.resourceRef),
              selection.configuration.definition.revision,
            ],
          },
    packageOption:
      selection.packageOption === undefined
        ? null
        : [resourceIdentity(selection.packageOption.optionRef), selection.packageOption.contentRevision.revision],
    product: resourceIdentity(selection.productRef),
    setComposition:
      selection.setComposition === undefined
        ? null
        : [resourceIdentity(selection.setComposition.resourceRef), selection.setComposition.revision],
    variant: resourceIdentity(selection.variantRef),
  });

const catalogProductUnitResourceType = 'commerce.catalog.product-unit';
const catalogResourceRef = (resourceType: string, resourceId: string, tenantId: string): CatalogResourceRef => ({
  moduleId: 'commerce.catalog',
  resourceId,
  resourceType,
  tenantId,
});

const quantityOwnerMetadata = (input: {
  readonly basis: CatalogQuantityHandoffBasisFacts;
  readonly current: CatalogSelectionCurrentFacts;
  readonly quantity: Extract<QuantityNormalization, { status: 'VALID' }>;
  readonly selection: CatalogSelection;
}) => {
  const targetRef = input.selection.packageOption?.optionRef ?? input.selection.variantRef;
  const unitRef = catalogResourceRef(
    catalogProductUnitResourceType,
    input.basis.unit.id,
    input.selection.productRef.tenantId,
  );
  const selectionKey = `commerce.catalog.selection:${fingerprint(selectionIdentity(input.selection))}`;
  const hierarchyRevision = `commerce.catalog.hierarchy:${fingerprint(
    encodeIdentity({
      contentPath: input.basis.contentPath,
      productRevision: input.basis.productRevision,
      setCompositionRevision: input.basis.setCompositionRevision ?? null,
      variantRevision: input.basis.variantRevision,
    }),
  )}`;
  const ownerRevision = `commerce.catalog.quantity:${fingerprint(
    encodeIdentity({
      basis: input.current.basis,
      hierarchyRevision,
      membership: input.current.status === 'OBSERVED' ? input.current.membership : null,
      quantity: input.quantity,
      selectionKey,
      unit: input.basis.unit,
    }),
  )}`;
  const completeness: CatalogQuantityHandoffReady['completeness'] = {
    observedAt: input.current.assessedAt,
    ownerRevision,
    scope: {
      kind: 'EXACT_PREDICATE',
      predicateRef: `commerce.catalog.quantity-preparation:${selectionKey}:${input.current.purpose}:${input.quantity.requested}`,
    },
  };
  if (input.current.status === 'OBSERVED' && input.current.validUntil !== undefined) {
    Object.assign(completeness, { nextApplicabilityBoundary: input.current.validUntil });
  }
  return {
    completeness,
    equivalentSelectionKey: selectionKey,
    hierarchyRevision,
    ownerRevision,
    quantityBasis: {
      targetDivisibilityRevision: input.basis.unit.targetDivisibilityRevision,
      targetRef,
      unitRef,
      unitRuleRevision: input.basis.unit.ruleRevision,
    },
  } as const;
};

interface CatalogPackageFacts {
  readonly configurationKey?: string;
  readonly packageContent?: PackageResolution;
  readonly packageRevision?: PackageContentRevision;
}

/** Rebuilds exact immutable Package facts from an owner-verified path; it never invents missing content. */
const buildCatalogPackageFacts = (input: {
  readonly basis: CatalogQuantityHandoffBasisFacts;
  readonly packageCount: string;
  readonly selection: CatalogSelection;
}): CatalogPackageFacts => {
  const { selection } = input;
  if (selection.packageOption === undefined || input.basis.contentPath.length === 0) {
    return {};
  }
  const { tenantId } = selection.productRef;
  const revisions: PackageContentRevision[] = [];
  for (const [index, step] of input.basis.contentPath.entries()) {
    const revision = Schema.decodeOption(CatalogRevisionNumberSchema)(step.revision);
    if (Option.isNone(revision)) {
      return {};
    }
    const entry: PackageContentRevision = {
      amount: step.amount,
      form: { productRef: selection.productRef, variantRef: selection.variantRef },
      reference: {
        resourceRef: catalogResourceRef('commerce.catalog.package-definition', step.packageDefinitionId, tenantId),
        revision: revision.value,
      },
      unitRef: catalogResourceRef(catalogProductUnitResourceType, step.unitId, tenantId),
    };
    if (step.configurationKey !== null) {
      Object.assign(entry, { configurationKey: step.configurationKey });
    }
    if (selection.setComposition !== undefined) {
      Object.assign(entry, { setComposition: selection.setComposition });
    }
    const lower = input.basis.contentPath[index + 1];
    if (lower !== undefined && step.lowerCount !== null) {
      const lowerRevision = Schema.decodeOption(CatalogRevisionNumberSchema)(lower.revision);
      if (Option.isNone(lowerRevision)) {
        return {};
      }
      Object.assign(entry, {
        lower: {
          count: step.lowerCount,
          revision: {
            resourceRef: catalogResourceRef('commerce.catalog.package-definition', lower.packageDefinitionId, tenantId),
            revision: lowerRevision.value,
          },
        },
      });
    }
    revisions.push(entry);
  }
  const [packageRevision] = revisions;
  if (packageRevision === undefined) {
    return {};
  }
  const facts: CatalogPackageFacts = {
    packageContent: resolvePackageContent(selection.packageOption.contentRevision, revisions, input.packageCount),
    packageRevision,
  };
  if (packageRevision.configurationKey !== undefined) {
    Object.assign(facts, { configurationKey: packageRevision.configurationKey });
  }
  return facts;
};

/**
 * Assembles Commerce-facing quantity facts from exact owner-issued Current facts, a verified
 * Package/Unit basis, and a normalization result. It emits only a product validity or
 * unverifiability result; customer-specific commercial rules remain outside Catalog.
 */
export const assembleCatalogQuantityHandoff = (input: {
  readonly basis: CatalogQuantityHandoffBasisFacts;
  readonly current: CatalogSelectionCurrentFacts;
  readonly quantity: QuantityNormalization;
  readonly selection: CatalogSelection;
}): CatalogQuantityHandoff => {
  const evidence = assessCatalogSelection({
    assessedAt: input.current.assessedAt,
    current: input.current,
    purpose: input.current.purpose,
    selection: input.selection,
  });
  const packageFacts = buildCatalogPackageFacts({
    basis: input.basis,
    packageCount: input.quantity.status === 'VALID' ? input.quantity.resulting : '1',
    selection: input.selection,
  });
  const handoffInput: HandoffInput = {
    divisibilityRevision: input.basis.unit.targetDivisibilityRevision,
    divisible: input.basis.unit.divisible,
    evidence,
    quantity: input.quantity,
    selection: input.selection,
    unitRef: catalogResourceRef(
      catalogProductUnitResourceType,
      input.basis.unit.id,
      input.selection.productRef.tenantId,
    ),
  };
  if (packageFacts.configurationKey !== undefined) {
    Object.assign(handoffInput, { configurationKey: packageFacts.configurationKey });
  }
  if (packageFacts.packageContent !== undefined) {
    Object.assign(handoffInput, { packageContent: packageFacts.packageContent });
  }
  if (packageFacts.packageRevision !== undefined) {
    Object.assign(handoffInput, { packageRevision: packageFacts.packageRevision });
  }
  const handoff = prepareCatalogQuantityHandoff(handoffInput);
  if (handoff.status !== 'READY') {
    return handoff;
  }
  return {
    ...handoff,
    ...quantityOwnerMetadata({
      basis: input.basis,
      current: input.current,
      quantity: handoff.quantity,
      selection: input.selection,
    }),
  };
};
