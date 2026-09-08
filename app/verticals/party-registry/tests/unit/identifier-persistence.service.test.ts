import { TestClock } from 'effect/testing';
import { expect, it } from 'effect-rstest';
import { DateTime, Effect, Match, Schema, Predicate } from 'effect';
/* eslint-disable anti-slop/no-chained-type-assertions, anti-slop/no-unsafe-dictionary-type -- Focused harness implements only the owner service's Drizzle seam. expires: 2026-12-31. */
import type { SQL } from 'drizzle-orm';
import { AresAppliedEvidenceSchema } from '../../shared/domain/ares-application.ts';
import type { partyAliases } from '../../src/db/schema.ts';
import { parties, partyIdentifierClaims, partyOfficialIdentifiers } from '../../src/db/schema.ts';
import {
  addOfficialIdentifierRecord,
  endOfficialIdentifierRecord,
  updateOfficialIdentifierVerificationRecord,
} from '../../src/services/party-official-identifier-persistence.service.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const partyId = '20000000-0000-4000-8000-000000000001';
const officialIdentifierId = '30000000-0000-4000-8000-000000000001';
const principalId = '40000000-0000-4000-8000-000000000001';
const date = (value: string) => DateTime.toDateUtc(DateTime.makeUnsafe(value));
const identifier = {
  identifierType: 'ICO',
  namespace: 'CZ:ICO',
  normalizedValue: '27074358',
  verification: 'VERIFIED',
} as const;
const row = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  acceptedByActionInvocationId: '50000000-0000-4000-8000-000000000001',
  acceptedByPrincipalId: principalId,
  identifierTypeKey: 'ICO',
  isCurrent: true,
  jurisdiction: 'CZ',
  namespace: 'CZ:ICO',
  normalizedValue: '27074358',
  officialIdentifierId,
  partyId,
  policyVersion: 'party-official-identifier.v1',
  provenanceMethod: 'MANUAL_CONFIRMATION',
  provenanceSource: 'USER_ASSERTION',
  recordedAt: date('2026-01-01T00:00:00.000Z'),
  retractsOfficialIdentifierId: null,
  state: 'ACTIVE',
  supersedesOfficialIdentifierId: null,
  tenantId,
  validFrom: date('2026-01-01T00:00:00.000Z'),
  validTo: null,
  verificationState: 'UNVERIFIED',
  verifiedAt: null,
  verifiedByPrincipalId: null,
  ...overrides,
});
type HarnessTable =
  | typeof parties
  | typeof partyAliases
  | typeof partyIdentifierClaims
  | typeof partyOfficialIdentifiers
  | SQL;

const harness = (
  options: {
    readonly current?: ReturnType<typeof row>;
    readonly claimOwner?: string;
    readonly partyType?: string;
    readonly absent?: boolean;
    readonly archived?: boolean;
  } = {},
) => {
  const current = options.current ?? row();
  const updates: Readonly<Record<string, unknown>>[] = [];
  const inserts: {
    readonly table: HarnessTable;
    readonly values: Readonly<Record<string, unknown>>;
  }[] = [];
  let deletes = 0;
  const lockedTables: (HarnessTable | undefined)[] = [];
  const select = () => {
    let table: HarnessTable | undefined;
    const rows = () => {
      if (table === partyOfficialIdentifiers) {
        return options.absent === true ? [] : [current];
      }
      if (table === parties) {
        return [
          {
            archivedAt: options.archived === true ? date('2026-01-01T00:00:00.000Z') : null,
            currentType: options.partyType ?? 'ORGANIZATION',
            partyId,
          },
        ];
      }
      if (table === partyIdentifierClaims) {
        return options.claimOwner === undefined ? [] : [{ partyId: options.claimOwner }];
      }
      return [];
    };
    const chain = Object.assign(
      Effect.sync(() => rows()),
      {
        for: () => {
          lockedTables.push(table);
          return Effect.succeed(rows());
        },
        from: (value: HarnessTable) => {
          table = value;
          return chain;
        },
        limit: () => chain,
        where: () => chain,
      },
    );
    return chain;
  };
  const update = () => {
    let values: Readonly<Record<string, unknown>> = {};
    const chain = {
      returning: () => Effect.succeed([{ ...current, ...values }]),
      set: (next: Readonly<Record<string, unknown>>) => {
        values = next;
        updates.push(next);
        return chain;
      },
      where: () => chain,
    };
    return chain;
  };
  const insert = (table: HarnessTable) => ({
    values: (values: Readonly<Record<string, unknown>>) => {
      inserts.push({ table, values });
      return Object.assign(
        Effect.sync(() => null),
        { returning: () => Effect.succeed([{ ...current, ...values }]) },
      );
    },
  });
  // SAFETY: this harness implements precisely the Drizzle fluent operations used by the tested service.
  const transaction = {
    delete: () => ({
      where: () => {
        deletes += 1;
        return Effect.void;
      },
    }),
    insert,
    select,
    update,
  } as unknown as Parameters<typeof updateOfficialIdentifierVerificationRecord>[0];
  return { deleted: () => deletes, inserts, lockedTables, transaction, updates };
};

