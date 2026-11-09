import { normalizeOfficialIdentifier } from '@app/party-registry/domain/identifier-contracts';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  ChangeOrganizationCustomerProfileIcoPayloadSchema,
  ORGANIZATION_PROFILE_ICO_FIELDS,
  OrganizationCustomerProfileIcoResponseSchema,
  OrganizationProfileIcoAssertionSchema,
} from '../../shared/domain/organization-profile-ico.ts';

const tenantId = 'bc000000-0000-4000-8000-000000000001';
const profileRef = {
  moduleId: 'commerce.customer-context',
  resourceId: 'bc000000-0000-4000-8000-000000000002',
  resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
  tenantId,
} as const;
const command = {
  countryCode: 'CZ',
  effectId: 'bc000000-0000-4000-8000-000000000003',
  effectiveAt: '2025-01-01T00:00:00.000Z',
  expectedRevision: 0,
  identifier: { identifierType: 'ICO', value: '19' },
  operation: 'SET',
  originalInput: '19',
  profileRef,
} as const;
const assertion = {
  effectiveAt: command.effectiveAt,
  effectiveTo: null,
  isCurrent: true,
  normalizedValue: '00000019',
  normalizerVersion: 'CZ:ICO:party-v1',
  operation: 'SET',
  originalInput: { digits: '19', kind: 'KNOWN' },
  partyRef: {
    moduleId: 'party.registry',
    resourceId: 'bc000000-0000-4000-8000-000000000004',
    resourceType: 'party.registry.party',
    tenantId,
  },
  profileRef,
  provenance: {
    ownerReceiptRef: { _tag: 'CORE_ACTION_INVOCATION', actionInvocationId: 'bc000000-0000-4000-8000-000000000005' },
  },
  recordedAt: '2026-11-07T00:00:00.000Z',
  revision: 1,
} as const;

it.effect('retains exact accepted numeric digits and uses the published Party normalizer', () =>
  Effect.gen(function* numericCompanyContract() {
    const decoded = yield* Schema.decodeUnknownEffect(ChangeOrganizationCustomerProfileIcoPayloadSchema)(command);
    expect(decoded).toEqual(command);
    expect(normalizeOfficialIdentifier(command.identifier)).toEqual({
      identifierType: 'ICO',
      namespace: 'CZ:ICO',
      normalizedValue: '00000019',
    });
  }),
);
it('rejects DIČ, non-Czech, invalid checksum, and mismatched original digits', () => {
  expect(Schema.is(ChangeOrganizationCustomerProfileIcoPayloadSchema)({ ...command, countryCode: 'SK' })).toBe(false);
  expect(
    Schema.is(ChangeOrganizationCustomerProfileIcoPayloadSchema)({
      ...command,
      identifier: { identifierType: 'CZ_DIC', value: 'CZ27074358' },
      originalInput: '27074358',
    }),
  ).toBe(false);
  expect(
    Schema.is(ChangeOrganizationCustomerProfileIcoPayloadSchema)({
      ...command,
      identifier: { identifierType: 'ICO', value: '12345678' },
      originalInput: '12345678',
    }),
  ).toBe(false);
  expect(Schema.is(ChangeOrganizationCustomerProfileIcoPayloadSchema)({ ...command, originalInput: '019' })).toBe(
    false,
  );
  expect(Schema.is(ChangeOrganizationCustomerProfileIcoPayloadSchema)({ ...command, originalInput: 'CZ19' })).toBe(
    false,
  );
});
it('requires the concrete Counterparty profile resource and bounded revisions', () => {
  expect(
    Schema.is(ChangeOrganizationCustomerProfileIcoPayloadSchema)({
      ...command,
      profileRef: { ...profileRef, resourceType: 'commerce.customer-context.retail-customer-profile' },
    }),
  ).toBe(false);
  expect(Schema.is(ChangeOrganizationCustomerProfileIcoPayloadSchema)({ ...command, expectedRevision: -1 })).toBe(
    false,
  );
  expect(
    Schema.is(ChangeOrganizationCustomerProfileIcoPayloadSchema)({ ...command, effectId: 'not-native-uuid' }),
  ).toBe(false);
});
it('exposes exactly the approved thirteen field paths, excluding raw actor, reason, and source', () => {
  expect(ORGANIZATION_PROFILE_ICO_FIELDS).toHaveLength(13);
  expect(Schema.is(OrganizationProfileIcoAssertionSchema)(assertion)).toBe(true);
  for (const extra of [
    { actor: { principalId: 'private-actor' } },
    { reason: 'private-declaration-reason' },
    { source: 'private-source-record' },
  ]) {
    expect(() =>
      Schema.decodeUnknownSync(OrganizationProfileIcoAssertionSchema, { onExcessProperty: 'error' })({
        ...assertion,
        ...extra,
      }),
    ).toThrow();
  }
  expect(() =>
    Schema.decodeUnknownSync(ChangeOrganizationCustomerProfileIcoPayloadSchema, { onExcessProperty: 'error' })({
      ...command,
      reason: 'private-reason',
    }),
  ).toThrow();
});
it('preserves unknown legacy input and a native owner receipt without inventing digits', () => {
  const legacy = {
    ...assertion,
    normalizerVersion: null,
    originalInput: { kind: 'UNKNOWN' },
    provenance: {
      ownerReceiptRef: {
        moduleId: 'party.registry',
        resourceId: 'legacy-official-id',
        resourceType: 'party.registry.party-official-identifier',
        tenantId,
      },
    },
  };
  expect(Schema.is(OrganizationProfileIcoAssertionSchema)(legacy)).toBe(true);
  expect(Schema.is(OrganizationCustomerProfileIcoResponseSchema)({ _tag: 'RECEIPT', assertion: legacy })).toBe(true);
});
it('allows END without supplying a fabricated replacement identifier', () => {
  const { identifier, originalInput, ...base } = command;
  expect(identifier.value).toBe(originalInput);
  expect(
    Schema.is(ChangeOrganizationCustomerProfileIcoPayloadSchema)({ ...base, expectedRevision: 1, operation: 'END' }),
  ).toBe(true);
});

it('distinguishes a numeric Current from an ended receipt and from unknown original input', () => {
  const current = { ...assertion, originalInput: { kind: 'UNKNOWN' } };
  expect(
    Schema.is(OrganizationCustomerProfileIcoResponseSchema)({
      _tag: 'PRESENT',
      current,
      history: [current],
      revision: current.revision,
    }),
  ).toBe(true);
  const ended = { ...current, isCurrent: false, normalizedValue: null, operation: 'END' };
  expect(Schema.is(OrganizationCustomerProfileIcoResponseSchema)({ _tag: 'RECEIPT', assertion: ended })).toBe(true);
  for (const invalidCurrent of [ended, { ...current, normalizedValue: null }, { ...current, isCurrent: false }]) {
    expect(
      Schema.is(OrganizationCustomerProfileIcoResponseSchema)({
        _tag: 'PRESENT',
        current: invalidCurrent,
        history: [invalidCurrent],
        revision: invalidCurrent.revision,
      }),
    ).toBe(false);
  }
});
