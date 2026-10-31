// @rstest-environment node
import {
  IdentityLifecycleConflictError,
  IdentityPersistenceUnavailableError,
  IdentityTargetInvalidError,
  PersonInvitationIdentityProvider,
} from '@app/core-runtime';
import type { OperationalScope, PersonInvitationIdentityInput } from '@app/core-runtime';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Crypto, Effect, Layer, Option, PlatformError, Result } from 'effect';
import { Base64Url } from 'effect/encoding';
import { Reactivity } from 'effect/reactivity';
import { SqlError, UnknownError } from 'effect/sql/SqlError';
import { expect, it } from 'effect-rstest';

import {
  installOperationalScopeFromTransactionService,
  OperationalScopeTransaction,
} from '../../../../../packages/core-runtime/src/db/scoped-transaction.ts';
import { scriptedPgClientLayer } from '../../../../../packages/core-runtime/src/testing/scripted-pg-client.ts';
import { testSqlConnection } from '../../../../../packages/core-runtime/tests/support/sql-connection.ts';
import { BetterAuthPersonInvitationIdentityProviderLive } from '../../../api/auth/db/person-invitation-provider.ts';
import { authRelations } from '../../../api/auth/db/schema.ts';

const scope: OperationalScope = {
  authBindingId: '00000000-0000-4000-8000-000000000004',
  authContextRef: 'session:invitation-provider',
  authMethod: 'session',
  correlationId: 'invitation-provider',
  legalEntityId: '00000000-0000-4000-8000-000000000002',
  principalId: '00000000-0000-4000-8000-000000000003',
  tenantId: '00000000-0000-4000-8000-000000000001',
};
const input: PersonInvitationIdentityInput = {
  displayName: 'Invited person',
  email: 'person@example.test',
  expiresAt: new Date('2026-10-28T00:00:00Z'),
  providerSubjectId: 'invited-provider-subject',
  verificationId: 'invitation-verification',
};
const cryptoFailure = PlatformError.systemError({
  _tag: 'Unknown',
  method: 'randomBytes',
  module: 'Crypto',
});
const nativeCrypto = Crypto.make({
  digest: (_algorithm, data) => Effect.succeed(data),
  randomBytes: (size) => Uint8Array.from({ length: size }, (_, index) => index),
});
const fixture = (crypto: Crypto.Crypto, sqlFailure?: SqlError) =>
  Effect.gen(function* invitationFixture() {
    const writes: { readonly params: readonly unknown[]; readonly sql: string }[] = [];
    const driver = scriptedPgClientLayer(
      Effect.succeed(
        testSqlConnection((sql, params) =>
          Effect.suspend(() => {
            writes.push({ params, sql });
            return sqlFailure === undefined ? Effect.succeed([]) : Effect.fail(sqlFailure);
          }),
        ),
      ),
    ).pipe(Layer.provide(Reactivity.layer));
    const database = yield* makeWithDefaults({ relations: authRelations }).pipe(Effect.provide(driver));
    const transaction = yield* installOperationalScopeFromTransactionService(scope).pipe(
      Effect.provideService(OperationalScopeTransaction, {
        delete: database.delete.bind(database),
        insert: database.insert.bind(database),
        install: () => Effect.void,
        scopedRoutineInvoker: () => ({ invoke: () => Effect.die('Unexpected routine invocation') }),
        select: database.select.bind(database),
        update: database.update.bind(database),
        verify: Effect.succeed(Option.some({ legal_entity_id: scope.legalEntityId ?? '', tenant_id: scope.tenantId })),
      }),
    );
    const provider = yield* PersonInvitationIdentityProvider.pipe(
      Effect.provide(
        BetterAuthPersonInvitationIdentityProviderLive.pipe(Layer.provide(Layer.succeed(Crypto.Crypto, crypto))),
      ),
    );
    return { provision: provider.fromTransaction(transaction).provision, writes };
  });

it.effect('captures Crypto in the provider layer and stores exactly 32 bytes as unpadded base64url', () =>
  Effect.gen(function* secureToken() {
    const sizes: number[] = [];
    const crypto: Crypto.Crypto = {
      ...nativeCrypto,
      randomBytes: (size) => {
        sizes.push(size);
        return nativeCrypto.randomBytes(size);
      },
    };
    const test = yield* fixture(crypto);
    expect(sizes).toEqual([]);
    expect(yield* test.provision(input)).toBeUndefined();
    expect(sizes).toEqual([32]);
    expect(test.writes).toHaveLength(2);
    const token = Base64Url.encode(Uint8Array.from({ length: 32 }, (_, index) => index));
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(Result.getOrThrow(Base64Url.decode(token))).toHaveLength(32);
    expect(test.writes[0]?.sql).toContain('"auth"."user"');
    expect(test.writes[0]?.params).toContain(input.providerSubjectId);
    expect(test.writes[1]?.sql).toContain('"auth"."verification"');
    expect(test.writes[1]?.params).toContain(`reset-password:${token}`);
  }),
);

it.effect('maps entropy failure to IdentityPersistenceUnavailableError before either SQL insert', () =>
  Effect.gen(function* failedEntropy() {
    const crypto: Crypto.Crypto = { ...nativeCrypto, randomBytes: () => Effect.fail(cryptoFailure) };
    const test = yield* fixture(crypto);
    const error = yield* Effect.flip(test.provision(input));
    expect(error).toBeInstanceOf(IdentityPersistenceUnavailableError);
    expect(error).toHaveProperty('cause', cryptoFailure);
    expect(test.writes).toEqual([]);
  }),
);

it.effect('rejects invalid login email before requesting entropy or persisting login rows', () =>
  Effect.gen(function* invalidEmail() {
    const crypto: Crypto.Crypto = { ...nativeCrypto, randomBytes: () => Effect.die('Unexpected entropy request') };
    const test = yield* fixture(crypto);
    expect(yield* Effect.flip(test.provision({ ...input, email: 'not-an-email' }))).toBeInstanceOf(
      IdentityTargetInvalidError,
    );
    expect(test.writes).toEqual([]);
  }),
);

it.effect('preserves the existing duplicate-email conflict instead of inserting verification', () =>
  Effect.gen(function* duplicateEmail() {
    const error = new SqlError({
      reason: new UnknownError({ cause: { code: '23505', constraint: 'user_email_unique' } }),
    });
    const test = yield* fixture(nativeCrypto, error);
    expect(yield* Effect.flip(test.provision(input))).toBeInstanceOf(IdentityLifecycleConflictError);
    expect(test.writes).toHaveLength(1);
  }),
);
