import { randomUUID } from 'node:crypto';
import {
  OperationContextDenied,
  ReadPermissionDenied,
  ReadRuntime,
  failClosedOwnerAuthorizationOverlay,
  makeActiveApplicationCompositionService,
  runAction,
} from '@app/core-runtime';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Array as EffectArray, Context, Effect, Exit, Layer, Match, Option, Order, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import {
  accessWorkloadBindings,
  legalEntities,
  principals,
  tenants,
} from '../../../../packages/core-runtime/src/db/schema.ts';
import {
  ConfigureCustomerSourceRoutePayloadSchema,
  ConfigureCustomerSourceRouteResultSchema,
} from '../../shared/actions/configure-customer-source-route.ts';
import {
  CustomerSourceRouteRequestSchema,
  CustomerSourceRouteResponseSchema,
} from '../../shared/apis/customer-source-route.ts';
import type { CustomerSourceRouteResponse } from '../../shared/apis/customer-source-route.ts';
import {
  CustomerSourceRouteUnavailable,
  StoredCustomerSourceRouteSchema,
} from '../../shared/domain/customer-source-route.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { configureCustomerSourceRouteAction } from '../../src/actions/configure-customer-source-route.action.ts';
import { customerSourceRouteRead } from '../../src/api/customer-source-route.read.ts';
import {
  commerceCustomerContextRelations,
  customerGroupDefinitionSourceRoutes,
  customerGroupMembershipSourceRoutes,
  customerProfileSourceRoutes,
  customerSourceRouteHistory,
  savedAddressSourceRoutes,
} from '../../src/database/schema.ts';
import { commerceCustomerContextRegistration } from '../../vertical.registration.ts';
import { enrollmentApplicationCompositionSnapshot } from '../support/enrollment-application-composition.ts';
import { makeCommerceCustomerContextDeniedAccess } from '../support/live-access-authority.ts';

const services = NodeChildProcessSpawner.layer.pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(NodeCrypto.layer),
);
const transport = () => ({
  correlationId: randomUUID(),
  idempotencyKey: randomUUID(),
  targetModuleKey: 'commerce.customer-context',
});
const json = Schema.encodeUnknownSync(Schema.fromJsonString(Schema.Json));
const resultOf = Schema.decodeSync(ConfigureCustomerSourceRouteResultSchema);
const responseOf = Schema.decodeUnknownSync(CustomerSourceRouteResponseSchema);
const storedRouteOf = Schema.decodeUnknownSync(StoredCustomerSourceRouteSchema);
/** The stored route, its generation and history page, or nothing when no route is stored. */
const storedOf = (response: CustomerSourceRouteResponse) =>
  Match.value(response).pipe(
    Match.tag('STORED', ({ generation, history, nextCursor, route }) => ({
      generation,
      history: history.map(({ actingPrincipalId, generation: entry, reason }) => ({
        actingPrincipalId,
        generation: entry,
        reason,
      })),
      nextCursor,
      route,
    })),
    Match.option,
  );
const SOURCE_WRITE = 'commerce.customer-context.source-write';
const SOURCE_READ = 'commerce.customer-context.source-read';
type Decision = typeof ConfigureCustomerSourceRoutePayloadSchema.Encoded;
type Route = Extract<Decision, { readonly _tag: 'CONFIGURE' }>['route'];
type RouteKind = Route['_tag'];

/**
 * One disposable owner database with a live human administrator and the Core enrollment a real Tenant holds for
 * Commerce source traffic: one system principal bound to the source-write workload and two integration
 * principals bound to the source-read workload. Nothing else is granted. The fixture's gate answers every
 * capability alike, so a suite that refuses one principal names it on `deniedAccess`, as a live gate with no
 * matching assignment would refuse it.
 */
