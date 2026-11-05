import { Effect, Exit, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { AuthorizationError, ConnectionError, SqlError } from 'effect/sql/SqlError';

import { lockActionAccessFence } from '../../src/access/approvals/action-mandate-dispatch.ts';
import { ActionPermissionCheckError } from '../../src/actions/errors.ts';
import { TrustedPrincipalContextSchema } from '../../src/actions/principal-context.ts';
import type { OperationalScope } from '../../src/operations/context.ts';
import { makeTestDatabase } from '../support/database.ts';

const tenantId = '51000000-0000-4000-8000-000000000001';
const scopeId = '52000000-0000-4000-8000-000000000001';
const companyScopeId = '52000000-0000-4000-8000-000000000002';
const legalEntityId = '55000000-0000-4000-8000-000000000001';
const scope: OperationalScope = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '53000000-0000-4000-8000-000000000001',
    authContextRef: 'better-auth-session:action-access-fence',
    authMethod: 'session',
    principalId: '54000000-0000-4000-8000-000000000001',
    tenantId,
  }),
  correlationId: 'correlation-fence',
};

const companyScope: OperationalScope = {
  ...Schema.decodeSync(TrustedPrincipalContextSchema)({
    authBindingId: '53000000-0000-4000-8000-000000000001',
    authContextRef: 'better-auth-session:action-access-fence',
    authMethod: 'session',
    legalEntityId,
    principalId: '54000000-0000-4000-8000-000000000001',
    tenantId,
  }),
  correlationId: 'correlation-fence',
};

interface FenceScript {
  /** The fence state answered per scope id; any scope it does not name answers `fenceRows`. */
  readonly fenceByScope?: Readonly<Record<string, readonly object[]>>;
  readonly fenceRows?: readonly object[];
  readonly lockFailure?: SqlError;
  readonly scopeFailure?: SqlError;
}

const recordedDatabase = (script: FenceScript) =>
  Effect.gen(function* recordedDatabaseEffect() {
    const statements: { readonly params: readonly unknown[]; readonly sql: string }[] = [];
    const database = yield* makeTestDatabase((statement, params) => {
      statements.push({ params, sql: statement });
      if (statement.includes('lock_access_scope_fence')) {
        const lockedScope = String(params[1]);
        return script.lockFailure === undefined
          ? Effect.succeed(script.fenceByScope?.[lockedScope] ?? script.fenceRows ?? [{ state: 'Ready' }])
          : Effect.fail(script.lockFailure);
      }
      if (statement.includes('"core"."access_scopes"')) {
        // The tenant context is the scope without a company; a company question names its company.
        const resolved = statement.includes('is null') ? scopeId : companyScopeId;
        return script.scopeFailure === undefined
          ? Effect.succeed([{ scope_id: resolved }])
          : Effect.fail(script.scopeFailure);
      }
      return Effect.succeed([]);
    });
    return { database, statements };
  });

const lockFence = (script: FenceScript) =>
  Effect.gen(function* lockFenceEffect() {
    const { database, statements } = yield* recordedDatabase(script);
    const exit = yield* database
      .transaction((transaction) => lockActionAccessFence(transaction, scope, 'forbidden', false))
      .pipe(Effect.exit);
    return { exit, statements };
  });

const lockCompanyFence = (script: FenceScript) =>
  Effect.gen(function* lockCompanyFenceEffect() {
    const { database, statements } = yield* recordedDatabase(script);
    const exit = yield* database
      .transaction((transaction) => lockActionAccessFence(transaction, companyScope, 'required', false))
      .pipe(Effect.exit);
    return { exit, locks: statements.filter(({ sql }) => sql.includes('lock_access_scope_fence')) };
  });

const expectFenceUnavailable = (script: FenceScript) =>
  Effect.gen(function* expectFenceUnavailableEffect() {
    const { database } = yield* recordedDatabase(script);
    const failure = yield* database
      .transaction((transaction) => lockActionAccessFence(transaction, scope, 'forbidden', false))
      .pipe(Effect.flip);
    expect(Schema.is(ActionPermissionCheckError)(failure)).toBe(true);
    if (Schema.is(ActionPermissionCheckError)(failure)) {
      expect(failure.code).toBe('action_permission_check_failed');
    }
  });

it.effect('locks the access scope fence only through the trusted routine, bound to tenant and scope', () =>
  Effect.gen(function* trustedFenceLock() {
    const { exit, statements } = yield* lockFence({});
    expect(Exit.isSuccess(exit)).toBe(true);
    const locks = statements.filter(({ sql }) => sql.includes('lock_access_scope_fence'));
    expect(locks).toEqual([
      {
        params: [tenantId, scopeId],
        sql: 'select trust.lock_access_scope_fence($1::uuid, $2::uuid) as state',
      },
    ]);
    expect(statements.some(({ sql }) => sql.includes('access_scope_fences'))).toBe(false);
  }),
);

it.effect('treats a missing, changing or unavailable fence as the typed 503', () =>
  Effect.gen(function* notReadyFences() {
    for (const fenceRows of [[], [{ state: null }], [{ state: 'Changing' }], [{ state: 'Unavailable' }]]) {
      yield* expectFenceUnavailable({ fenceRows });
    }
  }),
);

it.effect('maps every SQL failure of the fence read to the typed 503, never a defect', () =>
  Effect.gen(function* failedFenceReads() {
    const denied = new SqlError({ reason: new AuthorizationError({ cause: { code: '42501' } }) });
    const unreachable = new SqlError({ reason: new ConnectionError({ cause: { code: '08006' } }) });
    for (const failure of [denied, unreachable]) {
      yield* expectFenceUnavailable({ lockFailure: failure });
      yield* expectFenceUnavailable({ scopeFailure: failure });
    }
  }),
);

it.effect('holds the tenant fence the projection writer takes, then the company fence, for a company Action', () =>
  Effect.gen(function* companyActionHoldsTheWriterFence() {
    const ready = yield* lockCompanyFence({});
    expect(Exit.isSuccess(ready.exit)).toBe(true);
    expect(ready.locks.map(({ params }) => params[1])).toEqual([scopeId, companyScopeId]);
    // A writer changing the tenant refuses the company Action even while the company fence reads Ready.
    const changing = yield* lockCompanyFence({ fenceByScope: { [scopeId]: [{ state: 'Changing' }] } });
    expect(Exit.isFailure(changing.exit)).toBe(true);
    expect(changing.locks.map(({ params }) => params[1])).toEqual([scopeId]);
  }),
);
