import { randomUUID } from 'node:crypto';

import { layer as nodeCryptoLayer } from '@effect/platform-node/NodeCrypto';
import { layer as nodeServicesLayer } from '@effect/platform-node/NodeServices';
import { sql } from 'drizzle-orm';
import { Context, Crypto, Effect, Layer, Match, Redacted, Schema } from 'effect';

import {
  ActionInvocationPersistenceError,
  ActionRuntime,
  scopedRoutineInvokerFromTransaction,
} from '@app/core-runtime';
import type { ActionRuntimeService } from '@app/core-runtime';
import { environmentTestAccessTarget, grantTestTenantRoleAccess } from '@app/core-runtime/testing/tenant-access';

import { TrustedPrincipalContextSchema } from '../../../../packages/core-runtime/src/actions/principal-context.ts';
import { layerTestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import type { TestDatabaseFromClient } from '../../../../packages/core-runtime/tests/support/database.ts';
import { acquireFixturePgClient } from './fixture-pg-client.ts';
import { AccessChangesStoreLive } from '../../../../packages/core-runtime/src/access/changes/persistence/drizzle-store.ts';
import {
  // oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- The fixture builds the single projection writer over the shared SpiceDB, as Core's own access test support does; expires: 2027-03-31.
  makeAccessProjectionCompiler,
  // oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- The fixture owns and closes this SpiceDB transport in its own scope; expires: 2027-03-31.
  makeAccessProjectionTransport,
} from '../../../../packages/core-runtime/src/access/compiler/spice-db-compiler.ts';
import { AccessMembershipStoreLive } from '../../../../packages/core-runtime/src/access/intent/memberships.ts';
import {
  AccessPeopleStore,
  AccessPeopleStoreLive,
} from '../../../../packages/core-runtime/src/access/intent/people-store.ts';
import { AccessProjectionCompiler } from '../../../../packages/core-runtime/src/access/intent/projection-compiler.ts';
import {
  AccessProjectionWriter,
  AccessProjectionWriterLive,
} from '../../../../packages/core-runtime/src/access/intent/projection-writer.ts';
import { TenantIntentLoaderLive } from '../../../../packages/core-runtime/src/access/intent/tenant-intent-loader.ts';
import { AccessWriteJournalStoreLive } from '../../../../packages/core-runtime/src/access/lifecycle/persistence/journal-store.ts';
import {
  CoreDatabase,
  // oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- The writers run as the admin role over the environment database, as Core's own access test support does; expires: 2027-03-31.
  makeCoreDatabase,
} from '../../../../packages/core-runtime/src/db/client.ts';
import { loadDatabaseConnectionPair, parseDatabaseConfig } from '../../../../packages/core-runtime/src/db/config.ts';
import { stageScopeOf } from '../../../../packages/core-runtime/src/install/stage-context-bootstrap.ts';
import { ContextAccess } from '../../../../packages/core-runtime/src/permissions/context-access.ts';
import type { ContextAccessService } from '../../../../packages/core-runtime/src/permissions/context-access.ts';
import { PrincipalEligibility } from '../../../../packages/core-runtime/src/permissions/principal-ref.ts';
import type { PrincipalEligibilityService } from '../../../../packages/core-runtime/src/permissions/principal-ref.ts';
import { commercePortalAuthPlatformCryptoLive } from '../../api/portal-auth/deployment.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import { commerceCustomerContextRelations } from '../../src/database/schema.ts';
import {
  ClaimCounterpartyAccessInvitationResultSchema,
  ClaimCounterpartyAccessInvitationPayloadSchema,
} from '../../shared/actions/claim-counterparty-access-invitation.ts';
import { AccessInstantSchema, CounterpartyRefSchema, PrincipalRefSchema } from '../../shared/domain/access-contract.ts';
import type { CounterpartyPermissionCode } from '../../shared/domain/permission-catalog.ts';
import { counterpartyInvitationClaimRedemptionForTransaction } from '../../src/persistence/invitation-claim-authority-persistence.ts';
import {
  readCounterpartyAccessInvitationForScope,
  counterpartyAccessPortForOwnerTransaction,
} from '../../src/persistence/access-persistence.ts';
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
 * invitation hangs off and the administrator's owner-ledger grant and v2 role are real. The recipient
 * starts with no access intent at all: the claim route admits it once its redemption proves the
 * secret, and the claim's own grants give it its portal access, exactly as in production.
 */

const ACCESS_MANAGEMENT_PERMISSION = 'counterparty.access.manage';
/** What an invitation grants its recipient; the claim stages this grant for the claimant. */
const COUNTERPARTY_INVITATION_PERMISSION = 'counterparty.purchase.submit';
/** The administrator's own v2 capabilities: managing the Counterparty's access in the company. */
const ADMINISTRATOR_CAPABILITY_KEYS = [
  'commerce.customer-context.counterparty-commerce-access.grant',
  'commerce.customer-context.counterparty-commerce-access.revoke',
];

export interface CounterpartyInvitationRealm {
  readonly counterpartyPurchasingProfileId: string;
  readonly counterpartyResourceId: string;
  readonly inviterAuthBindingId: string;
  readonly inviterPrincipalId: string;
  readonly legalEntityId: string;
  readonly recipientAuthBindingId: string;
  readonly recipientPrincipalId: string;
  readonly storefrontAuthBindingId: string;
  readonly storefrontPrincipalId: string;
  readonly tenantId: string;
}

/** The real v2 grant input used by this fixture, scoped only to its invitation administrator. */
export const invitationAdministratorRoleInput = (realm: CounterpartyInvitationRealm) =>
  ({
    holders: [{ capabilityKeys: ADMINISTRATOR_CAPABILITY_KEYS, principalId: realm.inviterPrincipalId }],
    legalEntityIds: [realm.legalEntityId],
    tenantId: realm.tenantId,
  }) satisfies Pick<Parameters<typeof grantTestTenantRoleAccess>[0], 'holders' | 'legalEntityIds' | 'tenantId'>;

/** The platform services the v2 access writers read the catalog and mint their ids with. */
const tenantAccessServices = Layer.mergeAll(nodeServicesLayer, nodeCryptoLayer);

/**
 * The Core writers the recipient's v2 access intent changes through, built into the caller's scope: the people
 * store that ends its assignments and the single projection writer that reconciles the result.
 */
const recipientAccessWriters = Effect.fnUntraced(function* recipientAccessWriters() {
  const target = yield* environmentTestAccessTarget;
  const database = Context.make(
    CoreDatabase,
    yield* makeCoreDatabase(
      yield* parseDatabaseConfig({ DATABASE_URL: Redacted.value(target.adminConnectionString) }).pipe(Effect.orDie),
    ),
  );
  const transport = yield* Effect.acquireRelease(
    Effect.sync(() => makeAccessProjectionTransport(target.spiceDb)),
    (opened) => Effect.sync(() => opened.close()),
  );
  const platform = Context.add(database, AccessProjectionCompiler, makeAccessProjectionCompiler(transport));
  const stores = Context.merge(
    platform,
    yield* Layer.build(
      Layer.mergeAll(
        TenantIntentLoaderLive,
        AccessWriteJournalStoreLive,
        AccessChangesStoreLive,
        AccessMembershipStoreLive,
        AccessPeopleStoreLive,
      ),
    ).pipe(Effect.provideContext(platform)),
  );
  const writer = yield* Layer.build(AccessProjectionWriterLive).pipe(Effect.provideContext(stores));
  return {
    people: Context.get(stores, AccessPeopleStore),
    writer: Context.get(writer, AccessProjectionWriter),
  };
});

/**
 * Revoke the recipient's v2 access to the claim: every active assignment it holds ends in one people change,
 * followed by one reconcile through the single projection writer, so the engine denies because the intent did.
 */
export const revokeCounterpartyInvitationRecipientAccess = Effect.fnUntraced(
  function* revokeCounterpartyInvitationRecipientAccess(realm: CounterpartyInvitationRealm) {
    const { people, writer } = yield* recipientAccessWriters();
    const scope = yield* stageScopeOf({ principalId: realm.recipientPrincipalId, tenantId: realm.tenantId });
    const { assignments } = yield* people.loadTenantPeople(scope);
    const writes = assignments
      .filter(
        ({ holder, status }) =>
          status === 'active' &&
          Match.value(holder).pipe(
            Match.tag('Principal', ({ principalId }) => principalId === realm.recipientPrincipalId),
            Match.orElse(() => false),
          ),
      )
      .map(({ incarnationId }) => ({ _tag: 'EndAssignment' as const, incarnationId }));
    yield* people.applyPeopleChange(scope, { writes });
    yield* writer.reconcileTenant({ scope });
  },
  Effect.scoped,
  Effect.provide(tenantAccessServices),
  Effect.orDie,
);

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

export const makeCounterpartyInvitationRealm = Effect.fnUntraced(function* makeCounterpartyInvitationRealm(
  fixture: EnrollmentAcceptanceFixture,
) {
  const realm: CounterpartyInvitationRealm = {
    counterpartyPurchasingProfileId: randomUUID(),
    counterpartyResourceId: `counterparty-${randomUUID()}`,
    inviterAuthBindingId: randomUUID(),
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
  // The administrator who manages this Counterparty's access is a member of the company with a role of
  // exactly that authority; writing it also publishes the release every portal role is pinned to.
  yield* grantTestTenantRoleAccess({
    ...(yield* environmentTestAccessTarget),
    ...invitationAdministratorRoleInput(realm),
  }).pipe(Effect.provide(tenantAccessServices));
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
  identityNamespaces: ({ authenticationNamespaceIds }) => allowed(authenticationNamespaceIds),
  legalEntities: ({ legalEntityIds }) => allowed(legalEntityIds),
  modules: ({ moduleIds }) => allowed(moduleIds),
  ownerPermissions: ({ targets }) => allowed(targets.map(({ target }) => target.key)),
  resources: ({ resources }) =>
    allowed(resources.map(({ moduleId, resourceId, resourceType }) => `${moduleId}:${resourceType}:${resourceId}`)),
  tenants: ({ tenantIds }) => allowed(tenantIds),
};

interface ExpiryRow extends Record<string, unknown> {
  readonly expires_at: string;
}

type OwnerTransaction = Parameters<
  Parameters<TestDatabaseFromClient<typeof commerceCustomerContextRelations>['transaction']>[0]
>[0];

class InvitationOwnerDatabase extends Context.Service<
  InvitationOwnerDatabase,
  TestDatabaseFromClient<typeof commerceCustomerContextRelations>
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
  const client = yield* acquireFixturePgClient(connections.runtime.connectionString, 2);
  const database = yield* InvitationOwnerDatabase.pipe(
    Effect.provide(layerTestDatabaseFromClient(InvitationOwnerDatabase, client, commerceCustomerContextRelations)),
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
/** Creating an invitation grants nobody anything, so its owner transaction never writes portal access. */
const issuancePortalAccess = {
  grant: () => Effect.die('Creating an invitation writes no portal access'),
  revoke: () => Effect.die('Creating an invitation writes no portal access'),
};

export const issueCounterpartyAccessInvitation = Effect.fnUntraced(function* issueCounterpartyAccessInvitation(
  realm: CounterpartyInvitationRealm,
  capture: CapturingCounterpartyInvitationProofDelivery,
  deliveryReference: string,
  intendedPermissions: readonly [CounterpartyPermissionCode, ...CounterpartyPermissionCode[]] = [
    COUNTERPARTY_INVITATION_PERMISSION,
  ],
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
    counterpartyAccessPortForOwnerTransaction(transaction, scope, issuancePortalAccess).pipe(
      Effect.flatMap((port) =>
        port.createInvitation({
          actionInvocationId: randomUUID(),
          actor,
          counterpartyRef,
          deliveryMethod: 'VERIFIED_CONTACT_POINT',
          deliveryReference,
          expiresAt,
          intendedPermissions,
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

/** Prepare the generated claim Action's input through the same owner redemption used by enrollment. */
export const prepareCounterpartyInvitationClaimPayload = Effect.fnUntraced(
  function* prepareCounterpartyInvitationClaimPayload(
    fixture: EnrollmentAcceptanceFixture,
    realm: CounterpartyInvitationRealm,
    input: Pick<IssuedCounterpartyInvitation, 'claimProofReference' | 'invitationId' | 'secret'>,
  ) {
    const crypto = yield* Crypto.Crypto.pipe(Effect.provide(commercePortalAuthPlatformCryptoLive));
    const trustedScope = {
      ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
        authBindingId: realm.recipientAuthBindingId,
        authContextRef: `portal-session:${realm.recipientPrincipalId}`,
        authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
        authMethod: 'session',
        legalEntityId: realm.legalEntityId,
        principalId: realm.recipientPrincipalId,
        tenantId: realm.tenantId,
      }),
      correlationId: `counterparty-invitation-redemption-${randomUUID()}`,
      legalEntityId: realm.legalEntityId,
    };
    const invitationRef = {
      moduleId: 'commerce.customer-context' as const,
      resourceId: input.invitationId,
      resourceType: 'commerce.customer-context.counterparty-access-invitation' as const,
      tenantId: realm.tenantId,
    };
    return yield* fixture
      .run({ legalEntityId: realm.legalEntityId, tenantId: realm.tenantId }, (transaction) =>
        counterpartyInvitationClaimRedemptionForTransaction(transaction, crypto, trustedScope)
          .redeem({
            invitationRef: Schema.decodeUnknownSync(
              ClaimCounterpartyAccessInvitationPayloadSchema.fields.invitationRef,
            )(invitationRef),
            proofReference: Schema.decodeUnknownSync(
              ClaimCounterpartyAccessInvitationPayloadSchema.fields.claimProofReference,
            )(input.claimProofReference),
            rawProof: Redacted.make(input.secret),
          })
          .pipe(
            Effect.flatMap((redeemed) =>
              readCounterpartyAccessInvitationForScope(transaction, realm.tenantId, {
                counterpartyRef: redeemed.counterpartyRef,
                invitationId: input.invitationId,
                scope: redeemed.scope,
              }).pipe(
                Effect.flatMap((invitation) =>
                  Schema.decodeUnknownEffect(ClaimCounterpartyAccessInvitationPayloadSchema)({
                    claimant: { principalId: realm.recipientPrincipalId, tenantId: realm.tenantId },
                    claimProofReference: redeemed.proofReference,
                    counterpartyRef: redeemed.counterpartyRef,
                    expectedRevision: invitation.revision,
                    invitationRef,
                    scope: redeemed.scope,
                  }),
                ),
              ),
            ),
          )
          .pipe(Effect.orDie),
      )
      .pipe(Effect.orDie);
  },
);

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

const claimAnswerLoss = function* claimAnswerLoss(droppedAnswers: string[]) {
  const runtime = yield* ActionRuntime;
  let loseNextClaimAnswer = true;
  const runAction: ActionRuntimeService['runAction'] = (input) =>
    runtime.runAction(input).pipe(
      Effect.flatMap((result) => {
        if (
          loseNextClaimAnswer &&
          input.registration.descriptor.actionKey === 'commerce.customer-context.claim-counterparty-access-invitation'
        ) {
          if (
            !Schema.is(ClaimCounterpartyAccessInvitationResultSchema)(result) ||
            result.outcome === 'ALREADY_CLAIMED' ||
            result.invitation.state !== result.outcome
          ) {
            return Effect.die('The lost-answer fixture requires a committed claimed invitation');
          }
          loseNextClaimAnswer = false;
          droppedAnswers.push(result.attestation.attestationReference);
          return Effect.fail(
            new ActionInvocationPersistenceError({
              code: 'action_invocation_persistence_failed',
              reason: 'The committed invitation claim answer was lost',
            }),
          );
        }
        return Effect.succeed(result);
      }),
    );
  return {
    resolveActionCommit: runtime.resolveActionCommit,
    resolveActionExecution: runtime.resolveActionExecution,
    runAction,
  };
};

/**
 * Drops one claim answer after the real governed Action has committed, before the enrollment
 * driver can record its outcome. The real pending Attempt and owner lease remain untouched.
 */
export const loseCounterpartyInvitationClaimAnswer = (
  droppedAnswers: string[],
): Layer.Layer<ActionRuntime, never, ActionRuntime> =>
  Layer.effect(
    ActionRuntime,
    Effect.gen(() => claimAnswerLoss(droppedAnswers)),
  );

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
