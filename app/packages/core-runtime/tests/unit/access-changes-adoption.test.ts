import { expect, it } from 'effect-rstest';

import type { AdoptionRequest, AdoptionSelection } from '../../src/access/changes/adoption.ts';
import { planAdoption, planDecline } from '../../src/access/changes/adoption.ts';
import type { AccessConfigureBasis } from '../../src/access/changes/authority.ts';
import type { AdoptionPreview } from '../../src/access/changes/preview.ts';
import { previewAdoption } from '../../src/access/changes/preview.ts';
import type { RoleWithRevision } from '../../src/access/changes/role-edits.ts';
import { capabilityEffectLabel } from '../../src/access/changes/targets.ts';
import type { AccessChangeItem, Assignment, CatalogSnapshotEntry, Cell, Holder } from '../../src/access/model.ts';
import {
  adoptionTarget,
  agentHolder,
  assignment,
  BATCH,
  cell,
  changeItem,
  decision,
  delegatedBasis,
  delegation,
  entry,
  failureOf,
  fixedId,
  grantorHolding,
  instant,
  LEGAL_ENTITY,
  legalEntityScopeRecord,
  MANAGER,
  OTHER_LEGAL_ENTITY,
  OTHER_PERSON,
  ownerBasis,
  PERSON,
  principalHolder,
  ROLE,
  ROLE_ID,
  roleState,
  scopeAdminBasis,
  selection,
  succeeded,
  TENANT,
  tenantMembership,
} from './access-changes-fixtures.ts';

const NOTE = 'test.party.add-note';
const NOTE_TWO = 'test.party.note-two';
const VOID = 'test.invoice.void';
const PAY = 'test.invoice.pay';

const noteEntry = entry({ key: NOTE });
const noteTwoEntry = entry({ key: NOTE_TWO });
const voidEntry = entry({ key: VOID, modes: ['run', 'propose', 'approve'], risk: 'sensitive' });
const payEntry = entry({
  amountInput: 'amount',
  key: PAY,
  modes: ['run', 'propose', 'approve'],
  risk: 'critical',
});
const entries = [noteEntry, noteTwoEntry, voidEntry, payEntry];

const note = changeItem({ capabilityKey: NOTE, id: fixedId(70) });
const noteTwo = changeItem({ capabilityKey: NOTE_TWO, id: fixedId(71) });
const voidItem = changeItem({ capabilityKey: VOID, id: fixedId(72), risk: 'sensitive' });
const payItem = changeItem({ capabilityKey: PAY, id: fixedId(73), risk: 'critical' });

interface RequestInput {
  readonly actor?: Holder;
  readonly assignments?: readonly Assignment[];
  readonly authority?: AccessConfigureBasis;
  readonly decisionIds?: ReadonlyMap<string, string>;
  readonly entries?: readonly CatalogSnapshotEntry[];
  /** The cells the delegation's grantor holds; by default every entry in every mode, uncapped. */
  readonly grantorCells?: readonly Cell[];
  readonly items?: readonly AccessChangeItem[];
  readonly membership?: ReturnType<typeof tenantMembership>;
  readonly namedEffects?: ReadonlyMap<string, string>;
  readonly newRevisionIds?: ReadonlyMap<string, string>;
  readonly preview?: AdoptionPreview;
  readonly roles?: readonly RoleWithRevision[];
  readonly selections: readonly AdoptionSelection[];
}

const adoptionRequest = (input: RequestInput): AdoptionRequest => {
  const assignments = input.assignments ?? [];
  const { decisionIds, selections } = input;
  const fresh = previewAdoption({
    assignments,
    at: instant(3),
    items: selections.map(({ itemId, targets }) => ({ itemId, roleIds: targets.map(({ roleId }) => roleId) })),
  });
  const grantor = grantorHolding(
    (input.entries ?? entries).map(({ key }) => key),
    input.grantorCells,
  );
  return {
    actor: input.actor ?? principalHolder(),
    assignments: [...assignments, grantor.assignment],
    authority: input.authority ?? ownerBasis(),
    batchId: BATCH,
    decidedAt: instant(3),
    decisionIds: decisionIds ?? new Map(selections.map(({ itemId }, index) => [itemId, fixedId(80 + index)] as const)),
    entries: input.entries ?? entries,
    items: input.items ?? [note, noteTwo, voidItem, payItem],
    membership: input.membership ?? tenantMembership(),
    namedEffects: input.namedEffects ?? new Map<string, string>(),
    newRevisionIds: input.newRevisionIds ?? new Map([[ROLE, fixedId(41)]]),
    preview: input.preview ?? fresh,
    roles: [...(input.roles ?? [roleState({})]), grantor.role],
    selections,
    tenantId: TENANT,
  };
};

