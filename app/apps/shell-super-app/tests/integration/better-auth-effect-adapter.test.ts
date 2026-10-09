import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

import { apiKey } from '@better-auth/api-key';
import type { DBAdapter, Where } from 'better-auth';
import { like, sql } from 'drizzle-orm';
import { Cause, Effect, Exit } from 'effect';
import { describe, expect, it } from 'effect-rstest';

import { loadAuthConfig } from '../../api/auth/config.ts';
import { makeAuthDatabase } from '../../api/auth/db/client.ts';
import { user, verification } from '../../api/auth/db/schema.ts';

interface UserRow {
  readonly email: string;
  readonly emailVerified: boolean;
  readonly id: string;
  readonly name: string;
}

interface ApiKeyRow {
  readonly id: string;
  readonly requestCount: number;
}

interface ApiKeyInput {
  readonly createdAt: Date;
  readonly key: string;
  readonly referenceId: string;
  readonly requestCount: number;
  readonly updatedAt: Date;
}

interface VerificationRow {
  readonly identifier: string;
  readonly value: string;
}

// Fixed instants keep the fixtures independent of the clock; only expiry needs to lie ahead.
const fixtureCreatedAt = new Date('2026-01-01T00:00:00.000Z');
const fixtureExpiresAt = new Date('2100-01-01T00:00:00.000Z');

const betterAuthOptions = { plugins: [apiKey({ references: 'user' })] };

/** A shell Auth database whose fixture rows are removed when the test scope closes. */
const authFixture = Effect.gen(function* authFixture() {
  const configuration = yield* loadAuthConfig();
  const persistence = yield* makeAuthDatabase(configuration);
  const suffix = `-${randomUUID()}@adapter.example.test`;
  const cleanup = Effect.all(
    [
      persistence.executor.delete(user).where(like(user.email, `%${suffix}`)),
      persistence.executor.delete(verification).where(like(verification.identifier, `%${suffix}`)),
    ],
    { concurrency: 1, discard: true },
  ).pipe(Effect.orDie);
  yield* Effect.addFinalizer(() => cleanup);
  return { adapter: persistence.adapter(betterAuthOptions), executor: persistence.executor, suffix };
});

const createUser = (adapter: DBAdapter, name: string, email: string) =>
  Effect.promise(() =>
    adapter.create<Omit<UserRow, 'id'>, UserRow>({ data: { email, emailVerified: false, name }, model: 'user' }),
  );

const findUser = (adapter: DBAdapter, where: Where[]) =>
  Effect.promise(() => adapter.findOne<UserRow>({ model: 'user', where }));

