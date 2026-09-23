import { randomUUID } from 'node:crypto';

import { v1 } from '@authzed/authzed-node';
import { sql } from 'drizzle-orm';
import { Context, Effect, Layer, Schema } from 'effect';
import { Pool } from 'pg';

import { scopedRoutineInvokerFromTransaction } from '@app/core-runtime';

import { TrustedPrincipalContextSchema } from '../../../../packages/core-runtime/src/actions/principal-context.ts';
import { acquirePoolResource } from '../../../../packages/core-runtime/src/db/client.ts';
import { layerTestDatabaseFromPool } from '../../../../packages/core-runtime/tests/support/database.ts';
import type { TestDatabaseFromPool } from '../../../../packages/core-runtime/tests/support/database.ts';
import { loadDatabaseConnectionPair } from '../../../../packages/core-runtime/src/db/config.ts';
import {
  ContextAccess,
  toBusinessPermissionAccessKey,
  toBusinessPermissionAccessObjectId,
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
} from '../../../../packages/core-runtime/src/permissions/context-access.ts';
import type { ContextAccessService } from '../../../../packages/core-runtime/src/permissions/context-access.ts';
import { loadSpiceDbConfig } from '../../../../packages/core-runtime/src/permissions/config.ts';
import { PrincipalEligibility } from '../../../../packages/core-runtime/src/permissions/principal-ref.ts';
import type { PrincipalEligibilityService } from '../../../../packages/core-runtime/src/permissions/principal-ref.ts';
import { toSpiceDbActionObjectId } from '../../../../packages/core-runtime/src/permissions/service.ts';
import { commercePortalAuthPlatformCryptoLive } from '../../api/portal-auth/deployment.ts';
import { commerceCustomerContextRelations } from '../../src/database/schema.ts';
import { AccessInstantSchema, CounterpartyRefSchema, PrincipalRefSchema } from '../../shared/domain/access-contract.ts';
import { counterpartyAccessPortForScopedTransaction } from '../../src/persistence/access-persistence.ts';
import type { CounterpartyAccessScopedRoutineInvoker } from '../../src/persistence/access-persistence.ts';
import type { EnrollmentAcceptanceFixture } from './enrollment-acceptance-fixture.ts';
import type { CapturingCounterpartyInvitationProofDelivery } from './counterparty-invitation-proof-capture.ts';
import { seedCounterpartyInvitationCoreRealm } from './counterparty-invitation-core-realm.ts';

/**
 * Every durable fact a Counterparty invitation enrollment needs before its recipient can claim.
 *
 * The acceptance owns three Principals: the shared Storefront client that starts an enrollment on
 * a visitor's behalf, the Counterparty administrator whose current authority the claim re-verifies,
 * and the recipient the journey binds. Their Core rows, the Commerce Counterparty profile the
 * invitation hangs off, the administrator's owner-ledger grant and the SpiceDB relationships are
 * all real; nothing about the claim path is scripted.
 */

const ACCESS_MANAGEMENT_PERMISSION = 'counterparty.access.manage';
const COMMERCE_MODULE_KEY = 'commerce.customer-context';
/** What an invitation grants its recipient; the claim stages this grant for the claimant. */
const COUNTERPARTY_INVITATION_PERMISSION = 'counterparty.purchase.submit';

export interface CounterpartyInvitationRealm {
  readonly counterpartyPurchasingProfileId: string;
  readonly counterpartyResourceId: string;
  readonly inviterPrincipalId: string;
  readonly legalEntityId: string;
  readonly recipientAuthBindingId: string;
  readonly recipientPrincipalId: string;
  readonly storefrontAuthBindingId: string;
  readonly storefrontPrincipalId: string;
  readonly tenantId: string;
}

interface SpiceDbRelationshipSpec {
  readonly relation: string;
  readonly resourceId: string;
  readonly resourceType: string;
  readonly subjectId: string;
  readonly subjectType: string;
}

/** The `action#executor` relationships one Principal needs for the Actions a scenario runs. */
const executorOf = (principalId: string, actionKeys: readonly string[]): readonly SpiceDbRelationshipSpec[] =>
  actionKeys.map((actionKey) => ({
    relation: 'executor',
    resourceId: toSpiceDbActionObjectId(actionKey),
    resourceType: 'action',
    subjectId: principalId,
    subjectType: 'principal',
  }));

