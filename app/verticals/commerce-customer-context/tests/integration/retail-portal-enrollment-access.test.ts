import { randomUUID } from 'node:crypto';

import { ContextAccessLive, DatabaseConfigLive } from '@app/core-runtime';
import { sql } from 'drizzle-orm';
import { Effect, Layer, Match, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  GatewayAssertionRedemptionService,
  GatewayAssertionReplayError,
} from '@app/core-runtime/auth/gateway-assertion-redemption';
import {
  commerceCustomerContextActionRuntimeAwaitingOwnerPreparation,
  makeCommerceCustomerContextApiRuntime,
  productionReadRuntimeLive,
} from '../../api/index.ts';
import { commercePortalAuthRealmUnavailableLive } from '../../api/portal-auth/realm-unavailable.ts';
import {
  BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY,
  COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY,
  PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY,
  PARTY_REGISTRY_OWNER_MODULE_KEY,
  retailPartyRefFor,
  retailSelfEnrollmentRequestDigest,
} from '../../src/enrollment/journeys/retail-self-enrollment-contracts.ts';
import { CommerceEnrollmentOwnerTransitionPreparation } from '../../src/enrollment/orchestration/prepared-owner-authority.ts';
import { CustomerProfileReadResponseSchema } from '../../shared/apis/customer-profile-read.ts';
import { RetailAccessDecisionResponseSchema } from '../../shared/apis/retail-access-decision.ts';
import {
  EnrollmentActionInvocationIdSchema,
  EnrollmentDigestSchema,
  EnrollmentKeySchema,
  EnrollmentLegalEntityIdSchema,
  EnrollmentPrincipalIdSchema,
  EnrollmentTenantIdSchema,
} from '../../shared/enrollment-contracts.ts';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '../../shared/portal-auth-contracts.ts';
import { ultramodernApiMarker } from '../../shared/ultramodern-build.ts';
import { enrollmentApplicationCompositionRevision } from '../support/enrollment-application-composition.ts';
import {
  makeEnrollmentAcceptanceFixture,
  startEnrollmentAcceptanceAttempt,
} from '../support/enrollment-acceptance-fixture.ts';
import type { EnrollmentAcceptanceFixture } from '../support/enrollment-acceptance-fixture.ts';
import {
  issueAcceptanceGatewayAssertion,
  makeAcceptanceGatewayIssuer,
} from '../support/enrollment-acceptance-identity-gateway-assertion.ts';
import type { AcceptanceGatewayIssuer } from '../support/enrollment-acceptance-identity-gateway-assertion.ts';
import { makeCounterpartyInvitationRealm } from '../support/counterparty-invitation-acceptance.ts';
import type { CounterpartyInvitationRealm } from '../support/counterparty-invitation-acceptance.ts';

/**
 * Retail self-enrollment's portal access, end to end on the deployed composition.
 *
 * The shared Storefront client starts a Retail self-enrollment for a visitor. The enrollment continuation
 * binds the visitor's Retail Customer Profile with a module call acting for the Storefront client — the
 * assertion the Shell signs for `acquireRetailOwnerCredential`, minted here by the acceptance issuer — and
 * the deployed bind Action commits the binding while Core writes the customer's portal access with it.
 * Nobody seeds the customer: afterwards it reads its profile and its consent permission through the real
 * gate, while a person the enrollment did not bind, and a module call naming no enrollment of the Storefront
 * client, are refused.
 *
 * Only the Party and profile-ensure steps are stood in for by the profile they leave behind: their owner is
 * the Party Registry, an HTTP owner that is not reachable from this sandbox.
 */

const ORIGIN = 'http://localhost:3020';
const AUDIENCE = 'commerce-customer-context';
const ISSUER = 'http://gateway.retail-portal-enrollment-access.test';
const KEY_ID = 'retail-portal-enrollment-access';

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

/** The deployed handler tree; no owner preparation is needed by the binding and the reads it serves. */
const deployedRuntime = (gateway: AcceptanceGatewayIssuer) =>
  Effect.acquireRelease(
    Effect.sync(() =>
      makeCommerceCustomerContextApiRuntime(
        productionReadRuntimeLive,
        commerceCustomerContextActionRuntimeAwaitingOwnerPreparation.pipe(
          Layer.provide(
            Layer.succeed(CommerceEnrollmentOwnerTransitionPreparation, {
              prepare: () => Effect.succeed({ outcome: 'unavailable' as const }),
            }),
          ),
        ),
        singleUseRedemptionLive,
        commercePortalAuthRealmUnavailableLive([ORIGIN]),
        gateway.verificationLive,
        DatabaseConfigLive,
        ContextAccessLive,
      ).createHandler(),
    ),
    (runtime) => Effect.promise(async () => await runtime.dispose()),
  );

