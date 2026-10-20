// @effect-diagnostics strictEffectProvide:off -- Test-owned scripted issuer client; expires: 2026-12-31.
import { PgClient } from '@effect/sql-pg';
import { Effect, Exit, Layer, Option, Predicate, Redacted, Schema } from 'effect';
import type { Effect as EffectType } from 'effect';
import { expect, it } from 'effect-rstest';
import { Reactivity } from 'effect/reactivity';
import { ConnectionError, SqlError } from 'effect/sql/SqlError';

import { makeGatewayScopeGrantRegistrar } from '../../src/auth/gateway-scope-grant.ts';
import type { GatewayScopeGrantInput } from '../../src/auth/gateway-scope-grant.ts';
import { scriptedPgClientLayer } from '../../src/testing/scripted-pg-client.ts';
import { testSqlConnection } from '../support/sql-connection.ts';

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

interface RecordedStatement {
  readonly params: readonly unknown[];
  readonly sql: string;
}

const assertionValue = 'eyJhbGciOiJFUzI1NiJ9.eyJzdWIiOiJwIn0.c2lnbmF0dXJl';
const grant = (audience: string, legalEntityId?: string): GatewayScopeGrantInput => {
  const tenantScopedGrant: GatewayScopeGrantInput = {
    assertion: Redacted.make(assertionValue),
    audience,
    expiresAtEpochSeconds: 1_800_000_300,
    jti: '50000000-0000-4000-8000-000000000001',
    principalId: '10000000-0000-4000-8000-000000000001',
    tenantId: '20000000-0000-4000-8000-000000000001',
  };
  return legalEntityId === undefined ? tenantScopedGrant : { ...tenantScopedGrant, legalEntityId };
};

/** Registers one grant through a scripted issuer client whose statements `execute` observes. */
const registerWith = (
  input: GatewayScopeGrantInput,
  execute: (sql: string, params: readonly unknown[]) => EffectType.Effect<readonly object[], SqlError> = () =>
    Effect.succeed([]),
) =>
  Effect.gen(function* registerWithScriptedIssuer() {
    const client = yield* PgClient.PgClient;
    const result = yield* Effect.exit(makeGatewayScopeGrantRegistrar(client).register(input));
    return { result };
  }).pipe(
    Effect.provide(
      scriptedPgClientLayer(Effect.succeed(testSqlConnection(execute))).pipe(Layer.provideMerge(Reactivity.layer)),
    ),
  );

it.effect('audiences without a gateway-grant identity register nothing', () =>
  Effect.gen(function* catalogGrantIsNoOp() {
    const statements: RecordedStatement[] = [];
    const { result } = yield* registerWith(grant('catalog'), (sql, params) => {
      statements.push({ params, sql });
      return Effect.succeed([]);
    });
    expect(result._tag).toBe('Success');
    expect(statements).toEqual([]);
  }),
);

it.effect('a party-registry grant runs one register call with the exact token and scope', () =>
  Effect.gen(function* partyRegistryGrantRegisters() {
    const statements: RecordedStatement[] = [];
    const legalEntityId = '30000000-0000-4000-8000-000000000001';
    const record = (sql: string, params: readonly unknown[]) => {
      statements.push({ params, sql });
      return Effect.succeed([]);
    };
    expect((yield* registerWith(grant('party-registry'), record)).result._tag).toBe('Success');
    expect((yield* registerWith(grant('party-registry', legalEntityId), record)).result._tag).toBe('Success');
    const registerSql =
      'select trust.register_gateway_scope_grant($1, $2, $3::uuid, $4::uuid, $5::uuid, $6::uuid, to_timestamp($7))';
    const fixed = [
      assertionValue,
      'party-registry',
      '50000000-0000-4000-8000-000000000001',
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000001',
    ];
    expect(statements).toEqual([
      { params: [...fixed, null, 1_800_000_300], sql: registerSql },
      { params: [...fixed, legalEntityId, 1_800_000_300], sql: registerSql },
    ]);
  }),
);

it.effect('database failures surface as an unavailable grant with the cause kept off the wire', () =>
  Effect.gen(function* registrationFailureIsMapped() {
    const cause = new SqlError({ reason: new ConnectionError({ cause: 'issuer outage' }) });
    const { result } = yield* registerWith(grant('party-registry'), () => Effect.fail(cause));
    expect(Exit.isFailure(result)).toBe(true);
    const error = Option.getOrUndefined(Exit.findErrorOption(result));
    expect(Predicate.isTagged(error, 'GatewayScopeGrantUnavailableError')).toBe(true);
    expect(yield* encodeJson(error)).not.toContain('issuer outage');
    expect(Object.keys(error ?? {})).not.toContain('cause');
  }),
);
