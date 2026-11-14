// The Facility Operations reach over canonical Authorization v2 answers (ADR-0030). The old model read
// four `facility.operations.*` context-permission keys; this suite pins what replaced them: the parent
// records read is the operational reach, its restricted field group is what a full reader adds, and
// the one write Action is the whole write reach.
import { expect, it } from 'effect-rstest';
import { DateTime, Effect, Exit } from 'effect';
import { AccessDecisionGate, makeTestAccessDecision } from '@app/core-runtime/access/enforcement';
import { NodeCrypto } from '@effect/platform-node';
import { runFacilitySearchScenario } from './facility-search-harness.ts';

import {
  facilityOperationsApplyCommandDeclaration,
  facilityOperationsOverviewReadDeclaration,
  facilityOperationsRecordsReadDeclaration,
  facilityOperationsRecordsRestrictedGroup,
  facilityOperationsRestrictedAgendaFields,
} from '../../shared/domain/access-declarations.ts';
import { facilityGrantsOf } from '../../shared/domain/access-grants.ts';
import { facilityOperationsGrants, finishFacilityRecords } from '../../src/services/persistence.service.ts';
import { seedMetersState } from '../../scripts/seed/meters.mts';
import { recordsRead } from '../../src/api/records.read.ts';
import { overviewRead } from '../../src/api/overview.read.ts';
import { applyCommandAction } from '../../src/actions/apply-command.action.ts';

it('asks the gate exactly what the registered descriptors declare', () => {
  // The descriptors carry closed inline literals for the catalog; these owner copies must not drift.
  expect(recordsRead.descriptor.accessDeclaration).toMatchObject(facilityOperationsRecordsReadDeclaration);
  expect(recordsRead.descriptor.accessFieldGroups).toMatchObject([facilityOperationsRecordsRestrictedGroup]);
  expect(overviewRead.descriptor.accessDeclaration).toMatchObject(facilityOperationsOverviewReadDeclaration);
  expect(applyCommandAction.descriptor.accessDeclaration).toMatchObject(facilityOperationsApplyCommandDeclaration);
});

it('keeps the restricted agendas out of the parent read, as its own field group', () => {
  expect(facilityOperationsRecordsReadDeclaration).toMatchObject({
    key: 'facility.operations.api-records.read',
    kind: 'read',
    selectors: [],
  });
  expect(facilityOperationsRecordsRestrictedGroup).toMatchObject({
    fields: [...facilityOperationsRestrictedAgendaFields],
    key: 'facility.operations.records-restricted.read',
    kind: 'field_read',
  });
  // The calendar agenda is the one operational agenda; every other agenda path is restricted.
  expect(facilityOperationsRestrictedAgendaFields).not.toContain('agendas.agenda');
  expect(facilityOperationsRestrictedAgendaFields).not.toContain('agendas.meters');
  expect(recordsRead.descriptor.accessFieldGroups?.[0]?.key).toBe('facility.operations.records-restricted.read');
});

it('a full reader holds the parent read and its restricted group, and may write', () => {
  expect(facilityGrantsOf({ read: 'ALLOWED', restricted: 'ALLOWED', write: 'ALLOWED' })).toEqual({
    readAll: true,
    readOperational: true,
    writeAll: true,
    writeOperational: true,
  });
});

it('an operational-only partner holds the parent read without the group and writes nothing', () => {
  expect(facilityGrantsOf({ read: 'ALLOWED', restricted: 'DENIED', write: 'DENIED' })).toEqual({
    readAll: false,
    readOperational: true,
    writeAll: false,
    writeOperational: false,
  });
});

it('a caller without the parent read reaches no agenda, whatever the other answers', () => {
  expect(facilityGrantsOf({ read: 'DENIED', restricted: 'ALLOWED', write: 'DENIED' })).toEqual({
    readAll: false,
    readOperational: false,
    writeAll: false,
    writeOperational: false,
  });
});

it('a proposal-only answer never becomes a write', () => {
  expect(facilityGrantsOf({ read: 'ALLOWED', restricted: 'DENIED', write: 'NEEDS_APPROVAL' })).toMatchObject({
    writeAll: false,
    writeOperational: false,
  });
});

it.effect('an operational write gate never exposes restricted records, meter values or management', () =>
  Effect.gen(function* operationalOwner() {
    const scope = {
      authMethod: 'session' as const,
      correlationId: 'facility-owner-gate',
      legalEntityId: '71000000-0000-4000-8000-000000000021',
      principalId: '72000000-0000-4000-8000-000000000021',
      tenantId: '70000000-0000-4000-8000-000000000020',
    };
    const gate = makeTestAccessDecision({
      answers: {
        'facility.operations.api-records.read': { outcome: 'ALLOWED' },
        'facility.operations.apply-command.write': { outcome: 'ALLOWED' },
      },
    });
    const grants = yield* facilityOperationsGrants(scope).pipe(Effect.provideService(AccessDecisionGate, gate));
    expect(grants).toEqual({ readAll: false, readOperational: true, writeAll: false, writeOperational: true });
    const records = yield* finishFacilityRecords(
      {},
      {
        rows: new Map([
          [
            'meters',
            {
              revision: 2,
              state: seedMetersState(),
              updatedAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-10-20T00:00:00Z')),
            },
          ],
          [
            'documents',
            {
              revision: 1,
              state: { malformed: 'must not decode or expose' },
              updatedAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-10-20T00:00:00Z')),
            },
          ],
        ]),
      },
      grants,
      scope,
    );
    expect(records.agendas.documents).toBeUndefined();
    expect(records.agendas.assets).toBeUndefined();
    expect(records.agendas.security).toBeUndefined();
    expect(records.agendas.meters).toMatchObject({ canManage: false, canReadFinancial: false, canWrite: true });
    for (const meter of records.agendas.meters?.state.meters ?? []) {
      expect(meter.note).toBeUndefined();
      expect(meter.contract).toBeUndefined();
      for (const reading of meter.readings ?? []) {
        expect(reading.costMinor).toBeUndefined();
        expect(reading.photo).toBeUndefined();
      }
    }
    expect(gate.askedDecisions.map((question) => question.scope)).toEqual([scope, scope, scope]);
    expect(gate.askedDecisions[1]?.parentRead?.capability.capabilityKey).toBe('facility.operations.api-records.read');
  }),
);

it.effect('the registered search owners never query restricted indexes for an operational reader', () =>
  Effect.gen(function* searchOwnerGate() {
    for (const resource of ['asset', 'device', 'document'] as const) {
      const outcome = yield* runFacilitySearchScenario(resource, { operationalOnly: true });
      expect(outcome.exit).toEqual(Exit.succeed([]));
      expect(outcome.searched).toBe(false);
      expect(outcome.snapshot.ownerQueries).toEqual([]);
    }
    const meters = yield* runFacilitySearchScenario('meter', { operationalOnly: true });
    expect(Exit.isSuccess(meters.exit)).toBe(true);
    expect(meters.searched).toBe(true);
    expect(meters.snapshot.ownerQueries).toHaveLength(1);
  }).pipe(Effect.provide(NodeCrypto.layer)),
);
