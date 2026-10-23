import { expect, it } from 'effect-rstest';

import {
  occupancyRevert,
  occupancyStillInPlace,
  reviewOccupancyProposal,
  revertUnavailableReasonOf,
  targetOccupancyId,
} from '../../src/api/agent-review.ts';

const tenantId = 'tenant-1';
const MISSING_BEFORE = 'Chybí původní hodnoty, změnu nelze automaticky vrátit.';
const occupancyRef = {
  moduleId: 'property.leasing',
  resourceId: 'o1',
  resourceType: 'property.leasing.occupancy',
  tenantId,
};
const rentTerms = { currency: 'CZK', monthlyRentMinor: 1_500_000, paymentDay: 15, serviceChargesMinor: 300_000 };

const review = (
  request: Partial<Parameters<typeof reviewOccupancyProposal>[0]['request']> & { command: Record<string, unknown> },
  occupancy?: Record<string, unknown>,
  /** `null`: the lease read failed. */
  read: { readonly canWrite: boolean | undefined } | null = { canWrite: true },
) =>
  reviewOccupancyProposal({
    occupancy,
    read: read ?? undefined,
    request: { actionSlug: 'apply-command', key: 'k', stage: 'proposed', ...request },
    tenantId,
  });

it('rent term changes and draft edits read the lease they change', () => {
  expect(targetOccupancyId({ _tag: 'SetRentTerms', occupancyRef: { resourceId: 'o1' } })).toBe('o1');
  expect(targetOccupancyId({ _tag: 'UpdateDraft', occupancyRef })).toBe('o1');
  expect(targetOccupancyId({ _tag: 'Confirm', occupancyRef })).toBeUndefined();
  expect(targetOccupancyId({ _tag: 'CreateDraft' })).toBeUndefined();
});

it('SetRentTerms restores the previous rent terms', () => {
  expect(occupancyRevert({ _tag: 'SetRentTerms', occupancyRef, rentTerms: {} }, { rentTerms }, tenantId)).toEqual({
    commands: [{ _tag: 'SetRentTerms', occupancyRef, rentTerms }],
    kind: 'commands',
  });
  expect(occupancyRevert({ _tag: 'SetRentTerms', occupancyRef }, { startDate: '2026-01-01' }, tenantId)).toEqual({
    kind: 'none',
    reason: MISSING_BEFORE,
  });
});

it('UpdateDraft restores the dates and rent terms of the draft', () => {
  expect(
    occupancyRevert(
      { _tag: 'UpdateDraft', occupancyRef, startDate: '2026-02-01' },
      { startDate: '2026-01-01' },
      tenantId,
    ),
  ).toEqual({
    commands: [{ _tag: 'UpdateDraft', endDate: null, occupancyRef, startDate: '2026-01-01' }],
    kind: 'commands',
  });
  expect(
    occupancyRevert(
      { _tag: 'UpdateDraft', occupancyRef, startDate: '2026-02-01' },
      { endDate: '2026-12-31', rentTerms, startDate: '2026-01-01' },
      tenantId,
    ),
  ).toEqual({
    commands: [{ _tag: 'UpdateDraft', endDate: '2026-12-31', occupancyRef, rentTerms, startDate: '2026-01-01' }],
    kind: 'commands',
  });
  expect(occupancyRevert({ _tag: 'UpdateDraft', occupancyRef }, undefined, tenantId)).toEqual({
    kind: 'none',
    reason: MISSING_BEFORE,
  });
});

it('CreateDraft is undone by cancelling the created lease', () => {
  expect(occupancyRevert({ _tag: 'CreateDraft' }, undefined, tenantId)).toEqual({
    commands: [{ _tag: 'Cancel', occupancyRef: { ...occupancyRef, resourceId: '$createdId' } }],
    createdIdPath: 'resourceRef.resourceId',
    kind: 'commands',
  });
});

