import { ActionRuntime, TrustedPrincipalContextSchema } from '@app/core-runtime';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT } from '@app/party-registry-identity-contracts';
import { DateTime, Effect, Predicate, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { EnrollRetailCustomerPayloadSchema } from '../../shared/actions/enroll-retail-customer.ts';
import type { CounterpartyCustomerOnboardPayload } from '../../shared/actions/counterparty-customer-onboard.ts';
import { PartyContactPointSchema } from '../../shared/domain/contact-point.ts';
import {
  PartyContactPointAlreadyExists,
  PartyContactPointPersistenceUnavailable,
} from '../../shared/domain/contact-point-errors.ts';
import { PartyEvidenceInsufficient } from '../../shared/domain/identity-contracts.ts';
import { PartyRefSchema } from '../../shared/resources/party.ts';
import type { AddContactPointCommand, AddContactPointServices } from '../../src/actions/add-contact-point.action.ts';
import { enrollRetailCustomerAction } from '../../src/actions/enroll-retail-customer.action.ts';
import { CustomerOnboardFoundSchema } from '../../src/services/counterparty-persistence.service.ts';
import { partyRegistryBackendRegistration } from '../../vertical.runtime-declaration.ts';

const TENANT = '10000000-0000-4000-8000-000000000001';
const COMPANY = '20000000-0000-4000-8000-000000000001';
const PARTY = '30000000-0000-4000-8000-000000000001';
const ORIGINAL = '40000000-0000-4000-8000-000000000001';
const timestamp = '2026-11-20T00:00:00.000Z';
const principal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  authBindingId: '50000000-0000-4000-8000-000000000001',
  authContextRef: 'retail-enrollment-runtime',
  authMethod: 'api_key',
  legalEntityId: COMPANY,
  principalId: '60000000-0000-4000-8000-000000000001',
  tenantId: TENANT,
});
const partyRef = Schema.decodeUnknownSync(PartyRefSchema)({
  moduleId: 'party.registry',
  resourceId: PARTY,
  resourceType: 'party.registry.party',
  tenantId: TENANT,
});
const payload = Schema.decodeUnknownSync(EnrollRetailCustomerPayloadSchema)({
  email: 'retail@example.test',
  evidence: {
    authenticationNamespaceId: 'ontos.commerce.portal.better-auth.v1',
    candidateEvidenceRef: '70000000-0000-4000-8000-000000000001',
    emailOwnership: 'VERIFIED',
    enrollmentAttemptId: '80000000-0000-4000-8000-000000000001',
    journey: 'RETAIL_SELF_ENROLLMENT',
    providerOwnerInvocationId: '90000000-0000-4000-8000-000000000001',
    providerSubjectId: 'verified-retail-subject',
    sellingLegalEntityId: COMPANY,
    tenantId: TENANT,
  },
  originalInvocationId: ORIGINAL,
  phone: { preferred: true, type: 'PHONE', value: '+420777123456' },
});
const onboardResult = Schema.decodeUnknownSync(CustomerOnboardFoundSchema)({
  _tag: 'onboarded',
  counterpartyCreated: true,
  counterpartyRef: {
    moduleId: 'party.registry',
    resourceId: 'a0000000-0000-4000-8000-000000000001',
    resourceType: 'party.registry.counterparty',
    tenantId: TENANT,
  },
  legalEntityRef: {
    moduleId: 'core.identity',
    resourceId: COMPANY,
    resourceType: 'core.identity.legal-entity',
    tenantId: TENANT,
  },
  partyRef,
  role: {
    endProvenance: null,
    provenance: {
      evidenceReference: `commerce.portal-enrollment:${ORIGINAL}`,
      method: 'APPROVED_PURCHASING_RELATIONSHIP',
      reason: 'Verified retail enrollment',
      source: 'commerce.customer-context',
    },
    recordedAt: timestamp,
    rolePeriodRef: {
      moduleId: 'party.registry',
      resourceId: 'b0000000-0000-4000-8000-000000000001',
      resourceType: 'party.registry.counterparty-role-period',
      tenantId: TENANT,
    },
    roleType: 'CUSTOMER',
    state: 'ACTIVE',
    validFrom: timestamp,
    validTo: null,
  },
  rolePeriodCreated: true,
});
const contactOf = (command: AddContactPointCommand) =>
  Schema.decodeUnknownSync(PartyContactPointSchema)({
    contactPointRef: {
      moduleId: 'party.registry',
      resourceId:
        command.contactPoint.type === 'EMAIL'
          ? 'c0000000-0000-4000-8000-000000000001'
          : 'd0000000-0000-4000-8000-000000000001',
      resourceType: 'party.registry.party-contact-point',
      tenantId: TENANT,
    },
    current: true,
    end: null,
    partyRef: command.partyRef,
    privacyClassification: command.privacyClassification,
    provenance: command.provenance,
    recordedAt: timestamp,
    revision: 1,
    state: 'ACTIVE',
    storedPartyRef: command.partyRef,
    validFrom: command.validFrom,
    validTo: null,
    value:
      command.contactPoint.type === 'EMAIL'
        ? {
            displayValue: command.contactPoint.value,
            lookupValue: command.contactPoint.value,
            preferred: command.contactPoint.preferred,
            type: 'EMAIL',
          }
        : {
            countryCode: null,
            displayValue: '+420777123456',
            extension: null,
            lookupValue: '+420777123456',
            preferred: true,
            type: 'PHONE',
          },
  });

