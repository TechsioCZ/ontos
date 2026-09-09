import { expect, it } from 'effect-rstest';
import { Crypto, Effect, Layer, Predicate } from 'effect';
import { getReadHandler } from '../../../../packages/core-runtime/src/reads/definition.ts';
import {
  BusinessPermissionRelationshipMutation,
  ContextAccess,
  PrincipalEligibility,
  unavailablePrincipalEligibility,
} from '../../../../packages/core-runtime/src/index.ts';
import {
  CounterpartyAccessContractViolation,
  CounterpartyAccessUnavailable,
  CounterpartyInvitationClaimAuthority,
  CounterpartyInvitationProofDelivery,
  CounterpartyInvitationProofLifecycle,
  unavailableCounterpartyInvitationClaimAuthority,
  unavailableCounterpartyInvitationProofDelivery,
  unavailableCounterpartyInvitationProofLifecycle,
} from '../../shared/domain/access-port.ts';
import { counterpartyAccessReadPermissionTarget } from '../../src/api/access-read-support.ts';
import {
  counterpartyAccessInvitationReadRead,
  readCounterpartyAccessInvitationFromServices,
} from '../../src/api/counterparty-access-invitation-read.read.ts';
import {
  checkCounterpartyCommerceAccessFromServices,
  counterpartyCommerceAccessCheckRead,
} from '../../src/api/counterparty-commerce-access-check.read.ts';
import {
  counterpartyCommerceAccessDetailRead,
  readCounterpartyCommerceAccessDetailFromServices,
} from '../../src/api/counterparty-commerce-access-detail.read.ts';
import {
  counterpartyCommerceAccessListRead,
  listCounterpartyCommerceAccessFromServices,
} from '../../src/api/counterparty-commerce-access-list.read.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const otherTenantId = '10000000-0000-4000-8000-000000000099';
const legalEntityId = '20000000-0000-4000-8000-000000000002';
const principalId = '30000000-0000-4000-8000-000000000003';
const recipient = {
  principalId: '40000000-0000-4000-8000-000000000004',
  tenantId,
} as const;
const counterpartyRef = {
  moduleId: 'party.registry',
  resourceId: 'counterparty-1',
  resourceType: 'party.registry.counterparty',
  tenantId,
} as const;
const grantRef = {
  moduleId: 'commerce.customer-context',
  resourceId: 'grant-1',
  resourceType: 'commerce.customer-context.counterparty-commerce-access-grant',
  tenantId,
} as const;
const invitationRef = {
  moduleId: 'commerce.customer-context',
  resourceId: 'invitation-1',
  resourceType: 'commerce.customer-context.counterparty-access-invitation',
  tenantId,
} as const;
const scope = { kind: 'counterparty' } as const;
const storefrontScope = { kind: 'storefront', storefrontKey: 'storefront-1' } as const;
const grantedAt = '2026-09-09T10:00:00.000Z';

const grant = {
  catalogVersion: '1',
  counterpartyRef,
  grantedAt,
  grantedBy: { principalId, tenantId },
  grantRef,
  permission: 'counterparty.purchase.prepare',
  recipient,
  revision: 1,
  scope,
  state: 'ACTIVE',
} as const;

const invitation = {
  catalogVersion: '1',
  claimProofVersion: 'commerce-invitation-proof.v1',
  counterpartyRef,
  createdAt: grantedAt,
  deliveryMethod: 'VERIFIED_CONTACT_POINT',
  deliveryReference: 'contact-point-ref-1',
  expiresAt: '2026-09-10T10:00:00.000Z',
  grantProgress: [],
  intendedPermissions: ['counterparty.purchase.prepare'],
  invitationRef,
  invitedBy: { principalId, tenantId },
  reason: 'Onboard buyer',
  revision: 1,
  scope,
  state: 'PENDING',
} as const;

const operationalScope = Object.freeze({
  authMethod: 'system' as const,
  correlationId: 'access-read-contract',
  legalEntityId,
  principalId,
  tenantId,
});
const testCrypto = Crypto.make({
  digest: () => Effect.succeed(new Uint8Array(32)),
  randomBytes: (size) => new Uint8Array(size),
});
const unusedAccessDependencies = Layer.mergeAll(
  Layer.succeed(BusinessPermissionRelationshipMutation, {
    mutate: () => Effect.void,
  }),
  Layer.succeed(ContextAccess, {
    businessPermissions: () => Effect.succeed([]),
    legalEntities: () => Effect.succeed([]),
    modules: () => Effect.succeed([]),
    resources: () => Effect.succeed([]),
    tenants: () => Effect.succeed([]),
  }),
  Layer.succeed(PrincipalEligibility, unavailablePrincipalEligibility()),
  Layer.succeed(
    CounterpartyInvitationClaimAuthority,
    unavailableCounterpartyInvitationClaimAuthority('not used by the injected Read test service'),
  ),
  Layer.succeed(
    CounterpartyInvitationProofDelivery,
    unavailableCounterpartyInvitationProofDelivery('not used by the injected Read test service'),
  ),
  Layer.succeed(
    CounterpartyInvitationProofLifecycle,
    unavailableCounterpartyInvitationProofLifecycle('not used by the injected Read test service'),
  ),
  Layer.succeed(Crypto.Crypto, testCrypto),
);
const provideUnusedAccessPort = Effect.provide(unusedAccessDependencies);

