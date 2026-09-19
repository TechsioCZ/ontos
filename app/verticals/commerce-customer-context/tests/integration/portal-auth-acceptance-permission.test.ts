import { randomUUID } from 'node:crypto';

import { v1 } from '@authzed/authzed-node';
import { eq, sql } from 'drizzle-orm';
import { Effect, Layer, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  GatewayAssertionRedemptionService,
  GatewayAssertionReplayError,
} from '../../../../packages/core-runtime/src/auth/gateway-assertion-redemption.ts';
import { makeCoreDatabase } from '../../../../packages/core-runtime/src/db/client.ts';
import { loadDatabaseConnectionPair } from '../../../../packages/core-runtime/src/db/config.ts';
import {
  dataAccessEvents,
  legalEntities,
  principalAuthBindings,
  principals,
  tenantModuleStates,
  tenants,
} from '../../../../packages/core-runtime/src/db/schema.ts';
import { loadSpiceDbConfig } from '../../../../packages/core-runtime/src/permissions/config.ts';
import {
  toBusinessPermissionAccessObjectId,
  toLegalEntityAccessObjectId,
} from '../../../../packages/core-runtime/src/permissions/context-access.ts';
import {
  makeCommerceCustomerContextApiRuntime,
  productionActionRuntimeLive,
  productionReadRuntimeLive,
} from '../../api/index.ts';
import { commercePortalAuthRealmUnavailableLive } from '../../api/portal-auth/realm-unavailable.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import { SavedAddressListForbiddenProblemSchema } from '../../shared/apis/saved-address-list.ts';
import {
  issueAcceptanceGatewayAssertion,
  makeAcceptanceGatewayIssuer,
} from '../support/enrollment-acceptance-identity-gateway-assertion.ts';
import type { AcceptanceGatewayIssuer } from '../support/enrollment-acceptance-identity-gateway-assertion.ts';

/**
 * A customer session that holds no business Permission for the profile it selects is answered
 * 403 problem+json, and nothing is written.
 *
 * Everything but the Bearer assertion's issuer is the deployed composition: the real read runtime,
 * the real operational-scope revalidation against `core`, and the real SpiceDB authorization. The
 * subject is granted Tenant membership and Legal Entity access in SpiceDB so the only gate left
 * open is the business Permission the profile selection needs — the denial under test.
 */

const ORIGIN = 'http://localhost:3020';
const AUDIENCE = 'commerce-customer-context';
const ISSUER = 'http://gateway.permission-acceptance.test';
/** The namespace the deployed composition registers, so the production registry is what answers. */
const NAMESPACE_ID = COMMERCE_AUTHENTICATION_NAMESPACE_ID;
const KEY_ID = 'permission-acceptance';

interface SeededSubject {
  readonly authBindingId: string;
  readonly legalEntityId: string;
  readonly principalId: string;
  readonly tenantId: string;
}

const seedCoreSubject = Effect.fnUntraced(function* seedCoreSubject() {
  const connections = yield* loadDatabaseConnectionPair();
  const admin = yield* makeCoreDatabase(connections.admin);
  const subject: SeededSubject = {
    authBindingId: randomUUID(),
    legalEntityId: randomUUID(),
    principalId: randomUUID(),
    tenantId: randomUUID(),
  };
  const cleanup = Effect.gen(function* removeSeededRows() {
    for (const table of [
      dataAccessEvents,
      principalAuthBindings,
      tenantModuleStates,
      legalEntities,
      principals,
      tenants,
    ]) {
      yield* admin.executor.delete(table).where(eq(table.tenantId, subject.tenantId));
    }
  });
  yield* Effect.acquireRelease(cleanup, () => cleanup.pipe(Effect.orDie));
  yield* admin.executor.insert(tenants).values({
    defaultLocale: 'en',
    name: 'Permission acceptance tenant',
    slug: `permission-acceptance-${subject.tenantId}`,
    status: 'active',
    tenantId: subject.tenantId,
  });
  yield* admin.executor.insert(principals).values({
    displayName: 'Permission acceptance customer',
    kind: 'human',
    principalId: subject.principalId,
    status: 'active',
    tenantId: subject.tenantId,
  });
  yield* admin.executor.insert(legalEntities).values({
    legalEntityId: subject.legalEntityId,
    legalName: 'Permission acceptance selling entity',
    registrationCountry: 'CZ',
    registrationNumber: `permission-acceptance-${subject.legalEntityId}`,
    status: 'active',
    tenantId: subject.tenantId,
  });
  yield* admin.executor.insert(tenantModuleStates).values({
    moduleKey: 'commerce.customer-context',
    state: 'active',
    tenantId: subject.tenantId,
  });
  yield* admin.executor.insert(principalAuthBindings).values({
    authenticationNamespaceId: NAMESPACE_ID,
    principalAuthBindingId: subject.authBindingId,
    principalId: subject.principalId,
    provider: 'commerce-acceptance-provider',
    providerSubjectId: `permission-acceptance-${subject.principalId}`,
    status: 'active',
    subjectType: 'user',
    tenantId: subject.tenantId,
  });
  return { admin, subject };
});

