import { expect, it } from 'effect-rstest';

import { batchKeyFromSearch, itemKeyFromSearch } from '../../../src/routes/agent-platform/batch-link.ts';

it('reads the batch of an MCP review link', () => {
  expect(batchKeyFromSearch('?davka=5A5A5555-5555-4555-8555-555555555555')).toBe(
    'core:5a5a5555-5555-4555-8555-555555555555',
  );
  expect(batchKeyFromSearch('?davka=nic')).toBeUndefined();
  expect(batchKeyFromSearch('')).toBeUndefined();
});

it('selects the exact proposal from activity links without accepting selector text', () => {
  const uuid = '5a5a5555-5555-4555-8555-555555555555';
  expect(batchKeyFromSearch(`?davka=core%3A${uuid}`)).toBe(`core:${uuid}`);
  expect(itemKeyFromSearch(`?navrh=core%3A${uuid}`)).toBe(`core:${uuid}`);
  expect(itemKeyFromSearch('?navrh=%22%5D%20article')).toBeUndefined();
  expect(itemKeyFromSearch('')).toBeUndefined();
});
