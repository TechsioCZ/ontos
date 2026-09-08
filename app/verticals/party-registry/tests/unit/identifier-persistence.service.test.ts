import assert from 'node:assert/strict';
import test from 'node:test';

import { runEffectTestPromise } from '@app/core-runtime/testing/effect-runtime';
// @effect-diagnostics asyncFunction:off globalDate:off -- Existing compatibility boundary; expires: 2026-12-31.
/* eslint-disable anti-slop/no-chained-type-assertions, anti-slop/no-unsafe-dictionary-type -- Focused harness implements only the owner service's Drizzle seam. expires: 2026-12-31. */
import type { SQL } from 'drizzle-orm';
import { DateTime, Effect, Match, Schema } from 'effect';

import { AresAppliedEvidenceSchema } from '../../shared/domain/ares-application.ts';
import type { partyAliases } from '../../src/db/schema.ts';
import {
  parties,
  partyIdentifierClaims,
  partyOfficialIdentifiers,
} from '../../src/db/schema.ts';
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
  } = {}
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
            archivedAt:
              options.archived === true
                ? date('2026-01-01T00:00:00.000Z')
                : null,
            currentType: options.partyType ?? 'ORGANIZATION',
            partyId,
          },
        ];
      }
      if (table === partyIdentifierClaims) {
        return options.claimOwner === undefined
          ? []
          : [{ partyId: options.claimOwner }];
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
      }
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
        { returning: () => Effect.succeed([{ ...current, ...values }]) }
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
  } as unknown as Parameters<
    typeof updateOfficialIdentifierVerificationRecord
  >[0];
  return {
    deleted: () => deletes,
    inserts,
    lockedTables,
    transaction,
    updates,
  };
};

test('Add reuses a current same-Party identifier instead of duplicating an assertion', async () => {
  const db = harness();
  const result = await runEffectTestPromise(
    addOfficialIdentifierRecord(db.transaction, tenantId, partyId, identifier, {
      actionInvocationId: 'invocation',
      matchRuleVersion: 'party-exact-claims.v1',
      partyType: 'ORGANIZATION',
      principalId,
      provenanceMethod: 'MANUAL',
      provenanceSource: 'USER',
      validFrom: '2026-01-01T00:00:00.000Z',
    })
  );
  assert.equal(result.officialIdentifierId, officialIdentifierId);
  assert.equal(db.inserts.length, 0);
});

test('Add retains ARES evidence separately from the accepting actor and only claims eligible Party types', async () => {
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
  const externalEvidence = Schema.decodeUnknownSync(AresAppliedEvidenceSchema)(
    externalEvidenceWire
  );
  await Promise.all(
    (['ORGANIZATION', 'PERSON'] as const).map(async (partyType) => {
      const db = harness({ absent: true });
      await runEffectTestPromise(
        addOfficialIdentifierRecord(
          db.transaction,
          tenantId,
          partyId,
          identifier,
          {
            actionInvocationId: 'invocation',
            externalEvidence,
            matchRuleVersion: 'party-exact-claims.v1',
            partyType,
            principalId,
            provenanceMethod: 'REGISTRY_CONFIRMATION',
            provenanceSource: 'ARES',
            validFrom: '2026-01-01T00:00:00.000Z',
          }
        )
      );
      const storedEvidence = db.inserts[0]?.values['externalEvidence'];
      assert.deepEqual(storedEvidence, externalEvidenceWire);
      assert.deepEqual(
        Schema.decodeUnknownSync(AresAppliedEvidenceSchema)(storedEvidence),
        externalEvidence
      );
      assert.equal(db.inserts[0]?.values['acceptedByPrincipalId'], principalId);
      assert.equal(
        db.inserts.filter((entry) => entry.table === partyIdentifierClaims)
          .length,
        partyType === 'ORGANIZATION' ? 1 : 0
      );
    })
  );
});

test('ending an identifier preserves its fact and releases its current claim', async () => {
  const db = harness({
    claimOwner: partyId,
    current: row({
      verificationState: 'VERIFIED',
      verifiedAt: date('2026-01-01T00:00:00.000Z'),
    }),
  });
  const result = await runEffectTestPromise(
    endOfficialIdentifierRecord(
      db.transaction,
      tenantId,
      officialIdentifierId,
      '2026-02-01T00:00:00.000Z'
    )
  );
  assert.equal(result._tag, 'found');
  assert.equal(db.updates[0]?.['state'], 'ENDED');
  assert.equal(db.updates[0]?.['isCurrent'], false);
  assert.equal(db.deleted(), 1);
  assert.deepEqual(db.lockedTables, [parties, partyOfficialIdentifiers]);
});