const activePerson = () => assignment({ incarnationId: fixedId(50), roleId: ROLE });
const noteCell = () => cell(NOTE);

it('adopts a release of routine items as one batch decision', () => {
  const plan = succeeded(
    planAdoption(
      adoptionRequest({
        assignments: [activePerson()],
        selections: [selection(note.id, [adoptionTarget({})]), selection(noteTwo.id, [adoptionTarget({})])],
      }),
    ),
  );
  expect(plan.decisions).toHaveLength(2);
  expect(new Set(plan.decisions.map(({ batchId }) => batchId))).toEqual(new Set([BATCH]));
  expect(plan.items.map(({ status }) => status)).toEqual(['adopted', 'adopted']);
  expect(plan.roleEdits).toHaveLength(1);
  expect(plan.roleEdits[0]?.addedCells.map(({ capabilityKey }) => capabilityKey)).toEqual([NOTE, NOTE_TWO]);
  expect(plan.roleEdits[0]?.cells).toHaveLength(2);
  expect(plan.preview.humanCount).toBe(1);
  // Both decisions point at the one revision that carries the adopted cells.
  expect(plan.decisions.map(({ roleRevisionIds }) => roleRevisionIds)).toEqual([[fixedId(41)], [fixedId(41)]]);
});

it('adopts a sensitive capability alone and only with the effect it grants named', () => {
  const targets = [adoptionTarget({ modes: ['run', 'approve'] })];
  const named = new Map([[voidItem.id, capabilityEffectLabel(voidEntry)]]);
  const plan = succeeded(
    planAdoption(
      adoptionRequest({
        namedEffects: named,
        selections: [selection(voidItem.id, targets)],
      }),
    ),
  );
  expect(plan.items.map(({ status }) => status)).toEqual(['adopted']);
  expect(plan.roleEdits[0]?.addedCells.map(({ mode }) => mode)).toEqual(['approve', 'run']);

  expect(failureOf(planAdoption(adoptionRequest({ selections: [selection(voidItem.id, targets)] }))).code).toBe(
    'access_changes_named_effect_mismatch',
  );
  expect(
    failureOf(
      planAdoption(
        adoptionRequest({
          namedEffects: new Map([[voidItem.id, 'void invoices']]),
          selections: [selection(voidItem.id, targets)],
        }),
      ),
    ).code,
  ).toBe('access_changes_named_effect_mismatch');
});

it('refuses to slip a sensitive capability into a routine batch', () => {
  expect(
    failureOf(
      planAdoption(
        adoptionRequest({
          namedEffects: new Map([[voidItem.id, capabilityEffectLabel(voidEntry)]]),
          selections: [selection(note.id, [adoptionTarget({})]), selection(voidItem.id, [adoptionTarget({})])],
        }),
      ),
    ).code,
  ).toBe('access_changes_sensitive_requires_individual_decision');
});

it('never lets an agent decide', () => {
  expect(
    failureOf(
      planAdoption(
        adoptionRequest({
          actor: agentHolder(),
          selections: [selection(note.id, [adoptionTarget({})])],
        }),
      ),
    ).code,
  ).toBe('access_changes_agent_cannot_decide');
});

