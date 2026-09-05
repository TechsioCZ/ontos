// expect-count: 2
import { test } from 'node:test';

interface ActionCommitOpen {
  readonly _tag: 'ActionCommitOpen';
  readonly invocationId: string;
}

type SettledRows = ReadonlyArray<{ readonly _tag: 'settled' }>;

test('commit outcome', () => {
  const open: ActionCommitOpen = { _tag: 'ActionCommitOpen', invocationId: 'inv-1' };
  const rows: SettledRows = [{ _tag: 'settled' }];
  if (open._tag !== 'ActionCommitOpen' || rows.length !== 1) throw new Error('unreachable');
});
