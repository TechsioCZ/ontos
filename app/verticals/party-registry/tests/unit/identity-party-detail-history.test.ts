import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { makeTestDatabase } from '../../../../packages/core-runtime/tests/support/database.ts';
import { PartyFactAssertionSchema } from '../../shared/apis/party-detail.ts';
import { PartySchema } from '../../shared/domain/identity-contracts.ts';
import { partyDetailRead, readPartyDetailFromServices } from '../../src/api/party-detail.read.ts';
import { findPartyDetailAssertions } from '../../src/services/party-detail-persistence.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const partyId = '22222222-2222-4222-8222-222222222222';
const assertionId = '33333333-3333-4333-8333-333333333333';
const previousId = '44444444-4444-4444-8444-444444444444';
const principalId = '55555555-5555-4555-8555-555555555555';
const scope = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '66666666-6666-4666-8666-666666666666',
    authContextRef: 'better-auth-session:party-detail-history',
    authMethod: 'session',
    principalId,
    tenantId,
  }),
  correlationId: 'party-detail-history',
} as const;
const partyRef = {
  moduleId: 'party.registry',
  resourceId: partyId,
  resourceType: 'party.registry.party',
  tenantId,
} as const;
const wireFact = {
  assertionId,
  factKind: 'BUSINESS_NAME',
  isCurrent: true,
  partyRef,
  recordedAt: '2026-09-03T10:00:00.000Z',
  retractsAssertionId: null,
  state: 'ACTIVE',
  supersedesAssertionId: previousId,
  validFrom: '2026-09-03T10:00:00.000Z',
  validTo: null,
  value: 'Corrected name',
} as const;
const fact = Schema.decodeSync(PartyFactAssertionSchema)(wireFact);

it.effect('Party fact assertion contract exposes usable correction identities without sensitive evidence', () =>
  Effect.gen(function* verifySchema1() {
    expect(yield* Schema.encodeEffect(PartyFactAssertionSchema)(fact)).toEqual(wireFact);
    expect(() =>
      Schema.decodeSync(PartyFactAssertionSchema)({
        ...wireFact,
        assertionId: 'not-a-uuid',
      }),
    ).toThrow();
    const decodedWithSensitiveFields = yield* Schema.decodeUnknownEffect(PartyFactAssertionSchema)({
      ...wireFact,
      evidenceRefs: ['secret'],
      provenance: { source: 'secret' },
    });
    expect(yield* Schema.encodeEffect(PartyFactAssertionSchema)(decodedWithSensitiveFields)).toEqual(wireFact);
  }),
);

it('Party Detail is one governed record read: the same Party decision covers current facts and their history', () => {
  const { accessDeclaration, accessTarget } = partyDetailRead.descriptor;
  expect(accessDeclaration?.key).toBe('party.registry.party.read');
  expect(accessDeclaration?.selectors).toEqual(['all']);
  // A person's own rights decide it; the Storefront client, as the subject of a Retail self-enrollment,
  // is decided by its workload binding instead.
  expect(partyDetailRead.descriptor.accessActor).toEqual({
    callers: ['commerce-customer-context', 'catalog'],
    reason: expect.any(String),
    subject: 'rights',
    subjectWorkloads: ['commerce.storefront-client'],
  });
  // Asking for the history never widens the request into a second, review-only capability: the record
  // read decides both branches, and the identity values it returns are their own field group (O24, O58).
  expect(accessTarget?.({ partyRef }, scope)).toEqual({ moduleKey: 'party.registry', recordKey: partyId });
});

it.effect(
  'Party Detail persistence reads safe current and immutable historical assertions through a tenant-scoped query',
  () =>
    Effect.gen(function* verifyPartyDetail1() {
      const queries: string[] = [];
      const values: (readonly unknown[])[] = [];
      const rows = [
        [
          previousId,
          null,
          'BUSINESS_NAME',
          false,
          '2026-09-01T10:00:00.000Z',
          null,
          'SUPERSEDED',
          null,
          '2026-09-01T10:00:00.000Z',
          '2026-09-03T10:00:00.000Z',
          'Original name',
        ],
        [
          assertionId,
          null,
          'BUSINESS_NAME',
          true,
          '2026-09-03T10:00:00.000Z',
          null,
          'ACTIVE',
          previousId,
          '2026-09-03T10:00:00.000Z',
          null,
          'Corrected name',
        ],
      ];
      const database = yield* makeTestDatabase((text: string, parameters: readonly unknown[]) =>
        Effect.sync(() => {
          queries.push(text);
          values.push(parameters);
          return rows.map((row) => Object.fromEntries(row.map((value, index) => [String(index), value])));
        }),
      );

      const result = yield* findPartyDetailAssertions(database, tenantId, partyId, true);
      expect(result.currentFactAssertions).toEqual([fact]);
      const history = Option.getOrThrow(result.factHistory);
      expect(history.length).toBe(2);
      expect(history[0]?.value).toBe('Original name');
      expect(history[0]?.state).toBe('SUPERSEDED');
      const current = yield* findPartyDetailAssertions(database, tenantId, partyId, false);
      expect(current).toEqual({
        currentFactAssertions: [fact],
        factHistory: Option.none(),
      });
      expect(values).toEqual([
        [tenantId, partyId],
        [tenantId, partyId, 'ACTIVE', true],
      ]);
      const [historyQuery = '', currentQuery = ''] = queries;
      expect(historyQuery).toMatch(/"tenant_id" = \$1/u);
      expect(historyQuery).toMatch(/"party_id" = \$2/u);
      expect(historyQuery).not.toMatch(/provenance|principal|invocation|verification/u);
      expect(currentQuery).not.toMatch(/external_evidence/u);
      expect(currentQuery).toMatch(/"state" = \$3/u);
      expect(currentQuery).toMatch(/"is_current" = \$4/u);
      const detail = yield* readPartyDetailFromServices(
        partyRef,
        tenantId,
        {
          facts: (canonicalPartyId, includeHistory) =>
            findPartyDetailAssertions(database, tenantId, canonicalPartyId, includeHistory),
          find: () =>
            Effect.succeed({
              _tag: 'found' as const,
              value: Schema.decodeSync(PartySchema)({
                archivedAt: null,
                createdAt: '2026-09-01T10:00:00.000Z',
                businessName: 'Corrected name',
                displayName: 'Corrected name',
                firstName: null,
                lastName: null,
                partyRef,
                partyType: 'ORGANIZATION' as const,
                revision: 2,
                updatedAt: '2026-09-03T10:00:00.000Z',
              }),
            }),
          historicalNames: () => Effect.succeed([]),
          resolve: () =>
            Effect.succeed({
              canonicalPartyId: partyId,
              requestedPartyId: partyId,
              traversedAliasIds: [],
              wasAlias: false,
            }),
        },
        true,
      );
      expect(detail.currentFactAssertions[0]?.assertionId).toBe(assertionId);
      const detailHistory = detail.factHistory ?? [];
      expect(detailHistory[0]?.assertionId).toBe(previousId);
      expect(detailHistory[0]?.value).toBe('Original name');
    }),
);