const unavailableFailure = () =>
  new CounterpartyAccessUnavailable({
    code: 'counterparty_access_unavailable',
    reason: 'private adapter detail',
  });

const violationFailure = () =>
  new CounterpartyAccessContractViolation({
    code: 'counterparty_scope_mismatch',
    reason: 'private contract detail',
  });

it.effect('returns exact allowed and denied decisions and maps unavailable checks closed', () =>
  Effect.gen(function* checkReadOutcomes() {
    const input = {
      counterpartyRef,
      permission: 'counterparty.purchase.prepare' as const,
      scope,
    };
    for (const decision of ['ALLOWED', 'DENIED'] as const) {
      expect(
        yield* checkCounterpartyCommerceAccessFromServices(input, principalId, tenantId, {
          check: () => Effect.succeed(decision),
        }),
      ).toEqual({ decision });
    }

    const failure = yield* Effect.flip(
      checkCounterpartyCommerceAccessFromServices(input, principalId, tenantId, {
        check: () => Effect.fail(unavailableFailure()),
      }),
    );
    expect(Predicate.isTagged(failure, 'ReadHandlerUnavailable')).toBe(true);
  }).pipe(provideUnusedAccessPort),
);

it.effect('rejects cross-tenant checks before consulting the access adapter', () =>
  Effect.gen(function* checkTenantIsolation() {
    let called = false;
    const failure = yield* Effect.flip(
      checkCounterpartyCommerceAccessFromServices(
        {
          counterpartyRef: { ...counterpartyRef, tenantId: otherTenantId },
          permission: 'counterparty.purchase.prepare',
          scope,
        },
        principalId,
        tenantId,
        {
          check: () => {
            called = true;
            return Effect.succeed('ALLOWED');
          },
        },
      ),
    );
    expect(Predicate.isTagged(failure, 'ReadHandlerNotFound')).toBe(true);
    expect(called).toBe(false);
  }).pipe(provideUnusedAccessPort),
);

it.effect(
  'filters list results to the requested counterparty, recipient, and storefront scope',
  () =>
    Effect.gen(function* listIsolation() {
      const storefrontGrant = {
        ...grant,
        grantRef: { ...grantRef, resourceId: 'grant-storefront' },
        scope: storefrontScope,
      };
      const grants = [
        grant,
        storefrontGrant,
        {
          ...grant,
          grantRef: { ...grantRef, resourceId: 'grant-other-storefront' },
          scope: { kind: 'storefront' as const, storefrontKey: 'storefront-2' },
        },
        {
          ...grant,
          counterpartyRef: { ...counterpartyRef, resourceId: 'counterparty-2' },
          grantRef: { ...grantRef, resourceId: 'grant-other-counterparty' },
        },
        {
          ...grant,
          grantRef: { ...grantRef, resourceId: 'grant-other-recipient' },
          recipient: { ...recipient, principalId: '40000000-0000-4000-8000-000000000099' },
        },
      ] as const;
      const result = yield* listCounterpartyCommerceAccessFromServices(
        { counterpartyRef, recipient, scope: storefrontScope },
        principalId,
        legalEntityId,
        tenantId,
        { list: () => Effect.succeed(grants) },
      );
      expect(result.grants.map(({ grantRef: ref }) => ref.resourceId)).toEqual([
        'grant-1',
        'grant-storefront',
      ]);

      const failure = yield* Effect.flip(
        listCounterpartyCommerceAccessFromServices(
          { counterpartyRef, recipient: { ...recipient, tenantId: otherTenantId }, scope },
          principalId,
          legalEntityId,
          tenantId,
          { list: () => Effect.succeed(grants) },
        ),
      );
      expect(Predicate.isTagged(failure, 'ReadHandlerNotFound')).toBe(true);
    }),
);

it.effect('maps list adapter violations and unavailability to a closed unavailable result', () =>
  Effect.gen(function* listFailures() {
    for (const adapterFailure of [violationFailure(), unavailableFailure()]) {
      const failure = yield* Effect.flip(
        listCounterpartyCommerceAccessFromServices(
          { counterpartyRef, scope },
          principalId,
          legalEntityId,
          tenantId,
          { list: () => Effect.fail(adapterFailure) },
        ),
      );
      expect(Predicate.isTagged(failure, 'ReadHandlerUnavailable')).toBe(true);
    }
  }).pipe(provideUnusedAccessPort),
);