describe('Better Auth adapter on the native Effect executor', () => {
  it.live('runs every adapter operation against the Auth schema', () =>
    Effect.scoped(
      Effect.gen(function* everyOperation() {
        const { adapter, suffix } = yield* authFixture;
        const ownedBySuffix: Where = { field: 'email', operator: 'ends_with', value: suffix };
        const alpha = yield* createUser(adapter, 'Alpha', `alpha${suffix}`);
        const beta = yield* createUser(adapter, 'Beta', `beta${suffix}`);
        const gamma = yield* createUser(adapter, 'Gamma', `gamma${suffix}`);
        expect(alpha).toMatchObject({ email: `alpha${suffix}`, emailVerified: false, name: 'Alpha' });

        expect(yield* findUser(adapter, [{ field: 'id', value: beta.id }])).toMatchObject({ email: beta.email });
        expect(
          yield* findUser(adapter, [{ field: 'email', mode: 'insensitive', value: gamma.email.toUpperCase() }]),
        ).toMatchObject({ id: gamma.id });
        expect(yield* findUser(adapter, [{ field: 'email', value: `missing${suffix}` }])).toBeNull();
        const projected = yield* Effect.promise(() =>
          adapter.findOne<Pick<UserRow, 'email'>>({
            model: 'user',
            select: ['email'],
            where: [ownedBySuffix, { field: 'name', value: 'Alpha' }],
          }),
        );
        expect(projected).toEqual({ email: alpha.email });

        const page = yield* Effect.promise(() =>
          adapter.findMany<UserRow>({
            limit: 2,
            model: 'user',
            offset: 1,
            sortBy: { direction: 'desc', field: 'name' },
            where: [ownedBySuffix],
          }),
        );
        expect(page.map((row) => row.name)).toEqual(['Beta', 'Alpha']);
        const namesWhere = (where: Where[]) =>
          Effect.promise(() =>
            adapter.findMany<UserRow>({ model: 'user', sortBy: { direction: 'asc', field: 'name' }, where }),
          );
        expect(
          (yield* namesWhere([{ field: 'id', operator: 'in', value: [alpha.id, gamma.id] }])).map((row) => row.name),
        ).toEqual(['Alpha', 'Gamma']);
        expect(
          (yield* namesWhere([ownedBySuffix, { field: 'id', operator: 'not_in', value: [alpha.id] }])).map(
            (row) => row.name,
          ),
        ).toEqual(['Beta', 'Gamma']);
        expect(
          (yield* namesWhere([
            { connector: 'OR', field: 'id', value: alpha.id },
            { connector: 'OR', field: 'id', value: beta.id },
          ])).map((row) => row.name),
        ).toEqual(['Alpha', 'Beta']);
        expect(
          (yield* namesWhere([{ field: 'name', operator: 'starts_with', value: 'Gam' }, ownedBySuffix])).length,
        ).toBe(1);
        // LIKE metacharacters in a value are literals, not wildcards.
        expect(yield* namesWhere([ownedBySuffix, { field: 'name', operator: 'contains', value: '%' }])).toEqual([]);

        expect(yield* Effect.promise(() => adapter.count({ model: 'user', where: [ownedBySuffix] }))).toBe(3);
        const renamed = yield* Effect.promise(() =>
          adapter.update<UserRow>({
            model: 'user',
            update: { name: 'Alpha Prime' },
            where: [{ field: 'id', value: alpha.id }],
          }),
        );
        expect(renamed).toMatchObject({ id: alpha.id, name: 'Alpha Prime' });
        expect(
          yield* Effect.promise(() =>
            adapter.updateMany({ model: 'user', update: { emailVerified: true }, where: [ownedBySuffix] }),
          ),
        ).toBe(3);

        const key = yield* Effect.promise(() =>
          adapter.create<ApiKeyInput, ApiKeyRow>({
            data: {
              createdAt: fixtureCreatedAt,
              key: randomUUID(),
              referenceId: alpha.id,
              requestCount: 0,
              updatedAt: fixtureCreatedAt,
            },
            model: 'apikey',
          }),
        );
        const incremented = yield* Effect.promise(() =>
          adapter.incrementOne<ApiKeyRow>({
            increment: { requestCount: 2 },
            model: 'apikey',
            where: [{ field: 'id', value: key.id }],
          }),
        );
        expect(incremented?.requestCount).toBe(2);

        const identifier = `token${suffix}`;
        yield* Effect.promise(() =>
          adapter.create({
            data: {
              expiresAt: fixtureExpiresAt,
              identifier,
              value: 'secret',
            },
            model: 'verification',
          }),
        );
        const consume = Effect.promise(() =>
          adapter.consumeOne<VerificationRow>({
            model: 'verification',
            where: [{ field: 'identifier', value: identifier }],
          }),
        );
        expect(yield* consume).toMatchObject({ identifier, value: 'secret' });
        expect(yield* consume).toBeNull();

        yield* Effect.promise(() => adapter.delete({ model: 'user', where: [{ field: 'id', value: gamma.id }] }));
        expect(yield* findUser(adapter, [{ field: 'id', value: gamma.id }])).toBeNull();
        expect(yield* Effect.promise(() => adapter.deleteMany({ model: 'user', where: [ownedBySuffix] }))).toBe(2);
      }),
    ),
  );

  it.live('runs a Better Auth transaction on one connection and rolls it back when the body rejects', () =>
    Effect.scoped(
      Effect.gen(function* transactionRollback() {
        const { adapter, suffix } = yield* authFixture;
        const email = `rollback${suffix}`;
        const bodyFailure = new Error('the body rejected after writing');
        const outcome = yield* Effect.exit(
          Effect.promise(() =>
            adapter.transaction(async (transaction) => {
              await transaction.create({ data: { email, emailVerified: false, name: 'Rollback' }, model: 'user' });
              // Visible on the transaction's connection, invisible to the root adapter until commit.
              expect(
                await transaction.findOne({ model: 'user', where: [{ field: 'email', value: email }] }),
              ).not.toBeNull();
              expect(await adapter.findOne({ model: 'user', where: [{ field: 'email', value: email }] })).toBeNull();
              throw bodyFailure;
            }),
          ),
        );
        expect(Exit.isFailure(outcome) && Cause.squash(outcome.cause)).toBe(bodyFailure);
        expect(yield* findUser(adapter, [{ field: 'email', value: email }])).toBeNull();

        const committed = yield* Effect.promise(() =>
          adapter.transaction(
            async (transaction) =>
              await transaction.create<Omit<UserRow, 'id'>, UserRow>({
                data: { email: `commit${suffix}`, emailVerified: false, name: 'Commit' },
                model: 'user',
              }),
          ),
        );
        expect(yield* findUser(adapter, [{ field: 'id', value: committed.id }])).toMatchObject({ name: 'Commit' });
      }),
    ),
  );

  it.live('runs the transaction body in the caller async context that database hooks read', () =>
    Effect.scoped(
      Effect.gen(function* callerAsyncContext() {
        const { adapter } = yield* authFixture;
        // Open the pooled connection outside the caller context, as a warm server has, so the
        // transaction resumes on a socket that does not carry it.
        yield* Effect.promise(() => adapter.count({ model: 'user' }));
        const endpointContext = new AsyncLocalStorage<string>();
        const seen = yield* Effect.promise(() =>
          endpointContext.run('endpoint', () =>
            adapter.transaction(async (transaction) => {
              await transaction.count({ model: 'user' });
              return endpointContext.getStore();
            }),
          ),
        );
        expect(seen).toBe('endpoint');
      }),
    ),
  );

  it.live('opens only native @effect/sql-pg connections', () =>
    Effect.scoped(
      Effect.gen(function* nativeConnectionsOnly() {
        const { adapter, executor, suffix } = yield* authFixture;
        // The server clock bounds the window; the second of slack takes in the fixture's first connection.
        const [window] = yield* executor.execute<{ readonly since: string }>(
          sql`select (clock_timestamp() - interval '1 second')::text as since`,
          'objects',
        );
        yield* createUser(adapter, 'Connection', `connection${suffix}`);
        yield* Effect.promise(() =>
          adapter.transaction(
            async (transaction) =>
              await transaction.count({ model: 'user', where: [{ field: 'email', value: `connection${suffix}` }] }),
          ),
        );
        const backends = yield* executor.execute<{ readonly application_name: string }>(
          sql`
          select application_name from pg_stat_activity
          where datname = current_database() and usename = current_user and backend_start >= ${window?.since}::timestamptz
        `,
          'objects',
        );
        expect(backends.length).toBeGreaterThan(0);
        expect(new Set(backends.map((backend) => backend.application_name))).toEqual(new Set(['@effect/sql-pg']));
      }),
    ),
  );
});
