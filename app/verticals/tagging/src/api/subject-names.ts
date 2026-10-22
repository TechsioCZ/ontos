import { listOrders, listProducts } from '@app/merchandise/clients/records';
import { listCustomers } from '@app/party-registry/api/client';
import { listOpportunities } from '@app/sales-pipeline/clients/records';
import { listEmployees } from '@app/workforce/clients/records';
import { Effect, Match, Random } from 'effect';
import type { SubjectId, SubjectKind } from '../../shared/apis/records.ts';

/** Display label per subject id. Ids without a readable record are missing from the map. */
export type SubjectNames = ReadonlyMap<string, string>;

const noNames: SubjectNames = new Map();

const correlation = (label: string) =>
  Effect.all([Random.nextInt, Random.nextInt], { concurrency: 1 }).pipe(
    Effect.map(([first, second]) => `tagging:names:${label}:${first}:${second}`),
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
      listCustomers({ includeArchived: true, limit: 500 }).pipe(
        Effect.map((items) =>
          toNames(
            items,
            (item) => item.partyId,
            (item) => item.displayName,
          ),
        ),
      ),
    ),
    Match.when('employee', () =>
      listEmployees().pipe(
        Effect.map((items) =>
          toNames(
            items,
            (item) => item.id,
            (item) => item.fullName,
          ),
        ),
      ),
    ),
    Match.when('product', () =>
      inBatches(ids, (productIds) =>
        correlation('product').pipe(
          Effect.flatMap((id) => listProducts(id, { limit: ID_BATCH, ordersLimit: 0, productIds, summary: true })),
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
          Effect.flatMap((id) => listOrders(id, { limit: 0, orderIds, ordersLimit: ID_BATCH })),
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
        Effect.flatMap((id) => listOpportunities({}, id)),
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