const setup = Effect.fn('CustomerSourceRouteTest.setup')(function* setup() {
  const snapshot = yield* enrollmentApplicationCompositionSnapshot;
  const isolated = yield* makeIsolatedNativeDatabaseFixture({
    compositionSnapshot: snapshot,
    mode: 'schema-only',
    purpose: 'implementation-1126-group-definition',
  });
  const adminContext = yield* Layer.build(
    PgClient.layer({ url: Redacted.make(isolated.connections.admin.connectionString) }).pipe(
      Layer.provideMerge(Reactivity.layer),
    ),
  );
  const admin = yield* makeWithDefaults({ relations: commerceCustomerContextRelations }).pipe(
    Effect.provide(adminContext),
  );
  const core = yield* testCoreDatabase.pipe(Effect.provide(adminContext));
  const runtimeClient = yield* Layer.build(
    PgClient.layer({ url: Redacted.make(isolated.connections.runtime.connectionString) }).pipe(
      Layer.provideMerge(Reactivity.layer),
    ),
  );
  const runtime = yield* makeWithDefaults({ relations: commerceCustomerContextRelations }).pipe(
    Effect.provide(runtimeClient),
  );
  const fixture = yield* Effect.acquireRelease(
    makeLiveOperationFixture({
      access: 'allowed',
      actionExecutor: 'manager-only',
      actionKeys: [configureCustomerSourceRouteAction.descriptor.actionKey],
      additionalLegalEntity: 'same-tenant',
      adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
      allowedAudiences: ['commerce-customer-context'],
      applicationComposition: makeActiveApplicationCompositionService(Effect.succeed(snapshot)),
      authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
      compositionRevision: snapshot.composition.revision,
      expectedDeployment: ultramodernApiMarker,
      moduleKeys: ['commerce.customer-context'],
      ownerRegistration: commerceCustomerContextRegistration,
      runtimeConnectionString: Redacted.make(isolated.connections.runtime.connectionString),
    }),
    (resource) => resource.close().pipe(Effect.orDie),
  );
  const deniedAccess = makeCommerceCustomerContextDeniedAccess(failClosedOwnerAuthorizationOverlay);
  const runtimeContext = yield* Layer.build(fixture.layer.pipe(Layer.provide(deniedAccess.layer)));
  const { legalEntityId, tenantId } = fixture;
  const bindWorkload = (tenant: string, principalId: string, workloadKey: string) =>
    core.insert(accessWorkloadBindings).values({
      bindingId: randomUUID(),
      incarnation: randomUUID(),
      principalId,
      revokedAt: null,
      status: 'active',
      tenantId: tenant,
      workloadKey,
    });
  const revokeWorkload = (principalId: string, workloadKey: string) =>
    core
      .update(accessWorkloadBindings)
      .set({ revokedAt: sql`now()`, status: 'revoked' })
      .where(
        and(
          eq(accessWorkloadBindings.tenantId, tenantId),
          eq(accessWorkloadBindings.principalId, principalId),
          eq(accessWorkloadBindings.workloadKey, workloadKey),
        ),
      );
  const enroll = Effect.fn('CustomerSourceRouteTest.enroll')(function* enroll(
    tenant: string,
    kind: 'integration' | 'system',
    workloadKey: string,
  ) {
    const principalId = randomUUID();
    yield* core
      .insert(principals)
      .values({ displayName: 'Commerce source workload', kind, principalId, status: 'active', tenantId: tenant });
    yield* bindWorkload(tenant, principalId, workloadKey);
    return principalId;
  });
  const writer = yield* enroll(tenantId, 'system', SOURCE_WRITE);
  const reader = yield* enroll(tenantId, 'integration', SOURCE_READ);
  const secondReader = yield* enroll(tenantId, 'integration', SOURCE_READ);
  const principal = { ...fixture.manager, legalEntityId };
  const decide = (input: Decision) =>
    Schema.decodeEffect(ConfigureCustomerSourceRoutePayloadSchema)(input).pipe(
      Effect.flatMap((payload) =>
        runAction({ payload, principal, registration: configureCustomerSourceRouteAction, transport: transport() }),
      ),
      Effect.provideContext(runtimeContext),
    );
  const configure = (expectedGeneration: number | null, reason: string, route: Route) =>
    decide({ _tag: 'CONFIGURE', expectedGeneration, reason, route });
  const pause = (routeKind: RouteKind, routeId: string, expectedGeneration: number, reason = 'Pause imports') =>
    decide({ _tag: 'PAUSE', expectedGeneration, reason, routeId, routeKind });
  const readRoute = (request: typeof CustomerSourceRouteRequestSchema.Encoded, actor = principal) =>
    Schema.decodeEffect(CustomerSourceRouteRequestSchema)(request).pipe(
      Effect.flatMap((input) =>
        Context.get(runtimeContext, ReadRuntime).runRead({
          input,
          principal: actor,
          registration: customerSourceRouteRead,
          transport: { correlationId: randomUUID(), targetModuleKey: 'commerce.customer-context' },
        }),
      ),
      Effect.provideContext(runtimeContext),
    );
  /** One owner routine call as the runtime role, inside the installed Tenant and Legal Entity scope. */
  const owner = (statement: SQL) =>
    runtime.transaction((transaction) =>
      Effect.gen(function* ownerRoutine() {
        yield* transaction.execute(
          sql`select set_config('ontos.tenant_id',${tenantId},true),set_config('ontos.legal_entity_id',${legalEntityId},true)`,
          'objects',
        );
        // The columns the owner routines of this suite return; each call reads its own.
        const [row] = yield* transaction.execute<{
          readonly group_json?: { readonly groupRef: { readonly resourceId: string } } | null;
          readonly now?: string;
          readonly outcome?: string;
          readonly payload?: { readonly profileRef: { readonly resourceId: string } } | null;
          readonly result?: unknown;
        }>(statement, 'objects');
        return row;
      }),
    );
  return {
    admin,
    bindWorkload,
    configure,
    core,
    deniedAccess,
    enroll,
    fixture,
    legalEntityId,
    owner,
    pause,
    reader,
    readRoute,
    revokeWorkload,
    secondReader,
    tenantId,
    writer,
  };
});

// INTERNAL_CONTRACT only: these facts are not a claim about any external system's current payload.
const groupRoute = (principalId: string, sourceReaderPrincipalIds: readonly string[] = [], revision = '1') => ({
  _tag: 'GROUP_DEFINITION' as const,
  active: true,
  issuer: 'internal-ebs',
  mappingRevision: '1',
  namespace: 'customer-groups',
  principalId,
  route: { id: 'internal-group-route', revision },
  sourceReaderPrincipalIds,
});
const profileRoute = (principalId: string, sourceReaderPrincipalIds: readonly string[]) => ({
  _tag: 'PROFILE' as const,
  active: true,
  issuer: 'internal-ebs',
  mappingRevision: '1',
  namespace: 'customers',
  principalId,
  recordType: 'customer',
  route: { id: 'internal-profile-route', revision: '1' },
  sourceReaderPrincipalIds,
});
const membershipRoute = (principalId: string) => ({
  _tag: 'MEMBERSHIP' as const,
  active: true,
  allowComplete: true,
  completenessContract: {
    coverage: 'ALL_GROUP_MEMBERSHIPS_FOR_EXACT_PROFILE' as const,
    ref: 'internal-completeness-contract',
    revision: '1',
  },
  issuer: 'internal-ebs',
  principalId,
  route: { id: 'internal-membership-route', revision: '1' },
  sourceNamespace: 'customer-group-memberships',
});
const addressRoute = (principalId: string) => ({
  _tag: 'SAVED_ADDRESS' as const,
  active: true,
  issuer: 'internal-ebs',
  mappingRevision: '1',
  namespace: 'customer-addresses',
  principalId,
  recordType: 'address',
  route: { id: 'internal-address-route', revision: '1' },
});
const bind = 'Bind the internal EBS route';
/** One Saved Address source assertion through the internal address route. */
const addressSource = (effectId: string) => ({
  effectId,
  identity: {
    issuer: 'internal-ebs',
    namespace: 'customer-addresses',
    recordId: `address-${effectId}`,
    recordType: 'address',
    routeRef: 'internal-address-route',
  },
  mappingRevision: '1',
  routeRevision: '1',
});

