import { RecordsRequestSchema } from '@app/merchandise/apis/records';
import { executeRecords as executeMerchandiseRecords } from '@app/merchandise/apis/records/client';
import { executeCustomerList } from '@app/party-registry/apis/customer-list/client';
import { executeRecords as executeOpportunityRecords } from '@app/sales-pipeline/clients/records';
import { executeRecords as executeEmployeeRecords } from '@app/workforce/clients/records';
import { Effect, Match, Random, Schema } from 'effect';
import type { SubjectId, SubjectKind } from '../../shared/apis/records.ts';

/** Display label per subject id. Ids without a readable record are missing from the map. */
export type SubjectNames = ReadonlyMap<string, string>;

const noNames: SubjectNames = new Map();

/** The encoded Merchandise records view (the read request before the owner's schema decodes it). */
type RecordsViewEncoded = NonNullable<(typeof RecordsRequestSchema.Encoded)['view']>;

const correlation = (label: string) =>
  Effect.all([Random.nextInt, Random.nextInt], { concurrency: 1 }).pipe(
    Effect.map(([first, second]) => `tagging:names:${label}:${first}:${second}`),
  );

/** One Merchandise records read; the view is decoded with the owner's request schema before it is sent. */
const readMerchandiseRecords = (requestCorrelation: string, view: RecordsViewEncoded) =>
  Schema.decodeEffect(RecordsRequestSchema)({ view }).pipe(
    Effect.flatMap((request) => executeMerchandiseRecords(request, requestCorrelation)),
  );

const toNames = <T>(
  items: readonly T[],
  idOf: (item: T) => string,
  labelOf: (item: T) => string | null | undefined,
): SubjectNames =>
  new Map(
    items.flatMap((item): [string, string][] => {
      const label = labelOf(item);
      return label === null || label === undefined || label === '' ? [] : [[idOf(item), label]];
    }),
  );

/** Merchandise reads at most 250 products or orders by id per call. */
const ID_BATCH = 250;

/** Runs one id-filtered read per batch of `ID_BATCH` ids and concatenates the rows. */
const inBatches = <T, E>(
  ids: readonly SubjectId[],
  read: (batch: readonly string[]) => Effect.Effect<readonly T[], E>,
) =>
  Effect.forEach(
    Array.from({ length: Math.ceil(ids.length / ID_BATCH) }, (_, index) =>
      ids.slice(index * ID_BATCH, (index + 1) * ID_BATCH),
    ),
    read,
    { concurrency: 2 },
  ).pipe(Effect.map((pages) => pages.flat()));

/**
 * Labels the subjects of one kind. Products and orders are read by id; the other kinds have no id filter
 * and read their whole (small) population.
 */
const readNames = (kind: SubjectKind, ids: readonly SubjectId[]) =>
  Match.value(kind).pipe(
    Match.when('customer', () =>
      correlation('customer').pipe(
        Effect.flatMap((id) => executeCustomerList({ includeArchived: true, limit: 500 }, id)),
        Effect.map(({ items }) =>
          toNames(
            items,
            (item) => item.partyId,
            (item) => item.displayName,
          ),
        ),
      ),
    ),
    Match.when('employee', () =>
      correlation('employee').pipe(
        Effect.flatMap((id) => executeEmployeeRecords({}, id)),
        Effect.map((response) =>
          toNames(
            response.items,
            (item) => item.id,
            (item) => item.fullName,
          ),
        ),
      ),
    ),
    Match.when('product', () =>
      inBatches(ids, (productIds) =>
        correlation('product').pipe(
          Effect.flatMap((id) =>
            readMerchandiseRecords(id, { limit: ID_BATCH, ordersLimit: 0, productIds, summary: true }),
          ),
          Effect.map(({ products }) => products),
        ),
      ).pipe(
        Effect.map((items) =>
          toNames(
            items,
            (item) => item.id,
            (item) => `${item.sku} – ${item.name}`,
          ),
        ),
      ),
    ),
    Match.when('order', () =>
      inBatches(ids, (orderIds) =>
        correlation('order').pipe(
          Effect.flatMap((id) => readMerchandiseRecords(id, { limit: 0, orderIds, ordersLimit: ID_BATCH })),
          Effect.map(({ orders }) => orders),
        ),
      ).pipe(
        Effect.map((items) =>
          toNames(
            items,
            (item) => item.id,
            (item) => item.number,
          ),
        ),
      ),
    ),
    Match.when('opportunity', () =>
      correlation('opportunity').pipe(
        Effect.flatMap((id) => executeOpportunityRecords({}, id)),
        Effect.map((response) =>
          toNames(
            response.items,
            (item) => item.id,
            (item) => item.title,
          ),
        ),
      ),
    ),
    Match.exhaustive,
  );

/**
 * Human labels for one kind's subject ids. Loaded when the kind expands; reads nothing when no subject
 * carries the tag.
 */
export const loadSubjectNames = Effect.fn('Tagging.loadSubjectNames')(function* loadSubjectNames(
  kind: SubjectKind,
  ids: readonly SubjectId[],
) {
  if (ids.length === 0) {
    return noNames;
  }
  return yield* readNames(kind, ids);
});