const relationshipFor = (spec: SpiceDbRelationshipSpec) =>
  v1.Relationship.create({
    relation: spec.relation,
    resource: v1.ObjectReference.create({ objectId: spec.resourceId, objectType: spec.resourceType }),
    subject: v1.SubjectReference.create({
      object: v1.ObjectReference.create({ objectId: spec.subjectId, objectType: spec.subjectType }),
    }),
  });

/** A SpiceDB object identifier the encoder refused is a fixture defect, never a scenario outcome. */
const requireObjectId = (value: string | undefined, what: string): string => {
  if (value === undefined) {
    throw new Error(`The invitation acceptance could not encode a SpiceDB object id for ${what}`);
  }
  return value;
};

/** Writes the relationships one scenario needs and removes them again on scope close. */
const seedSpiceDbRelationships = Effect.fnUntraced(function* seedSpiceDbRelationships(
  specs: readonly SpiceDbRelationshipSpec[],
) {
  const configuration = yield* loadSpiceDbConfig();
  const client = v1.NewClient(
    configuration.preSharedKey,
    configuration.endpoint,
    configuration.insecureLocal ? v1.ClientSecurity.INSECURE_LOCALHOST_ALLOWED : v1.ClientSecurity.SECURE,
  );
  const relationships = specs.map(relationshipFor);
  const write = (operation: v1.RelationshipUpdate_Operation) =>
    Effect.promise(
      async () =>
        await client.promises.writeRelationships(
          v1.WriteRelationshipsRequest.create({
            updates: relationships.map((relationship) => v1.RelationshipUpdate.create({ operation, relationship })),
          }),
        ),
    );
  yield* write(v1.RelationshipUpdate_Operation.TOUCH);
  yield* Effect.addFinalizer(() => write(v1.RelationshipUpdate_Operation.DELETE).pipe(Effect.asVoid, Effect.orDie));
});

/** The Commerce rows an invitation hangs off, written with the owner role under the scenario scope. */
const seedCommerceCounterparty = (fixture: EnrollmentAcceptanceFixture, realm: CounterpartyInvitationRealm) =>
  fixture.admin
    .transaction((transaction) =>
      Effect.gen(function* insertCounterpartyRows() {
        yield* transaction.execute(
          sql`select set_config('ontos.tenant_id', ${realm.tenantId}, true), set_config('ontos.legal_entity_id', ${realm.legalEntityId}, true)`,
          'objects',
        );
        yield* transaction.execute(
          sql`
            insert into commerce_customer_context.customer_profiles
              (customer_profile_id, tenant_id, legal_entity_id, profile_kind, lifecycle, revision)
            values (${realm.counterpartyPurchasingProfileId}::uuid, ${realm.tenantId}::uuid, ${realm.legalEntityId}::uuid, 'COUNTERPARTY', 'ACTIVE', 1)
          `,
          'objects',
        );
        yield* transaction.execute(
          sql`
            insert into commerce_customer_context.counterparty_purchasing_profiles
              (counterparty_purchasing_profile_id, tenant_id, legal_entity_id, counterparty_resource_id)
            values (${realm.counterpartyPurchasingProfileId}::uuid, ${realm.tenantId}::uuid, ${realm.legalEntityId}::uuid, ${realm.counterpartyResourceId})
          `,
          'objects',
        );
        // The grantor's owner-ledger authority: the claim re-verifies it twice, before and after
        // staging the recipient's grants, and refuses the claim outright when it is missing.
        yield* transaction.execute(
          sql`
            insert into commerce_customer_context.counterparty_commerce_access_grants
              (tenant_id, legal_entity_id, counterparty_purchasing_profile_id, lifecycle, permission_code,
               principal_id, revision, action_invocation_id, actor_principal_id)
            values (${realm.tenantId}::uuid, ${realm.legalEntityId}::uuid, ${realm.counterpartyPurchasingProfileId}::uuid,
                    'ACTIVE', ${ACCESS_MANAGEMENT_PERMISSION}, ${realm.inviterPrincipalId}::uuid, 1,
                    ${randomUUID()}::uuid, ${realm.inviterPrincipalId}::uuid)
          `,
          'objects',
        );
      }),
    )
    .pipe(Effect.orDie);

