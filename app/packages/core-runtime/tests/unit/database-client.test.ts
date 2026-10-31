import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';

import { PgClient } from '@effect/sql-pg';
import { ConfigProvider, Context, Deferred, Effect, Exit, Fiber, Layer, Predicate, Redacted, Scope } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';

import { DatabasePoolRegistryLive, DatabasePools, openDatabaseClient } from '../../src/db/database-client.ts';
import { configureDatabasePool } from '../../src/db/pool-configuration.ts';

/** One physical backend session the fake server accepted. */
interface FakeSession {
  closed: boolean;
  readonly socket: Socket;
  readonly statements: string[];
  user: string;
}

interface FakePostgres {
  readonly sessions: FakeSession[];
  readonly url: (role: string) => Redacted.Redacted;
}

const int16 = (value: number) => {
  const buffer = Buffer.alloc(2);
  buffer.writeInt16BE(value);
  return buffer;
};
const int32 = (value: number) => {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value);
  return buffer;
};
const cString = (value: string) => Buffer.from(`${value}\0`);
const message = (type: string, ...body: Buffer[]) => {
  const payload = Buffer.concat(body);
  return Buffer.concat([Buffer.from(type), int32(payload.length + 4), payload]);
};
const readCString = (buffer: Buffer, offset: number) => {
  const end = buffer.indexOf(0, offset);
  return { next: end + 1, value: buffer.toString('utf-8', offset, end) };
};

/** Lock functions answer one binary boolean column (true); every other statement answers no rows. */
const booleanResult = (sql: string) => /pg_(?:try_)?advisory_(?:un)?lock/u.test(sql);
const rowDescription = (sql: string) =>
  booleanResult(sql)
    ? message('T', int16(1), cString('result'), int32(0), int16(0), int32(16), int16(1), int32(-1), int16(1))
    : message('n');

/**
 * A minimal PostgreSQL backend: trust authentication, the simple and extended query protocols, transaction
 * status, an error for any statement containing `fail`, and the server's `ROLLBACK` answer to a failed COMMIT.
 */
const serveSession = (socket: Socket, sessions: FakeSession[]) => {
  const session: FakeSession = { closed: false, socket, statements: [], user: '' };
  sessions.push(session);
  socket.on('close', () => {
    session.closed = true;
  });
  socket.on('error', () => {
    session.closed = true;
  });
  const prepared = new Map<string, string>();
  const portals = new Map<string, string>();
  let pending = Buffer.alloc(0);
  let started = false;
  let skipping = false;
  let status = 'I';

  const execute = (sql: string): Buffer[] => {
    session.statements.push(sql);
    const statement = sql.trim().toLowerCase();
    if (statement.includes('fail')) {
      status = status === 'I' ? 'I' : 'E';
      skipping = true;
      return [
        message(
          'E',
          Buffer.from('S'),
          cString('ERROR'),
          Buffer.from('C'),
          cString('22012'),
          Buffer.from('M'),
          cString('failed'),
          Buffer.from([0]),
        ),
      ];
    }
    if (statement.startsWith('begin')) {
      status = 'T';
      return [message('C', cString('BEGIN'))];
    }
    if (statement.startsWith('commit')) {
      const tag = status === 'E' ? 'ROLLBACK' : 'COMMIT';
      status = 'I';
      return [message('C', cString(tag))];
    }
    if (statement.startsWith('rollback to')) {
      status = 'T';
      return [message('C', cString('ROLLBACK'))];
    }
    if (statement.startsWith('rollback')) {
      status = 'I';
      return [message('C', cString('ROLLBACK'))];
    }
    if (statement.startsWith('savepoint') || statement.startsWith('release')) {
      return [message('C', cString(statement.split(' ')[0]?.toUpperCase() ?? 'SAVEPOINT'))];
    }
    return booleanResult(statement)
      ? [message('D', int16(1), int32(1), Buffer.from([1])), message('C', cString('SELECT 1'))]
      : [message('C', cString('SELECT 0'))];
  };

  const extendedQuery = new Map<string, (body: Buffer) => Buffer[]>([
    [
      'B',
      (body) => {
        const portal = readCString(body, 0);
        portals.set(portal.value, prepared.get(readCString(body, portal.next).value) ?? '');
        return [message('2')];
      },
    ],
    ['C', () => [message('3')]],
    [
      'D',
      (body) => {
        const name = readCString(body, 1).value;
        return body[0] === 'S'.codePointAt(0)
          ? [message('t', int16(0)), rowDescription(prepared.get(name) ?? '')]
          : [rowDescription(portals.get(name) ?? '')];
      },
    ],
    ['E', (body) => execute(portals.get(readCString(body, 0).value) ?? '')],
    [
      'P',
      (body) => {
        const name = readCString(body, 0);
        prepared.set(name.value, readCString(body, name.next).value);
        return [message('1')];
      },
    ],
    [
      'Q',
      (body) => {
        const sql = readCString(body, 0).value;
        return [
          ...(booleanResult(sql) ? [rowDescription(sql)] : []),
          ...execute(sql),
          message('Z', Buffer.from(status)),
        ];
      },
    ],
  ]);

  const handle = (type: string, body: Buffer): Buffer[] => {
    if (type === 'S') {
      skipping = false;
      return [message('Z', Buffer.from(status))];
    }
    if (type === 'X') {
      socket.end();
      return [];
    }
    if (skipping) {
      return [];
    }
    return extendedQuery.get(type)?.(body) ?? [];
  };

  /** The length of the frame at the head of the buffer, or infinity until its length prefix has arrived. */
  const frameLength = () => {
    if (!started) {
      return pending.length < 8 ? Number.POSITIVE_INFINITY : pending.readInt32BE(0);
    }
    return pending.length < 5 ? Number.POSITIVE_INFINITY : pending.readInt32BE(1) + 1;
  };

  const answer = (frame: Buffer): Buffer[] => {
    if (started) {
      return handle(String.fromCodePoint(frame[0] ?? 0), frame.subarray(5));
    }
    if (frame.readInt32BE(4) === 80_877_103) {
      return [Buffer.from('N')];
    }
    const fields = frame.subarray(8).toString('utf-8').split('\0');
    session.user = fields[fields.indexOf('user') + 1] ?? '';
    started = true;
    return [message('R', int32(0)), message('K', int32(1), int32(1)), message('Z', Buffer.from('I'))];
  };

  socket.on('data', (chunk: Buffer) => {
    pending = Buffer.concat([pending, chunk]);
    const replies: Buffer[] = [];
    // The startup frame comes first, then typed messages; a partial frame waits for the next chunk.
    for (let length = frameLength(); pending.length >= length; length = frameLength()) {
      replies.push(...answer(pending.subarray(0, length)));
      pending = pending.subarray(length);
    }
    if (replies.length > 0 && !socket.destroyed) {
      socket.write(Buffer.concat(replies));
    }
  });
};

