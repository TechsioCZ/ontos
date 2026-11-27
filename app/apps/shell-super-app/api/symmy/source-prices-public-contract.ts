import { PriceGroupSourcePricesResponseSchema } from '@app/pricing/apis/price-group-source-prices';
import type { PriceGroupSourcePricesResponse } from '@app/pricing/apis/price-group-source-prices';
import { Match, Schema, Struct } from 'effect';
import type { Types } from 'effect';

/**
 * The source price page as Symmy reads it: every owner reference is its plain id, under the name an import accepts
 * where one takes it, and no tenant or module is named. The shapes are built from the owner fields, so no limit can
 * drift. The owner checks that bind those fields to each other already ran on the internal projection and are not
 * repeated here.
 */
const page = PriceGroupSourcePricesResponseSchema.fields;
const entry = page.prices.value.fields;
const [current, notFound, conflict, unavailable] = entry.price.members;
const definition = current.fields.definition.fields;
const identity = definition.identityKey.fields;
const selection = identity.catalogSelection.fields;
const configuration = selection.configuration.schema.fields;
const choice = configuration.choices.value.fields;
const packageOption = selection.packageOption.schema.fields;
const unitBasis = identity.unitBasis.fields;
const [noGroup, pricedGroup] = identity.priceGroupSelector.members;
const provenance = entry.provenance.schema.fields;
const link = provenance.canonicalLink.fields;
const evidence = provenance.evidence.fields;
const assertion = evidence.sourceAssertion.fields;
const original = assertion.originalAssertion.fields;
const sourceRecord = assertion.sourceRecord.fields;

const priceId = definition.priceRef.fields.resourceId;
const productId = selection.productRef.fields.resourceId;
const variantId = selection.variantRef.fields.resourceId;

/** A catalog revision names its resource by id; its resource type is fixed by where it appears. */
const { resourceRef: revisionResourceRef, ...revisionRest } = selection.setComposition.schema.fields;
const CatalogRevisionSchema = Schema.Struct({
  ...revisionRest,
  resourceId: revisionResourceRef.fields.resourceId,
});
/** The one configuration revision whose id an import also takes, so it goes by the import's name. */
const AttributeDefinitionRevisionSchema = Schema.Struct({
  ...revisionRest,
  attributeDefinitionId: revisionResourceRef.fields.resourceId,
});
const ConfigurationSchema = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      attributeDefinition: Schema.optionalKey(AttributeDefinitionRevisionSchema),
      choiceKey: choice.choiceKey,
      unit: Schema.optionalKey(CatalogRevisionSchema),
      value: choice.value,
    }),
  ),
  definition: CatalogRevisionSchema,
  productId,
  variantId,
});
const PackageOptionSchema = Schema.Struct({
  contentRevision: CatalogRevisionSchema,
  optionId: packageOption.optionRef.fields.resourceId,
});
const UnitBasisSchema = Schema.Struct({
  quantity: unitBasis.quantity,
  unitId: unitBasis.unitRef.fields.resourceId,
});
const IdentityKeySchema = Schema.Struct({
  catalogSelection: Schema.Struct({
    configuration: Schema.optionalKey(ConfigurationSchema),
    packageOption: Schema.optionalKey(PackageOptionSchema),
    productId,
    setComposition: Schema.optionalKey(CatalogRevisionSchema),
    variantId,
  }),
  commercialScope: identity.commercialScope,
  currencyCode: identity.currencyCode,
  priceGroupSelector: Schema.Union([
    noGroup,
    Schema.Struct({
      kind: pricedGroup.fields.kind,
      priceGroupId: pricedGroup.fields.priceGroupRef.fields.resourceId,
    }),
  ]),
  unitBasis: UnitBasisSchema,
});
const CurrentPriceSchema = Schema.Struct({
  currentEvidence: Schema.Struct({
    ...Struct.omit(current.fields.currentEvidence.fields, ['priceRef']),
    priceId,
  }),
  definition: Schema.Struct({ identityKey: IdentityKeySchema, priceId, revision: definition.revision }),
  outcome: current.fields.outcome,
});
const PriceSchema = Schema.Union([
  CurrentPriceSchema,
  Schema.Struct({ ...Struct.omit(notFound.fields, ['priceRef']), priceId }),
  Schema.Struct({ ...Struct.omit(conflict.fields, ['priceRef']), priceId }),
  Schema.Struct({ ...Struct.omit(unavailable.fields, ['priceRef']), priceId }),
]);
const ProvenanceSchema = Schema.Struct({
  canonicalLink: Schema.Struct({
    ...Struct.omit(link, ['identityKey', 'priceRef']),
    identityKey: IdentityKeySchema,
    priceId,
  }),
  evidence: Schema.Struct({
    ...Struct.omit(evidence, ['sourceAssertion', 'tenantId']),
    sourceAssertion: Schema.Struct({
      ...Struct.omit(assertion, ['originalAssertion', 'sourceRecord']),
      originalAssertion: Schema.Struct({
        ...Struct.omit(original, ['unitBasis']),
        unitBasis: UnitBasisSchema,
      }),
      // The owner module of the source system is the route's own, the same for every entry of a page.
      sourceRecord: Schema.Struct({
        ...Struct.omit(sourceRecord, ['sourceSystem']),
        sourceSystem: Schema.Struct({ sourceSystemRef: sourceRecord.sourceSystem.fields.sourceSystemRef }),
      }),
    }),
  }),
  provenanceRef: provenance.provenanceRef,
});

