import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { OrganizationProfileIcoApplicabilityRequestSchema } from '../../shared/apis/organization-profile-ico-applicability.ts';
import { evaluateOrganizationProfileIcoApplicability } from '../../src/services/organization-profile-ico-applicability.service.ts';
import type { OrganizationProfileIcoApplicabilityServices } from '../../src/services/organization-profile-ico-applicability.service.ts';
import { makeOrganizationProfileIcoApplicabilityFixture } from '../support/organization-profile-ico-applicability.fixture.ts';

const ids = {
  legalEntityId: '73000000-0000-4000-8000-000000000002',
  principalId: '73000000-0000-4000-8000-000000000003',
  tenantId: '73000000-0000-4000-8000-000000000001',
};
const fixture = makeOrganizationProfileIcoApplicabilityFixture(ids);
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    ...ids,
    authBindingId: '73000000-0000-4000-8000-000000000004',
    authContextRef: 'internal:profile-ico',
    authenticationNamespaceId: 'core.staff',
    authMethod: 'session',
  }),
  correlationId: 'internal:profile-ico',
};
const portsFor = (facts = fixture): OrganizationProfileIcoApplicabilityServices => ({
  contexts: [facts.context],
  decision: () => Effect.succeed(Option.some(facts.decision)),
  holds: () => Effect.succeed('CLEAR'),
  proof: () => Effect.succeed(facts.proof),
  purposes: { get: () => Effect.succeed(Option.some(facts.purpose)) },
  repository: {
    listApplicabilityDecisions: () => Effect.succeed([facts.decision]),
    listApplicabilityPolicies: () => Effect.succeed([facts.policy]),
    listResponsibilities: () => Effect.succeed([facts.responsibility]),
  },
});
const services = portsFor();
const run = (ports = services) =>
  evaluateOrganizationProfileIcoApplicability(fixture.request, scope, ports, fixture.evaluatedAt);
describe('organization profile ICO-only applicability', () => {
  it.effect('accepts only the current native explicit ICO policy for actual profile and organization proofs', () =>
    Effect.gen(function* test() {
      expect(fixture.business.scope.facts.some(({ dimension }) => dimension === 'PRIVACY_SUBJECT')).toBe(false);
      expect(yield* run()).toMatchObject({
        allowedFields: fixture.request.fields,
        outcome: 'NOT_APPLICABLE',
        partyRevision: 7,
        profileRevision: 5,
      });
    }),
  );
  it.effect('binds both profile and Party revision plus actual role correlation evidence', () =>
    Effect.gen(function* test() {
      expect(
        (yield* run({ ...services, proof: () => Effect.succeed({ ...fixture.proof, profileRevision: 6 }) })).outcome,
      ).toBe('DENIED');
      expect(
        (yield* run({
          ...services,
          proof: () =>
            Effect.succeed({ ...fixture.proof, organization: { ...fixture.proof.organization, partyRevision: 8 } }),
        })).outcome,
      ).toBe('DENIED');
      expect(
        (yield* run({
          ...services,
          proof: () =>
            Effect.succeed({ ...fixture.proof, profileCorrelationEvidenceRef: 'internal:changed-native-role-version' }),
        })).outcome,
      ).toBe('DENIED');
      expect(
        (yield* run({
          ...services,
          proof: () => Effect.succeed({ ...fixture.proof, legalEntityId: '73000000-0000-4000-8000-000000000099' }),
        })).outcome,
      ).toBe('DENIED');
    }),
  );
  it.effect('rechecks native marker, configuration, Controller and holds', () =>
    Effect.gen(function* test() {
      expect((yield* run({ ...services, contexts: [] })).outcome).toBe('DENIED');
      expect(
        (yield* run({ ...services, contexts: [{ ...fixture.context, authorityRevision: 'internal:revoked' }] }))
          .outcome,
      ).toBe('DENIED');
      expect(
        (yield* run({
          ...services,
          repository: { ...services.repository, listApplicabilityPolicies: () => Effect.succeed([]) },
        })).outcome,
      ).toBe('DENIED');
      expect(
        (yield* run({
          ...services,
          repository: { ...services.repository, listResponsibilities: () => Effect.succeed([]) },
        })).outcome,
      ).toBe('DENIED');
      expect((yield* run({ ...services, holds: () => Effect.succeed('BLOCKED') })).outcome).toBe('DENIED');
      expect((yield* run({ ...services, holds: () => Effect.succeed('INDETERMINATE') })).outcome).toBe('INDETERMINATE');
    }),
  );
  it.effect('keeps write and migration classifications separately explicit', () =>
    Effect.gen(function* test() {
      const write = makeOrganizationProfileIcoApplicabilityFixture({ ...ids, operation: 'customer-profile-ico.write' });
      const migrate = makeOrganizationProfileIcoApplicabilityFixture({
        ...ids,
        operation: 'customer-profile-ico.migrate',
      });
      expect(
        (yield* evaluateOrganizationProfileIcoApplicability(write.request, scope, portsFor(write), write.evaluatedAt))
          .outcome,
      ).toBe('NOT_APPLICABLE');
      expect(
        (yield* evaluateOrganizationProfileIcoApplicability(
          migrate.request,
          scope,
          portsFor(migrate),
          migrate.evaluatedAt,
        )).outcome,
      ).toBe('NOT_APPLICABLE');
      expect(
        (yield* evaluateOrganizationProfileIcoApplicability(write.request, scope, services, fixture.evaluatedAt))
          .outcome,
      ).toBe('DENIED');
    }),
  );
  it('refuses retail profiles, contacts, actor provenance and generic profile operations', () => {
    expect(
      Schema.is(OrganizationProfileIcoApplicabilityRequestSchema)({ ...fixture.request, fields: ['reason'] }),
    ).toBe(false);
    expect(
      Schema.is(OrganizationProfileIcoApplicabilityRequestSchema)({ ...fixture.request, fields: ['actorPrincipalId'] }),
    ).toBe(false);
    expect(
      Schema.is(OrganizationProfileIcoApplicabilityRequestSchema)({
        ...fixture.request,
        operation: 'customer-profile.write',
      }),
    ).toBe(false);
    expect(
      Schema.is(OrganizationProfileIcoApplicabilityRequestSchema)({
        ...fixture.request,
        profileRef: {
          ...fixture.request.profileRef,
          resourceType: 'commerce.customer-context.retail-customer-profile',
        },
      }),
    ).toBe(false);
  });
});