it('occupancy state changes are not automatically revertible', () => {
  for (const tag of ['Confirm', 'Activate', 'Complete', 'Cancel']) {
    expect(occupancyRevert({ _tag: tag, occupancyRef }, undefined, tenantId)).toEqual({
      kind: 'none',
      reason: 'Změnu stavu nájmu nelze automaticky vrátit.',
    });
    expect(revertUnavailableReasonOf({ _tag: tag })).toBe('Změnu stavu nájmu nelze automaticky vrátit.');
  }
});

it('pending proposals report undo support from the command alone', () => {
  for (const tag of ['SetRentTerms', 'UpdateDraft', 'CreateDraft']) {
    expect(revertUnavailableReasonOf({ _tag: tag })).toBeUndefined();
  }
  expect(revertUnavailableReasonOf({ _tag: 'PrepareNotice' })).toBe('Tuto změnu nelze automaticky vrátit.');
});

it('detects rent terms or a start date a person changed after the approval', () => {
  const setTerms = { _tag: 'SetRentTerms', occupancyRef, rentTerms };
  expect(occupancyStillInPlace(setTerms, { rentTerms })).toBe(true);
  expect(occupancyStillInPlace(setTerms, { rentTerms: { ...rentTerms, paymentDay: 1 } })).toBe(false);
  expect(occupancyStillInPlace(setTerms, undefined)).toBe(false);
  const draft = { _tag: 'UpdateDraft', occupancyRef, startDate: '2026-02-01' };
  expect(occupancyStillInPlace(draft, { startDate: '2026-02-01' })).toBe(true);
  expect(occupancyStillInPlace(draft, { startDate: '2026-03-01' })).toBe(false);
  expect(occupancyStillInPlace({ _tag: 'CreateDraft' }, undefined)).toBeUndefined();
});

it('a pending rent change carries its undo plan and no lines of its own', () => {
  expect(
    review({ command: { _tag: 'SetRentTerms', occupancyRef, rentTerms: {} } }, { occupancyRef, rentTerms }),
  ).toEqual({
    key: 'k',
    revert: { commands: [{ _tag: 'SetRentTerms', occupancyRef, rentTerms }], kind: 'commands' },
    visible: true,
  });
  expect(review({ command: { _tag: 'Confirm', occupancyRef } })).toEqual({
    key: 'k',
    revert: { kind: 'none', reason: 'Změnu stavu nájmu nelze automaticky vrátit.' },
    revertUnavailableReason: 'Změnu stavu nájmu nelze automaticky vrátit.',
    visible: true,
  });
});

it('a lease gone for the reader hides the proposal, an unread lease stays open, a read-only reader is blocked', () => {
  const command = { _tag: 'UpdateDraft', occupancyRef, startDate: '2026-02-01' };
  expect(review({ command }).visible).toBe(false);
  expect(review({ command }, undefined, null)).toEqual({
    key: 'k',
    revert: { kind: 'none', reason: MISSING_BEFORE },
    visible: true,
  });
  expect(review({ command: { _tag: 'CreateDraft' } }, undefined, { canWrite: false }).blockedReason).toBe(
    'V tomto modulu nemáte oprávnění k zápisu.',
  );
  expect(review({ command: { _tag: 'CreateDraft' } }, undefined, null).blockedReason).toBeUndefined();
});

it('undo leaves a change alone when the lease was edited since or cannot be read', () => {
  const command = { _tag: 'SetRentTerms', occupancyRef, rentTerms };
  expect(review({ command, stage: 'undo' }, { rentTerms })).toEqual({ key: 'k', stillInPlace: true, visible: true });
  expect(review({ command, stage: 'undo' }, { rentTerms: {} }).stillInPlace).toBe(false);
  expect(review({ command, stage: 'undo' }).visible).toBe(false);
  expect(review({ command: { _tag: 'CreateDraft' }, stage: 'undo' })).toEqual({ key: 'k', visible: true });
});

it('history is visible without lines of its own', () => {
  expect(review({ command: { _tag: 'SetRentTerms', occupancyRef, rentTerms }, stage: 'history' })).toEqual({
    key: 'k',
    visible: true,
  });
});
