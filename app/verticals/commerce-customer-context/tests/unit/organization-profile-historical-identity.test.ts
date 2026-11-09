import { randomUUID } from 'node:crypto';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import {
  CustomerProfileOrganizationIcoFactsCurrentSchema,
  CustomerProfileOrganizationIcoFactsHistoricalIdentitySchema,
  CustomerProfileOrganizationIcoFactsRequestSchema,
  CustomerProfileOrganizationIcoFactsResponseSchema,
} from '../../shared/apis/customer-profile-organization-ico-facts.ts';

const tenantId = randomUUID();
const profileRef = {
  moduleId: 'commerce.customer-context',
  resourceId: randomUUID(),
  resourceType: 'commerce.customer-context.counterparty-purchasing-profile',
  tenantId,
};
const identity = {
  _tag: 'CURRENT_HISTORICAL_IDENTITY',
  counterpartyRef: {
    moduleId: 'party.registry',
    resourceId: randomUUID(),
    resourceType: 'party.registry.counterparty',
    tenantId,
  },
  counterpartyRevision: 'a'.repeat(64),
  currentCustomerRoleRef: {
    moduleId: 'party.registry',
    resourceId: randomUUID(),
    resourceType: 'party.registry.counterparty-role-period',
    tenantId,
  },
  currentCustomerRoleRevision: 'b'.repeat(64),
  legalEntityRef: {
    moduleId: 'core.identity',
    resourceId: randomUUID(),
    resourceType: 'core.identity.legal-entity',
    tenantId,
  },
  partyRef: { moduleId: 'party.registry', resourceId: randomUUID(), resourceType: 'party.registry.party', tenantId },
  partyRevision: 3,
  profileRef,
  profileRevision: 7,
  profileState: 'ARCHIVED',
};
it.effect('requires the explicit historical identity selector without accepting a caller-supplied profile state', () =>
  Effect.gen(function* historicalSelector() {
    expect(yield* Schema.decodeUnknownEffect(CustomerProfileOrganizationIcoFactsRequestSchema)({ profileRef })).toEqual(
      { profileRef },
    );
    expect(
      yield* Schema.decodeUnknownEffect(CustomerProfileOrganizationIcoFactsRequestSchema)({
        identityState: 'HISTORICAL',
        profileRef,
      }),
    ).toEqual({ identityState: 'HISTORICAL', profileRef });
    expect(Schema.is(CustomerProfileOrganizationIcoFactsRequestSchema)({ identityState: 'ARCHIVED', profileRef })).toBe(
      false,
    );
    const strict = yield* Schema.decodeUnknownEffect(CustomerProfileOrganizationIcoFactsRequestSchema, {
      onExcessProperty: 'error',
    })({ identityState: 'HISTORICAL', profileRef, profileState: 'ACTIVE' }).pipe(Effect.flip);
    expect(strict).toBeDefined();
  }),
);
it.effect(
  'keeps historical identity distinct from active write eligibility and requires current customer-role evidence',
  () =>
    Effect.gen(function* boundedHistoricalIdentity() {
      for (const profileState of ['ACTIVE', 'SUSPENDED', 'ARCHIVED']) {
        const decoded = yield* Schema.decodeUnknownEffect(CustomerProfileOrganizationIcoFactsHistoricalIdentitySchema)({
          ...identity,
          profileState,
        });
        expect(decoded.profileState).toBe(profileState);
        expect(Schema.is(CustomerProfileOrganizationIcoFactsCurrentSchema)(decoded)).toBe(false);
        expect(Schema.is(CustomerProfileOrganizationIcoFactsResponseSchema)(decoded)).toBe(true);
      }
      const { currentCustomerRoleRef: _role, ...missingRole } = identity;
      expect(Schema.is(CustomerProfileOrganizationIcoFactsHistoricalIdentitySchema)(missingRole)).toBe(false);
      const extraMaterial = yield* Schema.decodeUnknownEffect(
        CustomerProfileOrganizationIcoFactsHistoricalIdentitySchema,
        { onExcessProperty: 'error' },
      )({ ...identity, displayName: 'EXCLUDED', normalizedValue: '00000019' }).pipe(Effect.flip);
      expect(extraMaterial).toBeDefined();
    }),
);
