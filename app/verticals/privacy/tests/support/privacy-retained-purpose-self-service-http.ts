import { partyRegistryApiContract } from '@app/party-registry/api';
import { shellGatewayContextContract } from '@app/shared-contracts';
import {
  toLegalEntityAccessObjectId,
  toModuleAccessObjectId,
  toResourceAccessObjectId,
  toSpiceDbActionObjectId,
} from '@app/core-runtime';
import type { PartyRef } from '@app/party-registry/resources/party';
import { deadlineInterceptor, v1 } from '@authzed/authzed-node';
import { Config, Effect, Redacted, Schema } from 'effect';
import type { OperationalScope } from '@app/core-runtime';
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

import {
  buildActionAuthorizationRelationships,
  buildActionAuthorizationRoleGrantRelationships,
} from '../../../../packages/core-runtime/src/install/action-authorization-provisioning.ts';
import { toScopedRoleObjectId } from '../../../../packages/core-runtime/src/permissions/scoped-role.ts';

const commerceModuleKey = 'commerce.customer-context';
const privacyModuleKey = 'privacy.core';
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
/** Exact fixture role policy; Action identity and scope links use the canonical Core builders. */
export const buildRetainedConsentAccountActionRelationships = (
  account: Pick<RetainedConsentAccountTransport, 'legalEntityId' | 'principalId' | 'tenantId'>,
): readonly v1.Relationship[] => {
  const { legalEntityId, principalId, tenantId } = account;
  const roleKey = `retained-consent-account:${principalId}`;
  const scope = { legalEntityId, tenantId };
  const actions = retainedConsentAccountActionKeys.map((actionKey) => ({ ...scope, actionKey }));
  return [
    ...buildActionAuthorizationRelationships(actions),
    ...buildActionAuthorizationRoleGrantRelationships(
      actions.map((action) => ({ ...action, roleKey })),
      [{ ...scope, moduleKeys: [commerceModuleKey, privacyModuleKey] }],
    ),
    v1.Relationship.create({
      relation: 'member',
      resource: { objectId: toScopedRoleObjectId({ ...scope, roleKey }), objectType: 'scoped_role' },
      subject: { object: { objectId: principalId, objectType: 'principal' } },
    }),
  ];
};

class RetainedAccountPermissionError extends Schema.TaggedError<RetainedAccountPermissionError>()(
  'RetainedAccountPermissionError',
  { stage: Schema.String },
) {}
const permissionFailure = (stage: string) => new RetainedAccountPermissionError({ stage });
const partyAudience = 'party-registry';
const partyModuleKey = 'party.registry';
const fullyConsistent = () =>
  v1.Consistency.create({
    requirement: { fullyConsistent: true, oneofKind: 'fullyConsistent' },
  });
const exactRelationshipFilter = (relationship: v1.Relationship) => {
  const { resource, subject } = relationship;
  if (resource === undefined || subject?.object === undefined) {
    return Effect.fail(permissionFailure('invalid-owned-relationship'));
  }
  return Effect.succeed(
    v1.RelationshipFilter.create({
      optionalRelation: relationship.relation,
      optionalResourceId: resource.objectId,
      optionalSubjectFilter: {
        optionalRelation: { relation: subject.optionalRelation },
        optionalSubjectId: subject.object.objectId,
        subjectType: subject.object.objectType,
      },
      resourceType: resource.objectType,
    }),
  );
};
const assertAccountPermission = Effect.fn('RetainedConsent.assertActualPermission')(function* assertAccountPermission(
  client: v1.ZedClientInterface,
  resource: v1.ObjectReference,
  permission: string,
  principalId: string,
  expected: v1.CheckPermissionResponse_Permissionship,
) {
  const result = yield* Effect.tryPromise({
    catch: () => permissionFailure('permission-observation'),
    try: async () =>
      await client.promises.checkPermission(
        v1.CheckPermissionRequest.create({
          consistency: fullyConsistent(),
          permission,
          resource,
          subject: { object: { objectId: principalId, objectType: 'principal' } },
        }),
      ),
  });
  if (result.permissionship !== expected) {
    return yield* permissionFailure('permission-not-exact');
  }
  return yield* Effect.void;
});

