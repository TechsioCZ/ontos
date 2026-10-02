import { GatewayAssertionReplayError } from '@app/core-runtime';
import { defineRelations } from 'drizzle-orm';
import { Effect, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import {
  makeTestDatabaseFromClient,
  testDatabaseClients,
} from '../../../../packages/core-runtime/tests/support/database.ts';
import { makeGatewayAssertionRedemption } from '../../src/auth/gateway-assertion-redemption-runtime.ts';
import { gatewayAssertionRedemptions } from '../../src/database/schema.ts';

const issuer = 'https://pricing-gateway-postgres.ontos.test';
const audience = 'pricing-gateway-postgres';
const jti = '79700000-0000-4000-8000-000000000001';
const relations = defineRelations({ gatewayAssertionRedemptions });
const DatabaseEpochRowSchema = Schema.Struct({ nowEpochSeconds: Schema.FiniteFromString });

interface GrantRow {
  readonly delete_allowed: boolean;
  readonly insert_allowed: boolean;
  readonly rls_enabled: boolean;
  readonly select_allowed: boolean;
  readonly update_allowed: boolean;
}

it.live('durably rejects replay through the exact global least-privilege table', () =>
  Effect.scoped(
    Effect.gen(function* gatewayAssertionPostgresProof() {
      const { admin: adminClient, runtime: runtimeClient } = yield* testDatabaseClients;
      const executor = yield* makeTestDatabaseFromClient(runtimeClient, relations);
      const redemption = makeGatewayAssertionRedemption(executor);
      const cleanup = adminClient.unsafe('delete from pricing.gateway_assertion_redemptions where issuer = $1', [
        issuer,
      ]);
      yield* cleanup;
      yield* Effect.addFinalizer(() => cleanup.pipe(Effect.orDie));

      const [databaseEpochRow] = yield* adminClient.unsafe(
        `select floor(extract(epoch from clock_timestamp()))::text as "nowEpochSeconds"`,
      );
      const { nowEpochSeconds } = yield* Schema.decodeUnknownEffect(DatabaseEpochRowSchema)(databaseEpochRow);
      const assertion = {
        audience,
        expiresAtEpochSeconds: nowEpochSeconds + 300,
        issuer,
        jti,
      };
      yield* redemption.consume(assertion);
      const replay = yield* redemption.consume(assertion).pipe(Effect.flip);
      expect(Schema.is(GatewayAssertionReplayError)(replay)).toBe(true);

      yield* redemption.consume({ ...assertion, audience: `${audience}-other` });

      const [grant] = yield* adminClient.unsafe<GrantRow>(
        `select
           has_table_privilege('ontos_runtime', 'pricing.gateway_assertion_redemptions', 'SELECT') as select_allowed,
           has_table_privilege('ontos_runtime', 'pricing.gateway_assertion_redemptions', 'INSERT') as insert_allowed,
           has_table_privilege('ontos_runtime', 'pricing.gateway_assertion_redemptions', 'UPDATE') as update_allowed,
           has_table_privilege('ontos_runtime', 'pricing.gateway_assertion_redemptions', 'DELETE') as delete_allowed,
           relation.relrowsecurity as rls_enabled
         from pg_catalog.pg_class as relation
         join pg_catalog.pg_namespace as namespace on namespace.oid = relation.relnamespace
        where namespace.nspname = 'pricing' and relation.relname = 'gateway_assertion_redemptions'`,
      );
      expect(grant).toEqual({
        delete_allowed: true,
        insert_allowed: true,
        rls_enabled: false,
        select_allowed: true,
        update_allowed: false,
      });
    }),
  ),
);
