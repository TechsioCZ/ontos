import { NodeCrypto } from '@effect/platform-node';
import { getTableColumns, getTableName } from 'drizzle-orm';
import { EffectDrizzleQueryError } from 'drizzle-orm/effect-core';
import { makeWithDefaults } from 'drizzle-orm/effect-postgres';
import { Cause, Context, DateTime, Effect, Exit, Layer, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { Reactivity } from 'effect/reactivity';
import { SqlError, UnknownError } from 'effect/sql/SqlError';

import type { OAuthGrantRecord } from '../../src/auth/oauth-grant-registry-contract.ts';
import { OAuthGrantRegistryLive } from '../../src/auth/oauth-grant-registry-live.ts';
import { OAuthGrantRegistry } from '../../src/auth/oauth-grant-registry-service.ts';
import { OAuthGrantRegistryUnavailable } from '../../src/auth/oauth-grant-registry-unavailable.ts';
import { CoreDatabase } from '../../src/db/client.ts';
import { coreRelations, oauthConnectionGrants, principalAuthBindings, principals } from '../../src/db/schema.ts';
import { scriptedPgClientLayer } from '../../src/testing/scripted-pg-client.ts';
import { testSqlConnection } from '../support/sql-connection.ts';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const draft = {
  actingKind: 'human',
  actingPrincipalId: id(4),
  authBindingId: null,
  clientHost: 'client.example',
  clientId: 'https://client.example/metadata',
  clientKind: 'cimd',
  clientLogoUri: null,
  clientName: 'Connector',
  consentedAt: null,
  consentId: 'retained-consent',
  createdAt: DateTime.toDateUtc(DateTime.makeUnsafe('2026-10-25T10:00:00Z')),
  grantId: id(1),
  lastUsedAt: null,
  legalEntityId: id(2),
  modulesJson: 'all',
  profileId: id(5),
  revokedAt: null,
  revokedByPrincipalId: null,
  revokeReason: null,
  sessionId: 'real-session',
  status: 'draft',
  tenantId: id(3),
  userId: 'real-user',
  userPrincipalId: id(4),
  writePolicy: 'direct',
} satisfies typeof oauthConnectionGrants.$inferSelect;
const grant: OAuthGrantRecord = {
  ...draft,
  actingKind: 'human',
  clientKind: 'cimd',
  modules: 'all',
  status: 'draft',
  writePolicy: 'direct',
};

type QueryTable = typeof oauthConnectionGrants | typeof principalAuthBindings | typeof principals;
interface Query {
  readonly kind: string;
  readonly params: readonly unknown[];
  readonly sql: string;
  readonly table: QueryTable | undefined;
}
const queryTables: readonly QueryTable[] = [oauthConnectionGrants, principalAuthBindings, principals];
type DriverFact =
  | OAuthGrantRecord[keyof OAuthGrantRecord]
  | { readonly moduleId: string }
  | readonly { readonly access: string; readonly moduleId: string }[];
type DriverRow = Readonly<Record<string, DriverFact>>;
const queryTable = (sql: string) => queryTables.find((candidate) => sql.includes(`"${getTableName(candidate)}"`));
const driverRows = (table: QueryTable | undefined, rows: readonly DriverRow[]) => {
  const columns = table === undefined ? [] : Object.entries(getTableColumns(table));
  return rows.map((row) =>
    Object.fromEntries(
      columns.map(([key, column]) => {
        const value = row[key];
        return [
          key,
          column.dataType === 'date' && value !== null && value !== undefined
            ? Schema.decodeUnknownSync(Schema.Date)(value).toISOString()
            : value,
        ];
      }),
    ),
  );
};
const harness = (responses: readonly (readonly DriverRow[] | 'fail')[]) =>
  Effect.gen(function* acquireRegistryFixture() {
    const queries: Query[] = [];
    const events: string[] = [];
    const driverCause = new Error('driver-failed');
    const failure = new SqlError({ reason: new UnknownError({ cause: driverCause }) });
    let cursor = 0;
    const execute = (sql: string, params: readonly unknown[]) =>
      Effect.suspend(() => {
        if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
          events.push(sql.toLowerCase());
          return Effect.succeed([]);
        }
        const table = queryTable(sql);
        const kind = sql.includes('pg_advisory_xact_lock') ? 'execute' : sql.split(' ')[0];
        queries.push({ kind: kind ?? '', params, sql, table });
        events.push(kind ?? '');
        const response = responses[cursor];
        cursor += 1;
        if (response === 'fail') {
          return Effect.fail(failure);
        }
        // The shared connection fixture turns object values into positional driver rows. Order them by
        // Drizzle's actual selected columns, including missing fields, rather than bypassing its decoder.
        return Effect.succeed(driverRows(table, response ?? []));
      });
    const database = Layer.effect(
      CoreDatabase,
      Effect.map(makeWithDefaults({ relations: coreRelations }), (executor) => ({ executor })),
    ).pipe(Layer.provide(scriptedPgClientLayer(Effect.succeed(testSqlConnection(execute)))));
    // it.effect owns this scope. Keep the native client alive through every assertion and transaction.
    const context = yield* Layer.build(OAuthGrantRegistryLive.pipe(Layer.provide(database)));
    return { context, driverCause, events, failure, queries };
  });
