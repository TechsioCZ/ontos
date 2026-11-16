import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { bindActionTestServices, makeActionTestHarness } from '@app/core-runtime/testing/actions';
import { Effect, Schema } from 'effect';
import { assert, expect, it } from 'effect-rstest';

import { AddContactPointPayloadSchema } from '../../shared/actions/add-contact-point.ts';
import { UpdateContactPointPayloadSchema } from '../../shared/actions/update-contact-point.ts';
import {
  CounterpartyCustomerOnboardPayloadSchema,
  CounterpartyCustomerOnboardResultSchema,
} from '../../shared/actions/counterparty-customer-onboard.ts';
import { PartyContactPointSchema } from '../../shared/domain/contact-point.ts';
import { addContactPointAction } from '../../src/actions/add-contact-point.action.ts';
import { updateContactPointAction } from '../../src/actions/update-contact-point.action.ts';
import { counterpartyCustomerOnboardAction } from '../../src/actions/counterparty-customer-onboard.action.ts';
import { SourceOnboardReplaySchema } from '../../src/services/party-source-lifecycle.service.ts';
import { OrganizationBusinessOnboardedSchema } from '../../src/services/organization-business-onboard.service.ts';
import { OrganizationBusinessCounterpartyContextReason } from '../../shared/apis/organization-record-facts.ts';
import { partyRegistryBackendRegistration } from '../../vertical.runtime-declaration.ts';

const tenantId = 'ac110000-0000-4000-8000-000000000001';
const legalEntityId = 'ac120000-0000-4000-8000-000000000001';
const partyRef = {
  moduleId: 'party.registry',
  resourceType: 'party.registry.party',
  tenantId,
  resourceId: 'ac130000-0000-4000-8000-000000000001',
} as const;
const sourceReference = {
  source: { issuer: 'internal-lifecycle', namespace: 'customers', recordType: 'customer', routeRef: 'internal-route' },
  recordId: 'customer-1',
  occurrenceId: 'revision-1',
};
const provenance = { authoritative: false, source: 'PARTY_DECLARATION', method: 'DECLARED_BY_PARTY' } as const;
const instant = '2020-01-01T00:00:00.000Z';
const principal = Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
  authMethod: 'session',
  authBindingId: 'ac140000-0000-4000-8000-000000000001',
  principalId: 'ac150000-0000-4000-8000-000000000001',
  tenantId,
  legalEntityId,
  authContextRef: 'better-auth-session:source-lifecycle-action',
});

const pointFixture = Schema.decodeUnknownSync(PartyContactPointSchema)({
  contactPointRef: {
    moduleId: 'party.registry',
    resourceType: 'party.registry.party-contact-point',
    tenantId,
    resourceId: 'ac160000-0000-4000-8000-000000000001',
  },
  partyRef,
  storedPartyRef: partyRef,
  current: true,
  end: null,
  privacyClassification: 'PERSONAL',
  provenance,
  recordedAt: instant,
  revision: 1,
  state: 'ACTIVE',
  validFrom: instant,
  validTo: null,
  value: {
    type: 'EMAIL',
    displayValue: 'fixture@example.invalid',
    lookupValue: 'fixture@example.invalid',
    preferred: false,
  },
});

it.effect('source Contact replay strips its private flag and retains invariant access without another event', () =>
  Effect.gen(function* replayContactAction() {
    const point = pointFixture;
    const harness = yield* makeActionTestHarness({
      access: 'allowed',
      ownerRegistration: partyRegistryBackendRegistration,
      services: [
        bindActionTestServices(addContactPointAction, {
          add: () => Effect.succeed({ ...point, sourceReplayed: true }),
        }),
      ],
    });
    const payload = yield* Schema.decodeUnknownEffect(AddContactPointPayloadSchema)({
      sourceReference,
      partyRef,
      contactPoint: { type: 'EMAIL', value: 'fixture@example.invalid', preferred: false },
      privacyClassification: 'PERSONAL',
      provenance,
      validFrom: instant,
    });
    const result = yield* harness.runtime.runAction({
      payload: yield* Schema.encodeEffect(AddContactPointPayloadSchema)(payload),
      principal,
      registration: addContactPointAction,
      transport: { correlationId: 'source-contact-replay', idempotencyKey: 'source-contact-replay' },
    });
    expect(result).toEqual(point);
    const [commit] = harness.snapshot().committed;
    assert.isOk(commit !== undefined);
    expect(commit.evidence.domainEvents).toEqual([]);
    expect(commit.evidence.outboxMessages).toEqual([]);
    expect(commit.evidence.dataAccessEvents).toHaveLength(1);
  }),
);

