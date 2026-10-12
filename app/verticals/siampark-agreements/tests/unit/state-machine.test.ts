import { describe, expect, it } from 'effect-rstest';
import { Effect, Exit, Schema } from 'effect';
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
  moduleId: 'siampark.property',
  resourceId: '33333333-3333-4333-8333-333333333333',
  resourceType: 'siampark.property.unit',
  tenantId,
} as const;
const propertyRef = {
  moduleId: 'siampark.property',
  resourceId: '77777777-7777-4777-8777-777777777777',
  resourceType: 'siampark.property.property',
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
  moduleId: 'siampark.agreements',
  resourceId: '55555555-5555-4555-8555-555555555555',
  resourceType: 'siampark.agreements.contract',
  tenantId,
} as const;
const documentRef = {
  moduleId: 'siampark.agreements',
  resourceId: '66666666-6666-4666-8666-666666666666',
  resourceType: 'siampark.agreements.document',
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
const empty: AgreementsState = { contracts: [], documents: [], signatureObservations: [] };
let signatureSequence = 0;
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
  signatureRequestId: Effect.sync(() => {
    signatureSequence += 1;
    return `00000000-0000-4000-8000-${String(signatureSequence).padStart(12, '0')}`;
  }),
  unit: (ref) => Effect.succeed({ legalEntityId, lifecycleState: 'ACTIVE', propertyRef, unitRef: ref }),
};
const rejected = <Success, Failure>(effect: Effect.Effect<Success, Failure>) =>
  Effect.exit(effect).pipe(Effect.tap((exit) => Effect.sync(() => expect(Exit.isFailure(exit)).toBe(true))));

