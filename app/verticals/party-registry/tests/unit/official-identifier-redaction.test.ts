import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { projectReadResultFields } from '../../../../packages/core-runtime/src/reads/definition.ts';
import { PartyOfficialIdentifierDetailResponseSchema } from '../../shared/apis/party-official-identifier-detail.ts';
import { PartyOfficialIdentifierHistoryResponseSchema } from '../../shared/apis/party-official-identifier-history.ts';
import { OfficialIdentifierAssertionSchema } from '../../shared/domain/identifier-contracts.ts';
import { partyOfficialIdentifierDetailRead } from '../../src/api/party-official-identifier-detail.read.ts';
import { partyOfficialIdentifierHistoryRead } from '../../src/api/party-official-identifier-history.read.ts';

const identifierRef = {
  moduleId: 'party.registry',
  resourceId: '20000000-0000-4000-8000-000000000001',
  resourceType: 'party.registry.party-official-identifier',
  tenantId: '10000000-0000-4000-8000-000000000001',
} as const;
const assertion = Schema.decodeSync(OfficialIdentifierAssertionSchema)({
  identifierType: 'ICO',
  namespace: 'CZ:ICO',
  normalizedValue: '01000004',
  officialIdentifierRef: identifierRef,
  originalInputDigits: '1000004',
  partyRef: { ...identifierRef, resourceType: 'party.registry.party' },
  recordedAt: '2026-01-01T00:00:00.000Z',
  state: 'ACTIVE',
  validFrom: '2026-01-01T00:00:00.000Z',
  validTo: null,
  verification: 'VERIFIED',
});

/** The paths a read declares, exactly as the runtime removes them for a caller without the group. */
const deniedPathsOf = (read: typeof partyOfficialIdentifierDetailRead | typeof partyOfficialIdentifierHistoryRead) =>
  (read.descriptor.accessFieldGroups ?? []).flatMap((group) => group.fields.map((field) => field.split('.')));

it.effect('a caller without the value grant gets the identifier without its value, not a failed encode', () =>
  Effect.gen(function* verifyRedactedIdentifierDetail() {
    const redacted = Option.getOrThrow(
      projectReadResultFields(
        assertion,
        deniedPathsOf(partyOfficialIdentifierDetailRead),
        PartyOfficialIdentifierDetailResponseSchema,
      ),
    );
    // The HTTP endpoint encodes the success value against the response schema before it is sent.
    const wire = yield* Schema.encodeEffect(PartyOfficialIdentifierDetailResponseSchema)(redacted);
    expect(wire).not.toHaveProperty('normalizedValue');
    expect(wire).not.toHaveProperty('originalInputDigits');
    expect(wire.officialIdentifierRef).toEqual(identifierRef);
    expect(wire.identifierType).toBe('ICO');
    // The domain model stays strict: only the read view may omit the value.
    expect(Schema.is(OfficialIdentifierAssertionSchema)(redacted)).toBe(false);
  }),
);

it.effect('the history redacts the value of every row and keeps the rows', () =>
  Effect.gen(function* verifyRedactedIdentifierHistory() {
    const history = { items: [assertion, assertion] };
    const redacted = Option.getOrThrow(
      projectReadResultFields(
        history,
        deniedPathsOf(partyOfficialIdentifierHistoryRead),
        PartyOfficialIdentifierHistoryResponseSchema,
      ),
    );
    const wire = yield* Schema.encodeEffect(PartyOfficialIdentifierHistoryResponseSchema)(redacted);
    expect(wire.items).toHaveLength(2);
    for (const item of wire.items) {
      expect(item).not.toHaveProperty('normalizedValue');
      expect(item.state).toBe('ACTIVE');
    }
  }),
);

it.effect('a caller holding the value grant still gets the value and its original digits', () =>
  Effect.gen(function* verifyFullIdentifierDetail() {
    const complete = Option.getOrThrow(
      projectReadResultFields(assertion, [], PartyOfficialIdentifierDetailResponseSchema),
    );
    const wire = yield* Schema.encodeEffect(PartyOfficialIdentifierDetailResponseSchema)(complete);
    expect(wire.normalizedValue).toBe('01000004');
    expect(wire.originalInputDigits).toBe('1000004');
  }),
);