/** Removes every Commerce row one scenario wrote, in dependency order. */
const removeCommerceCounterparty = (fixture: EnrollmentAcceptanceFixture, realm: CounterpartyInvitationRealm) =>
  fixture.admin
    .transaction((transaction) =>
      Effect.gen(function* deleteCounterpartyRows() {
        yield* transaction.execute(sql`set local session_replication_role = 'replica'`, 'objects');
        for (const table of [
          'counterparty_invitation_claim_attempts',
          'counterparty_invitation_claim_proofs',
          'counterparty_access_invitations',
          'counterparty_commerce_access_grants',
          'access_mutation_journal',
          'counterparty_purchasing_profiles',
          'customer_profiles',
        ]) {
          yield* transaction.execute(
            sql`delete from commerce_customer_context.${sql.raw(table)} where tenant_id = ${realm.tenantId}::uuid`,
            'objects',
          );
        }
      }),
    )
    .pipe(Effect.asVoid, Effect.orDie);

/** Every Action key a scenario's Principals execute, keyed by the Principal that executes it. */
export interface CounterpartyInvitationActionGrants {
  readonly recipientActionKeys: readonly string[];
  readonly storefrontActionKeys: readonly string[];
}

const spiceDbSpecsFor = (
  realm: CounterpartyInvitationRealm,
  grants: CounterpartyInvitationActionGrants,
): readonly SpiceDbRelationshipSpec[] => {
  const legalEntityObjectId = requireObjectId(
    toLegalEntityAccessObjectId(realm.tenantId, realm.legalEntityId),
    'the selling Legal Entity',
  );
  const moduleObjectId = requireObjectId(
    toModuleAccessObjectId(realm.tenantId, realm.legalEntityId, COMMERCE_MODULE_KEY),
    'the Commerce module',
  );
  const administrationObjectId = requireObjectId(
    toBusinessPermissionAccessObjectId(ACCESS_MANAGEMENT_PERMISSION, {
      counterpartyId: realm.counterpartyResourceId,
      kind: 'counterparty',
      legalEntityId: realm.legalEntityId,
      tenantId: realm.tenantId,
    }),
    'the Counterparty administration permission',
  );
  const memberOf = (principalId: string): readonly SpiceDbRelationshipSpec[] => [
    {
      relation: 'member',
      resourceId: realm.tenantId,
      resourceType: 'tenant',
      subjectId: principalId,
      subjectType: 'principal',
    },
    {
      relation: 'member',
      resourceId: legalEntityObjectId,
      resourceType: 'legal_entity',
      subjectId: principalId,
      subjectType: 'principal',
    },
    {
      relation: 'accessor',
      resourceId: moduleObjectId,
      resourceType: 'module_access',
      subjectId: principalId,
      subjectType: 'principal',
    },
  ];
  return [
    {
      relation: 'tenant',
      resourceId: legalEntityObjectId,
      resourceType: 'legal_entity',
      subjectId: realm.tenantId,
      subjectType: 'tenant',
    },
    {
      relation: 'legal_entity',
      resourceId: moduleObjectId,
      resourceType: 'module_access',
      subjectId: legalEntityObjectId,
      subjectType: 'legal_entity',
    },
    {
      relation: 'legal_entity',
      resourceId: administrationObjectId,
      resourceType: 'business_permission',
      subjectId: legalEntityObjectId,
      subjectType: 'legal_entity',
    },
    // Core's own projection of the grantor's administrative authority, conjunctive with the owner
    // ledger row above: the claim consults both and refuses when either is missing.
    {
      relation: 'grantee',
      resourceId: administrationObjectId,
      resourceType: 'business_permission',
      subjectId: realm.inviterPrincipalId,
      subjectType: 'principal',
    },
    ...memberOf(realm.inviterPrincipalId),
    ...memberOf(realm.recipientPrincipalId),
    ...memberOf(realm.storefrontPrincipalId),
    ...executorOf(realm.recipientPrincipalId, grants.recipientActionKeys),
    ...executorOf(realm.storefrontPrincipalId, grants.storefrontActionKeys),
  ];
};

export const makeCounterpartyInvitationRealm = Effect.fnUntraced(function* makeCounterpartyInvitationRealm(
  fixture: EnrollmentAcceptanceFixture,
  grants: CounterpartyInvitationActionGrants,
) {
  const realm: CounterpartyInvitationRealm = {
    counterpartyPurchasingProfileId: randomUUID(),
    counterpartyResourceId: `counterparty-${randomUUID()}`,
    inviterPrincipalId: randomUUID(),
    legalEntityId: randomUUID(),
    recipientAuthBindingId: randomUUID(),
    recipientPrincipalId: randomUUID(),
    storefrontAuthBindingId: randomUUID(),
    storefrontPrincipalId: randomUUID(),
    tenantId: fixture.scope.tenantId,
  };
  yield* seedCounterpartyInvitationCoreRealm(realm);
  yield* Effect.acquireRelease(seedCommerceCounterparty(fixture, realm), () =>
    removeCommerceCounterparty(fixture, realm),
  );
  yield* seedSpiceDbRelationships(spiceDbSpecsFor(realm, grants));
  return realm;
});