describe('Agreements state transitions', () => {
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
      expect(updated.snapshot.signatureObservations).toEqual(initial.signatureObservations);
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
  it.effect('keeps lifecycle independent from a simulated signature and produces final signed metadata', () =>
    Effect.gen(function* testEffect() {
      const created = yield* transitionAgreements(empty, { _tag: 'CreateContract', record: draft }, scope, validators);
      const sent = yield* transitionAgreements(
        created.snapshot,
        { _tag: 'SendSignature', contractRef, signerContact: 'signer@example.test' },
        scope,
        validators,
      );
      expect(sent.snapshot.contracts[0]).toMatchObject({ lifecycleState: 'DRAFT', signatureState: 'SENT' });
      expect(sent.snapshot.signatureObservations[0]).toMatchObject({
        completedAt: null,
        integrationKind: 'ELECTRONIC_SIGNATURE',
        ownerResourceRef: contractRef,
        providerLabel: 'DEMO',
        signer: { contact: 'signer@example.test', counterpartyRef, displayName: 'Canonical customer', partyRef },
      });
      expect(sent.snapshot.signatureObservations[0]?.attemptedAt).not.toBe('2026-10-05T00:00:00.000Z');
      yield* rejected(
        transitionAgreements(
          sent.snapshot,
          { _tag: 'ObserveSignature', contractRef, document: null, outcome: 'SIGNED' },
          scope,
          validators,
        ),
      );
      const signed = yield* transitionAgreements(
        sent.snapshot,
        { _tag: 'ObserveSignature', contractRef, document, outcome: 'SIGNED' },
        scope,
        validators,
      );
      expect(signed.snapshot.contracts[0]).toMatchObject({ lifecycleState: 'DRAFT', signatureState: 'SIGNED' });
      expect(signed.snapshot.documents[0]).toMatchObject({
        lifecycleState: 'FINAL',
        signedDocumentReference: 'SIMULATED:signed-lease',
      });
      expect(signed.snapshot.signatureObservations[0]).toMatchObject({
        correlation: sent.snapshot.signatureObservations[0]?.correlation,
        mode: 'SIMULATED',
        state: 'SIGNED',
      });
      const active = yield* transitionAgreements(
        signed.snapshot,
        { _tag: 'ActivateContract', contractRef },
        scope,
        validators,
      );
      expect(active.snapshot.contracts[0]).toMatchObject({ lifecycleState: 'ACTIVE', signatureState: 'SIGNED' });
    }),
  );
  it.effect(
    'resolves renewal attention with one successor draft while preserving the active contract expiry indicator',
    () =>
      Effect.gen(function* testEffect() {
        const previous = { ...draft, lifecycleState: 'ACTIVE' as const, signatureState: 'SIGNED' as const };
        const initial = { ...empty, contracts: [previous] };
        expect(presentContracts(initial)[0]?.expiringSoon).toBe(true);
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
        const presented = presentContracts(renewed.snapshot);
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
        moduleId: 'siampark.occupancy',
        resourceId: '88888888-8888-4888-8888-888888888888',
        resourceType: 'siampark.occupancy.occupancy',
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
  it.effect('rejects signatures on unsigned-unsent or terminated records and does not fabricate signed evidence', () =>
    Effect.gen(function* testEffect() {
      yield* rejected(
        transitionAgreements(
          { ...empty, contracts: [draft] },
          { _tag: 'ObserveSignature', contractRef, document, outcome: 'SIGNED' },
          scope,
          validators,
        ),
      );
      const sent = yield* transitionAgreements(
        { ...empty, contracts: [draft] },
        { _tag: 'SendSignature', contractRef, signerContact: 'signer@example.test' },
        scope,
        validators,
      );
      const declined = yield* transitionAgreements(
        sent.snapshot,
        { _tag: 'ObserveSignature', contractRef, document: null, outcome: 'DECLINED' },
        scope,
        validators,
      );
      expect(declined.snapshot.documents).toEqual([]);
      expect(declined.snapshot.contracts[0]?.signatureState).toBe('DECLINED');
      expect(declined.snapshot.signatureObservations[0]?.observationId).toBe(
        sent.snapshot.signatureObservations[0]?.observationId,
      );
      expect(declined.snapshot.signatureObservations[0]?.completedAt).toBeTruthy();
      const resent = yield* transitionAgreements(
        declined.snapshot,
        { _tag: 'SendSignature', contractRef, signerContact: 'retry@example.test' },
        scope,
        validators,
      );
      expect(resent.snapshot.signatureObservations).toHaveLength(2);
      expect(resent.snapshot.signatureObservations[1]?.observationId).not.toBe(
        sent.snapshot.signatureObservations[0]?.observationId,
      );
      expect(resent.snapshot.signatureObservations[0]?.state).toBe('DECLINED');
      yield* rejected(
        transitionAgreements(
          { ...empty, contracts: [{ ...draft, lifecycleState: 'TERMINATED' }] },
          { _tag: 'SendSignature', contractRef, signerContact: 'signer@example.test' },
          scope,
          validators,
        ),
      );
    }),
  );
  it.effect('refuses missing contact and unavailable or mismatched canonical signer validation', () =>
    Effect.gen(function* signatureGuards() {
      const initial = { ...empty, contracts: [draft] };
      yield* rejected(
        transitionAgreements(initial, { _tag: 'SendSignature', contractRef, signerContact: '  ' }, scope, validators),
      );
      yield* rejected(
        transitionAgreements(
          initial,
          { _tag: 'SendSignature', contractRef, signerContact: 'signer@example.test' },
          scope,
          unavailableAgreementsValidators,
        ),
      );
      yield* rejected(
        transitionAgreements(
          initial,
          { _tag: 'SendSignature', contractRef, signerContact: 'signer@example.test' },
          scope,
          {
            ...validators,
            counterparty: (ref) =>
              validators
                .counterparty(ref)
                .pipe(Effect.map((value) => ({ ...value, partyRef: { ...value.partyRef, tenantId: legalEntityId } }))),
          },
        ),
      );
    }),
  );
  it('derives expiration using the fixed demo date, independently of audit time', () => {
    expect(
      presentContracts({ ...empty, contracts: [{ ...draft, endDate: '2026-10-05', lifecycleState: 'ACTIVE' }] })[0],
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
    expect(presentContracts({ ...empty, contracts }).map((record) => record.expiringSoon)).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
  });
});
