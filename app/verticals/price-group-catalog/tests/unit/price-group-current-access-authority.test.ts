import { defineDatabaseIdentityEnrollment, SHARED_RUNTIME_IDENTITY } from '@app/core-runtime';
import { bootstrapScopesOf } from '@app/core-runtime/access/bootstrap';
import { LegalEntityIdSchema, PrincipalIdSchema, TenantIdSchema } from '@app/core-runtime/access/ids';
import { stageScopeOf } from '@app/core-runtime/install/stage-context-bootstrap';
import {
  makeActionTestAccessFences,
  makeTestActionAccessPorts,
  testActionAccessScopeIds,
} from '@app/core-runtime/testing/actions';
import type { ActionTestAccessFenceQuery, TestActionAccessAuthorityScript } from '@app/core-runtime/testing/actions';
import { makePersistedActionTestAccessGate } from '@app/core-runtime/testing/access-gate';
import { testCoreDatabase } from '@app/core-runtime/testing/owner-evidence';
import { scriptedPgClientLayer, testSqlConnection } from '@app/core-runtime/testing/scripted-pg-client';
import { PgClient } from '@effect/sql-pg';
import { Context, Effect, Layer, Option, Schema } from 'effect';
import { Reactivity } from 'effect/reactivity';
import { expect, it } from 'effect-rstest';

import { createPriceGroupAction } from '../../src/actions/create-price-group.action.ts';

/*
 * The native Price Group receiver answers a protected Action through the production engine over the
 * fixture's own authority, and pins it to the persisted fence/revision rows its tenant bootstrap
 * wrote. This suite proves that contract without a database: the same scripted authority the native
 * fixtures give the gate, the production preparation path, and a scripted table that answers only
 * the shipped fence statements.
 *
 * It is not a PostgreSQL integration proof. It proves the two facts the native receiver depends on:
 * a Ready persisted fence admits a held capability, and a Changing or absent fence, or a capability
 * the fixture withholds, never admits one.
 */

const tenantId = TenantIdSchema.make('00000000-0000-4000-8000-0000000a0001');
const principalId = PrincipalIdSchema.make('00000000-0000-4000-8000-0000000a0002');
const companyId = LegalEntityIdSchema.make('00000000-0000-4000-8000-0000000a0003');
const scopeValues = Schema.Tuple([Schema.String, Schema.String]);
const normalize = (sql: string) => sql.trim().replaceAll(/\s+/gu, ' ').toLowerCase();
const setupScope = "select set_config('ontos.tenant_id', $1, true), set_config('ontos.legal_entity_id', $2, true)";
const readInstalledScope =
  "select current_user::text as role, current_setting('ontos.tenant_id', true) as tenant_id, current_setting('ontos.legal_entity_id', true) as legal_entity_id";

type Fences = Effect.Success<ReturnType<typeof makeActionTestAccessFences>>;

/** The production fence/revision reader and this scripted table share the same statements. */
const fenceDatabase = (fences: Fences) =>
  Effect.gen(function* scriptedFenceDatabase() {
    let installedTenant = '';
    let installedCompany = '';
    const connection = testSqlConnection((sql, params) =>
      Effect.gen(function* fenceStatement() {
        const statement = normalize(sql);
        if (['begin', 'commit', 'rollback'].includes(statement)) {
          return [];
        }
        if (statement === setupScope) {
          [installedTenant, installedCompany] = yield* Schema.decodeUnknownEffect(scopeValues)(params).pipe(
            Effect.orDie,
          );
          return [];
        }
        if (statement === readInstalledScope) {
          return [
            {
              legal_entity_id: installedCompany,
              role: SHARED_RUNTIME_IDENTITY.role,
              tenant_id: installedTenant,
            },
          ];
        }
        const query: ActionTestAccessFenceQuery = {
          params,
          scope: { legalEntityId: installedCompany, tenantId: installedTenant },
          sql,
        };
        const answer = fences.read(query);
        return Option.isSome(answer)
          ? yield* answer.value
          : yield* Effect.die(`The fence fixture must not execute owner or unlisted SQL: ${sql}`);
      }),
    );
    const reactivity = yield* Reactivity.make;
    const services = yield* Layer.build(scriptedPgClientLayer(Effect.succeed(connection))).pipe(
      Effect.provideService(Reactivity.Reactivity, reactivity),
    );
    return yield* testCoreDatabase.pipe(
      Effect.provideService(PgClient.PgClient, Context.get(services, PgClient.PgClient)),
    );
  });

const capabilityKeyOf = (): string => {
  const declaration = createPriceGroupAction.descriptor.accessDeclaration;
  if (declaration === undefined) {
    throw new Error('The Catalog create Action must declare its access capability');
  }
  return declaration.key;
};

