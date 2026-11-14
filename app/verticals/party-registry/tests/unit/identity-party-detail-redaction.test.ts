import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { projectReadResultFields } from '../../../../packages/core-runtime/src/reads/definition.ts';
import {
  PartyDetailResponseSchema,
  PartyFactAssertionSchema,
  PartyHistoricalNameAssertionSchema,
} from '../../shared/apis/party-detail.ts';
import { PartySchema } from '../../shared/domain/identity-contracts.ts';
import { partyDetailRead, readPartyDetailFromServices } from '../../src/api/party-detail.read.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const partyId = '22222222-2222-4222-8222-222222222222';
const assertionId = '33333333-3333-4333-8333-333333333333';
const previousId = '44444444-4444-4444-8444-444444444444';
const partyRef = {
  moduleId: 'party.registry',
  resourceId: partyId,
  resourceType: 'party.registry.party',
  tenantId,
} as const;
const fact = Schema.decodeSync(PartyFactAssertionSchema)({
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
});
const previousFact = Schema.decodeSync(PartyFactAssertionSchema)({
  assertionId: previousId,
  factKind: 'BUSINESS_NAME',
  isCurrent: false,
  partyRef,
  recordedAt: '2026-09-01T10:00:00.000Z',
  retractsAssertionId: null,
  state: 'SUPERSEDED',
  supersedesAssertionId: null,
  validFrom: '2026-09-01T10:00:00.000Z',
  validTo: '2026-09-03T10:00:00.000Z',
  value: 'Original name',
});
const archivedNameId = '66666666-6666-4666-8666-666666666666';
const archivedName = Schema.decodeSync(PartyHistoricalNameAssertionSchema)({
  assertionId: archivedNameId,
  factKind: 'DISPLAY_NAME',
  isCurrent: false,
  partyRef,
  recordedAt: '2026-08-01T10:00:00.000Z',
  retractsAssertionId: null,
  state: 'SUPERSEDED',
  supersedesAssertionId: null,
  validFrom: '2026-08-01T10:00:00.000Z',
  validTo: '2026-09-01T10:00:00.000Z',
  value: 'Archived name',
});
const party = Schema.decodeSync(PartySchema)({
  archivedAt: null,
  businessName: 'Corrected name',
  createdAt: '2026-09-01T10:00:00.000Z',
  displayName: 'Corrected name',
  firstName: null,
  lastName: null,
  partyRef,
  partyType: 'ORGANIZATION',
  revision: 2,
  updatedAt: '2026-09-03T10:00:00.000Z',
});
const services = {
  facts: (_partyId: string, includeFactHistory: boolean) =>
    Effect.succeed({
      currentFactAssertions: [fact],
      factHistory: includeFactHistory ? Option.some([previousFact]) : Option.none(),
    }),
  find: () => Effect.succeed({ _tag: 'found' as const, value: party }),
  historicalNames: (_partyId: string) => Effect.succeed([archivedName]),
  resolve: () =>
    Effect.succeed({
      canonicalPartyId: partyId,
      requestedPartyId: partyId,
      traversedAliasIds: [],
      wasAlias: false,
    }),
};
// The paths the read declares as `party.registry.party-identity.read`, exactly as the runtime removes them.
const identityFieldPaths = (partyDetailRead.descriptor.accessFieldGroups ?? [])
  .filter((group) => group.key === 'party.registry.party-identity.read')
  .flatMap((group) => group.fields.map((field) => field.split('.')));

it.effect('a caller without identity read gets 200 with the identity fields absent, not a failed encode', () =>
  Effect.gen(function* verifyRedactedPartyDetail() {
    const result = yield* readPartyDetailFromServices(partyRef, tenantId, services, true);
    const redacted = Option.getOrThrow(projectReadResultFields(result, identityFieldPaths, PartyDetailResponseSchema));
    // The HTTP endpoint encodes the success value against the response schema before it is sent.
    const wire = yield* Schema.encodeEffect(PartyDetailResponseSchema)(redacted);
    for (const name of ['businessName', 'displayName', 'firstName', 'lastName']) {
      expect(wire.party).not.toHaveProperty(name);
    }
    expect(wire.party.partyRef).toEqual(partyRef);
    expect(wire.currentFactAssertions[0]).not.toHaveProperty('value');
    expect(wire.currentFactAssertions[0]?.assertionId).toBe(assertionId);
    expect(wire.factHistory?.[0]).not.toHaveProperty('value');
    expect(wire.factHistory?.[0]?.assertionId).toBe(previousId);
    // The archived name is redacted by the same field grant, so its own value goes too.
    expect(wire.historicalNameEvidence?.[0]).not.toHaveProperty('value');
    expect(wire.historicalNameEvidence?.[0]?.assertionId).toBe(archivedNameId);
    expect(wire.historicalNameEvidence?.[0]?.factKind).toBe('DISPLAY_NAME');
    expect(wire.resolution.kind).toBe('DIRECT');
  }),
);

it.effect('a caller holding every field group still gets the identity fields and the history', () =>
  Effect.gen(function* verifyFullPartyDetail() {
    const result = yield* readPartyDetailFromServices(partyRef, tenantId, services, true);
    const complete = Option.getOrThrow(projectReadResultFields(result, [], PartyDetailResponseSchema));
    const wire = yield* Schema.encodeEffect(PartyDetailResponseSchema)(complete);
    expect(wire.party.displayName).toBe('Corrected name');
    expect(wire.party.businessName).toBe('Corrected name');
    expect(wire.currentFactAssertions[0]?.value).toBe('Corrected name');
    expect(wire.factHistory?.[0]?.value).toBe('Original name');
    expect(wire.historicalNameEvidence?.[0]?.value).toBe('Archived name');
  }),
);