it.live(
  'grants a source route only to principals Core enrolls for it, under a generation no stale decision overwrites',
  () =>
    Effect.scoped(
      Effect.gen(function* governedSourceRouteAuthority() {
        const {
          admin,
          bindWorkload,
          configure,
          core,
          enroll,
          fixture,
          legalEntityId,
          owner,
          pause,
          reader,
          readRoute,
          revokeWorkload,
          secondReader,
          tenantId,
          writer,
        } = yield* setup();
        const ineligible = resultOf({ _tag: 'REJECTED', currentGeneration: null, reason: 'PRINCIPAL_INELIGIBLE' });
        const groupPage = (cursor: number | null, limit = 10) =>
          readRoute({ cursor, limit, routeId: 'internal-group-route', routeKind: 'GROUP_DEFINITION' });
        const historyOf = (routeId: string) =>
          admin
            .select()
            .from(customerSourceRouteHistory)
            .where(
              and(eq(customerSourceRouteHistory.tenantId, tenantId), eq(customerSourceRouteHistory.routeId, routeId)),
            )
            .orderBy(asc(customerSourceRouteHistory.generation));
        const storedGroups = () =>
          admin
            .select()
            .from(customerGroupDefinitionSourceRoutes)
            .where(
              and(
                eq(customerGroupDefinitionSourceRoutes.tenantId, tenantId),
                eq(customerGroupDefinitionSourceRoutes.routeId, 'internal-group-route'),
              ),
            );

        // The human administrator, an integration reader, an unknown id and another Tenant's enrolled writer are
        // never the writer of this Tenant's route.
        const foreignTenant = randomUUID();
        yield* core.insert(tenants).values({
          defaultLocale: 'en',
          name: 'Foreign Tenant',
          slug: `foreign-${foreignTenant}`,
          status: 'active',
          tenantId: foreignTenant,
        });
        const foreignWriter = yield* enroll(foreignTenant, 'system', SOURCE_WRITE);
        for (const candidate of [fixture.manager.principalId, reader, randomUUID(), foreignWriter]) {
          expect(yield* configure(null, bind, groupRoute(candidate))).toEqual(ineligible);
        }
        // A Profile or Group definition reader must be an integration principal of this Tenant bound to the
        // source-read workload.
        for (const readers of [[writer], [fixture.manager.principalId], [reader, randomUUID()]]) {
          expect(yield* configure(null, bind, profileRoute(writer, readers))).toEqual(ineligible);
          expect(yield* configure(null, bind, groupRoute(writer, readers))).toEqual(ineligible);
        }
        // Nothing is stored yet, so nothing can be paused and the administrator sees no route.
        expect(yield* pause('GROUP_DEFINITION', 'internal-group-route', 1)).toEqual(
          resultOf({ _tag: 'REJECTED', currentGeneration: null, reason: 'EXPECTATION_MISMATCH' }),
        );
        expect(yield* groupPage(null)).toEqual(responseOf({ _tag: 'ABSENT' }));
        expect(yield* admin.select().from(customerSourceRouteHistory)).toEqual([]);

        // PostgreSQL renders a uuid in lower case, so an upper-case request stores the same principal.
        const route = groupRoute(writer);
        const [first, concurrent] = yield* Effect.all(
          [configure(null, bind, route), configure(null, bind, { ...route, principalId: writer.toUpperCase() })],
          { concurrency: 2 },
        );
        expect([first, concurrent]).toContainEqual(resultOf({ _tag: 'CONFIGURED', generation: 1, route }));
        expect([first, concurrent]).toContainEqual(resultOf({ _tag: 'UNCHANGED', generation: 1, route }));

        const paused = { ...route, active: false };
        expect(yield* configure(null, 'Stale operator view', paused)).toEqual(
          resultOf({ _tag: 'REJECTED', currentGeneration: 1, reason: 'EXPECTATION_MISMATCH' }),
        );
        expect(yield* configure(1, 'Another issuer', { ...route, issuer: 'another-ebs' })).toEqual(
          resultOf({ _tag: 'REJECTED', currentGeneration: 1, reason: 'SOURCE_IDENTITY_IMMUTABLE' }),
        );
        // A pause changes the active flag and the generation, and nothing else the route states.
        const [active] = yield* storedGroups();
        expect(yield* pause('GROUP_DEFINITION', route.route.id, 1, 'Pause')).toEqual(
          resultOf({ _tag: 'PAUSED', generation: 2 }),
        );
        const [inactive] = yield* storedGroups();
        expect(inactive).toEqual({ ...active, active: false, generation: 2 });
        // Pausing a paused route changes nothing and records no generation.
        expect(yield* pause('GROUP_DEFINITION', route.route.id, 2, 'Pause again')).toEqual(
          resultOf({ _tag: 'PAUSED', generation: 2 }),
        );
        expect(yield* storedGroups()).toEqual([inactive]);
        expect(yield* historyOf(route.route.id)).toHaveLength(2);
        expect(yield* configure(2, 'Resume', route)).toEqual(resultOf({ _tag: 'CONFIGURED', generation: 3, route }));
        // A -> B -> A: the route equals what generation 1 stored, yet a decision taken against generation 1 is stale.
        expect(yield* pause('GROUP_DEFINITION', route.route.id, 1, 'Late pause')).toEqual(
          resultOf({ _tag: 'REJECTED', currentGeneration: 3, reason: 'EXPECTATION_MISMATCH' }),
        );

        // The routines refuse a Legal Entity other than the one their transaction is scoped to.
        const otherEntity = randomUUID();
        for (const statement of [
          sql`select * from commerce_customer_context.configure_customer_source_route(${tenantId}::uuid,${otherEntity}::uuid,${json(
            {
              actingPrincipalId: fixture.manager.principalId,
              actionInvocationId: randomUUID(),
              enrolledReaderPrincipalIds: [],
              enrolledWriterPrincipalId: writer,
              expectedGeneration: 3,
              reason: 'Wrong Legal Entity',
              route: paused,
            },
          )}::jsonb)`,
          sql`select * from commerce_customer_context.pause_customer_source_route(${tenantId}::uuid,${otherEntity}::uuid,${json(
            {
              actingPrincipalId: fixture.manager.principalId,
              actionInvocationId: randomUUID(),
              expectedGeneration: 3,
              reason: 'Wrong Legal Entity',
              routeId: route.route.id,
              routeKind: route._tag,
            },
          )}::jsonb)`,
          sql`select * from commerce_customer_context.read_customer_source_route(${tenantId}::uuid,${otherEntity}::uuid,${json(
            { cursor: null, limit: 10, routeId: route.route.id, routeKind: route._tag },
          )}::jsonb)`,
        ]) {
          expect(Exit.isFailure(yield* owner(statement).pipe(Effect.exit))).toBe(true);
        }

        // With two system principals enrolled for source writes Core names no writer, so no route can be configured;
        // a pause needs no enrollment and still succeeds.
        const secondWriter = yield* enroll(tenantId, 'system', SOURCE_WRITE);
        const ambiguous = yield* Effect.flip(configure(3, 'Resume under an ambiguous enrollment', route));
        expect(Schema.is(CustomerSourceRouteUnavailable)(ambiguous)).toBe(true);
        expect(ambiguous).toMatchObject({ code: 'PERSISTENCE_UNAVAILABLE' });
        expect(yield* pause('GROUP_DEFINITION', route.route.id, 3, 'Pause during the ambiguous enrollment')).toEqual(
          resultOf({ _tag: 'PAUSED', generation: 4 }),
        );
        yield* revokeWorkload(secondWriter, SOURCE_WRITE);
        expect(yield* configure(4, 'Resume once one writer is enrolled', route)).toEqual(
          resultOf({ _tag: 'CONFIGURED', generation: 5, route }),
        );
        // Once Core revokes the writer's enrollment, the stored route cannot be revised for it, yet it can be paused.
        yield* revokeWorkload(writer, SOURCE_WRITE);
        expect(yield* configure(5, 'Revise without enrollment', groupRoute(writer, [], '2'))).toEqual(
          resultOf({ _tag: 'REJECTED', currentGeneration: 5, reason: 'PRINCIPAL_INELIGIBLE' }),
        );
        expect(yield* pause('GROUP_DEFINITION', route.route.id, 5, 'Pause the unenrolled writer')).toEqual(
          resultOf({ _tag: 'PAUSED', generation: 6 }),
        );

        const history = yield* historyOf(route.route.id);
        expect(
          history.map(({ currentRoute, generation, previousRoute, reason, routeId, routeKind }) => ({
            currentRoute,
            generation,
            previousRoute,
            reason,
            routeId,
            routeKind,
          })),
        ).toEqual(
          [
            { currentRoute: route, generation: 1, previousRoute: null, reason: bind },
            { currentRoute: paused, generation: 2, previousRoute: route, reason: 'Pause' },
            { currentRoute: route, generation: 3, previousRoute: paused, reason: 'Resume' },
            {
              currentRoute: paused,
              generation: 4,
              previousRoute: route,
              reason: 'Pause during the ambiguous enrollment',
            },
            { currentRoute: route, generation: 5, previousRoute: paused, reason: 'Resume once one writer is enrolled' },
            { currentRoute: paused, generation: 6, previousRoute: route, reason: 'Pause the unenrolled writer' },
          ].map((entry) => ({ ...entry, routeId: route.route.id, routeKind: route._tag })),
        );
        expect(new Set(history.map(({ actingPrincipalId }) => actingPrincipalId))).toEqual(
          new Set([fixture.manager.principalId]),
        );
        expect(new Set(history.map(({ actionInvocationId }) => actionInvocationId)).size).toBe(6);
        expect(yield* storedGroups()).toEqual([
          {
            active: false,
            generation: 6,
            issuer: route.issuer,
            legalEntityId,
            mappingRevision: route.mappingRevision,
            namespace: route.namespace,
            principalId: writer,
            routeId: route.route.id,
            routeRevision: route.route.revision,
            sourceReaderPrincipalIds: [],
            tenantId,
          },
        ]);
        const rewritten = yield* admin
          .update(customerSourceRouteHistory)
          .set({ reason: 'Rewritten' })
          .where(eq(customerSourceRouteHistory.tenantId, tenantId))
          .pipe(Effect.exit);
        expect(Exit.isFailure(rewritten)).toBe(true);

        // A second administrator reads what a decision would replace, and the decisions taken so far, newest first.
        const entry = (generation: number, reason: string) => ({
          actingPrincipalId: fixture.manager.principalId,
          generation,
          reason,
        });
        expect(storedOf(yield* groupPage(null, 2))).toEqual(
          Option.some({
            generation: 6,
            history: [entry(6, 'Pause the unenrolled writer'), entry(5, 'Resume once one writer is enrolled')],
            nextCursor: Option.some(5),
            route: storedRouteOf(paused),
          }),
        );
        expect(storedOf(yield* groupPage(5, 2))).toEqual(
          Option.some({
            generation: 6,
            history: [entry(4, 'Pause during the ambiguous enrollment'), entry(3, 'Resume')],
            nextCursor: Option.some(3),
            route: storedRouteOf(paused),
          }),
        );
        expect(storedOf(yield* groupPage(3, 2))).toEqual(
          Option.some({
            generation: 6,
            history: [entry(2, 'Pause'), entry(1, bind)],
            nextCursor: Option.none(),
            route: storedRouteOf(paused),
          }),
        );

        // Core enrolls the writer again for the remaining routes.
        yield* bindWorkload(tenantId, writer, SOURCE_WRITE);
        // A route stored before this Action existed may lack its mapping revision. The administrator sees it without
        // one, pauses it without restating it, and repairs it with the mapping revision they supply; the owner never
        // invents one.
        yield* admin.insert(customerGroupDefinitionSourceRoutes).values({
          active: true,
          issuer: route.issuer,
          legalEntityId,
          mappingRevision: null,
          namespace: route.namespace,
          principalId: writer,
          routeId: 'legacy-group-route',
          routeRevision: '1',
          tenantId,
        });
        const legacyStored = { ...route, mappingRevision: null, route: { id: 'legacy-group-route', revision: '1' } };
        expect(
          storedOf(
            yield* readRoute({ cursor: null, limit: 10, routeId: 'legacy-group-route', routeKind: 'GROUP_DEFINITION' }),
          ),
        ).toEqual(
          Option.some({ generation: 1, history: [], nextCursor: Option.none(), route: storedRouteOf(legacyStored) }),
        );
        expect(yield* pause('GROUP_DEFINITION', 'legacy-group-route', 1, 'Pause the legacy route')).toEqual(
          resultOf({ _tag: 'PAUSED', generation: 2 }),
        );
        const legacy = { ...paused, route: { id: 'legacy-group-route', revision: '1' } };
        expect(yield* configure(1, 'Repair against a stale view', legacy)).toEqual(
          resultOf({ _tag: 'REJECTED', currentGeneration: 2, reason: 'EXPECTATION_MISMATCH' }),
        );
        expect(yield* configure(2, 'Repair with the agreed mapping', legacy)).toEqual(
          resultOf({ _tag: 'CONFIGURED', generation: 3, route: legacy }),
        );
        expect(yield* historyOf('legacy-group-route')).toMatchObject([
          { currentRoute: { ...legacyStored, active: false }, generation: 2, previousRoute: legacyStored },
          { currentRoute: legacy, generation: 3, previousRoute: { ...legacyStored, active: false } },
        ]);

        // Readers are a set, for a Group definition route as for a Profile route.
        const readers = EffectArray.sort([reader, secondReader], Order.String);
        const readable = { ...legacy, sourceReaderPrincipalIds: readers };
        expect(
          yield* configure(3, 'Name the readers', {
            ...legacy,
            sourceReaderPrincipalIds: EffectArray.reverse(readers),
          }),
        ).toEqual(resultOf({ _tag: 'CONFIGURED', generation: 4, route: readable }));
        expect(yield* configure(4, 'Same readers, another order', readable)).toEqual(
          resultOf({ _tag: 'UNCHANGED', generation: 4, route: readable }),
        );

        // The other three registries: Profile readers are a set, and no route ever moves to another source.
        const profile = profileRoute(writer, readers);
        expect(yield* configure(null, bind, profileRoute(writer, EffectArray.reverse(readers)))).toEqual(
          resultOf({ _tag: 'CONFIGURED', generation: 1, route: profile }),
        );
        expect(yield* configure(null, 'Same readers, another order', profile)).toEqual(
          resultOf({ _tag: 'UNCHANGED', generation: 1, route: profile }),
        );
        for (const other of [membershipRoute(writer), addressRoute(writer)]) {
          expect(yield* configure(null, bind, other)).toEqual(
            resultOf({ _tag: 'CONFIGURED', generation: 1, route: other }),
          );
        }
        for (const moved of [
          { ...membershipRoute(writer), sourceNamespace: 'other-memberships' },
          { ...profile, recordType: 'contact' },
          { ...addressRoute(writer), recordType: 'contact' },
        ]) {
          expect(yield* configure(1, 'Move the source', moved)).toEqual(
            resultOf({ _tag: 'REJECTED', currentGeneration: 1, reason: 'SOURCE_IDENTITY_IMMUTABLE' }),
          );
        }
        const [storedProfile] = yield* admin
          .select()
          .from(customerProfileSourceRoutes)
          .where(eq(customerProfileSourceRoutes.tenantId, tenantId));
        expect(storedProfile).toMatchObject({ generation: 1, principalId: writer, sourceReaderPrincipalIds: readers });
        // A stored reader Core no longer binds makes the route unchangeable for it, yet the route can be paused.
        yield* revokeWorkload(secondReader, SOURCE_READ);
        expect(yield* configure(1, 'Keep the unbound reader', { ...profile, active: false })).toEqual(
          resultOf({ _tag: 'REJECTED', currentGeneration: 1, reason: 'PRINCIPAL_INELIGIBLE' }),
        );
        expect(yield* pause('PROFILE', profile.route.id, 1, 'Pause the unbound reader')).toEqual(
          resultOf({ _tag: 'PAUSED', generation: 2 }),
        );
        expect(
          yield* admin
            .select()
            .from(customerGroupMembershipSourceRoutes)
            .where(eq(customerGroupMembershipSourceRoutes.tenantId, tenantId)),
        ).toEqual([
          {
            active: true,
            allowComplete: true,
            completenessContractCoverage: 'ALL_GROUP_MEMBERSHIPS_FOR_EXACT_PROFILE',
            completenessContractRef: 'internal-completeness-contract',
            completenessContractRevision: '1',
            generation: 1,
            issuer: 'internal-ebs',
            legalEntityId,
            principalId: writer,
            routeId: 'internal-membership-route',
            routeRevision: '1',
            sourceNamespace: 'customer-group-memberships',
            tenantId,
          },
        ]);
        expect(
          yield* admin.select().from(savedAddressSourceRoutes).where(eq(savedAddressSourceRoutes.tenantId, tenantId)),
        ).toEqual([
          {
            active: true,
            generation: 1,
            issuer: 'internal-ebs',
            legalEntityId,
            mappingRevision: '1',
            namespace: 'customer-addresses',
            principalId: writer,
            recordType: 'address',
            routeRef: 'internal-address-route',
            routeRevision: '1',
            tenantId,
          },
        ]);
      }),
    ).pipe(Effect.provide(services)),
);