interface FixtureInput {
  readonly contactFailure?: 'EMAIL' | 'PHONE';
  readonly duplicateEmail?: boolean;
  readonly proofDenied?: boolean;
}

/** Bound owner ports exercise native handler ordering and Core commit/evidence atomicity, not SQL rollback. */
const fixtureOf = (input: FixtureInput = {}) =>
  Effect.gen(function* fixture() {
    const calls: string[] = [];
    const contacts: AddContactPointCommand[] = [];
    const onboarding: CounterpartyCustomerOnboardPayload[] = [];
    const harness = yield* makeActionTestHarness({
      access: 'allowed',
      databaseIdentities: PARTY_REGISTRY_DATABASE_IDENTITY_ENROLLMENT,
      ownerRegistration: partyRegistryBackendRegistration,
      services: [
        bindActionTestServices(enrollRetailCustomerAction, {
          add: (command) =>
            Effect.suspend((): ReturnType<AddContactPointServices['add']> => {
              calls.push(`add:${command.contactPoint.type}`);
              contacts.push(command);
              if (command.contactPoint.type === input.contactFailure) {
                return Effect.fail(
                  new PartyContactPointPersistenceUnavailable({
                    code: 'party_contact_point_persistence_unavailable',
                    reason: 'Scripted contact persistence failure',
                  }),
                );
              }
              const contact = contactOf(command);
              if (input.duplicateEmail === true && command.contactPoint.type === 'EMAIL') {
                return Effect.fail(
                  new PartyContactPointAlreadyExists({
                    code: 'party_contact_point_already_exists',
                    existingContactPointRef: contact.contactPointRef,
                    reason: 'The exact email contact is retained',
                  }),
                );
              }
              return Effect.succeed(contact);
            }),
          onboard: (declaration) =>
            Effect.sync(() => {
              calls.push('onboard');
              onboarding.push(declaration);
              return onboardResult;
            }),
          prove: () =>
            Effect.suspend(() => {
              calls.push('prove');
              return input.proofDenied === true
                ? Effect.fail(
                    new PartyEvidenceInsufficient({
                      code: 'party_evidence_insufficient',
                      reason: 'The original Create ownership proof was refused',
                    }),
                  )
                : Effect.succeed(partyRef);
            }),
          reuseContact: (declaration) =>
            Effect.sync(() => {
              calls.push('reuse:EMAIL');
              return contactOf({
                ...declaration,
                acceptedByActionInvocationId: ORIGINAL,
                acceptedByPrincipalId: principal.principalId,
                validFrom: DateTime.formatIso(declaration.validFrom),
              });
            }),
        }),
      ],
    });
    const run = () =>
      harness.runtime
        .runAction({
          payload,
          principal,
          registration: enrollRetailCustomerAction,
          transport: { correlationId: 'retail-enrollment-atomic-runtime', idempotencyKey: 'retail-enrollment-once' },
        })
        .pipe(Effect.provideService(ActionRuntime, harness.runtime));
    return { calls, contacts, harness, onboarding, run };
  });

