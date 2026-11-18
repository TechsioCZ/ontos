// @rstest-environment happy-dom
import { pinDocumentNavigationModules } from '@app/shared-contracts';
import { expect, it } from 'effect-rstest';
import { isTagReadForbidden, tagsFailureStatus, tagsReadable } from '../../src/tags/tag-access.ts';

it('reads tags when the Shell left no navigation hint', () => {
  expect(tagsReadable()).toBe(true);
});

it('reads tags only when the navigation hint lists the tagging module', () => {
  pinDocumentNavigationModules(['demo.merchandise', 'demo.tagging'], document);
  expect(tagsReadable()).toBe(true);
  pinDocumentNavigationModules(['demo.merchandise', 'work.tasks'], document);
  expect(tagsReadable()).toBe(false);
});

it('treats an owner or gateway refusal as no tags section and anything else as a retryable error', () => {
  expect(tagsFailureStatus({ _tag: 'RecordsForbiddenProblem' })).toBe('forbidden');
  expect(tagsFailureStatus({ _tag: 'GatewayForbiddenProblem' })).toBe('forbidden');
  expect(tagsFailureStatus({ _tag: 'HttpClientError' })).toBe('error');
  expect(isTagReadForbidden({ _tag: 'ApplyCommandActionForbiddenProblem' })).toBe(false);
});
