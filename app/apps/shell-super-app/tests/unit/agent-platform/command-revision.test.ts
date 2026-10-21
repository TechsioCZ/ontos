import { expect, it } from 'effect-rstest';

import { commandRevisionFrom } from '../../../api/agent-platform/command-revision.ts';

it('uses the module-wide revision when the records read has one', () => {
  expect(commandRevisionFrom({ revision: 7 }, { _tag: 'CreateTask' })).toBe(7);
});

it('uses the agenda revision of a facility command', () => {
  const body = { agendas: { agenda: { revision: 115 }, assets: { revision: 121 }, purchasing: { revision: 3 } } };
  expect(commandRevisionFrom(body, { _tag: 'AgendaEventUpdate' })).toBe(115);
  expect(commandRevisionFrom(body, { _tag: 'AssetUpdate' })).toBe(121);
  expect(commandRevisionFrom(body, { _tag: 'StockReceipt' })).toBe(3);
});

it('has no revision for an agenda the read did not return or an unknown command', () => {
  expect(commandRevisionFrom({ agendas: { assets: { revision: 1 } } }, { _tag: 'MeterUpdate' })).toBeUndefined();
  expect(commandRevisionFrom({ agendas: {} }, { _tag: 'Unknown' })).toBeUndefined();
  expect(commandRevisionFrom(undefined, { _tag: 'AssetUpdate' })).toBeUndefined();
});
