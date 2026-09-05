/* eslint-disable anti-slop/no-chained-type-assertions, anti-slop/no-unsafe-dictionary-type, unicorn/no-thenable -- This focused harness models only the Drizzle fluent/PromiseLike surface exercised by Contact Point ending. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { DateTime, Effect, Schema } from 'effect';
import { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import {
  addContactPointRecord as addRecord,
  endContactPointRecord as endRecord,
  findPartyContactPointRecord,
  updateContactPointRecord as updateRecord,
} from '../../src/services/party-contact-point-persistence.service.ts';
import { makePartyAliasResolutionService } from '../../src/merge/party-alias-resolution.service.ts';
import { AresAppliedEvidenceSchema } from '../../shared/domain/ares-application.ts';

const tenantId = '10000000-0000-4000-8000-000000000001';
const partyId = '20000000-0000-4000-8000-000000000001';
const contactPointId = '30000000-0000-4000-8000-000000000001';
const actionInvocationId = '40000000-0000-4000-8000-000000000001';
const principalId = '50000000-0000-4000-8000-000000000001';
const instantAsDate = (instant: string): Date => DateTime.toDateUtc(DateTime.makeUnsafe(instant));
const directAliases = makePartyAliasResolutionService({
  findAlias: () => Effect.succeed(null),
  partyExists: () => Effect.succeed(true),
});
const addContactPointRecord = (
  transaction: Parameters<typeof addRecord>[0],
  scope: Parameters<typeof addRecord>[1],
  command: Parameters<typeof addRecord>[2],
  aliases = directAliases,
) => addRecord(transaction, scope, command, aliases);
const endContactPointRecord = (
  transaction: Parameters<typeof endRecord>[0],
  scope: Parameters<typeof endRecord>[1],
  command: Parameters<typeof endRecord>[2],
  aliases = directAliases,
) => endRecord(transaction, scope, command, aliases);
const updateContactPointRecord = (
  transaction: Parameters<typeof updateRecord>[0],
  scope: Parameters<typeof updateRecord>[1],
  command: Parameters<typeof updateRecord>[2],
  aliases = directAliases,
) => updateRecord(transaction, scope, command, aliases);

const contactRow = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  acceptedByActionInvocationId: actionInvocationId,
  acceptedByPrincipalId: principalId,
  additionalEvidenceRefs: [],
  addressLine1: null,
  addressLine2: null,
  city: null,
  contactPointId,
  contactPointType: 'EMAIL',
  countryCode: null,
  displayValue: 'party@example.test',
  endEvidenceRefs: null,
  endProvenanceMethod: null,
  endProvenanceSource: null,
  endReason: null,
  endedByActionInvocationId: null,
  endedByPrincipalId: null,
  endedRecordedAt: null,
  evidenceReference: null,
  externalEvidence: null,
  isCurrent: true,
  normalizationVersion: 'party-contact-v1',
  normalizedValue: 'party@example.test',
  partyId,
  phoneCountryCode: null,
  phoneExtension: null,
  policyVersion: 'party-contact-point.v1',
  postalCode: null,
  preferred: true,
  privacyClassification: 'PERSONAL',
  provenanceAuthoritative: false,
  provenanceMethod: 'MANUAL_CONFIRMATION',
  provenanceSource: 'USER_ASSERTION',
  recordedAt: instantAsDate('2026-01-01T00:00:00.000Z'),
  region: null,
  retractsContactPointId: null,
  revision: 1,
  state: 'ACTIVE',
  supersedesContactPointId: null,
  tenantId,
  validFrom: instantAsDate('2026-01-01T00:00:00.000Z'),
  validTo: null,
  verificationMethod: null,
  verificationState: 'UNVERIFIED',
  verifiedAt: null,
  verifiedByPrincipalId: null,
  verifierReference: null,
  ...overrides,
});

const purposeRow = (overrides: Readonly<Record<string, unknown>> = {}) => ({
  acceptedByActionInvocationId: actionInvocationId,
  acceptedByPrincipalId: principalId,
  contactPointId,
  contactPointPurposeId: '60000000-0000-4000-8000-000000000001',
  endEvidenceRefs: null,
  endProvenanceMethod: null,
  endProvenanceSource: null,
  endReason: null,
  endedByActionInvocationId: null,
  endedByPrincipalId: null,
  endedRecordedAt: null,
  evidenceReference: null,
  externalEvidence: null,
  isCurrent: true,
  jurisdiction: 'ZZ',
  partyId,
  policyVersion: 'party-contact-point.v1',
  preferred: true,
  provenanceAuthoritative: false,
  provenanceMethod: 'MANUAL_CONFIRMATION',
  provenanceSource: 'USER_ASSERTION',
  purposeKey: 'DELIVERY',
  recordedAt: instantAsDate('2026-01-01T00:00:00.000Z'),
  registryContext: 'GENERAL',
  revision: 1,
  state: 'ACTIVE',
  tenantId,
  validFrom: instantAsDate('2026-01-01T00:00:00.000Z'),
  validTo: null,
  verificationMethod: null,
  verificationState: 'UNVERIFIED',
  verifiedAt: null,
  verifiedByPrincipalId: null,
  verifierReference: null,
  ...overrides,
});

interface Harness {
  readonly insertValues: readonly Readonly<Record<string, unknown>>[];
  readonly transaction: Parameters<typeof endContactPointRecord>[0];
  readonly updateSets: readonly Readonly<Record<string, unknown>>[];
  readonly selectWheres: readonly SQL[];
}

const transactionHarness = (
  selects: readonly (readonly Readonly<Record<string, unknown>>[])[],
  returningRows: readonly (readonly Readonly<Record<string, unknown>>[])[] = [],
): Harness => {
  const selectQueue = [...selects];
  const returningQueue = [...returningRows];
  const insertValues: Readonly<Record<string, unknown>>[] = [];
  const selectWheres: SQL[] = [];
  const updateSets: Readonly<Record<string, unknown>>[] = [];
  const select = () => {
    const rows = selectQueue.shift() ?? [];
    const chain = {
      for: () => Promise.resolve(rows),
      from: () => chain,
      limit: () => chain,
      orderBy: () => chain,
      then: <Result>(
        onfulfilled?: ((value: readonly Readonly<Record<string, unknown>>[]) => Result) | null,
      ) => Promise.resolve(rows).then(onfulfilled),
      where: (condition: SQL) => {
        selectWheres.push(condition);
        return chain;
      },
    };
    return chain;
  };
  const update = () => {
    const chain = {
      set: (values: Readonly<Record<string, unknown>>) => {
        updateSets.push(values);
        return chain;
      },
      then: <Result>(onfulfilled?: (() => Result) | null) => Promise.resolve().then(onfulfilled),
      where: () => chain,
    };
    return chain;
  };
  const insert = () => {
    const chain = {
      returning: () => Promise.resolve(returningQueue.shift() ?? []),
      then: <Result>(onfulfilled?: (() => Result) | null) => Promise.resolve().then(onfulfilled),
      values: (values: Readonly<Record<string, unknown>>) => {
        insertValues.push(values);
        return chain;
      },
    };
    return chain;
  };
  // SAFETY: the harness implements precisely the select/update fluent methods used by this service.
  const transaction = { insert, select, update } as unknown as Parameters<
    typeof endContactPointRecord
  >[0];
  return { insertValues, selectWheres, transaction, updateSets };
};

const scope = {
  authMethod: 'system' as const,
  correlationId: 'contact-end-test',
  principalId,
  tenantId,
};

const wholeEndCommand = (effectiveEnd: string, reason = 'Party retired this mailbox') => ({
  acceptedByActionInvocationId: actionInvocationId,
  acceptedByPrincipalId: principalId,
  contactPointRef: {
    moduleId: 'party.registry' as const,
    resourceId: contactPointId,
    resourceType: 'party.registry.party-contact-point' as const,
    tenantId,
  },
  effectiveEnd,
  provenance: {
    authoritative: false,
    evidenceReference: 'evidence:contact-end:1',
    method: 'MANUAL_CONFIRMATION' as const,
    source: 'USER_ASSERTION' as const,
  },
  reason,
  target: { type: 'WHOLE_CONTACT_POINT' as const },
});

test('stores future end provenance while keeping the contact current until the boundary', () =>
  Effect.runPromise(
    Effect.gen(function* contactPointScenario() {
      const effectiveEnd = '2099-01-01T00:00:00.000Z';
      const updated = contactRow({
        endEvidenceRefs: ['evidence:contact-end:1'],
        endProvenanceMethod: 'MANUAL_CONFIRMATION',
        endProvenanceSource: 'USER_ASSERTION',
        endReason: 'Party retired this mailbox',
        endedByActionInvocationId: actionInvocationId,
        endedByPrincipalId: principalId,
        endedRecordedAt: instantAsDate('2026-09-03T00:00:00.000Z'),
        revision: 2,
        validTo: instantAsDate(effectiveEnd),
      });
      const harness = transactionHarness([
        [contactRow()],
        [{ partyId }],
        [contactRow()],
        [updated],
        [],
      ]);

      const result = yield* endContactPointRecord(
        harness.transaction,
        scope,
        wholeEndCommand(effectiveEnd),
      );

      assert.equal(harness.updateSets[0]?.['state'], 'ACTIVE');
      assert.equal(harness.updateSets[0]?.['isCurrent'], true);
      assert.deepEqual(harness.updateSets[0]?.['endEvidenceRefs'], ['evidence:contact-end:1']);
      assert.equal(harness.updateSets[0]?.['endReason'], 'Party retired this mailbox');
      assert.deepEqual(result.contactPoint.end?.provenance.evidenceReferences, [
        'evidence:contact-end:1',
      ]);
    }),
  ));

test('stores end provenance on both a last ADDRESS purpose and its owning address', () =>
  Effect.runPromise(
    Effect.gen(function* contactPointScenario() {
      const effectiveEnd = '2026-02-01T00:00:00.000Z';
      const address = contactRow({
        addressLine1: 'Na Prikope 1',
        city: 'Praha',
        contactPointType: 'ADDRESS',
        countryCode: 'CZ',
        displayValue: null,
        normalizationVersion: null,
        normalizedValue: null,
        preferred: false,
      });
      const endedAddress = contactRow({
        ...address,
        endEvidenceRefs: ['evidence:contact-end:1'],
        endProvenanceMethod: 'MANUAL_CONFIRMATION',
        endProvenanceSource: 'USER_ASSERTION',
        endReason: 'Party retired this mailbox',
        endedByActionInvocationId: actionInvocationId,
        endedByPrincipalId: principalId,
        endedRecordedAt: instantAsDate('2026-09-03T12:00:00.000Z'),
        isCurrent: false,
        revision: 2,
        state: 'ENDED',
        validTo: instantAsDate(effectiveEnd),
      });
      const endedPurpose = purposeRow({
        endEvidenceRefs: ['evidence:contact-end:1'],
        endProvenanceMethod: 'MANUAL_CONFIRMATION',
        endProvenanceSource: 'USER_ASSERTION',
        endReason: 'Party retired this mailbox',
        endedByActionInvocationId: actionInvocationId,
        endedByPrincipalId: principalId,
        endedRecordedAt: instantAsDate('2026-09-03T12:00:00.000Z'),
        isCurrent: false,
        revision: 2,
        state: 'ENDED',
        validTo: instantAsDate(effectiveEnd),
      });
      const harness = transactionHarness([
        [address],
        [{ partyId }],
        [address],
        [purposeRow()],
        [endedAddress],
        [endedPurpose],
      ]);
      const command = {
        ...wholeEndCommand(effectiveEnd),
        target: { target: { purpose: 'DELIVERY' as const }, type: 'ADDRESS_PURPOSE' as const },
      };

      const result = yield* endContactPointRecord(harness.transaction, scope, command);

      assert.equal(harness.updateSets.length, 2);
      assert.equal(harness.updateSets[0]?.['endProvenanceSource'], 'USER_ASSERTION');
      assert.equal(harness.updateSets[1]?.['endProvenanceMethod'], 'MANUAL_CONFIRMATION');
      assert.equal(result.contactPoint.value.type, 'ADDRESS');
      assert.equal(
        result.contactPoint.value.type === 'ADDRESS' &&
          result.contactPoint.value.purposes[0]?.end?.reason,
        'Party retired this mailbox',
      );
    }),
  ));

test('reuses only an exact end request and rejects changed evidence at the same boundary', () =>
  Effect.runPromise(
    Effect.gen(function* contactPointScenario() {
      const effectiveEnd = '2026-02-01T00:00:00.000Z';
      const ended = contactRow({
        endEvidenceRefs: ['evidence:contact-end:1'],
        endProvenanceMethod: 'MANUAL_CONFIRMATION',
        endProvenanceSource: 'USER_ASSERTION',
        endReason: 'Party retired this mailbox',
        endedByActionInvocationId: actionInvocationId,
        endedByPrincipalId: principalId,
        endedRecordedAt: instantAsDate('2026-09-03T12:00:00.000Z'),
        isCurrent: false,
        revision: 2,
        state: 'ENDED',
        validTo: instantAsDate(effectiveEnd),
      });
      const exactHarness = transactionHarness([[ended], [{ partyId }], [ended], []]);
      const exact = yield* endContactPointRecord(
        exactHarness.transaction,
        scope,
        wholeEndCommand(effectiveEnd),
      );
      assert.equal(exact.changed, false);
      assert.equal(exactHarness.updateSets.length, 0);

      const changedHarness = transactionHarness([[ended], [{ partyId }], [ended]]);
      const changed = yield* Effect.exit(
        endContactPointRecord(
          changedHarness.transaction,
          scope,
          wholeEndCommand(effectiveEnd, 'A different reason'),
        ),
      );
      assert.equal(changed._tag, 'Failure');
      assert.equal(changedHarness.updateSets.length, 0);
    }),
  ));

test('stores correction end provenance on the preserved original Contact Point', () =>
  Effect.runPromise(
    Effect.gen(function* contactPointScenario() {
      const original = contactRow();
      const corrected = contactRow({
        endEvidenceRefs: ['evidence:wrong-mailbox:1'],
        endProvenanceMethod: 'MANUAL_CONFIRMATION',
        endProvenanceSource: 'USER_ASSERTION',
        endReason: 'Mailbox was attached to the wrong Party',
        endedByActionInvocationId: actionInvocationId,
        endedByPrincipalId: principalId,
        endedRecordedAt: instantAsDate('2026-09-03T12:00:00.000Z'),
        isCurrent: false,
        preferred: false,
        revision: 2,
        state: 'RETRACTED',
        validTo: instantAsDate('2026-09-03T12:00:00.000Z'),
      });
      const harness = transactionHarness([[original], [{ partyId }], [original], [corrected], []]);

      const result = yield* updateContactPointRecord(harness.transaction, scope, {
        acceptedByActionInvocationId: actionInvocationId,
        acceptedByPrincipalId: principalId,
        change: {
          evidenceReferences: ['evidence:wrong-mailbox:1'],
          reason: 'Mailbox was attached to the wrong Party',
          type: 'CORRECT_CONTACT_POINT',
        },
        contactPointRef: wholeEndCommand('2099-01-01T00:00:00.000Z').contactPointRef,
        expectedRevision: 1,
        provenance: {
          authoritative: false,
          method: 'MANUAL_CONFIRMATION',
          source: 'USER_ASSERTION',
        },
      });

      assert.equal(harness.updateSets[0]?.['state'], 'RETRACTED');
      assert.equal(harness.updateSets[0]?.['endReason'], 'Mailbox was attached to the wrong Party');
      assert.deepEqual(harness.updateSets[0]?.['endEvidenceRefs'], ['evidence:wrong-mailbox:1']);
      assert.equal(harness.insertValues[0]?.['contactPointId'], contactPointId);
      assert.equal(result.end?.reason, 'Mailbox was attached to the wrong Party');
    }),
  ));

const addressRow = (overrides: Readonly<Record<string, unknown>> = {}) =>
  contactRow({
    addressLine1: 'Na Prikope 1',
    city: 'Praha',
    contactPointType: 'ADDRESS',
    countryCode: 'CZ',
    displayValue: null,
    normalizationVersion: null,
    normalizedValue: null,
    preferred: false,
    ...overrides,
  });

const updateCommand = (change: Parameters<typeof updateContactPointRecord>[2]['change']) => ({
  acceptedByActionInvocationId: actionInvocationId,
  acceptedByPrincipalId: principalId,
  change,
  contactPointRef: wholeEndCommand('2099-01-01T00:00:00.000Z').contactPointRef,
  expectedRevision: 1,
  provenance: {
    authoritative: true,
    evidenceReference: 'evidence:registry:1',
    method: 'DOCUMENT_REVIEW' as const,
    source: 'EXTERNAL_EVIDENCE' as const,
  },
});

test('re-adds a scheduled-ended purpose as a new period without reopening its history', () =>
  Effect.runPromise(
    Effect.gen(function* contactPointScenario() {
      const stalePurpose = purposeRow({
        endEvidenceRefs: ['evidence:contact-end:1'],
        endProvenanceMethod: 'MANUAL_CONFIRMATION',
        endProvenanceSource: 'USER_ASSERTION',
        endReason: 'Previous delivery period ended',
        endedByActionInvocationId: actionInvocationId,
        endedByPrincipalId: principalId,
        endedRecordedAt: instantAsDate('2026-01-02T00:00:00.000Z'),
        validTo: instantAsDate('2026-02-01T00:00:00.000Z'),
      });
      const renewedPurpose = purposeRow({
        contactPointPurposeId: '60000000-0000-4000-8000-000000000002',
        validFrom: instantAsDate('2026-09-03T12:00:00.000Z'),
      });
      const address = addressRow();
      const harness = transactionHarness([
        [address],
        [{ partyId }],
        [address],
        [stalePurpose],
        [addressRow({ revision: 2 })],
        [{ ...stalePurpose, isCurrent: false, state: 'ENDED' }, renewedPurpose],
      ]);
      const result = yield* updateContactPointRecord(
        harness.transaction,
        scope,
        updateCommand({
          assignment: { preferred: true, purpose: 'DELIVERY' },
          type: 'SET_ADDRESS_PURPOSE',
        }),
      );
      assert.equal(harness.updateSets[0]?.['state'], 'ENDED');
      assert.equal(harness.updateSets[0]?.['revision'], 2);
      assert.equal(harness.insertValues.length, 1);
      assert.equal(harness.insertValues[0]?.['validTo'], undefined);
      assert.equal(harness.insertValues[0]?.['endReason'], undefined);
      assert.equal(result.value.type, 'ADDRESS');
      if (result.value.type === 'ADDRESS') {
        assert.equal(result.value.purposes.length, 2);
        assert.equal(result.value.purposes[0]?.current, false);
        assert.equal(result.value.purposes[1]?.validTo, null);
      }
    }),
  ));

test('rejects a REGISTERED context collision as a typed domain conflict before mutation', () =>
  Effect.runPromise(
    Effect.gen(function* contactPointScenario() {
      const address = addressRow();
      const conflicting = purposeRow({
        contactPointId: '30000000-0000-4000-8000-000000000002',
        jurisdiction: 'CZ',
        purposeKey: 'REGISTERED',
        registryContext: 'ARES',
      });
      const harness = transactionHarness([[address], [{ partyId }], [address], [conflicting]]);
      const error = yield* Effect.flip(
        updateContactPointRecord(
          harness.transaction,
          scope,
          updateCommand({
            assignment: {
              preferred: true,
              purpose: 'REGISTERED',
              registryContext: { jurisdiction: 'CZ', registryKey: 'ARES' },
            },
            type: 'SET_ADDRESS_PURPOSE',
          }),
        ),
      );
      assert.equal(error._tag, 'PartyContactPointAlreadyExists');
      assert.equal(harness.updateSets.length, 0);
      assert.equal(harness.insertValues.length, 0);
      const condition = harness.selectWheres.at(3);
      assert.ok(condition);
      const query = new PgDialect().sqlToQuery(condition);
      assert.match(query.sql, /registry_context/u);
      assert.match(query.sql, /jurisdiction/u);
      assert.ok(query.params.includes('ARES'));
      assert.ok(query.params.includes('CZ'));

      const addHarness = transactionHarness([[{ partyId }], [], [conflicting]]);
      const addError = yield* Effect.flip(
        addContactPointRecord(addHarness.transaction, scope, {
          acceptedByActionInvocationId: actionInvocationId,
          acceptedByPrincipalId: principalId,
          contactPoint: {
            address: { addressLine1: 'Another street 2', city: 'Praha', countryCode: 'CZ' },
            purposes: [
              {
                preferred: true,
                purpose: 'REGISTERED',
                registryContext: { jurisdiction: 'CZ', registryKey: 'ARES' },
              },
            ],
            type: 'ADDRESS',
          },
          partyRef: {
            moduleId: 'party.registry',
            resourceId: partyId,
            resourceType: 'party.registry.party',
            tenantId,
          },
          privacyClassification: 'PUBLIC',
          provenance: {
            authoritative: true,
            evidenceReference: 'evidence:registry:2',
            method: 'DOCUMENT_REVIEW',
            source: 'EXTERNAL_EVIDENCE',
          },
          validFrom: '2026-01-01T00:00:00.000Z',
          verification: { state: 'UNVERIFIED' },
        }),
      );
      assert.equal(addError._tag, 'PartyContactPointAlreadyExists');
      assert.equal(addHarness.insertValues.length, 0);
      assert.equal(addHarness.updateSets.length, 0);
    }),
  ));

test('advances revisions on both the transferred purpose and its owning address', () =>
  Effect.runPromise(
    Effect.gen(function* contactPointScenario() {
      const address = addressRow();
      const current = purposeRow({ preferred: false });
      const previousPreferred = purposeRow({
        contactPointId: '30000000-0000-4000-8000-000000000002',
        contactPointPurposeId: '60000000-0000-4000-8000-000000000002',
        revision: 7,
      });
      const harness = transactionHarness([
        [address],
        [{ partyId }],
        [address],
        [current, previousPreferred],
        [addressRow({ revision: 2 })],
        [{ ...current, preferred: true, revision: 2 }],
      ]);
      yield* updateContactPointRecord(
        harness.transaction,
        scope,
        updateCommand({
          assignment: { preferred: true, purpose: 'DELIVERY' },
          type: 'SET_ADDRESS_PURPOSE',
        }),
      );
      assert.equal(harness.updateSets[0]?.['revision'], 8);
      assert.equal(harness.updateSets[0]?.['preferred'], false);
      const revision = harness.updateSets[1]?.['revision'];
      assert.ok(revision instanceof SQL);
      assert.match(new PgDialect().sqlToQuery(revision).sql, /revision.*\+ 1/u);
      assert.equal(harness.updateSets[2]?.['revision'], 2);
      assert.equal(harness.updateSets[3]?.['revision'], 2);
    }),
  ));

test('preserves original provenance evidence and appends deduplicated enrichment', () =>
  Effect.runPromise(
    Effect.gen(function* contactPointScenario() {
      const row = contactRow({
        additionalEvidenceRefs: ['evidence:second'],
        evidenceReference: 'evidence:first',
      });
      const updated = contactRow({
        additionalEvidenceRefs: ['evidence:second', 'evidence:third'],
        evidenceReference: 'evidence:first',
        revision: 2,
      });
      const harness = transactionHarness([[row], [{ partyId }], [row], [updated], []]);
      const result = yield* updateContactPointRecord(
        harness.transaction,
        scope,
        updateCommand({
          provenance: {
            authoritative: false,
            evidenceReference: 'evidence:third',
            method: 'MANUAL_CONFIRMATION',
            source: 'USER_ASSERTION',
          },
          type: 'ADD_PROVENANCE',
        }),
      );
      assert.equal(harness.updateSets[0]?.['evidenceReference'], undefined);
      assert.deepEqual(harness.updateSets[0]?.['additionalEvidenceRefs'], [
        'evidence:second',
        'evidence:third',
      ]);
      assert.deepEqual(result.provenance.evidenceReferences, [
        'evidence:first',
        'evidence:second',
        'evidence:third',
      ]);
    }),
  ));

test('rejects invalid E.164 and oversized extensions through the service typed-error path', () =>
  Effect.runPromise(
    Effect.all(
      [
        { preferred: false, type: 'PHONE' as const, value: '+0123456789' },
        {
          extension: '1234567890123',
          preferred: false,
          type: 'PHONE' as const,
          value: '+420777123456',
        },
      ].map((contactPoint) =>
        Effect.gen(function* contactPointCase() {
          const harness = transactionHarness([]);
          const error = yield* Effect.flip(
            addContactPointRecord(harness.transaction, scope, {
              acceptedByActionInvocationId: actionInvocationId,
              acceptedByPrincipalId: principalId,
              contactPoint,
              partyRef: {
                moduleId: 'party.registry',
                resourceId: partyId,
                resourceType: 'party.registry.party',
                tenantId,
              },
              privacyClassification: 'PERSONAL',
              provenance: {
                authoritative: false,
                method: 'MANUAL_CONFIRMATION',
                source: 'USER_ASSERTION',
              },
              validFrom: '2026-01-01T00:00:00.000Z',
              verification: { state: 'UNVERIFIED' },
            }),
          );
          assert.equal(error._tag, 'PartyContactPointInvalid');
          assert.equal(harness.selectWheres.length, 0);
          assert.equal(harness.insertValues.length, 0);
        }),
      ),
    ).pipe(Effect.asVoid),
  ));

test('rejects an explicit alias Party add but keeps durable ContactPoint updates readable through the full chain', () =>
  Effect.runPromise(
    Effect.gen(function* contactPointScenario() {
      const intermediatePartyId = '20000000-0000-4000-8000-000000000002';
      const canonicalPartyId = '20000000-0000-4000-8000-000000000003';
      const aliases = makePartyAliasResolutionService({
        findAlias: (requestedTenantId, requestedPartyId) => {
          if (requestedPartyId === partyId) {
            return Effect.succeed({
              aliasPartyId: partyId,
              canonicalPartyId: intermediatePartyId,
              tenantId: requestedTenantId,
            });
          }
          if (requestedPartyId === intermediatePartyId) {
            return Effect.succeed({
              aliasPartyId: intermediatePartyId,
              canonicalPartyId,
              tenantId: requestedTenantId,
            });
          }
          return Effect.succeed(null);
        },
        partyExists: () => Effect.succeed(true),
      });
      const addHarness = transactionHarness([[{ partyId }]]);
      const rejected = yield* Effect.flip(
        addContactPointRecord(
          addHarness.transaction,
          scope,
          {
            acceptedByActionInvocationId: actionInvocationId,
            acceptedByPrincipalId: principalId,
            contactPoint: { preferred: false, type: 'EMAIL', value: 'new@example.test' },
            partyRef: {
              moduleId: 'party.registry',
              resourceId: partyId,
              resourceType: 'party.registry.party',
              tenantId,
            },
            privacyClassification: 'PERSONAL',
            provenance: {
              authoritative: false,
              method: 'MANUAL_CONFIRMATION',
              source: 'USER_ASSERTION',
            },
            validFrom: '2026-01-01T00:00:00.000Z',
            verification: { state: 'UNVERIFIED' },
          },
          aliases,
        ),
      );
      assert.equal(rejected._tag, 'PartyAliasWriteRejected');
      if (rejected._tag === 'PartyAliasWriteRejected') {
        assert.equal(rejected.canonicalPartyRef.resourceId, canonicalPartyId);
      }
      assert.equal(addHarness.insertValues.length, 0);

      const row = contactRow();
      const updateHarness = transactionHarness([
        [row],
        [{ partyId: canonicalPartyId }],
        [row],
        [contactRow({ preferred: false, revision: 2 })],
        [],
      ]);
      const updated = yield* updateContactPointRecord(
        updateHarness.transaction,
        scope,
        updateCommand({
          preferred: false,
          type: 'SET_CHANNEL_PREFERRED',
        }),
        aliases,
      );
      assert.equal(updated.partyRef.resourceId, canonicalPartyId);
      assert.equal(updated.storedPartyRef?.resourceId, partyId);
      assert.equal(updateHarness.updateSets.length, 1);

      const readHarness = transactionHarness([[row], []]);
      const detail = yield* findPartyContactPointRecord(
        readHarness.transaction,
        scope,
        contactPointId,
        aliases,
      );
      assert.equal(detail?.partyRef.resourceId, canonicalPartyId);
      assert.equal(detail?.storedPartyRef?.resourceId, partyId);

      const ended = contactRow({
        endEvidenceRefs: ['evidence:contact-end:1'],
        endProvenanceMethod: 'MANUAL_CONFIRMATION',
        endProvenanceSource: 'USER_ASSERTION',
        endReason: 'Party retired this mailbox',
        endedByActionInvocationId: actionInvocationId,
        endedByPrincipalId: principalId,
        endedRecordedAt: instantAsDate('2026-09-03T12:00:00.000Z'),
        revision: 2,
        validTo: instantAsDate('2099-01-01T00:00:00.000Z'),
      });
      const endHarness = transactionHarness([
        [row],
        [{ partyId: canonicalPartyId }],
        [row],
        [ended],
        [],
      ]);
      const endResult = yield* endContactPointRecord(
        endHarness.transaction,
        scope,
        wholeEndCommand('2099-01-01T00:00:00.000Z'),
        aliases,
      );
      assert.equal(endResult.contactPoint.partyRef.resourceId, canonicalPartyId);
      assert.equal(endHarness.updateSets.length, 1);
    }),
  ));

test('advances the replaced channel preference revision as well as the selected contact', () =>
  Effect.runPromise(
    Effect.gen(function* contactPointScenario() {
      const row = contactRow({ preferred: false });
      const harness = transactionHarness([
        [row],
        [{ partyId }],
        [row],
        [contactRow({ revision: 2 })],
        [],
      ]);
      yield* updateContactPointRecord(
        harness.transaction,
        scope,
        updateCommand({ preferred: true, type: 'SET_CHANNEL_PREFERRED' }),
      );
      const revision = harness.updateSets[0]?.['revision'];
      assert.ok(revision instanceof SQL);
      assert.match(new PgDialect().sqlToQuery(revision).sql, /revision.*\+ 1/u);
      assert.equal(harness.updateSets[1]?.['revision'], 2);
    }),
  ));

test('persists bounded ARES provenance on the address and purpose without using observation time as effective time', () =>
  Effect.runPromise(
    Effect.gen(function* contactPointScenario() {
      const externalEvidence = yield* Schema.decodeUnknownEffect(AresAppliedEvidenceSchema)({
        authorityPolicyKey: 'party_registry.ares_enrichment',
        authorityPolicyVersion: '1',
        cacheAgeSeconds: 120,
        decidedAt: '2026-09-03T10:02:00.000Z',
        evidenceRef: 'ares:27074358:registered-address',
        fact: 'REGISTERED_ADDRESS',
        observedAt: '2026-09-03T10:00:00.000Z',
        outcome: 'APPLY_ENRICHMENT',
        provider: 'ares',
        providerChangedOn: '2026-08-01',
        providerRecordRef: 'ares:27074358',
        queryIco: '27074358',
        reasonCode: 'selected_missing_fact_confirmed',
        servedAt: '2026-09-03T10:02:00.000Z',
      });
      const address = addressRow({ externalEvidence });
      const purpose = purposeRow({
        externalEvidence,
        jurisdiction: 'CZ',
        purposeKey: 'REGISTERED',
        registryContext: 'ARES',
      });
      const harness = transactionHarness([[{ partyId }], [], [], [purpose]], [[address]]);
      const result = yield* addContactPointRecord(harness.transaction, scope, {
        acceptedByActionInvocationId: actionInvocationId,
        acceptedByPrincipalId: principalId,
        contactPoint: {
          address: { addressLine1: 'Na Prikope 1', city: 'Praha', countryCode: 'CZ' },
          purposes: [
            {
              preferred: true,
              purpose: 'REGISTERED',
              registryContext: { jurisdiction: 'CZ', registryKey: 'ARES' },
            },
          ],
          type: 'ADDRESS',
        },
        partyRef: {
          moduleId: 'party.registry',
          resourceId: partyId,
          resourceType: 'party.registry.party',
          tenantId,
        },
        privacyClassification: 'PUBLIC',
        provenance: {
          authoritative: true,
          evidenceReference: externalEvidence.evidenceRef,
          externalEvidence,
          method: 'PROVIDER_OBSERVATION',
          source: 'EXTERNAL_EVIDENCE',
        },
        validFrom: '2026-08-01T00:00:00.000Z',
        verification: { state: 'UNVERIFIED' },
      });
      assert.deepEqual(harness.insertValues[0]?.['externalEvidence'], externalEvidence);
      assert.deepEqual(harness.insertValues[1]?.['externalEvidence'], externalEvidence);
      assert.deepEqual(
        harness.insertValues[0]?.['validFrom'],
        instantAsDate('2026-08-01T00:00:00.000Z'),
      );
      assert.equal(result.provenance.externalEvidence?.observedAt, '2026-09-03T10:00:00.000Z');
      assert.equal(result.value.type, 'ADDRESS');
      if (result.value.type === 'ADDRESS') {
        assert.deepEqual(result.value.purposes[0]?.provenance.externalEvidence, externalEvidence);
      }
    }),
  ));

test('treats PHONE extensions as distinct endpoints while rejecting an exact duplicate extension', () =>
  Effect.runPromise(
    Effect.gen(function* contactPointScenario() {
      const existing = contactRow({
        contactPointType: 'PHONE',
        displayValue: '+420777123456',
        normalizedValue: '+420777123456',
        phoneCountryCode: 'CZ',
        phoneExtension: '101',
      });
      const created = contactRow({
        ...existing,
        contactPointId: '30000000-0000-4000-8000-000000000002',
        phoneExtension: '102',
        preferred: false,
      });
      const command = (extension: string): Parameters<typeof addRecord>[2] => ({
        acceptedByActionInvocationId: actionInvocationId,
        acceptedByPrincipalId: principalId,
        contactPoint: { extension, preferred: false, type: 'PHONE', value: '+420777123456' },
        partyRef: {
          moduleId: 'party.registry',
          resourceId: partyId,
          resourceType: 'party.registry.party',
          tenantId,
        },
        privacyClassification: 'BUSINESS_SENSITIVE',
        provenance: {
          authoritative: false,
          method: 'MANUAL_CONFIRMATION',
          source: 'USER_ASSERTION',
        },
        validFrom: '2026-01-01T00:00:00.000Z',
        verification: { state: 'UNVERIFIED' },
      });
      const newHarness = transactionHarness([[{ partyId }], [existing], []], [[created]]);
      const result = yield* addContactPointRecord(newHarness.transaction, scope, command('102'));
      assert.equal(newHarness.insertValues.length, 1);
      assert.equal(result.value.type === 'PHONE' && result.value.extension, '102');

      const duplicateHarness = transactionHarness([[{ partyId }], [existing]]);
      const duplicate = yield* Effect.flip(
        addContactPointRecord(duplicateHarness.transaction, scope, command('101')),
      );
      assert.equal(duplicate._tag, 'PartyContactPointAlreadyExists');
      assert.equal(duplicateHarness.insertValues.length, 0);
    }),
  ));

test('whole ADDRESS end preserves an earlier purpose end and its independent accepted evidence', () =>
  Effect.runPromise(
    Effect.gen(function* contactPointScenario() {
      const address = addressRow();
      const earlierEndAudit = {
        endEvidenceRefs: ['evidence:delivery-contract-ended'],
        endProvenanceMethod: 'DOCUMENT_REVIEW',
        endProvenanceSource: 'EXTERNAL_EVIDENCE',
        endReason: 'Independent delivery contract end',
        endedByActionInvocationId: actionInvocationId,
        endedByPrincipalId: principalId,
        endedRecordedAt: instantAsDate('2026-01-02T00:00:00.000Z'),
      };
      const earlierPurpose = purposeRow({
        ...earlierEndAudit,
        validTo: instantAsDate('2090-01-01T00:00:00.000Z'),
      });
      const openPurpose = purposeRow({
        contactPointPurposeId: '60000000-0000-4000-8000-000000000002',
        purposeKey: 'CORRESPONDENCE',
      });
      const wholeEndAudit = {
        endEvidenceRefs: ['evidence:contact-end:1'],
        endProvenanceMethod: 'MANUAL_CONFIRMATION',
        endProvenanceSource: 'USER_ASSERTION',
        endReason: 'Party retired this mailbox',
        endedByActionInvocationId: actionInvocationId,
        endedByPrincipalId: principalId,
        endedRecordedAt: instantAsDate('2026-09-03T12:00:00.000Z'),
        revision: 2,
        validTo: instantAsDate('2099-01-01T00:00:00.000Z'),
      };
      const harness = transactionHarness([
        [address],
        [{ partyId }],
        [address],
        [earlierPurpose, openPurpose],
        [addressRow(wholeEndAudit)],
        [earlierPurpose, purposeRow({ ...openPurpose, ...wholeEndAudit })],
      ]);
      const result = yield* endContactPointRecord(
        harness.transaction,
        scope,
        wholeEndCommand('2099-01-01T00:00:00.000Z'),
      );
      assert.equal(
        harness.updateSets.length,
        2,
        'only the address and still-open purpose are changed',
      );
      assert.equal(harness.updateSets[1]?.['revision'], 2);
      if (result.contactPoint.value.type === 'ADDRESS') {
        const [preserved] = result.contactPoint.value.purposes;
        assert.equal(preserved?.validTo, '2090-01-01T00:00:00.000Z');
        assert.equal(preserved?.end?.reason, 'Independent delivery contract end');
        assert.deepEqual(preserved?.end?.provenance.evidenceReferences, [
          'evidence:delivery-contract-ended',
        ]);
      } else {
        assert.fail('Expected ADDRESS result');
      }
    }),
  ));