test('a future end does not release a presently valid claim', async () => {
  const db = harness();
  const result = await runEffectTestPromise(
    endOfficialIdentifierRecord(
      db.transaction,
      tenantId,
      officialIdentifierId,
      '2099-01-01T00:00:00.000Z'
    )
  );
  assert.equal(result._tag, 'conflict');
  assert.equal(db.updates.length, 0);
  assert.equal(db.deleted(), 0);
});

const verificationCommand = {
  expectedVerification: 'UNVERIFIED',
  matchRuleVersion: 'party-exact-claims.v1',
  principalId,
  verification: 'VERIFIED',
} as const;

test('verification collision changes neither metadata nor claim ownership', async () => {
  const db = harness({ claimOwner: 'another-party' });
  const result = await runEffectTestPromise(
    updateOfficialIdentifierVerificationRecord(
      db.transaction,
      tenantId,
      officialIdentifierId,
      verificationCommand
    )
  );
  assert.equal(result._tag, 'claim_conflict');
  assert.equal(db.updates.length, 0);
  assert.equal(db.inserts.length, 0);
});

test('verification preserves before-state and immutable identity/provenance while acquiring an eligible claim', async () => {
  const db = harness();
  const result = await runEffectTestPromise(
    updateOfficialIdentifierVerificationRecord(
      db.transaction,
      tenantId,
      officialIdentifierId,
      verificationCommand
    )
  );
  assert.equal(result._tag, 'found');
  const found = Match.value(result).pipe(
    Match.tag('found', (value) => value),
    Match.orElse(() =>
      assert.fail('Expected the identifier verification update to succeed')
    )
  );
  assert.equal(found.previous.verificationState, 'UNVERIFIED');
  assert.equal(found.value.verificationState, 'VERIFIED');
  assert.equal(found.value.provenanceSource, 'USER_ASSERTION');
  assert.deepEqual(Object.keys(db.updates[0] ?? {}).toSorted(), [
    'verificationState',
    'verifiedAt',
    'verifiedByPrincipalId',
  ]);
  assert.equal(db.inserts[0]?.table, partyIdentifierClaims);
});

test('PERSON verification cannot acquire an implicit strong identifier claim', async () => {
  const db = harness({ partyType: 'PERSON' });
  const result = await runEffectTestPromise(
    updateOfficialIdentifierVerificationRecord(
      db.transaction,
      tenantId,
      officialIdentifierId,
      verificationCommand
    )
  );
  assert.equal(result._tag, 'found');
  assert.equal(db.inserts.length, 0);
});

test('verification downgrade releases its claim without erasing the previous verification evidence', async () => {
  const verifiedAt = date('2026-01-01T00:00:00.000Z');
  const db = harness({
    claimOwner: partyId,
    current: row({
      verificationState: 'VERIFIED',
      verifiedAt,
      verifiedByPrincipalId: principalId,
    }),
  });
  const result = await runEffectTestPromise(
    updateOfficialIdentifierVerificationRecord(
      db.transaction,
      tenantId,
      officialIdentifierId,
      {
        ...verificationCommand,
        expectedVerification: 'VERIFIED',
        verification: 'REJECTED',
      }
    )
  );
  assert.equal(result._tag, 'found');
  const found = Match.value(result).pipe(
    Match.tag('found', (value) => value),
    Match.orElse(() =>
      assert.fail('Expected the identifier verification downgrade to succeed')
    )
  );
  assert.equal(found.previous.verifiedAt, verifiedAt);
  assert.equal(found.previous.verifiedByPrincipalId, principalId);
  assert.equal(found.value.verifiedAt, null);
  assert.equal(db.deleted(), 1);
});

test('archived Party and stale verification updates are rejected before mutation', async () => {
  await Promise.all(
    [
      harness({ archived: true }),
      harness({ current: row({ verificationState: 'REJECTED' }) }),
    ].map(async (db) => {
      const result = await runEffectTestPromise(
        updateOfficialIdentifierVerificationRecord(
          db.transaction,
          tenantId,
          officialIdentifierId,
          verificationCommand
        )
      );
      assert.equal(result._tag, 'conflict');
      assert.equal(db.updates.length, 0);
    })
  );
});
