import { Context, Crypto, Effect, Schema } from 'effect';

import { AuthenticationNamespaceIdSchema } from '../../src/auth/external-identity-contracts.ts';

export const staffAuthenticationNamespaceId = Schema.decodeSync(AuthenticationNamespaceIdSchema)(
  'test.staff.better-auth.v1',
);

const nextUuid = Crypto.Crypto.use((crypto) => crypto.randomUUIDv4());

export const makePermissionSuite = Effect.gen(function* makePermissionSuite() {
  const suiteId = yield* nextUuid;
  const tenantId = yield* nextUuid;
  const legalEntityId = yield* nextUuid;
  const bootstrapOwnerPrincipalId = yield* nextUuid;
  const bootstrapOwnerAuthBindingId = yield* nextUuid;
  const principalId = yield* nextUuid;
  const principalAuthBindingId = yield* nextUuid;
  const nonMemberPrincipalId = yield* nextUuid;
  const nonMemberAuthBindingId = yield* nextUuid;
  const otherTenantId = yield* nextUuid;
  const otherTenantLegalEntityId = yield* nextUuid;
  const otherTenantBootstrapOwnerPrincipalId = yield* nextUuid;
  const otherTenantBootstrapOwnerAuthBindingId = yield* nextUuid;
  const otherTenantPrincipalId = yield* nextUuid;
  const otherTenantAuthBindingId = yield* nextUuid;
  const actionPrefix = `core.shell.test.permission.case-${suiteId}`;
  const actionKeys = {
    allowed: `${actionPrefix}.allowed`,
    concurrentDenied: `${actionPrefix}.concurrent-denied`,
    crossTenantDenied: `${actionPrefix}.cross-tenant-denied`,
    denied: `${actionPrefix}.denied`,
    membershipAllowed: `${actionPrefix}.membership-allowed`,
    missing: `${actionPrefix}.missing`,
    nonMemberDenied: `${actionPrefix}.non-member-denied`,
    unavailable: `${actionPrefix}.unavailable`,
  } as const;

  const bootstrapOwnerPrincipal = {
    authBindingId: bootstrapOwnerAuthBindingId,
    authContextRef: `better-auth-session:${suiteId}:bootstrap-owner`,
    authenticationNamespaceId: staffAuthenticationNamespaceId,
    authMethod: 'session',
    principalId: bootstrapOwnerPrincipalId,
    tenantId,
  } as const;

  const principal = {
    authBindingId: principalAuthBindingId,
    authContextRef: `better-auth-session:${suiteId}:principal`,
    authenticationNamespaceId: staffAuthenticationNamespaceId,
    authMethod: 'session',
    legalEntityId,
    principalId,
    tenantId,
  } as const;

  const nonMemberPrincipal = {
    authBindingId: nonMemberAuthBindingId,
    authContextRef: `better-auth-session:${suiteId}:non-member`,
    authenticationNamespaceId: staffAuthenticationNamespaceId,
    authMethod: 'session',
    principalId: nonMemberPrincipalId,
    tenantId,
  } as const;

  const otherTenantPrincipal = {
    authBindingId: otherTenantAuthBindingId,
    authContextRef: `better-auth-session:${suiteId}:other-tenant`,
    authenticationNamespaceId: staffAuthenticationNamespaceId,
    authMethod: 'session',
    legalEntityId: otherTenantLegalEntityId,
    principalId: otherTenantPrincipalId,
    tenantId: otherTenantId,
  } as const;

  const otherTenantBootstrapOwnerPrincipal = {
    authBindingId: otherTenantBootstrapOwnerAuthBindingId,
    authContextRef: `better-auth-session:${suiteId}:other-tenant-bootstrap-owner`,
    authenticationNamespaceId: staffAuthenticationNamespaceId,
    authMethod: 'session',
    principalId: otherTenantBootstrapOwnerPrincipalId,
    tenantId: otherTenantId,
  } as const;

  return {
    actionKeys,
    actionPrefix,
    bootstrapOwnerAuthBindingId,
    bootstrapOwnerPrincipal,
    bootstrapOwnerPrincipalId,
    legalEntityId,
    nonMemberAuthBindingId,
    nonMemberPrincipal,
    nonMemberPrincipalId,
    otherTenantAuthBindingId,
    otherTenantBootstrapOwnerAuthBindingId,
    otherTenantBootstrapOwnerPrincipal,
    otherTenantBootstrapOwnerPrincipalId,
    otherTenantId,
    otherTenantLegalEntityId,
    otherTenantPrincipal,
    otherTenantPrincipalId,
    principal,
    principalAuthBindingId,
    principalId,
    tenantId,
  };
});

export type PermissionSuiteFixture = Effect.Success<typeof makePermissionSuite>;

/** Two isolated tenants with separate bootstrap owners and tested humans per permission suite run. */
export class PermissionSuite extends Context.Service<PermissionSuite, PermissionSuiteFixture>()(
  '@app/core-runtime/tests/support/action-permission-suite/PermissionSuite',
) {}
