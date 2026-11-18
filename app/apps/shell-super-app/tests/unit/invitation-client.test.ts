// The invitation password client against the Shell's native invitation endpoint, served in process: the client runs
// its real HttpClient and codec; only the network hop is the in-process server, installed through FetchHttpClient.Fetch.
import { inProcessFetch } from '@app/shared-contracts/testing/http-double';
import { HttpRouter, HttpServerRequest, HttpServerResponse } from '@modern-js/bff-effect/effect-edge';
import { Effect, Redacted } from 'effect';
import { FetchHttpClient } from 'effect/http';
import { beforeEach, expect, it } from 'effect-rstest';

import { setInvitationPassword } from '../../src/routes/people/invitation-client.ts';

/** One request the invitation endpoint received: its path and decoded JSON body. */
interface ReceivedInvitation {
  readonly body: unknown;
  readonly pathname: string;
}

const received: ReceivedInvitation[] = [];
const ownPassword = Redacted.make('my-own-password');
const token = 'a'.repeat(43);

/** The native invitation endpoint answering every request with `answer`. */
const invitationEndpoint = (answer: HttpServerResponse.HttpServerResponse) =>
  inProcessFetch(
    HttpRouter.add(
      'POST',
      '/shell-super-app-api/invitation/set-password',
      Effect.gen(function* receiveInvitation() {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const body = yield* request.json;
        received.push({ body, pathname: new URL(request.url, 'http://shell.test').pathname });
        return answer;
      }).pipe(Effect.orDie),
    ),
  );

beforeEach(() => {
  received.length = 0;
});

it.layer(FetchHttpClient.layer)((test) => {
  test.effect(
    'sets the password only through the native invitation endpoint and does not sign in or activate membership',
    () =>
      Effect.gen(function* verifyPasswordRequest() {
        expect(yield* setInvitationPassword(token, ownPassword)).toEqual({
          status: 'ok',
        });
        expect(received).toEqual([
          {
            body: { password: Redacted.value(ownPassword), token },
            pathname: '/shell-super-app-api/invitation/set-password',
          },
        ]);
      }).pipe(Effect.provide(invitationEndpoint(HttpServerResponse.jsonUnsafe({ status: true })))),
  );

  test.effect('does not treat an expired or malformed invitation response as password success and never retries', () =>
    Effect.gen(function* rejectExpiredInvitation() {
      expect((yield* setInvitationPassword(token, ownPassword)).status).toBe('failed');
      expect(received).toHaveLength(1);
    }).pipe(Effect.provide(invitationEndpoint(HttpServerResponse.empty({ status: 400 })))),
  );
});
