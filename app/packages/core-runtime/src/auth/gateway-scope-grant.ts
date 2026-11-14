import { PgClient } from '@effect/sql-pg';
import { Context, Duration, Effect, Layer, Option, Redacted } from 'effect';

import { loadDatabaseConfig } from '../db/config.ts';
import type { DatabaseConfigError } from '../db/config-error.ts';
import { DatabaseConnectionError } from '../db/connection-error.ts';
import { findPostgresFailure } from '../database/postgres-failure.ts';
import {
  DatabaseIdentityEnrollmentContext,
  gatewayScopeGrantRoleForAudience,
  SHELL_GATEWAY_ISSUER_IDENTITY,
} from '../db/database-identities.ts';
import type { DatabaseIdentityEnrollment } from '../db/database-identities.ts';
import { configureDatabasePool } from '../db/pool-configuration.ts';
import { verifySessionRoleOnFirstUse } from '../db/session-identity.ts';
import { GatewayScopeGrantUnavailableError } from './gateway-scope-grant-unavailable-error.ts';

export { GatewayScopeGrantUnavailableError } from './gateway-scope-grant-unavailable-error.ts';

/** One issued gateway assertion, registered so its audience's database login can establish its scope. */
export interface GatewayScopeGrantInput {
  readonly assertion: Redacted.Redacted;
  readonly audience: string;
  readonly expiresAtEpochSeconds: number;
  readonly jti: string;
  readonly legalEntityId?: string;
  readonly principalId: string;
  readonly tenantId: string;
}

export interface GatewayScopeGrantRegistrarService {
  readonly register: (input: GatewayScopeGrantInput) => Effect.Effect<void, GatewayScopeGrantUnavailableError>;
}

export class GatewayScopeGrantRegistrar extends Context.Service<
  GatewayScopeGrantRegistrar,
  GatewayScopeGrantRegistrarService
>()('@app/core-runtime/auth/gateway-scope-grant/GatewayScopeGrantRegistrar') {}

const REGISTRATION_TIMEOUT = Duration.seconds(5);
// One search starts every owner at once, and each owner call registers its own single-use assertion. Four connections
// halve the queueing for a full fan-out while adding at most two connections per Shell process to the database budget.
const REGISTRAR_MAX_CONNECTIONS = 4;

const UNAVAILABLE_REASON = 'Gateway scope grant registration is unavailable';

const unavailableError = (cause?: unknown): GatewayScopeGrantUnavailableError => {
  // The SQLSTATE is the one sanitized fact that explains a refusal (an audience the trust catalog does not enroll,
  // an inactive principal, a missing grant), so it is classified here at the persistence edge.
  const error = Option.match(findPostgresFailure(cause), {
    onNone: () => new GatewayScopeGrantUnavailableError({ reason: UNAVAILABLE_REASON }),
    onSome: ({ code }) => new GatewayScopeGrantUnavailableError({ reason: UNAVAILABLE_REASON, sqlState: code }),
  });
  return cause === undefined
    ? error
    : Object.defineProperty(error, 'cause', {
        configurable: false,
        enumerable: false,
        value: cause,
        writable: false,
      });
};

/**
 * Registers grants through an issuer connection. Audiences without a gateway-grant database identity
 * are a no-op; enrolled audiences run one autocommit call, so the grant is durable before the token
 * leaves the issuer.
 */
export const makeGatewayScopeGrantRegistrar = (
  client: PgClient.PgClient,
  enrollment: DatabaseIdentityEnrollment,
): GatewayScopeGrantRegistrarService => ({
  register: Effect.fn('GatewayScopeGrantRegistrar.register')(function* registerGatewayScopeGrantEffect(
    input: GatewayScopeGrantInput,
  ) {
    if (Option.isNone(gatewayScopeGrantRoleForAudience(enrollment, input.audience))) {
      return;
    }
    yield* client`select trust.register_gateway_scope_grant(${Redacted.value(input.assertion)}, ${input.audience}, ${input.jti}::uuid, ${input.principalId}::uuid, ${input.tenantId}::uuid, ${input.legalEntityId ?? null}::uuid, to_timestamp(${input.expiresAtEpochSeconds}))`.pipe(
      Effect.mapError(unavailableError),
      Effect.timeoutOrElse({
        duration: REGISTRATION_TIMEOUT,
        orElse: () => Effect.fail(unavailableError()),
      }),
    );
  }),
});

const connectionFailure = (cause: unknown): DatabaseConnectionError =>
  new DatabaseConnectionError({
    cause,
    reason: 'Unable to initialize the gateway scope grant issuer connection pool',
  });

/**
 * The issuer's own small pool on the `shell_gateway_issuer` login. It never reads `DatabaseConfig` or
 * `CoreDatabase`, so it cannot collide with the host's shared-runtime database.
 */
export const GatewayScopeGrantRegistrarLive: Layer.Layer<
  GatewayScopeGrantRegistrar,
  DatabaseConfigError | DatabaseConnectionError,
  DatabaseIdentityEnrollmentContext
> = Layer.effect(
  GatewayScopeGrantRegistrar,
  Effect.gen(function* makeGatewayScopeGrantRegistrarService() {
    const enrollment = yield* DatabaseIdentityEnrollmentContext;
    const configuration = yield* loadDatabaseConfig({ identity: SHELL_GATEWAY_ISSUER_IDENTITY });
    const poolConfiguration = yield* configureDatabasePool(
      Redacted.make(configuration.connectionString),
      undefined,
      REGISTRAR_MAX_CONNECTIONS,
    );
    const services = yield* Layer.build(PgClient.layer(poolConfiguration)).pipe(Effect.mapError(connectionFailure));
    const client = verifySessionRoleOnFirstUse(Context.get(services, PgClient.PgClient), configuration.expectedRole);
    return makeGatewayScopeGrantRegistrar(client, enrollment);
  }),
);
