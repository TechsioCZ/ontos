import { PgClient } from '@effect/sql-pg';
import { Context, Duration, Effect, Layer, Option, Redacted } from 'effect';

import { loadDatabaseConfig } from '../db/config.ts';
import type { DatabaseConfigError } from '../db/config-error.ts';
import { DatabaseConnectionError } from '../db/connection-error.ts';
import { gatewayScopeGrantRoleForAudience, SHELL_GATEWAY_ISSUER_IDENTITY } from '../db/database-identities.ts';
import { configureDatabasePool } from '../db/pool-configuration.ts';
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
const REGISTRAR_MAX_CONNECTIONS = 2;

const unavailableError = (cause?: unknown): GatewayScopeGrantUnavailableError => {
  const error = new GatewayScopeGrantUnavailableError({
    reason: 'Gateway scope grant registration is unavailable',
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
export const makeGatewayScopeGrantRegistrar = (client: PgClient.PgClient): GatewayScopeGrantRegistrarService => ({
  register: Effect.fn('GatewayScopeGrantRegistrar.register')(function* registerGatewayScopeGrantEffect(
    input: GatewayScopeGrantInput,
  ) {
    if (Option.isNone(gatewayScopeGrantRoleForAudience(input.audience))) {
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
  DatabaseConfigError | DatabaseConnectionError
> = Layer.effect(
  GatewayScopeGrantRegistrar,
  Effect.gen(function* makeGatewayScopeGrantRegistrarService() {
    const configuration = yield* loadDatabaseConfig({ identity: SHELL_GATEWAY_ISSUER_IDENTITY });
    const poolConfiguration = yield* configureDatabasePool(Redacted.make(configuration.connectionString));
    const services = yield* Layer.build(
      PgClient.layer({ ...poolConfiguration, maxConnections: REGISTRAR_MAX_CONNECTIONS }),
    ).pipe(Effect.mapError(connectionFailure));
    return makeGatewayScopeGrantRegistrar(Context.get(services, PgClient.PgClient));
  }),
);