const fakePostgres = Effect.acquireRelease(
  Effect.callback<{ readonly fake: FakePostgres; readonly server: Server; readonly sockets: Set<Socket> }>((resume) => {
    const sessions: FakeSession[] = [];
    const sockets = new Set<Socket>();
    const server = createServer((socket) => {
      sockets.add(socket);
      serveSession(socket, sessions);
    });
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = Predicate.hasProperty(address, 'port') ? String(address.port) : '';
      resume(
        Effect.succeed({
          fake: {
            sessions,
            url: (role) => Redacted.make(`postgresql://${role}:secret@127.0.0.1:${port}/ontos`),
          },
          server,
          sockets,
        }),
      );
    });
  }),
  ({ server, sockets }) =>
    Effect.callback<undefined>((resume) => {
      for (const socket of sockets) {
        socket.destroy();
      }
      server.close(() => resume(Effect.undefined));
    }),
).pipe(Effect.map(({ fake }) => fake));

const sharedPools = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.gen(function* withSharedPools() {
    const context = yield* Layer.build(DatabasePoolRegistryLive.pipe(Layer.provide(Reactivity.layer)));
    return yield* program.pipe(Effect.provideContext(context));
  }).pipe(
    Effect.scoped,
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown({ ONTOS_DATABASE_POOL_SHARED: 'true' }),
    ),
  );
const privatePools = Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({}));

/** One owner's client, open until its own scope closes. */
const ownerClient = (
  url: Redacted.Redacted,
  scope: Scope.Scope,
  settings?: { readonly maxConnections?: number; readonly statementTimeout?: number },
) =>
  Effect.gen(function* openOwnerClient() {
    const configuration = yield* configureDatabasePool(
      url,
      settings?.statementTimeout === undefined ? undefined : { statement_timeout: settings.statementTimeout },
      settings?.maxConnections,
    );
    const reactivity = yield* Reactivity.make;
    return yield* openDatabaseClient(configuration).pipe(
      Effect.provideService(Reactivity.Reactivity, reactivity),
      Scope.provide(scope),
    );
  });

