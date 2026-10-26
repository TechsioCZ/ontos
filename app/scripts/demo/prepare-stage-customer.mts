#!/usr/bin/env node
import { randomUUID } from 'node:crypto';

import { DatabaseConfig, parseDatabaseConfig } from '@app/core-runtime';
import { NodeRuntime, NodeServices } from '@effect/platform-node';
import { eq } from 'drizzle-orm';
import { Config, Console, Effect, Layer, Redacted, Schedule, Schema } from 'effect';
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/unstable/http';

import {
  CommercePortalAuthDatabase,
  CommercePortalAuthDatabaseFromDatabaseConfigLive,
} from '../../verticals/commerce-customer-context/src/portal-auth/persistence/portal-auth-database.ts';
import { user } from '../../verticals/commerce-customer-context/src/portal-auth/persistence/portal-auth-tables.ts';
import { DEFAULT_PASSWORD } from '../ops/stage-demo-verify.mjs';

export const STAGE_CUSTOMER_EMAIL = 'delivery-checkout-20261026@ontos.demo';
const STOREFRONT_ORIGIN = 'https://ontos-stage-akros.bleeding.dev';

export class StageCustomerFixtureError extends Schema.TaggedError<StageCustomerFixtureError>()(
  'StageCustomerFixtureError',
  { step: Schema.String },
) {}

const failed = (step: string) => new StageCustomerFixtureError({ step });
const RegistrationResult = Schema.Struct({ outcome: Schema.Literal('ENROLLMENT_STARTED') });

/** Prepare one operator-owned demo fixture, never a public verification shortcut or an SMTP claim. */
export const prepareStageCustomer = Effect.fn('StageDemo.prepareCustomer')(function* prepareStageCustomer() {
  const database = yield* CommercePortalAuthDatabase;
  const findRegistered = Effect.gen(function* findNativeAccount() {
    const rows = yield* database.executor
      .select({
        emailVerified: user.emailVerified,
        enrollmentOwnerInvocationId: user.enrollmentOwnerInvocationId,
        id: user.id,
      })
      .from(user)
      .where(eq(user.email, STAGE_CUSTOMER_EMAIL))
      .limit(2)
      .pipe(Effect.mapError(() => failed('native_account_lookup_failed')));
    if (rows.length === 0) {
      return null;
    }
    const [account] = rows;
    if (rows.length !== 1 || account?.enrollmentOwnerInvocationId === null || account === undefined) {
      return yield* failed('native_enrollment_identity_required');
    }
    return account;
  });
  // A prior run may have created the native account before its operator update failed.
  const existing = yield* findRegistered;
  if (existing === null) {
    const client = yield* HttpClient.HttpClient;
    const registration = yield* client
      .execute(
        HttpClientRequest.post(`${STOREFRONT_ORIGIN}/api/ontos/account`).pipe(
          HttpClientRequest.setHeaders({ origin: STOREFRONT_ORIGIN }),
          HttpClientRequest.bodyJsonUnsafe({
            email: STAGE_CUSTOMER_EMAIL,
            firstName: 'Ověření',
            lastName: 'Ukázky',
            operation: 'register',
            password: Redacted.value(DEFAULT_PASSWORD),
            passwordConfirmation: Redacted.value(DEFAULT_PASSWORD),
            requestId: randomUUID(),
            termsAccepted: true,
          }),
        ),
      )
      .pipe(Effect.mapError(() => failed('native_enrollment_transport_failed')));
    if (registration.status < 200 || registration.status >= 300) {
      return yield* failed('native_enrollment_start_refused');
    }
    yield* HttpClientResponse.schemaBodyJson(RegistrationResult)(registration).pipe(
      Effect.mapError(() => failed('native_enrollment_response_invalid')),
    );
  }
  const registered =
    existing ??
    (yield* findRegistered.pipe(
      Effect.flatMap((account) => (account === null ? failed('native_account_pending') : Effect.succeed(account))),
      Effect.retry({
        schedule: Schedule.spaced('1 second'),
        times: 30,
        while: (cause) => Schema.is(StageCustomerFixtureError)(cause) && cause.step === 'native_account_pending',
      }),
    ));
  if (!registered.emailVerified) {
    // The native owner adapter updates only this operator-owned fixture. No token, session or grant is invented.
    const adapter = database.adapter({});
    yield* Effect.tryPromise({
      catch: () => failed('native_fixture_update_failed'),
      try: async () =>
        await adapter.update({
          model: 'user',
          update: { emailVerified: true },
          where: [{ field: 'id', value: registered.id }],
        }),
    });
  }
  const [prepared] = yield* database.executor
    .select({ emailVerified: user.emailVerified })
    .from(user)
    .where(eq(user.id, registered.id))
    .pipe(Effect.mapError(() => failed('native_fixture_confirmation_failed')));
  if (prepared === undefined || !prepared.emailVerified) {
    return yield* failed('native_fixture_update_unconfirmed');
  }
  return yield* Console.log(
    'Native demo customer prepared. Email status is operator-seeded, not SMTP verification proof.',
  );
});

if (import.meta.main) {
  const operatorDatabase = Layer.unwrap(
    Effect.gen(function* prepareStageCustomerOperator() {
      if ((yield* Config.String('ULTRAMODERN_DEPLOYMENT_ENVIRONMENT')) !== 'stage') {
        return yield* failed('stage_environment_required');
      }
      const connectionString = yield* Config.Redacted('COMMERCE_PORTAL_AUTH_DATABASE_ADMIN_URL').pipe(
        Effect.mapError(() => failed('operator_database_configuration_missing')),
      );
      const configuration = yield* parseDatabaseConfig({ DATABASE_URL: Redacted.value(connectionString) }).pipe(
        Effect.mapError(() => failed('operator_database_configuration_invalid')),
      );
      return CommercePortalAuthDatabaseFromDatabaseConfigLive.pipe(
        Layer.provide(Layer.succeed(DatabaseConfig, configuration)),
      );
    }),
  );
  NodeRuntime.runMain(
    prepareStageCustomer().pipe(
      Effect.provide(operatorDatabase),
      Effect.scoped,
      Effect.provide(FetchHttpClient.layer),
      Effect.provide(NodeServices.layer),
      Effect.mapError((cause) =>
        Schema.is(StageCustomerFixtureError)(cause) ? cause : failed('customer_fixture_preparation_failed'),
      ),
      Effect.tapError((cause) => Console.error(`Native demo customer preparation failed at ${cause.step}.`)),
    ),
    { disableErrorReporting: true },
  );
}
