import { getTableName } from 'drizzle-orm';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { Effect, Exit, Layer, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import type { OAuthGrantRecord } from '../../src/auth/oauth-grant-registry-contract.ts';
import { OAuthGrantRegistryLive } from '../../src/auth/oauth-grant-registry-live.ts';
import { OAuthGrantRegistry } from '../../src/auth/oauth-grant-registry-service.ts';
import { OAuthGrantRegistryUnavailable } from '../../src/auth/oauth-grant-registry-unavailable.ts';
import { CoreDatabase } from '../../src/db/client.ts';
import { oauthConnectionGrants, principalAuthBindings, principals } from '../../src/db/schema.ts';

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
  createdAt: new Date('2026-10-25T10:00:00Z'),
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
type QueryValues =
  | Partial<typeof oauthConnectionGrants.$inferInsert>
  | Partial<typeof principalAuthBindings.$inferInsert>;
interface ScriptedExecutor {
  readonly delete: (table: QueryTable) => Fluent;
  readonly execute: (predicate: SQL) => Fluent;
  readonly insert: (table: QueryTable) => Fluent;
  readonly select: () => Fluent;
  readonly transaction: <A>(
    body: (transaction: ScriptedExecutor) => Effect.Effect<A, unknown>,
  ) => Effect.Effect<A, unknown>;
  readonly update: (table: QueryTable) => Fluent;
}
interface Query {
  readonly kind: string;
  limit?: number;
  lock?: string;
  predicate?: SQL | undefined;
  table?: QueryTable | undefined;
  values?: QueryValues;
}
interface Fluent extends Effect.Effect<readonly unknown[], string> {
  readonly for: (lock: string) => Fluent;
  readonly from: (table: QueryTable) => Fluent;
  readonly limit: (limit: number) => Fluent;
  readonly orderBy: (...order: SQL[]) => Fluent;
  readonly returning: (selection?: QueryValues) => Fluent;
  readonly set: (values: QueryValues) => Fluent;
  readonly values: (values: QueryValues) => Fluent;
  readonly where: (predicate: SQL | undefined) => Fluent;
}
const harness = (responses: readonly (readonly unknown[] | 'fail')[]) => {
  const queries: Query[] = [];
  const events: string[] = [];
  let cursor = 0;
  const query = (kind: string, table?: QueryTable): Fluent => {
    const observation: Query = { kind, table };
    const fluent: Fluent = Object.assign(
      Effect.suspend(() => {
        queries.push(observation);
        events.push(kind);
        const response = responses[cursor];
        cursor += 1;
        return response === 'fail' ? Effect.fail('driver-failed') : Effect.succeed(response ?? []);
      }),
      {
        for: (value: string): Fluent => {
          observation.lock = value;
          return fluent;
        },
        from: (value: QueryTable): Fluent => {
          observation.table = value;
          return fluent;
        },
        limit: (value: number): Fluent => {
          observation.limit = value;
          return fluent;
        },
        orderBy: (): Fluent => fluent,
        returning: (): Fluent => fluent,
        set: (value: QueryValues): Fluent => {
          observation.values = value;
          return fluent;
        },
        values: (value: QueryValues): Fluent => {
          observation.values = value;
          return fluent;
        },
        where: (value: SQL | undefined): Fluent => {
          observation.predicate = value;
          return fluent;
        },
      },
    );
    return fluent;
  };
  const executor: ScriptedExecutor = {
    delete: (table: QueryTable) => query('delete', table),
    execute: (predicate: SQL) => {
      const result = query('execute');
      return result.where(predicate);
    },
    insert: (table: QueryTable) => query('insert', table),
    select: () => query('select'),
    transaction: <A>(body: (transaction: ScriptedExecutor) => Effect.Effect<A, unknown>) =>
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
    update: (table: QueryTable) => query('update', table),
  };
  // SAFETY: the scripted unit driver implements only this producer's exercised operations, not the full Drizzle API.
  // eslint-disable-next-line typescript/no-unsafe-type-assertion -- Test-only driver boundary; production always receives the real CoreDatabase executor.
  const database = { executor } as never;
  const layer = OAuthGrantRegistryLive.pipe(Layer.provide(Layer.succeed(CoreDatabase, database)));
  return { events, layer, queries };
};
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
for (const malformed of malformedFacts) {
  for (const operation of grantReads) {
    it.effect(`${operation.name} rejects malformed ${malformed.name} as a typed storage failure`, () =>
      Effect.gen(function* rejectMalformedProjection() {
        const fixture = harness([[{ ...draft, ...malformed.fields }]]);
        const error = yield* Effect.gen(function* read() {
          return yield* operation.run(yield* OAuthGrantRegistry);
        }).pipe(Effect.provide(fixture.layer), Effect.flip);
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
    it.effect(`${operation.name} rejects malformed ${malformed.name} before follow-up queries`, () =>
      Effect.gen(function* rejectMalformedTransition() {
        const fixture = harness([[{ ...draft, authBindingId: id(6), status: 'active', ...malformed.fields }]]);
        const error = yield* Effect.gen(function* transition() {
          return yield* operation.run(yield* OAuthGrantRegistry);
        }).pipe(Effect.provide(fixture.layer), Effect.flip);
        expect(error).toBeInstanceOf(OAuthGrantRegistryUnavailable);
        expect(Schema.isSchemaError(error.cause)).toBe(true);
        expect(fixture.events).toEqual(['begin', 'select', 'rollback']);
      }),
    );
  }

  it.effect(`draft activation rejects malformed ${malformed.name} before principal checks or writes`, () =>
    Effect.gen(function* rejectMalformedDraft() {
      const fixture = harness([[], [{ ...draft, ...malformed.fields }]]);
      const error = yield* Effect.gen(function* approve() {
        return yield* (yield* OAuthGrantRegistry).approveDraftGrant({ actorPrincipalId: draft.userPrincipalId, grant });
      }).pipe(Effect.provide(fixture.layer), Effect.flip);
      expect(error).toBeInstanceOf(OAuthGrantRegistryUnavailable);
      expect(Schema.isSchemaError(error.cause)).toBe(true);
      expect(fixture.events).toEqual(['begin', 'execute', 'select', 'rollback']);
    }),
  );
}

interface GrantResultOperation extends GrantRead {
  readonly events: readonly string[];
  readonly responsesBeforeResult: readonly (readonly unknown[])[];
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
    it.effect(`${operation.name} rejects malformed returned ${malformed.name} without follow-up writes`, () =>
      Effect.gen(function* rejectMalformedResult() {
        const fixture = harness([
          ...operation.responsesBeforeResult,
          [{ ...draft, authBindingId: id(6), ...malformed.fields }],
        ]);
        const error = yield* Effect.gen(function* mutate() {
          return yield* operation.run(yield* OAuthGrantRegistry);
        }).pipe(Effect.provide(fixture.layer), Effect.flip);
        expect(error).toBeInstanceOf(OAuthGrantRegistryUnavailable);
        expect(Schema.isSchemaError(error.cause)).toBe(true);
        expect(fixture.events).toEqual(operation.events);
      }),
    );
  }
}

it.effect('a missing revoke reason is malformed, not historical SQL null', () =>
  Effect.gen(function* missingReason() {
    const malformed = Object.fromEntries(Object.entries(draft).filter(([key]) => key !== 'revokeReason'));
    const fixture = harness([[malformed]]);
    const error = yield* Effect.gen(function* lookup() {
      return yield* (yield* OAuthGrantRegistry).findGrant(draft.grantId);
    }).pipe(Effect.provide(fixture.layer), Effect.flip);
    expect(Schema.isSchemaError(error.cause)).toBe(true);
  }),
);

it.effect('valid historical SQL nulls are retained, not confused with lookup absence', () =>
  Effect.gen(function* historicalNulls() {
    const historical = { ...draft, consentId: null, sessionId: null, status: 'revoked' };
    const fixture = harness([[historical]]);
    const result = yield* Effect.gen(function* lookup() {
      return yield* (yield* OAuthGrantRegistry).findGrant(draft.grantId);
    }).pipe(Effect.provide(fixture.layer));
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
  it.effect(`valid module array of length ${modulesJson.length} is preserved`, () =>
    Effect.gen(function* validModules() {
      const fixture = harness([[{ ...draft, modulesJson }]]);
      const result = yield* Effect.gen(function* lookup() {
        return yield* (yield* OAuthGrantRegistry).findGrant(draft.grantId);
      }).pipe(Effect.provide(fixture.layer));
      expect(Option.getOrThrow(result).modules).toEqual(modulesJson);
    }),
  );
}

it.effect('valid non-default vocabulary and historical dates survive decoding unchanged', () =>
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
    const fixture = harness([[historical]]);
    const result = yield* Effect.gen(function* lookup() {
      return yield* (yield* OAuthGrantRegistry).findGrant(draft.grantId);
    }).pipe(Effect.provide(fixture.layer));
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
  it.effect(`${operation.name} rejects a malformed later row rather than projecting a partial result`, () =>
    Effect.gen(function* invalidLaterRow() {
      const fixture = harness([[draft, { ...draft, grantId: id(7), revokeReason: 'unknown' }]]);
      const error = yield* Effect.gen(function* read() {
        return yield* operation.run(yield* OAuthGrantRegistry);
      }).pipe(Effect.provide(fixture.layer), Effect.flip);
      expect(Schema.isSchemaError(error.cause)).toBe(true);
      expect(fixture.queries).toHaveLength(1);
    }),
  );
}

it.effect('every superseded row is validated before any derived binding writes', () =>
  Effect.gen(function* invalidLaterSupersededRow() {
    const fixture = harness([
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
    }).pipe(Effect.provide(fixture.layer), Effect.flip);
    expect(Schema.isSchemaError(error.cause)).toBe(true);
    expect(fixture.events).toEqual(['begin', 'execute', 'select', 'select', 'update', 'update', 'rollback']);
    expect(fixture.queries.every((query) => query.table !== principalAuthBindings)).toBe(true);
  }),
);

it.effect('valid profile and owner projections keep exactly their existing public shape', () =>
  Effect.gen(function* validProjections() {
    const fixture = harness([[draft], [{ ...draft, status: 'revoked' }]]);
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
    }).pipe(Effect.provide(fixture.layer));
  }),
);

it.effect('an empty result still means absence for every optional lookup or mutation', () =>
  Effect.gen(function* absentResults() {
    const fixture = harness([]);
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
      expect(Option.isNone(yield* registry.approveDraftGrant({ actorPrincipalId: draft.userPrincipalId, grant }))).toBe(
        true,
      );
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
    }).pipe(Effect.provide(fixture.layer));
  }),
);

it.effect('an empty insert result remains an unavailable error, not an absent grant', () =>
  Effect.gen(function* emptyInsert() {
    const fixture = harness([]);
    const error = yield* Effect.gen(function* insert() {
      return yield* (yield* OAuthGrantRegistry).insertDraftGrant(grant);
    }).pipe(Effect.provide(fixture.layer), Effect.flip);
    expect(error).toBeInstanceOf(OAuthGrantRegistryUnavailable);
    expect(error.cause).toBe('Draft insert returned no retained grant');
  }),
);

it.effect('database failure retains its original cause through the transaction boundary', () =>
  Effect.gen(function* retainedDriverFailure() {
    const fixture = harness(['fail']);
    const error = yield* Effect.gen(function* transition() {
      return yield* (yield* OAuthGrantRegistry).setGrantStatus({
        grantId: draft.grantId,
        revokedByPrincipalId: null,
        revokeReason: null,
        status: 'revoked',
      });
    }).pipe(Effect.provide(fixture.layer), Effect.flip);
    expect(error).toBeInstanceOf(OAuthGrantRegistryUnavailable);
    expect(error.cause).toBe('driver-failed');
    expect(fixture.events).toEqual(['begin', 'select', 'rollback']);
  }),
);

const sqlOf = (query: Query | undefined) => {
  if (query?.predicate === undefined) {
    throw new Error('expected a SQL predicate');
  }
  return new PgDialect().sqlToQuery(query.predicate);
};

it.effect('captures Core once; session correlation and TTL remain in the actual native query', () =>
  Effect.gen(function* sessionCorrelation() {
    const fixture = harness([[draft]]);
    const registry = yield* Effect.scoped(Layer.build(fixture.layer)).pipe(Effect.map((context) => context));
    const result = yield* Effect.gen(function* lookup() {
      return yield* (yield* OAuthGrantRegistry).findSessionGrant({ sessionId: 'real-session', userId: 'real-user' });
    }).pipe(Effect.provide(registry));
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

it.effect('invalid grant identifiers are absent without any database work', () =>
  Effect.gen(function* invalidId() {
    const fixture = harness([]);
    const result = yield* Effect.gen(function* lookup() {
      return yield* (yield* OAuthGrantRegistry).findGrant('not-a-uuid');
    }).pipe(Effect.provide(fixture.layer));
    expect(Option.isNone(result)).toBe(true);
    expect(fixture.queries).toHaveLength(0);
  }),
);

it.effect('grant revoke disables the exact derived binding in the same transaction before terminal status', () =>
  Effect.gen(function* revokeAtomicity() {
    const active = { ...draft, authBindingId: id(6), status: 'active' };
    const fixture = harness([[active], [], [{ ...active, status: 'revoked' }]]);
    yield* Effect.gen(function* revoke() {
      return yield* (yield* OAuthGrantRegistry).setGrantStatus({
        grantId: draft.grantId,
        revokedByPrincipalId: id(4),
        revokeReason: 'user',
        status: 'revoked',
      });
    }).pipe(Effect.provide(fixture.layer));
    expect(fixture.events).toEqual(['begin', 'select', 'update', 'update', 'commit']);
    expect(fixture.queries[1]?.table).toBe(principalAuthBindings);
    expect(fixture.queries[1]?.values).toMatchObject({ revokedAt: null, status: 'disabled' });
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

it.effect('binding-write failure rolls back and never reports a terminal grant commit', () =>
  Effect.gen(function* failedRevoke() {
    const fixture = harness([[{ ...draft, authBindingId: id(6), status: 'active' }], 'fail']);
    const result = yield* Effect.gen(function* revoke() {
      return yield* (yield* OAuthGrantRegistry).setGrantStatus({
        grantId: draft.grantId,
        revokedByPrincipalId: null,
        revokeReason: null,
        status: 'revoked',
      });
    }).pipe(Effect.provide(fixture.layer), Effect.exit);
    expect(Exit.isFailure(result)).toBe(true);
    expect(fixture.events).toEqual(['begin', 'select', 'update', 'rollback']);
  }),
);

it.effect('activation uses retained principals, preserves binding id and supersedes only the exact tenant family', () =>
  Effect.gen(function* activate() {
    const active = { ...draft, authBindingId: id(6), status: 'active' };
    const old = { ...active, authBindingId: id(8), grantId: id(7) };
    const fixture = harness([
      [],
      [draft],
      [{ kind: 'human', principalId: draft.userPrincipalId, status: 'active' }],
      [active],
      [old],
      [],
      [],
    ]);
    const result = yield* Effect.gen(function* approve() {
      return yield* (yield* OAuthGrantRegistry).approveDraftGrant({ actorPrincipalId: draft.userPrincipalId, grant });
    }).pipe(Effect.provide(fixture.layer));
    expect(Option.isSome(result)).toBe(true);
    expect(fixture.events.at(-1)).toBe('commit');
    expect(fixture.queries[2]?.table).toBe(principals);
    expect(fixture.queries[2]?.lock).toBe('share');
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
    const issued = fixture.queries[6]?.values;
    const activated = fixture.queries[3]?.values;
    expect(issued).toMatchObject({ bindingRevision: 1, providerSubjectId: draft.grantId, subjectType: 'oauth_grant' });
    expect(issued).toHaveProperty(
      'principalAuthBindingId',
      activated && 'authBindingId' in activated ? activated.authBindingId : undefined,
    );
  }),
);

it.effect('inactive principals cannot produce a binding even in a pre-admission callback', () =>
  Effect.gen(function* inactivePrincipal() {
    const fixture = harness([[], [draft], [{ kind: 'human', principalId: draft.userPrincipalId, status: 'disabled' }]]);
    const result = yield* Effect.gen(function* approve() {
      return yield* (yield* OAuthGrantRegistry).approveDraftGrant({ actorPrincipalId: draft.userPrincipalId, grant });
    }).pipe(Effect.provide(fixture.layer));
    expect(Option.isNone(result)).toBe(true);
    expect(fixture.queries.some((query) => query.kind === 'insert')).toBe(false);
  }),
);

it.effect('repeated terminal cleanup preserves attribution and only defensively disables an active binding', () =>
  Effect.gen(function* terminalCleanup() {
    const terminal = {
      ...draft,
      authBindingId: id(6),
      revokedByPrincipalId: id(9),
      revokeReason: 'user',
      status: 'revoked',
    };
    const fixture = harness([[terminal], []]);
    const result = yield* Effect.gen(function* revoke() {
      return yield* (yield* OAuthGrantRegistry).setGrantStatus({
        grantId: draft.grantId,
        revokedByPrincipalId: null,
        revokeReason: null,
        status: 'revoked',
      });
    }).pipe(Effect.provide(fixture.layer));
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

it.effect('terminal grants cannot reactivate a binding before admission', () =>
  Effect.gen(function* terminalBinding() {
    const fixture = harness([[{ ...draft, authBindingId: id(6), status: 'revoked' }]]);
    const result = yield* Effect.gen(function* reactivate() {
      yield* (yield* OAuthGrantRegistry).setGrantBindingStatus({
        authBindingId: id(6),
        status: 'active',
        tenantId: draft.tenantId,
      });
    }).pipe(Effect.provide(fixture.layer), Effect.exit);
    expect(Exit.isFailure(result)).toBe(true);
    expect(fixture.events).toEqual(['begin', 'select', 'rollback']);
  }),
);

it.effect('binding creation failure takes the activation transaction rollback path', () =>
  Effect.gen(function* activationFailure() {
    const fixture = harness([
      [],
      [draft],
      [{ kind: 'human', principalId: draft.userPrincipalId, status: 'active' }],
      [{ ...draft, status: 'active' }],
      [],
      'fail',
    ]);
    const result = yield* Effect.gen(function* approve() {
      return yield* (yield* OAuthGrantRegistry).approveDraftGrant({ actorPrincipalId: draft.userPrincipalId, grant });
    }).pipe(Effect.provide(fixture.layer), Effect.exit);
    expect(Exit.isFailure(result)).toBe(true);
    expect(fixture.events.at(-1)).toBe('rollback');
    expect(fixture.events).not.toContain('commit');
    expect(fixture.queries.at(-1)?.table).toBe(principalAuthBindings);
    expect(sqlOf(fixture.queries[1]).sql).toContain("interval '30 minutes'");
  }),
);

it.effect('management lists preserve tenant/self/admin filters, default non-drafts, and limit', () =>
  Effect.gen(function* managementFilters() {
    const fixture = harness([[]]);
    yield* Effect.gen(function* list() {
      return yield* (yield* OAuthGrantRegistry).listGrants({
        legalEntityId: draft.legalEntityId,
        tenantId: draft.tenantId,
        userId: draft.userId,
        userPrincipalId: draft.userPrincipalId,
      });
    }).pipe(Effect.provide(fixture.layer));
    const query = sqlOf(fixture.queries[0]);
    expect(query.params).toEqual(
      expect.arrayContaining([draft.tenantId, draft.legalEntityId, draft.userId, draft.userPrincipalId, 'draft']),
    );
    expect(query.sql).toContain('<>');
    expect(fixture.queries[0]?.limit).toBe(500);
    expect(getTableName(oauthConnectionGrants)).toBe('oauth_connection_grants');
  }),
);