const query = (client: PgClient.PgClient, sql: string) => client.unsafe(sql).pipe(Effect.asVoid);

const sessionRunning = (fake: FakePostgres, sql: string) =>
  fake.sessions.filter((session) => session.statements.includes(sql));

/** Terminate is asynchronous: the backend sees the socket close shortly after the pool shuts down. */
const awaitClosed = (session: FakeSession | undefined) =>
  Effect.callback<undefined>((resume) => {
    if (session === undefined || session.closed) {
      resume(Effect.undefined);
      return;
    }
    session.socket.once('close', () => resume(Effect.undefined));
  });

it.live('gives two owners asking for the same role one native pool', () =>
  Effect.gen(function* sameRole() {
    const fake = yield* fakePostgres;
    const crm = yield* ownerClient(fake.url('ontos_runtime'), yield* Effect.scope);
    const pricing = yield* ownerClient(fake.url('ontos_runtime'), yield* Effect.scope);

    yield* query(crm, 'select 1 as crm');
    yield* query(pricing, 'select 1 as pricing');

    expect(crm.config).toBe(pricing.config);
    expect(fake.sessions.map(({ statements, user }) => ({ statements, user }))).toStrictEqual([
      { statements: ['select 1 as crm', 'select 1 as pricing'], user: 'ontos_runtime' },
    ]);
  }).pipe(Effect.scoped, sharedPools),
);

it.live('gives different roles different pools', () =>
  Effect.gen(function* differentRoles() {
    const fake = yield* fakePostgres;
    const runtime = yield* ownerClient(fake.url('ontos_runtime'), yield* Effect.scope);
    const party = yield* ownerClient(fake.url('party_registry_runtime'), yield* Effect.scope);

    yield* query(runtime, 'select 1 as runtime');
    yield* query(party, 'select 1 as party');

    expect(runtime.config).not.toBe(party.config);
    expect(fake.sessions.map(({ user }) => user)).toStrictEqual(['ontos_runtime', 'party_registry_runtime']);
  }).pipe(Effect.scoped, sharedPools),
);

it.live('serves twelve owners from the process budget and queues another checkout until a lease closes', () =>
  Effect.gen(function* processWideCapacity() {
    const fake = yield* fakePostgres;
    const parent = yield* Effect.scope;
    const url = fake.url('ontos_runtime');
    const leases = yield* Effect.forEach(Array.from({ length: 12 }), () =>
      Effect.gen(function* reserveForOwner() {
        const scope = yield* Scope.fork(parent);
        const client = yield* ownerClient(url, parent);
        yield* client.reserve.pipe(Scope.provide(scope));
        return scope;
      }),
    );
    expect(fake.sessions).toHaveLength(12);

    const next = yield* ownerClient(url, parent);
    const acquired = yield* Deferred.make<boolean>();
    const started = yield* Deferred.make<boolean>();
    yield* Effect.scoped(
      Effect.andThen(Deferred.succeed(started, true), Effect.andThen(next.reserve, Deferred.succeed(acquired, true))),
    ).pipe(Effect.forkScoped);
    yield* Deferred.await(started);
    yield* Effect.yieldNow;
    expect(yield* Deferred.isDone(acquired)).toBe(false);
    const [first] = leases;
    if (first === undefined) {
      return yield* Effect.die('The pool capacity test opened no lease');
    }
    yield* Scope.close(first, Exit.void);
    yield* Deferred.await(acquired);
    expect(fake.sessions).toHaveLength(12);
    return yield* Effect.void;
  }).pipe(
    Effect.scoped,
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown({
        ONTOS_DATABASE_POOL_MAX_CONNECTIONS: '12',
        ONTOS_DATABASE_POOL_SHARED: 'true',
      }),
    ),
    sharedPools,
  ),
);

it.live('keeps the shared pool open until its last owner closes', () =>
  Effect.gen(function* lastOwnerCloses() {
    const fake = yield* fakePostgres;
    const url = fake.url('ontos_runtime');
    const crmScope = yield* Scope.make();
    const pricingScope = yield* Scope.make();
    const crm = yield* ownerClient(url, crmScope);
    const pricing = yield* ownerClient(url, pricingScope);
    yield* query(crm, 'select 1 as before_close');

    yield* Scope.close(crmScope, Exit.void);
    yield* query(pricing, 'select 1 as after_close');
    expect(fake.sessions).toHaveLength(1);
    expect(fake.sessions[0]?.closed).toBe(false);

    yield* Scope.close(pricingScope, Exit.void);
    yield* awaitClosed(fake.sessions[0]);
    const later = yield* ownerClient(url, yield* Effect.scope);
    yield* query(later, 'select 1 as reopened');
    expect(later.config).not.toBe(pricing.config);
    expect(sessionRunning(fake, 'select 1 as reopened')).toStrictEqual([fake.sessions[1]]);
  }).pipe(Effect.scoped, sharedPools),
);

