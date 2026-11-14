import { Context, Effect, Option } from 'effect';

import type { SqlError } from 'effect/sql/SqlError';
import { OpenDatabaseTransaction } from '../db/transaction-io-guard.ts';
import type { OperationalScope } from '../operations/context.ts';

export interface ActionTestPreparationRead {
  readonly params: readonly unknown[];
  readonly scope: Readonly<{ readonly legalEntityId: string; readonly tenantId: string }>;
  readonly sql: string;
}

export interface ActionTestPreparationReadScript {
  readonly execute: (query: ActionTestPreparationRead) => Effect.Effect<readonly object[], SqlError>;
  /** Exact SQL from the native Drizzle driver. No wildcard or table-wide allowance. */
  readonly sql: string;
}

/** Private fixture phase marker. It provides neither an owner service nor an authorization verdict. */
export const ActionTestPreparationScope = Context.Reference<Option.Option<OperationalScope>>(
  '@app/core-runtime/testing/ActionTestPreparationScope',
  { defaultValue: Option.none },
);

const isSelection = (sql: string): boolean =>
  /^select\s/iu.test(sql.trim()) &&
  !/[;]/u.test(sql) &&
  !/\b(?:insert|update|delete|merge|alter|drop|create|truncate|grant|revoke|copy|call|do|execute|nextval|setval|set_config)\b/iu.test(
    sql,
  ) &&
  !/\bfor\s+(?:key\s+share|no\s+key\s+update|share|update)\b/iu.test(sql);

/**
 * Only an exact scripted SELECT in the genuine preflight's scoped snapshot is offered to a callback.
 * The owner writer has no preparation marker, even when it asks for exactly the same SQL.
 */
export const executeActionTestPreparationRead = Effect.fn('ActionTestHarness.preparationRead')(
  function* executeActionTestPreparationRead(input: {
    readonly query: ActionTestPreparationRead;
    readonly scripts: readonly ActionTestPreparationReadScript[];
    readonly trace: ActionTestPreparationRead[];
  }) {
    const preparing = yield* ActionTestPreparationScope;
    const transaction = yield* OpenDatabaseTransaction;
    const query = Object.freeze({
      params: Object.freeze([...input.query.params]),
      scope: Object.freeze({ ...input.query.scope }),
      sql: input.query.sql,
    });
    if (
      Option.isNone(preparing) ||
      Option.isNone(transaction) ||
      query.scope.tenantId !== preparing.value.tenantId ||
      query.scope.legalEntityId !== (preparing.value.legalEntityId ?? '') ||
      !isSelection(query.sql)
    ) {
      return yield* Effect.die('Only read-only SQL in the registered Action preparation snapshot may be scripted');
    }
    input.trace.push(query);
    const scripts = input.scripts.filter((script) => script.sql === query.sql);
    const [script] = scripts;
    if (scripts.length !== 1 || script === undefined) {
      return yield* Effect.die('The Action preparation SELECT has no unique exact scripted answer');
    }
    return yield* script.execute(query);
  },
);
