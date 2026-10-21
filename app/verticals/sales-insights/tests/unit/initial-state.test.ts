import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import { connectionAllowsWrite, emptySalesInsightsState } from '../../src/services/initial-state.ts';

it.effect('a company without stored metrics reads as one empty collection', () =>
  Effect.gen(function* emptyState() {
    const state = yield* emptySalesInsightsState(
      '70000000-0000-4000-8000-000000000020',
      '71000000-0000-4000-8000-000000000020',
    );
    expect(state.metrics).toEqual([]);
    expect(state.collection.ref.moduleId).toBe('demo.sales-insights');
  }),
);

it('a read-only MCP connection cannot write', () => {
  expect(connectionAllowsWrite({ authMethod: 'session' }, 'demo.sales-insights')).toBe(true);
  expect(connectionAllowsWrite({ authMethod: 'oauth_connection' }, 'demo.sales-insights')).toBe(false);
});