/**
 * Issuance authorization is granted wholesale: the governed create Action's own permission gates
 * are covered by the access acceptance, and the claim path below reads the real SpiceDB.
 */
const eligiblePrincipals: PrincipalEligibilityService = {
  resolve: (principal) => Effect.succeed({ decision: 'eligible', principal, reason: 'active' }),
};

/** Context authorization is granted wholesale for issuance; the claim reads the real SpiceDB. */
const allowed = (keys: readonly string[]) => Effect.succeed(keys.map((key) => ({ decision: 'allowed' as const, key })));
const openContextAccess: ContextAccessService = {
  businessPermissions: ({ targets }) => allowed(targets.map(toBusinessPermissionAccessKey)),
  identityNamespaces: ({ authenticationNamespaceIds }) => allowed(authenticationNamespaceIds),
  legalEntities: ({ legalEntityIds }) => allowed(legalEntityIds),
  modules: ({ moduleIds }) => allowed(moduleIds),
  resources: ({ resources }) =>
    allowed(resources.map(({ moduleId, resourceId, resourceType }) => `${moduleId}:${resourceType}:${resourceId}`)),
  tenants: ({ tenantIds }) => allowed(tenantIds),
};

interface ExpiryRow extends Record<string, unknown> {
  readonly expires_at: string;
}

type OwnerTransaction = Parameters<
  Parameters<TestDatabaseFromPool<typeof commerceCustomerContextRelations>['transaction']>[0]
>[0];

class InvitationOwnerDatabase extends Context.Service<
  InvitationOwnerDatabase,
  TestDatabaseFromPool<typeof commerceCustomerContextRelations>
>()('@app/commerce-customer-context/tests/support/InvitationOwnerDatabase') {}

/**
 * One owner transaction on the runtime role with the scenario's Tenant and Legal Entity installed
 * exactly as a governed operation installs them — the same seam `counterpartyAccessServicesForTransaction`
 * is handed in production, so every routine the invitation owner calls is the deployed one.
 */
const counterpartyAccessOwnerRun = Effect.fnUntraced(function* counterpartyAccessOwnerRun(
  realm: CounterpartyInvitationRealm,
) {
  const connections = yield* loadDatabaseConnectionPair();
  const pool = yield* acquirePoolResource(
    () => new Pool({ connectionString: connections.runtime.connectionString, max: 2 }),
  );
  const database = yield* InvitationOwnerDatabase.pipe(
    Effect.provide(layerTestDatabaseFromPool(InvitationOwnerDatabase, pool, commerceCustomerContextRelations)),
  );
  const scope = { legalEntityId: realm.legalEntityId, tenantId: realm.tenantId };
  const installScope = (transaction: OwnerTransaction) =>
    transaction.execute(
      sql`select set_config('ontos.tenant_id', ${realm.tenantId}, true), set_config('ontos.legal_entity_id', ${realm.legalEntityId}, true)`,
      'objects',
    );
  const invokerFor = (transaction: OwnerTransaction): CounterpartyAccessScopedRoutineInvoker =>
    scopedRoutineInvokerFromTransaction((statement) => transaction.execute(statement, 'objects'), scope);
  return {
    /**
     * One canonical UTC instant a day from now, read from the deployment's own PostgreSQL clock.
     * Every expiry predicate the invitation routines evaluate compares against that clock, so a
     * fixture that minted the instant from this process could place an invitation outside its own
     * validity window.
     */
    expiryInOneDay: database
      .transaction((transaction) =>
        transaction.execute<ExpiryRow>(
          sql`select to_char((statement_timestamp() + interval '1 day') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as expires_at`,
          'objects',
        ),
      )
      .pipe(
        Effect.flatMap((rows) => {
          const [row] = rows;
          return row === undefined
            ? Effect.die('The invitation acceptance could not read the deployment clock')
            : Effect.succeed(row.expires_at);
        }),
        Effect.orDie,
      ),
    run: <Value>(operation: (transaction: CounterpartyAccessScopedRoutineInvoker) => Effect.Effect<Value>) =>
      database
        .transaction((transaction) =>
          installScope(transaction).pipe(Effect.flatMap(() => operation(invokerFor(transaction)))),
        )
        .pipe(Effect.orDie),
  };
});

