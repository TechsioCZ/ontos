import { randomUUID } from 'node:crypto';
import { ReadRuntime, ReadPermissionDenied, loadDatabaseConnectionPair, runAction } from '@app/core-runtime';
import { makeLiveOperationFixture } from '@app/core-runtime/testing/actions';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { makeIsolatedNativeDatabaseFixture } from '@app/core-runtime/testing/isolated-native-database';
import { NodeChildProcessSpawner, NodeCrypto, NodeServices } from '@effect/platform-node';
import { PgClient } from '@effect/sql-pg';
import { eq, sql } from 'drizzle-orm';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Context, Effect, Layer, Match, Redacted, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';
import { CreateCustomerGroupPayloadSchema } from '../../shared/actions/create-customer-group.ts';
import { UpdateCustomerGroupPayloadSchema } from '../../shared/actions/update-customer-group.ts';
import { CustomerGroupDefinitionSourceRejected } from '../../shared/domain/group-contract.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { createCustomerGroupAction } from '../../src/actions/create-customer-group.action.ts';
import { updateCustomerGroupAction } from '../../src/actions/update-customer-group.action.ts';
import { customerGroupDefinitionSourceRead } from '../../src/api/customer-group-definition-source.read.ts';
import type { CustomerGroupDefinitionSourceRequest } from '../../shared/apis/customer-group-definition-source.ts';
import {
  commerceCustomerContextRelations,
  customerGroupDefinitionSourceRoutes,
  customerGroupDefinitionSourceReceipts,
  customerGroupDefinitionSourceBindings,
  customerGroupRevisions,
  customerGroups,
} from '../../src/database/schema.ts';
import { commerceCustomerContextRegistration } from '../../vertical.registration.ts';
import {
  seedCustomerGroupSourceAuthority,
  CustomerGroupSourceAuthorityFixtureUnavailable,
} from '../../src/testing/customer-group-source-authority.ts';
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