it('refuses a preview that no longer matches the intent', () => {
  const stale = previewAdoption({
    assignments: [],
    at: instant(3),
    items: [{ itemId: note.id, roleIds: [ROLE_ID] }],
  });
  const changed = previewAdoption({
    assignments: [activePerson()],
    at: instant(3),
    items: [{ itemId: note.id, roleIds: [ROLE_ID] }],
  });
  expect(
    failureOf(
      planAdoption(
        adoptionRequest({
          assignments: [activePerson()],
          preview: stale,
          selections: [selection(note.id, [adoptionTarget({})])],
        }),
      ),
    ).code,
  ).toBe('access_changes_preview_stale');
  expect(
    succeeded(
      planAdoption(
        adoptionRequest({
          assignments: [activePerson()],
          preview: changed,
          selections: [selection(note.id, [adoptionTarget({})])],
        }),
      ),
    ).items[0]?.status,
  ).toBe('adopted');
});

it('refuses an item whose capability the module has not published', () => {
  expect(
    failureOf(
      planAdoption(
        adoptionRequest({
          entries: [voidEntry, payEntry],
          selections: [selection(note.id, [adoptionTarget({})])],
        }),
      ),
    ).code,
  ).toBe('access_changes_item_unavailable');
});

it('strips a removed capability only while it stays removed', () => {
  const removed = changeItem({ capabilityKey: NOTE, id: fixedId(74), kind: 'removed' });
  const plan = succeeded(
    planAdoption(
      adoptionRequest({
        entries: [noteTwoEntry, voidEntry, payEntry],
        items: [removed],
        roles: [roleState({ cells: [noteCell()] })],
        selections: [selection(removed.id, [adoptionTarget({})])],
      }),
    ),
  );
  expect(plan.roleEdits[0]?.removedCells.map(({ capabilityKey }) => capabilityKey)).toEqual([NOTE]);
  expect(plan.roleEdits[0]?.addedCells).toEqual([]);
  expect(
    failureOf(
      planAdoption(
        adoptionRequest({
          items: [removed],
          selections: [selection(removed.id, [adoptionTarget({})])],
        }),
      ),
    ).code,
  ).toBe('access_changes_item_unavailable');
});

it('bounds a delegated manager to the exact envelope', () => {
  const inside = delegation({ capabilityKeys: [NOTE], people: [PERSON], roleIds: [ROLE] });
  const plan = succeeded(
    planAdoption(
      adoptionRequest({
        actor: principalHolder(MANAGER),
        assignments: [activePerson()],
        authority: delegatedBasis(inside),
        selections: [selection(note.id, [adoptionTarget({})])],
      }),
    ),
  );
  expect(plan.items[0]?.status).toBe('adopted');

  // A brand-new capability is outside every existing envelope: extending it is a new decision (P8).
  const narrower = delegation({ capabilityKeys: [NOTE_TWO], people: [PERSON], roleIds: [ROLE] });
  expect(
    failureOf(
      planAdoption(
        adoptionRequest({
          actor: principalHolder(MANAGER),
          assignments: [activePerson()],
          authority: delegatedBasis(narrower),
          selections: [selection(note.id, [adoptionTarget({})])],
        }),
      ),
    ).code,
  ).toBe('access_changes_delegation_out_of_envelope');

  // A holder outside the named people is out of the envelope too.
  const otherPeople = delegation({ capabilityKeys: [NOTE], people: [OTHER_PERSON], roleIds: [ROLE] });
  expect(
    failureOf(
      planAdoption(
        adoptionRequest({
          actor: principalHolder(MANAGER),
          assignments: [activePerson()],
          authority: delegatedBasis(otherPeople),
          selections: [selection(note.id, [adoptionTarget({})])],
        }),
      ),
    ).code,
  ).toBe('access_changes_delegation_out_of_envelope');
});

