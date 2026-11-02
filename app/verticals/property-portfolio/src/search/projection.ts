import { CoreSearchProjectionDocumentSchema, CoreSearchProjectionInvalid } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import type { PropertyState } from '../../shared/apis/records.ts';

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

const companyDocuments = (company: SearchSourceCompany, snapshot: SearchSourceSnapshot) => {
  const { legalEntityId, state } = company;
  const properties = state.properties.filter(
    (property) => property.archive === undefined && property.lifecycleState !== 'DISPOSED',
  );
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
      searchableText: [property.name, property.code, property.address],
      title: property.name,
    })),
    ...state.units.flatMap((unit) => {
      const property = properties.find((candidate) => candidate.propertyRef.resourceId === unit.propertyRef.resourceId);
      return unit.archive !== undefined || unit.lifecycleState === 'RETIRED' || property === undefined
        ? []
        : [
            {
              ...common,
              ref: unit.unitRef,
              searchableText: [unit.name, unit.code, property.name, property.address],
              title: unit.name,
            },
          ];
    }),
  ];
};
const companyMatchesScope = ({ legalEntityId, state }: SearchSourceCompany, tenantId: string) =>
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
      state.properties.some((property) => property.propertyRef.resourceId === propertyRef.resourceId),
  );

/** Only public register labels belong in search, never notes, people or archive evidence. */
export const buildSearchDocuments = Effect.fn('PropertySearch.buildDocuments')((snapshot: SearchSourceSnapshot) =>
  Effect.forEach(
    snapshot.companies,
    (company) =>
      companyMatchesScope(company, snapshot.tenantId)
        ? Schema.decodeEffect(Schema.Array(CoreSearchProjectionDocumentSchema))(
            companyDocuments(company, snapshot),
          ).pipe(Effect.mapError(invalidSearchSource))
        : Effect.fail(invalidSearchSource()),
    { concurrency: 1 },
  ).pipe(
    Effect.flatMap((groups) => {
      const documents = groups.flat();
      const identities = new Set(documents.map(({ ref }) => `${ref.resourceType}:${ref.resourceId}`));
      return identities.size === documents.length ? Effect.succeed(documents) : Effect.fail(invalidSearchSource());
    }),
  ),
);