it.effect('denies invalid native proof before onboarding, contacts or committed evidence', () =>
  Effect.gen(function* invalidProofNoWrites() {
    const fixture = yield* fixtureOf({ proofDenied: true });
    const failure = yield* fixture.run().pipe(Effect.flip);
    expect(Predicate.isTagged(failure, 'PartyEvidenceInsufficient')).toBe(true);
    expect(fixture.calls).toEqual(['prove']);
    expect(fixture.contacts).toEqual([]);
    expect(fixture.onboarding).toEqual([]);
    expect(fixture.harness.snapshot().committed).toEqual([]);
  }),
);

it.effect('derives the target from proof and commits onboarding, email and phone through one native Action', () =>
  Effect.gen(function* oneEnrollmentCommit() {
    const fixture = yield* fixtureOf();
    expect(yield* fixture.run()).toEqual({ partyRef });
    expect(fixture.calls).toEqual(['prove', 'onboard', 'add:EMAIL', 'add:PHONE']);
    expect(fixture.onboarding[0]).toMatchObject({
      partyRef,
      counterpartyProvenance: { source: 'commerce.customer-context' },
      customerEvidence: { source: 'commerce.customer-context' },
    });
    expect(fixture.contacts).toHaveLength(2);
    for (const command of fixture.contacts) {
      expect(command).toMatchObject({
        acceptedByPrincipalId: principal.principalId,
        partyRef,
        privacyClassification: 'PERSONAL',
        provenance: { authoritative: false, method: 'DECLARED_BY_PARTY', source: 'PARTY_DECLARATION' },
      });
    }
    const { committed } = fixture.harness.snapshot();
    expect(committed).toHaveLength(1);
    expect(committed[0]?.evidence.domainEvents.map((event) => event.eventType)).toEqual([
      'party.registry.counterparty-created.v1',
      'party.registry.counterparty-role-added.v1',
      'party.registry.contact-point-added.v1',
      'party.registry.contact-point-added.v1',
    ]);
    expect(committed[0]?.evidence.outboxMessages).toHaveLength(4);
  }),
);

it.effect('does not repeat onboarding or contacts on an identical idempotent replay', () =>
  Effect.gen(function* idempotentEnrollment() {
    const fixture = yield* fixtureOf();
    yield* fixture.run();
    const before = [...fixture.calls];
    expect(Predicate.isTagged(yield* fixture.run().pipe(Effect.flip), 'ActionAlreadyCommitted')).toBe(true);
    expect(fixture.calls).toEqual(before);
    expect(fixture.harness.snapshot().committed).toHaveLength(1);
  }),
);

const contactFailures: readonly ('EMAIL' | 'PHONE')[] = ['EMAIL', 'PHONE'];
for (const contactFailure of contactFailures) {
  it.effect(`commits no Action evidence, domain events or outbox when ${contactFailure} persistence fails`, () =>
    Effect.gen(function* failedContactNoCommit() {
      const fixture = yield* fixtureOf({ contactFailure });
      expect(
        Predicate.isTagged(yield* fixture.run().pipe(Effect.flip), 'PartyContactPointPersistenceUnavailable'),
      ).toBe(true);
      expect(fixture.calls).toEqual(
        contactFailure === 'EMAIL' ? ['prove', 'onboard', 'add:EMAIL'] : ['prove', 'onboard', 'add:EMAIL', 'add:PHONE'],
      );
      expect(fixture.harness.snapshot().committed).toEqual([]);
      expect(fixture.harness.snapshot().stages.includes('handler_executed')).toBe(false);
    }),
  );
}

it.effect('reuses an exact retained contact without publishing another contact-added event', () =>
  Effect.gen(function* retainedEmail() {
    const fixture = yield* fixtureOf({ duplicateEmail: true });
    expect(yield* fixture.run()).toEqual({ partyRef });
    expect(fixture.calls).toEqual(['prove', 'onboard', 'add:EMAIL', 'reuse:EMAIL', 'add:PHONE']);
    const { committed } = fixture.harness.snapshot();
    expect(committed).toHaveLength(1);
    expect(
      committed[0]?.evidence.domainEvents.filter(
        (event) => event.eventType === 'party.registry.contact-point-added.v1',
      ),
    ).toHaveLength(1);
    expect(committed[0]?.evidence.outboxMessages).toHaveLength(3);
  }),
);
