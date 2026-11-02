import { expect, it } from 'effect-rstest';
import { searchStageOwners, searchStageTopics } from '../demo/search-stage-state.mts';

it('inspects all search owners, including CRM and the system people owner', () => {
  expect(new Set(searchStageOwners).size).toBe(12);
  expect(searchStageOwners).toContain('demo.crm');
  expect(searchStageOwners).toContain('core.identity');
});

it('uses exact search topics and excludes the invoice source worker and other business events', () => {
  expect(searchStageTopics).toContain('finance.billing.search-changed.v1');
  expect(searchStageTopics).toContain('demo.merchandise.search-refresh-requested.v1');
  expect(searchStageTopics).toContain('core.identity.people-search-rebuild-requested.v1');
  expect(searchStageTopics).not.toContain('demo.sales-pipeline.opportunity-won.v1');
  expect(searchStageTopics.every((topic) => topic.endsWith('.v1'))).toBe(true);
});