const malformedFacts = [
  { fields: { actingKind: 'unknown' }, name: 'acting kind' },
  { fields: { clientKind: 'unknown' }, name: 'client kind' },
  { fields: { status: 'unknown' }, name: 'status' },
  { fields: { writePolicy: 'unknown' }, name: 'write policy' },
  { fields: { modulesJson: null }, name: 'null modules' },
  { fields: { modulesJson: { moduleId: 'crm' } }, name: 'non-array modules' },
  { fields: { modulesJson: [{ access: 'admin', moduleId: 'crm' }] }, name: 'module access' },
  { fields: { modulesJson: [{ access: 'read', moduleId: '' }] }, name: 'module identity' },
  { fields: { revokeReason: 'unknown' }, name: 'revoke reason' },
];

type Registry = (typeof OAuthGrantRegistry)['Service'];
interface GrantRead {
  readonly name: string;
  readonly run: (registry: Registry) => Effect.Effect<unknown, OAuthGrantRegistryUnavailable>;
}
const grantReads: readonly GrantRead[] = [
  { name: 'grant lookup', run: (registry) => registry.findGrant(draft.grantId) },
  { name: 'session lookup', run: (registry) => registry.findSessionGrant(draft) },
  { name: 'list', run: (registry) => registry.listGrants({ tenantId: draft.tenantId }) },
  { name: 'previous profile projection', run: (registry) => registry.findPreviousProfileId(draft) },
  {
    name: 'owner projection',
    run: (registry) =>
      registry.owners({ grantIds: [draft.grantId], legalEntityId: draft.legalEntityId, tenantId: draft.tenantId }),
  },
];
const sqlOf = (query: Query | undefined) => {
  if (query === undefined) {
    throw new Error('expected an executed SQL statement');
  }
  return query;
};
const boundValue = Schema.decodeUnknownSync(Schema.Union([Schema.String, Schema.Finite, Schema.Null]));
const parameterFor = (query: Query | undefined, column: string): string | number | null => {
  const { params, sql } = sqlOf(query);
  const updateParameter = new RegExp(`"${column}" = \\$(?<parameter>\\d+)`, 'u').exec(sql)?.groups?.['parameter'];
  if (updateParameter !== undefined) {
    return boundValue(params[Number(updateParameter) - 1]);
  }
  const insert = /insert into [^(]+\((?<columns>[^)]+)\) values \((?<values>[^)]+)\)/u.exec(sql);
  const index = insert?.groups?.['columns']?.split(', ').indexOf(`"${column}"`);
  const insertParameter = index === undefined ? undefined : insert?.groups?.['values']?.split(', ')[index];
  if (insertParameter !== undefined && /^\$\d+$/u.test(insertParameter)) {
    return boundValue(params[Number(insertParameter.slice(1)) - 1]);
  }
  throw new Error(`expected a bound parameter for ${column}`);
};