it.effect('returns grant detail only when tenant, counterparty, grant, and scope all match', () =>
  Effect.gen(function* detailIsolation() {
    expect(
      yield* readCounterpartyCommerceAccessDetailFromServices(
        { counterpartyRef, grantRef, scope },
        principalId,
        legalEntityId,
        tenantId,
        { list: () => Effect.succeed([grant]) },
      ),
    ).toEqual({ grant });
    expect(
      yield* readCounterpartyCommerceAccessDetailFromServices(
        { counterpartyRef, grantRef, scope: storefrontScope },
        principalId,
        legalEntityId,
        tenantId,
        { list: () => Effect.succeed([grant]) },
      ),
    ).toEqual({ grant });

    const leakingInputs = [
      { counterpartyRef: { ...counterpartyRef, tenantId: otherTenantId }, grantRef, scope },
      { counterpartyRef, grantRef: { ...grantRef, tenantId: otherTenantId }, scope },
      { counterpartyRef: { ...counterpartyRef, resourceId: 'counterparty-2' }, grantRef, scope },
    ] as const;
    for (const input of leakingInputs) {
      const failure = yield* Effect.flip(
        readCounterpartyCommerceAccessDetailFromServices(
          input,
          principalId,
          legalEntityId,
          tenantId,
          { list: () => Effect.succeed([grant]) },
        ),
      );
      expect(Predicate.isTagged(failure, 'ReadHandlerNotFound')).toBe(true);
    }
    const storefrontGrant = { ...grant, scope: storefrontScope } as const;
    const scopeMismatch = yield* Effect.flip(
      readCounterpartyCommerceAccessDetailFromServices(
        { counterpartyRef, grantRef, scope },
        principalId,
        legalEntityId,
        tenantId,
        { list: () => Effect.succeed([storefrontGrant]) },
      ),
    );
    expect(Predicate.isTagged(scopeMismatch, 'ReadHandlerNotFound')).toBe(true);
  }),
);

it.effect('maps grant-detail adapter failures to unavailable', () =>
  Effect.gen(function* detailFailure() {
    const failure = yield* Effect.flip(
      readCounterpartyCommerceAccessDetailFromServices(
        { counterpartyRef, grantRef, scope },
        principalId,
        legalEntityId,
        tenantId,
        { list: () => Effect.fail(unavailableFailure()) },
      ),
    );
    expect(Predicate.isTagged(failure, 'ReadHandlerUnavailable')).toBe(true);
  }),
);

it.effect('returns invitations only inside the trusted tenant, counterparty, and scope', () =>
  Effect.gen(function* invitationIsolation() {
    expect(
      yield* readCounterpartyAccessInvitationFromServices(
        { counterpartyRef, invitationRef, scope },
        principalId,
        legalEntityId,
        tenantId,
        { getInvitation: () => Effect.succeed(invitation) },
      ),
    ).toEqual({ invitation });
    expect(
      yield* readCounterpartyAccessInvitationFromServices(
        { counterpartyRef, invitationRef, scope: storefrontScope },
        principalId,
        legalEntityId,
        tenantId,
        { getInvitation: () => Effect.succeed(invitation) },
      ),
    ).toEqual({ invitation });

    const leakingInputs = [
      { counterpartyRef: { ...counterpartyRef, tenantId: otherTenantId }, invitationRef, scope },
      { counterpartyRef, invitationRef: { ...invitationRef, tenantId: otherTenantId }, scope },
      {
        counterpartyRef: { ...counterpartyRef, resourceId: 'counterparty-2' },
        invitationRef,
        scope,
      },
    ] as const;
    for (const input of leakingInputs) {
      const failure = yield* Effect.flip(
        readCounterpartyAccessInvitationFromServices(input, principalId, legalEntityId, tenantId, {
          getInvitation: () => Effect.succeed(invitation),
        }),
      );
      expect(Predicate.isTagged(failure, 'ReadHandlerNotFound')).toBe(true);
    }
    const storefrontInvitation = { ...invitation, scope: storefrontScope } as const;
    const scopeMismatch = yield* Effect.flip(
      readCounterpartyAccessInvitationFromServices(
        { counterpartyRef, invitationRef, scope },
        principalId,
        legalEntityId,
        tenantId,
        { getInvitation: () => Effect.succeed(storefrontInvitation) },
      ),
    );
    expect(Predicate.isTagged(scopeMismatch, 'ReadHandlerNotFound')).toBe(true);

    const failure = yield* Effect.flip(
      readCounterpartyAccessInvitationFromServices(
        { counterpartyRef, invitationRef, scope },
        principalId,
        legalEntityId,
        tenantId,
        { getInvitation: () => Effect.fail(violationFailure()) },
      ),
    );
    expect(Predicate.isTagged(failure, 'ReadHandlerUnavailable')).toBe(true);
  }),
);