const requiredObjectId = (value: string | undefined, description: string): string => {
  if (value === undefined) {
    throw new Error(`${description} could not be encoded`);
  }
  return value;
};

/**
 * Tenant membership and Legal Entity access, and nothing else: the `business_permission` grant the
 * profile selection needs is deliberately absent, and is written only by the positive control below.
 */
const seedSpiceDbContext = Effect.fnUntraced(function* seedSpiceDbContext(subject: SeededSubject) {
  const configuration = yield* loadSpiceDbConfig();
  const client = v1.NewClient(
    configuration.preSharedKey,
    configuration.endpoint,
    configuration.insecureLocal ? v1.ClientSecurity.INSECURE_LOCALHOST_ALLOWED : v1.ClientSecurity.SECURE,
  );
  const principalSubject = v1.SubjectReference.create({
    object: v1.ObjectReference.create({ objectId: subject.principalId, objectType: 'principal' }),
  });
  const legalEntityObject = v1.ObjectReference.create({
    objectId: requiredObjectId(
      toLegalEntityAccessObjectId(subject.tenantId, subject.legalEntityId),
      'The Legal Entity access object',
    ),
    objectType: 'legal_entity',
  });
  const write = (operation: v1.RelationshipUpdate_Operation, relationships: readonly v1.Relationship[]) =>
    Effect.promise(
      async () =>
        await client.promises.writeRelationships(
          v1.WriteRelationshipsRequest.create({
            updates: relationships.map((relationship) => v1.RelationshipUpdate.create({ operation, relationship })),
          }),
        ),
    );
  const install = (relationships: readonly v1.Relationship[]) =>
    Effect.gen(function* installRelationships() {
      yield* write(v1.RelationshipUpdate_Operation.TOUCH, relationships);
      yield* Effect.addFinalizer(() =>
        write(v1.RelationshipUpdate_Operation.DELETE, relationships).pipe(Effect.asVoid, Effect.orDie),
      );
    });
  yield* install([
    v1.Relationship.create({
      relation: 'member',
      resource: v1.ObjectReference.create({ objectId: subject.tenantId, objectType: 'tenant' }),
      subject: principalSubject,
    }),
    v1.Relationship.create({
      relation: 'tenant',
      resource: legalEntityObject,
      subject: v1.SubjectReference.create({
        object: v1.ObjectReference.create({ objectId: subject.tenantId, objectType: 'tenant' }),
      }),
    }),
    v1.Relationship.create({
      relation: 'member',
      resource: legalEntityObject,
      subject: principalSubject,
    }),
  ]);
  return (counterpartyId: string) => {
    const businessPermissionObject = v1.ObjectReference.create({
      objectId: requiredObjectId(
        toBusinessPermissionAccessObjectId('counterparty.address_book.use', {
          counterpartyId,
          kind: 'counterparty',
          legalEntityId: subject.legalEntityId,
          tenantId: subject.tenantId,
        }),
        'The Counterparty address-book permission object',
      ),
      objectType: 'business_permission',
    });
    return install([
      v1.Relationship.create({
        relation: 'legal_entity',
        resource: businessPermissionObject,
        subject: v1.SubjectReference.create({ object: legalEntityObject }),
      }),
      v1.Relationship.create({
        relation: 'grantee',
        resource: businessPermissionObject,
        subject: principalSubject,
      }),
    ]);
  };
});

/** A redemption store that accepts each `jti` exactly once, as a deployed redemption store does. */
const singleUseRedemptionLive = Layer.sync(GatewayAssertionRedemptionService, () => {
  const consumed = new Set<string>();
  return {
    consume: ({ jti }) =>
      consumed.has(jti)
        ? Effect.fail(new GatewayAssertionReplayError({ reason: 'The Bearer assertion was already redeemed' }))
        : Effect.sync(() => {
            consumed.add(jti);
          }),
  };
});

const configuredRuntime = (gateway: AcceptanceGatewayIssuer) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      makeCommerceCustomerContextApiRuntime(
        productionReadRuntimeLive,
        productionActionRuntimeLive,
        singleUseRedemptionLive,
        commercePortalAuthRealmUnavailableLive([ORIGIN]),
        // The verification material is a composition input of the deployed verifier, so no ambient
        // environment is touched.
        gateway.verificationLive,
      ).createHandler(),
    ),
    (runtime) => Effect.promise(async () => await runtime.dispose()),
  );

