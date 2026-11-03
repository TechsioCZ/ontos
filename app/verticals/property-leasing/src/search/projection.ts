import { CoreSearchProjectionDocumentSchema, CoreSearchProjectionInvalid } from '@app/core-runtime';
import { Effect, Schema } from 'effect';
import type { Occupancy, OccupancyState } from '../../shared/apis/records.ts';

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
const uuidSchema = Schema.String.check(Schema.isUUID());
const projectionVersionPattern = /^[1-9][0-9]*$/u;
const snapshotMatchesScope = (snapshot: SearchSourceSnapshot) =>
  Schema.is(uuidSchema)(snapshot.tenantId) &&
  projectionVersionPattern.test(snapshot.projectionVersion) &&
  snapshot.companies.every(({ legalEntityId }) => Schema.is(uuidSchema)(legalEntityId)) &&
  new Set(snapshot.companies.map(({ legalEntityId }) => legalEntityId)).size === snapshot.companies.length;
const stateLabels = {
  ACTIVE: 'Aktivní',
  CANCELLED: 'Zrušený',
  COMPLETED: 'Ukončený',
  CONFIRMED: 'Potvrzený',
  DRAFT: 'Návrh',
} as const satisfies Record<Occupancy['state'], string>;
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
    // Owner-held status and ID distinguish equal-date leases without guessing a foreign owner label.
    const title = `Nájem od ${dateLabel(occupancy.startDate)}${endLabel} · ${stateLabels[occupancy.state]} · ${occupancy.occupancyRef.resourceId}`;
    return [
      {
        archived: false,
        facets: [],
        metadata: [],
        projectionVersion: snapshot.projectionVersion,
        ref: occupancy.occupancyRef,
        searchableText: [
          title,
          occupancy.occupancyRef.resourceId,
          occupancy.state,
          stateLabels[occupancy.state],
          occupancy.startDate,
          ...(occupancy.endDate === null ? [] : [occupancy.endDate]),
        ],
        selectedLegalEntityId: legalEntityId,
        title,
      },
    ];
  });

/**
 * Only owner-held identity, lifecycle and dates. Relation labels (tenant/customer name, unit/property
 * name, code and address) stay absent until Party and Portfolio publish approved search-label contracts;
 * this projection never joins their private tables or fabricates an address. No dossiers, rent or notes.
 */
export const buildSearchDocuments = Effect.fn('LeaseSearch.buildDocuments')(function* buildDocuments(
  snapshot: SearchSourceSnapshot,
) {
  if (!snapshotMatchesScope(snapshot)) {
    return yield* invalidSearchSource();
  }
  const groups = yield* Effect.forEach(
    snapshot.companies,
    (company) =>
      companyMatchesScope(company, snapshot.tenantId)
        ? Schema.decodeEffect(Schema.Array(CoreSearchProjectionDocumentSchema))(
            companyDocuments(company, snapshot),
          ).pipe(Effect.mapError(invalidSearchSource))
        : Effect.fail(invalidSearchSource()),
    { concurrency: 1 },
  );
  const documents = groups.flat();
  const identities = new Set(documents.map(({ ref }) => `${ref.resourceType}:${ref.resourceId}`));
  if (identities.size !== documents.length) {
    return yield* invalidSearchSource();
  }
  return documents;
});
