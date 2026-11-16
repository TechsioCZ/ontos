import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  OrganizationProfileSourceCreateTemplateSchema,
  OrganizationProfileSourceReceiptSchema,
  OrganizationProfileSourceCurrentSchema,
  fingerprintOrganizationProfileSourceCreateTemplate,
  fingerprintOrganizationProfileSourceCreate,
} from '../../shared/domain/organization-profile-source.ts';
import { CreateCounterpartyPurchasingProfilePayloadSchema } from '../../shared/actions/create-counterparty-purchasing-profile.ts';

const tenantId = 'bd000000-0000-4000-8000-000000000001';
const legalEntity = {
  moduleId: 'core.identity',
  resourceId: 'bd000000-0000-4000-8000-000000000002',
  resourceType: 'core.identity.legal-entity',
  tenantId,
} as const;
const counterpartyRef = {
  moduleId: 'party.registry',
  resourceId: 'bd000000-0000-4000-8000-000000000003',
  resourceType: 'party.registry.counterparty',
  tenantId,
} as const;
const source = {
  effectId: 'bd000000-0000-4000-8000-000000000004',
  issuer: 'explicit-commerce-source',
  mappingRevision: 'mapping-1',
  namespace: 'customers',
  occurrenceId: 'company-1-r1',
  order: 1,
  recordId: 'company-1',
  recordType: 'customer',
  revision: '1',
  route: { id: 'commerce-route', revision: '1' },
};
const partySourceReference = {
  occurrenceId: 'organization-1-r1',
  recordId: 'organization-1',
  source: {
    issuer: 'independent-party-source',
    namespace: 'organizations',
    recordType: 'company',
    routeRef: 'party-route',
  },
};
const template = {
  _tag: 'CreateCounterpartyProfileFromCounterparty',
  fromCounterpartyEffect: { effectKey: 'onboard', itemKey: 'company-1' },
  payload: {
    effectiveAt: '2025-01-01T00:00:00.000Z',
    partySourceReference,
    source,
    subject: { kind: 'COUNTERPARTY', sellingLegalEntityRef: legalEntity },
    trigger: 'AUTHORIZED_ONBOARDING',
  },
} as const;
const native = { ...template.payload, subject: { ...template.payload.subject, counterpartyRef } };
it.effect('binds the named semantic parent and actual SLE without a future Counterparty identifier', () =>
  Effect.gen(function* semanticProjection() {
    const decoded = yield* Schema.decodeUnknownEffect(OrganizationProfileSourceCreateTemplateSchema)(template);
    const original = yield* fingerprintOrganizationProfileSourceCreateTemplate(decoded);
    expect(
      yield* fingerprintOrganizationProfileSourceCreateTemplate({
        ...decoded,
        fromCounterpartyEffect: { ...decoded.fromCounterpartyEffect, effectKey: 'other-parent' },
      }),
    ).not.toBe(original);
    expect(
      yield* fingerprintOrganizationProfileSourceCreateTemplate({
        ...decoded,
        payload: {
          ...decoded.payload,
          subject: {
            ...decoded.payload.subject,
            sellingLegalEntityRef: { ...legalEntity, resourceId: 'bd000000-0000-4000-8000-000000000005' },
          },
        },
      }),
    ).not.toBe(original);
    expect(() =>
      Schema.decodeUnknownSync(OrganizationProfileSourceCreateTemplateSchema, { onExcessProperty: 'error' })({
        ...template,
        payload: native,
      }),
    ).toThrow();
  }),
);
it.effect('binds the actual native Counterparty and SLE while omitting only the execution locator', () =>
  Effect.gen(function* actualNativeProjection() {
    const payload = yield* Schema.decodeUnknownEffect(CreateCounterpartyPurchasingProfilePayloadSchema)(native);
    const original = yield* fingerprintOrganizationProfileSourceCreate(payload);
    const witness = {
      effectId: source.effectId,
      originalAdmissionInvocationId: 'bd000000-0000-4000-8000-000000000006',
      semanticInputDigest: 'a'.repeat(64),
      semanticProjectionVersion: 'commerce.customer-context.organization-profile-create-template-fields.v1',
    };
    expect(yield* fingerprintOrganizationProfileSourceCreate({ ...payload, sourceOrganizationWitness: witness })).toBe(
      original,
    );
    expect(
      yield* fingerprintOrganizationProfileSourceCreate({
        ...payload,
        subject: {
          ...payload.subject,
          counterpartyRef: { ...counterpartyRef, resourceId: 'bd000000-0000-4000-8000-000000000007' },
        },
      }),
    ).not.toBe(original);
    expect(
      yield* fingerprintOrganizationProfileSourceCreate({
        ...payload,
        subject: {
          ...payload.subject,
          sellingLegalEntityRef: { ...legalEntity, resourceId: 'bd000000-0000-4000-8000-000000000008' },
        },
      }),
    ).not.toBe(original);
  }),
);
it('rejects a witness for another effect and a caller-invented approval field', () => {
  expect(
    Schema.is(CreateCounterpartyPurchasingProfilePayloadSchema)({
      ...native,
      sourceOrganizationWitness: {
        effectId: 'bd000000-0000-4000-8000-000000000009',
        originalAdmissionInvocationId: 'bd000000-0000-4000-8000-000000000006',
        semanticInputDigest: 'a'.repeat(64),
        semanticProjectionVersion: 'commerce.customer-context.organization-profile-create-template-fields.v1',
      },
    }),
  ).toBe(false);
  expect(() =>
    Schema.decodeUnknownSync(OrganizationProfileSourceCreateTemplateSchema, { onExcessProperty: 'error' })({
      ...template,
      approval: true,
    }),
  ).toThrow();
});
it('keeps original actor and optional SLE outside the finite receipt/current projection', () => {
  const receipt = {
    actionInvocationId: 'bd000000-0000-4000-8000-000000000010',
    intent: { ...template.payload, subject: { counterpartyRef, kind: 'COUNTERPARTY' } },
    profileKind: 'COUNTERPARTY',
    recordedAt: '2026-11-07T00:00:00.000Z',
    result: {
      outcome: 'PROFILE_CREATED',
      profileRef: {
        moduleId: 'commerce.customer-context',
        resourceId: 'bd000000-0000-4000-8000-000000000011',
        resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
        tenantId,
      },
      revision: 1,
      sourceEffect: { effectId: source.effectId, replayed: false },
      state: 'ACTIVE',
    },
  };
  expect(Schema.is(OrganizationProfileSourceReceiptSchema)(receipt)).toBe(true);
  expect(() =>
    Schema.decodeUnknownSync(OrganizationProfileSourceReceiptSchema, { onExcessProperty: 'error' })({
      ...receipt,
      actorPrincipalId: 'private-actor',
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(OrganizationProfileSourceReceiptSchema, { onExcessProperty: 'error' })({
      ...receipt,
      intent: native,
    }),
  ).toThrow();
  expect(() =>
    Schema.decodeUnknownSync(OrganizationProfileSourceCurrentSchema, { onExcessProperty: 'error' })({
      partyRef: { moduleId: 'party.registry', resourceId: 'party-org', resourceType: 'party.registry.party', tenantId },
      partySourceReference,
      profile: {
        profileRef: { ...receipt.result.profileRef, kind: 'COUNTERPARTY' },
        revision: 1,
        state: 'ACTIVE',
        subject: native.subject,
      },
      source,
    }),
  ).toThrow();
});
