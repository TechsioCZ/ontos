import { partyRegistryApiContract } from '@app/party-registry/api';
import { shellGatewayContextContract } from '@app/shared-contracts';
import { Effect, Redacted, Schema } from 'effect';
import type { OperationalScope } from '@app/core-runtime';
import { grantTestTenantRoleAccess } from '@app/core-runtime/testing/tenant-access';
import type { TestTenantAccessTarget } from '@app/core-runtime/testing/tenant-access';
import { ReadPrincipalBindingPayloadSchema } from '@app/core-runtime/auth/external-identity-contracts';
import { STAFF_AUTHENTICATION_NAMESPACE_ID } from '@app/core-runtime/auth/staff-authentication-namespace';
import { commerceCustomerContextApiContract } from '@app/commerce-customer-context/api';
import { COMMERCE_AUTHENTICATION_NAMESPACE_ID } from '@app/commerce-customer-context/portal-auth/contracts';
import { issueApiKeyGatewayContext } from '@app/shared-contracts/server/gateway-context-api-key';
import {
  issueExternalGatewayContext,
  readPrincipalBinding,
} from '@app/shared-contracts/server/external-identity-client';
import { ExternalGatewayContextRequestSchema } from '@app/shared-contracts/external-identity';
import { ConsentSelfServiceAuthorizationError } from '../../shared/domain/privacy-consent-self-service.ts';

const uuid = Schema.String.check(Schema.isUUID());
const localOrigin = Schema.URLFromString.check(
  Schema.makeFilter((url) =>
    url.protocol === 'http:' &&
    ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
    url.username === '' &&
    url.password === '' &&
    url.pathname === '/' &&
    url.search === '' &&
    url.hash === ''
      ? undefined
      : 'The native owner origin must be loopback without credentials or a path',
  ),
);
/** IDs below must come from the real provider/session and public Core binding result. */
export const RetainedConsentAccountTransportSchema = Schema.Struct({
  authBindingId: uuid.pipe(Schema.brand('AuthBindingId')),
  commerceOrigin: localOrigin,
  compositionRevision: Schema.String.check(Schema.isPattern(/^[a-f0-9]{64}$/u)),
  coreApiKey: Schema.Redacted(Schema.String),
  coreOrigin: localOrigin,
  legalEntityId: uuid.pipe(Schema.brand('LegalEntityId')),
  partyOrigin: localOrigin,
  principalId: uuid.pipe(Schema.brand('PrincipalId')),
  providerSubjectId: Schema.String.check(Schema.isMinLength(1)).pipe(Schema.brand('ProviderSubjectId')),
  sessionRef: Schema.String.check(Schema.isMinLength(1)),
  tenantId: uuid.pipe(Schema.brand('TenantId')),
});
export type RetainedConsentAccountTransport = typeof RetainedConsentAccountTransportSchema.Type;

/** These are exact entrypoint test grants, never the owner's retail.consent.manage business grant. */
export const retainedConsentAccountActionKeys = [
  'commerce.customer-context.bind-retail-portal-profile',
  'commerce.customer-context.revoke-retail-portal-profile-binding',
  'privacy.core.acknowledge-privacy-notice',
  'privacy.core.record-notice-provision',
  'privacy.core.record-consent-decision',
  'privacy.core.consent-self-service',
] as const;
class RetainedAccountPermissionError extends Schema.TaggedError<RetainedAccountPermissionError>()(
  'RetainedAccountPermissionError',
  { stage: Schema.String },
) {}
const permissionFailure = (stage: string) => new RetainedAccountPermissionError({ stage });
const partyAudience = 'party-registry';

const isCurrentAccountBinding = (
  binding: Effect.Success<ReturnType<typeof readPrincipalBinding>>,
  account: RetainedConsentAccountTransport,
) =>
  binding.outcome === 'FOUND' &&
  binding.authBindingId === account.authBindingId &&
  binding.principalId === account.principalId &&
  binding.authenticationNamespaceId === COMMERCE_AUTHENTICATION_NAMESPACE_ID &&
  binding.bindingStatus === 'active' &&
  binding.principalStatus === 'active' &&
  binding.tenantStatus === 'active';

const accountMembershipBindingStage = 'account-membership-binding';

/**
 * What production does not give the account itself: the binding Actions it runs on its own instead of the
 * Storefront enrollment that binds a customer in production, and the Privacy and Party capabilities of the
 * modules that own them. The Commerce Reads it resolves its own profile, binding and access with come from
 * production: the binding gives the account Commerce's Retail customer portal role, and its revocation ends it.
 */
const retainedConsentAccountCapabilityKeys = [
  'commerce.customer-context.retail-portal-profile.bind',
  'commerce.customer-context.retail-portal-profile-binding.revoke',
  'privacy.core.notice.acknowledge',
  'privacy.core.notice-provision.record',
  'privacy.core.consent-decision.record',
  'privacy.core.consent.self-service',
  'party.registry.party.read',
];

/**
 * Authentication activation does not assign authorization membership. Explicit fixture administration first
 * verifies the real owner binding, then gives the account membership in the Tenant and its company (which is
 * what lets it select that company before it binds itself) and a role of exactly the capabilities above,
 * through the Core access writer.
 */