it.layer(Layer.merge(Reactivity.layer, NodeCrypto.layer))('OAuthGrantRegistry native storage', (suite) => {
  for (const malformed of malformedFacts) {
    for (const operation of grantReads) {
      suite.effect(`${operation.name} rejects malformed ${malformed.name} as a typed storage failure`, () =>
        Effect.gen(function* rejectMalformedProjection() {
          const fixture = yield* harness([[{ ...draft, ...malformed.fields }]]);
          const error = yield* Effect.gen(function* read() {
            return yield* operation.run(yield* OAuthGrantRegistry);
          }).pipe(Effect.provide(fixture.context), Effect.asVoid, Effect.flip);
          expect(error).toBeInstanceOf(OAuthGrantRegistryUnavailable);
          expect(Schema.isSchemaError(error.cause)).toBe(true);
          expect(fixture.queries).toHaveLength(1);
        }),
      );
    }

    const transitions: readonly GrantRead[] = [
      {
        name: 'terminal transition',
        run: (registry) =>
          registry.setGrantStatus({
            grantId: draft.grantId,
            revokedByPrincipalId: null,
            revokeReason: null,
            status: 'revoked',
          }),
      },
      {
        name: 'binding activation',
        run: (registry) =>
          registry.setGrantBindingStatus({ authBindingId: id(6), status: 'active', tenantId: draft.tenantId }),
      },
      {
        name: 'binding disablement',
        run: (registry) =>
          registry.setGrantBindingStatus({ authBindingId: id(6), status: 'disabled', tenantId: draft.tenantId }),
      },
    ];
    for (const operation of transitions) {
      suite.effect(`${operation.name} rejects malformed ${malformed.name} before follow-up queries`, () =>
        Effect.gen(function* rejectMalformedTransition() {
          const fixture = yield* harness([[{ ...draft, authBindingId: id(6), status: 'active', ...malformed.fields }]]);
          const error = yield* Effect.gen(function* transition() {
            return yield* operation.run(yield* OAuthGrantRegistry);
          }).pipe(Effect.provide(fixture.context), Effect.asVoid, Effect.flip);
          expect(error).toBeInstanceOf(OAuthGrantRegistryUnavailable);
          expect(Schema.isSchemaError(error.cause)).toBe(true);
          expect(fixture.events).toEqual(['begin', 'select', 'rollback']);
        }),
      );
    }

    suite.effect(`draft activation rejects malformed ${malformed.name} before principal checks or writes`, () =>
      Effect.gen(function* rejectMalformedDraft() {
        const fixture = yield* harness([[], [{ ...draft, ...malformed.fields }]]);
        const error = yield* Effect.gen(function* approve() {
          return yield* (yield* OAuthGrantRegistry).approveDraftGrant({
            actorPrincipalId: draft.userPrincipalId,
            grant,
          });
        }).pipe(Effect.provide(fixture.context), Effect.asVoid, Effect.flip);
        expect(error).toBeInstanceOf(OAuthGrantRegistryUnavailable);
        expect(Schema.isSchemaError(error.cause)).toBe(true);
        expect(fixture.events).toEqual(['begin', 'execute', 'select', 'rollback']);
      }),
    );
  }

  interface GrantResultOperation extends GrantRead {
    readonly events: readonly string[];
    readonly responsesBeforeResult: readonly (readonly DriverRow[])[];
  }
  const grantResults: readonly GrantResultOperation[] = [
    {
      events: ['delete', 'insert'],
      name: 'draft insert',
      responsesBeforeResult: [[]],
      run: (registry) => registry.insertDraftGrant(grant),
    },
    {
      events: ['update'],
      name: 'access update',
      responsesBeforeResult: [],
      run: (registry) => registry.updateGrantAccess({ grantId: draft.grantId, modules: 'all', writePolicy: 'direct' }),
    },
    {
      events: ['update'],
      name: 'last-used update',
      responsesBeforeResult: [],
      run: (registry) => registry.touchGrantLastUsed(draft.grantId),
    },
    {
      events: ['begin', 'select', 'update', 'rollback'],
      name: 'terminal update',
      responsesBeforeResult: [[draft]],
      run: (registry) =>
        registry.setGrantStatus({
          grantId: draft.grantId,
          revokedByPrincipalId: null,
          revokeReason: null,
          status: 'revoked',
        }),
    },
    {
      events: ['begin', 'execute', 'select', 'select', 'update', 'rollback'],
      name: 'active update',
      responsesBeforeResult: [[], [draft], [{ kind: 'human', principalId: draft.userPrincipalId, status: 'active' }]],
      run: (registry) => registry.approveDraftGrant({ actorPrincipalId: draft.userPrincipalId, grant }),
    },
    {
      events: ['begin', 'execute', 'select', 'select', 'update', 'update', 'rollback'],
      name: 'superseded update',
      responsesBeforeResult: [
        [],
        [draft],
        [{ kind: 'human', principalId: draft.userPrincipalId, status: 'active' }],
        [{ ...draft, status: 'active' }],
      ],
      run: (registry) => registry.approveDraftGrant({ actorPrincipalId: draft.userPrincipalId, grant }),
    },
  ];
  for (const malformed of malformedFacts) {
    for (const operation of grantResults) {
      suite.effect(`${operation.name} rejects malformed returned ${malformed.name} without follow-up writes`, () =>
        Effect.gen(function* rejectMalformedResult() {
          const fixture = yield* harness([
            ...operation.responsesBeforeResult,
            [{ ...draft, authBindingId: id(6), ...malformed.fields }],
          ]);
          const error = yield* Effect.gen(function* mutate() {
            return yield* operation.run(yield* OAuthGrantRegistry);
          }).pipe(Effect.provide(fixture.context), Effect.asVoid, Effect.flip);
          expect(error).toBeInstanceOf(OAuthGrantRegistryUnavailable);
          expect(Schema.isSchemaError(error.cause)).toBe(true);
          expect(fixture.events).toEqual(operation.events);
        }),
      );
    }
  }

  suite.effect('a missing revoke reason is malformed, not historical SQL null', () =>
    Effect.gen(function* missingReason() {
      const malformed = Object.fromEntries(Object.entries(draft).filter(([key]) => key !== 'revokeReason'));
      const fixture = yield* harness([[malformed]]);
      const error = yield* Effect.gen(function* lookup() {
        return yield* (yield* OAuthGrantRegistry).findGrant(draft.grantId);
      }).pipe(Effect.provide(fixture.context), Effect.asVoid, Effect.flip);
      expect(Schema.isSchemaError(error.cause)).toBe(true);
    }),
  );

  suite.effect('valid historical SQL nulls are retained, not confused with lookup absence', () =>
    Effect.gen(function* historicalNulls() {
      const historical = { ...draft, consentId: null, sessionId: null, status: 'revoked' };
      const fixture = yield* harness([[historical]]);
      const result = yield* Effect.gen(function* lookup() {
        return yield* (yield* OAuthGrantRegistry).findGrant(draft.grantId);
      }).pipe(Effect.provide(fixture.context));
      expect(Option.getOrThrow(result)).toEqual({
        actingKind: historical.actingKind,
        actingPrincipalId: historical.actingPrincipalId,
        authBindingId: null,
        clientHost: historical.clientHost,
        clientId: historical.clientId,
        clientKind: historical.clientKind,
        clientLogoUri: null,
        clientName: historical.clientName,
        consentedAt: null,
        consentId: null,
        createdAt: historical.createdAt,
        grantId: historical.grantId,
        lastUsedAt: null,
        legalEntityId: historical.legalEntityId,
        modules: 'all',
        profileId: historical.profileId,
        revokedAt: null,
        revokedByPrincipalId: null,
        revokeReason: null,
        sessionId: null,
        status: 'revoked',
        tenantId: historical.tenantId,
        userId: historical.userId,
        userPrincipalId: historical.userPrincipalId,
        writePolicy: historical.writePolicy,
      });
    }),
  );

  for (const modulesJson of [
    [],
    [
      { access: 'read', moduleId: 'crm' },
      { access: 'write', moduleId: 'catalog' },
    ],
  ]) {
    suite.effect(`valid module array of length ${modulesJson.length} is preserved`, () =>
      Effect.gen(function* validModules() {
        const fixture = yield* harness([[{ ...draft, modulesJson }]]);
        const result = yield* Effect.gen(function* lookup() {
          return yield* (yield* OAuthGrantRegistry).findGrant(draft.grantId);
        }).pipe(Effect.provide(fixture.context));
        expect(Option.getOrThrow(result).modules).toEqual(modulesJson);
      }),
    );
  }

  suite.effect('valid non-default vocabulary and historical dates survive decoding unchanged', () =>
    Effect.gen(function* retainedVocabulary() {
      const historical = {
        ...draft,
        actingKind: 'agent',
        authBindingId: id(6),
        clientKind: 'loopback',
        clientLogoUri: 'https://client.example/logo.png',
        consentedAt: draft.createdAt,
        lastUsedAt: draft.createdAt,
        modulesJson: [],
        revokedAt: draft.createdAt,
        revokedByPrincipalId: id(9),
        revokeReason: 'password_changed',
        status: 'superseded',
        writePolicy: 'approval',
      };
      const fixture = yield* harness([[historical]]);
      const result = yield* Effect.gen(function* lookup() {
        return yield* (yield* OAuthGrantRegistry).findGrant(draft.grantId);
      }).pipe(Effect.provide(fixture.context));
      expect(Option.getOrThrow(result)).toMatchObject({
        actingKind: 'agent',
        authBindingId: id(6),
        clientKind: 'loopback',
        clientLogoUri: historical.clientLogoUri,
        consentedAt: draft.createdAt,
        lastUsedAt: draft.createdAt,
        modules: [],
        revokedAt: draft.createdAt,
        revokedByPrincipalId: id(9),
        revokeReason: 'password_changed',
        status: 'superseded',
        writePolicy: 'approval',
      });
    }),
  );

  for (const operation of grantReads.filter((read) => read.name === 'list' || read.name === 'owner projection')) {
    suite.effect(`${operation.name} rejects a malformed later row rather than projecting a partial result`, () =>
      Effect.gen(function* invalidLaterRow() {
        const fixture = yield* harness([[draft, { ...draft, grantId: id(7), revokeReason: 'unknown' }]]);
        const error = yield* Effect.gen(function* read() {
          return yield* operation.run(yield* OAuthGrantRegistry);
        }).pipe(Effect.provide(fixture.context), Effect.asVoid, Effect.flip);
        expect(Schema.isSchemaError(error.cause)).toBe(true);
        expect(fixture.queries).toHaveLength(1);
      }),
    );
  }

  suite.effect('every superseded row is validated before any derived binding writes', () =>
    Effect.gen(function* invalidLaterSupersededRow() {
      const fixture = yield* harness([
        [],
        [draft],
        [{ kind: 'human', principalId: draft.userPrincipalId, status: 'active' }],
        [{ ...draft, status: 'active' }],
        [
          { ...draft, authBindingId: id(6), status: 'superseded' },
          { ...draft, authBindingId: id(8), grantId: id(7), modulesJson: null, status: 'superseded' },
        ],
      ]);
      const error = yield* Effect.gen(function* approve() {
        return yield* (yield* OAuthGrantRegistry).approveDraftGrant({ actorPrincipalId: draft.userPrincipalId, grant });
      }).pipe(Effect.provide(fixture.context), Effect.asVoid, Effect.flip);
      expect(Schema.isSchemaError(error.cause)).toBe(true);
      expect(fixture.events).toEqual(['begin', 'execute', 'select', 'select', 'update', 'update', 'rollback']);
      expect(fixture.queries.every((query) => query.table !== principalAuthBindings)).toBe(true);
    }),
  );

  suite.effect('valid profile and owner projections keep exactly their existing public shape', () =>
    Effect.gen(function* validProjections() {
      const fixture = yield* harness([[draft], [{ ...draft, status: 'revoked' }]]);
      yield* Effect.gen(function* read() {
        const registry = yield* OAuthGrantRegistry;
        expect(Option.getOrThrow(yield* registry.findPreviousProfileId(draft))).toBe(draft.profileId);
        expect(
          yield* registry.owners({
            grantIds: [draft.grantId],
            legalEntityId: draft.legalEntityId,
            tenantId: draft.tenantId,
          }),
        ).toEqual([
          {
            grantId: draft.grantId,
            legalEntityId: draft.legalEntityId,
            tenantId: draft.tenantId,
            userPrincipalId: draft.userPrincipalId,
          },
        ]);
      }).pipe(Effect.provide(fixture.context));
    }),
  );

  suite.effect('an empty result still means absence for every optional lookup or mutation', () =>
    Effect.gen(function* absentResults() {
      const fixture = yield* harness([]);
      yield* Effect.gen(function* absence() {
        const registry = yield* OAuthGrantRegistry;
        expect(Option.isNone(yield* registry.findGrant(draft.grantId))).toBe(true);
        expect(Option.isNone(yield* registry.findSessionGrant(draft))).toBe(true);
        expect(Option.isNone(yield* registry.findPreviousProfileId(draft))).toBe(true);
        expect(
          Option.isNone(
            yield* registry.updateGrantAccess({ grantId: draft.grantId, modules: 'all', writePolicy: 'direct' }),
          ),
        ).toBe(true);
        expect(
          Option.isNone(
            yield* registry.setGrantStatus({
              grantId: draft.grantId,
              revokedByPrincipalId: null,
              revokeReason: null,
              status: 'revoked',
            }),
          ),
        ).toBe(true);
        expect(
          Option.isNone(yield* registry.approveDraftGrant({ actorPrincipalId: draft.userPrincipalId, grant })),
        ).toBe(true);
        expect(yield* registry.touchGrantLastUsed(draft.grantId)).toBe(false);
        expect(yield* registry.listGrants({ tenantId: draft.tenantId })).toEqual([]);
        expect(
          yield* registry.owners({
            grantIds: [draft.grantId],
            legalEntityId: draft.legalEntityId,
            tenantId: draft.tenantId,
          }),
        ).toEqual([]);
        yield* registry.setGrantBindingStatus({ authBindingId: id(6), status: 'disabled', tenantId: draft.tenantId });
      }).pipe(Effect.provide(fixture.context));
    }),
  );

  suite.effect('an empty insert result remains an unavailable error, not an absent grant', () =>
    Effect.gen(function* emptyInsert() {
      const fixture = yield* harness([]);
      const error = yield* Effect.gen(function* insert() {
        return yield* (yield* OAuthGrantRegistry).insertDraftGrant(grant);
      }).pipe(Effect.provide(fixture.context), Effect.asVoid, Effect.flip);
      expect(error).toBeInstanceOf(OAuthGrantRegistryUnavailable);
      expect(error.cause).toBe('Draft insert returned no retained grant');
    }),
  );

  suite.effect('database failure retains its original cause through the transaction boundary', () =>
    Effect.gen(function* retainedDriverFailure() {
      const fixture = yield* harness(['fail']);
      const error = yield* Effect.gen(function* transition() {
        return yield* (yield* OAuthGrantRegistry).setGrantStatus({
          grantId: draft.grantId,
          revokedByPrincipalId: null,
          revokeReason: null,
          status: 'revoked',
        });
      }).pipe(Effect.provide(fixture.context), Effect.asVoid, Effect.flip);
      expect(error).toBeInstanceOf(OAuthGrantRegistryUnavailable);
      expect(error.cause).toBeInstanceOf(EffectDrizzleQueryError);
      expect(error.cause).toHaveProperty('cause', Cause.fail(fixture.failure));
      expect(fixture.failure.reason.cause).toBe(fixture.driverCause);
      expect(fixture.events).toEqual(['begin', 'select', 'rollback']);
    }),
  );

  suite.effect('captures Core once; session correlation and TTL remain in the actual native query', () =>
    Effect.gen(function* sessionCorrelation() {
      const fixture = yield* harness([[draft]]);
      const registry = Context.get(fixture.context, OAuthGrantRegistry);
      const result = yield* registry.findSessionGrant({ sessionId: 'real-session', userId: 'real-user' });
      expect(Option.getOrThrow(result)).toMatchObject({
        consentId: draft.consentId,
        grantId: draft.grantId,
        sessionId: draft.sessionId,
      });
      const query = sqlOf(fixture.queries[0]);
      expect(query.sql).toContain('"session_id"');
      expect(query.sql).toContain('"user_id"');
      expect(query.sql).toContain("interval '30 minutes'");
      expect(query.params).toContain('real-session');
      expect(query.params).toContain('real-user');
    }),
  );

  suite.effect('invalid grant identifiers are absent without any database work', () =>
    Effect.gen(function* invalidId() {
      const fixture = yield* harness([]);
      const result = yield* Effect.gen(function* lookup() {
        return yield* (yield* OAuthGrantRegistry).findGrant('not-a-uuid');
      }).pipe(Effect.provide(fixture.context));
      expect(Option.isNone(result)).toBe(true);
      expect(fixture.queries).toHaveLength(0);
    }),
  );

  suite.effect('grant revoke disables the exact derived binding in the same transaction before terminal status', () =>
    Effect.gen(function* revokeAtomicity() {
      const active = { ...draft, authBindingId: id(6), status: 'active' };
      const fixture = yield* harness([[active], [], [{ ...active, status: 'revoked' }]]);
      yield* Effect.gen(function* revoke() {
        return yield* (yield* OAuthGrantRegistry).setGrantStatus({
          grantId: draft.grantId,
          revokedByPrincipalId: id(4),
          revokeReason: 'user',
          status: 'revoked',
        });
      }).pipe(Effect.provide(fixture.context));
      expect(fixture.events).toEqual(['begin', 'select', 'update', 'update', 'commit']);
      expect(fixture.queries[1]?.table).toBe(principalAuthBindings);
      expect(parameterFor(fixture.queries[1], 'revoked_at')).toBe(null);
      expect(parameterFor(fixture.queries[1], 'status')).toBe('disabled');
      const binding = sqlOf(fixture.queries[1]);
      expect(binding.params).toEqual(
        expect.arrayContaining([
          draft.tenantId,
          id(6),
          'better_auth',
          'oauth_grant',
          draft.grantId,
          draft.actingPrincipalId,
          'active',
        ]),
      );
      expect(fixture.queries[2]?.table).toBe(oauthConnectionGrants);
    }),
  );

  suite.effect('binding-write failure rolls back and never reports a terminal grant commit', () =>
    Effect.gen(function* failedRevoke() {
      const fixture = yield* harness([[{ ...draft, authBindingId: id(6), status: 'active' }], 'fail']);
      const result = yield* Effect.gen(function* revoke() {
        return yield* (yield* OAuthGrantRegistry).setGrantStatus({
          grantId: draft.grantId,
          revokedByPrincipalId: null,
          revokeReason: null,
          status: 'revoked',
        });
      }).pipe(Effect.provide(fixture.context), Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      expect(fixture.events).toEqual(['begin', 'select', 'update', 'rollback']);
    }),
  );

  suite.effect(
    'activation uses retained principals, preserves binding id and supersedes only the exact tenant family',
    () =>
      Effect.gen(function* activate() {
        const active = { ...draft, authBindingId: id(6), status: 'active' };
        const old = { ...active, authBindingId: id(8), grantId: id(7) };
        const fixture = yield* harness([
          [],
          [draft],
          [{ kind: 'human', principalId: draft.userPrincipalId, status: 'active' }],
          [active],
          [old],
          [],
          [],
        ]);
        const result = yield* Effect.gen(function* approve() {
          return yield* (yield* OAuthGrantRegistry).approveDraftGrant({
            actorPrincipalId: draft.userPrincipalId,
            grant,
          });
        }).pipe(Effect.provide(fixture.context));
        expect(Option.isSome(result)).toBe(true);
        expect(fixture.events.at(-1)).toBe('commit');
        expect(fixture.queries[2]?.table).toBe(principals);
        expect(sqlOf(fixture.queries[2]).sql).toContain('for share');
        const family = sqlOf(fixture.queries[4]);
        expect(family.params).toEqual(
          expect.arrayContaining([
            draft.tenantId,
            draft.actingPrincipalId,
            draft.clientId,
            draft.legalEntityId,
            draft.userId,
          ]),
        );
        const issued = fixture.queries.at(6);
        const activatedBindingId = parameterFor(fixture.queries[3], 'auth_binding_id');
        expect(activatedBindingId).toEqual(expect.any(String));
        expect(parameterFor(issued, 'binding_revision')).toBe(1);
        expect(parameterFor(issued, 'provider_subject_id')).toBe(draft.grantId);
        expect(parameterFor(issued, 'subject_type')).toBe('oauth_grant');
        expect(parameterFor(issued, 'principal_auth_binding_id')).toBe(activatedBindingId);
      }),
  );

  suite.effect('inactive principals cannot produce a binding even in a pre-admission callback', () =>
    Effect.gen(function* inactivePrincipal() {
      const fixture = yield* harness([
        [],
        [draft],
        [{ kind: 'human', principalId: draft.userPrincipalId, status: 'disabled' }],
      ]);
      const result = yield* Effect.gen(function* approve() {
        return yield* (yield* OAuthGrantRegistry).approveDraftGrant({ actorPrincipalId: draft.userPrincipalId, grant });
      }).pipe(Effect.provide(fixture.context));
      expect(Option.isNone(result)).toBe(true);
      expect(fixture.queries.some((query) => query.kind === 'insert')).toBe(false);
    }),
  );

  suite.effect('repeated terminal cleanup preserves attribution and only defensively disables an active binding', () =>
    Effect.gen(function* terminalCleanup() {
      const terminal = {
        ...draft,
        authBindingId: id(6),
        revokedByPrincipalId: id(9),
        revokeReason: 'user',
        status: 'revoked',
      };
      const fixture = yield* harness([[terminal], []]);
      const result = yield* Effect.gen(function* revoke() {
        return yield* (yield* OAuthGrantRegistry).setGrantStatus({
          grantId: draft.grantId,
          revokedByPrincipalId: null,
          revokeReason: null,
          status: 'revoked',
        });
      }).pipe(Effect.provide(fixture.context));
      expect(Option.getOrThrow(result)).toMatchObject({
        revokedByPrincipalId: id(9),
        revokeReason: 'user',
        status: 'revoked',
      });
      expect(fixture.queries).toHaveLength(2);
      expect(fixture.queries[1]?.table).toBe(principalAuthBindings);
      expect(sqlOf(fixture.queries[1]).params).toContain('active');
      expect(sqlOf(fixture.queries[1]).sql).toContain('is null');
      expect(fixture.events.at(-1)).toBe('commit');
    }),
  );

  suite.effect('terminal grants cannot reactivate a binding before admission', () =>
    Effect.gen(function* terminalBinding() {
      const fixture = yield* harness([[{ ...draft, authBindingId: id(6), status: 'revoked' }]]);
      const result = yield* Effect.gen(function* reactivate() {
        yield* (yield* OAuthGrantRegistry).setGrantBindingStatus({
          authBindingId: id(6),
          status: 'active',
          tenantId: draft.tenantId,
        });
      }).pipe(Effect.provide(fixture.context), Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      expect(fixture.events).toEqual(['begin', 'select', 'rollback']);
    }),
  );

  suite.effect('binding creation failure takes the activation transaction rollback path', () =>
    Effect.gen(function* activationFailure() {
      const fixture = yield* harness([
        [],
        [draft],
        [{ kind: 'human', principalId: draft.userPrincipalId, status: 'active' }],
        [{ ...draft, status: 'active' }],
        [],
        'fail',
      ]);
      const result = yield* Effect.gen(function* approve() {
        return yield* (yield* OAuthGrantRegistry).approveDraftGrant({ actorPrincipalId: draft.userPrincipalId, grant });
      }).pipe(Effect.provide(fixture.context), Effect.exit);
      expect(Exit.isFailure(result)).toBe(true);
      expect(fixture.events.at(-1)).toBe('rollback');
      expect(fixture.events).not.toContain('commit');
      expect(fixture.queries.at(-1)?.table).toBe(principalAuthBindings);
      expect(sqlOf(fixture.queries[1]).sql).toContain("interval '30 minutes'");
    }),
  );

  suite.effect('management lists preserve tenant/self/admin filters, default non-drafts, and limit', () =>
    Effect.gen(function* managementFilters() {
      const fixture = yield* harness([[]]);
      yield* Effect.gen(function* list() {
        return yield* (yield* OAuthGrantRegistry).listGrants({
          legalEntityId: draft.legalEntityId,
          tenantId: draft.tenantId,
          userId: draft.userId,
          userPrincipalId: draft.userPrincipalId,
        });
      }).pipe(Effect.provide(fixture.context));
      const query = sqlOf(fixture.queries[0]);
      expect(query.params).toEqual(
        expect.arrayContaining([draft.tenantId, draft.legalEntityId, draft.userId, draft.userPrincipalId, 'draft']),
      );
      expect(query.sql).toContain('<>');
      expect(query.sql).toMatch(/limit \$\d+$/u);
      expect(query.params.at(-1)).toBe(500);
      expect(getTableName(oauthConnectionGrants)).toBe('oauth_connection_grants');
    }),
  );
});