type DeployedHandler = Effect.Success<ReturnType<typeof deployedRuntime>>;

interface RetailScenario {
  readonly attemptId: string;
  readonly customerId: string;
  readonly fixture: EnrollmentAcceptanceFixture;
  readonly gateway: AcceptanceGatewayIssuer;
  readonly partyId: string;
  readonly profileId: string;
  readonly realm: CounterpartyInvitationRealm;
  readonly runtime: DeployedHandler;
}

/** The Retail Customer Profile the Party and ensure steps leave behind for the visitor's Party. */
const seedRetailProfile = (
  fixture: EnrollmentAcceptanceFixture,
  realm: CounterpartyInvitationRealm,
  ids: {
    readonly partyId: string;
    readonly profileId: string;
  },
) =>
  Effect.acquireRelease(
    fixture.admin
      .transaction((transaction) =>
        Effect.gen(function* insertRetailProfile() {
          yield* transaction.execute(
            sql`select set_config('ontos.tenant_id', ${realm.tenantId}, true), set_config('ontos.legal_entity_id', ${realm.legalEntityId}, true)`,
            'objects',
          );
          yield* transaction.execute(
            sql`insert into commerce_customer_context.customer_profiles
                  (customer_profile_id, tenant_id, legal_entity_id, profile_kind, lifecycle, revision)
                values (${ids.profileId}::uuid, ${realm.tenantId}::uuid, ${realm.legalEntityId}::uuid, 'RETAIL', 'ACTIVE', 1)`,
            'objects',
          );
          yield* transaction.execute(
            sql`insert into commerce_customer_context.retail_customer_profiles
                  (retail_customer_profile_id, tenant_id, legal_entity_id, party_resource_id)
                values (${ids.profileId}::uuid, ${realm.tenantId}::uuid, ${realm.legalEntityId}::uuid, ${ids.partyId})`,
            'objects',
          );
        }),
      )
      .pipe(Effect.orDie),
    () =>
      fixture.admin
        .transaction((transaction) =>
          Effect.gen(function* deleteRetailRows() {
            yield* transaction.execute(sql`set local session_replication_role = 'replica'`, 'objects');
            for (const table of [
              'retail_portal_profile_binding_history',
              'retail_portal_profile_bindings',
              'retail_customer_profiles',
            ]) {
              yield* transaction.execute(
                sql`delete from commerce_customer_context.${sql.raw(table)} where tenant_id = ${realm.tenantId}::uuid`,
                'objects',
              );
            }
          }),
        )
        .pipe(Effect.asVoid, Effect.orDie),
  );

/** A Storefront-started Retail self-enrollment for a visitor whose Core Principal holds no access at all. */
const retailScenario = Effect.fnUntraced(function* retailScenario() {
  const tenantId = randomUUID();
  const compositionRevision = yield* enrollmentApplicationCompositionRevision;
  const fixture = yield* makeEnrollmentAcceptanceFixture({ tenantId }, compositionRevision);
  // The realm's recipient is the visitor this enrollment binds; the Storefront client is its workload.
  const realm = yield* makeCounterpartyInvitationRealm(fixture);
  const ids = { partyId: `retail-party-${randomUUID()}`, profileId: randomUUID() };
  yield* seedRetailProfile(fixture, realm, ids);
  const attempt = yield* startEnrollmentAcceptanceAttempt(fixture, {
    actionInvocationId: Schema.decodeSync(EnrollmentActionInvocationIdSchema)(randomUUID()),
    actorPrincipalId: Schema.decodeSync(EnrollmentPrincipalIdSchema)(realm.storefrontPrincipalId),
    compositionRevision,
    intentDigest: Schema.decodeSync(EnrollmentDigestSchema)('b'.repeat(64)),
    intentKey: Schema.decodeSync(EnrollmentKeySchema)(`retail-portal-access-${randomUUID()}`),
    journey: 'RETAIL_SELF_ENROLLMENT',
    targetLegalEntityId: Schema.decodeSync(EnrollmentLegalEntityIdSchema)(realm.legalEntityId),
    tenantId: Schema.decodeSync(EnrollmentTenantIdSchema)(tenantId),
  }).pipe(Effect.orDie);
  const gateway = yield* makeAcceptanceGatewayIssuer(ISSUER, KEY_ID);
  const runtime = yield* deployedRuntime(gateway);
  return {
    attemptId: attempt.portalEnrollmentAttemptId,
    customerId: realm.recipientPrincipalId,
    fixture,
    gateway,
    partyId: ids.partyId,
    profileId: ids.profileId,
    realm,
    runtime,
  } satisfies RetailScenario;
});

