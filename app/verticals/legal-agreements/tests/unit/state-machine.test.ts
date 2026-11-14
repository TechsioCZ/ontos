import { describe, expect, it } from 'effect-rstest';
import { Effect, Exit, Schema } from 'effect';
import { TestClock } from 'effect/testing';
import { AgreementsConflict, AgreementsRejected } from '../../shared/actions/apply-command.ts';

import type { AgreementsState, Contract, Document } from '../../shared/apis/records.ts';
import {
  presentContracts,
  transitionAgreements,
  unavailableAgreementsValidators,
} from '../../src/services/persistence.service.ts';
import type { AgreementsValidators } from '../../src/services/persistence.service.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const scope = { legalEntityId, tenantId };
const unitRef = {
  moduleId: 'property.portfolio',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'property.portfolio.unit',
  tenantId,
} as const;
const propertyRef = {
  moduleId: 'property.portfolio',
  resourceId: '77777777-7777-4777-8777-777777777777',
  resourceType: 'property.portfolio.property',
  tenantId,
} as const;
const counterpartyRef = {
  moduleId: 'party.registry',
  resourceId: '44444444-4444-4444-8444-444444444444',
  resourceType: 'party.registry.counterparty',
  tenantId,
} as const;
const partyRef = {
  moduleId: 'party.registry',
  resourceId: '99999999-9999-4999-8999-999999999999',
  resourceType: 'party.registry.party',
  tenantId,
} as const;
const contractRef = {
  moduleId: 'legal.agreements',
  resourceId: '55555555-5555-4555-8555-555555555555',
  resourceType: 'legal.agreements.contract',
  tenantId,
} as const;
const documentRef = {
  moduleId: 'legal.agreements',
  resourceId: '66666666-6666-4666-8666-666666666666',
  resourceType: 'legal.agreements.document',
  tenantId,
} as const;
const draft: Contract = {
  contractRef,
  counterpartyRef,
  endDate: '2026-10-25',
  kind: 'LEASE',
  lifecycleState: 'DRAFT',
  note: null,
  occupancyRef: null,
  propertyRef: null,
  renewalNoticeDate: '2026-10-05',
  signatureState: 'NOT_SENT',
  startDate: '2026-01-01',
  supersedesContractRef: null,
  unitRef,
};
const document: Document = {
  contractRef,
  createdAt: '2026-10-05T00:00:00.000Z',
  documentRef,
  fileName: 'lease.pdf',
  kind: 'LEASE',
  lifecycleState: 'FINAL',
  signedDocumentReference: 'SIMULATED:signed-lease',
  title: 'Lease',
  updatedAt: '2026-10-05T00:00:00.000Z',
};
const empty: AgreementsState = { contracts: [], documents: [] };
const validators: AgreementsValidators = {
  ...unavailableAgreementsValidators,
  counterparty: (ref) =>
    Effect.succeed({
      activeCustomer: true,
      archived: false,
      counterpartyRef: ref,
      displayName: 'Canonical customer',
      legalEntityId,
      partyRef,
    }),
  unit: (ref) => Effect.succeed({ legalEntityId, lifecycleState: 'ACTIVE', propertyRef, unitRef: ref }),
};
const rejected = <Success, Failure>(effect: Effect.Effect<Success, Failure>) =>
  Effect.exit(effect).pipe(Effect.tap((exit) => Effect.sync(() => expect(Exit.isFailure(exit)).toBe(true))));

