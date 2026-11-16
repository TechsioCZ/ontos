import { randomUUID } from 'node:crypto';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { EnsureRetailCustomerProfilePayloadSchema } from '../../shared/actions/ensure-retail-customer-profile.ts';
import { CustomerProfileSourceRequestSchema } from '../../shared/apis/customer-profile-source.ts';
import { CustomerProfileSourceAssertionSchema } from '../../shared/domain/customer-profile-source.ts';

const tenantId = randomUUID();
const source = {
  effectId: 'commerce-effect-1',
  issuer: 'erp-issuer',
  mappingRevision: 'approved-mapping-3',
  namespace: 'customer-profiles',
  occurrenceId: 'commerce-profile-r7',
  order: 7,
  recordId: 'customer-0042',
  recordType: 'commerce-profile',
  revision: '7',
  route: { id: 'commerce-route', revision: '2' },
};
const partySourceReference = {
  occurrenceId: 'party-identity-declaration-1',
  recordId: 'person-99',
  source: { issuer: 'crm-issuer', namespace: 'declared-identities', recordType: 'person', routeRef: 'party-route' },
};
const payload = {
  effectiveAt: '2026-11-07T00:00:00.000Z',
  partySourceReference,
  source,
  subject: {
    kind: 'RETAIL',
    partyRef: { moduleId: 'party.registry', resourceId: randomUUID(), resourceType: 'party.registry.party', tenantId },
    sellingLegalEntityRef: {
      moduleId: 'core.identity',
      resourceId: randomUUID(),
      resourceType: 'core.identity.legal-entity',
      tenantId,
    },
  },
  trigger: 'AUTHORIZED_ONBOARDING',
};

it.effect(
  'requires independent exact Party admission evidence for a sourced Profile without equating source identities',
  () =>
    Effect.gen(function* exactPartySourceReference() {
      const decoded = yield* Schema.decodeUnknownEffect(EnsureRetailCustomerProfilePayloadSchema)(payload);
      expect(decoded.source).toEqual(source);
      expect(decoded.partySourceReference).toEqual(partySourceReference);
      const { partySourceReference: _partySourceReference, ...missingPartyReference } = payload;
      const { source: _source, ...missingCommerceSource } = payload;
      expect(Schema.is(EnsureRetailCustomerProfilePayloadSchema)(missingPartyReference)).toBe(false);
      expect(Schema.is(EnsureRetailCustomerProfilePayloadSchema)(missingCommerceSource)).toBe(false);
      expect(Schema.is(CustomerProfileSourceAssertionSchema)({ ...source, recordId: ' customer-0042 ' })).toBe(false);
    }),
);

it.effect('bounds source paging and preserves explicit cursor absence through the public codec', () =>
  Effect.gen(function* sourcePageCodec() {
    const request = {
      cursor: null,
      issuer: source.issuer,
      limit: 100,
      mappingRevision: source.mappingRevision,
      mode: 'LIST',
      namespace: source.namespace,
      recordType: source.recordType,
      route: source.route,
    };
    const decoded = yield* Schema.decodeUnknownEffect(CustomerProfileSourceRequestSchema)(request);
    expect(yield* Schema.encodeEffect(CustomerProfileSourceRequestSchema)(decoded)).toEqual(request);
    expect(Schema.is(CustomerProfileSourceRequestSchema)({ ...request, limit: 101 })).toBe(false);
    expect(Schema.is(CustomerProfileSourceRequestSchema)({ ...request, limit: 0 })).toBe(false);
  }),
);
