import { Array as Arr, Context, Effect, Layer, Option, Schema } from 'effect';
import type { OutboxWorkerHandlerContext } from '../outbox/definition.ts';
import { validateCoreSearchProjectionWorkerContext, CoreSearchProjectionDocumentSchema } from '../search/projection.ts';
import { CoreSearchProjectionStore } from '../search/projection-store.ts';
import {
  ResourceContainmentRelationshipMutation,
  ownerResourceModuleContainment,
} from '../permissions/resource-containment-mutation.ts';
import type { ResourceContainmentRelationship } from '../permissions/resource-containment-mutation.ts';
import { toLegalEntityAccessObjectId, toResourceAccessObjectId } from '../permissions/context-access.ts';
import { PeopleSearchSource } from './people-search-source.ts';
import type { PeopleSearchSourceSnapshot } from './people-search-source.ts';
import { personRef, personIdentity } from './person-identity.ts';
import { PeopleSearchVisibility, peopleSearchUnavailable } from './people-search-visibility.ts';

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

export const peopleContainment = (
  tenantId: string,
  legalEntityId: string,
  ref: { readonly moduleId: string; readonly resourceId: string; readonly resourceType: string },
): readonly ResourceContainmentRelationship[] => {
  const module = ownerResourceModuleContainment(tenantId, legalEntityId, ref);
  const resourceId = toResourceAccessObjectId(tenantId, legalEntityId, ref);
  const companyId = toLegalEntityAccessObjectId(tenantId, legalEntityId);
  const identity = personIdentity(ref.resourceId);
  if (
    module === undefined ||
    resourceId === undefined ||
    companyId === undefined ||
    ref.moduleId !== corePeopleModuleId ||
    ref.resourceType !== 'core.identity.person' ||
    Option.isNone(identity) ||
    identity.value.legalEntityId !== legalEntityId
  ) {
    return [];
  }
  const resource = { objectId: resourceId, objectType: 'resource' } as const;
  return [
    module,
    { container: { objectId: companyId, objectType: 'legal_entity' }, relation: 'people_company', resource },
    { container: { objectId: tenantId, objectType: 'tenant' }, relation: 'people_tenant', resource },
  ];
};

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
    const containment = yield* ResourceContainmentRelationshipMutation;
    const visibility = yield* PeopleSearchVisibility;
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
        const visible = yield* visibility.visible(
          snapshot.tenantId,
          snapshot.people.map(({ principalId }) => principalId),
        );
        const documents = yield* buildPeopleSearchDocuments({
          ...snapshot,
          people: snapshot.people.filter(({ principalId }) => visible.has(principalId)),
        });
        // All source SQL transactions have closed before touching external containment.
        const relationships = documents.flatMap(({ ref, selectedLegalEntityId }) =>
          peopleContainment(snapshot.tenantId, selectedLegalEntityId ?? '', ref),
        );
        if (relationships.length !== documents.length * 3) {
          return yield* peopleSearchUnavailable();
        }
        yield* Effect.forEach(Arr.chunksOf(relationships, 99), (batch) => containment.touch({ relationships: batch }), {
          concurrency: 1,
          discard: true,
        }).pipe(Effect.mapError(peopleSearchUnavailable));
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
