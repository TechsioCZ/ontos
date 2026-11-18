import { PgTypes } from '@effect/sql-pg';
import { getColumns } from 'drizzle-orm';
import type { Column } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import type { PgTable } from 'drizzle-orm/pg-core';
import { Effect, Predicate } from 'effect';

import { PostgresWireStatementError } from './native-postgres-wire.ts';
import type {
  PostgresWireColumn,
  PostgresWireExecutor,
  PostgresWireResult,
  PostgresWireSession,
  PostgresWireValue,
} from './native-postgres-wire.ts';

/** One row as the test scripts it, keyed by the drizzle property names of its table. */
export type CoreTableRow = Readonly<Record<string, PostgresWireValue>>;
/** The parameters PostgreSQL received for a statement's WHERE clause, in placeholder order. */
export interface CoreTableWhere {
  readonly params: readonly PostgresWireValue[];
}

/** The remote side of Core persistence: what PostgreSQL stores and returns for each table statement. */
export interface CoreTableScript {
  /** `role` is the login role of the session that inserted, PostgreSQL's `current_user`. */
  readonly insert: (table: PgTable, value: CoreTableRow | readonly CoreTableRow[], role: string) => void;
  /** Catalog and session metadata (`pg_roles`, `current_database()`) PostgreSQL computes itself. */
  readonly nativeRows: () => readonly CoreTableRow[];
  readonly selectRows: (table: PgTable, where: CoreTableWhere) => readonly CoreTableRow[];
  readonly updateRows: (
    table: PgTable,
    values: CoreTableRow,
    where: CoreTableWhere,
  ) => Effect.Effect<readonly CoreTableRow[], PostgresWireStatementError>;
}

interface ScriptedColumn {
  readonly key: string;
  readonly wire: PostgresWireColumn;
}

const columnOid = (column: Column): number => {
  const type = column.getSQLType();
  if (type.endsWith('[]')) {
    return PgTypes.OID.textArray;
  }
  if (type === 'boolean') {
    return PgTypes.OID.bool;
  }
  if (type === 'integer' || type === 'serial') {
    return PgTypes.OID.int4;
  }
  if (type === 'bigint' || type === 'bigserial') {
    return PgTypes.OID.int8;
  }
  // Text, identifiers, enums, JSON and timestamps reach drizzle as text it parses itself.
  return PgTypes.OID.text;
};

const textOf = (value: PostgresWireValue): string => {
  if (Predicate.isString(value)) {
    return value;
  }
  if (Predicate.isDate(value)) {
    return value.toISOString();
  }
  if (value === null || Array.isArray(value)) {
    return JSON.stringify(value);
  }
  return String(value);
};

/** The value PostgreSQL would send for `value` in a column of this OID. */
const driverValue = (value: PostgresWireValue | undefined, oid: number): PostgresWireValue => {
  if (value === null || value === undefined) {
    return null;
  }
  if (oid === PgTypes.OID.bool) {
    return value === true || value === 'true' || value === 't';
  }
  if (oid === PgTypes.OID.int4) {
    return Number(textOf(value));
  }
  if (oid === PgTypes.OID.int8) {
    return BigInt(textOf(value));
  }
  if (oid === PgTypes.OID.textArray) {
    return Array.isArray(value) ? value.map(textOf) : [textOf(value)];
  }
  return textOf(value);
};

/** Splits a SQL list at its top-level commas. */
const splitTopLevel = (text: string): readonly string[] => {
  const items: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = '';
  for (const character of text) {
    if (character === '"' || character === "'") {
      quoted = !quoted;
    } else if (!quoted && character === '(') {
      depth += 1;
    } else if (!quoted && character === ')') {
      depth -= 1;
    }
    if (!quoted && depth === 0 && character === ',') {
      items.push(current.trim());
      current = '';
    } else {
      current += character;
    }
  }
  if (current.trim().length > 0) {
    items.push(current.trim());
  }
  return items;
};
const lastIdentifier = (expression: string): string =>
  [...expression.matchAll(/"(?<identifier>[^"]+)"/gu)].at(-1)?.groups?.['identifier'] ??
  expression.split(/[\s.]/u).at(-1) ??
  expression;
const resultName = (expression: string): string =>
  /\sas\s+"?(?<alias>\w+)"?$/iu.exec(expression)?.groups?.['alias'] ??
  lastIdentifier(expression.replace(/\(.*\)$/u, ''));
const placeholders = (text: string) =>
  [...text.matchAll(/\$(?<position>\d+)/gu)].map((match) => Number(match.groups?.['position']) - 1);