/** Public SDK TEST setup. Existing owner tuples are observed and never entered in the deletion ledger. */
const openRetainedPermissionClient = Effect.fn('RetainedConsent.openPermissionClient')(
  function* openRetainedPermissionClient() {
    const endpoint = yield* Config.schema(
      Schema.String.check(Schema.isPattern(/^(?:localhost|127\.0\.0\.1):[0-9]{1,5}$/u)),
      'SPICEDB_ENDPOINT',
    );
    const certificate = yield* Config.schema(Schema.NonEmptyString, 'SPICEDB_CA_CERT');
    const key = yield* Config.Redacted('SPICEDB_PRESHARED_KEY');
    return yield* Effect.acquireRelease(
      Effect.try({
        catch: () => permissionFailure('permission-client'),
        try: () =>
          v1.NewClientWithCustomCert(Redacted.value(key), endpoint, Buffer.from(certificate), undefined, {
            interceptors: [deadlineInterceptor(5000)],
          }),
      }),
      (value) => Effect.sync(() => value.close()),
    );
  },
);

const installRetainedOwnedRelationships = Effect.fn('RetainedConsent.installOwnedRelationships')(
  function* installRetainedOwnedRelationships(
    client: v1.ZedClientInterface,
    relationships: readonly v1.Relationship[],
  ) {
    const owned: v1.Relationship[] = [];
    for (const relationship of relationships) {
      const filter = yield* exactRelationshipFilter(relationship);
      const existing = yield* Effect.tryPromise({
        catch: () => permissionFailure('owned-relationship-observation'),
        try: async () =>
          await client.promises.readRelationships(
            v1.ReadRelationshipsRequest.create({
              consistency: fullyConsistent(),
              relationshipFilter: filter,
            }),
          ),
      });
      if (existing.length === 0) {
        owned.push(relationship);
      }
    }
    const write = (operation: v1.RelationshipUpdate_Operation) =>
      Effect.tryPromise({
        catch: () => permissionFailure('owned-relationship-write'),
        try: async () =>
          await client.promises.writeRelationships(
            v1.WriteRelationshipsRequest.create({
              updates: owned.map((relationship) => v1.RelationshipUpdate.create({ operation, relationship })),
            }),
          ),
      });
    // The complete absence-checked ledger exists before the uncertain write. No broad delete, tenant executor or business grant.
    if (owned.length > 0) {
      yield* Effect.addFinalizer(() => write(v1.RelationshipUpdate_Operation.DELETE).pipe(Effect.orDie));
      yield* write(v1.RelationshipUpdate_Operation.TOUCH);
    }
    return yield* Effect.void;
  },
);

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

