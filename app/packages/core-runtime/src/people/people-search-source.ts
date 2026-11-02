import { and, asc, eq, ne, or } from 'drizzle-orm';
import { Context, Effect, Layer } from 'effect';
import { CoreSearchWorkerSnapshot } from '../search/worker-snapshot.ts';
import type { CoreSearchWorkerSnapshotView } from '../search/worker-snapshot.ts';
import type { OutboxWorkerHandlerContext } from '../outbox/definition.ts';
import { legalEntities, principalCompanyMemberships, principals, tenants } from '../db/schema.ts';
import { peopleSearchUnavailable } from './people-search-visibility.ts';

export interface PeopleSearchSourcePerson {
  readonly displayName: string;
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly tenantId: string;
}
export interface PeopleSearchSourceSnapshot {
  readonly people: readonly PeopleSearchSourcePerson[];
  readonly projectionVersion: string;
  readonly tenantId: string;
}
const companyPeople = (view: CoreSearchWorkerSnapshotView, legalEntityId: string) =>
  view.forLegalEntity(legalEntityId, (executor) =>
    executor
      .select({
        displayName: principals.displayName,
        legalEntityId: principalCompanyMemberships.legalEntityId,
        principalId: principals.principalId,
        tenantId: principals.tenantId,
      })
      .from(principals)
      .innerJoin(
        principalCompanyMemberships,
        and(
          eq(principalCompanyMemberships.tenantId, principals.tenantId),
          eq(principalCompanyMemberships.principalId, principals.principalId),
          eq(principalCompanyMemberships.legalEntityId, legalEntityId),
        ),
      )
      .innerJoin(
        legalEntities,
        and(eq(legalEntities.tenantId, principals.tenantId), eq(legalEntities.legalEntityId, legalEntityId)),
      )
      .innerJoin(tenants, eq(tenants.tenantId, principals.tenantId))
      .where(
        and(
          eq(principals.tenantId, view.tenantId),
          or(eq(principals.kind, 'human'), eq(principals.kind, 'agent')),
          ne(principals.status, 'archived'),
          ne(principalCompanyMemberships.status, 'departed'),
          eq(legalEntities.status, 'active'),
          eq(tenants.status, 'active'),
        ),
      )
      .orderBy(asc(principals.displayName), asc(principals.principalId))
      .pipe(Effect.mapError(peopleSearchUnavailable)),
  );

/** Only owner SQL snapshot acquisition. Query-time matching always belongs to the existing Core index. */
export class PeopleSearchSource extends Context.Service<
  PeopleSearchSource,
  {
    readonly load: (
      context: OutboxWorkerHandlerContext,
    ) => Effect.Effect<PeopleSearchSourceSnapshot, ReturnType<typeof peopleSearchUnavailable>>;
  }
>()('@app/core-runtime/people/people-search-source/PeopleSearchSource') {}
export const PeopleSearchSourceLive = Layer.effect(
  PeopleSearchSource,
  Effect.gen(function* liveSource() {
    const snapshot = yield* CoreSearchWorkerSnapshot;
    return {
      load: Effect.fn('PeopleSearchSource.load')(function* load(context: OutboxWorkerHandlerContext) {
        return yield* snapshot
          .read(
            context,
            Effect.fn(function* coherentPeople(view) {
              const people = yield* Effect.forEach(
                view.legalEntityIds,
                (legalEntityId) => companyPeople(view, legalEntityId),
                { concurrency: 1 },
              );
              return { people: people.flat(), projectionVersion: view.projectionVersion, tenantId: view.tenantId };
            }),
          )
          .pipe(Effect.mapError(peopleSearchUnavailable));
      }),
    };
  }),
);
