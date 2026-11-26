import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { NodeServices } from '@effect/platform-node';
import { Console, Crypto, Effect, Layer, Ref, Schema } from 'effect';
import type { Redacted } from 'effect';
import { Cookies, FetchHttpClient, HttpClient, HttpClientRequest } from 'effect/http';
import { HttpApiClient } from 'effect/http-api';

import {
  ChangeSystemWorkloadEnrollmentPayloadSchema,
  ShellAuthenticationApi,
  shellAuthenticationApiContract,
} from '../apps/shell-super-app/shared/browser-api.ts';
import { LOCAL_DEVELOPMENT_CONTEXT, loadRootConfiguration } from './initialize-local-development.mts';

/*
 * The one enrollment `local:initialize` cannot make: the local Tenant's `core.media.integrity` system Principal, which
 * records proven corruption of a Media Asset as `failed`. Only Core's `core.identity.change-system-workload-enrollment`
 * creates such a Principal, and it needs the running Shell, so this runs after the applications are up: it signs in as
 * the local owner and calls the Shell's own endpoint. A rerun answers `ALREADY_ENROLLED`.
 */

export class LocalIntegrityEnrollmentError extends Schema.TaggedError<LocalIntegrityEnrollmentError>()(
  'LocalIntegrityEnrollmentError',
  { reason: Schema.String },
) {}

export interface LocalIntegrityEnrollmentInput {
  /** The local Shell's origin. */
  readonly baseUrl: string;
  readonly email: string;
  readonly password: Redacted.Redacted;
}

export const enrolLocalIntegrityPrincipal = Effect.fn('LocalDevelopment.enrolIntegrityPrincipal')(
  function* enrolIntegrityPrincipal(input: LocalIntegrityEnrollmentInput) {
    const session = yield* Ref.make(Cookies.empty);
    const client = yield* HttpApiClient.make(ShellAuthenticationApi, {
      baseUrl: `${input.baseUrl}${shellAuthenticationApiContract.apiPrefix}`,
      transformClient: (http) =>
        http.pipe(
          HttpClient.mapRequest(HttpClientRequest.setHeader('origin', input.baseUrl)),
          HttpClient.withCookiesRef(session),
        ),
    });
    const { identity } = yield* client.authentication.signIn({
      payload: { email: input.email, password: input.password },
    });
    if (identity.tenantId !== LOCAL_DEVELOPMENT_CONTEXT.tenantId) {
      return yield* new LocalIntegrityEnrollmentError({
        reason: 'The signed-in account does not belong to the local development Tenant; nothing was enrolled',
      });
    }
    const payload = yield* Schema.decodeUnknownEffect(ChangeSystemWorkloadEnrollmentPayloadSchema)({
      _tag: 'ENROLL',
      moduleKey: 'core.media',
      reason: 'Local development records proven Media Asset corruption',
      workloadKey: 'core.media.integrity',
    });
    // A fresh key each run: a saved reply must not stand for an enrollment that was ended since.
    const crypto = yield* Crypto.Crypto;
    return yield* client.identity.changeSystemWorkloadEnrollment({
      headers: { 'idempotency-key': yield* crypto.randomUUIDv4() },
      payload,
    });
  },
);

const enrolWithLocalConfiguration = Effect.gen(function* enrolConfigured() {
  const configuration = yield* loadRootConfiguration();
  return yield* enrolLocalIntegrityPrincipal({
    baseUrl: configuration.authBaseUrl,
    email: configuration.email,
    password: configuration.password,
  });
});

const runLocalIntegrityEnrollment = Effect.matchEffect(enrolWithLocalConfiguration, {
  onFailure: (error) =>
    Console.error(
      'The integrity principal was not enrolled. It needs the applications running with an active Application Composition source and the seeded local owner; see the error below.',
      error,
    ).pipe(Effect.as(false)),
  onSuccess: (enrollment) => Console.log(`core.media.integrity: ${enrollment._tag}`).pipe(Effect.as(true)),
});

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const succeeded = await Effect.runPromise(
    runLocalIntegrityEnrollment.pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          FetchHttpClient.layer,
          // A redirect could carry the password off the loopback origin the configuration accepted.
          Layer.succeed(FetchHttpClient.RequestInit, { redirect: 'error' }),
        ),
      ),
    ),
  );
  if (!succeeded) {
    process.exitCode = 1;
  }
}