describe('Agreements state transitions', () => {
  it.effect('sets and clears commercial terms on draft and active contracts only', () =>
    Effect.gen(function* setsTerms() {
      const rentTerms = {
        currency: 'CZK',
        monthlyRentMinor: 1_850_000,
        paymentDay: 15,
        serviceChargesMinor: 320_000,
      } as const;
      const initial: AgreementsState = { ...empty, contracts: [{ ...draft, lifecycleState: 'ACTIVE' }] };
      const set = yield* transitionAgreements(
        initial,
        {
          _tag: 'SetContractTerms',
          contractRef: draft.contractRef,
          noticePeriod: '3 měsíce',
          rentTerms,
          responsiblePerson: 'Jana Správcová',
          subject: 'Nájem bytu 2+kk',
        },
        scope,
        validators,
      );
      expect(set.snapshot.contracts[0]).toEqual({
        ...draft,
        lifecycleState: 'ACTIVE',
        noticePeriod: '3 měsíce',
        rentTerms,
        responsiblePerson: 'Jana Správcová',
        subject: 'Nájem bytu 2+kk',
      });
      const cleared = yield* transitionAgreements(
        set.snapshot,
        { _tag: 'SetContractTerms', contractRef: draft.contractRef, subject: 'Jen předmět' },
        scope,
        validators,
      );
      expect(cleared.snapshot.contracts[0]).toEqual({ ...draft, lifecycleState: 'ACTIVE', subject: 'Jen předmět' });
      const terminated: AgreementsState = { ...empty, contracts: [{ ...draft, lifecycleState: 'TERMINATED' }] };
      expect(
        Schema.is(AgreementsConflict)(
          yield* Effect.flip(
            transitionAgreements(
              terminated,
              { _tag: 'SetContractTerms', contractRef: draft.contractRef, rentTerms },
              scope,
              validators,
            ),
          ),
        ),
      ).toBe(true);
    }),
  );
  it.effect('creates a commercial agreement without property or occupancy access', () =>
    Effect.gen(function* commercialContract() {
      const commercial: Contract = { ...draft, kind: 'OTHER', unitRef: null };
      const created = yield* transitionAgreements(
        empty,
        { _tag: 'CreateContract', record: commercial },
        scope,
        validators,
      );
      expect(created.snapshot.contracts).toEqual([commercial]);
      const leaseWithoutUnit = yield* Effect.flip(
        transitionAgreements(
          empty,
          { _tag: 'CreateContract', record: { ...commercial, kind: 'LEASE' } },
          scope,
          validators,
        ),
      );
      expect(Schema.is(AgreementsRejected)(leaseWithoutUnit)).toBe(true);
    }),
  );
  it.effect('records a manual signature and signed document without a simulated provider request', () =>
    Effect.gen(function* manualSignature() {
      yield* TestClock.setTime(Date.parse('2026-10-16T12:00:00.000Z'));
      const commercial: Contract = { ...draft, kind: 'OTHER', lifecycleState: 'ACTIVE', unitRef: null };
      const initial: AgreementsState = { ...empty, contracts: [commercial] };
      const command = {
        _tag: 'RecordSignedDocument',
        contractRef,
        document: { ...document, kind: 'OTHER', signedDocumentReference: 'archive://agreements/signed.pdf' },
        signedBy: 'Jan Novák',
        signedOn: '2026-01-01',
      } as const;
      const recorded = yield* transitionAgreements(initial, command, scope, validators);
      expect(recorded.snapshot.contracts[0]).toMatchObject({ lifecycleState: 'ACTIVE', signatureState: 'SIGNED' });
      expect(recorded.snapshot.documents[0]).toMatchObject({
        lifecycleState: 'FINAL',
        signedBy: 'Jan Novák',
        signedDocumentReference: 'archive://agreements/signed.pdf',
        signedOn: '2026-01-01',
      });
      expect(
        Schema.is(AgreementsConflict)(
          yield* Effect.flip(transitionAgreements(recorded.snapshot, command, scope, validators)),
        ),
      ).toBe(true);
      for (const invalid of [
        { ...command, document: { ...command.document, fileName: null } },
        { ...command, document: { ...command.document, signedDocumentReference: null } },
        {
          ...command,
          document: { ...command.document, contractRef: { ...contractRef, resourceId: unitRef.resourceId } },
        },
        { ...command, document: { ...command.document, documentRef: { ...documentRef, tenantId: legalEntityId } } },
        { ...command, signedOn: '2999-01-01' },
      ]) {
        expect(
          Schema.is(AgreementsRejected)(yield* Effect.flip(transitionAgreements(initial, invalid, scope, validators))),
        ).toBe(true);
      }
      const pending: AgreementsState = { ...initial, contracts: [{ ...commercial, signatureState: 'SENT' }] };
      expect(
        Schema.is(AgreementsConflict)(yield* Effect.flip(transitionAgreements(pending, command, scope, validators))),
      ).toBe(true);
    }),
  );

  it.effect('edits only an unsigned draft period while retaining its anchors and existing metadata', () =>
    Effect.gen(function* updateDraftPeriod() {
      const previous: Contract = { ...draft, note: 'Keep the existing note', propertyRef };
      const initial: AgreementsState = { ...empty, contracts: [previous], documents: [document] };
      const edited: Contract = { ...previous, endDate: '2027-10-06', startDate: '2026-10-06' };
      const updated = yield* transitionAgreements(
        initial,
        { _tag: 'UpdateContract', record: edited },
        scope,
        validators,
      );
      expect(updated.snapshot.contracts).toEqual([edited]);
      expect(updated.snapshot.documents).toEqual(initial.documents);
      for (const record of [
        { ...previous, signatureState: 'SENT' as const },
        { ...previous, lifecycleState: 'ACTIVE' as const },
      ]) {
        const failure = yield* Effect.flip(
          transitionAgreements(
            { ...initial, contracts: [record] },
            { _tag: 'UpdateContract', record: { ...record, endDate: edited.endDate, startDate: edited.startDate } },
            scope,
            validators,
          ),
        );
        expect(Schema.is(AgreementsConflict)(failure)).toBe(true);
      }
      const invalid = yield* Effect.flip(
        transitionAgreements(
          initial,
          { _tag: 'UpdateContract', record: { ...previous, endDate: previous.startDate } },
          scope,
          validators,
        ),
      );
      expect(Schema.is(AgreementsRejected)(invalid)).toBe(true);
    }),
  );
  it.effect(
    'resolves renewal attention with one successor draft while preserving the active contract expiry indicator',
    () =>
      Effect.gen(function* testEffect() {
        const previous = { ...draft, lifecycleState: 'ACTIVE' as const, signatureState: 'SIGNED' as const };
        const initial = { ...empty, contracts: [previous] };
        expect(presentContracts(initial, '2026-10-05')[0]?.expiringSoon).toBe(true);
        const successor = {
          ...draft,
          contractRef: { ...contractRef, resourceId: '77777777-7777-4777-8777-777777777777' },
          endDate: '2027-10-25',
          startDate: '2026-10-25',
          supersedesContractRef: contractRef,
        };
        const renewed = yield* transitionAgreements(
          initial,
          { _tag: 'RenewContract', contractRef, successor },
          scope,
          validators,
        );
        expect(renewed.snapshot.contracts[0]).toEqual(previous);
        const presented = presentContracts(renewed.snapshot, '2026-10-05');
        expect(presented[0]).toMatchObject({ expiringSoon: true, hasSuccessorDraft: true, lifecycleState: 'ACTIVE' });
        expect(presented.filter((record) => record.expiringSoon)).toHaveLength(1);
        expect(presented.filter((record) => record.expiringSoon && !record.hasSuccessorDraft)).toEqual([]);
        expect(presented[1]).toMatchObject({ expiringSoon: false, lifecycleState: 'DRAFT' });
        yield* rejected(
          transitionAgreements(renewed.snapshot, { _tag: 'RenewContract', contractRef, successor }, scope, validators),
        );
      }),
  );
  it.effect('rejects wrong tenant, inactive customer, and absent public validation', () =>
    Effect.gen(function* testEffect() {
      yield* rejected(
        transitionAgreements(
          empty,
          {
            _tag: 'CreateContract',
            record: { ...draft, counterpartyRef: { ...counterpartyRef, tenantId: legalEntityId } },
          },
          scope,
          validators,
        ),
      );
      yield* rejected(
        transitionAgreements(empty, { _tag: 'CreateContract', record: draft }, scope, {
          ...validators,
          counterparty: (ref) =>
            Effect.succeed({
              activeCustomer: false,
              archived: false,
              counterpartyRef: ref,
              displayName: 'Canonical customer',
              legalEntityId,
              partyRef,
            }),
        }),
      );
      yield* rejected(
        transitionAgreements(empty, { _tag: 'CreateContract', record: draft }, scope, unavailableAgreementsValidators),
      );
    }),
  );
  it.effect('resolves optional occupancy links through the owner and rejects a different unit or customer', () =>
    Effect.gen(function* linkedOccupancyTest() {
      const occupancyRef = {
        moduleId: 'property.leasing',
        resourceId: '88888888-8888-4888-8888-888888888888',
        resourceType: 'property.leasing.occupancy',
        tenantId,
      } as const;
      const record = { ...draft, occupancyRef };
      const linkedValidators: AgreementsValidators = {
        ...validators,
        occupancy: (ref) =>
          Effect.succeed({
            customerCounterpartyRef: counterpartyRef,
            kind: 'LONG_TERM_LEASE',
            occupancyRef: ref,
            unitRef,
          }),
      };
      const created = yield* transitionAgreements(empty, { _tag: 'CreateContract', record }, scope, linkedValidators);
      expect(created.snapshot.contracts[0]?.occupancyRef).toEqual(occupancyRef);
      yield* rejected(transitionAgreements(empty, { _tag: 'CreateContract', record }, scope, validators));
      for (const mismatch of ['unit', 'customer'] as const) {
        yield* rejected(
          transitionAgreements(empty, { _tag: 'CreateContract', record }, scope, {
            ...linkedValidators,
            occupancy: (ref) =>
              Effect.succeed({
                customerCounterpartyRef:
                  mismatch === 'customer'
                    ? { ...counterpartyRef, resourceId: documentRef.resourceId }
                    : counterpartyRef,
                kind: 'LONG_TERM_LEASE',
                occupancyRef: ref,
                unitRef: mismatch === 'unit' ? { ...unitRef, resourceId: documentRef.resourceId } : unitRef,
              }),
          }),
        );
      }
    }),
  );
  it('derives expiration using the supplied business date, independently of audit time', () => {
    expect(
      presentContracts(
        { ...empty, contracts: [{ ...draft, endDate: '2026-10-05', lifecycleState: 'ACTIVE' }] },
        '2026-10-05',
      )[0],
    ).toMatchObject({ expiringSoon: false, isExpired: true });
  });
  it('limits expiry warnings to active unexpired contracts within the thirty-day calendar window', () => {
    const contracts: Contract[] = [
      { ...draft, lifecycleState: 'DRAFT' },
      { ...draft, lifecycleState: 'TERMINATED' },
      { ...draft, lifecycleState: 'EXPIRED' },
      { ...draft, endDate: null, lifecycleState: 'ACTIVE' },
      { ...draft, endDate: '2026-11-05', lifecycleState: 'ACTIVE' },
      { ...draft, endDate: '2026-11-04', lifecycleState: 'ACTIVE' },
    ];
    expect(presentContracts({ ...empty, contracts }, '2026-10-05').map((record) => record.expiringSoon)).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
  });
  it('moves the expiry warning with the actual business day', () => {
    const state = { ...empty, contracts: [{ ...draft, endDate: '2026-10-25', lifecycleState: 'ACTIVE' as const }] };
    expect(presentContracts(state, '2026-10-20')[0]).toMatchObject({ expiringSoon: true, isExpired: false });
    expect(presentContracts(state, '2026-10-26')[0]).toMatchObject({ expiringSoon: false, isExpired: true });
  });
});
