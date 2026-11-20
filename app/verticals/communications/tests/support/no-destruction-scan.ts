import { Schema } from 'effect';
import { parseSync, Visitor } from 'oxc-parser';
import type { Node, Span } from 'oxc-parser';

/**
 * Static guard behind the "no automatic destructive mechanism" test (#1410 AC-05/AC-12, PRIV-COM-05/06/16).
 *
 * It parses TypeScript with a real AST, so comments, strings that contain `/*`, aliases, destructuring and computed
 * access are read for what they are, not guessed from text. It is a TRIPWIRE for the owner sources, not the proof of
 * safety: the proof is the PostgreSQL privilege and append-only trigger guards on the runtime role. A dynamic key that the
 * parser cannot fold (`db[someVariable]`) is outside what any static scan can see.
 */

export interface DestructionFinding {
  readonly kind: string;
  readonly line: number;
  /** The source of the call (or access) that triggered the finding, for allowlist matching and for the failure message. */
  readonly text: string;
}

/** Writes that change or remove stored rows; naming one in any form (call, alias, destructuring, string key) is a finding. */
const mutatingMembers: ReadonlySet<string> = new Set(['delete', 'onConflictDoUpdate', 'truncate', 'update']);

/** Repetition and scheduling vocabulary of Effect: nothing in an owner source may repeat or schedule work. */
const schedulingMembers: ReadonlySet<string> = new Set([
  'forever',
  'repeat',
  'repeatN',
  'repeatOrElse',
  'schedule',
  'scheduleForked',
  'scheduleFrom',
]);
const timerIdentifiers: ReadonlySet<string> = new Set(['setImmediate', 'setInterval', 'setTimeout']);
const schedulingImportSources = /^effect\/(?:Cron|Schedule)$/u;
const schedulingNamespaces: ReadonlySet<string> = new Set(['Cron', 'Schedule']);

/** Disposal verbs: a call named like one is a finding whether it is a function or a method. */
const disposalName = /^(?:anonymi[sz]e|purge|shred|scrub|wipe|cleanup|garbageCollect|expireNow|dispose(?:Of)?Data)/u;

/** The text of a static string expression, folding `'del' + 'ete'` and a template without interpolation. */
const stringOf = (node: Node): string | undefined => {
  if (node.type === 'Literal') {
    return Schema.is(Schema.String)(node.value) ? node.value : undefined;
  }
  if (node.type === 'TemplateLiteral') {
    return node.expressions.length === 0 ? (node.quasis[0]?.value.cooked ?? undefined) : undefined;
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    const left = stringOf(node.left);
    const right = stringOf(node.right);
    return left === undefined || right === undefined ? undefined : left + right;
  }
  return undefined;
};

/** The static name of a property key or member property, folding `['del' + 'ete']` and a backtick key. */
const staticName = (property: Node, computed: boolean): string | undefined =>
  !computed && (property.type === 'Identifier' || property.type === 'PrivateIdentifier')
    ? property.name
    : stringOf(property);

/** The name a call goes by: a plain function, or a (possibly computed) method. */
const calleeName = (callee: Node): string | undefined => {
  if (callee.type === 'Identifier') {
    return callee.name;
  }
  return callee.type === 'MemberExpression' ? staticName(callee.property, callee.computed) : undefined;
};

