import { randomUUID } from 'node:crypto';

import { ContextAccessLive, DatabaseConfigLive } from '@app/core-runtime';
import {
  ReadPrincipalBindingPayloadSchema,
  ReadPrincipalBindingResultSchema,
} from '@app/core-runtime/auth/external-identity-contracts';
import { eq, sql } from 'drizzle-orm';
import { Config, DateTime, Effect, Layer, Match, Option, Redacted, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  GatewayAssertionRedemptionService,
  GatewayAssertionReplayError,
} from '@app/core-runtime/auth/gateway-assertion-redemption';
import {
  commerceCustomerContextActionRuntimeAwaitingOwnerPreparation,
  commercePortalAuthRealmLive,
  makeCommerceCustomerContextApiRuntime,
  productionReadRuntimeLive,
} from '../../api/index.ts';
import { CommercePortalAuthConfig } from '../../api/portal-auth/provider/config-service.ts';
import { parseCommercePortalAuthConfig } from '../../api/portal-auth/provider/config.ts';
import {
  ACTIVATE_PRINCIPAL_BINDING_TRANSITION_KEY,
  CORE_IDENTITY_OWNER_MODULE_KEY,
} from '../../src/enrollment/journeys/existing-account.ts';
import {
  BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY,
  COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY,
  ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY,
  PARTY_CANDIDATE_SUBMISSION_TRANSITION_KEY,
  PARTY_REGISTRY_OWNER_MODULE_KEY,
  retailPartyRefFor,
  retailSelfEnrollmentRequestDigest,
} from '../../src/enrollment/journeys/retail-self-enrollment-contracts.ts';
import {
  CommerceEnrollmentOwnerTransitionPreparation,
  PORTAL_ACCOUNT_CREATION_TRANSITION_KEY,
  PORTAL_AUTH_OWNER_MODULE_KEY,
} from '../../src/enrollment/orchestration/prepared-owner-authority.ts';
import { makeCommercePortalAuthDatabase } from '../../src/portal-auth/persistence/portal-auth-database.ts';
import { user } from '../../src/portal-auth/persistence/portal-auth-tables.ts';
import { acquireOutlivingCleanup } from '../../../../packages/core-runtime/tests/support/database.ts';
import { localEmailDeliveryLive } from '../support/local-email-delivery.ts';
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
import {
  enrollmentApplicationCompositionRevision,
  enrollmentApplicationCompositionSnapshot,
  enrollmentApplicationCompositionVerificationLayer,
} from '../support/enrollment-application-composition.ts';
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
 * the Party Registry, an HTTP owner that is not reachable from this sandbox. The deployment configures the
 * portal realm and the Core identity transport, so the binding's current target check runs for real: the
 * provider account row the realm's account creation commits is seeded, and Core identity is answered at its
 * HTTP boundary from the binding row Core holds.
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

const providerDatabaseUrl = Config.Redacted('COMMERCE_PORTAL_AUTH_DATABASE_URL').pipe(
  Config.orElse(() => Config.Redacted('DATABASE_URL')),
);
const CORE_IDENTITY_ORIGIN = 'https://core-identity.retail-portal-access.test';
const CORE_IDENTITY_READ_URL = `${CORE_IDENTITY_ORIGIN}/auth/identity/external/bindings/read`;
const decodeBindingRead = Schema.decodeUnknownSync(Schema.fromJsonString(ReadPrincipalBindingPayloadSchema));

/**
 * Core identity at its HTTP boundary: the deployment's Core identity client reaches it through the injected fetch,
 * and the scenario decides each answer from the Core rows it seeded. No answer is a Core that is not reachable.
 */
const makeCoreIdentityStandIn = () => {
  const reads: { readonly apiKey: string | null; readonly payload: typeof ReadPrincipalBindingPayloadSchema.Type }[] =
    [];
  let respond = Option.none<(providerSubjectId: string) => object>();
  /** Every other request leaves through the ordinary fetch. */
  const coreIdentityFetch: typeof globalThis.fetch = (input, init) => {
    const request = new Request(input, init);
    if (request.url !== CORE_IDENTITY_READ_URL) {
      return fetch(request);
    }
    return request.text().then((body) => {
      const payload = decodeBindingRead(body);
      reads.push({ apiKey: request.headers.get('x-api-key'), payload });
      return Option.isSome(respond) && payload.lookup === 'subject'
        ? Response.json(respond.value(payload.providerSubjectId))
        : new Response(null, { status: 503 });
    });
  };
  return {
    coreIdentityFetch,
    reads,
    reply: (next: Option.Option<(providerSubjectId: string) => object>) => {
      respond = next;
    },
  };
};
type CoreIdentityStandIn = ReturnType<typeof makeCoreIdentityStandIn>;