interface IssuedCounterpartyInvitation {
  readonly claimProofReference: string;
  readonly invitationId: string;
  readonly revision: number;
  readonly secret: string;
}

/**
 * One real Counterparty Access invitation, created through the owner port the governed
 * `create-counterparty-access-invitation` Action calls, with the deployment's fail-closed proof
 * delivery replaced by the capturing one so the recipient's copy of the secret is observable.
 */
export const issueCounterpartyAccessInvitation = Effect.fnUntraced(function* issueCounterpartyAccessInvitation(
  realm: CounterpartyInvitationRealm,
  capture: CapturingCounterpartyInvitationProofDelivery,
  deliveryReference: string,
) {
  const scope = {
    ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
      authBindingId: randomUUID(),
      authContextRef: `portal-session:${realm.inviterPrincipalId}`,
      authMethod: 'session',
      principalId: realm.inviterPrincipalId,
      tenantId: realm.tenantId,
    }),
    correlationId: `counterparty-invitation-issue-${randomUUID()}`,
    legalEntityId: realm.legalEntityId,
  };
  const counterpartyRef = Schema.decodeUnknownSync(CounterpartyRefSchema)({
    moduleId: 'party.registry',
    resourceId: realm.counterpartyResourceId,
    resourceType: 'party.registry.counterparty',
    tenantId: realm.tenantId,
  });
  const actor = Schema.decodeUnknownSync(PrincipalRefSchema)({
    principalId: realm.inviterPrincipalId,
    tenantId: realm.tenantId,
  });
  const before = capture.staged.length;
  const owner = yield* counterpartyAccessOwnerRun(realm);
  const { run } = owner;
  const expiresAt = Schema.decodeUnknownSync(AccessInstantSchema)(yield* owner.expiryInOneDay);
  const created = yield* run((transaction) =>
    counterpartyAccessPortForScopedTransaction(transaction, scope).pipe(
      Effect.flatMap((port) =>
        port.createInvitation({
          actionInvocationId: randomUUID(),
          actor,
          counterpartyRef,
          deliveryMethod: 'VERIFIED_CONTACT_POINT',
          deliveryReference,
          expiresAt,
          intendedPermissions: [COUNTERPARTY_INVITATION_PERMISSION],
          legalEntityId: realm.legalEntityId,
          reason: 'Counterparty invitation enrollment acceptance',
          scope: { kind: 'counterparty' },
        }),
      ),
      Effect.provide(
        Layer.mergeAll(
          capture.live,
          commercePortalAuthPlatformCryptoLive,
          Layer.succeed(ContextAccess, openContextAccess),
          Layer.succeed(PrincipalEligibility, eligiblePrincipals),
        ),
      ),
      Effect.orDie,
    ),
  );
  const staged = capture.staged.at(-1);
  if (created.outcome !== 'CREATED' || staged === undefined || capture.staged.length !== before + 1) {
    return yield* Effect.die('The invitation acceptance did not stage exactly one proof delivery');
  }
  const issued: IssuedCounterpartyInvitation = {
    claimProofReference: staged.claimProofReference,
    invitationId: created.invitation.invitationRef.resourceId,
    revision: created.invitation.revision,
    secret: staged.secret,
  };
  return issued;
});

interface InvitationRow extends Record<string, unknown> {
  readonly claim_proof_reference: string | null;
  readonly claimed_by_principal_id: string | null;
  readonly lifecycle: string;
  readonly revision: number;
}

/** The durable invitation row, read with the owner role so RLS cannot mask a regression. */
export const readCounterpartyInvitationRow = (
  fixture: EnrollmentAcceptanceFixture,
  realm: CounterpartyInvitationRealm,
  invitationId: string,
): Effect.Effect<InvitationRow> =>
  fixture.admin
    .transaction((transaction) =>
      transaction.execute<InvitationRow>(
        sql`
          select lifecycle, revision, claimed_by_principal_id, claim_proof_reference
            from commerce_customer_context.counterparty_access_invitations
           where tenant_id = ${realm.tenantId}::uuid
             and counterparty_access_invitation_id = ${invitationId}::uuid
        `,
        'objects',
      ),
    )
    .pipe(
      Effect.flatMap((rows) => {
        const [row] = rows;
        return row === undefined ? Effect.die('The acceptance invitation row is missing') : Effect.succeed(row);
      }),
      Effect.orDie,
    );