/** The module call the continuation makes: this module acting for the Storefront client in the company. */
const continuationAssertion = (scenario: RetailScenario) =>
  issueAcceptanceGatewayAssertion(
    scenario.fixture.admin,
    scenario.gateway,
    AUDIENCE,
    {
      authBindingId: scenario.realm.storefrontAuthBindingId,
      authContextRef: `portal-session:${scenario.realm.storefrontPrincipalId}`,
      authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
      authMethod: 'session',
      legalEntityId: scenario.realm.legalEntityId,
      principalId: scenario.realm.storefrontPrincipalId,
      tenantId: scenario.realm.tenantId,
    },
    { appId: 'commerce-customer-context', buildMarker: ultramodernApiMarker.buildMarker, principalId: randomUUID() },
  );

/** A person's own portal session in the company: the customer, or the Counterparty administrator. */
const personAssertion = (scenario: RetailScenario, person: 'customer' | 'administrator') =>
  issueAcceptanceGatewayAssertion(scenario.fixture.admin, scenario.gateway, AUDIENCE, {
    authBindingId: person === 'customer' ? scenario.realm.recipientAuthBindingId : scenario.realm.inviterAuthBindingId,
    authContextRef: `portal-session:${person}`,
    authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
    authMethod: 'session',
    legalEntityId: scenario.realm.legalEntityId,
    principalId: person === 'customer' ? scenario.customerId : scenario.realm.inviterPrincipalId,
    tenantId: scenario.realm.tenantId,
  });

const post = <Body extends object>(path: string, body: Body, assertion: string, idempotent = false) => {
  const headers = new Headers({
    authorization: `Bearer ${assertion}`,
    'content-type': 'application/json',
    'x-correlation-id': `retail-portal-access-${randomUUID()}`,
  });
  if (idempotent) {
    headers.set('idempotency-key', randomUUID());
  }
  return new Request(`${ORIGIN}${path}`, { body: JSON.stringify(body), headers, method: 'POST' });
};

/** One request to the deployed handler, answered as its status and its decoded JSON body. */
const send = (scenario: RetailScenario, request: Request) =>
  Effect.promise(async () => {
    const response = await scenario.runtime.handler(request);
    const body: unknown = await response.json();
    return { body, status: response.status };
  });

const profileRefOf = (scenario: RetailScenario) => ({
  moduleId: 'commerce.customer-context',
  resourceId: scenario.profileId,
  resourceType: 'commerce.customer-context.retail-customer-profile',
  tenantId: scenario.realm.tenantId,
});
const sellingLegalEntityRefOf = (scenario: RetailScenario) => ({
  moduleId: 'core.identity' as const,
  resourceId: scenario.realm.legalEntityId,
  resourceType: 'core.identity.legal-entity' as const,
  tenantId: scenario.realm.tenantId,
});

const principalRefOf = (scenario: RetailScenario, principalId: string) => ({
  moduleId: 'core.identity' as const,
  resourceId: principalId,
  resourceType: 'core.identity.principal' as const,
  tenantId: scenario.realm.tenantId,
});

/** The BIND payload the continuation builds from the Attempt's journal. */
const bindPayload = (
  scenario: RetailScenario,
  enrollmentEvidenceRef: string,
  effectiveAt: string,
  principalId: string,
) => ({
  effectiveAt,
  enrollmentEvidenceRef,
  expectedRevision: null,
  expectedState: null,
  principalRef: principalRefOf(scenario, principalId),
  profileRef: profileRefOf(scenario),
  reason: 'Retail self-enrollment',
  sellingLegalEntityRef: sellingLegalEntityRefOf(scenario),
});

/**
 * The Attempt's journal as the continuation leaves it before it dispatches the BIND: the Party its candidate
 * submission established, and the binding transition whose request digest names the customer it resolved.
 */
