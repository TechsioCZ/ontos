import { pinDocumentNavigationModules } from '@app/shared-contracts';
import { afterEach, expect, it } from 'effect-rstest';
import { isTagReadForbidden, tagsFailureStatus, tagsReadable } from '../../src/tags/tag-access.ts';

/** A stand-in browser document carrying the Shell's navigation hint for these module ids. */
const pinNavigation = (moduleIds: readonly string[]) => {
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {}, writable: true });
  pinDocumentNavigationModules(moduleIds, globalThis.document);
};

// The node test environment has no document; without one there is no Shell hint again.
afterEach(() => {
  Reflect.deleteProperty(globalThis, 'document');
});

it('reads tags when the Shell left no navigation hint', () => {
  expect(tagsReadable()).toBe(true);
});

it('reads tags only when the navigation hint lists the tagging module', () => {
  pinNavigation(['demo.merchandise', 'demo.tagging']);
  expect(tagsReadable()).toBe(true);
  pinNavigation(['demo.merchandise', 'work.tasks']);
  expect(tagsReadable()).toBe(false);
});

it('treats an owner or gateway refusal as no tags section and anything else as a retryable error', () => {
  expect(tagsFailureStatus({ _tag: 'RecordsForbiddenProblem' })).toBe('forbidden');
  expect(tagsFailureStatus({ _tag: 'GatewayForbiddenProblem' })).toBe('forbidden');
  expect(tagsFailureStatus({ _tag: 'HttpClientError' })).toBe('error');
  expect(isTagReadForbidden({ _tag: 'ApplyCommandActionForbiddenProblem' })).toBe(false);
});
