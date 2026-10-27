import { Schema } from 'effect';
import { UrlParams } from 'effect/http';
import { expect, it } from 'effect-rstest';

import {
  AgentReviewSearchQuerySchema,
  batchKeyFromSearch,
  itemKeyFromSearch,
} from '../../../src/routes/agent-platform/batch-link.ts';

const routeSearch = (query: string) =>
  Schema.decodeSync(AgentReviewSearchQuerySchema)(UrlParams.fromInput(new URLSearchParams(query)));
const batchKeyFromQuery = (query: string) => batchKeyFromSearch(routeSearch(query));
const itemKeyFromQuery = (query: string) => itemKeyFromSearch(routeSearch(query));

it('reads the batch of an MCP review link', () => {
  expect(batchKeyFromQuery('?davka=5A5A5555-5555-4555-8555-555555555555')).toBe(
    'core:5a5a5555-5555-4555-8555-555555555555',
  );
  expect(batchKeyFromQuery('?davka=nic')).toBeUndefined();
  expect(batchKeyFromQuery('')).toBeUndefined();
});

it('selects the exact proposal from activity links without accepting selector text', () => {
  const uuid = '5a5a5555-5555-4555-8555-555555555555';
  expect(batchKeyFromQuery(`?davka=core%3A${uuid}`)).toBe(`core:${uuid}`);
  expect(itemKeyFromQuery(`?navrh=core%3A${uuid}`)).toBe(`core:${uuid}`);
  expect(itemKeyFromQuery('?navrh=%22%5D%20article')).toBeUndefined();
  expect(itemKeyFromQuery('')).toBeUndefined();
});

it('targets exact items in module-native queues without lowercasing their ids', () => {
  const query = new URLSearchParams({
    davka: 'legacy:fixture-notes:Batch:One',
    navrh: 'legacy:fixture-notes:Change:Two',
  }).toString();
  expect(batchKeyFromQuery(query)).toBe('legacy:fixture-notes:Batch:One');
  expect(itemKeyFromQuery(query)).toBe('legacy:fixture-notes:Change:Two');
  expect(itemKeyFromQuery('?navrh=legacy:fixture-notes:')).toBeUndefined();
});