it.live('keeps each owner client in its own transactions on the shared pool', () =>
  Effect.gen(function* ownTransactions() {
    const fake = yield* fakePostgres;
    const crm = yield* ownerClient(fake.url('ontos_runtime'), yield* Effect.scope);
    const redemption = yield* ownerClient(fake.url('ontos_runtime'), yield* Effect.scope);

    yield* crm.withTransaction(
      Effect.andThen(query(crm, 'select 1 as inside'), query(redemption, 'select 1 as autocommit')),
    );

    const [transaction] = sessionRunning(fake, 'select 1 as inside');
    const [autocommit] = sessionRunning(fake, 'select 1 as autocommit');
    expect(transaction?.statements).toStrictEqual(['BEGIN', 'select 1 as inside', 'COMMIT']);
    expect(autocommit).not.toBe(transaction);
    expect(autocommit?.statements).toStrictEqual(['select 1 as autocommit']);

    const aborted = yield* Effect.exit(crm.withTransaction(Effect.ignore(query(crm, 'select fail'))));
    expect(Exit.isFailure(aborted)).toBe(true);
    expect(String(aborted)).toContain('COMMIT rolled back an aborted transaction');
  }).pipe(Effect.scoped, sharedPools),
);

it.live('keeps session advisory locks on a private session', () =>
  Effect.gen(function* privateLockSession() {
    const fake = yield* fakePostgres;
    const url = fake.url('ontos_runtime');
    const pooled = yield* ownerClient(url, yield* Effect.scope);

    yield* Effect.scoped(
      Effect.gen(function* acquirePrivateLock() {
        const configuration = yield* configureDatabasePool(url, undefined, 1);
        const reactivity = yield* Reactivity.make;
        const privateClient = yield* PgClient.make(configuration).pipe(
          Effect.provideService(Reactivity.Reactivity, reactivity),
        );
        yield* privateClient.unsafe("select pg_try_advisory_lock(hashtextextended('test-lock', 0))");
        yield* query(pooled, 'select 1 as while_locked');
      }),
    );

    const lock = fake.sessions.find((session) =>
      session.statements.some((statement) => statement.includes('pg_try_advisory_lock')),
    );
    const [work] = sessionRunning(fake, 'select 1 as while_locked');
    expect(lock).toBeDefined();
    expect(work).not.toBe(lock);
    expect(lock?.statements.filter((statement) => !statement.includes('advisory'))).toStrictEqual([]);
    yield* awaitClosed(lock);
    expect(work?.closed).toBe(false);
  }).pipe(Effect.scoped, sharedPools),
);

it.live('gives every client its own pool without the process flag', () =>
  Effect.gen(function* privateByDefault() {
    const fake = yield* fakePostgres;
    const crm = yield* ownerClient(fake.url('ontos_runtime'), yield* Effect.scope);
    const pricing = yield* ownerClient(fake.url('ontos_runtime'), yield* Effect.scope);

    yield* query(crm, 'select 1 as crm');
    yield* query(pricing, 'select 1 as pricing');

    expect(crm.config).not.toBe(pricing.config);
    expect(fake.sessions).toHaveLength(2);
  }).pipe(Effect.scoped, privatePools),
);

it.live('coalesces concurrent first owners without sharing their transaction identities', () =>
  Effect.gen(function* concurrentOwners() {
    const fake = yield* fakePostgres;
    const scope = yield* Effect.scope;
    const [first, second] = yield* Effect.all(
      [ownerClient(fake.url('ontos_runtime'), scope), ownerClient(fake.url('ontos_runtime'), scope)],
      { concurrency: 'unbounded' },
    );
    expect(first.config).toBe(second.config);
    expect(first.transactionService).not.toBe(second.transactionService);
    yield* query(first, 'select 1 as first_owner');
    yield* query(second, 'select 1 as second_owner');
    expect(fake.sessions).toHaveLength(1);
  }).pipe(Effect.scoped, sharedPools),
);

