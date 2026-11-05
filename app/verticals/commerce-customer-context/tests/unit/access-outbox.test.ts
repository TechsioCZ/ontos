import { expect, it } from 'effect-rstest';
import { Crypto, Effect, Layer, Schema } from 'effect';
import { createActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import type { ActionCollector } from '../../../../packages/core-runtime/src/actions/collector.ts';
import { AccessPortalProjection } from '@app/core-runtime/access/portal';
import { getActionHandler } from '@app/core-runtime/testing/actions';
import type { DomainEventContractMap } from '../../../../packages/core-runtime/src/actions/events.ts';
import {
  ContextAccess,
  PrincipalEligibility,
  trustVerifiedGatewayPrincipalContext,
  unavailablePrincipalEligibility,
} from '../../../../packages/core-runtime/src/index.ts';
import {
  CounterpartyAccessContractViolation,
  CounterpartyInvitationClaimAuthority,
  CounterpartyInvitationProofDelivery,
  CounterpartyInvitationProofLifecycle,
  unavailableCounterpartyInvitationClaimAuthority,
  unavailableCounterpartyInvitationProofDelivery,
  unavailableCounterpartyInvitationProofLifecycle,
} from '../../shared/domain/access-port.ts';
import {
  CounterpartyAccessAdministratorBootstrappedEventPayloadSchema,
  CounterpartyAccessGrantedEventPayloadSchema,
  CounterpartyAccessInvitationClaimedEventPayloadSchema,
  CounterpartyAccessInvitationCreatedEventPayloadSchema,
  CounterpartyAccessInvitationResentEventPayloadSchema,
  CounterpartyAccessInvitationRevokedEventPayloadSchema,
  CounterpartyAccessRevokedEventPayloadSchema,
} from '../../shared/domain/access-outbox-contract.ts';
import { bootstrapCounterpartyAccessAdministratorAction } from '../../src/actions/bootstrap-counterparty-access-administrator.action.ts';
import { claimCounterpartyAccessInvitationAction } from '../../src/actions/claim-counterparty-access-invitation.action.ts';
import { createCounterpartyAccessInvitationAction } from '../../src/actions/create-counterparty-access-invitation.action.ts';
import { grantCounterpartyCommerceAccessAction } from '../../src/actions/grant-counterparty-commerce-access.action.ts';
import { resendCounterpartyAccessInvitationAction } from '../../src/actions/resend-counterparty-access-invitation.action.ts';
import { revokeCounterpartyAccessInvitationAction } from '../../src/actions/revoke-counterparty-access-invitation.action.ts';
import { revokeCounterpartyCommerceAccessAction } from '../../src/actions/revoke-counterparty-commerce-access.action.ts';

const compositionRevision = 'a'.repeat(64);

const tenantId = '10000000-0000-4000-8000-000000000001';
const legalEntityId = '20000000-0000-4000-8000-000000000002';
const actor = {
  principalId: '30000000-0000-4000-8000-000000000003',
  tenantId,
} as const;
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
const grantedAt = '2026-09-09T10:00:00.000Z';
const expiresAt = '2026-09-10T10:00:00.000Z';
const actionInvocationId = '50000000-0000-4000-8000-000000000005';
const testCrypto = Crypto.make({
  digest: () => Effect.succeed(new Uint8Array(32)),
  randomBytes: (size) => new Uint8Array(size),
});
const unusedAccessDependencies = Layer.mergeAll(
  Layer.succeed(ContextAccess, {
    legalEntities: () => Effect.succeed([]),
    modules: () => Effect.succeed([]),
    ownerPermissions: () => Effect.succeed([]),
    resources: () => Effect.succeed([]),
    tenants: () => Effect.succeed([]),
  }),
  Layer.succeed(PrincipalEligibility, unavailablePrincipalEligibility()),
  Layer.succeed(
    CounterpartyInvitationClaimAuthority,
    unavailableCounterpartyInvitationClaimAuthority('not used by the injected test service'),
  ),
  Layer.succeed(
    CounterpartyInvitationProofDelivery,
    unavailableCounterpartyInvitationProofDelivery('not used by the injected test service'),
  ),
  Layer.succeed(
    CounterpartyInvitationProofLifecycle,
    unavailableCounterpartyInvitationProofLifecycle('not used by the injected test service'),
  ),
  Layer.succeed(Crypto.Crypto, testCrypto),
  Layer.succeed(AccessPortalProjection, { project: () => Effect.die('A handler never reconciles the engine') }),
);
const provideUnusedAccessPort = Effect.provide(unusedAccessDependencies);

const expectSingleEvent = (
  material: {
    readonly domainEvents: readonly unknown[];
    readonly outboxMessages: readonly {
      readonly domainEventIndex: number;
      readonly message: { readonly topic: string };
    }[];
  },
  topic: string,
) => {
  expect(material.domainEvents).toHaveLength(1);
  expect(material.outboxMessages).toHaveLength(1);
  expect(material.outboxMessages[0]?.domainEventIndex).toBe(0);
  expect(material.outboxMessages[0]?.message.topic).toBe(topic);
};

const commonGrantPayload = {
  catalogVersion: '1',
  counterpartyRef,
  grantRef,
  permission: 'counterparty.purchase.prepare',
  recipient,
  revision: 1,
  scope,
} as const;

const commonInvitationPayload = {
  catalogVersion: '1',
  counterpartyRef,
  invitationRef,
  revision: 1,
  scope,
} as const;

const invitation = {
  ...commonInvitationPayload,
  claimProofVersion: 'commerce-invitation-proof.v1',
  createdAt: grantedAt,
  deliveryMethod: 'VERIFIED_CONTACT_POINT',
  deliveryReference: 'contact-point-ref-1',
  expiresAt,
  grantProgress: [
    {
      permission: 'counterparty.purchase.prepare',
      state: 'PENDING_GRANT',
    },
  ],
  intendedPermissions: ['counterparty.purchase.prepare'],
  invitedBy: actor,
  reason: 'Onboard buyer',
  state: 'PENDING',
} as const;

const actionContext = <DomainEvents extends DomainEventContractMap, Services>(
  collector: ActionCollector<DomainEvents>,
  services: Services,
  principalId: string = actor.principalId,
) => ({
  actionInvocationId,
  addDomainEvent: collector.addDomainEvent,
  addOutboxMessage: collector.addOutboxMessage,
  compositionRevision,
  recordAuditEvidence: collector.recordAuditEvidence,
  recordDataAccess: collector.recordDataAccess,
  scope: trustVerifiedGatewayPrincipalContext(
    {
      authBindingId: '80000000-0000-4000-8000-000000000008',
      authContextRef: 'better-auth-api-key:access-outbox-contract',
      authMethod: 'api_key' as const,
      correlationId: 'access-outbox-contract',
      legalEntityId,
      principalId,
      tenantId,
    },
    compositionRevision,
  ),
  services,
});

const accessActions = [
  grantCounterpartyCommerceAccessAction,
  revokeCounterpartyCommerceAccessAction,
  bootstrapCounterpartyAccessAdministratorAction,
  createCounterpartyAccessInvitationAction,
  resendCounterpartyAccessInvitationAction,
  revokeCounterpartyAccessInvitationAction,
  claimCounterpartyAccessInvitationAction,
] as const;

it('publishes exact, secret-safe access event contracts', () => {
  const eventContracts = [
    [CounterpartyAccessGrantedEventPayloadSchema, { ...commonGrantPayload, grantedAt, grantedBy: actor }],
    [CounterpartyAccessRevokedEventPayloadSchema, { ...commonGrantPayload, revokedAt: grantedAt, revokedBy: actor }],
    [
      CounterpartyAccessAdministratorBootstrappedEventPayloadSchema,
      {
        ...commonGrantPayload,
        bootstrappedAt: grantedAt,
        bootstrappedBy: actor,
        permission: 'counterparty.access.manage',
      },
    ],
    [
      CounterpartyAccessInvitationCreatedEventPayloadSchema,
      {
        ...commonInvitationPayload,
        createdAt: grantedAt,
        deliveryMethod: 'VERIFIED_CONTACT_POINT',
        deliveryReference: 'contact-point-ref-1',
        expiresAt,
        intendedPermissions: ['counterparty.purchase.prepare'],
        invitedBy: actor,
      },
    ],
    [
      CounterpartyAccessInvitationResentEventPayloadSchema,
      {
        ...commonInvitationPayload,
        deliveryMethod: 'VERIFIED_CONTACT_POINT',
        deliveryReference: 'contact-point-ref-1',
        expiresAt: '2026-09-10T10:00:00.000Z',
        resentBy: actor,
      },
    ],
    [CounterpartyAccessInvitationRevokedEventPayloadSchema, { ...commonInvitationPayload, revokedBy: actor }],
    [
      CounterpartyAccessInvitationClaimedEventPayloadSchema,
      {
        ...commonInvitationPayload,
        attestationReference: 'claim-attestation-ref-1',
        claimedBy: recipient,
        grantProgress: [
          {
            grantRef,
            permission: 'counterparty.purchase.prepare',
            state: 'ACTIVE',
          },
        ],
        intendedPermissions: ['counterparty.purchase.prepare'],
        verifiedAt: grantedAt,
      },
    ],
  ] as const;

  expect(eventContracts).toHaveLength(7);
  for (const [schema, payload] of eventContracts) {
    expect(Schema.is(schema)(payload)).toBe(true);
    for (const forbiddenKey of ['claimProofRef', 'claimProofReference', 'invitationSecret', 'invitationToken']) {
      expect(() =>
        Schema.decodeUnknownSync(schema, { onExcessProperty: 'error' })({
          ...payload,
          [forbiddenKey]: 'must-never-enter-an-event',
        }),
      ).toThrow();
    }
  }

  const topics = accessActions.flatMap(({ descriptor }) => Object.keys(descriptor.domainEvents));
  expect(new Set(topics)).toEqual(
    new Set([
      'commerce.customer-context.counterparty-access-granted.v1',
      'commerce.customer-context.counterparty-access-revoked.v1',
      'commerce.customer-context.counterparty-access-administrator-bootstrapped.v1',
      'commerce.customer-context.counterparty-access-invitation-created.v1',
      'commerce.customer-context.counterparty-access-invitation-resent.v1',
      'commerce.customer-context.counterparty-access-invitation-revoked.v1',
      'commerce.customer-context.counterparty-access-invitation-claimed.v1',
    ]),
  );
  expect(accessActions.every(({ descriptor }) => Object.keys(descriptor.domainEvents).length === 1)).toBe(true);
});

it.effect('publishes the granted event only for a grant this Action applied', () =>
  Effect.gen(function* grantEventAttachment() {
    const payload = {
      counterpartyRef,
      permission: 'counterparty.purchase.prepare' as const,
      recipient,
      scope,
    };
    const grant = { ...commonGrantPayload, grantedAt, grantedBy: actor, state: 'ACTIVE' as const };
    const run = (outcome: 'APPLIED' | 'ALREADY_ACTIVE') => {
      const collector = createActionCollector(
        grantCounterpartyCommerceAccessAction.descriptor.domainEvents,
        'commerce.customer-context',
        grantCounterpartyCommerceAccessAction.descriptor.accessEvidencePolicy,
        grantCounterpartyCommerceAccessAction.descriptor.auditEvidenceSchema,
      );
      return getActionHandler(grantCounterpartyCommerceAccessAction)(
        payload,
        actionContext(collector, { grant: () => Effect.succeed({ grant, outcome }) }),
      ).pipe(Effect.map(() => collector.snapshot()));
    };

    const material = yield* run('APPLIED');
    expectSingleEvent(material, 'commerce.customer-context.counterparty-access-granted.v1');
    expect(material.outboxMessages[0]?.message.payloadJson).toEqual({
      ...commonGrantPayload,
      grantedAt,
      grantedBy: actor,
    });

    const replay = yield* run('ALREADY_ACTIVE');
    expect(replay.domainEvents).toHaveLength(0);
    expect(replay.outboxMessages).toHaveLength(0);
  }).pipe(provideUnusedAccessPort),
);

it.effect('publishes the bootstrapped event only for an administrator this Action applied', () =>
  Effect.gen(function* bootstrapEventAttachment() {
    const payload = { counterpartyRef, reason: 'Initial administrator', recipient };
    const grant = {
      ...commonGrantPayload,
      grantedAt,
      grantedBy: actor,
      permission: 'counterparty.access.manage' as const,
      state: 'ACTIVE' as const,
    };
    const run = (outcome: 'APPLIED' | 'ALREADY_ACTIVE') => {
      const collector = createActionCollector(
        bootstrapCounterpartyAccessAdministratorAction.descriptor.domainEvents,
        'commerce.customer-context',
        bootstrapCounterpartyAccessAdministratorAction.descriptor.accessEvidencePolicy,
        bootstrapCounterpartyAccessAdministratorAction.descriptor.auditEvidenceSchema,
      );
      return getActionHandler(bootstrapCounterpartyAccessAdministratorAction)(
        payload,
        actionContext(collector, { bootstrap: () => Effect.succeed({ grant, outcome }) }),
      ).pipe(Effect.map(() => collector.snapshot()));
    };

    const material = yield* run('APPLIED');
    expectSingleEvent(material, 'commerce.customer-context.counterparty-access-administrator-bootstrapped.v1');
    expect(material.outboxMessages[0]?.message.payloadJson).toEqual({
      ...commonGrantPayload,
      bootstrappedAt: grantedAt,
      bootstrappedBy: actor,
      permission: 'counterparty.access.manage',
    });

    const replay = yield* run('ALREADY_ACTIVE');
    expect(replay.domainEvents).toHaveLength(0);
    expect(replay.outboxMessages).toHaveLength(0);
  }).pipe(provideUnusedAccessPort),
);

it.effect('rejects bootstrap from an authMethod-shaped context without trusted provenance', () =>
  Effect.gen(function* bootstrapProvenance() {
    const collector = createActionCollector(
      bootstrapCounterpartyAccessAdministratorAction.descriptor.domainEvents,
      'commerce.customer-context',
      bootstrapCounterpartyAccessAdministratorAction.descriptor.accessEvidencePolicy,
      bootstrapCounterpartyAccessAdministratorAction.descriptor.auditEvidenceSchema,
    );
    let bootstrapCalls = 0;
    const context = actionContext(collector, {
      bootstrap: () => {
        bootstrapCalls += 1;
        return Effect.die('bootstrap must not be reached');
      },
    });
    const failure = yield* Effect.flip(
      getActionHandler(bootstrapCounterpartyAccessAdministratorAction)(
        { counterpartyRef, reason: 'Initial administrator', recipient },
        { ...context, scope: { ...context.scope } },
      ),
    );

    expect(Schema.is(CounterpartyAccessContractViolation)(failure)).toBe(true);
    if (Schema.is(CounterpartyAccessContractViolation)(failure)) {
      expect(failure.code).toBe('bootstrap_required');
    }
    expect(bootstrapCalls).toBe(0);
  }).pipe(provideUnusedAccessPort),
);

it.effect('publishes the revoked event only for a grant this Action revoked', () =>
  Effect.gen(function* revokeEventAttachment() {
    const payload = {
      counterpartyRef,
      grantRef,
      permission: 'counterparty.purchase.prepare' as const,
      recipient,
      scope,
    };
    const grant = {
      ...commonGrantPayload,
      grantedAt,
      grantedBy: actor,
      revision: 2,
      revokedAt: expiresAt,
      revokedBy: actor,
      state: 'REVOKED' as const,
    };
    const run = (outcome: 'REVOKED' | 'ALREADY_REVOKED') => {
      const collector = createActionCollector(
        revokeCounterpartyCommerceAccessAction.descriptor.domainEvents,
        'commerce.customer-context',
        revokeCounterpartyCommerceAccessAction.descriptor.accessEvidencePolicy,
        revokeCounterpartyCommerceAccessAction.descriptor.auditEvidenceSchema,
      );
      return getActionHandler(revokeCounterpartyCommerceAccessAction)(
        payload,
        actionContext(collector, { revoke: () => Effect.succeed({ grant, outcome }) }),
      ).pipe(Effect.map(() => collector.snapshot()));
    };

    const material = yield* run('REVOKED');
    expectSingleEvent(material, 'commerce.customer-context.counterparty-access-revoked.v1');
    expect(material.outboxMessages[0]?.message.payloadJson).toEqual({
      ...commonGrantPayload,
      revision: 2,
      revokedAt: expiresAt,
      revokedBy: actor,
    });

    const replay = yield* run('ALREADY_REVOKED');
    expect(replay.domainEvents).toHaveLength(0);
    expect(replay.outboxMessages).toHaveLength(0);
  }).pipe(provideUnusedAccessPort),
);

it.effect('attaches invitation-created outbox only for a new invitation', () =>
  Effect.gen(function* invitationCreateAttachment() {
    const payload = {
      counterpartyRef,
      deliveryMethod: invitation.deliveryMethod,
      deliveryReference: invitation.deliveryReference,
      expiresAt,
      intendedPermissions: invitation.intendedPermissions,
      reason: invitation.reason,
      scope,
    };
    const run = (outcome: 'CREATED' | 'ALREADY_PENDING') => {
      const collector = createActionCollector(
        createCounterpartyAccessInvitationAction.descriptor.domainEvents,
        'commerce.customer-context',
        createCounterpartyAccessInvitationAction.descriptor.accessEvidencePolicy,
        createCounterpartyAccessInvitationAction.descriptor.auditEvidenceSchema,
      );
      return getActionHandler(createCounterpartyAccessInvitationAction)(
        payload,
        actionContext(collector, {
          create: () => Effect.succeed({ invitation, outcome }),
        }),
      ).pipe(Effect.map(() => collector.snapshot()));
    };

    const material = yield* run('CREATED');
    expect(material.domainEvents).toHaveLength(1);
    expect(material.outboxMessages).toHaveLength(1);
    expect(material.outboxMessages[0]?.domainEventIndex).toBe(0);
    expect(material.outboxMessages[0]?.message.topic).toBe(
      'commerce.customer-context.counterparty-access-invitation-created.v1',
    );

    const replay = yield* run('ALREADY_PENDING');
    expect(replay.domainEvents).toHaveLength(0);
    expect(replay.outboxMessages).toHaveLength(0);
  }).pipe(provideUnusedAccessPort),
);

it.effect('attaches invitation-resent outbox only for an actual resend', () =>
  Effect.gen(function* invitationResendAttachment() {
    const payload = { counterpartyRef, expectedRevision: 1, invitationRef, scope };
    const run = (outcome: 'RESENT' | 'ALREADY_SENT') => {
      const collector = createActionCollector(
        resendCounterpartyAccessInvitationAction.descriptor.domainEvents,
        'commerce.customer-context',
        resendCounterpartyAccessInvitationAction.descriptor.accessEvidencePolicy,
        resendCounterpartyAccessInvitationAction.descriptor.auditEvidenceSchema,
      );
      return getActionHandler(resendCounterpartyAccessInvitationAction)(
        payload,
        actionContext(collector, {
          resend: () => Effect.succeed({ invitation, outcome }),
        }),
      ).pipe(Effect.map(() => collector.snapshot()));
    };

    const material = yield* run('RESENT');
    expect(material.domainEvents).toHaveLength(1);
    expect(material.outboxMessages).toHaveLength(1);
    expect(material.outboxMessages[0]?.domainEventIndex).toBe(0);
    expect(material.outboxMessages[0]?.message.topic).toBe(
      'commerce.customer-context.counterparty-access-invitation-resent.v1',
    );

    const replay = yield* run('ALREADY_SENT');
    expect(replay.domainEvents).toHaveLength(0);
    expect(replay.outboxMessages).toHaveLength(0);
  }).pipe(provideUnusedAccessPort),
);

it.effect('attaches invitation-revoked outbox only for an actual revocation', () =>
  Effect.gen(function* invitationRevokeAttachment() {
    const payload = {
      counterpartyRef,
      expectedRevision: 1,
      invitationRef,
      reason: 'Access no longer needed',
      scope,
    };
    const revokedInvitation = { ...invitation, revision: 2, state: 'REVOKED' as const };
    const run = (outcome: 'REVOKED' | 'ALREADY_REVOKED') => {
      const collector = createActionCollector(
        revokeCounterpartyAccessInvitationAction.descriptor.domainEvents,
        'commerce.customer-context',
        revokeCounterpartyAccessInvitationAction.descriptor.accessEvidencePolicy,
        revokeCounterpartyAccessInvitationAction.descriptor.auditEvidenceSchema,
      );
      return getActionHandler(revokeCounterpartyAccessInvitationAction)(
        payload,
        actionContext(collector, {
          revoke: () => Effect.succeed({ invitation: revokedInvitation, outcome }),
        }),
      ).pipe(Effect.map(() => collector.snapshot()));
    };

    const material = yield* run('REVOKED');
    expect(material.domainEvents).toHaveLength(1);
    expect(material.outboxMessages).toHaveLength(1);
    expect(material.outboxMessages[0]?.domainEventIndex).toBe(0);
    expect(material.outboxMessages[0]?.message.topic).toBe(
      'commerce.customer-context.counterparty-access-invitation-revoked.v1',
    );

    const replay = yield* run('ALREADY_REVOKED');
    expect(replay.domainEvents).toHaveLength(0);
    expect(replay.outboxMessages).toHaveLength(0);
  }).pipe(provideUnusedAccessPort),
);

it.effect('publishes the claimed event only for a claim this Action completed', () =>
  Effect.gen(function* invitationClaimAttachment() {
    const payload = {
      claimant: recipient,
      claimProofReference: 'proof-ref-1',
      counterpartyRef,
      expectedRevision: 1,
      invitationRef,
      scope,
    };
    const attestation = {
      attestationReference: 'claim-attestation-ref-1',
      claimant: recipient,
      counterpartyRef,
      invitationRef,
      inviterAuthority: {
        decision: 'ALLOWED' as const,
        inviter: actor,
        permission: 'counterparty.access.manage' as const,
        scope,
      },
      proofVersion: 'commerce-invitation-proof.v1' as const,
      state: 'VERIFIED_AND_CONSUMED' as const,
      verifiedAt: grantedAt,
    };
    const claimedInvitation = {
      ...invitation,
      claimant: recipient,
      grantProgress: [
        {
          grantRef,
          permission: 'counterparty.purchase.prepare' as const,
          state: 'ACTIVE' as const,
        },
      ],
      revision: 3,
      state: 'CLAIMED' as const,
    };
    const run = (claimed: boolean) => {
      const collector = createActionCollector(
        claimCounterpartyAccessInvitationAction.descriptor.domainEvents,
        'commerce.customer-context',
        claimCounterpartyAccessInvitationAction.descriptor.accessEvidencePolicy,
        claimCounterpartyAccessInvitationAction.descriptor.auditEvidenceSchema,
      );
      return getActionHandler(claimCounterpartyAccessInvitationAction)(
        payload,
        actionContext(
          collector,
          {
            claim: () =>
              Effect.succeed(
                claimed
                  ? { attestation, invitation: claimedInvitation, outcome: 'CLAIMED' as const }
                  : { invitation: claimedInvitation, outcome: 'ALREADY_CLAIMED' as const },
              ),
          },
          recipient.principalId,
        ),
      ).pipe(Effect.map(() => collector.snapshot()));
    };

    const material = yield* run(true);
    expect(material.domainEvents).toHaveLength(1);
    expect(material.outboxMessages).toHaveLength(1);
    expect(material.outboxMessages[0]?.domainEventIndex).toBe(0);
    expect(material.outboxMessages[0]?.message.topic).toBe(
      'commerce.customer-context.counterparty-access-invitation-claimed.v1',
    );
    expect(material.outboxMessages[0]?.message.payloadJson).toEqual({
      ...commonInvitationPayload,
      attestationReference: 'claim-attestation-ref-1',
      claimedBy: recipient,
      grantProgress: claimedInvitation.grantProgress,
      intendedPermissions: claimedInvitation.intendedPermissions,
      revision: 3,
      verifiedAt: grantedAt,
    });

    const replay = yield* run(false);
    expect(replay.domainEvents).toHaveLength(0);
    expect(replay.outboxMessages).toHaveLength(0);
  }).pipe(provideUnusedAccessPort),
);

it.effect('defers durable proof rejection until after the Action transaction commits', () =>
  Effect.gen(function* deferClaimRejection() {
    const collector = createActionCollector(
      claimCounterpartyAccessInvitationAction.descriptor.domainEvents,
      'commerce.customer-context',
      claimCounterpartyAccessInvitationAction.descriptor.accessEvidencePolicy,
      claimCounterpartyAccessInvitationAction.descriptor.auditEvidenceSchema,
    );
    const committedRejection = yield* getActionHandler(claimCounterpartyAccessInvitationAction)(
      {
        claimant: recipient,
        claimProofReference: 'proof-ref-1',
        counterpartyRef,
        expectedRevision: 1,
        invitationRef,
        scope,
      },
      actionContext(
        collector,
        {
          claim: () =>
            Effect.succeed({
              invitation,
              outcome: 'REJECTED' as const,
              rejection: 'INVALID_PROOF' as const,
            }),
        },
        recipient.principalId,
      ),
    );

    expect(Schema.is(claimCounterpartyAccessInvitationAction.descriptor.resultSchema)(committedRejection)).toBe(false);
    const snapshot = collector.snapshot();
    expect(snapshot.auditEvidence).toBeDefined();
    expect(snapshot.dataAccessEvents).toHaveLength(1);
    expect(snapshot.domainEvents).toHaveLength(0);
    expect(snapshot.outboxMessages).toHaveLength(0);
  }).pipe(provideUnusedAccessPort),
);