const parametersIn = (text: string, params: readonly PostgresWireValue[]) =>
  placeholders(text).map((index) => params[index] ?? null);

const sqlNameOf = (table: PgTable) => {
  const { name, schema } = getTableConfig(table);
  return schema === undefined ? `"${name}"` : `"${schema}"."${name}"`;
};
const columnsOf = (table: PgTable) =>
  new Map(Object.entries(getColumns(table)).map(([key, column]: [string, Column]) => [column.name, { column, key }]));
const scriptedColumns = (table: PgTable, expressions: readonly string[]): readonly ScriptedColumn[] => {
  const columns = columnsOf(table);
  return expressions.map((expression) => {
    const name = lastIdentifier(expression);
    const entry = columns.get(name);
    // drizzle reads timestamps as `::text` and parses them itself, so PostgreSQL sends text there.
    const oid = entry === undefined || expression.endsWith('::text') ? PgTypes.OID.text : columnOid(entry.column);
    return { key: entry?.key ?? name, wire: { name, oid } };
  });
};
const tableResult = (
  command: string,
  columns: readonly ScriptedColumn[],
  rows: readonly CoreTableRow[],
): PostgresWireResult => ({
  columns: columns.map(({ wire }) => wire),
  command,
  rows: rows.map((row) => columns.map(({ key, wire }) => driverValue(row[key], wire.oid))),
});
const withReturning = (
  command: string,
  table: PgTable,
  returning: string | undefined,
  rows: readonly CoreTableRow[],
) =>
  returning === undefined
    ? { columns: [], command, rows: [] }
    : tableResult(command, scriptedColumns(table, splitTopLevel(returning)), rows);

const insertStatement =
  /^insert into (?<table>(?:"[^"]+"\.)?"[^"]+") \((?<columns>[^)]*)\) values (?<tuples>.+?)(?: on conflict .*?)?(?: returning (?<returning>.+))?$/isu;