it.live('does not share pools with different explicit limits or server deadlines', () =>
  Effect.gen(function* distinctBudgets() {
    const fake = yield* fakePostgres;
    const scope = yield* Effect.scope;
    const url = fake.url('ontos_runtime');
    const first = yield* ownerClient(url, scope, { maxConnections: 1 });
    const second = yield* ownerClient(url, scope, { maxConnections: 2 });
    const deadline = yield* ownerClient(url, scope, { maxConnections: 1, statementTimeout: 1000 });
    yield* query(first, 'select 1 as first_budget');
    yield* query(second, 'select 1 as second_budget');
    yield* query(deadline, 'select 1 as custom_deadline');
    expect(first.config).not.toBe(second.config);
    expect(first.config).not.toBe(deadline.config);
    expect(fake.sessions).toHaveLength(3);
  }).pipe(Effect.scoped, sharedPools),
);

it.live('fails closed when sharing is enabled without a process host registry', () =>
  Effect.gen(function* missingHostRegistry() {
    const fake = yield* fakePostgres;
    const result = yield* Effect.exit(ownerClient(fake.url('ontos_runtime'), yield* Effect.scope));
    expect(Exit.isFailure(result)).toBe(true);
    expect(String(result)).toContain('Shared database pools require a scoped process host registry');
    expect(fake.sessions).toHaveLength(0);
  }).pipe(
    Effect.scoped,
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown({ ONTOS_DATABASE_POOL_SHARED: 'true' }),
    ),
  ),
);

it.live('keeps native driver metadata and after-commit callbacks on each owner client', () =>
  Effect.gen(function* nativeTransactionCallbacks() {
    const fake = yield* fakePostgres;
    const first = yield* ownerClient(fake.url('ontos_runtime'), yield* Effect.scope);
    const second = yield* ownerClient(fake.url('ontos_runtime'), yield* Effect.scope);
    const committed: string[] = [];
    expect(first.driver).toBe('pg');
    expect(second.driver).toBe('pg');
    yield* first.withTransaction(
      Effect.gen(function* outerTransaction() {
        yield* first.afterCommit(
          Effect.sync(() => {
            committed.push('first');
          }),
        );
        yield* second.withTransaction(
          second.afterCommit(
            Effect.sync(() => {
              committed.push('second');
            }),
          ),
        );
        expect(committed).toEqual(['second']);
      }),
    );
    expect(committed).toEqual(['second', 'first']);
  }).pipe(Effect.scoped, sharedPools),
);

it.live('closes shared pools when the runtime registry shuts down with owner scopes still open', () =>
  Effect.gen(function* runtimeShutdown() {
    const fake = yield* fakePostgres;
    const ownerScope = yield* Effect.scope;
    yield* Effect.scoped(
      Effect.gen(function* runtimeScope() {
        const registry = Context.get(
          yield* Layer.build(DatabasePoolRegistryLive.pipe(Layer.provide(Reactivity.layer))),
          DatabasePools,
        );
        const client = yield* ownerClient(fake.url('ontos_runtime'), ownerScope).pipe(
          Effect.provideService(DatabasePools, registry),
        );
        yield* query(client, 'select 1 as before_shutdown');
        expect(fake.sessions[0]?.closed).toBe(false);
      }),
    );
    yield* awaitClosed(fake.sessions[0]);
    expect(fake.sessions[0]?.closed).toBe(true);
  }).pipe(
    Effect.scoped,
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown({ ONTOS_DATABASE_POOL_SHARED: 'true' }),
    ),
  ),
);

it.live('reports native pool occupancy and waiters, then returns to idle after a reservation', () =>
  Effect.gen(function* poolStatistics() {
    const fake = yield* fakePostgres;
    const client = yield* ownerClient(fake.url('ontos_runtime'), yield* Effect.scope, { maxConnections: 1 });
    const statistics = client.poolStatistics ?? Effect.die('The pinned driver must expose native pool statistics');
    expect(yield* statistics).toEqual({ idle: 0, inUse: 0, total: 0, waiting: 0 });
    const reservation = yield* Scope.make();
    yield* client.reserve.pipe(Scope.provide(reservation));
    expect(yield* statistics).toEqual({ idle: 0, inUse: 1, total: 1, waiting: 0 });
    const waiting = yield* client.reserve.pipe(Effect.scoped, Effect.forkScoped);
    yield* Effect.yieldNow;
    expect(yield* statistics).toEqual({ idle: 0, inUse: 1, total: 1, waiting: 1 });
    yield* Scope.close(reservation, Exit.void);
    yield* Fiber.join(waiting);
    expect(yield* statistics).toEqual({ idle: 1, inUse: 0, total: 1, waiting: 0 });
  }).pipe(Effect.scoped, sharedPools),
);