it.live('shows a stored route only to an administrator of its own company and Tenant, and audits every read', () =>
  Effect.scoped(
    Effect.gen(function* administratorRouteRead() {
      const { configure, core, deniedAccess, fixture, legalEntityId, readRoute, tenantId, writer } = yield* setup();
      const route = groupRoute(writer);
      expect(yield* configure(null, bind, route)).toEqual(resultOf({ _tag: 'CONFIGURED', generation: 1, route }));
      const request = { cursor: null, limit: 10, routeId: route.route.id, routeKind: route._tag };
      const { accessDeclaration, evidencePolicy } = customerSourceRouteRead.descriptor;
      const routeReads = fixture
        .evidence(core)
        .pipe(
          Effect.map(({ accesses }) =>
            accesses.filter(({ evidencePolicyKey }) => evidencePolicyKey === evidencePolicy.policyKey),
          ),
        );
      const audited = {
        evidencePolicyKey: evidencePolicy.policyKey,
        legalEntityId,
        servingModuleKey: 'commerce.customer-context',
        tenantId,
      };

      // The administrator reads the route, and Core records the read with what it returned.
      expect(
        Option.map(storedOf(yield* readRoute(request)), ({ generation, route: stored }) => ({ generation, stored })),
      ).toEqual(Option.some({ generation: 1, stored: storedRouteOf(route) }));
      expect(yield* routeReads).toEqual([
        expect.objectContaining({
          ...audited,
          outcome: 'allowed',
          outcomeCode: 'read_allowed',
          principalId: fixture.manager.principalId,
          resultCount: 1,
        }),
      ]);

      // A member of the company without the administration assignment is refused, and the refusal is recorded.
      expect(accessDeclaration?.key).toBe('commerce.customer-context.customer-source-route.read');
      deniedAccess.deny(fixture.reader.principalId, accessDeclaration?.key ?? '');
      const member = yield* Effect.flip(readRoute(request, { ...fixture.reader, legalEntityId }));
      expect(Schema.is(ReadPermissionDenied)(member)).toBe(true);
      expect(yield* routeReads).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ...audited,
            outcome: 'denied',
            outcomeCode: 'read_permission_denied',
            principalId: fixture.reader.principalId,
            resultCount: 0,
          }),
        ]),
      );

      // Each company holds its own routes: under another company of the same Tenant the administrator sees none.
      const otherCompany = yield* Effect.fromNullishOr(fixture.secondaryLegalEntity).pipe(Effect.orDie);
      expect(yield* readRoute(request, otherCompany.manager)).toEqual(responseOf({ _tag: 'ABSENT' }));
      expect(yield* routeReads).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            ...audited,
            legalEntityId: otherCompany.legalEntityId,
            outcome: 'allowed',
            principalId: fixture.manager.principalId,
            resultCount: 0,
          }),
        ]),
      );

      // The administrator cannot read under another Tenant's company, nor as a principal of another Tenant.
      const foreignTenant = randomUUID();
      const foreignCompany = randomUUID();
      yield* core.insert(tenants).values({
        defaultLocale: 'en',
        name: 'Foreign Tenant',
        slug: `foreign-${foreignTenant}`,
        status: 'active',
        tenantId: foreignTenant,
      });
      yield* core.insert(legalEntities).values({
        legalEntityId: foreignCompany,
        legalName: 'Foreign company',
        registrationCountry: 'CZ',
        registrationNumber: foreignCompany,
        status: 'active',
        tenantId: foreignTenant,
      });
      for (const outsider of [
        { ...fixture.manager, legalEntityId: foreignCompany },
        { ...fixture.manager, legalEntityId: foreignCompany, tenantId: foreignTenant },
      ]) {
        expect(Schema.is(OperationContextDenied)(yield* Effect.flip(readRoute(request, outsider)))).toBe(true);
      }
      expect(yield* routeReads).toHaveLength(3);
    }),
  ).pipe(Effect.provide(services)),
);