const selectStatement =
  /^select (?<selection>.+?) from (?<table>(?:"[^"]+"\.)?"[^"]+")(?: where (?<where>.+?))?(?: order by .+?)?(?: limit .+?)?$/isu;
const updateStatement =
  /^update (?<table>(?:"[^"]+"\.)?"[^"]+") set (?<assignments>.+?) where (?<where>.+?)(?: returning (?<returning>.+))?$/isu;
const controlStatement = /^(?<control>begin|commit|rollback|savepoint|release)\b/iu;

/** Transaction control; `set_config(..., true)` settings live only as long as their transaction. */
const control = (keyword: string, session: PostgresWireSession): PostgresWireResult => {
  if (keyword === 'begin') {
    session.inTransaction = true;
    session.settings.clear();
  } else if (keyword === 'commit' || keyword === 'rollback') {
    session.inTransaction = false;
    session.settings.clear();
  }
  return { columns: [], command: keyword.toUpperCase(), rows: [] };
};

/**
 * Answers Core table statements as PostgreSQL would, from `script`: inserts, single-table selects and
 * updates with RETURNING, transaction control with transaction-local `set_config` settings, and the
 * native catalog metadata queries Core issues. Anything else is refused with a native ErrorResponse.
 */
export const answerCoreTableStatements = (
  tables: readonly PgTable[],
  script: CoreTableScript,
): PostgresWireExecutor => {
  const tablesBySqlName = new Map(tables.map((table) => [sqlNameOf(table), table]));
  const tableNamed = (name: string) =>
    Effect.fromNullishOr(tablesBySqlName.get(name)).pipe(
      Effect.mapError(
        () => new PostgresWireStatementError({ code: '42P01', message: `relation ${name} is not scripted` }),
      ),
    );

  const insert = Effect.fn('CoreTableScript.insert')(function* insert(
    groups: Readonly<Record<string, string | undefined>>,
    params: readonly PostgresWireValue[],
    session: PostgresWireSession,
  ) {
    const table = yield* tableNamed(groups['table'] ?? '');
    const columns = scriptedColumns(table, splitTopLevel(groups['columns'] ?? ''));
    const rows = [...(groups['tuples'] ?? '').matchAll(/\((?<tuple>[^()]*)\)/gu)].map((match) =>
      Object.fromEntries(
        splitTopLevel(match.groups?.['tuple'] ?? '').flatMap((item, index) => {
          const [position] = placeholders(item);
          return position === undefined ? [] : [[columns[index]?.key ?? '', params[position] ?? null]];
        }),
      ),
    );
    script.insert(table, rows.length === 1 ? (rows[0] ?? {}) : rows, session.user);
    return withReturning(`INSERT 0 ${rows.length}`, table, groups['returning'], rows);
  });

  const update = Effect.fn('CoreTableScript.update')(function* update(
    groups: Readonly<Record<string, string | undefined>>,
    params: readonly PostgresWireValue[],
  ) {
    const table = yield* tableNamed(groups['table'] ?? '');
    const columns = columnsOf(table);
    const values = Object.fromEntries(
      splitTopLevel(groups['assignments'] ?? '').map((assignment) => {
        const [target = '', source = ''] = assignment.split('=');
        const [position] = placeholders(source);
        const name = lastIdentifier(target);
        return [columns.get(name)?.key ?? name, position === undefined ? null : (params[position] ?? null)];
      }),
    );
    const rows = yield* script.updateRows(table, values, { params: parametersIn(groups['where'] ?? '', params) });
    return withReturning(`UPDATE ${rows.length}`, table, groups['returning'], rows);
  });

  const select = Effect.fn('CoreTableScript.select')(function* select(
    groups: Readonly<Record<string, string | undefined>>,
    params: readonly PostgresWireValue[],
  ) {
    const table = yield* tableNamed(groups['table'] ?? '');
    const rows = script.selectRows(table, { params: parametersIn(groups['where'] ?? '', params) });
    return tableResult(`SELECT ${rows.length}`, scriptedColumns(table, splitTopLevel(groups['selection'] ?? '')), rows);
  });

  const sessionRows = (sql: string, params: readonly PostgresWireValue[], session: PostgresWireSession) => {
    // Without SET ROLE, the session's login role is both its `session_user` and its `current_user`.
    if (sql === 'select current_user::text as role' || sql === 'select session_user::text as role') {
      return [{ role: session.user }];
    }
    const scopeRow = (): readonly CoreTableRow[] => [
      {
        legal_entity_id: session.settings.get('ontos.legal_entity_id') ?? '',
        role: session.user,
        tenant_id: session.settings.get('ontos.tenant_id') ?? '',
      },
    ];
    // `set_config` answers the value it set, beside whatever else the statement selects.
    if (sql.includes('set_config(')) {
      const [tenantId = null, legalEntityId = null] = params;
      session.settings.set('ontos.tenant_id', textOf(tenantId));
      session.settings.set('ontos.legal_entity_id', textOf(legalEntityId));
      return scopeRow();
    }
    if (sql.includes('current_setting(')) {
      return scopeRow();
    }
    return script.nativeRows();
  };
  const metadata = (sql: string, params: readonly PostgresWireValue[], session: PostgresWireSession) => {
    const rows = sessionRows(sql, params, session);
    const selection = splitTopLevel(
      /^select (?<selection>.+?)(?: from .*)?$/isu.exec(sql)?.groups?.['selection'] ?? '',
    );
    const columns = selection.map((expression): PostgresWireColumn => {
      const name = resultName(expression);
      const sample = rows.map((row) => row[name]).find((value) => value !== undefined && value !== null);
      const boolean = Predicate.isBoolean(sample) || (sample === undefined && /^rol(?!name)/u.test(expression));
      return { name, oid: boolean ? PgTypes.OID.bool : PgTypes.OID.text };
    });
    return {
      columns,
      command: `SELECT ${rows.length}`,
      rows: rows.map((row) => columns.map(({ name, oid }) => driverValue(row[name], oid))),
    };
  };

  return ({ params, session, sql: raw }) => {
    const sql = raw.replaceAll(/\s+/gu, ' ').trim();
    const keyword = controlStatement.exec(sql)?.groups?.['control']?.toLowerCase();
    if (keyword !== undefined) {
      return Effect.succeed(control(keyword, session));
    }
    const inserted = insertStatement.exec(sql)?.groups;
    if (inserted !== undefined) {
      return insert(inserted, params, session);
    }
    const updated = updateStatement.exec(sql)?.groups;
    if (updated !== undefined) {
      return update(updated, params);
    }
    if (/^delete\b/iu.test(sql)) {
      return Effect.fail(
        new PostgresWireStatementError({ code: '0A000', message: 'The scripted Core tables do not model DELETE' }),
      );
    }
    const selected = selectStatement.exec(sql)?.groups;
    if (selected !== undefined && tablesBySqlName.has(selected['table'] ?? '')) {
      return select(selected, params);
    }
    return Effect.succeed(metadata(sql, params, session));
  };
};
