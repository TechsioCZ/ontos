import { randomUUID } from 'node:crypto';
import { runAction, makeActiveApplicationCompositionService } from '@app/core-runtime';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { eq } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Effect, Layer, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import {
  ConfigureCustomerSourceRoutePayloadSchema,
  ConfigureCustomerSourceRouteResultSchema,
} from '../../shared/actions/configure-customer-source-route.ts';
import { CreateCustomerGroupPayloadSchema } from '../../shared/actions/create-customer-group.ts';
import { CustomerGroupDefinitionSourceRejected } from '../../shared/domain/group-contract.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { configureCustomerSourceRouteAction } from '../../src/actions/configure-customer-source-route.action.ts';
import { createCustomerGroupAction } from '../../src/actions/create-customer-group.action.ts';
import {
  commerceCustomerContextRelations,
  customerGroupDefinitionSourceRoutes,
  customerGroupMembershipSourceRoutes,
  customerProfileSourceRoutes,
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

it.live('establishes source route authority only through the owner Action and the source write then succeeds', () =>
  Effect.scoped(
    Effect.gen(function* governedSourceRoute() {
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
      // The admin connection only observes; no route, grant or proof is written outside the owner Action.
      const admin = yield* makeWithDefaults({ relations: commerceCustomerContextRelations }).pipe(
        Effect.provide(adminContext),
      );
      const fixture = yield* Effect.acquireRelease(
        makeLiveOperationFixture({
          access: 'allowed',
          actionExecutor: 'manager-only',
          actionKeys: [
            configureCustomerSourceRouteAction.descriptor.actionKey,
            createCustomerGroupAction.descriptor.actionKey,
          ],
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
      const principal = { ...fixture.manager, legalEntityId: fixture.legalEntityId };
      const configure = (input: typeof ConfigureCustomerSourceRoutePayloadSchema.Encoded) =>
        Schema.decodeEffect(ConfigureCustomerSourceRoutePayloadSchema)(input).pipe(
          Effect.flatMap((payload) =>
            runAction({ payload, principal, registration: configureCustomerSourceRouteAction, transport: transport() }),
          ),
          Effect.provideContext(runtimeContext),
        );
      const resultOf = Schema.decodeSync(ConfigureCustomerSourceRouteResultSchema);

      // INTERNAL_CONTRACT only: these facts are not a claim about any external system's current payload.
      const source = {
        definitionEvidence: {
          kind: 'NAMED_CONFIGURATION' as const,
          reference: 'internal.ebs-explicit-classification',
          revision: '1',
        },
        effectId: 'group-create-1',
        issuer: 'internal-ebs',
        mappingRevision: '1',
        namespace: 'customer-groups',
        order: 1,
        recordId: '77',
        revision: '1',
        route: { id: 'internal-group-route', revision: '1' },
        sourceCode: 'LOYAL',
      };
      const create = (recordId: string, sourceCode: string, effectId: string) =>
        Schema.decodeUnknownEffect(CreateCustomerGroupPayloadSchema)({
          businessCode: `INTERNAL_${sourceCode}`,
          description: 'Source-managed fixture Group',
          initialState: 'ACTIVE',
          meaningKey: 'internal.ebs-explicit-classification',
          membershipCriteria: 'Explicit assignment by the internal EBS fixture',
          name: `Group ${sourceCode}`,
          purpose: 'Internal EBS classification',
          reason: 'Import source Group revision 1',
          source: { ...source, effectId, recordId, sourceCode },
        }).pipe(
          Effect.flatMap((payload) =>
            runAction({ payload, principal, registration: createCustomerGroupAction, transport: transport() }),
          ),
          Effect.provideContext(runtimeContext),
        );

      const denied = yield* Effect.flip(create('77', 'LOYAL', 'group-create-1'));
      expect(denied).toBeInstanceOf(CustomerGroupDefinitionSourceRejected);
      expect(denied).toMatchObject({ code: 'customer_group_source_authority_denied' });

      const writer = fixture.manager.principalId.toLowerCase();
      const groupRoute = {
        _tag: 'GROUP_DEFINITION' as const,
        active: true,
        issuer: source.issuer,
        mappingRevision: source.mappingRevision,
        namespace: source.namespace,
        principalId: writer,
        route: source.route,
      };
      // PostgreSQL renders a uuid in lower case, so an upper-case request stores the same principal.
      const [first, concurrent] = yield* Effect.all(
        [
          configure({ expected: null, reason: 'Bind the internal EBS Group route', route: groupRoute }),
          configure({
            expected: null,
            reason: 'Bind the internal EBS Group route',
            route: { ...groupRoute, principalId: writer.toUpperCase() },
          }),
        ],
        { concurrency: 2 },
      );
      const configuredGroup = resultOf({ _tag: 'CONFIGURED', route: groupRoute });
      const unchangedGroup = resultOf({ _tag: 'UNCHANGED', route: groupRoute });
      expect([first, concurrent]).toContainEqual(configuredGroup);
      expect([first, concurrent]).toContainEqual(unchangedGroup);
      expect(
        yield* admin
          .select()
          .from(customerGroupDefinitionSourceRoutes)
          .where(eq(customerGroupDefinitionSourceRoutes.tenantId, fixture.tenantId)),
      ).toEqual([
        {
          active: true,
          issuer: source.issuer,
          legalEntityId: fixture.legalEntityId,
          mappingRevision: source.mappingRevision,
          namespace: source.namespace,
          principalId: writer,
          routeId: source.route.id,
          routeRevision: source.route.revision,
          tenantId: fixture.tenantId,
        },
      ]);

      // The owner's own source write is now admitted through the configured route.
      expect((yield* create('77', 'LOYAL', 'group-create-1')).created).toBe(true);

      const pausedRoute = { ...groupRoute, active: false };
      const staleView = resultOf({ _tag: 'REJECTED', actual: groupRoute, reason: 'EXPECTATION_MISMATCH' });
      expect(yield* configure({ expected: null, reason: 'Stale operator view', route: pausedRoute })).toEqual(
        staleView,
      );
      const otherEntry = { ...groupRoute, route: { id: 'another-group-route', revision: '1' } };
      expect(yield* configure({ expected: otherEntry, reason: 'Wrong registry entry', route: pausedRoute })).toEqual(
        staleView,
      );
      const otherIssuer = resultOf({ _tag: 'REJECTED', actual: groupRoute, reason: 'SOURCE_IDENTITY_IMMUTABLE' });
      expect(
        yield* configure({
          expected: groupRoute,
          reason: 'Point the route at another issuer',
          route: { ...groupRoute, issuer: 'another-ebs' },
        }),
      ).toEqual(otherIssuer);
      const paused = resultOf({ _tag: 'CONFIGURED', route: pausedRoute });
      expect(
        yield* configure({ expected: groupRoute, reason: 'Pause the internal EBS Group route', route: pausedRoute }),
      ).toEqual(paused);
      const pausedWrite = yield* Effect.flip(create('78', 'VIP', 'group-create-2'));
      expect(pausedWrite).toMatchObject({ code: 'customer_group_source_authority_denied' });

      const profileRoute = {
        _tag: 'PROFILE' as const,
        active: true,
        issuer: 'internal-ebs',
        mappingRevision: '1',
        namespace: 'customers',
        principalId: writer,
        recordType: 'customer',
        route: { id: 'internal-profile-route', revision: '1' },
        sourceReaderPrincipalIds: [writer],
      };
      const membershipRoute = {
        _tag: 'MEMBERSHIP' as const,
        active: true,
        allowComplete: true,
        completenessContract: {
          coverage: 'ALL_GROUP_MEMBERSHIPS_FOR_EXACT_PROFILE' as const,
          ref: 'internal-completeness-contract',
          revision: '1',
        },
        issuer: 'internal-ebs',
        principalId: writer,
        route: { id: 'internal-membership-route', revision: '1' },
        sourceNamespace: 'customer-group-memberships',
      };
      const addressRoute = {
        _tag: 'SAVED_ADDRESS' as const,
        active: true,
        issuer: 'internal-ebs',
        mappingRevision: '1',
        namespace: 'customer-addresses',
        principalId: writer,
        recordType: 'address',
        route: { id: 'internal-address-route', revision: '1' },
      };
      for (const route of [profileRoute, membershipRoute, addressRoute]) {
        const configured = resultOf({ _tag: 'CONFIGURED', route });
        const unchanged = resultOf({ _tag: 'UNCHANGED', route });
        expect(yield* configure({ expected: null, reason: 'Bind the internal EBS route', route })).toEqual(configured);
        expect(yield* configure({ expected: null, reason: 'Retry the same binding', route })).toEqual(unchanged);
      }
      expect(
        yield* admin
          .select()
          .from(customerProfileSourceRoutes)
          .where(eq(customerProfileSourceRoutes.tenantId, fixture.tenantId)),
      ).toEqual([
        {
          active: true,
          issuer: 'internal-ebs',
          legalEntityId: fixture.legalEntityId,
          mappingRevision: '1',
          namespace: 'customers',
          principalId: writer,
          recordType: 'customer',
          routeId: 'internal-profile-route',
          routeRevision: '1',
          sourceReaderPrincipalIds: [writer],
          tenantId: fixture.tenantId,
        },
      ]);
      expect(
        yield* admin
          .select()
          .from(customerGroupMembershipSourceRoutes)
          .where(eq(customerGroupMembershipSourceRoutes.tenantId, fixture.tenantId)),
      ).toEqual([
        {
          active: true,
          allowComplete: true,
          completenessContractCoverage: 'ALL_GROUP_MEMBERSHIPS_FOR_EXACT_PROFILE',
          completenessContractRef: 'internal-completeness-contract',
          completenessContractRevision: '1',
          issuer: 'internal-ebs',
          legalEntityId: fixture.legalEntityId,
          principalId: writer,
          routeId: 'internal-membership-route',
          routeRevision: '1',
          sourceNamespace: 'customer-group-memberships',
          tenantId: fixture.tenantId,
        },
      ]);
      expect(
        yield* admin
          .select()
          .from(savedAddressSourceRoutes)
          .where(eq(savedAddressSourceRoutes.tenantId, fixture.tenantId)),
      ).toEqual([
        {
          active: true,
          issuer: 'internal-ebs',
          legalEntityId: fixture.legalEntityId,
          mappingRevision: '1',
          namespace: 'customer-addresses',
          principalId: writer,
          recordType: 'address',
          routeRef: 'internal-address-route',
          routeRevision: '1',
          tenantId: fixture.tenantId,
        },
      ]);
      const withdrawn = {
        ...membershipRoute,
        allowComplete: false,
        completenessContract: null,
        route: { id: 'internal-membership-route', revision: '2' },
      };
      const revised = resultOf({ _tag: 'CONFIGURED', route: withdrawn });
      expect(
        yield* configure({
          expected: membershipRoute,
          reason: 'Withdraw the completeness qualification',
          route: withdrawn,
        }),
      ).toEqual(revised);
    }),
  ).pipe(Effect.provide(services)),
);
