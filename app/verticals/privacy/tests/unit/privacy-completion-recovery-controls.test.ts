import { expect, rs, test } from 'effect-rstest';

import { makeReportResponseLossControl } from '../support/privacy-completion-http.ts';

// Import only the closed synchronous control; do not launch the fixture process.
rs.mock('@effect/platform-node/NodeRuntime', () => ({ runMain: rs.fn() }));

const reportPath = '/privacy/actions/record-owner-execution-outcome';

test('discards exactly one successful real report response and cannot be rearmed', () => {
  const control = makeReportResponseLossControl();
  const close = rs.fn<() => void>();
  expect(control.discard('POST', reportPath, 200, close)).toBe(false);
  expect(control.arm()).toBe(true);
  expect(control.arm()).toBe(false);
  expect(control.discard('POST', reportPath, 200, close)).toBe(true);
  expect(close).toHaveBeenCalledTimes(1);
  expect(control.observe()).toEqual({ armed: false, committedResponseStatus: 200, discardedResponses: 1 });
  expect(control.arm()).toBe(false);
  expect(control.discard('POST', reportPath, 200, close)).toBe(false);
  expect(close).toHaveBeenCalledTimes(1);
});

test.each([
  ['GET', reportPath, 200],
  ['POST', `${reportPath}?unexpected=1`, 200],
  ['POST', '/privacy/actions/dispatch-privacy-measure', 200],
  ['POST', reportPath, 401],
  ['POST', reportPath, 403],
  ['POST', reportPath, 409],
  ['POST', reportPath, 422],
  ['POST', reportPath, 503],
] as const)('keeps the armed fault for the real successful report: %s %s %i', (method, path, status) => {
  const control = makeReportResponseLossControl();
  const close = rs.fn<() => void>();
  expect(control.arm()).toBe(true);
  expect(control.discard(method, path, status, close)).toBe(false);
  expect(close).not.toHaveBeenCalled();
  expect(control.observe()).toEqual({ armed: true, committedResponseStatus: null, discardedResponses: 0 });
  expect(control.discard('POST', reportPath, 200, close)).toBe(true);
  expect(close).toHaveBeenCalledTimes(1);
});