it.effect('source no-change update strips its private flag and commits no update event', () =>
  Effect.gen(function* unchangedContactAction() {
    const point = yield* Schema.decodeUnknownEffect(PartyContactPointSchema)({
      ...(yield* Schema.encodeEffect(PartyContactPointSchema)(pointFixture)),
      value: {
        type: 'ADDRESS',
        address: {
          addressLine1: null,
          addressLine2: null,
          city: 'Praha',
          countryCode: 'CZ',
          postalCode: null,
          region: null,
        },
        purposes: [
          {
            purpose: 'CORRESPONDENCE',
            preferred: false,
            current: true,
            end: null,
            provenance,
            recordedAt: instant,
            revision: 1,
            state: 'ACTIVE',
            validFrom: instant,
            validTo: null,
          },
        ],
      },
    });
    const harness = yield* makeActionTestHarness({
      access: 'allowed',
      ownerRegistration: partyRegistryBackendRegistration,
      services: [
        bindActionTestServices(updateContactPointAction, {
          update: () => Effect.succeed({ ...point, sourceUnchanged: true }),
        }),
      ],
    });
    const payload = yield* Schema.decodeUnknownEffect(UpdateContactPointPayloadSchema)({
      sourceReference,
      contactPointRef: point.contactPointRef,
      expectedRevision: point.revision,
      provenance,
      change: {
        type: 'END_ADDRESS_PURPOSE',
        effectiveEnd: instant,
        reason: 'Already ended source purpose',
        target: { purpose: 'BILLING' },
      },
    });
    const result = yield* harness.runtime.runAction({
      payload: yield* Schema.encodeEffect(UpdateContactPointPayloadSchema)(payload),
      principal,
      registration: updateContactPointAction,
      transport: { correlationId: 'source-contact-noop', idempotencyKey: 'source-contact-noop' },
    });
    expect(result).toEqual(point);
    const [commit] = harness.snapshot().committed;
    assert.isOk(commit !== undefined);
    expect(commit.evidence.domainEvents).toEqual([]);
    expect(commit.evidence.outboxMessages).toEqual([]);
  }),
);

it.effect(
  'source Counterparty replay retains its original flags and required success audit without duplicate events',
  () =>
    Effect.gen(function* replayOnboardingAction() {
      const original = yield* Schema.decodeUnknownEffect(CounterpartyCustomerOnboardResultSchema)({
        counterpartyCreated: true,
        rolePeriodCreated: true,
        partyRef,
        counterpartyRef: {
          moduleId: 'party.registry',
          resourceType: 'party.registry.counterparty',
          tenantId,
          resourceId: 'ac170000-0000-4000-8000-000000000001',
        },
        rolePeriodRef: {
          moduleId: 'party.registry',
          resourceType: 'party.registry.counterparty-role-period',
          tenantId,
          resourceId: 'ac180000-0000-4000-8000-000000000001',
        },
        legalEntityRef: {
          moduleId: 'core.identity',
          resourceType: 'core.identity.legal-entity',
          tenantId,
          resourceId: legalEntityId,
        },
        roleType: 'CUSTOMER',
        validFrom: instant,
        validTo: null,
      });
      const harness = yield* makeActionTestHarness({
        access: 'allowed',
        ownerRegistration: partyRegistryBackendRegistration,
        services: [
          bindActionTestServices(counterpartyCustomerOnboardAction, {
            onboard: () => Effect.succeed(SourceOnboardReplaySchema.make({ result: original })),
          }),
        ],
      });
      const payload = yield* Schema.decodeUnknownEffect(CounterpartyCustomerOnboardPayloadSchema)({
        sourceReference,
        partyRef,
        validFrom: instant,
        counterpartyProvenance: {
          method: 'SIGNED_CONTRACT',
          source: 'internal-source',
          evidenceReference: 'fixture:commercial-contract',
          reason: 'Fixture commercial agreement',
        },
        customerEvidence: { method: 'BINDING_ORDER', source: 'internal-source', evidenceReference: 'fixture:order' },
      });
      const result = yield* harness.runtime.runAction({
        payload,
        principal,
        registration: counterpartyCustomerOnboardAction,
        transport: { correlationId: 'source-counterparty-replay', idempotencyKey: 'source-counterparty-replay' },
      });
      expect(result).toEqual(original);
      const [commit] = harness.snapshot().committed;
      assert.isOk(commit !== undefined);
      expect(commit.evidence.domainEvents).toEqual([]);
      expect(commit.evidence.outboxMessages).toEqual([]);
      expect(commit.evidence.dataAccessEvents).toHaveLength(1);
    }),
);

