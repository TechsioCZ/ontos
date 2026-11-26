import { NodeCrypto } from '@effect/platform-node';
import { Effect, Exit, Layer, Match, Redacted, Ref } from 'effect';
import { HttpClient, HttpClientResponse } from 'effect/http';
import { expect, it } from 'effect-rstest';

import { enrolLocalIntegrityPrincipal } from '../enrol-local-integrity-principal.mts';
import { LOCAL_DEVELOPMENT_CONTEXT } from '../initialize-local-development.mts';

/*
 * The command signs in to a running local Shell as the local owner and runs Core's own enrollment Action through the
 * Shell's HTTP endpoint. The Shell here is a scripted stand-in: this proves what the command sends and refuses, not
 * what the Shell decides.
 */

const origin = 'http://localhost:3020';
const input = { baseUrl: origin, email: 'demo@test.com', password: Redacted.make('local-password') };

const enrollment = {
  _tag: 'ENROLLED',
  added: [],
  bindingIncarnation: '75000000-0000-4000-8000-000000000001',
  held: [],
  moduleKey: 'core.media',
  pending: [],
  principalId: '75000000-0000-4000-8000-000000000002',
  principalStatus: 'active',
  workloadKey: 'core.media.integrity',
};

interface Sent {
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly url: string;
}

const shellFor = (tenantId: string, sent: Ref.Ref<readonly Sent[]>) =>
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.gen(function* answer() {
        const body = Match.value(request.body).pipe(
          Match.tag('Uint8Array', (encoded) => new TextDecoder().decode(encoded.body)),
          Match.orElse(() => ''),
        );
        yield* Ref.update(sent, (all) => [...all, { body, headers: { ...request.headers }, url: url.toString() }]);
        const signIn = url.pathname.endsWith('/auth/sign-in');
        return HttpClientResponse.fromWeb(
          request,
          Response.json(
            signIn
              ? {
                  identity: {
                    displayName: 'Local User',
                    email: input.email,
                    principalId: LOCAL_DEVELOPMENT_CONTEXT.principalId,
                    tenantId,
                  },
                }
              : enrollment,
            signIn ? { headers: { 'set-cookie': 'session=local-session; Path=/; HttpOnly' } } : {},
          ),
        );
      }),
    ),
  );

it.layer(NodeCrypto.layer)('local integrity principal enrollment', (suite) => {
  suite.effect('signs in, then enrolls the integrity workload with that session, its origin and a fresh key', () =>
    Effect.gen(function* enrolls() {
      const sent = yield* Ref.make<readonly Sent[]>([]);
      const run = enrolLocalIntegrityPrincipal(input).pipe(
        Effect.provide(shellFor(LOCAL_DEVELOPMENT_CONTEXT.tenantId, sent)),
      );
      expect(yield* run).toHaveProperty('principalId', enrollment.principalId);
      yield* run;
      const [signIn, enrol, , again] = yield* Ref.get(sent);
      expect(signIn?.url).toBe(`${origin}/shell-super-app-api/auth/sign-in`);
      expect(enrol?.url).toBe(`${origin}/shell-super-app-api/auth/identity/system-workload-enrollments`);
      expect(enrol?.headers).toMatchObject({ cookie: 'session=local-session', origin });
      expect(enrol?.body).toContain('"moduleKey":"core.media"');
      expect(enrol?.body).toContain('"workloadKey":"core.media.integrity"');
      expect(enrol?.body).toContain('"_tag":"ENROLL"');
      // A rerun is a new request: the saved reply of an earlier one must not stand for an enrollment ended since.
      expect(again?.headers['idempotency-key']).not.toBe(enrol?.headers['idempotency-key']);
    }),
  );

  suite.effect('enrolls nothing when the session belongs to another tenant', () =>
    Effect.gen(function* otherTenant() {
      const sent = yield* Ref.make<readonly Sent[]>([]);
      const exit = yield* Effect.exit(
        enrolLocalIntegrityPrincipal(input).pipe(
          Effect.provide(shellFor('75000000-0000-4000-8000-000000000009', sent)),
        ),
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect((yield* Ref.get(sent)).map(({ url }) => url)).toEqual([`${origin}/shell-super-app-api/auth/sign-in`]);
    }),
  );
});
