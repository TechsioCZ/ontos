import { Effect, Redacted } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { afterAll, beforeAll, beforeEach, expect, it, rstest } from 'effect-rstest';

import { setInvitationPassword } from '../../src/routes/people/invitation-client.ts';

const originalFetch = globalThis.fetch;
const fetch = rstest.fn<typeof globalThis.fetch>();
beforeAll(() => {
  globalThis.fetch = fetch;
});
afterAll(() => {
  globalThis.fetch = originalFetch;
});
beforeEach(() => {
  fetch.mockReset();
});

it.layer(FetchHttpClient.layer)((test) => {
  test.effect(
    'sets the password only through the native invitation endpoint and does not sign in or activate membership',
    () =>
      Effect.gen(function* verifyPasswordRequest() {
        fetch.mockResolvedValue(Response.json({ status: true }));
        expect(yield* setInvitationPassword('a'.repeat(43), Redacted.make('my-own-password'))).toEqual({
          status: 'ok',
        });
        expect(fetch).toHaveBeenCalledTimes(1);
        const input = fetch.mock.calls[0]?.[0];
        if (input === undefined) {
          throw new Error('Missing invitation request');
        }
        expect(new URL(new Request(input).url).pathname).toBe('/shell-super-app-api/invitation/set-password');
      }),
  );

  test.effect('does not treat an expired or malformed invitation response as password success and never retries', () =>
    Effect.gen(function* rejectExpiredInvitation() {
      fetch.mockResolvedValue(new Response(null, { status: 400 }));
      expect((yield* setInvitationPassword('a'.repeat(43), Redacted.make('my-own-password'))).status).toBe('failed');
      expect(fetch).toHaveBeenCalledTimes(1);
    }),
  );
});