/** Manager Party read is setup for the actual public Subject producer, with the same exact owned ledger. */
export const installRetainedAccountEntrypoints = Effect.fn('RetainedConsent.installAccountEntrypoints')(
  function* installRetainedAccountEntrypoints(
    account: RetainedConsentAccountTransport,
    deniedPrincipalId: string,
    partyRef: PartyRef,
  ) {
    const client = yield* openRetainedPermissionClient();
    if (partyRef.tenantId !== account.tenantId || deniedPrincipalId === account.principalId) {
      return yield* permissionFailure('permission-target');
    }
    // Authentication activation does not assign authorization membership. Explicit fixture
    // administration first verifies the real owner binding, then owns only this exact member edge.
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
    yield* installRetainedOwnedRelationships(client, [
      v1.Relationship.create({
        relation: 'member',
        resource: { objectId: account.tenantId, objectType: 'tenant' },
        subject: { object: { objectId: account.principalId, objectType: 'principal' } },
      }),
    ]);
    yield* assertAccountPermission(
      client,
      v1.ObjectReference.create({ objectId: account.tenantId, objectType: 'tenant' }),
      'access',
      account.principalId,
      v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION,
    );
    const legalEntityId = toLegalEntityAccessObjectId(account.tenantId, account.legalEntityId);
    const partyModuleId = toModuleAccessObjectId(account.tenantId, account.legalEntityId, partyModuleKey);
    const partyObjectId = toResourceAccessObjectId(account.tenantId, account.legalEntityId, partyRef);
    if (legalEntityId === undefined || partyModuleId === undefined || partyObjectId === undefined) {
      return yield* permissionFailure('permission-object');
    }
    const subject = { object: { objectId: account.principalId, objectType: 'principal' } };
    // The published Party detail Read requires this Tenant permission. Resource reader
    // tuples alone do not authorize it; this is explicit fixture administration.
    const relationships = [
      v1.Relationship.create({
        relation: 'party_identity_reader',
        resource: { objectId: account.tenantId, objectType: 'tenant' },
        subject,
      }),
      v1.Relationship.create({
        relation: 'member',
        resource: { objectId: legalEntityId, objectType: 'legal_entity' },
        subject,
      }),
      ...buildRetainedConsentAccountActionRelationships(account),
      v1.Relationship.create({
        relation: 'module',
        resource: { objectId: partyObjectId, objectType: 'resource' },
        subject: { object: { objectId: partyModuleId, objectType: 'module_access' } },
      }),
      v1.Relationship.create({
        relation: 'reader',
        resource: { objectId: partyObjectId, objectType: 'resource' },
        subject,
      }),
    ];
    for (const moduleId of [commerceModuleKey, partyModuleKey, privacyModuleKey]) {
      const objectId = toModuleAccessObjectId(account.tenantId, account.legalEntityId, moduleId);
      if (objectId === undefined) {
        return yield* permissionFailure('module-object');
      }
      relationships.push(
        v1.Relationship.create({
          relation: 'legal_entity',
          resource: { objectId, objectType: 'module_access' },
          subject: { object: { objectId: legalEntityId, objectType: 'legal_entity' } },
        }),
        v1.Relationship.create({ relation: 'accessor', resource: { objectId, objectType: 'module_access' }, subject }),
      );
    }
    yield* installRetainedOwnedRelationships(client, relationships);
    for (const [principalId, expected] of [
      [account.principalId, v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION],
      [deniedPrincipalId, v1.CheckPermissionResponse_Permissionship.NO_PERMISSION],
    ] as const) {
      yield* assertAccountPermission(
        client,
        v1.ObjectReference.create({ objectId: account.tenantId, objectType: 'tenant' }),
        'read_party_identity',
        principalId,
        expected,
      );
    }
    for (const permission of ['manage_party_identity', 'review_party_identity', 'merge_party_identity']) {
      yield* assertAccountPermission(
        client,
        v1.ObjectReference.create({ objectId: account.tenantId, objectType: 'tenant' }),
        permission,
        account.principalId,
        v1.CheckPermissionResponse_Permissionship.NO_PERMISSION,
      );
    }
    for (const actionKey of retainedConsentAccountActionKeys) {
      const resource = v1.ObjectReference.create({
        objectId: toSpiceDbActionObjectId({
          actionKey,
          legalEntityId: account.legalEntityId,
          tenantId: account.tenantId,
        }),
        objectType: 'action',
      });
      yield* assertAccountPermission(
        client,
        resource,
        'execute',
        account.principalId,
        v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION,
      );
      yield* assertAccountPermission(
        client,
        resource,
        'execute',
        deniedPrincipalId,
        v1.CheckPermissionResponse_Permissionship.NO_PERMISSION,
      );
    }
    for (const moduleId of [commerceModuleKey, partyModuleKey, privacyModuleKey]) {
      const objectId = toModuleAccessObjectId(account.tenantId, account.legalEntityId, moduleId);
      if (objectId === undefined) {
        return yield* permissionFailure('module-verification-object');
      }
      yield* assertAccountPermission(
        client,
        v1.ObjectReference.create({ objectId, objectType: 'module_access' }),
        'access',
        account.principalId,
        v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION,
      );
    }
    return yield* Effect.void;
  },
);

export const installRetainedManagerPartyRead = Effect.fn('RetainedConsent.installManagerPartyRead')(
  function* installRetainedManagerPartyRead(
    scope: { readonly legalEntityId: string; readonly principalId: string; readonly tenantId: string },
    partyRef: PartyRef,
  ) {
    if (scope.tenantId !== partyRef.tenantId) {
      return yield* permissionFailure('manager-party-target');
    }
    const objectId = toResourceAccessObjectId(scope.tenantId, scope.legalEntityId, partyRef);
    const moduleId = toModuleAccessObjectId(scope.tenantId, scope.legalEntityId, partyModuleKey);
    if (objectId === undefined || moduleId === undefined) {
      return yield* permissionFailure('manager-party-object');
    }
    const client = yield* openRetainedPermissionClient();
    yield* installRetainedOwnedRelationships(client, [
      v1.Relationship.create({
        relation: 'module',
        resource: { objectId, objectType: 'resource' },
        subject: { object: { objectId: moduleId, objectType: 'module_access' } },
      }),
      v1.Relationship.create({
        relation: 'reader',
        resource: { objectId, objectType: 'resource' },
        subject: { object: { objectId: scope.principalId, objectType: 'principal' } },
      }),
    ]);
    yield* assertAccountPermission(
      client,
      v1.ObjectReference.create({ objectId, objectType: 'resource' }),
      'read',
      scope.principalId,
      v1.CheckPermissionResponse_Permissionship.HAS_PERMISSION,
    );
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