it.effect(
  'bounded organization Onboard handler retains native minimal acknowledgement, audit and reference-only events',
  () =>
    Effect.gen(function* boundedOrganizationOnboardAction() {
      const result = yield* Schema.decodeUnknownEffect(CounterpartyCustomerOnboardResultSchema)({
        counterpartyCreated: true,
        rolePeriodCreated: true,
        partyRef,
        counterpartyRef: {
          moduleId: 'party.registry',
          resourceType: 'party.registry.counterparty',
          tenantId,
          resourceId: 'ac170000-0000-4000-8000-000000000001',
        },
        rolePeriodRef: {
          moduleId: 'party.registry',
          resourceType: 'party.registry.counterparty-role-period',
          tenantId,
          resourceId: 'ac180000-0000-4000-8000-000000000001',
        },
        legalEntityRef: {
          moduleId: 'core.identity',
          resourceType: 'core.identity.legal-entity',
          tenantId,
          resourceId: legalEntityId,
        },
        roleType: 'CUSTOMER',
        validFrom: instant,
        validTo: null,
      });
      const harness = yield* makeActionTestHarness({
        access: 'allowed',
        ownerRegistration: partyRegistryBackendRegistration,
        services: [
          bindActionTestServices(counterpartyCustomerOnboardAction, {
            onboard: () => Effect.succeed(OrganizationBusinessOnboardedSchema.make({ result, replayed: false })),
          }),
        ],
      });
      const payload = yield* Schema.decodeUnknownEffect(CounterpartyCustomerOnboardPayloadSchema)({
        sourceReference,
        partyRef,
        validFrom: instant,
        counterpartyProvenance: {
          method: 'APPROVED_COMMERCIAL_RELATIONSHIP',
          source: sourceReference.source.routeRef,
          evidenceReference: sourceReference.recordId,
          reason: OrganizationBusinessCounterpartyContextReason,
        },
        customerEvidence: {
          method: 'APPROVED_PURCHASING_RELATIONSHIP',
          source: sourceReference.source.routeRef,
          evidenceReference: sourceReference.recordId,
        },
      });
      const actual = yield* harness.runtime.runAction({
        payload,
        principal,
        registration: counterpartyCustomerOnboardAction,
        transport: { correlationId: 'organization-minimal-onboard', idempotencyKey: 'organization-minimal-onboard' },
      });
      expect(actual).toEqual(result);
      const [commit] = harness.snapshot().committed;
      assert.isOk(commit !== undefined);
      expect(commit.evidence.domainEvents).toHaveLength(2);
      expect(commit.evidence.outboxMessages).toHaveLength(2);
      expect(commit.evidence.dataAccessEvents).toHaveLength(1);
      const [created, roleAdded] = commit.evidence.domainEvents;
      expect(created?.payloadJson).toEqual({
        counterpartyRef: result.counterpartyRef,
        legalEntityRef: result.legalEntityRef,
        partyRef,
      });
      expect(roleAdded?.payloadJson).toEqual({
        counterpartyRef: result.counterpartyRef,
        rolePeriodRef: result.rolePeriodRef,
        roleType: 'CUSTOMER',
        validFrom: instant,
        validTo: null,
      });
    }),
);