const preparedDecision = (input: {
  readonly fenceState: 'Changing' | 'Ready' | 'missing';
  readonly legalEntityIds?: readonly string[];
  readonly refusedCapabilityKeys?: readonly string[];
}) =>
  Effect.gen(function* preparedPriceGroupDecision() {
    const script: TestActionAccessAuthorityScript = { principalId, tenantId };
    if (input.legalEntityIds !== undefined) {
      Object.assign(script, { legalEntityIds: input.legalEntityIds });
    }
    if (input.refusedCapabilityKeys !== undefined) {
      Object.assign(script, { refusedCapabilityKeys: input.refusedCapabilityKeys });
    }
    const scopeIds = testActionAccessScopeIds(script);
    const fenceRows: {
      readonly legalEntityId?: string;
      readonly revision: number;
      readonly scopeId: string;
      readonly state: 'Changing' | 'Ready';
      readonly tenantId: string;
    }[] = [];
    if (input.fenceState !== 'missing') {
      fenceRows.push({
        revision: 1,
        scopeId: scopeIds.tenantContextScopeId,
        state: input.fenceState,
        tenantId,
      });
      for (const scopeId of scopeIds.legalEntityScopeIds) {
        fenceRows.push({ legalEntityId: companyId, revision: 2, scopeId, state: input.fenceState, tenantId });
      }
    }
    const fences = yield* makeActionTestAccessFences(fenceRows);
    const executor = yield* fenceDatabase(fences);
    const gate = yield* makePersistedActionTestAccessGate({
      database: { enrollment: defineDatabaseIdentityEnrollment([]), executor },
      ports: makeTestActionAccessPorts(script),
    });
    const prepare = Option.getOrThrow(Option.fromUndefinedOr(gate.prepare));
    const declaration = createPriceGroupAction.descriptor.accessDeclaration;
    if (declaration === undefined) {
      throw new Error('The Catalog create Action must declare its access capability');
    }
    const scope = yield* stageScopeOf({ principalId, tenantId }).pipe(Effect.orDie);
    const now = new Date('2026-11-09T00:00:00.000Z');
    return {
      executor,
      now,
      prepare,
      question: { carrier: { accessDeclaration: declaration }, legalEntityScope: 'forbidden' as const, now, scope },
      scopeIds,
    };
  });

it.effect('the prepared Catalog gate admits a held capability only under a Ready persisted fence', () =>
  Effect.scoped(
    Effect.gen(function* readyFenceAdmits() {
      const prepared = yield* preparedDecision({ fenceState: 'Ready' });
      const decision = yield* prepared.prepare(prepared.question);
      expect(decision.decision.outcome).toBe('ALLOWED');
      expect(decision.decision.evidence.length).toBeGreaterThan(0);
      const rechecked = yield* prepared.executor.transaction((transaction) =>
        decision.recheck(prepared.now, transaction),
      );
      expect(rechecked.outcome).toBe('ALLOWED');
    }),
  ),
);

it.effect('the withheld Catalog create capability is a decision, never an unavailable gate', () =>
  Effect.scoped(
    Effect.gen(function* withheldCapabilityDenies() {
      const prepared = yield* preparedDecision({
        fenceState: 'Ready',
        refusedCapabilityKeys: [capabilityKeyOf()],
      });
      const decision = yield* prepared.prepare(prepared.question);
      expect(decision.decision.outcome).toBe('DENIED');
      expect(decision.decision.reasons.map(({ code }) => code)).toContain('deny.insufficient_grant');
    }),
  ),
);

for (const fenceState of ['Changing', 'missing'] as const) {
  it.effect(`a ${fenceState} persisted fence is unavailable, never an allow`, () =>
    Effect.scoped(
      Effect.gen(function* unpreparedFenceRefuses() {
        const prepared = yield* preparedDecision({ fenceState });
        const failure = yield* Effect.flip(prepared.prepare(prepared.question));
        expect(failure._tag).toBe('AccessDecisionUnavailable');
      }),
    ),
  );
}

it.effect('the scripted authority names the persisted scope ids the native writer derives', () =>
  Effect.sync(() => {
    const script = { legalEntityIds: [companyId], principalId, tenantId };
    const scripted = testActionAccessScopeIds(script);
    const persisted = bootstrapScopesOf(tenantId, [companyId]);
    expect(scripted.tenantContextScopeId).toBe(persisted[0]?.scopeId);
    expect(scripted.legalEntityScopeIds).toEqual(
      persisted.flatMap((scope) => (scope._tag === 'LegalEntity' ? [scope.scopeId] : [])),
    );
  }),
);