interface ClaimProofRow extends Record<string, unknown> {
  readonly attestation_reference: string | null;
  readonly claimant_principal_id: string | null;
  readonly lifecycle: string;
}

/** The durable one-time proof this invitation was delivered with, read with the owner role. */
export const readCounterpartyInvitationClaimProof = (
  fixture: EnrollmentAcceptanceFixture,
  realm: CounterpartyInvitationRealm,
  invitationId: string,
): Effect.Effect<ClaimProofRow> =>
  fixture.admin
    .transaction((transaction) =>
      transaction.execute<ClaimProofRow>(
        sql`
          select lifecycle, claimant_principal_id, attestation_reference
            from commerce_customer_context.counterparty_invitation_claim_proofs
           where tenant_id = ${realm.tenantId}::uuid
             and invitation_id = ${invitationId}::uuid
        `,
        'objects',
      ),
    )
    .pipe(
      Effect.flatMap((rows) => {
        const [row] = rows;
        return row === undefined ? Effect.die('The acceptance invitation claim proof is missing') : Effect.succeed(row);
      }),
      Effect.orDie,
    );

/**
 * Rewrites one owner transition back into the durable state a lost answer leaves behind: dispatched
 * under a worker lease that has since lapsed, with no outcome ever recorded.
 *
 * Everything the owner itself committed — the consumed proof, the claimed invitation, the staged
 * grants — is deliberately left exactly as the claim wrote it. That difference is the whole point:
 * only a read of the invitation can tell this apart from a claim that never ran.
 */
export const loseCounterpartyInvitationClaimAnswer = (
  fixture: EnrollmentAcceptanceFixture,
  realm: CounterpartyInvitationRealm,
  portalEnrollmentAttemptId: string,
  transitionKey: string,
): Effect.Effect<void> =>
  fixture.admin
    .transaction((transaction) =>
      Effect.gen(function* rewriteClaimTransition() {
        yield* transaction.execute(
          sql`
            update commerce_customer_context.portal_enrollment_owner_operations
               set status = 'IN_PROGRESS', revision = revision + 1,
                   result_reference = null, reconciliation_ref = null, result_digest = null,
                   outcome_code = null, failure_code = null, failure_reason = null,
                   lease_owner = ${`commerce.customer-context.invitation-claim:${portalEnrollmentAttemptId}`},
                   lease_token = gen_random_uuid(),
                   lease_expires_at = statement_timestamp() - interval '1 minute',
                   completed_at = null, updated_at = statement_timestamp()
             where tenant_id = ${realm.tenantId}::uuid
               and portal_enrollment_attempt_id = ${portalEnrollmentAttemptId}::uuid
               and transition_key = ${transitionKey}
          `,
          'objects',
        );
        yield* transaction.execute(
          sql`
            update commerce_customer_context.portal_enrollment_attempts
               set state = 'IN_PROGRESS', revision = revision + 1,
                   lease_owner = null, lease_token = null, lease_expires_at = null,
                   last_failure_code = null, last_failure_reason = null,
                   updated_at = statement_timestamp()
             where tenant_id = ${realm.tenantId}::uuid
               and portal_enrollment_attempt_id = ${portalEnrollmentAttemptId}::uuid
          `,
          'objects',
        );
      }),
    )
    .pipe(Effect.asVoid, Effect.orDie);

interface ClaimMutationRow extends Record<string, unknown> {
  readonly claims: string;
}

/** How many CLAIM_INVITE mutations one invitation has durably journalled. */
export const countCounterpartyInvitationClaims = (
  fixture: EnrollmentAcceptanceFixture,
  realm: CounterpartyInvitationRealm,
  invitationId: string,
): Effect.Effect<number> =>
  fixture.admin
    .transaction((transaction) =>
      transaction.execute<ClaimMutationRow>(
        sql`
          select count(*)::text as claims
            from commerce_customer_context.access_mutation_journal
           where tenant_id = ${realm.tenantId}::uuid
             and mutation_kind = 'CLAIM_INVITE'
             and resource_id = ${invitationId}::uuid
        `,
        'objects',
      ),
    )
    .pipe(
      Effect.map((rows) => Number(rows[0]?.claims ?? '0')),
      Effect.orDie,
    );
