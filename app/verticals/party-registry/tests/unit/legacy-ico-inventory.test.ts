import { DateTime, Effect, Schema, Result } from 'effect';
import { TrustedPrincipalContextSchema } from '@app/core-runtime';
import { expect, it } from 'effect-rstest';
import {
  LegacyIcoInventoryRequestSchema,
  LegacyIcoInventoryResponseSchema,
} from '../../shared/apis/legacy-ico-inventory.ts';
import { FenceLegacyIcoAuthorityPayloadSchema } from '../../shared/actions/fence-legacy-ico-authority.ts';
import type { partyOfficialIdentifiers } from '../../src/db/schema.ts';
import {
  authorizeLegacyIco,
  PartyLegacyIcoPrivacy,
  legacyIcoAssertionRevision,
  legacyIcoInventorySnapshotVersion,
} from '../../src/services/legacy-ico-authority.service.ts';
import { checkLegacyIcoPrivacy, withLegacyIcoPrivacySite } from '../../src/services/legacy-ico-privacy.service.ts';

const tenantId = 'a1000000-0000-4000-8000-000000000001';
const id = 'a2000000-0000-4000-8000-000000000001';
const row: typeof partyOfficialIdentifiers.$inferSelect = {
  tenantId,
  officialIdentifierId: id,
  partyId: 'a3000000-0000-4000-8000-000000000001',
  identifierTypeKey: 'ICO',
  namespace: 'CZ:ICO',
  jurisdiction: 'CZ',
  normalizedValue: '01000004',
  originalInputDigits: null,
  state: 'ACTIVE',
  isCurrent: true,
  validFrom: DateTime.toDateUtc(DateTime.makeUnsafe('2020-01-01T00:00:00Z')),
  validTo: null,
  recordedAt: DateTime.toDateUtc(DateTime.makeUnsafe('2020-01-02T00:00:00Z')),
  provenanceSource: 'internal-fixture',
  provenanceMethod: 'LEGACY_IMPORT',
  externalEvidence: null,
  acceptedByActionInvocationId: id,
  acceptedByPrincipalId: id,
  policyVersion: 'legacy',
  supersedesOfficialIdentifierId: null,
  retractsOfficialIdentifierId: null,
};
const ref = {
  moduleId: 'party.registry',
  resourceType: 'party.registry.party-official-identifier',
  resourceId: id,
  tenantId,
} as const;

it('public inventory and fence accept only the explicit bounded organization projection', () => {
  expect(Schema.is(LegacyIcoInventoryRequestSchema)({})).toBe(true);
  expect(Schema.is(LegacyIcoInventoryRequestSchema)({ projection: 'ORGANIZATION_ICO_FIELDS_V1' })).toBe(true);
  expect(Schema.is(LegacyIcoInventoryRequestSchema)({ projection: 'ANY_ORGANIZATION_DATA' })).toBe(false);
  expect(
    Schema.is(FenceLegacyIcoAuthorityPayloadSchema)({
      expectedSnapshotVersion: 'a'.repeat(64),
      migrationPlanRef: 'internal-fixture',
      projection: 'ORGANIZATION_ICO_FIELDS_V1',
    }),
  ).toBe(true);
});

it('versions original-input knowledge, state, historical effective time and recorded provenance independently', () => {
  const baseline = legacyIcoAssertionRevision(row);
  for (const changed of [
    { originalInputDigits: '1000004' },
    { state: 'ENDED', isCurrent: false },
    { validTo: DateTime.toDateUtc(DateTime.makeUnsafe('2021-01-01T00:00:00Z')) },
    { provenanceMethod: 'CORRECTED_IMPORT' },
    { acceptedByActionInvocationId: 'a2000000-0000-4000-8000-000000000002' },
  ]) {
    expect(legacyIcoAssertionRevision({ ...row, ...changed })).not.toBe(baseline);
  }
  expect(legacyIcoAssertionRevision({ ...row })).toBe(baseline);
});