it('bounds a delegated adoption by what the grantor holds now, mode by mode', () => {
  const envelope = delegation({ capabilityKeys: [NOTE], people: [PERSON], roleIds: [ROLE] });
  const adoptWith = (grantorCells: readonly Cell[]) =>
    planAdoption(
      adoptionRequest({
        actor: principalHolder(MANAGER),
        assignments: [activePerson()],
        authority: delegatedBasis(envelope),
        grantorCells,
        selections: [selection(note.id, [adoptionTarget({})])],
      }),
    );
  // A grantor who runs notes on every record lets the delegate adopt running them ...
  expect(succeeded(adoptWith([cell(NOTE)])).items[0]?.status).toBe('adopted');
  // ... one who only proposes them, or reaches only their own assigned records, does not.
  expect(failureOf(adoptWith([cell(NOTE, 'propose')])).code).toBe('access_changes_delegation_out_of_envelope');
  expect(failureOf(adoptWith([cell(NOTE, 'run', 'assigned')])).code).toBe('access_changes_delegation_out_of_envelope');
  // A grantor whose membership ended holds nothing a delegate may hand on, whatever their roles say.
  const formerMember = planAdoption(
    adoptionRequest({
      actor: principalHolder(MANAGER),
      assignments: [activePerson()],
      authority: delegatedBasis(envelope),
      grantorCells: [cell(NOTE)],
      membership: tenantMembership([MANAGER]),
      selections: [selection(note.id, [adoptionTarget({})])],
    }),
  );
  expect(failureOf(formerMember).code).toBe('access_changes_delegation_out_of_envelope');
});

it('bounds scope administration to the context it administers', () => {
  const legalEntityRole = roleState({ legalEntityId: LEGAL_ENTITY });
  const plan = succeeded(
    planAdoption(
      adoptionRequest({
        authority: scopeAdminBasis({ legalEntityIds: [LEGAL_ENTITY] }),
        roles: [legalEntityRole],
        selections: [selection(note.id, [adoptionTarget({})])],
      }),
    ),
  );
  expect(plan.items[0]?.status).toBe('adopted');
  expect(
    failureOf(
      planAdoption(
        adoptionRequest({
          authority: scopeAdminBasis({ tenantContext: true }),
          roles: [legalEntityRole],
          selections: [selection(note.id, [adoptionTarget({})])],
        }),
      ),
    ).code,
  ).toBe('access_changes_authority_missing');
});

it('adopts only the modes, selectors and ceilings the declaration supports', () => {
  const unsupportedMode = adoptionTarget({ modes: ['approve'] });
  expect(failureOf(planAdoption(adoptionRequest({ selections: [selection(note.id, [unsupportedMode])] }))).code).toBe(
    'access_changes_target_invalid',
  );
  const unsupportedSelector = adoptionTarget({ selector: 'assigned' });
  expect(
    failureOf(planAdoption(adoptionRequest({ selections: [selection(note.id, [unsupportedSelector])] }))).code,
  ).toBe('access_changes_target_invalid');
  const ceilingWithoutMoneyInput = adoptionTarget({ amountCeiling: { currency: 'CZK', limitMinor: 1000 } });
  expect(
    failureOf(planAdoption(adoptionRequest({ selections: [selection(voidItem.id, [ceilingWithoutMoneyInput])] }))).code,
  ).toBe('access_changes_target_invalid');
  const ceilingWithMoneyInput = adoptionTarget({ amountCeiling: { currency: 'CZK', limitMinor: 1000 } });
  expect(
    succeeded(
      planAdoption(
        adoptionRequest({
          namedEffects: new Map([[payItem.id, capabilityEffectLabel(payEntry)]]),
          selections: [selection(payItem.id, [ceilingWithMoneyInput])],
        }),
      ),
    ).roleEdits[0]?.addedCells[0]?.amountCeiling,
  ).toEqual({ currency: 'CZK', limitMinor: 1000 });
});

it('writes no revision for a role that already covers the adopted cells', () => {
  const plan = succeeded(
    planAdoption(
      adoptionRequest({
        newRevisionIds: new Map(),
        roles: [roleState({ cells: [noteCell()] })],
        selections: [selection(note.id, [adoptionTarget({})])],
      }),
    ),
  );
  expect(plan.roleEdits).toEqual([]);
  expect(plan.decisions[0]?.roleRevisionIds).toEqual([]);
});

it('refuses an adoption whose role edit has no successor revision', () => {
  expect(
    failureOf(
      planAdoption(
        adoptionRequest({
          newRevisionIds: new Map(),
          selections: [selection(note.id, [adoptionTarget({})])],
        }),
      ),
    ).code,
  ).toBe('access_changes_identity_missing');
});

