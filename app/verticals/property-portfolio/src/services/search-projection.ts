import { CoreSearchProjectionDocumentSchema, CoreSearchProjectionInvalid } from '@app/core-runtime';
import { Effect, Schema, Struct } from 'effect';
import { PropertyStateSchema } from '../../shared/apis/records.ts';
import type { PropertyState } from '../../shared/apis/records.ts';
import { SelectedLegalEntityIdSchema } from '../../shared/domain/search.ts';
import { AssetRefSchema } from '../../shared/resources/asset.ts';

export interface SearchSourceCompany {
  readonly legalEntityId: string;
  readonly state: PropertyState;
}
export interface SearchSourceSnapshot {
  readonly companies: readonly SearchSourceCompany[];
  readonly projectionVersion: string;
  readonly tenantId: string;
}
export const invalidSearchSource = (cause?: unknown) =>
  new CoreSearchProjectionInvalid({
    cause,
    code: 'core_search_projection_invalid',
    reason: 'Property search requires a consistent owner and company snapshot',
  });

const currentSearchSourceSchema = Schema.Struct({
  companies: Schema.Array(Schema.Struct({ legalEntityId: SelectedLegalEntityIdSchema, state: PropertyStateSchema })),
  tenantId: AssetRefSchema.fields.tenantId,
});

const searchSourceSnapshotSchema = Schema.Struct({
  ...currentSearchSourceSchema.fields,
  projectionVersion: CoreSearchProjectionDocumentSchema.fields.projectionVersion,
});
const currentSearchDocumentSchema = Schema.Struct(
  Struct.omit(CoreSearchProjectionDocumentSchema.fields, ['projectionVersion']),
);

const companyDocuments = (company: SearchSourceCompany) => {
  const { legalEntityId, state } = company;
  const properties = state.properties.filter(
    (property) => property.archive === undefined && property.lifecycleState !== 'DISPOSED',
  );
  const propertiesById = new Map(properties.map((property) => [property.propertyRef.resourceId, property]));
  const units = state.units.filter(
    (unit) =>
      unit.archive === undefined &&
      unit.lifecycleState !== 'RETIRED' &&
      propertiesById.has(unit.propertyRef.resourceId),
  );
  const unitsById = new Map(units.map((unit) => [unit.unitRef.resourceId, unit]));
  const common = {
    archived: false,
    facets: [],
    metadata: [],
    selectedLegalEntityId: legalEntityId,
  };
  return [
    ...properties.map((property) => ({
      ...common,
      ref: property.propertyRef,
      searchableText: [
        property.name,
        property.code,
        property.address,
        ...(property.propertyType === undefined ? [] : [property.propertyType]),
      ],
      title: property.name,
    })),
    ...units.flatMap((unit) => {
      const property = propertiesById.get(unit.propertyRef.resourceId);
      return unit.archive !== undefined || unit.lifecycleState === 'RETIRED' || property === undefined
        ? []
        : [
            {
              ...common,
              ref: unit.unitRef,
              searchableText: [unit.name, unit.code, ...(unit.unitKind === null ? [] : [unit.unitKind])],
              title: unit.name,
            },
          ];
    }),
    ...state.assets.flatMap((asset) => {
      const property = propertiesById.get(asset.propertyRef.resourceId);
      const unit = asset.unitRef === null ? undefined : unitsById.get(asset.unitRef.resourceId);
      return asset.lifecycleState === 'DISPOSED' ||
        property === undefined ||
        (asset.unitRef !== null && unit === undefined)
        ? []
        : [
            {
              ...common,
              ref: asset.assetRef,
              searchableText: [
                asset.name,
                asset.category,
                asset.code,
                ...(asset.serialNumber === null ? [] : [asset.serialNumber]),
              ],
              title: asset.name,
            },
          ];
    }),
  ];
};
const companyMatchesScope = ({ legalEntityId, state }: SearchSourceCompany, tenantId: string) => {
  const propertiesById = new Map(state.properties.map((property) => [property.propertyRef.resourceId, property]));
  const unitsById = new Map(state.units.map((unit) => [unit.unitRef.resourceId, unit]));
  return (
    propertiesById.size === state.properties.length &&
    unitsById.size === state.units.length &&
    new Set(state.assets.map((asset) => asset.assetRef.resourceId)).size === state.assets.length &&
    state.properties.every(
      ({ legalEntityRef, propertyRef }) =>
        propertyRef.tenantId === tenantId &&
        legalEntityRef.tenantId === tenantId &&
        legalEntityRef.resourceId === legalEntityId,
    ) &&
    state.units.every(
      ({ propertyRef, unitRef }) =>
        unitRef.tenantId === tenantId &&
        propertyRef.tenantId === tenantId &&
        propertiesById.has(propertyRef.resourceId),
    ) &&
    state.assets.every(({ assetRef, propertyRef, unitRef }) => {
      const unit = unitRef === null ? undefined : unitsById.get(unitRef.resourceId);
      return (
        assetRef.tenantId === tenantId &&
        propertyRef.tenantId === tenantId &&
        propertiesById.has(propertyRef.resourceId) &&
        (unitRef === null || (unitRef.tenantId === tenantId && unit?.propertyRef.resourceId === propertyRef.resourceId))
      );
    })
  );
};

const snapshotMatchesScope = (snapshot: Omit<SearchSourceSnapshot, 'projectionVersion'>) => {
  const identities = snapshot.companies.flatMap(({ state }) => [
    ...state.properties.map(({ propertyRef }) => propertyRef),
    ...state.units.map(({ unitRef }) => unitRef),
    ...state.assets.map(({ assetRef }) => assetRef),
  ]);
  return (
    new Set(snapshot.companies.map(({ legalEntityId }) => legalEntityId)).size === snapshot.companies.length &&
    new Set(identities.map((ref) => `${ref.resourceType}:${ref.resourceId}`)).size === identities.length &&
    snapshot.companies.every((company) => companyMatchesScope(company, snapshot.tenantId))
  );
};

/** Current canonical owner evidence, shared by interactive search and versioned projection publication. */
export const buildCurrentSearchDocuments = Effect.fn('PropertySearch.buildCurrentDocuments')(
  function* buildCurrentDocuments(input: Omit<SearchSourceSnapshot, 'projectionVersion'>) {
    const snapshot = yield* Schema.decodeUnknownEffect(currentSearchSourceSchema)(input).pipe(
      Effect.mapError(invalidSearchSource),
    );
    if (!snapshotMatchesScope(snapshot)) {
      return yield* invalidSearchSource();
    }
    return yield* Schema.decodeUnknownEffect(Schema.Array(currentSearchDocumentSchema))(
      snapshot.companies.flatMap(companyDocuments),
    ).pipe(Effect.mapError(invalidSearchSource));
  },
);

/** Only public register labels belong in the versioned index, never notes, people or archive evidence. */
export const buildSearchDocuments = Effect.fn('PropertySearch.buildDocuments')(function* buildDocuments(
  input: SearchSourceSnapshot,
) {
  const snapshot = yield* Schema.decodeUnknownEffect(searchSourceSnapshotSchema)(input).pipe(
    Effect.mapError(invalidSearchSource),
  );
  const documents = yield* buildCurrentSearchDocuments(snapshot);
  return yield* Schema.decodeUnknownEffect(Schema.Array(CoreSearchProjectionDocumentSchema))(
    documents.map((document) => ({ ...document, projectionVersion: snapshot.projectionVersion })),
  ).pipe(Effect.mapError(invalidSearchSource));
});