it.live(
  'a paused route admits no source write of any kind, and a Group definition reader reads only current definitions',
  () =>
    Effect.scoped(
      Effect.gen(function* pausedRouteAndGroupReader() {
        const { configure, legalEntityId, owner, pause, reader, secondReader, tenantId, writer } = yield* setup();
        // Business times come from the database clock that also stamps the owner's records.
        const isoNow = owner(
          sql`select to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`,
        ).pipe(Effect.map((row) => row?.now ?? ''));
        interface SourceRoute {
          readonly id: string;
          readonly revision: string;
        }

        // The owner routines the source Actions and the Group definition Read run, called as the given principal. The
        // live fixture runs Actions only for human session actors, so the source writes are driven at this boundary.
        const groupIntent = (effectId: string, recordId: string, sourceCode: string, route: SourceRoute) => ({
          businessCode: `INTERNAL_${sourceCode}`,
          description: 'Source-managed fixture Group',
          initialState: 'ACTIVE',
          meaningKey: `internal.ebs-${sourceCode.toLowerCase()}`,
          membershipCriteria: `Explicit ${sourceCode} assignment by the internal EBS fixture`,
          name: `Group ${sourceCode}`,
          purpose: `Internal EBS ${sourceCode} classification`,
          reason: 'Import source Group revision 1',
          source: {
            definitionEvidence: {
              kind: 'NAMED_CONFIGURATION',
              reference: 'internal.ebs-explicit-classification',
              revision: '1',
            },
            effectId,
            issuer: 'internal-ebs',
            mappingRevision: '1',
            namespace: 'customer-groups',
            order: 1,
            recordId,
            revision: '1',
            route,
            sourceCode,
          },
        });
        type GroupIntent = ReturnType<typeof groupIntent>;
        const writeGroup = (principalId: string, intent: GroupIntent) =>
          owner(
            sql`select outcome, group_json from commerce_customer_context.apply_customer_group_definition_source(${tenantId}::uuid,${legalEntityId}::uuid,'CREATE',${json(intent)}::jsonb,now(),${principalId}::uuid,${randomUUID()}::uuid)`,
          ).pipe(Effect.map((row) => ({ groupId: row?.group_json?.groupRef.resourceId ?? '', outcome: row?.outcome })));
        const readGroup = (principalId: string, intent: GroupIntent, route: SourceRoute, mode = 'RECEIPT') =>
          owner(
            sql`select outcome, result from commerce_customer_context.read_customer_group_definition_source(${tenantId}::uuid,${legalEntityId}::uuid,${principalId}::uuid,${json(
              {
                effectId: intent.source.effectId,
                expectedIntent: intent,
                expectedOperation: 'CREATE',
                issuer: intent.source.issuer,
                mappingRevision: intent.source.mappingRevision,
                mode,
                namespace: intent.source.namespace,
                recordId: intent.source.recordId,
                route,
              },
            )}::jsonb)`,
          );

        const profileSource = (effectId: string, recordId: string, route: SourceRoute) => ({
          effectId,
          issuer: 'internal-ebs',
          mappingRevision: '1',
          namespace: 'customers',
          occurrenceId: `${recordId}-r1`,
          order: 1,
          recordId,
          recordType: 'customer',
          revision: 'r1',
          route,
        });
        type ProfileSource = ReturnType<typeof profileSource>;
        const ensureProfile = Effect.fn('CustomerSourceRouteTest.ensureProfile')(function* ensureProfile(
          principalId: string,
          source: ProfileSource,
        ) {
          const partyId = randomUUID();
          const payload = {
            effectiveAt: yield* isoNow,
            partySourceReference: {
              occurrenceId: `person-${source.recordId}-r1`,
              recordId: `person-${source.recordId}`,
              source: {
                issuer: 'internal-party-source',
                namespace: 'identity',
                recordType: 'person',
                routeRef: 'party-source-route',
              },
            },
            source,
            subject: {
              kind: 'RETAIL',
              partyRef: {
                moduleId: 'party.registry',
                resourceId: partyId,
                resourceType: 'party.registry.party',
                tenantId,
              },
              sellingLegalEntityRef: {
                moduleId: 'core.identity',
                resourceId: legalEntityId,
                resourceType: 'core.identity.legal-entity',
                tenantId,
              },
            },
            trigger: 'AUTHORIZED_ONBOARDING',
          };
          return yield* owner(
            sql`select outcome, payload from commerce_customer_context.ensure_source_customer_profile(${tenantId}::uuid,${legalEntityId}::uuid,${principalId}::uuid,${randomUUID()}::uuid,now(),${json(
              {
                payload,
                profileKind: 'RETAIL',
                proof: { partyResourceId: partyId, partyResourceRevision: 'internal-party-revision-1' },
              },
            )}::jsonb)`,
          ).pipe(
            Effect.map((row) => ({
              outcome: row?.outcome,
              payload: row?.payload,
              profileId: row?.payload?.profileRef.resourceId ?? '',
            })),
          );
        });

        const membershipCommand = (
          effectiveAt: string,
          effectId: string,
          groupId: string,
          profileId: string,
          route: SourceRoute,
        ) => ({
          effectiveAt,
          groupRef: {
            moduleId: 'commerce.customer-context',
            resourceId: groupId,
            resourceType: 'commerce.customer-context.customer-group',
            tenantId,
          },
          manager: {
            factFamily: 'CUSTOMER_GROUP_MEMBERSHIP',
            issuer: 'internal-ebs',
            sourceNamespace: 'customer-group-memberships',
            tenantId,
          },
          operation: 'ASSIGN',
          profile: {
            profileKind: 'RETAIL',
            profileRef: {
              moduleId: 'commerce.customer-context',
              resourceId: profileId,
              resourceType: 'commerce.customer-context.retail-customer-profile',
              tenantId,
            },
          },
          reason: 'Assign the source membership',
          route,
          source: { assertionId: `assertion-${effectId}`, effectId, order: 1, sourceRecordId: `record-${effectId}` },
        });
        type MembershipCommand = ReturnType<typeof membershipCommand>;
        const applyMembership = (principalId: string, command: MembershipCommand) =>
          owner(
            sql`select outcome, result from commerce_customer_context.apply_customer_group_membership_source(${tenantId}::uuid,${legalEntityId}::uuid,${principalId}::uuid,${randomUUID()}::uuid,clock_timestamp(),${json(command)}::jsonb)`,
          );
        // Saved Address authorization is checked before any address is written, so it shows the route's answer alone.
        const authorizeAddress = (principalId: string, effectId: string) =>
          owner(
            sql`select outcome from commerce_customer_context.authorize_saved_address_source(${tenantId}::uuid,${legalEntityId}::uuid,${principalId}::uuid,${randomUUID()}::uuid,'commerce.customer-context.add-saved-address',${'a'.repeat(64)},${json(
              {
                operation: 'ADD',
                profile: { kind: 'RETAIL', profileRef: { resourceId: randomUUID(), tenantId } },
                source: addressSource(effectId),
              },
            )}::jsonb)`,
          );

        // Every route binds the writer; the Group definition route also names one reader.
        const routes = {
          address: addressRoute(writer),
          group: groupRoute(writer, [reader]),
          membership: membershipRoute(writer),
          profile: profileRoute(writer, []),
        };
        for (const route of Object.values(routes)) {
          expect(yield* configure(null, bind, route)).toEqual(resultOf({ _tag: 'CONFIGURED', generation: 1, route }));
        }
        const denied = { outcome: 'SOURCE_AUTHORITY_DENIED' };

        // While the routes are active the writer writes through each of them.
        const group = groupIntent('group-create', '77', 'LOYAL', routes.group.route);
        const created = yield* writeGroup(writer, group);
        expect(created).toMatchObject({ outcome: 'CREATED' });
        const ensured = yield* ensureProfile(writer, profileSource('profile-create', 'C-1', routes.profile.route));
        expect(ensured).toMatchObject({ payload: { sourceEffect: { effectId: 'profile-create', replayed: false } } });
        const membership = membershipCommand(
          yield* isoNow,
          'membership-assign',
          created.groupId,
          ensured.profileId,
          routes.membership.route,
        );
        expect(yield* applyMembership(writer, membership)).toMatchObject({ outcome: 'APPLIED' });
        // The route admits the writer; the request then fails only on its target, a Profile this source never bound.
        expect(yield* authorizeAddress(writer, 'address-add')).toMatchObject({ outcome: 'TARGET_INELIGIBLE' });

        // The writer reads the current definition and recovers its receipt; the reader the route names reads the
        // current definition and no receipt; a principal Core binds to source reads that the route does not name
        // reads nothing.
        expect(yield* readGroup(writer, group, routes.group.route, 'CURRENT')).toMatchObject({
          outcome: 'FOUND',
          result: { _tag: 'CURRENT' },
        });
        expect(yield* readGroup(writer, group, routes.group.route)).toMatchObject({
          outcome: 'FOUND',
          result: { _tag: 'RECEIPT', created: true, operation: 'CREATE' },
        });
        expect(yield* readGroup(reader, group, routes.group.route, 'CURRENT')).toMatchObject({
          outcome: 'FOUND',
          result: { _tag: 'CURRENT' },
        });
        expect(yield* readGroup(reader, group, routes.group.route)).toMatchObject(denied);
        for (const mode of ['CURRENT', 'RECEIPT']) {
          expect(yield* readGroup(secondReader, group, routes.group.route, mode)).toMatchObject(denied);
        }

        // Each route is paused; no fresh write of its kind is admitted any more, and its reader reads nothing.
        for (const route of Object.values(routes)) {
          expect(yield* pause(route._tag, route.route.id, 1)).toEqual(resultOf({ _tag: 'PAUSED', generation: 2 }));
        }
        expect(yield* writeGroup(writer, groupIntent('group-create-2', '78', 'VIP', routes.group.route))).toMatchObject(
          denied,
        );
        expect(
          yield* ensureProfile(writer, profileSource('profile-create-2', 'C-2', routes.profile.route)),
        ).toMatchObject(denied);
        expect(
          yield* applyMembership(writer, {
            ...membership,
            source: { ...membership.source, effectId: 'membership-assign-2' },
          }),
        ).toMatchObject(denied);
        expect(yield* authorizeAddress(writer, 'address-add-2')).toMatchObject(denied);
        expect(yield* readGroup(reader, group, routes.group.route, 'CURRENT')).toMatchObject(denied);
      }),
    ).pipe(Effect.provide(services)),
);
