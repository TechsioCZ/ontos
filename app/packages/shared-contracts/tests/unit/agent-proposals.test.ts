import { Result, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { AGENT_PAGE_SIZE, AgentActivityRequestSchema, AgentPageCursorSchema } from '../../src/agent-proposals.ts';

const decodeCursor = Schema.decodeUnknownResult(AgentPageCursorSchema);
const decodeActivity = Schema.decodeUnknownResult(AgentActivityRequestSchema);

it('accepts only real canonical UTC millisecond positions for stable SQL and wire ordering', () => {
  const id = 'proposal:example';
  expect(Result.isSuccess(decodeCursor({ at: '2026-10-23T10:00:00.000Z', id }))).toBe(true);
  for (const at of [
    '2026-10-23T10:00:00Z',
    '2026-10-23T12:00:00.000+02:00',
    'not-a-date',
    '2026-99-99T10:00:00.000Z',
  ]) {
    expect(Result.isFailure(decodeCursor({ at, id }))).toBe(true);
  }
});

it('never accepts an activity page larger than the bounded source lookahead', () => {
  expect(Result.isSuccess(decodeActivity({ limit: AGENT_PAGE_SIZE }))).toBe(true);
  expect(Result.isFailure(decodeActivity({ limit: AGENT_PAGE_SIZE + 1 }))).toBe(true);
  expect(Result.isFailure(decodeActivity({ limit: 0 }))).toBe(true);
});