it('complete inventory version is order independent and detects removal, additions, revision or Tenant changes', () => {
  const first = { assertionRef: ref, revision: legacyIcoAssertionRevision(row) };
  const second = {
    assertionRef: { ...ref, resourceId: 'a2000000-0000-4000-8000-000000000002' },
    revision: 'b'.repeat(64),
  };
  const hash = legacyIcoInventorySnapshotVersion(tenantId, [first, second]);
  expect(legacyIcoInventorySnapshotVersion(tenantId, [second, first])).toBe(hash);
  expect(legacyIcoInventorySnapshotVersion(tenantId, [first])).not.toBe(hash);
  expect(legacyIcoInventorySnapshotVersion('a1000000-0000-4000-8000-000000000002', [first, second])).not.toBe(hash);
  expect(legacyIcoInventorySnapshotVersion(tenantId, [first, { ...second, revision: 'c'.repeat(64) }])).not.toBe(hash);
});

it('public inventory preserves unknown original input and includes ended assertions instead of manufacturing Current', () => {
  const payload = {
    tenantId,
    completeness: 'ALL_LEGACY_ICO_ASSERTIONS',
    snapshotVersion: 'a'.repeat(64),
    authority: { kind: 'LEGACY_PARTY' },
    assertions: [
      {
        assertionRef: ref,
        partyRef: { ...ref, resourceType: 'party.registry.party', resourceId: row.partyId },
        revision: 'b'.repeat(64),
        normalizedValue: row.normalizedValue,
        originalInput: { kind: 'UNKNOWN' },
        state: 'ENDED',
        isCurrent: false,
        validFrom: row.validFrom.toISOString(),
        validTo: '2021-01-01T00:00:00.000Z',
        recordedAt: row.recordedAt.toISOString(),
        provenance: {
          source: row.provenanceSource,
          method: row.provenanceMethod,
          policyVersion: row.policyVersion,
          acceptedByActionInvocationId: id,
          acceptedByPrincipalId: id,
          supersedesAssertionId: null,
          retractsAssertionId: null,
        },
      },
    ],
  };
  const decoded = Schema.decodeUnknownSync(LegacyIcoInventoryResponseSchema)(payload);
  expect(decoded.assertions[0]?.originalInput).toEqual({ kind: 'UNKNOWN' });
  expect(decoded.assertions[0]?.isCurrent).toBe(false);
});

it.effect('inventory and fence re-check current Privacy and fail closed without or after denied policy', () =>
  Effect.gen(function* privacyBoundary() {
    const scope = {
      ...(yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)({
        tenantId,
        principalId: id,
        authMethod: 'session',
        authBindingId: id,
        authContextRef: 'session:internal-fixture',
      })),
      correlationId: 'internal-fixture',
    };
    expect(Result.isFailure(yield* authorizeLegacyIco(scope, 'INVENTORY', [row.partyId]).pipe(Effect.result))).toBe(
      true,
    );
    expect(Result.isFailure(yield* checkLegacyIcoPrivacy(scope, 'INVENTORY', []).pipe(Effect.result))).toBe(true);
    expect(yield* checkLegacyIcoPrivacy(scope, 'INVENTORY', []).pipe(withLegacyIcoPrivacySite('legacy-read'))).toEqual({
      outcome: 'ALLOWED',
      organizationOnlyPartyIds: [],
    });
    expect(Result.isFailure(yield* checkLegacyIcoPrivacy(scope, 'FENCE', []).pipe(Effect.result))).toBe(true);
    const calls: string[] = [];
    const policy = {
      authorize: (_scope: typeof scope, operation: 'INVENTORY' | 'FENCE') => {
        calls.push(operation);
        return Effect.succeed('ALLOWED' as const);
      },
    };
    yield* authorizeLegacyIco(scope, 'INVENTORY').pipe(Effect.provideService(PartyLegacyIcoPrivacy, policy));
    yield* authorizeLegacyIco(scope, 'FENCE').pipe(Effect.provideService(PartyLegacyIcoPrivacy, policy));
    expect(calls).toEqual(['INVENTORY', 'FENCE']);
    expect(
      Result.isFailure(
        yield* authorizeLegacyIco(scope, 'INVENTORY').pipe(
          Effect.provideService(PartyLegacyIcoPrivacy, { authorize: () => Effect.succeed('DENIED' as const) }),
          Effect.result,
        ),
      ),
    ).toBe(true);
  }),
);
