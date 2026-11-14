import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';
import { describe, expect, it } from 'effect-rstest';
import { OrganizationIcoApplicabilityRequestSchema } from '../../shared/apis/organization-ico-applicability.ts';
import { evaluateOrganizationIcoApplicability } from '../../src/services/organization-ico-applicability.service.ts';
import type { OrganizationIcoApplicabilityServices } from '../../src/services/organization-ico-applicability.service.ts';
import { makeOrganizationIcoApplicabilityFixture } from '../support/organization-ico-applicability.fixture.ts';

const ids = {
  legalEntityId: '71000000-0000-4000-8000-000000000002',
  principalId: '71000000-0000-4000-8000-000000000003',
  tenantId: '71000000-0000-4000-8000-000000000001',
};
const fixture = makeOrganizationIcoApplicabilityFixture(ids);
const scope = {
  ...Schema.decodeUnknownSync(TrustedPrincipalContextSchema)({
    ...ids,
    authBindingId: '71000000-0000-4000-8000-000000000004',
    authContextRef: 'fixture:organization-ico',
    authenticationNamespaceId: 'core.staff',
    authMethod: 'session',
  }),
  correlationId: 'fixture:organization-ico',
};
const services: OrganizationIcoApplicabilityServices = {
  contexts: [fixture.context],
  decision: () => Effect.succeed(Option.some(fixture.decision)),
  holds: () => Effect.succeed('CLEAR'),
  proof: () => Effect.succeed(fixture.proof),
  purposes: { get: () => Effect.succeed(Option.some(fixture.purpose)) },
  repository: {
    listApplicabilityDecisions: () => Effect.succeed([fixture.decision]),
    listApplicabilityPolicies: () => Effect.succeed([fixture.policy]),
    listResponsibilities: () => Effect.succeed([fixture.responsibility]),
  },
};
const run = (ports = services, evaluatedAt = fixture.evaluatedAt) =>
  evaluateOrganizationIcoApplicability(fixture.request, scope, ports, evaluatedAt);
describe('native organization ICO-only classification', () => {
  it.effect('requires no dummy subject, consent or legal basis but actual current native classification', () =>
    Effect.gen(function* test() {
      expect(fixture.decision.nonPersonalApplicability?.kind).toBe('ORGANIZATION_ICO_ONLY');
      expect(fixture.business.scope.facts.some(({ dimension }) => dimension === 'PRIVACY_SUBJECT')).toBe(false);
      expect(yield* run()).toMatchObject({
        allowedFields: fixture.request.fields,
        outcome: 'NOT_APPLICABLE',
        partyRevision: 7,
      });
    }),
  );
  it.effect('denies absent classification, changed current policy, stale owner revision and nonorganization', () =>
    Effect.gen(function* test() {
      expect((yield* run({ ...services, contexts: [] })).outcome).toBe('DENIED');
      expect(
        (yield* run({
          ...services,
          repository: { ...services.repository, listApplicabilityPolicies: () => Effect.succeed([]) },
        })).outcome,
      ).toBe('DENIED');
      expect(
        (yield* run({ ...services, proof: () => Effect.succeed({ ...fixture.proof, partyRevision: 8 }) })).outcome,
      ).toBe('DENIED');
      expect(
        (yield* run({
          ...services,
          proof: () =>
            Effect.succeed({
              fieldContractVersion: fixture.proof.fieldContractVersion,
              outcome: 'NOT_CURRENT_ORGANIZATION',
            }),
        })).outcome,
      ).toBe('DENIED');
    }),
  );
  it.effect('requires the explicit ICO marker and rejects a superseding unresolved native decision', () =>
    Effect.gen(function* test() {
      const { nonPersonalApplicability: _classification, ...ordinaryPolicy } = fixture.policy;
      expect(
        (yield* run({
          ...services,
          repository: { ...services.repository, listApplicabilityPolicies: () => Effect.succeed([ordinaryPolicy]) },
        })).outcome,
      ).toBe('DENIED');
      expect(
        (yield* run({
          ...services,
          repository: {
            ...services.repository,
            listApplicabilityDecisions: () =>
              Effect.succeed([
                fixture.decision,
                { ...fixture.decision, evaluatedAt: '2026-11-07T12:00:01.000Z', outcome: 'UNRESOLVED' },
              ]),
          },
        })).outcome,
      ).toBe('NOT_APPLICABLE');
      expect(
        (yield* run({
          ...services,
          repository: {
            ...services.repository,
            listApplicabilityDecisions: () =>
              Effect.succeed([
                fixture.decision,
                { ...fixture.decision, evaluatedAt: '2026-11-07T11:59:59.000Z', outcome: 'UNRESOLVED' },
              ]),
          },
        })).outcome,
      ).toBe('NOT_APPLICABLE');
      expect(
        (yield* run({
          ...services,
          repository: {
            ...services.repository,
            listApplicabilityDecisions: () =>
              Effect.succeed([
                fixture.decision,
                { ...fixture.decision, evaluatedAt: fixture.evaluatedAt, outcome: 'UNRESOLVED' },
              ]),
          },
        })).outcome,
      ).toBe('DENIED');
      expect(
        (yield* run(
          {
            ...services,
            repository: {
              ...services.repository,
              listApplicabilityDecisions: () =>
                Effect.succeed([
                  fixture.decision,
                  { ...fixture.decision, evaluatedAt: '2026-11-07T12:00:01.000Z', outcome: 'UNRESOLVED' },
                ]),
            },
          },
          '2026-11-07T12:00:02.000Z',
        )).outcome,
      ).toBe('DENIED');
    }),
  );
  it.effect('rechecks revocation, purpose, exact Controller and current holds each attempt', () =>
    Effect.gen(function* test() {
      expect(
        (yield* run({ ...services, contexts: [{ ...fixture.context, authorityRevision: 'revision:2' }] })).outcome,
      ).toBe('DENIED');
      expect(
        (yield* run({
          ...services,
          purposes: { get: () => Effect.succeed(Option.some({ ...fixture.purpose, lifecycle: 'RETIRED' })) },
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
  it('refuses personal or free-text projection fields at decoding', () => {
    expect(Schema.is(OrganizationIcoApplicabilityRequestSchema)({ ...fixture.request, fields: ['businessName'] })).toBe(
      false,
    );
    expect(
      Schema.is(OrganizationIcoApplicabilityRequestSchema)({ ...fixture.request, fields: ['actorPrincipalId'] }),
    ).toBe(false);
  });
});
