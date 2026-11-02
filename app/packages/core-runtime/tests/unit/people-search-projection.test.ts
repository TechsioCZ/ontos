import { Context, Effect, Layer, Option, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  makeInMemoryCoreSearchProjectionStore,
  createCoreSearchQueryRuntime,
  CoreSearchProjectionDocumentSchema,
  CoreSearchProjectionUnavailable,
} from '../../src/search/projection.ts';
import { CoreSearchProjectionStore } from '../../src/search/projection-store.ts';
import { attestOutboxWorkerHandlerContext } from '../../src/outbox/definition.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import {
  buildPeopleSearchDocuments,
  PeopleSearchProjector,
  PeopleSearchProjectorLive,
  peopleContainment,
} from '../../src/people/people-search-projection.ts';
import { PeopleSearchSource } from '../../src/people/people-search-source.ts';
import { PeopleSearchVisibility } from '../../src/people/people-search-visibility.ts';
import { ReadHandlerUnavailable } from '../../src/reads/errors.ts';
import {
  ResourceContainmentRelationshipMutation,
  makeResourceContainmentRelationshipMutation,
} from '../../src/permissions/resource-containment-mutation.ts';
import { personIdentity, personResourceId } from '../../src/people/person-identity.ts';
import { toResourceAccessObjectId } from '../../src/permissions/context-access.ts';
import { corePeopleSearchOutboxWorkers } from '../../src/outbox/core-system-worker-entry.ts';
import { peopleSearchIngestionRegistrations } from '../../src/people/people-search-worker-layer.ts';
import { isCoreSearchIngestionRegistered } from '../../src/search/ingestion-registry.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const companyId = '20000000-0000-4000-8000-000000000001';
const secondCompanyId = '20000000-0000-4000-8000-000000000002';
const principalId = '30000000-0000-4000-8000-000000000001';
const person = { displayName: 'Žofie Nováková', legalEntityId: companyId, principalId, tenantId };
const context = attestOutboxWorkerHandlerContext({
  attemptNumber: 1,
  claimId: 'claim-1',
  compositionRevision: 'a'.repeat(64),
  consumerModuleKey: 'core.identity',
  correlationId: 'people-search',
  deliveryId: 'delivery-1',
  domainEventId: 'event-1',
  legalEntityScope: 'forbidden',
  messageId: 'message-1',
  producerModuleKey: 'core.identity',
  tenantId,
  tenantSequenceNo: 1n,
  topic: 'core.identity.principal-lifecycle-changed.v1',
  workerKey: 'core.identity.project-people-lifecycle-search',
});
const scope = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  authBindingId: '40000000-0000-4000-8000-000000000001',
  authContextRef: 'better-auth-session:people-test',
  authMethod: 'session',
  legalEntityId: companyId,
  principalId,
  tenantId,
});
const query = (value: string, company = companyId, tenant = tenantId) => ({
  includeArchived: false,
  moduleId: 'core.identity',
  query: value,
  resourceType: 'core.identity.person',
  selectedLegalEntityId: company,
  tenantId: tenant,
});
it.effect('indexes company-qualified names only, with separate identities across companies', () =>
  Effect.gen(function* namesOnly() {
    const privatePerson = { ...person, email: 'private@example.test' };
    const documents = yield* buildPeopleSearchDocuments({
      people: [privatePerson, { ...person, legalEntityId: secondCompanyId }],
      projectionVersion: '1',
      tenantId,
    });
    expect(documents.map(({ ref }) => ref.resourceId)).toEqual([
      personResourceId(companyId, principalId),
      personResourceId(secondCompanyId, principalId),
    ]);
    expect(documents[0]?.searchableText).toEqual(['Žofie Nováková']);
    expect(
      yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Array(CoreSearchProjectionDocumentSchema)))(documents),
    ).not.toContain('private@example.test');
    expect(Option.isSome(personIdentity(documents[0]?.ref.resourceId ?? ''))).toBe(true);
    expect(Option.isNone(personIdentity(`${companyId}.not-a-principal`))).toBe(true);
    const failure = yield* Effect.flip(
      buildPeopleSearchDocuments({
        people: [{ ...person, tenantId: secondCompanyId }],
        projectionVersion: '1',
        tenantId,
      }),
    );
    expect(Schema.is(ReadHandlerUnavailable)(failure)).toBe(true);
  }),
);
it.effect('full versioned refresh removes departed/hidden rows, is replay-safe, and stays scoped', () =>
  Effect.gen(function* coherentRefresh() {
    const store = makeInMemoryCoreSearchProjectionStore();
    let people = [person];
    let version = '1';
    const order: string[] = [];
    const dependencies = yield* Layer.build(
      Layer.mergeAll(
        Layer.succeed(PeopleSearchSource, {
          load: () => {
            order.push('snapshot-closed');
            return Effect.succeed({ people, projectionVersion: version, tenantId });
          },
        }),
        Layer.succeed(CoreSearchProjectionStore, store),
        Layer.succeed(ResourceContainmentRelationshipMutation, {
          touch: ({ relationships }) => {
            order.push('containment');
            expect(relationships).toHaveLength(3);
            return Effect.void;
          },
        }),
        Layer.succeed(PeopleSearchVisibility, { visible: (_tenantId, ids) => Effect.succeed(new Set(ids)) }),
      ),
    );
    const projectorContext = yield* Layer.build(PeopleSearchProjectorLive).pipe(Effect.provideContext(dependencies));
    const projector = Context.get(projectorContext, PeopleSearchProjector);
    yield* projector.project(context);
    expect(order).toEqual(['snapshot-closed', 'containment']);
    const runtime = yield* createCoreSearchQueryRuntime.pipe(Effect.provideService(CoreSearchProjectionStore, store));
    expect(yield* runtime.search(query('zofie'), { ...scope, correlationId: 'query' })).toHaveLength(1);
    expect(yield* runtime.search(query('private@example.test'), { ...scope, correlationId: 'query' })).toEqual([]);
    expect(
      Schema.is(CoreSearchProjectionUnavailable)(
        yield* runtime.search(query('zofie', secondCompanyId), { ...scope, correlationId: 'query' }).pipe(Effect.flip),
      ),
    ).toBe(true);
    people = [];
    version = '2';
    yield* projector.project(context);
    yield* projector.project(context);
    expect(yield* runtime.search(query('zofie'), { ...scope, correlationId: 'query' })).toEqual([]);
    people = [person];
    version = '1';
    yield* projector.project(context);
    expect(yield* runtime.search(query('zofie'), { ...scope, correlationId: 'query' })).toEqual([]);
  }),
);
it.effect('containment touches only own module/company/tenant edges, never grants a reader/accessor', () =>
  Effect.gen(function* exactContainment() {
    const ref = {
      moduleId: 'core.identity',
      resourceId: personResourceId(companyId, principalId),
      resourceType: 'core.identity.person',
    };
    const relationships = peopleContainment(tenantId, companyId, ref);
    const writes: string[] = [];
    const mutation = makeResourceContainmentRelationshipMutation({
      writeRelationships: (request) => {
        for (const update of request.updates) {
          writes.push(update.relationship?.relation ?? '');
        }
        return Effect.succeed({ writtenAt: { token: 'people' } });
      },
    });
    const [first, ...rest] = relationships;
    if (first === undefined) {
      return yield* Effect.die('Expected containment');
    }
    yield* mutation.touch({ relationships: [first, ...rest] });
    expect(writes).toEqual(['module', 'people_company', 'people_tenant']);
    const company = relationships.find(({ relation }) => relation === 'people_company');
    if (company === undefined || company.relation !== 'people_company') {
      return yield* Effect.die('Expected company containment');
    }
    for (const invalid of [
      { ...company, container: { objectId: 'foreign', objectType: 'legal_entity' as const } },
      {
        ...company,
        resource: {
          objectId:
            toResourceAccessObjectId(tenantId, companyId, {
              ...ref,
              moduleId: 'other.owner',
              resourceType: 'other.owner.person',
            }) ?? '',
          objectType: 'resource' as const,
        },
      },
      {
        ...company,
        resource: {
          objectId:
            toResourceAccessObjectId(tenantId, companyId, {
              ...ref,
              resourceId: personResourceId(secondCompanyId, principalId),
            }) ?? '',
          objectType: 'resource' as const,
        },
      },
    ]) {
      expect(
        Predicate.isTagged('ResourceContainmentMutationUnavailable')(
          yield* mutation.touch({ relationships: [invalid] }).pipe(Effect.flip),
        ),
      ).toBe(true);
    }
    expect(writes).toHaveLength(3);
    return yield* Effect.void;
  }),
);
it('each Core system worker has an exact registered ingestion claim and no tenant module-state dependency', () => {
  expect(corePeopleSearchOutboxWorkers).toHaveLength(3);
  for (const { descriptor } of corePeopleSearchOutboxWorkers) {
    expect(descriptor.entrypoint.scope).toBe('system');
    expect(descriptor.legalEntityScope).toBe('forbidden');
    expect(isCoreSearchIngestionRegistered(peopleSearchIngestionRegistrations, descriptor)).toBe(true);
  }
});