const quote = String.raw`(?:"[^"]+"|\w+)`;
const sqlStatements: readonly { readonly kind: string; readonly pattern: RegExp }[] = [
  {
    kind: 'raw SQL UPDATE',
    pattern: new RegExp(String.raw`\bupdate\s+(?:only\s+)?${quote}(?:\s*\.\s*${quote})?\s+(?:as\s+\w+\s+)?set\b`, 'iu'),
  },
  { kind: 'raw SQL DELETE', pattern: /\bdelete\s+from\b/iu },
  { kind: 'raw SQL TRUNCATE', pattern: /\btruncate\b(?:\s+table)?\s+(?:only\s+)?["\w]/iu },
  {
    kind: 'raw SQL DROP',
    pattern:
      /\bdrop\s+(?:table|schema|column|view|materialized\s+view|database|type|sequence|index|if\s+exists|owned|role)\b/iu,
  },
];

/** The text a string-like node holds; an interpolated value stands in as a quoted name so `UPDATE ${t} SET` still reads as SQL. */
const sqlTextOf = (node: Node): string | undefined =>
  node.type === 'TemplateLiteral' ? node.quasis.map(({ value }) => value.cooked ?? '').join('"x"') : stringOf(node);

const lineOf = (source: string, offset: number): number => source.slice(0, offset).split('\n').length;

/** Scans one TypeScript source and returns every destructive, rewriting or scheduling construct it contains. */
export const scanSourceForDestruction = (fileName: string, source: string): readonly DestructionFinding[] => {
  const { errors, program } = parseSync(fileName, source);
  if (errors.length > 0) {
    throw new Error(`${fileName} does not parse: ${errors[0]?.message ?? 'unknown error'}`);
  }
  const findings = new Map<string, DestructionFinding>();
  const add = (kind: string, node: Span, text = source.slice(node.start, node.end)) => {
    findings.set(`${kind}@${String(node.start)}`, { kind, line: lineOf(source, node.start), text });
  };
  /** The call a member access is the callee of, so an allowance can name `.delete(table)` and not a bare alias. */
  const calls = new Map<number, Span>();
  const scanSql = (node: Node) => {
    const text = sqlTextOf(node);
    for (const { kind, pattern } of sqlStatements) {
      if (text !== undefined && pattern.test(text)) {
        add(kind, node);
      }
    }
  };

  new Visitor({
    BinaryExpression(node) {
      if (node.operator === '+') {
        scanSql(node);
      }
    },
    CallExpression(node) {
      if (node.callee.type === 'MemberExpression') {
        calls.set(node.callee.start, node);
      }
      const name = calleeName(node.callee);
      if (name !== undefined && disposalName.test(name)) {
        add(`disposal call ${name}`, node);
      }
    },
    Identifier(node) {
      if (timerIdentifiers.has(node.name)) {
        add(`timer ${node.name}`, node);
      }
    },
    ImportDeclaration(node) {
      const from = node.source.value;
      if (schedulingImportSources.test(from)) {
        add(`import of ${from}`, node);
      }
      for (const specifier of node.specifiers) {
        const imported = specifier.type === 'ImportSpecifier' ? staticName(specifier.imported, false) : undefined;
        if (from === 'effect' && imported !== undefined && schedulingNamespaces.has(imported)) {
          add(`import of ${imported}`, specifier);
        }
        if (/^effect\/(?:Effect|Stream)$/u.test(from) && imported !== undefined && schedulingMembers.has(imported)) {
          add(`import of scheduling ${imported}`, specifier);
        }
      }
    },
    Literal(node) {
      scanSql(node);
    },
    MemberExpression(node) {
      const name = staticName(node.property, node.computed);
      if (name === undefined) {
        return;
      }
      if (mutatingMembers.has(name)) {
        const call = calls.get(node.start);
        add(`access to .${name}`, node, call === undefined ? undefined : source.slice(call.start, call.end));
      }
      // `'a'.repeat(3)` is string padding, not Effect's repeat
      if (schedulingMembers.has(name) && stringOf(node.object) === undefined) {
        add(`scheduling .${name}`, node);
      }
      if (timerIdentifiers.has(name)) {
        add(`timer .${name}`, node);
      }
    },
    ObjectPattern(node) {
      // `const { delete: remove, update } = db` and a destructured parameter read the member without naming it as a call
      for (const property of node.properties) {
        if (property.type !== 'Property') {
          continue;
        }
        const name = staticName(property.key, property.computed);
        if (name !== undefined && mutatingMembers.has(name)) {
          add(`destructured .${name}`, property);
        }
        if (name !== undefined && (schedulingMembers.has(name) || timerIdentifiers.has(name))) {
          add(`destructured scheduling .${name}`, property);
        }
      }
    },
    TemplateLiteral(node) {
      scanSql(node);
    },
  }).visit(program);
  return [...findings.values()].toSorted((left, right) => left.line - right.line);
};

/* ------------------------------------------------------------------------------------------------ */
/* Migrations                                                                                       */
/* ------------------------------------------------------------------------------------------------ */

const migrationStatements: readonly { readonly kind: string; readonly pattern: RegExp }[] = [
  ...sqlStatements,
  {
    kind: 'SQL GRANT of a row-changing privilege',
    pattern: /\bgrant\s+[^;]*?\b(?:delete|truncate|update)\b[^;]*?\bon\s+table\b[^;]*/iu,
  },
];

/** Every destructive or row-rewriting SQL statement of a migration, with the comments removed first. */
export const scanMigrationForDestruction = (sql: string): readonly DestructionFinding[] => {
  const code = sql.replaceAll(/--[^\n]*/gu, '').replaceAll(/\/\*[\s\S]*?\*\//gu, '');
  return migrationStatements.flatMap(({ kind, pattern }) =>
    [...code.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))].map((match) => ({
      kind,
      line: lineOf(code, match.index),
      text: match[0].replaceAll(/\s+/gu, ' ').trim(),
    })),
  );
};