it('refuses a role of another tenant', () => {
  expect(
    failureOf(
      planAdoption(
        adoptionRequest({
          roles: [roleState({ tenantId: fixedId(999) })],
          selections: [selection(note.id, [adoptionTarget({})])],
        }),
      ),
    ).code,
  ).toBe('access_changes_target_invalid');
});

it('declines sensitive and routine items together without touching a role', () => {
  const declineRequest = (itemIds: readonly string[]) => ({
    actor: principalHolder(),
    authority: ownerBasis(),
    batchId: BATCH,
    decidedAt: instant(3),
    decisionIds: new Map(itemIds.map((itemId, index) => [itemId, fixedId(90 + index)] as const)),
    itemIds,
    items: [note, voidItem, changeItem({ capabilityKey: VOID, id: fixedId(75), risk: 'sensitive', status: 'adopted' })],
    tenantId: TENANT,
  });
  const plan = succeeded(planDecline(declineRequest([note.id, voidItem.id])));
  expect(plan.items.map(({ status }) => status)).toEqual(['declined', 'declined']);
  expect(plan.decisions.map(({ roleRevisionIds }) => roleRevisionIds)).toEqual([[], []]);
  expect(failureOf(planDecline(declineRequest([fixedId(75)]))).code).toBe('access_changes_item_unavailable');
  expect(decision({ decision: 'decline', itemId: note.id, roleRevisionIds: [] }).decision).toBe('decline');
});

it('re-reads the published risk and never batches an item that became sensitive', () => {
  // The item was listed while the key was routine; a later release raised the published entry.
  const raisedEntry = entry({ key: NOTE, modes: ['run', 'propose', 'approve'], risk: 'sensitive' });
  const staleItem = changeItem({ capabilityKey: NOTE, id: fixedId(76) });
  const raisedAdoption = (
    selections: readonly AdoptionSelection[],
    namedEffects: ReadonlyMap<string, string> = new Map<string, string>(),
  ) => adoptionRequest({ entries: [raisedEntry, noteTwoEntry], items: [staleItem, noteTwo], namedEffects, selections });

  // The stale item's own risk is a floor, never the whole answer: it cannot ride in a routine batch.
  expect(
    failureOf(
      planAdoption(
        raisedAdoption([selection(staleItem.id, [adoptionTarget({})]), selection(noteTwo.id, [adoptionTarget({})])]),
      ),
    ).code,
  ).toBe('access_changes_sensitive_requires_individual_decision');
  // Alone it is still an individual decision that names the effect the entry now has.
  expect(failureOf(planAdoption(raisedAdoption([selection(staleItem.id, [adoptionTarget({})])]))).code).toBe(
    'access_changes_named_effect_mismatch',
  );
  expect(
    succeeded(
      planAdoption(
        raisedAdoption(
          [selection(staleItem.id, [adoptionTarget({})])],
          new Map([[staleItem.id, capabilityEffectLabel(raisedEntry)]]),
        ),
      ),
    ).items[0]?.status,
  ).toBe('adopted');
});

it('refuses an item that was undone instead of deciding it a second time', () => {
  const undone = changeItem({ capabilityKey: NOTE, id: fixedId(77), status: 'undone' });
  expect(
    failureOf(
      planAdoption(adoptionRequest({ items: [undone], selections: [selection(undone.id, [adoptionTarget({})])] })),
    ).code,
  ).toBe('access_changes_item_unavailable');
  expect(
    failureOf(
      planDecline({
        actor: principalHolder(),
        authority: ownerBasis(),
        batchId: BATCH,
        decidedAt: instant(3),
        decisionIds: new Map([[undone.id, fixedId(95)]]),
        itemIds: [undone.id],
        items: [undone],
        tenantId: TENANT,
      }),
    ).code,
  ).toBe('access_changes_item_unavailable');
});

