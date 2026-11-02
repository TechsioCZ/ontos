import { CoreSearchProjectionDocumentSchema, CoreSearchProjectionInvalid } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import type { OccupancyState } from '../../shared/apis/records.ts';

export interface SearchSourceCompany {
  readonly legalEntityId: string;
  readonly state: OccupancyState;
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
    reason: 'Lease search requires a consistent owner and company snapshot',
  });
const dateLabel = (value: string) => {
  const [year, month, day] = value.split('-');
  return `${Number(day)}. ${Number(month)}. ${year}`;
};
const companyMatchesScope = ({ state }: SearchSourceCompany, tenantId: string) =>
  state.occupancies.every(
    (occupancy) =>
      occupancy.occupancyRef.tenantId === tenantId &&
      occupancy.unitRef.tenantId === tenantId &&
      (occupancy.customerCounterpartyRef === null || occupancy.customerCounterpartyRef.tenantId === tenantId) &&
      (occupancy.guestPartyRef === null || occupancy.guestPartyRef.tenantId === tenantId) &&
      (occupancy.contractRef === null || occupancy.contractRef.tenantId === tenantId),
  );
const companyDocuments = ({ legalEntityId, state }: SearchSourceCompany, snapshot: SearchSourceSnapshot) =>
  state.occupancies.flatMap((occupancy) => {
    if (occupancy.kind !== 'LONG_TERM_LEASE' || occupancy.state === 'CANCELLED') {
      return [];
    }
    const endLabel = occupancy.endDate === null ? ' na dobu neurčitou' : ` do ${dateLabel(occupancy.endDate)}`;
    const title = `Nájem od ${dateLabel(occupancy.startDate)}${endLabel}`;
    return [
      {
        archived: false,
        facets: [],
        metadata: [],
        projectionVersion: snapshot.projectionVersion,
        ref: occupancy.occupancyRef,
        searchableText: [title, occupancy.startDate, ...(occupancy.endDate === null ? [] : [occupancy.endDate])],
        selectedLegalEntityId: legalEntityId,
        title,
      },
    ];
  });

/** Lease dates are owner-held labels. Dossiers, rent, notes and foreign-owner IDs are not search text. */
export const buildSearchDocuments = Effect.fn('LeaseSearch.buildDocuments')((snapshot: SearchSourceSnapshot) =>
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