export const installRetainedAccountEntrypoints = Effect.fn('RetainedConsent.installAccountEntrypoints')(
  function* installRetainedAccountEntrypoints(
    account: RetainedConsentAccountTransport,
    target: TestTenantAccessTarget,
  ) {
    const bindingLookup = yield* Schema.decodeUnknownEffect(ReadPrincipalBindingPayloadSchema)({
      authBindingId: account.authBindingId,
      lookup: 'binding',
    }).pipe(Effect.mapError(() => permissionFailure(accountMembershipBindingStage)));
    const activeBinding = yield* readPrincipalBinding(bindingLookup, {
      apiKey: account.coreApiKey,
      baseUrl: new URL(shellGatewayContextContract.apiPrefix, account.coreOrigin),
      requestCorrelation: 'retained-account-membership',
    }).pipe(Effect.mapError(() => permissionFailure(accountMembershipBindingStage)));
    if (!isCurrentAccountBinding(activeBinding, account)) {
      return yield* permissionFailure(accountMembershipBindingStage);
    }
    yield* grantTestTenantRoleAccess({
      ...target,
      holders: [{ capabilityKeys: retainedConsentAccountCapabilityKeys, principalId: account.principalId }],
      legalEntityIds: [account.legalEntityId],
      tenantId: account.tenantId,
    });
    return yield* Effect.void;
  },
);

const actualAuthorityUnavailable = () =>
  new ConsentSelfServiceAuthorizationError({
    code: 'AUTHORITY_UNAVAILABLE',
    reason: 'The actual native account owner credential is unavailable',
  });

/** Both branches use the actual Shell issuer; no forwarded incoming bearer or constructed Principal is accepted. */
export const retainedOwnerCredential = (account: RetainedConsentAccountTransport, managerPrincipalId: string) =>
  Effect.fn('RetainedConsent.acquireActualOwnerCredential')(function* acquireActualOwnerCredential(
    scope: OperationalScope,
    audience: 'commerce-customer-context' | 'party-registry',
  ) {
    if (
      scope.tenantId !== account.tenantId ||
      scope.legalEntityId !== account.legalEntityId ||
      scope.impersonatedByPrincipalId !== undefined
    ) {
      return yield* actualAuthorityUnavailable();
    }
    if (
      scope.principalId === managerPrincipalId &&
      (scope.authMethod === 'api_key' || scope.authMethod === 'session') &&
      scope.authenticationNamespaceId === STAFF_AUTHENTICATION_NAMESPACE_ID
    ) {
      const issued = yield* issueApiKeyGatewayContext(
        { audience, compositionRevision: account.compositionRevision, legalEntityId: account.legalEntityId },
        {
          apiKey: account.coreApiKey,
          baseUrl: new URL(shellGatewayContextContract.apiPrefix, account.coreOrigin),
          requestCorrelation: scope.correlationId,
        },
      ).pipe(Effect.mapError(actualAuthorityUnavailable));
      if (issued.compositionRevision !== account.compositionRevision) {
        return yield* actualAuthorityUnavailable();
      }
      return {
        authorization: Redacted.make(`Bearer ${issued.token}`),
        baseUrl:
          audience === partyAudience
            ? new URL(partyRegistryApiContract.apiPrefix, account.partyOrigin).href
            : new URL(commerceCustomerContextApiContract.apiPrefix, account.commerceOrigin).href,
        compositionRevision: issued.compositionRevision,
      };
    }
    if (
      scope.principalId !== account.principalId ||
      scope.authMethod !== 'session' ||
      scope.authenticationNamespaceId !== COMMERCE_AUTHENTICATION_NAMESPACE_ID ||
      scope.authBindingId !== account.authBindingId ||
      scope.authContextRef !== account.sessionRef
    ) {
      return yield* actualAuthorityUnavailable();
    }
    const lookup = yield* Schema.decodeUnknownEffect(ReadPrincipalBindingPayloadSchema)({
      authBindingId: account.authBindingId,
      lookup: 'binding',
    }).pipe(Effect.mapError(actualAuthorityUnavailable));
    const binding = yield* readPrincipalBinding(lookup, {
      apiKey: account.coreApiKey,
      baseUrl: new URL(shellGatewayContextContract.apiPrefix, account.coreOrigin),
      requestCorrelation: scope.correlationId,
    }).pipe(Effect.mapError(actualAuthorityUnavailable));
    if (!isCurrentAccountBinding(binding, account)) {
      return yield* actualAuthorityUnavailable();
    }
    const request = yield* Schema.decodeUnknownEffect(ExternalGatewayContextRequestSchema)({
      audience,
      authenticationNamespaceId: COMMERCE_AUTHENTICATION_NAMESPACE_ID,
      authenticationRef: account.sessionRef,
      compositionRevision: account.compositionRevision,
      legalEntityId: account.legalEntityId,
      providerSubjectId: account.providerSubjectId,
      subjectType: 'user',
    }).pipe(Effect.mapError(actualAuthorityUnavailable));
    const issued = yield* issueExternalGatewayContext(request, {
      apiKey: account.coreApiKey,
      baseUrl: new URL(shellGatewayContextContract.apiPrefix, account.coreOrigin),
      requestCorrelation: scope.correlationId,
    }).pipe(Effect.mapError(actualAuthorityUnavailable));
    if (issued.compositionRevision !== account.compositionRevision) {
      return yield* actualAuthorityUnavailable();
    }
    return {
      authorization: Redacted.make(`Bearer ${issued.token}`),
      baseUrl:
        audience === partyAudience
          ? new URL(partyRegistryApiContract.apiPrefix, account.partyOrigin).href
          : new URL(commerceCustomerContextApiContract.apiPrefix, account.commerceOrigin).href,
      compositionRevision: issued.compositionRevision,
    };
  });