it('bounds a delegated manager to the legal entity of their own delegation', () => {
  const scope = legalEntityScopeRecord({ legalEntityId: LEGAL_ENTITY });
  const envelope = delegation({ capabilityKeys: [NOTE], people: [PERSON], roleIds: [ROLE] });
  const adoptIn = (roles: readonly RoleWithRevision[], assignments: readonly Assignment[] = [activePerson()]) =>
    planAdoption(
      adoptionRequest({
        actor: principalHolder(MANAGER),
        assignments,
        authority: delegatedBasis(envelope, scope),
        roles,
        selections: [selection(note.id, [adoptionTarget({})])],
      }),
    );

  // The delegation's own legal entity is the only place it configures.
  expect(succeeded(adoptIn([roleState({ legalEntityId: LEGAL_ENTITY })])).items[0]?.status).toBe('adopted');
  // A tenant-wide role reaches every company, so it is never a delegate's to edit.
  expect(failureOf(adoptIn([roleState({})])).code).toBe('access_changes_delegation_out_of_envelope');
  // Another legal entity is a different scope with its own delegation.
  expect(failureOf(adoptIn([roleState({ legalEntityId: OTHER_LEGAL_ENTITY })])).code).toBe(
    'access_changes_delegation_out_of_envelope',
  );
  // An assignment held in another scope is outside the delegation too.
  expect(
    failureOf(
      adoptIn(
        [roleState({ legalEntityId: LEGAL_ENTITY })],
        [assignment({ incarnationId: fixedId(51), scopeId: fixedId(3) })],
      ),
    ).code,
  ).toBe('access_changes_delegation_out_of_envelope');
});

it('bounds every adopted cell by the delegation amount ceiling', () => {
  const envelope = delegation({
    amountCeiling: { currency: 'CZK', limitMinor: 500 },
    capabilityKeys: [PAY],
    people: [PERSON],
    roleIds: [ROLE],
  });
  const adoptPay = (amountCeiling?: { readonly currency: string; readonly limitMinor: number }) =>
    planAdoption(
      adoptionRequest({
        actor: principalHolder(MANAGER),
        assignments: [activePerson()],
        authority: delegatedBasis(envelope),
        namedEffects: new Map([[payItem.id, capabilityEffectLabel(payEntry)]]),
        selections: [
          selection(payItem.id, [amountCeiling === undefined ? adoptionTarget({}) : adoptionTarget({ amountCeiling })]),
        ],
      }),
    );

  // A money cell with no limit of its own is unlimited authority, so it never fits a capped envelope.
  expect(failureOf(adoptPay()).code).toBe('access_changes_delegation_out_of_envelope');
  expect(failureOf(adoptPay({ currency: 'CZK', limitMinor: 1000 })).code).toBe(
    'access_changes_delegation_out_of_envelope',
  );
  expect(failureOf(adoptPay({ currency: 'EUR', limitMinor: 100 })).code).toBe(
    'access_changes_delegation_out_of_envelope',
  );
  expect(succeeded(adoptPay({ currency: 'CZK', limitMinor: 500 })).items[0]?.status).toBe('adopted');

  // The ceiling limits money only: a capability that moves none is adopted without one.
  const noteEnvelope = delegation({
    amountCeiling: { currency: 'CZK', limitMinor: 500 },
    capabilityKeys: [NOTE],
    people: [PERSON],
    roleIds: [ROLE],
  });
  expect(
    succeeded(
      planAdoption(
        adoptionRequest({
          actor: principalHolder(MANAGER),
          assignments: [activePerson()],
          authority: delegatedBasis(noteEnvelope),
          selections: [selection(note.id, [adoptionTarget({})])],
        }),
      ),
    ).items[0]?.status,
  ).toBe('adopted');
});

it("never lets a person borrow another manager's delegation", () => {
  const envelope = delegation({ capabilityKeys: [NOTE], people: [PERSON], roleIds: [ROLE] });
  expect(
    failureOf(
      planAdoption(
        adoptionRequest({
          // The delegation names MANAGER as its manager; OUTSIDER is not that person.
          actor: principalHolder(OTHER_PERSON),
          assignments: [activePerson()],
          authority: delegatedBasis(envelope),
          selections: [selection(note.id, [adoptionTarget({})])],
        }),
      ),
    ).code,
  ).toBe('access_changes_delegation_out_of_envelope');
});
