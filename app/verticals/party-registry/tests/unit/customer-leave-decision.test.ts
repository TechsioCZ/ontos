import { expect, it } from 'effect-rstest';

import { customerLeaveDecision } from '../../src/routes/[lang]/prodej/zakaznici/customers-data.ts';

it('asks before a row click retargets the open detail that has unsaved changes', () => {
  expect(customerLeaveDecision({ busy: false, dirty: true })).toBe('confirm');
});

it('retargets at once when the open detail is clean', () => {
  expect(customerLeaveDecision({ busy: false, dirty: false })).toBe('proceed');
});

it('ignores a retarget while a save or refresh is in flight, dirty or not', () => {
  expect(customerLeaveDecision({ busy: true, dirty: false })).toBe('ignore');
  expect(customerLeaveDecision({ busy: true, dirty: true })).toBe('ignore');
});