it.live('commits and recovers source Group definitions through the registered owner Actions', () =>
  Effect.scoped(
    Effect.gen(function* nativeSourceGroupDefinitions() {
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
      const coreEvidence = yield* testCoreDatabase.pipe(Effect.provide(adminContext));
      const fixture = yield* Effect.acquireRelease(
        makeLiveOperationFixture({
          access: 'allowed',
          actionExecutor: 'manager-only',
          actionKeys: [createCustomerGroupAction.descriptor.actionKey, updateCustomerGroupAction.descriptor.actionKey],
          adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
          allowedAudiences: ['commerce-customer-context'],
          applicationComposition: { load: Effect.succeed(snapshot) },
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

      // INTERNAL_CONTRACT only: these facts are not a claim about Symmy's current payload.
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
      const payload = yield* Schema.decodeUnknownEffect(CreateCustomerGroupPayloadSchema)({
        businessCode: 'INTERNAL_LOYAL',
        description: 'Source-managed fixture Group',
        initialState: 'ACTIVE',
        meaningKey: 'internal.ebs-explicit-classification',
        membershipCriteria: 'Explicit assignment by the internal EBS fixture',
        name: 'Loyal customers',
        purpose: 'Internal EBS classification',
        reason: 'Import source Group revision 1',
        source,
      });
      const readSource = (input: CustomerGroupDefinitionSourceRequest) =>
        Context.get(runtimeContext, ReadRuntime)
          .runRead({
            input,
            principal,
            registration: customerGroupDefinitionSourceRead,
            transport: { correlationId: randomUUID(), targetModuleKey: 'commerce.customer-context' },
          })
          .pipe(Effect.provideContext(runtimeContext));
      const create = (input = payload) =>
        runAction({ payload: input, principal, registration: createCustomerGroupAction, transport: transport() }).pipe(
          Effect.provideContext(runtimeContext),
        );
      const denied = yield* Effect.flip(create());
      expect(denied).toBeInstanceOf(CustomerGroupDefinitionSourceRejected);
      expect(denied).toMatchObject({
        code: 'customer_group_source_authority_denied',
      });
      const fixturePurposeRejected = yield* Effect.flip(
        seedCustomerGroupSourceAuthority({
          adminConnectionString: Redacted.make(isolated.connections.admin.connectionString),
          fixture: isolated,
          operatorPrincipalId: fixture.manager.principalId,
          operatorProviderUserId: 'not-read-for-wrong-purpose',
          route: {
            active: true,
            issuer: source.issuer,
            legalEntityId: fixture.legalEntityId,
            mappingRevision: source.mappingRevision,
            namespace: source.namespace,
            principalId: fixture.manager.principalId,
            routeId: source.route.id,
            routeRevision: source.route.revision,
            tenantId: fixture.tenantId,
          },
        }),
      );
      expect(fixturePurposeRejected).toBeInstanceOf(CustomerGroupSourceAuthorityFixtureUnavailable);
      expect(yield* admin.select().from(customerGroupDefinitionSourceRoutes)).toHaveLength(0);
      yield* admin.insert(customerGroupDefinitionSourceRoutes).values({
        active: true,
        issuer: source.issuer,
        legalEntityId: fixture.legalEntityId,
        mappingRevision: source.mappingRevision,
        namespace: source.namespace,
        principalId: fixture.manager.principalId,
        routeId: source.route.id,
        routeRevision: source.route.revision,
        tenantId: fixture.tenantId,
      });
      const absent = yield* readSource({
        issuer: source.issuer,
        mappingRevision: source.mappingRevision,
        mode: 'CURRENT',
        namespace: source.namespace,
        recordId: source.recordId,
        route: source.route,
      });
      expect(
        Match.value(absent).pipe(
          Match.tag('ABSENT', () => true),
          Match.orElse(() => false),
        ),
      ).toBe(true);
      const [first, retry] = yield* Effect.all([create(), create()], { concurrency: 2 });
      expect(first.group.groupRef).toEqual(retry.group.groupRef);
      expect([first.created, retry.created].filter(Boolean)).toHaveLength(1);
      const original = first.created ? first : retry;
      const updatePayload = yield* Schema.decodeUnknownEffect(UpdateCustomerGroupPayloadSchema)({
        description: payload.description,
        expectedRevision: 1,
        groupRef: original.group.groupRef,
        membershipCriteria: payload.membershipCriteria,
        name: 'Renamed loyal customers',
        purpose: payload.purpose,
        reason: 'Apply source cosmetic rename revision 2',
        source: { ...source, effectId: 'group-update-2', order: 2, revision: '2' },
      });
      const update = (input = updatePayload) =>
        runAction({ payload: input, principal, registration: updateCustomerGroupAction, transport: transport() }).pipe(
          Effect.provideContext(runtimeContext),
        );
      const renamed = yield* update();
      expect(renamed.group.groupRef).toEqual(original.group.groupRef);
      expect(renamed.group.meaningKey).toBe(original.group.meaningKey);
      expect(renamed.group.definitionHistory).toHaveLength(2);
      const current = yield* readSource({
        issuer: source.issuer,
        mappingRevision: source.mappingRevision,
        mode: 'CURRENT',
        namespace: source.namespace,
        recordId: source.recordId,
        route: source.route,
      });
      expect(current).toMatchObject({
        group: renamed.group,
        source: { order: 2, recordId: source.recordId, revision: '2' },
      });
      const receipt = yield* readSource({
        effectId: source.effectId,
        expectedIntent: payload,
        expectedOperation: 'CREATE',
        issuer: source.issuer,
        mappingRevision: source.mappingRevision,
        mode: 'RECEIPT',
        namespace: source.namespace,
        route: source.route,
      });
      expect(receipt).toMatchObject({
        created: true,
        group: original.group,
        operation: 'CREATE',
        originalIntent: payload,
        source,
      });
      const updateRetry = yield* update();
      expect(updateRetry).toEqual({ changed: false, group: renamed.group });
      const recoveredCreate = yield* create();
      expect(recoveredCreate).toEqual({ created: false, group: original.group });
      const conflict = yield* Effect.flip(create({ ...payload, name: 'Changed original intent' }));
      expect(conflict).toMatchObject({ code: 'customer_group_source_conflict' });
      const wrongRecoveredIntent = yield* Effect.flip(
        readSource({
          effectId: source.effectId,
          expectedIntent: { ...payload, name: 'Different original body' },
          expectedOperation: 'CREATE',
          issuer: source.issuer,
          mappingRevision: source.mappingRevision,
          mode: 'RECEIPT',
          namespace: source.namespace,
          route: source.route,
        }),
      );
      expect(wrongRecoveredIntent).toMatchObject({
        code: 'read_policy_denied',
        httpStatus: 409,
        policyReasonCode: 'customer_group_source_conflict',
      });
      const wrongMapping = yield* Effect.flip(
        create({
          ...payload,
          source: { ...source, effectId: 'unapproved-mapping-effect', mappingRevision: 'unapproved' },
        }),
      );
      expect(wrongMapping).toMatchObject({ code: 'customer_group_source_authority_denied' });
      const stale = yield* Effect.flip(
        update({ ...updatePayload, source: { ...source, effectId: 'late-old-revision', order: 0, revision: '0' } }),
      );
      expect(stale).toMatchObject({ code: 'customer_group_source_stale' });
      const staleTarget = yield* Effect.flip(
        update({ ...updatePayload, source: { ...source, effectId: 'stale-target-revision', order: 3, revision: '3' } }),
      );
      expect(staleTarget).toMatchObject({ code: 'customer_group_revision_conflict' });
      yield* admin.insert(customerGroupDefinitionSourceRoutes).values({
        active: true,
        issuer: 'other-internal-ebs',
        legalEntityId: fixture.legalEntityId,
        mappingRevision: source.mappingRevision,
        namespace: source.namespace,
        principalId: fixture.manager.principalId,
        routeId: 'other-group-route',
        routeRevision: '1',
        tenantId: fixture.tenantId,
      });
      const otherIssuer = yield* Effect.flip(
        create({
          ...payload,
          source: { ...source, issuer: 'other-internal-ebs', route: { id: 'other-group-route', revision: '1' } },
        }),
      );
      expect(otherIssuer).toMatchObject({ code: 'customer_group_source_conflict' });
      const changedMeaning = yield* Effect.flip(
        update({
          ...updatePayload,
          expectedRevision: 2,
          purpose: 'Different meaning',
          source: { ...source, effectId: 'group-update-3', order: 3, revision: '3' },
        }),
      );
      expect(changedMeaning).toMatchObject({ code: 'customer_group_definition_change_requires_new_group' });
      const noopPayload = {
        ...updatePayload,
        expectedRevision: 2,
        source: { ...source, effectId: 'group-noop-3', order: 3, revision: '3' },
      };
      const noop = yield* update(noopPayload);
      expect(noop).toEqual({ changed: false, group: renamed.group });
      const noopReceipt = yield* readSource({
        effectId: noopPayload.source.effectId,
        expectedIntent: noopPayload,
        expectedOperation: 'UPDATE',
        issuer: source.issuer,
        mappingRevision: source.mappingRevision,
        mode: 'RECEIPT',
        namespace: source.namespace,
        route: source.route,
      });
      expect(noopReceipt).toMatchObject({
        changed: false,
        group: renamed.group,
        operation: 'UPDATE',
        originalIntent: noopPayload,
      });
      const manualUpdate = {
        description: payload.description,
        expectedRevision: 2,
        groupRef: original.group.groupRef,
        membershipCriteria: payload.membershipCriteria,
        name: 'Manual takeover',
        purpose: payload.purpose,
        reason: 'Unproved manual takeover',
      };
      const blockedManual = yield* Effect.flip(
        runAction({
          payload: manualUpdate,
          principal,
          registration: updateCustomerGroupAction,
          transport: transport(),
        }).pipe(Effect.provideContext(runtimeContext)),
      );
      expect(blockedManual).toMatchObject({ code: 'customer_group_source_authority_denied' });
      yield* admin
        .update(customerGroupDefinitionSourceRoutes)
        .set({ active: false })
        .where(eq(customerGroupDefinitionSourceRoutes.tenantId, fixture.tenantId));
      const revokedRecovery = yield* Effect.flip(create());
      expect(revokedRecovery).toBeInstanceOf(CustomerGroupDefinitionSourceRejected);
      expect(revokedRecovery).toMatchObject({ code: 'customer_group_source_authority_denied' });
      const revokedRead = yield* Effect.flip(
        readSource({
          effectId: source.effectId,
          expectedIntent: payload,
          expectedOperation: 'CREATE',
          issuer: source.issuer,
          mappingRevision: source.mappingRevision,
          mode: 'RECEIPT',
          namespace: source.namespace,
          route: source.route,
        }),
      );
      expect(revokedRead).toBeInstanceOf(ReadPermissionDenied);
      const [receipts, bindings, revisions, groups] = yield* Effect.all(
        [
          admin
            .select()
            .from(customerGroupDefinitionSourceReceipts)
            .where(eq(customerGroupDefinitionSourceReceipts.tenantId, fixture.tenantId)),
          admin
            .select()
            .from(customerGroupDefinitionSourceBindings)
            .where(eq(customerGroupDefinitionSourceBindings.tenantId, fixture.tenantId)),
          admin.select().from(customerGroupRevisions).where(eq(customerGroupRevisions.tenantId, fixture.tenantId)),
          admin.select().from(customerGroups).where(eq(customerGroups.tenantId, fixture.tenantId)),
        ],
        { concurrency: 1 },
      );
      expect(receipts).toHaveLength(3);
      expect(bindings).toHaveLength(1);
      expect(revisions).toHaveLength(2);
      expect(groups).toHaveLength(1);
      expect(bindings[0]).toMatchObject({ sourceOrder: 3, sourceRevision: '3' });
      const evidence = yield* fixture.evidence(coreEvidence);
      expect(evidence.events.map(({ eventType }) => eventType)).toEqual([
        'commerce.customer-context.customer-group-created.v1',
        'commerce.customer-context.customer-group-updated.v1',
      ]);
      expect(evidence.outbox).toHaveLength(2);
      const [privileges] = yield* admin.execute<{ helper: boolean; raw: boolean }>(
        sql`select has_table_privilege('ontos_runtime','commerce_customer_context.customer_group_definition_source_receipts','SELECT') as raw, has_function_privilege('ontos_runtime','commerce_customer_context.update_customer_group_source_guarded(uuid,uuid,uuid,integer,text,text,text,text,text,timestamptz,uuid,uuid)','EXECUTE') as helper`,
        'objects',
      );
      expect(privileges).toEqual({ helper: false, raw: false });
      const other = { ...fixture.denied, legalEntityId: fixture.legalEntityId };
      const unboundPrincipal = yield* Effect.flip(
        runAction({ payload, principal: other, registration: createCustomerGroupAction, transport: transport() }).pipe(
          Effect.provideContext(runtimeContext),
        ),
      );
      expect(unboundPrincipal).toBeInstanceOf(CustomerGroupDefinitionSourceRejected);
      expect(unboundPrincipal).toMatchObject({ code: 'customer_group_source_authority_denied' });
      const { source: declaredSource, ...humanDefinition } = payload;
      expect(declaredSource).toEqual(source);
      const humanPayload = yield* Schema.decodeUnknownEffect(CreateCustomerGroupPayloadSchema)({
        ...humanDefinition,
        businessCode: 'INTERNAL_HUMAN',
        meaningKey: 'internal.human-classification',
        membershipCriteria: 'Explicit internal human classification',
        name: 'Human managed fixture Group',
        purpose: 'Human managed internal classification',
      });
      const humanCreated = yield* create(humanPayload);
      expect(humanCreated.created).toBe(true);
      const humanUpdate = yield* Schema.decodeUnknownEffect(UpdateCustomerGroupPayloadSchema)({
        description: humanPayload.description,
        expectedRevision: humanCreated.group.revision,
        groupRef: humanCreated.group.groupRef,
        membershipCriteria: humanPayload.membershipCriteria,
        name: 'Renamed human managed Group',
        purpose: humanPayload.purpose,
        reason: 'Authorized human classification rename',
      });
      expect((yield* update(humanUpdate)).changed).toBe(true);
      const finalEvidence = yield* fixture.evidence(coreEvidence);
      expect(finalEvidence.events).toHaveLength(4);
      expect(finalEvidence.outbox).toHaveLength(4);
      const active = yield* loadDatabaseConnectionPair({ envPath: '/dev/null' });
      expect(isolated.connections.admin.database).not.toBe(active.admin.database);
    }),
  ).pipe(Effect.provide(services)),
);
