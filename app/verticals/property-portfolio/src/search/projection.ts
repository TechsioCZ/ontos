import { CoreSearchProjectionDocumentSchema, CoreSearchProjectionInvalid } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
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

const searchSourceSnapshotSchema = Schema.Struct({
  companies: Schema.Array(Schema.Struct({ legalEntityId: SelectedLegalEntityIdSchema, state: PropertyStateSchema })),
  projectionVersion: CoreSearchProjectionDocumentSchema.fields.projectionVersion,
  tenantId: AssetRefSchema.fields.tenantId,
});

const companyDocuments = (company: SearchSourceCompany, snapshot: SearchSourceSnapshot) => {
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
    projectionVersion: snapshot.projectionVersion,
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
              searchableText: [
                unit.name,
                unit.code,
                property.name,
                property.code,
                property.address,
                ...(unit.unitKind === null ? [] : [unit.unitKind]),
              ],
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
                property.name,
                property.code,
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

const snapshotMatchesScope = (snapshot: SearchSourceSnapshot) => {
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

/** Only public register labels belong in search, never notes, people or archive evidence. */
export const buildSearchDocuments = Effect.fn('PropertySearch.buildDocuments')(function* buildDocuments(
  input: SearchSourceSnapshot,
) {
  const snapshot = yield* Schema.decodeUnknownEffect(searchSourceSnapshotSchema)(input).pipe(
    Effect.mapError(invalidSearchSource),
  );
  if (!snapshotMatchesScope(snapshot)) {
    return yield* invalidSearchSource();
  }
  return yield* Schema.decodeUnknownEffect(Schema.Array(CoreSearchProjectionDocumentSchema))(
    snapshot.companies.flatMap((company) => companyDocuments(company, snapshot)),
  ).pipe(Effect.mapError(invalidSearchSource));
});
