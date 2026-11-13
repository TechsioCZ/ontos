import { Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { LegalEntityIdSchema, RecordKeySchema, TenantIdSchema } from '../../src/access/ids.ts';
import { defineDatabaseIdentityEnrollment } from '../../src/db/database-identities.ts';
import { refuseInsideDatabaseTransaction } from '../../src/db/transaction-io-guard.ts';
import { makeActionTestAccessFences, makeActionTestHarness } from '../../src/testing/actions.ts';
import type { ActionTestAccessFences } from '../../src/testing/action-access-fences.ts';
import { makePersistedActionTestAccessGate } from '../../src/testing/access-gate.ts';
import { actionFor, ownerKey, principal, readFor } from '../support/action-command-v2.ts';
import { makeTestOperationOwner } from '../support/action-runtime-options.ts';
import { makeTestDatabase } from '../support/database.ts';
import { cell, makeAuthority, makeCheck } from './access-decision-support.ts';
import type { AuthoritySpec } from './access-decision-support.ts';

const tenantScopeId = '00000000-0000-4000-8000-000000000101';
const companyScopeId = '00000000-0000-4000-8000-000000000102';
const companyId = Schema.decodeUnknownSync(LegalEntityIdSchema)(principal.legalEntityId);
const first = RecordKeySchema.make('first');
const second = RecordKeySchema.make('second');
const scopeValues = Schema.Tuple([Schema.String, Schema.String]);
const normalize = (sql: string) => sql.trim().replaceAll(/\s+/gu, ' ').toLowerCase();
const beforeOwnerTransaction = () => 0;

const fenceDatabase = (fences: ActionTestAccessFences) =>
  Effect.gen(function* buildFenceDatabase() {
    let tenantId = '';
    let legalEntityId = '';
    return yield* makeTestDatabase((sql, params) =>
      Effect.gen(function* executeFenceFixtureSql() {
        const statement = normalize(sql);
        if (['begin', 'commit', 'rollback'].includes(statement)) {
          return [];
        }
        // A session-setting role installs its scope and reads back the connected role in one statement.
        if (
          statement ===
          "select current_user::text as role, set_config('ontos.tenant_id', $1, true) as tenant_id, set_config('ontos.legal_entity_id', $2, true) as legal_entity_id"
        ) {
          [tenantId, legalEntityId] = yield* Schema.decodeUnknownEffect(scopeValues)(params).pipe(Effect.orDie);
          return [{ legal_entity_id: legalEntityId, role: 'ontos_runtime', tenant_id: tenantId }];
        }
        const answer = fences.read({ params, scope: { legalEntityId, tenantId }, sql });
        return Option.isSome(answer) ? yield* answer.value : yield* Effect.die(`Unlisted fence fixture SQL: ${sql}`);
      }),
    );
  });

for (const state of ['Ready', 'Changing', 'missing'] as const) {
  it.effect(
    `the production preparation reads explicit SQL fence rows and executes all records only when ${state}`,
    () =>
      Effect.gen(function* persistedFenceLifecycle() {
        const fences = yield* makeActionTestAccessFences([
          { revision: 7, scopeId: tenantScopeId, state: 'Ready', tenantId: principal.tenantId },
          ...(state === 'missing'
            ? []
            : [
                {
                  legalEntityId: companyId,
                  revision: 11,
                  scopeId: companyScopeId,
                  state,
                  tenantId: principal.tenantId,
                },
              ]),
        ]);
        const executor = yield* fenceDatabase(fences);
        const spec: AuthoritySpec = {
          cells: [
            cell({ capability: `${ownerKey}.record.change` }),
            cell({ capability: `${ownerKey}.record.write-salary` }),
            cell({ capability: `${ownerKey}.record.read` }),
            cell({ capability: `${ownerKey}.record.read-salary` }),
          ],
          legalEntityScope: {
            _tag: 'LegalEntity',
            legalEntityId: LegalEntityIdSchema.make(principal.legalEntityId ?? ''),
            tenantId: TenantIdSchema.make(principal.tenantId),
          },
        };
        const authority = makeAuthority(spec).port;
        const check = makeCheck({ authority: spec }).port;
        let transactionCount = beforeOwnerTransaction;
        let remoteChecks = 0;
        const gate = yield* makePersistedActionTestAccessGate({
          database: { enrollment: defineDatabaseIdentityEnrollment([]), executor },
          ports: {
            candidates: { listCandidateIds: () => Effect.succeed([]) },
            check: {
              checkBulk: (items) =>
                Effect.gen(function* remoteCheck() {
                  expect(transactionCount()).toBe(0);
                  yield* refuseInsideDatabaseTransaction('spicedb', 'persisted-action-fixture');
                  remoteChecks += 1;
                  return yield* check.checkBulk(items);
                }),
            },
            decisionLog: { record: () => Effect.void },
            intent: { authorityFor: () => authority, joined: () => ({ authorityFor: () => authority }) },
            principalKinds: { readKind: () => Effect.succeed(Option.some('human' as const)) },
          },
        });
        const read = readFor();
        const action = actionFor(read);
        const owner = makeTestOperationOwner({ actions: [action], moduleId: ownerKey, reads: [read] });
        const harness = yield* makeActionTestHarness({
          accessDecision: gate,
          accessFences: fences,
          ownerRegistration: owner.ownerRegistration,
        });
        transactionCount = () => harness.snapshot().transactionCount;
        const request = {
          payload: { ids: [first, second], salary: 25 },
          principal,
          registration: action,
          transport: { correlationId: `fences-${state}`, idempotencyKey: `fences-${state}` },
        };
        const result = yield* Effect.result(harness.runtime.runAction(request));
        if (state === 'Ready') {
          expect(result).toMatchObject({ success: 2 });
          expect(remoteChecks).toBeGreaterThan(0);
          expect(harness.snapshot().committed).toHaveLength(1);
          const calls = remoteChecks;
          expect((yield* Effect.flip(harness.runtime.runAction(request)))._tag).toBe('ActionAlreadyCommitted');
          expect(remoteChecks).toBe(calls);
        } else {
          expect(result).toMatchObject({ failure: { _tag: 'ActionPermissionCheckError' } });
          expect(remoteChecks).toBe(0);
          expect(harness.snapshot().transactionCount).toBe(0);
          expect(harness.snapshot().committed).toEqual([]);
        }
      }),
  );
}

it.effect('the fence fixture never admits an owner SELECT, write or altered infrastructure statement', () =>
  Effect.gen(function* noOwnerSqlInFenceFixture() {
    const fences = yield* makeActionTestAccessFences([]);
    for (const sql of [
      'select * from core.access_scopes',
      'select trust.lock_access_scope_fence($1::uuid, $2::uuid) as state; select 1',
      'update core.access_scope_fences set revision = 1',
    ]) {
      expect(Option.isNone(fences.read({ params: [], scope: { legalEntityId: '', tenantId: '' }, sql }))).toBe(true);
    }
  }),
);