it.effect('Add reuses a current same-Party identifier instead of duplicating an assertion', () =>
  Effect.gen(function* verifyCase1() {
    const db = harness();
    const result = yield* addOfficialIdentifierRecord(
      db.transaction,
      tenantId,
      partyId,
      identifier,
      {
        actionInvocationId: 'invocation',
        matchRuleVersion: 'party-exact-claims.v1',
        partyType: 'ORGANIZATION',
        principalId,
        provenanceMethod: 'MANUAL',
        provenanceSource: 'USER',
        validFrom: '2026-01-01T00:00:00.000Z',
      },
    );
    expect(result.officialIdentifierId).toBe(officialIdentifierId);
    expect(db.inserts.length).toBe(0);
  }),
);

it.effect(
  'Add retains ARES evidence separately from the accepting actor and only claims eligible Party types',
  () =>
    Effect.gen(function* verifyCase2() {
      const externalEvidenceWire = {
        authorityPolicyKey: 'party_registry.ares_enrichment',
        authorityPolicyVersion: '1',
        cacheAgeSeconds: 0,
        decidedAt: '2026-01-01T00:00:00.000Z',
        evidenceRef: 'ares:27074358:confirmation',
        fact: 'ICO',
        observedAt: '2026-01-01T00:00:00.000Z',
        outcome: 'APPLY_ENRICHMENT',
        provider: 'ares',
        providerChangedOn: null,
        providerRecordRef: null,
        queryIco: '27074358',
        reasonCode: 'authoritative_ico',
        servedAt: '2026-01-01T00:00:00.000Z',
      } as const;
      const externalEvidence =
        yield* Schema.decodeUnknownEffect(AresAppliedEvidenceSchema)(externalEvidenceWire);
      yield* Effect.all(
        (['ORGANIZATION', 'PERSON'] as const).map((partyType) =>
          Effect.gen(function* verifyCase3() {
            const db = harness({ absent: true });
            yield* addOfficialIdentifierRecord(db.transaction, tenantId, partyId, identifier, {
              actionInvocationId: 'invocation',
              externalEvidence,
              matchRuleVersion: 'party-exact-claims.v1',
              partyType,
              principalId,
              provenanceMethod: 'REGISTRY_CONFIRMATION',
              provenanceSource: 'ARES',
              validFrom: '2026-01-01T00:00:00.000Z',
            });
            const storedEvidence = db.inserts[0]?.values['externalEvidence'];
            expect(storedEvidence).toEqual(externalEvidenceWire);
            expect(
              yield* Schema.decodeUnknownEffect(AresAppliedEvidenceSchema)(storedEvidence),
            ).toEqual(externalEvidence);
            expect(db.inserts[0]?.values['acceptedByPrincipalId']).toBe(principalId);
            expect(db.inserts.filter((entry) => entry.table === partyIdentifierClaims).length).toBe(
              partyType === 'ORGANIZATION' ? 1 : 0,
            );
          }),
        ),
      );
    }),
);

it.effect('ending an identifier preserves its fact and releases its current claim', () =>
  Effect.gen(function* verifyCase4() {
    yield* TestClock.setTime(
      DateTime.toEpochMillis(DateTime.makeUnsafe('2026-09-07T00:00:00.000Z')),
    );
    const db = harness({
      claimOwner: partyId,
      current: row({ verificationState: 'VERIFIED', verifiedAt: date('2026-01-01T00:00:00.000Z') }),
    });
    const result = yield* endOfficialIdentifierRecord(
      db.transaction,
      tenantId,
      officialIdentifierId,
      '2026-02-01T00:00:00.000Z',
    );
    expect(Predicate.isTagged(result, 'found')).toBe(true);
    expect(db.updates[0]?.['state']).toBe('ENDED');
    expect(db.updates[0]?.['isCurrent']).toBe(false);
    expect(db.deleted()).toBe(1);
    expect(db.lockedTables).toEqual([parties, partyOfficialIdentifiers]);
  }),
);

