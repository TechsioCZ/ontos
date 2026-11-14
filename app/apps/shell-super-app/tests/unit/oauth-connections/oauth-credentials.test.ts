import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { Effect, Exit, Layer } from 'effect';
import { expect, it } from 'effect-rstest';

import { AuthDatabase } from '../../../api/auth/db/client.ts';
import { OAuthCredentials } from '../../../api/auth/db/oauth-credentials.ts';
import { OAuthCredentialsLive } from '../../../api/auth/db/oauth-credentials-live.ts';
import { oauthAccessToken, oauthConsent, oauthRefreshToken } from '../../../api/auth/db/schema.ts';

type CredentialTable = typeof oauthAccessToken | typeof oauthConsent | typeof oauthRefreshToken;
interface Statement {
  readonly predicate: SQL | undefined;
  readonly table: CredentialTable;
}
const lockedRead = (statements: Statement[], table: CredentialTable, predicate: SQL | undefined) => ({
  for: () =>
    Effect.sync(() => {
      statements.push({ predicate, table });
      return [{ userId: 'retained-user' }];
    }),
});
const fixture = (referenceId: string | null, failCleanup = false) => {
  const statements: Statement[] = [];
  const events: string[] = [];
  const operations = {
    delete: (table: CredentialTable) => ({
      where: (predicate: SQL | undefined) =>
        Effect.suspend(() => {
          statements.push({ predicate, table });
          return failCleanup ? Effect.fail('driver-failure') : Effect.void;
        }),
    }),
    select: () => ({
      from: (table: CredentialTable) => ({
        where: (predicate: SQL | undefined) => lockedRead(statements, table, predicate),
      }),
    }),
  };
  const executor = {
    ...operations,
    transaction: (body: (transaction: typeof operations) => Effect.Effect<void, unknown>) =>
      Effect.suspend(() => {
        events.push('begin');
        return body(executor);
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            events.push('commit');
          }),
        ),
        Effect.tapError(() =>
          Effect.sync(() => {
            events.push('rollback');
          }),
        ),
      ),
  };
  // SAFETY: this scripted driver implements the exercised transaction operations, not Better Auth's adapter.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- Test-only driver boundary; production receives the full AuthDatabase service.
  const database = { executor } as never;
  const layer = OAuthCredentialsLive.pipe(Layer.provide(Layer.succeed(AuthDatabase, database)));
  const revoke = Effect.gen(function* revoke() {
    yield* (yield* OAuthCredentials).revokeFamily({
      clientId: 'retained-client',
      id: 'retained-refresh-row',
      referenceId,
    });
  }).pipe(Effect.provide(layer));
  return { events, revoke, statements };
};
const queryOf = (statement: Statement | undefined) => {
  if (statement?.predicate === undefined) {
    throw new Error('expected credential predicate');
  }
  return new PgDialect().sqlToQuery(statement.predicate);
};

it.effect('Auth cleanup uses retained client/user/reference family facts without any Core tables', () =>
  Effect.gen(function* familyCleanup() {
    const test = fixture('retained-grant');
    yield* test.revoke;
    expect(test.events).toEqual(['begin', 'commit']);
    expect(test.statements.map((statement) => statement.table)).toEqual([
      oauthRefreshToken,
      oauthAccessToken,
      oauthRefreshToken,
      oauthConsent,
    ]);
    expect(queryOf(test.statements[0]).params).toEqual(['retained-refresh-row', 'retained-client', 'retained-grant']);
    for (const statement of test.statements.slice(1)) {
      expect(queryOf(statement).params).toEqual(['retained-grant', 'retained-client', 'retained-user']);
    }
  }),
);
it.effect('unreferenced refresh cleanup removes only that refresh row and its access tokens', () =>
  Effect.gen(function* unreferencedFamily() {
    const test = fixture(null);
    yield* test.revoke;
    expect(test.statements.map((statement) => statement.table)).toEqual([
      oauthRefreshToken,
      oauthAccessToken,
      oauthRefreshToken,
    ]);
    expect(queryOf(test.statements[0]).sql).toContain('is null');
    expect(queryOf(test.statements[1]).params).toEqual(['retained-refresh-row', 'retained-client']);
  }),
);
it.effect('Auth cleanup failures roll back and remain failures', () =>
  Effect.gen(function* cleanupFailure() {
    const test = fixture('retained-grant', true);
    const result = yield* test.revoke.pipe(Effect.exit);
    expect(Exit.isFailure(result)).toBe(true);
    expect(test.events).toEqual(['begin', 'rollback']);
  }),
);
