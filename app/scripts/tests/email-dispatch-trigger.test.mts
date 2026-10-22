import { afterEach, expect, it, rstest } from '@rstest/core';
import { startEmailDispatchTrigger } from '../email-dispatch-trigger.mts';

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
  rstest.restoreAllMocks();
  rstest.unstubAllGlobals();
  rstest.useRealTimers();
});
const configuration = {
  ONTOS_EMAIL_DISPATCH_URL: 'https://shell.stage.test/shell-super-app-api/email/dispatch',
  ONTOS_EMAIL_DISPATCH_SECRET: 'fixture-secret',
};

it('does nothing when dispatch is not configured; rejects partial or unsafe configuration', () => {
  const fetch = rstest.fn();
  rstest.stubGlobal('fetch', fetch);
  stop = startEmailDispatchTrigger({});
  expect(fetch).not.toHaveBeenCalled();
  for (const environment of [
    { ONTOS_EMAIL_DISPATCH_SECRET: 'fixture-secret' },
    { ONTOS_EMAIL_DISPATCH_URL: configuration.ONTOS_EMAIL_DISPATCH_URL },
    { ...configuration, ONTOS_EMAIL_DISPATCH_URL: 'http://shell.stage.test/shell-super-app-api/email/dispatch' },
    { ...configuration, ONTOS_EMAIL_DISPATCH_URL: 'not-a-url' },
    { ...configuration, ONTOS_EMAIL_DISPATCH_URL: 'https://shell.stage.test/other' },
  ])
    expect(() => startEmailDispatchTrigger(environment)).toThrow('must be configured together');
});

it('posts a bearer-authenticated tick every 10 seconds, never follows redirects, and stops cleanly', async () => {
  rstest.useFakeTimers();
  const fetch = rstest.fn(async () => new Response(null, { status: 200 }));
  rstest.stubGlobal('fetch', fetch);
  stop = startEmailDispatchTrigger(configuration);
  await rstest.advanceTimersByTimeAsync(0);
  expect(fetch).toHaveBeenCalledTimes(1);
  const request = fetch.mock.calls[0] as unknown as [URL, RequestInit];
  expect(request[0].href).toBe(configuration.ONTOS_EMAIL_DISPATCH_URL);
  expect(request[1].method).toBe('POST');
  expect(request[1].redirect).toBe('error');
  expect(request[1].headers).toEqual({ authorization: 'Bearer fixture-secret' });
  await rstest.advanceTimersByTimeAsync(10_000);
  expect(fetch).toHaveBeenCalledTimes(2);
  stop();
  await rstest.advanceTimersByTimeAsync(20_000);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('does not overlap slow dispatch requests and aborts its owned request on stop', async () => {
  rstest.useFakeTimers();
  let signal: AbortSignal | undefined;
  const fetch = rstest.fn((_url: URL, request: RequestInit) => {
    signal = request.signal ?? undefined;
    return new Promise<Response>(() => {});
  });
  rstest.stubGlobal('fetch', fetch);
  stop = startEmailDispatchTrigger(configuration);
  await rstest.advanceTimersByTimeAsync(20_000);
  expect(fetch).toHaveBeenCalledTimes(1);
  stop();
  expect(signal?.aborted).toBe(true);
});