it.effect('a future end does not release a presently valid claim', () =>
  Effect.gen(function* verifyCase5() {
    yield* TestClock.setTime(
      DateTime.toEpochMillis(DateTime.makeUnsafe('2026-09-07T00:00:00.000Z')),
    );
    const db = harness();
    const result = yield* endOfficialIdentifierRecord(
      db.transaction,
      tenantId,
      officialIdentifierId,
      '2099-01-01T00:00:00.000Z',
    );
    expect(Predicate.isTagged(result, 'conflict')).toBe(true);
    expect(db.updates.length).toBe(0);
    expect(db.deleted()).toBe(0);
  }),
);

const verificationCommand = {
  expectedVerification: 'UNVERIFIED',
  matchRuleVersion: 'party-exact-claims.v1',
  principalId,
  verification: 'VERIFIED',
} as const;

it.effect('verification collision changes neither metadata nor claim ownership', () =>
  Effect.gen(function* verifyCase6() {
    const db = harness({ claimOwner: 'another-party' });
    const result = yield* updateOfficialIdentifierVerificationRecord(
      db.transaction,
      tenantId,
      officialIdentifierId,
      verificationCommand,
    );
    expect(Predicate.isTagged(result, 'claim_conflict')).toBe(true);
    expect(db.updates.length).toBe(0);
    expect(db.inserts.length).toBe(0);
  }),
);

it.effect(
  'verification preserves before-state and immutable identity/provenance while acquiring an eligible claim',
  () =>
    Effect.gen(function* verifyCase7() {
      const db = harness();
      const result = yield* updateOfficialIdentifierVerificationRecord(
        db.transaction,
        tenantId,
        officialIdentifierId,
        verificationCommand,
      );
      expect(Predicate.isTagged(result, 'found')).toBe(true);
      const found = Match.value(result).pipe(
        Match.tag('found', (value) => value),
        Match.orElse(() =>
          (() => {
            throw new Error('Expected the identifier verification update to succeed');
          })(),
        ),
      );
      expect(found.previous.verificationState).toBe('UNVERIFIED');
      expect(found.value.verificationState).toBe('VERIFIED');
      expect(found.value.provenanceSource).toBe('USER_ASSERTION');
      expect(Object.keys(db.updates[0] ?? {}).toSorted()).toEqual([
        'verificationState',
        'verifiedAt',
        'verifiedByPrincipalId',
      ]);
      expect(db.inserts[0]?.table).toBe(partyIdentifierClaims);
    }),
);

it.effect('PERSON verification cannot acquire an implicit strong identifier claim', () =>
  Effect.gen(function* verifyCase8() {
    const db = harness({ partyType: 'PERSON' });
    const result = yield* updateOfficialIdentifierVerificationRecord(
      db.transaction,
      tenantId,
      officialIdentifierId,
      verificationCommand,
    );
    expect(Predicate.isTagged(result, 'found')).toBe(true);
    expect(db.inserts.length).toBe(0);
  }),
);

it.effect(
  'verification downgrade releases its claim without erasing the previous verification evidence',
  () =>
    Effect.gen(function* verifyCase9() {
      const verifiedAt = date('2026-01-01T00:00:00.000Z');
      const db = harness({
        claimOwner: partyId,
        current: row({
          verificationState: 'VERIFIED',
          verifiedAt,
          verifiedByPrincipalId: principalId,
        }),
      });
      const result = yield* updateOfficialIdentifierVerificationRecord(
        db.transaction,
        tenantId,
        officialIdentifierId,
        {
          ...verificationCommand,
          expectedVerification: 'VERIFIED',
          verification: 'REJECTED',
        },
      );
      expect(Predicate.isTagged(result, 'found')).toBe(true);
      const found = Match.value(result).pipe(
        Match.tag('found', (value) => value),
        Match.orElse(() =>
          (() => {
            throw new Error('Expected the identifier verification downgrade to succeed');
          })(),
        ),
      );
      expect(found.previous.verifiedAt).toBe(verifiedAt);
      expect(found.previous.verifiedByPrincipalId).toBe(principalId);
      expect(found.value.verifiedAt).toBe(null);
      expect(db.deleted()).toBe(1);
    }),
);

it.effect('archived Party and stale verification updates are rejected before mutation', () =>
  Effect.all(
    [harness({ archived: true }), harness({ current: row({ verificationState: 'REJECTED' }) })].map(
      (db) =>
        Effect.gen(function* verifyCase11() {
          const result = yield* updateOfficialIdentifierVerificationRecord(
            db.transaction,
            tenantId,
            officialIdentifierId,
            verificationCommand,
          );
          expect(Predicate.isTagged(result, 'conflict')).toBe(true);
          expect(db.updates.length).toBe(0);
        }),
    ),
  ),
);