const scopeWithoutLegalEntity = {
  authMethod: operationalScope.authMethod,
  correlationId: operationalScope.correlationId,
  principalId: operationalScope.principalId,
  tenantId: operationalScope.tenantId,
};

it.effect('fails closed when the access-list handler lacks Legal Entity context', () =>
  Effect.gen(function* missingListLegalEntity() {
    const unavailable = yield* getReadHandler(counterpartyCommerceAccessListRead)(
      { counterpartyRef, scope },
      {
        readKey: counterpartyCommerceAccessListRead.descriptor.readKey,
        scope: scopeWithoutLegalEntity,
        services: { list: () => Effect.succeed([grant]) },
      },
    ).pipe(
      Effect.match({
        onFailure: (failure) => Predicate.isTagged(failure, 'ReadHandlerUnavailable'),
        onSuccess: () => false,
      }),
    );
    expect(unavailable).toBe(true);
  }).pipe(provideUnusedAccessPort),
);

it.effect('fails closed when the access-detail handler lacks Legal Entity context', () =>
  Effect.gen(function* missingDetailLegalEntity() {
    const unavailable = yield* getReadHandler(counterpartyCommerceAccessDetailRead)(
      { counterpartyRef, grantRef, scope },
      {
        readKey: counterpartyCommerceAccessDetailRead.descriptor.readKey,
        scope: scopeWithoutLegalEntity,
        services: { list: () => Effect.succeed([grant]) },
      },
    ).pipe(
      Effect.match({
        onFailure: (failure) => Predicate.isTagged(failure, 'ReadHandlerUnavailable'),
        onSuccess: () => false,
      }),
    );
    expect(unavailable).toBe(true);
  }).pipe(provideUnusedAccessPort),
);

it.effect('fails closed when the invitation handler lacks Legal Entity context', () =>
  Effect.gen(function* missingInvitationLegalEntity() {
    const unavailable = yield* getReadHandler(counterpartyAccessInvitationReadRead)(
      { counterpartyRef, invitationRef, scope },
      {
        readKey: counterpartyAccessInvitationReadRead.descriptor.readKey,
        scope: scopeWithoutLegalEntity,
        services: { getInvitation: () => Effect.succeed(invitation) },
      },
    ).pipe(
      Effect.match({
        onFailure: (failure) => Predicate.isTagged(failure, 'ReadHandlerUnavailable'),
        onSuccess: () => false,
      }),
    );
    expect(unavailable).toBe(true);
    expect(counterpartyCommerceAccessCheckRead.descriptor.legalEntityScope).toBe('required');
  }).pipe(provideUnusedAccessPort),
);

it('derives safe counterparty targets and only forwards gateway-verified Storefront identity', () => {
  expect(
    counterpartyAccessReadPermissionTarget({ counterpartyRef, scope }, operationalScope),
  ).toEqual({
    businessPermission: {
      permission: 'counterparty.access.read',
      target: {
        counterpartyId: counterpartyRef.resourceId,
        kind: 'counterparty',
        legalEntityId,
        tenantId,
      },
    },
    kind: 'business_permission',
  });

  const storefrontTarget = counterpartyAccessReadPermissionTarget(
    { counterpartyRef, scope: storefrontScope },
    operationalScope,
  );
  expect(storefrontTarget.businessPermission.target).toEqual({
    counterpartyId: counterpartyRef.resourceId,
    kind: 'counterparty_storefront',
    legalEntityId,
    storefrontId: storefrontScope.storefrontKey,
    tenantId,
  });
  expect(storefrontTarget).not.toHaveProperty('trustedStorefrontId');

  const trustedStorefrontTarget = counterpartyAccessReadPermissionTarget(
    { counterpartyRef, scope: storefrontScope },
    { ...operationalScope, trustedStorefrontId: storefrontScope.storefrontKey },
  );
  expect(trustedStorefrontTarget).toHaveProperty(
    'trustedStorefrontId',
    storefrontScope.storefrontKey,
  );

  const mismatchedStorefrontTarget = counterpartyAccessReadPermissionTarget(
    { counterpartyRef, scope: storefrontScope },
    { ...operationalScope, trustedStorefrontId: 'storefront-2' },
  );
  expect(mismatchedStorefrontTarget).toHaveProperty('trustedStorefrontId', 'storefront-2');
  expect(mismatchedStorefrontTarget.businessPermission.target).toHaveProperty(
    'storefrontId',
    storefrontScope.storefrontKey,
  );
});
