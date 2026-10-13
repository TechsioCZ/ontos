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

/** Reads every record of one kind and labels it. Each branch is one cross-vertical read. */
const readNames = (kind: SubjectKind) =>
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
      correlation('product').pipe(
        Effect.flatMap((id) => listProducts(id)),
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
      correlation('order').pipe(
        Effect.flatMap((id) => listOrders(id)),
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
  return yield* readNames(kind);
});