it.live(
  'a profile selection without the exact business Permission is 403 and writes nothing',
  () =>
    Effect.scoped(
      Effect.gen(function* profileSelectionWithoutPermission() {
        const gateway = yield* makeAcceptanceGatewayIssuer(ISSUER, KEY_ID);
        const { admin, subject } = yield* seedCoreSubject();
        const grantAddressBookPermission = yield* seedSpiceDbContext(subject);
        const runtime = yield* configuredRuntime(gateway);
        const counterpartyId = randomUUID();

        const selectProfile = Effect.fnUntraced(function* selectProfile() {
          const assertion = yield* issueAcceptanceGatewayAssertion(admin.executor, gateway, AUDIENCE, {
            authBindingId: subject.authBindingId,
            authContextRef: `portal-session:${subject.authBindingId}`,
            authenticationNamespaceId: NAMESPACE_ID,
            authMethod: 'session',
            legalEntityId: subject.legalEntityId,
            principalId: subject.principalId,
            tenantId: subject.tenantId,
          });
          return yield* Effect.promise(
            async () =>
              await runtime.handler(
                new Request(`${ORIGIN}/reads/saved-address-list`, {
                  body: JSON.stringify({
                    profile: {
                      counterpartyRef: {
                        moduleId: 'party.registry',
                        resourceId: counterpartyId,
                        resourceType: 'party.registry.counterparty',
                        tenantId: subject.tenantId,
                      },
                      kind: 'COUNTERPARTY',
                      profileRef: {
                        moduleId: 'commerce.customer-context',
                        resourceId: randomUUID(),
                        resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
                        tenantId: subject.tenantId,
                      },
                    },
                  }),
                  headers: {
                    authorization: `Bearer ${assertion}`,
                    'content-type': 'application/json',
                    origin: ORIGIN,
                    'x-correlation-id': `permission-acceptance-${randomUUID()}`,
                  },
                  method: 'POST',
                }),
              ),
          );
        });

        const savedAddressRows = () =>
          admin.executor.execute<{ readonly saved_address_id: string }>(
            sql`
            select saved_address_id
              from commerce_customer_context.saved_addresses
             where tenant_id = ${subject.tenantId}::uuid
             order by saved_address_id
          `,
            'objects',
          );
        const addressesBefore = yield* savedAddressRows();

        const denied = yield* selectProfile();
        expect(denied.status).toBe(403);
        expect(denied.headers.get('content-type')).toContain('application/problem+json');
        const deniedProblem = yield* Effect.promise(async () => await denied.clone().json());
        expect(Schema.is(SavedAddressListForbiddenProblemSchema)(deniedProblem)).toBe(true);
        expect(deniedProblem).toMatchObject({
          detail: 'The principal is not permitted to perform this read.',
          status: 403,
          title: 'Read forbidden',
          type: 'https://ontos.dev/problems/read-forbidden',
        });

        // The denial is journalled as a denial and nothing is served: the access evidence names the
        // authorization stage and the SpiceDB check, and no business row moves.
        expect(
          yield* admin.executor
            .select({
              outcome: dataAccessEvents.outcome,
              outcomeCode: dataAccessEvents.outcomeCode,
              outcomeStage: dataAccessEvents.outcomeStage,
              resultCount: dataAccessEvents.resultCount,
            })
            .from(dataAccessEvents)
            .where(eq(dataAccessEvents.tenantId, subject.tenantId)),
        ).toStrictEqual([
          { outcome: 'denied', outcomeCode: 'spicedb_permission_denied', outcomeStage: 'authz', resultCount: 0 },
        ]);
        expect(yield* savedAddressRows()).toStrictEqual(addressesBefore);

        // The business Permission is the gate that answered, and the grant is what it wanted: with
        // the exact `counterparty.address_book.use` relationship written and every other input
        // identical, the selection passes that check and is refused by the next gate instead.
        yield* grantAddressBookPermission(counterpartyId);
        yield* selectProfile();
        expect(
          yield* admin.executor
            .select({ outcomeCode: dataAccessEvents.outcomeCode })
            .from(dataAccessEvents)
            .where(eq(dataAccessEvents.tenantId, subject.tenantId))
            .orderBy(dataAccessEvents.occurredAt),
        ).toStrictEqual([{ outcomeCode: 'spicedb_permission_denied' }, { outcomeCode: 'read_permission_denied' }]);
      }),
    ),
  // Building the deployed composition root — every governed route, both runtimes, the Core pools
  // and the SpiceDB client — costs more than this project's default per-test budget.
  180_000,
);
