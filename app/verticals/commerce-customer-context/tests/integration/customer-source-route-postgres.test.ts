import { randomUUID } from 'node:crypto';
import { runAction, makeActiveApplicationCompositionService } from '@app/core-runtime';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { and, asc, eq, sql } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Array as EffectArray, DateTime, Effect, Exit, Layer, Order, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { accessWorkloadBindings, principals, tenants } from '../../../../packages/core-runtime/src/db/schema.ts';
import {
  ConfigureCustomerSourceRoutePayloadSchema,
  ConfigureCustomerSourceRouteResultSchema,
} from '../../shared/actions/configure-customer-source-route.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { configureCustomerSourceRouteAction } from '../../src/actions/configure-customer-source-route.action.ts';
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
const SOURCE_WRITE = 'commerce.customer-context.source-write';
const SOURCE_READ = 'commerce.customer-context.source-read';

/**
 * One disposable owner database with a live human administrator and the Core enrollment a real Tenant holds for
 * Commerce source traffic: one system principal bound to the source-write workload and two integration
 * principals bound to the source-read workload. Nothing else is granted.
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
  const runtimeContext = yield* Layer.build(fixture.layer);
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
  const configure = (input: typeof ConfigureCustomerSourceRoutePayloadSchema.Encoded) =>
    Schema.decodeEffect(ConfigureCustomerSourceRoutePayloadSchema)(input).pipe(
      Effect.flatMap((payload) =>
        runAction({ payload, principal, registration: configureCustomerSourceRouteAction, transport: transport() }),
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
        const [row] = yield* transaction.execute<{ readonly outcome: string; readonly result?: unknown }>(
          statement,
          'objects',
        );
        return row;
      }),
    );
  return {
    admin,
    bindWorkload,
    configure,
    core,
    enroll,
    fixture,
    legalEntityId,
    owner,
    reader,
    secondReader,
    tenantId,
    writer,
  };
});

// INTERNAL_CONTRACT only: these facts are not a claim about any external system's current payload.
const groupRoute = (principalId: string) => ({
  _tag: 'GROUP_DEFINITION' as const,
  active: true,
  issuer: 'internal-ebs',
  mappingRevision: '1',
  namespace: 'customer-groups',
  principalId,
  route: { id: 'internal-group-route', revision: '1' },
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
          reader,
          secondReader,
          tenantId,
          writer,
        } = yield* setup();
        const ineligible = resultOf({ _tag: 'REJECTED', currentGeneration: null, reason: 'PRINCIPAL_INELIGIBLE' });

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
          expect(yield* configure({ expectedGeneration: null, reason: bind, route: groupRoute(candidate) })).toEqual(
            ineligible,
          );
        }
        // A Profile reader must be an integration principal of this Tenant bound to the source-read workload.
        for (const readers of [[writer], [fixture.manager.principalId], [reader, randomUUID()]]) {
          expect(
            yield* configure({ expectedGeneration: null, reason: bind, route: profileRoute(writer, readers) }),
          ).toEqual(ineligible);
        }
        expect(yield* admin.select().from(customerSourceRouteHistory)).toEqual([]);

        // PostgreSQL renders a uuid in lower case, so an upper-case request stores the same principal.
        const route = groupRoute(writer);
        const [first, concurrent] = yield* Effect.all(
          [
            configure({ expectedGeneration: null, reason: bind, route }),
            configure({
              expectedGeneration: null,
              reason: bind,
              route: { ...route, principalId: writer.toUpperCase() },
            }),
          ],
          { concurrency: 2 },
        );
        expect([first, concurrent]).toContainEqual(resultOf({ _tag: 'CONFIGURED', generation: 1, route }));
        expect([first, concurrent]).toContainEqual(resultOf({ _tag: 'UNCHANGED', generation: 1, route }));

        const paused = { ...route, active: false };
        expect(yield* configure({ expectedGeneration: null, reason: 'Stale operator view', route: paused })).toEqual(
          resultOf({ _tag: 'REJECTED', currentGeneration: 1, reason: 'EXPECTATION_MISMATCH' }),
        );
        expect(
          yield* configure({
            expectedGeneration: 1,
            reason: 'Another issuer',
            route: { ...route, issuer: 'another-ebs' },
          }),
        ).toEqual(resultOf({ _tag: 'REJECTED', currentGeneration: 1, reason: 'SOURCE_IDENTITY_IMMUTABLE' }));
        expect(yield* configure({ expectedGeneration: 1, reason: 'Pause', route: paused })).toEqual(
          resultOf({ _tag: 'CONFIGURED', generation: 2, route: paused }),
        );
        expect(yield* configure({ expectedGeneration: 2, reason: 'Resume', route })).toEqual(
          resultOf({ _tag: 'CONFIGURED', generation: 3, route }),
        );
        // A -> B -> A: the route equals what generation 1 stored, yet a decision taken against generation 1 is stale.
        expect(yield* configure({ expectedGeneration: 1, reason: 'Late pause', route: paused })).toEqual(
          resultOf({ _tag: 'REJECTED', currentGeneration: 3, reason: 'EXPECTATION_MISMATCH' }),
        );

        // The routine refuses a Legal Entity other than the one its transaction is scoped to.
        const otherEntity = yield* owner(
          sql`select * from commerce_customer_context.configure_customer_source_route(${tenantId}::uuid,${randomUUID()}::uuid,${json(
            {
              actingPrincipalId: fixture.manager.principalId,
              actionInvocationId: randomUUID(),
              expectedGeneration: 3,
              principalsEligible: true,
              reason: 'Wrong Legal Entity',
              route: paused,
            },
          )}::jsonb)`,
        ).pipe(Effect.exit);
        expect(Exit.isFailure(otherEntity)).toBe(true);

        // Once Core revokes the writer's enrollment, the stored route can still be paused but never resumed.
        yield* core
          .update(accessWorkloadBindings)
          .set({ revokedAt: DateTime.toDateUtc(yield* DateTime.now), status: 'revoked' })
          .where(and(eq(accessWorkloadBindings.tenantId, tenantId), eq(accessWorkloadBindings.principalId, writer)));
        expect(yield* configure({ expectedGeneration: 3, reason: 'Resume without enrollment', route })).toEqual(
          resultOf({ _tag: 'REJECTED', currentGeneration: 3, reason: 'PRINCIPAL_INELIGIBLE' }),
        );
        expect(yield* configure({ expectedGeneration: 3, reason: 'Pause the revoked writer', route: paused })).toEqual(
          resultOf({ _tag: 'CONFIGURED', generation: 4, route: paused }),
        );

        const history = yield* admin
          .select()
          .from(customerSourceRouteHistory)
          .where(eq(customerSourceRouteHistory.tenantId, tenantId))
          .orderBy(asc(customerSourceRouteHistory.generation));
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
            { currentRoute: paused, generation: 4, previousRoute: route, reason: 'Pause the revoked writer' },
          ].map((entry) => ({ ...entry, routeId: route.route.id, routeKind: route._tag })),
        );
        expect(new Set(history.map(({ actingPrincipalId }) => actingPrincipalId))).toEqual(
          new Set([fixture.manager.principalId]),
        );
        expect(new Set(history.map(({ actionInvocationId }) => actionInvocationId)).size).toBe(4);
        expect(
          yield* admin
            .select()
            .from(customerGroupDefinitionSourceRoutes)
            .where(eq(customerGroupDefinitionSourceRoutes.tenantId, tenantId)),
        ).toEqual([
          {
            active: false,
            generation: 4,
            issuer: route.issuer,
            legalEntityId,
            mappingRevision: route.mappingRevision,
            namespace: route.namespace,
            principalId: writer,
            routeId: route.route.id,
            routeRevision: route.route.revision,
            tenantId,
          },
        ]);
        const rewritten = yield* admin
          .update(customerSourceRouteHistory)
          .set({ reason: 'Rewritten' })
          .where(eq(customerSourceRouteHistory.tenantId, tenantId))
          .pipe(Effect.exit);
        expect(Exit.isFailure(rewritten)).toBe(true);

        // Core enrolls the writer again for the remaining routes.
        yield* bindWorkload(tenantId, writer, SOURCE_WRITE);
        // A route stored before this Action existed may lack its mapping revision. It is repaired against its stored
        // generation with the mapping revision the administrator supplies; the owner never invents one.
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
        const legacy = { ...paused, route: { id: 'legacy-group-route', revision: '1' } };
        expect(yield* configure({ expectedGeneration: null, reason: 'Repair', route: legacy })).toEqual(
          resultOf({ _tag: 'REJECTED', currentGeneration: 1, reason: 'EXPECTATION_MISMATCH' }),
        );
        expect(
          yield* configure({ expectedGeneration: 1, reason: 'Repair with the agreed mapping', route: legacy }),
        ).toEqual(resultOf({ _tag: 'CONFIGURED', generation: 2, route: legacy }));
        const [repaired] = yield* admin
          .select()
          .from(customerSourceRouteHistory)
          .where(
            and(
              eq(customerSourceRouteHistory.tenantId, tenantId),
              eq(customerSourceRouteHistory.routeId, 'legacy-group-route'),
            ),
          );
        expect(repaired).toMatchObject({
          currentRoute: legacy,
          generation: 2,
          previousRoute: { ...legacy, active: true, mappingRevision: null },
        });

        // The other three registries: Profile readers are a set, and no route ever moves to another source.
        const readers = EffectArray.sort([reader, secondReader], Order.String);
        const profile = profileRoute(writer, readers);
        expect(
          yield* configure({
            expectedGeneration: null,
            reason: bind,
            route: profileRoute(writer, EffectArray.reverse(readers)),
          }),
        ).toEqual(resultOf({ _tag: 'CONFIGURED', generation: 1, route: profile }));
        expect(
          yield* configure({ expectedGeneration: null, reason: 'Same readers, another order', route: profile }),
        ).toEqual(resultOf({ _tag: 'UNCHANGED', generation: 1, route: profile }));
        for (const other of [membershipRoute(writer), addressRoute(writer)]) {
          expect(yield* configure({ expectedGeneration: null, reason: bind, route: other })).toEqual(
            resultOf({ _tag: 'CONFIGURED', generation: 1, route: other }),
          );
        }
        for (const moved of [
          { ...membershipRoute(writer), sourceNamespace: 'other-memberships' },
          { ...profile, recordType: 'contact' },
          { ...addressRoute(writer), recordType: 'contact' },
        ]) {
          expect(yield* configure({ expectedGeneration: 1, reason: 'Move the source', route: moved })).toEqual(
            resultOf({ _tag: 'REJECTED', currentGeneration: 1, reason: 'SOURCE_IDENTITY_IMMUTABLE' }),
          );
        }
        const [storedProfile] = yield* admin
          .select()
          .from(customerProfileSourceRoutes)
          .where(eq(customerProfileSourceRoutes.tenantId, tenantId));
        expect(storedProfile).toMatchObject({ generation: 1, principalId: writer, sourceReaderPrincipalIds: readers });
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

it.live(
  'keeps an effect committed before its route was paused or revised recoverable, and denies every fresh write',
  () =>
    Effect.scoped(
      Effect.gen(function* recoverableSourceEffects() {
        const { configure, legalEntityId, owner, reader, secondReader, tenantId, writer } = yield* setup();
        const route = groupRoute(writer);
        const groupIntent = (effectId: string, recordId: string, sourceCode: string, sourceRoute = route.route) => ({
          businessCode: `INTERNAL_${sourceCode}`,
          description: 'Source-managed fixture Group',
          initialState: 'ACTIVE',
          // Each source Group is a distinct definition, so no fresh write is refused as a semantic duplicate.
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
            issuer: route.issuer,
            mappingRevision: route.mappingRevision,
            namespace: route.namespace,
            order: 1,
            recordId,
            revision: '1',
            route: sourceRoute,
            sourceCode,
          },
        });
        type GroupIntent = ReturnType<typeof groupIntent>;
        // The owner routines the Group Actions and the Group source Read run, as the enrolled source writer.
        const writeGroup = (intent: GroupIntent) =>
          owner(
            sql`select outcome from commerce_customer_context.apply_customer_group_definition_source(${tenantId}::uuid,${legalEntityId}::uuid,'CREATE',${json(intent)}::jsonb,now(),${writer}::uuid,${randomUUID()}::uuid)`,
          );
        const readGroup = (principalId: string, intent: GroupIntent, mode: 'CURRENT' | 'RECEIPT') =>
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
                route: intent.source.route,
              },
            )}::jsonb)`,
          );

        const committed = groupIntent('group-create-1', '77', 'LOYAL');
        expect(yield* writeGroup(committed)).toMatchObject({ outcome: 'SOURCE_AUTHORITY_DENIED' });
        expect(yield* configure({ expectedGeneration: null, reason: bind, route })).toMatchObject({ generation: 1 });
        // The effect commits and its reply is lost; then the route is paused.
        expect(yield* writeGroup(committed)).toMatchObject({ outcome: 'CREATED' });
        expect(
          yield* configure({ expectedGeneration: 1, reason: 'Pause', route: { ...route, active: false } }),
        ).toMatchObject({ generation: 2 });
        const recovered = yield* readGroup(writer, committed, 'RECEIPT');
        expect(recovered).toMatchObject({
          outcome: 'FOUND',
          result: { _tag: 'RECEIPT', created: true, operation: 'CREATE' },
        });
        expect(yield* writeGroup(groupIntent('group-create-2', '78', 'VIP'))).toMatchObject({
          outcome: 'SOURCE_AUTHORITY_DENIED',
        });
        expect(yield* readGroup(writer, committed, 'CURRENT')).toMatchObject({ outcome: 'SOURCE_AUTHORITY_DENIED' });
        expect(yield* readGroup(reader, committed, 'RECEIPT')).toMatchObject({ outcome: 'SOURCE_AUTHORITY_DENIED' });
        // Revised: revision 2 supersedes revision 1. The revision 1 effect stays recoverable; revision 1 admits nothing new.
        const revised = { ...route, route: { id: route.route.id, revision: '2' } };
        expect(yield* configure({ expectedGeneration: 2, reason: 'Revise', route: revised })).toMatchObject({
          generation: 3,
        });
        expect(yield* readGroup(writer, committed, 'RECEIPT')).toEqual(recovered);
        expect(yield* writeGroup(groupIntent('group-create-3', '79', 'GOLD'))).toMatchObject({
          outcome: 'SOURCE_AUTHORITY_DENIED',
        });
        expect(yield* writeGroup(groupIntent('group-create-4', '80', 'SILVER', revised.route))).toMatchObject({
          outcome: 'CREATED',
        });

        // The other registries: a paused route denies its fresh source write but still admits the recovery read.
        const profile = profileRoute(writer, [reader]);
        const membership = membershipRoute(writer);
        const address = addressRoute(writer);
        for (const other of [profile, membership, address]) {
          expect(yield* configure({ expectedGeneration: null, reason: bind, route: other })).toMatchObject({
            generation: 1,
          });
        }
        const profileSource = {
          effectId: 'profile-1',
          issuer: profile.issuer,
          mappingRevision: profile.mappingRevision,
          namespace: profile.namespace,
          recordId: 'C1',
          recordType: profile.recordType,
          route: profile.route,
        };
        const ensureProfile = () =>
          owner(
            sql`select outcome from commerce_customer_context.ensure_source_customer_profile(${tenantId}::uuid,${legalEntityId}::uuid,${writer}::uuid,${randomUUID()}::uuid,now(),${json(
              { payload: { source: profileSource }, profileKind: 'RETAIL', proof: { partyResourceId: randomUUID() } },
            )}::jsonb)`,
          );
        const readProfile = (principalId: string, mode: 'CURRENT' | 'RECEIPT') =>
          owner(
            sql`select outcome from commerce_customer_context.read_customer_profile_source(${tenantId}::uuid,${legalEntityId}::uuid,${principalId}::uuid,${json(
              { ...profileSource, mode },
            )}::jsonb)`,
          );
        const membershipQuery = {
          effectId: 'membership-1',
          manager: {
            factFamily: 'CUSTOMER_GROUP_MEMBERSHIP',
            issuer: membership.issuer,
            sourceNamespace: membership.sourceNamespace,
            tenantId,
          },
          profile: { profileKind: 'RETAIL', profileRef: { resourceId: randomUUID(), tenantId } },
          route: membership.route,
        };
        const writeMembership = () =>
          owner(
            sql`select outcome from commerce_customer_context.apply_customer_group_membership_source(${tenantId}::uuid,${legalEntityId}::uuid,${writer}::uuid,${randomUUID()}::uuid,now(),${json(
              { ...membershipQuery, source: { effectId: membershipQuery.effectId } },
            )}::jsonb)`,
          );
        const recoverMembership = () =>
          owner(
            sql`select outcome from commerce_customer_context.read_customer_group_membership_source_receipt(${tenantId}::uuid,${legalEntityId}::uuid,${writer}::uuid,${json(
              membershipQuery,
            )}::jsonb)`,
          );
        const addressInput = (mode: 'CURRENT' | 'RECEIPT') => ({
          actionInvocationId: randomUUID(),
          actionKey: 'commerce.customer-context.add-saved-address',
          mode,
          profile: { kind: 'RETAIL', profileRef: { resourceId: randomUUID(), tenantId } },
          requestHash: '0'.repeat(64),
          source: {
            effectId: 'address-1',
            identity: {
              issuer: address.issuer,
              namespace: address.namespace,
              recordId: 'A1',
              recordType: address.recordType,
              routeRef: address.route.id,
            },
            mappingRevision: address.mappingRevision,
            routeRevision: address.route.revision,
          },
        });
        const authorizeAddress = () =>
          owner(
            sql`select outcome from commerce_customer_context.authorize_saved_address_source(${tenantId}::uuid,${legalEntityId}::uuid,${writer}::uuid,${randomUUID()}::uuid,'commerce.customer-context.add-saved-address',${'0'.repeat(64)},${json(
              addressInput('RECEIPT'),
            )}::jsonb)`,
          );
        const readAddress = (mode: 'CURRENT' | 'RECEIPT') =>
          owner(
            sql`select outcome from commerce_customer_context.read_saved_address_source_receipt(${tenantId}::uuid,${legalEntityId}::uuid,${writer}::uuid,${writer}::uuid,null,${json(
              addressInput(mode),
            )}::jsonb)`,
          );

        // While active, each route admits its source write up to the missing target.
        expect(yield* readProfile(writer, 'CURRENT')).toMatchObject({ outcome: 'AVAILABLE' });
        expect(yield* writeMembership()).toMatchObject({ outcome: 'TARGET_NOT_FOUND' });
        expect(yield* authorizeAddress()).toMatchObject({ outcome: 'TARGET_INELIGIBLE' });
        for (const other of [profile, membership, address]) {
          expect(
            yield* configure({ expectedGeneration: 1, reason: 'Pause', route: { ...other, active: false } }),
          ).toMatchObject({ generation: 2 });
        }
        expect(yield* ensureProfile()).toMatchObject({ outcome: 'SOURCE_AUTHORITY_DENIED' });
        expect(yield* writeMembership()).toMatchObject({ outcome: 'SOURCE_AUTHORITY_DENIED' });
        expect(yield* authorizeAddress()).toMatchObject({ outcome: 'SOURCE_AUTHORITY_DENIED' });
        expect(yield* readProfile(writer, 'CURRENT')).toMatchObject({ outcome: 'SOURCE_AUTHORITY_DENIED' });
        expect(yield* readAddress('CURRENT')).toMatchObject({ outcome: 'SOURCE_AUTHORITY_DENIED' });
        // Recovery passes the route and finds no receipt for these never-committed effects.
        expect(yield* readProfile(writer, 'RECEIPT')).toMatchObject({ outcome: 'NOT_FOUND' });
        expect(yield* readProfile(reader, 'RECEIPT')).toMatchObject({ outcome: 'NOT_FOUND' });
        expect(yield* readProfile(secondReader, 'RECEIPT')).toMatchObject({ outcome: 'SOURCE_AUTHORITY_DENIED' });
        expect(yield* recoverMembership()).toMatchObject({ outcome: 'TARGET_NOT_FOUND' });
        expect(yield* readAddress('RECEIPT')).toMatchObject({ outcome: 'NOT_FOUND' });
      }),
    ).pipe(Effect.provide(services)),
);
