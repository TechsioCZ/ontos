/* eslint-disable anti-slop/no-chained-type-assertions, anti-slop/no-unsafe-dictionary-type -- Focused harness implements only the owner service's Drizzle seam. expires: 2026-12-31. */
import type { SQL } from 'drizzle-orm';
import { DateTime, Effect, Schema, Predicate } from 'effect';
import { expect, it } from 'effect-rstest';
import { TestClock } from 'effect/testing';

import { AresAppliedEvidenceSchema } from '../../shared/domain/ares-application.ts';
import type { partyAliases } from '../../src/db/schema.ts';
import { parties, partyOfficialIdentifiers } from '../../src/db/schema.ts';
import {
  acceptMatchingOfficialIdentifierRecord,
  addOfficialIdentifierRecord,
  endOfficialIdentifierRecord,
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
  ...overrides,
});
type HarnessTable = typeof parties | typeof partyAliases | typeof partyOfficialIdentifiers | SQL;

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
      return Object.assign(Effect.succeed(null), {
        returning: () => Effect.succeed([{ ...current, ...values }]),
      });
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
  } as unknown as Parameters<typeof endOfficialIdentifierRecord>[0] & Parameters<typeof addOfficialIdentifierRecord>[0];
  return {
    deleted: () => deletes,
    inserts,
    lockedTables,
    transaction,
    updates,
  };
};

it.effect('Add reuses a current same-Party identifier instead of duplicating an assertion', () =>
  Effect.gen(function* verifyCase1() {
    const db = harness();
    const result = yield* addOfficialIdentifierRecord(db.transaction, tenantId, partyId, identifier, {
      actionInvocationId: 'invocation',
      principalId,
      provenanceMethod: 'MANUAL',
      provenanceSource: 'USER',
      validFrom: '2026-01-01T00:00:00.000Z',
    });
    expect(result.officialIdentifierId).toBe(officialIdentifierId);
    expect(db.inserts.length).toBe(0);
  }),
);

it.effect('matching acceptance reuses the assertion without changing original acceptance', () =>
  Effect.gen(function* matchingAcceptanceReuse() {
    const db = harness();
    const result = yield* acceptMatchingOfficialIdentifierRecord(db.transaction, tenantId, partyId, identifier, {
      actionInvocationId: 'matching-reuse-invocation',
      principalId,
      provenanceMethod: 'REGISTRY',
      provenanceSource: 'matching-test',
      validFrom: '2026-01-01T00:00:00.000Z',
    });
    expect(Predicate.isTagged(result, 'reused')).toBe(true);
    expect(db.updates).toEqual([]);
    expect(db.inserts).toEqual([]);
  }),
);

it.effect('Add retains ARES evidence separately from the accepting actor without creating identity claims', () =>
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
    const externalEvidence = yield* Schema.decodeEffect(AresAppliedEvidenceSchema)(externalEvidenceWire);
    const db = harness({ absent: true });
    yield* addOfficialIdentifierRecord(db.transaction, tenantId, partyId, identifier, {
      actionInvocationId: 'invocation',
      externalEvidence,
      principalId,
      provenanceMethod: 'REGISTRY_CONFIRMATION',
      provenanceSource: 'ARES',
      validFrom: '2026-01-01T00:00:00.000Z',
    });
    const storedEvidence = db.inserts[0]?.values['externalEvidence'];
    expect(storedEvidence).toEqual(externalEvidenceWire);
    expect(yield* Schema.decodeUnknownEffect(AresAppliedEvidenceSchema)(storedEvidence)).toEqual(externalEvidence);
    expect(db.inserts[0]?.values['acceptedByPrincipalId']).toBe(principalId);
    expect(db.inserts.length).toBe(1);
  }),
);

it.effect('ending an identifier preserves its fact and acceptance', () =>
  Effect.gen(function* verifyCase4() {
    yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe('2026-09-07T00:00:00.000Z')));
    const db = harness({
      claimOwner: partyId,
      current: row({}),
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
    expect(db.deleted()).toBe(0);
    expect(db.lockedTables).toEqual([parties, partyOfficialIdentifiers]);
  }),
);

it.effect('a future end does not end a presently valid identifier', () =>
  Effect.gen(function* verifyCase5() {
    yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe('2026-09-07T00:00:00.000Z')));
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

it.effect('standalone Add stores source ICO digits independently of the normalized claim identity', () =>
  Effect.gen(function* originalInputAcceptance() {
    const db = harness({ absent: true });
    yield* addOfficialIdentifierRecord(
      db.transaction,
      tenantId,
      partyId,
      {
        ...identifier,
        normalizedValue: '01000004',
      },
      {
        actionInvocationId: 'original-input-invocation',
        originalInputDigits: '1000004',
        principalId,
        provenanceMethod: 'MANUAL',
        provenanceSource: 'USER',
        validFrom: '2026-01-01T00:00:00.000Z',
      },
    );
    expect(db.inserts).toHaveLength(1);
    expect(db.inserts[0]?.values['originalInputDigits']).toBe('1000004');
    expect(db.inserts[0]?.values['normalizedValue']).toBe('01000004');
    expect(db.inserts[0]?.values['acceptedByActionInvocationId']).toBe('original-input-invocation');
  }),
);

it.effect('a new Add invocation never overwrites the original source or fills unknown evidence on reuse', () =>
  Effect.gen(function* retainedInputReuse() {
    for (const originalInputDigits of ['1000004', null]) {
      const db = harness({ current: row({ normalizedValue: '01000004', originalInputDigits }) });
      const reused = yield* addOfficialIdentifierRecord(
        db.transaction,
        tenantId,
        partyId,
        {
          ...identifier,
          normalizedValue: '01000004',
        },
        {
          actionInvocationId: 'different-invocation',
          originalInputDigits: '01000004',
          principalId,
          provenanceMethod: 'MANUAL',
          provenanceSource: 'USER',
          validFrom: '2026-01-01T00:00:00.000Z',
        },
      );
      expect(reused.originalInputDigits).toBe(originalInputDigits);
      expect(db.inserts).toEqual([]);
      expect(db.updates).toEqual([]);
    }
  }),
);