const journalRetailBinding = (scenario: RetailScenario) =>
  scenario.fixture.admin
    .transaction((transaction) =>
      Effect.gen(function* insertJournal() {
        yield* transaction.execute(
          sql`select set_config('ontos.tenant_id', ${scenario.realm.tenantId}, true)`,
          'objects',
        );
        const bindDigest = retailSelfEnrollmentRequestDigest({
          intent: {
            partyRef: retailPartyRefFor(scenario.realm.tenantId, scenario.partyId),
            principalRef: principalRefOf(scenario, scenario.customerId),
            sellingLegalEntityRef: sellingLegalEntityRefOf(scenario),
            step: 'RETAIL_PORTAL_BINDING',
          },
          ownerModuleKey: COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY,
          portalEnrollmentAttemptId: scenario.attemptId,
          transitionKey: BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY,
        });
        yield* transaction.execute(
          sql`insert into commerce_customer_context.portal_enrollment_owner_operations
                (tenant_id, portal_enrollment_attempt_id, owner_module_key, transition_key, owner_invocation_id,
                 actor_principal_id, request_digest, status, completed_at, result_reference)
              values
                (${scenario.realm.tenantId}::uuid, ${scenario.attemptId}::uuid, ${PARTY_REGISTRY_OWNER_MODULE_KEY},
                 ${PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY}, ${randomUUID()}::uuid,
                 ${scenario.realm.storefrontPrincipalId}::uuid, ${'c'.repeat(64)}, 'SUCCEEDED', statement_timestamp(),
                 ${scenario.partyId}),
                (${scenario.realm.tenantId}::uuid, ${scenario.attemptId}::uuid, ${COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY},
                 ${BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY}, ${randomUUID()}::uuid,
                 ${scenario.realm.storefrontPrincipalId}::uuid, ${bindDigest}, 'IN_PROGRESS', null, null)`,
          'objects',
        );
      }),
    )
    .pipe(Effect.orDie);

/** The deployment's own PostgreSQL instant: the clock the binding routine records its transition at. */
const databaseNow = (scenario: RetailScenario) =>
  scenario.fixture.admin
    .execute<{ readonly now: string }>(
      sql`select to_char(statement_timestamp() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as now`,
      'objects',
    )
    .pipe(
      Effect.flatMap(([row]) =>
        row === undefined ? Effect.die('The deployment clock could not be read') : Effect.succeed(row.now),
      ),
      Effect.orDie,
    );

const bind = Effect.fnUntraced(function* bind(
  scenario: RetailScenario,
  enrollmentEvidenceRef: string,
  principalId: string = scenario.customerId,
) {
  const effectiveAt = yield* databaseNow(scenario);
  const assertion = yield* continuationAssertion(scenario);
  return yield* send(
    scenario,
    post(
      '/commerce-customer-context/actions/bind-retail-portal-profile',
      bindPayload(scenario, enrollmentEvidenceRef, effectiveAt, principalId),
      assertion,
      true,
    ),
  );
});

const readProfile = (scenario: RetailScenario, person: 'customer' | 'administrator') =>
  personAssertion(scenario, person).pipe(
    Effect.flatMap((assertion) =>
      send(
        scenario,
        post(
          '/reads/customer-profile-read',
          {
            authorizationSubject: {
              kind: 'RETAIL',
              partyRef: {
                moduleId: 'party.registry',
                resourceId: scenario.partyId,
                resourceType: 'party.registry.party',
                tenantId: scenario.realm.tenantId,
              },
              sellingLegalEntityRef: sellingLegalEntityRefOf(scenario),
            },
            profileRef: { ...profileRefOf(scenario), kind: 'RETAIL' },
          },
          assertion,
        ),
      ),
    ),
  );

/** The question the Privacy consent self-service asks: may this customer manage its consents here? */
const checkConsent = (scenario: RetailScenario) =>
  personAssertion(scenario, 'customer').pipe(
    Effect.flatMap((assertion) =>
      send(
        scenario,
        post(
          '/reads/retail-access-decision',
          { profileRef: profileRefOf(scenario), requiredPermission: 'retail.consent.manage' },
          assertion,
        ),
      ),
    ),
  );