export const SymmySourcePricesSchema = Schema.Struct({
  count: page.count,
  limit: page.limit,
  offset: page.offset,
  prices: Schema.Array(Schema.Struct({ price: PriceSchema, provenance: Schema.optionalKey(ProvenanceSchema) })),
});

type Entry = PriceGroupSourcePricesResponse['prices'][number];
type Price = Entry['price'];
type IdentityKey = Extract<Price, { readonly outcome: 'PRICE_DEFINITION_CURRENT' }>['definition']['identityKey'];
type Selection = IdentityKey['catalogSelection'];
type Revision = NonNullable<Selection['setComposition']>;
type Configuration = NonNullable<Selection['configuration']>;

const mapRevision = ({ resourceRef, ...revision }: Revision) => ({ ...revision, resourceId: resourceRef.resourceId });
const mapUnitBasis = ({ quantity, unitRef }: IdentityKey['unitBasis']) => ({ quantity, unitId: unitRef.resourceId });

type Choice = Configuration['choices'][number];

const mapChoice = ({ attributeDefinition, unit, ...rest }: Choice) => {
  const mapped: Types.Mutable<(typeof ConfigurationSchema.Type)['choices'][number]> = { ...rest };
  if (attributeDefinition !== undefined) {
    const { resourceRef, ...revision } = attributeDefinition;
    mapped.attributeDefinition = { ...revision, attributeDefinitionId: resourceRef.resourceId };
  }
  if (unit !== undefined) {
    mapped.unit = mapRevision(unit);
  }
  return mapped;
};

const mapConfiguration = ({ choices, definition: configured, productRef, variantRef }: Configuration) => ({
  choices: choices.map(mapChoice),
  definition: mapRevision(configured),
  productId: productRef.resourceId,
  variantId: variantRef.resourceId,
});

const mapPackageOption = ({ contentRevision, optionRef }: NonNullable<Selection['packageOption']>) => ({
  contentRevision: mapRevision(contentRevision),
  optionId: optionRef.resourceId,
});

const mapSelection = ({ configuration: configured, packageOption: option, setComposition, ...target }: Selection) => {
  const mapped: Types.Mutable<typeof IdentityKeySchema.fields.catalogSelection.Type> = {
    productId: target.productRef.resourceId,
    variantId: target.variantRef.resourceId,
  };
  if (configured !== undefined) {
    mapped.configuration = mapConfiguration(configured);
  }
  if (option !== undefined) {
    mapped.packageOption = mapPackageOption(option);
  }
  if (setComposition !== undefined) {
    mapped.setComposition = mapRevision(setComposition);
  }
  return mapped;
};

const mapIdentityKey = ({ catalogSelection, priceGroupSelector, unitBasis: basis, ...key }: IdentityKey) => ({
  ...key,
  catalogSelection: mapSelection(catalogSelection),
  priceGroupSelector:
    priceGroupSelector.kind === 'NO_GROUP'
      ? priceGroupSelector
      : { kind: priceGroupSelector.kind, priceGroupId: priceGroupSelector.priceGroupRef.resourceId },
  unitBasis: mapUnitBasis(basis),
});

const mapPrice = (price: Price) =>
  Match.value(price).pipe(
    Match.when({ outcome: 'PRICE_DEFINITION_CURRENT' }, ({ currentEvidence, definition: defined, outcome }) => {
      const { priceRef: evidenced, ...observed } = currentEvidence;
      return {
        currentEvidence: { ...observed, priceId: evidenced.resourceId },
        definition: {
          identityKey: mapIdentityKey(defined.identityKey),
          priceId: defined.priceRef.resourceId,
          revision: defined.revision,
        },
        outcome,
      };
    }),
    Match.orElse(({ priceRef, ...unresolved }) => ({ ...unresolved, priceId: priceRef.resourceId })),
  );

const mapProvenance = ({ canonicalLink, evidence: recorded, provenanceRef }: NonNullable<Entry['provenance']>) => {
  const { identityKey, priceRef, ...linked } = canonicalLink;
  const { sourceAssertion, tenantId: _routeTenant, ...evidenceRest } = recorded;
  const { originalAssertion, sourceRecord: record } = sourceAssertion;
  return {
    canonicalLink: { ...linked, identityKey: mapIdentityKey(identityKey), priceId: priceRef.resourceId },
    evidence: {
      ...evidenceRest,
      sourceAssertion: {
        ...sourceAssertion,
        originalAssertion: { ...originalAssertion, unitBasis: mapUnitBasis(originalAssertion.unitBasis) },
        sourceRecord: { ...record, sourceSystem: { sourceSystemRef: record.sourceSystem.sourceSystemRef } },
      },
    },
    provenanceRef,
  };
};

export const mapSymmySourcePrices = ({ prices, ...rest }: PriceGroupSourcePricesResponse) => ({
  ...rest,
  prices: prices.map(({ price, provenance: recorded }) =>
    recorded === undefined
      ? { price: mapPrice(price) }
      : { price: mapPrice(price), provenance: mapProvenance(recorded) },
  ),
});