/**
 * The deployment configuration of a host that opted into the portal realm and the Core identity transport, installed
 * the way every acceptance suite installs its configuration: through the verification layer's ConfigProvider, with
 * the owner transport behind its injected fetch.
 */
const deploymentConfigurationLive = Effect.fnUntraced(function* deploymentConfigurationLive(input: {
  readonly coreIdentity: CoreIdentityStandIn;
  readonly coreIdentityApiKey: string;
  readonly gateway: AcceptanceGatewayIssuer;
  readonly tenantId: string;
}) {
  const snapshot = yield* enrollmentApplicationCompositionSnapshot;
  return enrollmentApplicationCompositionVerificationLayer(
    snapshot,
    {
      COMMERCE_CORE_IDENTITY_BASE_URL: CORE_IDENTITY_ORIGIN,
      COMMERCE_PORTAL_AUTH_DATABASE_URL: Redacted.value(yield* providerDatabaseUrl),
      COMMERCE_PORTAL_AUTH_SECRET: 'r'.repeat(64),
      COMMERCE_PORTAL_AUTH_TRUSTED_ORIGINS: ORIGIN,
      COMMERCE_PORTAL_AUTH_URL: ORIGIN,
      COMMERCE_TENANT_CREDENTIALS: JSON.stringify({
        [input.tenantId]: {
          coreIdentityApiKey: input.coreIdentityApiKey,
          gatewayApiKey: `retail-portal-access-unused-${randomUUID()}`,
        },
      }),
      ONTOS_GATEWAY_ISSUER: input.gateway.issuer,
      ONTOS_GATEWAY_PUBLIC_JWKS: JSON.stringify({ keys: [input.gateway.publicJwk] }),
    },
    input.coreIdentity.coreIdentityFetch,
  );
});

/** The realm a host that opted in gets, assembled from the same layer the composition root uses. */
const configuredRealmLive = Effect.fnUntraced(function* configuredRealmLive() {
  const configuration = yield* parseCommercePortalAuthConfig({
    COMMERCE_PORTAL_AUTH_DATABASE_URL: Redacted.value(yield* providerDatabaseUrl),
    COMMERCE_PORTAL_AUTH_SECRET: 'r'.repeat(64),
    COMMERCE_PORTAL_AUTH_TRUSTED_ORIGINS: ORIGIN,
    COMMERCE_PORTAL_AUTH_URL: ORIGIN,
  });
  return commercePortalAuthRealmLive.pipe(
    Layer.provide(localEmailDeliveryLive([])),
    Layer.provideMerge(Layer.succeed(CommercePortalAuthConfig, configuration)),
  );
});

/**
 * The deployed handler tree of a host that configured the portal realm and the Core identity transport, so the
 * binding's current target-identity check runs against both. No owner preparation is needed by the binding.
 */
const deployedRuntime = (deploymentConfiguration: Layer.Layer<never>) =>
  Effect.acquireRelease(
    Effect.map(configuredRealmLive(), (realmLive) =>
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
        realmLive,
        deploymentConfiguration,
        DatabaseConfigLive,
        ContextAccessLive,
      ).createHandler(),
    ),
    (runtime) => Effect.promise(async () => await runtime.dispose()),
  );

type DeployedHandler = Effect.Success<ReturnType<typeof deployedRuntime>>;