/** The customer's access intent as Core holds it: its memberships and the roles it was assigned. */
const customerAccessIntent = Effect.fnUntraced(function* customerAccessIntent(scenario: RetailScenario) {
  const memberships = yield* scenario.fixture.admin
    .execute<{ readonly recorded_by: string; readonly status: string }>(
      sql`select status, recorded_by::text from core.access_memberships
        where tenant_id = ${scenario.realm.tenantId}::uuid and principal_id = ${scenario.customerId}::uuid
        order by status`,
      'objects',
    )
    .pipe(Effect.orDie);
  const assignments = yield* scenario.fixture.admin
    .execute<{ readonly role: string; readonly status: string }>(
      sql`select role.name as role, assignment.status from core.access_assignments assignment
        join core.access_roles role on role.tenant_id = assignment.tenant_id and role.role_id = assignment.role_id
        where assignment.tenant_id = ${scenario.realm.tenantId}::uuid
          and assignment.principal_id = ${scenario.customerId}::uuid`,
      'objects',
    )
    .pipe(Effect.orDie);
  return {
    assignments: assignments.map(({ role, status }) => ({ role, status })),
    memberships: memberships.map(({ recorded_by, status }) => ({ recordedBy: recorded_by, status })),
  };
});

it.live(
  'gives a Retail self-enrollment customer its portal access with the binding, and refuses everybody else',
  () =>
    Effect.scoped(
      Effect.gen(function* retailPortalAccess() {
        const scenario = yield* retailScenario();

        // Before the binding the customer holds nothing, so it cannot even act in the company.
        expect((yield* readProfile(scenario, 'customer')).status).toBe(403);
        expect(yield* customerAccessIntent(scenario)).toStrictEqual({ assignments: [], memberships: [] });

        // A module call that names no enrollment the Storefront client started binds nobody.
        const unproven = yield* bind(scenario, randomUUID());
        expect(unproven.status).toBeGreaterThanOrEqual(400);
        expect(unproven.status).toBeLessThan(500);
        expect(unproven.body).toMatchObject({ code: 'ENROLLMENT_EVIDENCE_INSUFFICIENT' });
        expect(yield* customerAccessIntent(scenario)).toStrictEqual({ assignments: [], memberships: [] });

        // The continuation journaled the binding for the customer it resolved; the same Attempt never binds
        // anybody else, even when the Storefront client's own module call names them.
        yield* journalRetailBinding(scenario);
        const another = yield* bind(scenario, scenario.attemptId, scenario.realm.inviterPrincipalId);
        expect(another.status).toBeGreaterThanOrEqual(400);
        expect(another.status).toBeLessThan(500);
        expect(another.body).toMatchObject({ code: 'ENROLLMENT_EVIDENCE_INSUFFICIENT' });

        // The continuation's bind for the Attempt the Storefront client started commits the binding and the
        // customer's portal access together; the rows are the customer's own, not the machine's.
        const bound = yield* bind(scenario, scenario.attemptId);
        expect(bound.status).toBe(200);
        expect(bound.body).toMatchObject({ outcome: 'BINDING_ACTIVATED', state: 'ACTIVE' });
        expect(yield* customerAccessIntent(scenario)).toStrictEqual({
          assignments: [{ role: 'Zákazník e-shopu', status: 'active' }],
          memberships: [
            { recordedBy: scenario.customerId, status: 'active' },
            { recordedBy: scenario.customerId, status: 'active' },
          ],
        });

        // The customer now reads its own profile and may manage its consents, through the real gate.
        const profile = yield* readProfile(scenario, 'customer');
        expect(profile.status).toBe(200);
        const read = yield* Schema.decodeUnknownEffect(CustomerProfileReadResponseSchema)(profile.body);
        expect(
          Match.value(read).pipe(
            Match.tag('PROFILE_AVAILABLE', ({ profile: available }) => ({
              profileId: available.profileRef.resourceId,
              state: available.state,
            })),
            Match.orElse(() => null),
          ),
        ).toStrictEqual({ profileId: scenario.profileId, state: 'ACTIVE' });
        const consent = yield* checkConsent(scenario);
        expect(consent.status).toBe(200);
        const decision = yield* Schema.decodeUnknownEffect(RetailAccessDecisionResponseSchema)(consent.body);
        expect(decision.decision).toStrictEqual({ allowed: true, outcome: 'ALLOWED' });

        // A person the enrollment did not bind holds no portal role, so the profile stays closed to it.
        expect((yield* readProfile(scenario, 'administrator')).status).toBe(403);
      }),
    ),
  300_000,
);
