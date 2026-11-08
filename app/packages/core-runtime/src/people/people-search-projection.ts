import { Context, Effect, Layer, Option, Schema } from 'effect';
import type { OutboxWorkerHandlerContext } from '../outbox/definition.ts';
import { validateCoreSearchProjectionWorkerContext, CoreSearchProjectionDocumentSchema } from '../search/projection.ts';
import { CoreSearchProjectionStore } from '../search/projection-store.ts';
import { PeopleSearchSource } from './people-search-source.ts';
import type { PeopleSearchSourceSnapshot } from './people-search-source.ts';
import { personRef, personIdentity } from './person-identity.ts';
import { peopleSearchUnavailable } from './people-search-contract.ts';

const corePeopleModuleId = 'core.identity';
export const buildPeopleSearchDocuments = Effect.fn('PeopleSearch.buildDocuments')(function* build(
  snapshot: PeopleSearchSourceSnapshot,
) {
  return yield* Effect.forEach(
    snapshot.people,
    Effect.fn(function* document(person) {
      if (person.tenantId !== snapshot.tenantId) {
        return yield* peopleSearchUnavailable();
      }
      const ref = yield* personRef(snapshot.tenantId, person.legalEntityId, person.principalId).pipe(
        Effect.mapError(peopleSearchUnavailable),
      );
      if (Option.isNone(personIdentity(ref.resourceId))) {
        return yield* peopleSearchUnavailable();
      }
      // Names only. Neither authentication addresses nor invitation details are public search evidence.
      return yield* Schema.decodeUnknownEffect(CoreSearchProjectionDocumentSchema)({
        archived: false,
        facets: [],
        metadata: [],
        projectionVersion: snapshot.projectionVersion,
        ref,
        searchableText: [person.displayName],
        selectedLegalEntityId: person.legalEntityId,
        title: person.displayName,
      }).pipe(Effect.mapError(peopleSearchUnavailable));
    }),
    { concurrency: 1 },
  );
});

export class PeopleSearchProjector extends Context.Service<
  PeopleSearchProjector,
  {
    readonly project: (
      context: OutboxWorkerHandlerContext,
    ) => Effect.Effect<void, ReturnType<typeof peopleSearchUnavailable>>;
  }
>()('@app/core-runtime/people/people-search-projection/PeopleSearchProjector') {}

export const PeopleSearchProjectorLive = Layer.effect(
  PeopleSearchProjector,
  Effect.gen(function* liveProjector() {
    const source = yield* PeopleSearchSource;
    const store = yield* CoreSearchProjectionStore;
    return {
      project: Effect.fn('PeopleSearchProjector.project')(function* project(context: OutboxWorkerHandlerContext) {
        yield* validateCoreSearchProjectionWorkerContext(context, {
          moduleId: corePeopleModuleId,
          tenantId: context.tenantId,
        }).pipe(Effect.mapError(peopleSearchUnavailable));
        const snapshot = yield* source.load(context);
        if (snapshot.tenantId !== context.tenantId) {
          return yield* peopleSearchUnavailable();
        }
        // The projection is a candidate index; the read revalidates every hit against current authority.
        const documents = yield* buildPeopleSearchDocuments(snapshot);
        yield* store
          .replace(
            {
              documents,
              moduleId: corePeopleModuleId,
              rebuildVersion: snapshot.projectionVersion,
              resourceType: 'core.identity.person',
              tenantId: snapshot.tenantId,
            },
            context,
          )
          .pipe(Effect.mapError(peopleSearchUnavailable));
        return yield* Effect.void;
      }),
    };
  }),
);