interface RetailScenario {
  readonly attemptId: string;
  readonly bindAt: DateTime.Utc;
  readonly coreIdentity: CoreIdentityStandIn;
  readonly coreIdentityApiKey: string;
  readonly customerId: string;
  readonly fixture: EnrollmentAcceptanceFixture;
  readonly gateway: AcceptanceGatewayIssuer;
  readonly partyId: string;
  readonly profileId: string;
  readonly providerInvocationId: string;
  readonly providerSubjectId: string;
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

/**
 * The provider account step as the continuation leaves it (provider-owner-effect.ts): the account-creation
 * transition succeeded under its owner invocation, and the Attempt records the account subject it created.
 * Answers the Attempt's own creation instant, which the continuation binds as `effectiveAt`.
 */
const recordAccountCreation = (
  fixture: EnrollmentAcceptanceFixture,
  realm: CounterpartyInvitationRealm,
  attemptId: string,
  account: { readonly providerInvocationId: string; readonly providerSubjectId: string },
) =>
  fixture.admin
    .transaction((transaction) =>
      Effect.gen(function* recordAccount() {
        yield* transaction.execute(sql`select set_config('ontos.tenant_id', ${realm.tenantId}, true)`, 'objects');
        yield* transaction.execute(
          sql`update commerce_customer_context.portal_enrollment_attempts
                set authentication_namespace_id = ${COMMERCE_AUTHENTICATION_NAMESPACE_ID},
                    subject_type = 'user',
                    provider_subject_id = ${account.providerSubjectId}
              where tenant_id = ${realm.tenantId}::uuid and portal_enrollment_attempt_id = ${attemptId}::uuid`,
          'objects',
        );
        yield* transaction.execute(
          sql`insert into commerce_customer_context.portal_enrollment_owner_operations
                (tenant_id, portal_enrollment_attempt_id, owner_module_key, transition_key, owner_invocation_id,
                 actor_principal_id, request_digest, status, completed_at, result_reference)
              values (${realm.tenantId}::uuid, ${attemptId}::uuid, ${PORTAL_AUTH_OWNER_MODULE_KEY},
                ${PORTAL_ACCOUNT_CREATION_TRANSITION_KEY}, ${account.providerInvocationId}::uuid,
                ${realm.storefrontPrincipalId}::uuid, ${'d'.repeat(64)}, 'SUCCEEDED', statement_timestamp(),
                ${account.providerSubjectId})`,
          'objects',
        );
        const [row] = yield* transaction.execute<{ readonly created_at: string }>(
          sql`select to_char(created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as created_at
                from commerce_customer_context.portal_enrollment_attempts
               where tenant_id = ${realm.tenantId}::uuid and portal_enrollment_attempt_id = ${attemptId}::uuid`,
          'objects',
        );
        return row === undefined
          ? yield* Effect.die('The started Attempt is missing')
          : DateTime.makeUnsafe(row.created_at);
      }),
    )
    .pipe(Effect.orDie);

/** The provider directory row the realm's own account creation commits, stamped with its owner invocation. */
const seedProviderAccount = (providerSubjectId: string, ownerInvocationId: string) =>
  Effect.gen(function* insertProviderAccount() {
    const database = yield* acquireOutlivingCleanup(
      makeCommercePortalAuthDatabase({ connectionString: yield* providerDatabaseUrl }),
    ).pipe(Effect.orDie);
    yield* Effect.acquireRelease(
      database.executor
        .insert(user)
        .values({
          email: `retail-portal-access-${randomUUID()}@example.test`,
          emailVerified: false,
          enrollmentOwnerInvocationId: ownerInvocationId,
          id: providerSubjectId,
          name: 'Retail portal access customer',
        })
        .pipe(Effect.orDie),
      () => database.executor.delete(user).where(eq(user.id, providerSubjectId)).pipe(Effect.ignore),
    );
  });

/** The customer proves its address with the provider; only a verified account may become the binding's target. */
const verifyProviderAccount = (providerSubjectId: string) =>
  Effect.gen(function* markProviderAccountVerified() {
    const database = yield* acquireOutlivingCleanup(
      makeCommercePortalAuthDatabase({ connectionString: yield* providerDatabaseUrl }),
    ).pipe(Effect.orDie);
    yield* database.executor
      .update(user)
      .set({ emailVerified: true })
      .where(eq(user.id, providerSubjectId))
      .pipe(Effect.orDie);
  });

/** Core identity answers a subject read from the binding row Core actually holds for the customer. */
const answerFromCoreBinding = (scenario: RetailScenario) =>
  scenario.fixture.admin
    .execute<{ readonly binding_revision: number; readonly status: string }>(
      sql`select binding_revision, status from core.principal_auth_bindings
           where tenant_id = ${scenario.realm.tenantId}::uuid
             and principal_auth_binding_id = ${scenario.realm.recipientAuthBindingId}::uuid`,
      'objects',
    )
    .pipe(
      Effect.flatMap(([row]) =>
        row === undefined ? Effect.die('The customer binding is missing') : Effect.succeed(row),
      ),
      Effect.flatMap((row) =>
        Schema.encodeEffect(ReadPrincipalBindingResultSchema)(
          Schema.decodeUnknownSync(Schema.toType(ReadPrincipalBindingResultSchema))({
            authBindingId: scenario.realm.recipientAuthBindingId,
            authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
            bindingRevision: row.binding_revision,
            bindingStatus: row.status,
            originalInvocationId: Option.none(),
            outcome: 'FOUND',
            principalId: scenario.customerId,
            principalStatus: 'active',
            tenantStatus: 'active',
          }),
        ),
      ),
      Effect.orDie,
      Effect.tap((answer) =>
        Effect.sync(() => {
          scenario.coreIdentity.reply(
            Option.some((providerSubjectId: string) =>
              providerSubjectId === scenario.providerSubjectId ? answer : { outcome: 'NOT_FOUND' },
            ),
          );
        }),
      ),
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
  // The provider account the continuation created for the visitor, and the subject it recorded on the Attempt.
  const providerInvocationId = randomUUID();
  const providerSubjectId = `counterparty-invitation-recipient-${realm.recipientPrincipalId}`;
  const bindAt = yield* recordAccountCreation(fixture, realm, attempt.portalEnrollmentAttemptId, {
    providerInvocationId,
    providerSubjectId,
  });
  yield* seedProviderAccount(providerSubjectId, providerInvocationId);
  const gateway = yield* makeAcceptanceGatewayIssuer(ISSUER, KEY_ID);
  // The deployment's workload credential table names this Tenant, as a configured host names its Tenants.
  const coreIdentity = makeCoreIdentityStandIn();
  const coreIdentityApiKey = `retail-portal-access-core-identity-${randomUUID()}`;
  const runtime = yield* deployedRuntime(
    yield* deploymentConfigurationLive({ coreIdentity, coreIdentityApiKey, gateway, tenantId }),
  );
  return {
    attemptId: attempt.portalEnrollmentAttemptId,
    bindAt,
    coreIdentity,
    coreIdentityApiKey,
    customerId: realm.recipientPrincipalId,
    fixture,
    gateway,
    partyId: ids.partyId,
    profileId: ids.profileId,
    providerInvocationId,
    providerSubjectId,
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
                 ${ENSURE_RETAIL_CUSTOMER_PROFILE_TRANSITION_KEY}, ${randomUUID()}::uuid,
                 ${scenario.realm.storefrontPrincipalId}::uuid, ${'e'.repeat(64)}, 'SUCCEEDED', statement_timestamp(),
                 ${scenario.profileId}),
                (${scenario.realm.tenantId}::uuid, ${scenario.attemptId}::uuid, ${CORE_IDENTITY_OWNER_MODULE_KEY},
                 ${ACTIVATE_PRINCIPAL_BINDING_TRANSITION_KEY}, ${randomUUID()}::uuid,
                 ${scenario.realm.storefrontPrincipalId}::uuid, ${'f'.repeat(64)}, 'SUCCEEDED', statement_timestamp(),
                 ${scenario.realm.recipientAuthBindingId}),
                (${scenario.realm.tenantId}::uuid, ${scenario.attemptId}::uuid, ${COMMERCE_CUSTOMER_CONTEXT_OWNER_MODULE_KEY},
                 ${BIND_RETAIL_PORTAL_PROFILE_TRANSITION_KEY}, ${randomUUID()}::uuid,
                 ${scenario.realm.storefrontPrincipalId}::uuid, ${bindDigest}, 'IN_PROGRESS', null, null)`,
          'objects',
        );
      }),
    )
    .pipe(Effect.orDie);

const bind = Effect.fnUntraced(function* bind(
  scenario: RetailScenario,
  enrollmentEvidenceRef: string,
  principalId: string = scenario.customerId,
) {
  // The continuation binds at the Attempt's own creation instant (owner-effect-registry.ts).
  const effectiveAt = DateTime.formatIso(scenario.bindAt);
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

        // The provider account the enrollment created is not verified yet: the current target check refuses it
        // before Core is asked, and nothing is granted.
        yield* answerFromCoreBinding(scenario);
        const unverified = yield* bind(scenario, scenario.attemptId);
        expect(unverified.status).toBeGreaterThanOrEqual(400);
        expect(unverified.status).toBeLessThan(500);
        expect(unverified.body).toMatchObject({ code: 'ENROLLMENT_EVIDENCE_INSUFFICIENT' });
        expect(scenario.coreIdentity.reads).toHaveLength(0);
        expect(yield* customerAccessIntent(scenario)).toStrictEqual({ assignments: [], memberships: [] });

        // Core no longer knows the account subject: still refused, still nothing granted.
        yield* verifyProviderAccount(scenario.providerSubjectId);
        scenario.coreIdentity.reply(Option.some(() => ({ outcome: 'NOT_FOUND' })));
        const unknown = yield* bind(scenario, scenario.attemptId);
        expect(unknown.status).toBeGreaterThanOrEqual(400);
        expect(unknown.status).toBeLessThan(500);
        expect(unknown.body).toMatchObject({ code: 'ENROLLMENT_EVIDENCE_INSUFFICIENT' });
        expect(yield* customerAccessIntent(scenario)).toStrictEqual({ assignments: [], memberships: [] });

        // The continuation's bind for the Attempt the Storefront client started commits the binding and the
        // customer's portal access together once the verified account is the customer's current Core binding;
        // the rows are the customer's own, not the machine's.
        yield* answerFromCoreBinding(scenario);
        const bound = yield* bind(scenario, scenario.attemptId);
        expect(bound.status).toBe(200);
        expect(bound.body).toMatchObject({ outcome: 'BINDING_ACTIVATED', state: 'ACTIVE' });
        // Core was read with this deployment's Core identity credential for the account subject the Attempt holds.
        expect(scenario.coreIdentity.reads.at(-1)).toMatchObject({
          apiKey: scenario.coreIdentityApiKey,
          payload: { lookup: 'subject', providerSubjectId: scenario.providerSubjectId, subjectType: 'user' },
        });
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
