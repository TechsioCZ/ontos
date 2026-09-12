import type { SQL } from 'drizzle-orm';
import { EffectDrizzleQueryError } from 'drizzle-orm/effect-core';
import { PgDialect } from 'drizzle-orm/pg-core';
import { Cause, Effect, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';
import { SqlError, UniqueViolation } from 'effect/unstable/sql/SqlError';

import type { OperationalScope } from '../../src/operations/context.ts';
import {
  defineScopedRoutine,
  scopedRoutineInvokerFromTransaction,
  ScopedRoutineInvocationError,
} from '../../src/db/scoped-routine.ts';
import type { ScopedRoutineDefinitionInput } from '../../src/db/scoped-routine.ts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const legalEntityId = '22222222-2222-4222-8222-222222222222';
const scope = Object.freeze({
  authContextRef: 'better-auth-session:test',
  authMethod: 'session',
  correlationId: 'correlation-1',
  legalEntityId,
  principalId: '33333333-3333-4333-8333-333333333333',
  tenantId,
}) satisfies OperationalScope;
const tenantOnlyScope = Object.freeze({
  authContextRef: scope.authContextRef,
  authMethod: scope.authMethod,
  correlationId: scope.correlationId,
  principalId: scope.principalId,
  tenantId: scope.tenantId,
}) satisfies OperationalScope;

const SavedRowSchema = Schema.Struct({ saved_id: Schema.String });
const saveProfile = defineScopedRoutine({
  name: 'save_profile',
  ownerModuleKey: 'commerce.customer-context',
  parameters: [
    { source: 'tenantId', type: 'uuid' },
    { source: 'legalEntityId', type: 'uuid' },
    { source: 'input', type: 'text' },
    { nullable: true, source: 'input', type: 'jsonb' },
  ],
  resultSchema: SavedRowSchema,
  routineKey: 'profile.save',
  schema: 'commerce_customer_context',
});

it.effect('injects verified scope values and parameterizes every caller-supplied value', () =>
  Effect.gen(function* scopedRoutineInvocation() {
    let statement: SQL | undefined;
    const payload = "Robert'); drop schema core cascade; --";
    const executor = scopedRoutineInvokerFromTransaction((candidate) => {
      statement = candidate;
      return Effect.succeed([{ saved_id: 'saved-1' }]);
    }, scope);

    const rows = yield* executor.invoke(saveProfile, [payload, { source: 'test' }]);
    expect(rows).toEqual([{ saved_id: 'saved-1' }]);
    expect(statement).toBeDefined();
    if (statement === undefined) {
      return;
    }
    const query = new PgDialect().sqlToQuery(statement);
    expect(query.sql).toBe(
      'select * from "commerce_customer_context"."save_profile"($1::uuid, $2::uuid, $3::text, $4::jsonb)',
    );
    expect(query.params).toEqual([tenantId, legalEntityId, payload, { source: 'test' }]);
    expect(query.sql).not.toContain(payload);
  }),
);

it.effect('fails before SQL when a declared legal-entity context value is unavailable', () =>
  Effect.gen(function* missingLegalEntity() {
    let executions = 0;
    const executor = scopedRoutineInvokerFromTransaction(() => {
      executions += 1;
      return Effect.succeed([]);
    }, tenantOnlyScope);
    const error = yield* Effect.flip(executor.invoke(saveProfile, ['name', null]));

    expect(Schema.is(ScopedRoutineInvocationError)(error)).toBe(true);
    expect(error.code).toBe('scoped_routine_scope_missing');
    expect(error.ownerModuleKey).toBe('commerce.customer-context');
    expect(error.routineKey).toBe('profile.save');
    expect(Option.isNone(error.postgresCode)).toBe(true);
    expect(executions).toBe(0);
  }),
);

it.effect('maps PostgreSQL metadata to a sanitized typed persistence failure', () =>
  Effect.gen(function* postgresFailure() {
    const constraint = 'customer_profile_tenant_external_key_uk';
    const driver = {
      code: '23505',
      constraint,
      detail: 'private row values',
      query: 'private SQL',
    };
    const executor = scopedRoutineInvokerFromTransaction(
      () =>
        Effect.fail(
          new EffectDrizzleQueryError({
            cause: Cause.fail(new SqlError({ reason: new UniqueViolation({ cause: driver, constraint }) })),
            params: ['private parameter'],
            query: 'private SQL',
          }),
        ),
      scope,
    );
    const error = yield* Effect.flip(executor.invoke(saveProfile, ['name', null]));

    expect(Schema.is(ScopedRoutineInvocationError)(error)).toBe(true);
    expect(error.code).toBe('scoped_routine_invocation_failed');
    expect(Option.getOrThrow(error.constraint)).toBe(constraint);
    expect(error.ownerModuleKey).toBe('commerce.customer-context');
    expect(Option.getOrThrow(error.postgresCode)).toBe('23505');
    expect(error.routineKey).toBe('profile.save');
    expect('cause' in error).toBe(false);
    expect(error.reason).not.toContain('private');
  }),
);

it('validates and deeply freezes routine allowlist declarations', () => {
  expect(Object.isFrozen(saveProfile)).toBe(true);
  expect(Object.isFrozen(saveProfile.parameters)).toBe(true);
  expect(Object.isFrozen(saveProfile.parameters[0])).toBe(true);

  const invalidDefinitions: readonly ScopedRoutineDefinitionInput[] = [
    {
      name: 'unsafe; drop schema core',
      ownerModuleKey: 'commerce.customer-context',
      parameters: [{ source: 'tenantId', type: 'uuid' }] as const,
      resultSchema: SavedRowSchema,
      routineKey: 'profile.save',
      schema: 'commerce_customer_context',
    },
    {
      name: 'save_profile',
      ownerModuleKey: 'commerce.customer-context',
      parameters: [{ source: 'input', type: 'text' }] as const,
      resultSchema: SavedRowSchema,
      routineKey: 'profile.save',
      schema: 'commerce_customer_context',
    },
    {
      name: 'save_profile',
      ownerModuleKey: 'commerce.customer-context',
      parameters: [
        { source: 'tenantId', type: 'uuid' },
        { source: 'tenantId', type: 'uuid' },
      ] as const,
      resultSchema: SavedRowSchema,
      routineKey: 'profile.save',
      schema: 'commerce_customer_context',
    },
  ];
  for (const definition of invalidDefinitions) {
    expect(() => defineScopedRoutine(definition)).toThrow();
  }
});
