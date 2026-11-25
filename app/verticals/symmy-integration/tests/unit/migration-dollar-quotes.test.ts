import { fileURLToPath } from 'node:url';

import { NodeFileSystem } from '@effect/platform-node';
import { Array as EffectArray, Effect, FileSystem, Order } from 'effect';
import { expect, it } from 'effect-rstest';

/**
 * Why a statement of a migration cannot be parsed for its dollar quotes: a `$` that opens no dollar quote, positional
 * parameter or identifier part, or a dollar quote whose closing tag never follows in the same statement. Comments,
 * quoted literals and the bodies of dollar quotes are skipped as PostgreSQL's lexer skips them; its block comments
 * nest, so a comment ends only where its outermost opening is closed.
 */
/** Where the block comment opened at `start` ends, past its outermost close, or none when it never closes. */
const blockCommentEnd = (statement: string, start: number): number | undefined => {
  let depth = 1;
  let index = start + 2;
  while (depth > 0 && index < statement.length) {
    if (statement.startsWith('/*', index)) {
      depth += 1;
      index += 2;
    } else if (statement.startsWith('*/', index)) {
      depth -= 1;
      index += 2;
    } else {
      index += 1;
    }
  }
  return depth === 0 ? index : undefined;
};

const dollarQuoteDefects = (statement: string): readonly string[] => {
  const defects: string[] = [];
  const tag = /\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/uy;
  let index = 0;
  while (index < statement.length) {
    const character = statement.charAt(index);
    const next = statement.charAt(index + 1);
    if (character === '-' && next === '-') {
      const end = statement.indexOf('\n', index);
      index = end === -1 ? statement.length : end + 1;
    } else if (character === '/' && next === '*') {
      const end = blockCommentEnd(statement, index);
      if (end === undefined) {
        return [...defects, `a comment opened at offset ${String(index)} is never closed`];
      }
      index = end;
    } else if (character === "'" || character === '"') {
      let end = statement.indexOf(character, index + 1);
      while (end !== -1 && statement.charAt(end + 1) === character) {
        end = statement.indexOf(character, end + 2);
      }
      if (end === -1) {
        return [...defects, `a ${character} literal opened at offset ${String(index)} is never closed`];
      }
      index = end + 1;
    } else if (character === '$' && !/[A-Za-z0-9_$]/u.test(statement.charAt(index - 1))) {
      tag.lastIndex = index;
      const opened = tag.exec(statement)?.[0];
      if (opened === undefined) {
        if (!/[0-9]/u.test(next)) {
          defects.push(`a $ at offset ${String(index)} opens no dollar quote`);
        }
        index += 1;
      } else {
        const closed = statement.indexOf(opened, index + opened.length);
        if (closed === -1) {
          return [...defects, `${opened} opened at offset ${String(index)} is never closed in its statement`];
        }
        index = closed + opened.length;
      }
    } else {
      index += 1;
    }
  }
  return defects;
};

const migrationsDirectory = fileURLToPath(new URL('../../drizzle/', import.meta.url));

it.layer(NodeFileSystem.layer)('Symmy migration dollar quotes', (suite) => {
  suite.effect('closes every dollar-quoted body of every migration within its own statement', () =>
    Effect.gen(function* everyMigrationParses() {
      const fileSystem = yield* FileSystem.FileSystem;
      const folders = EffectArray.sort(yield* fileSystem.readDirectory(migrationsDirectory), Order.String);
      expect(folders.length).toBeGreaterThan(0);
      for (const folder of folders) {
        const migration = yield* fileSystem.readFileString(`${migrationsDirectory}${folder}/migration.sql`);
        const defects = migration
          .split('--> statement-breakpoint')
          .flatMap((statement, position) =>
            dollarQuoteDefects(statement).map((defect) => `statement ${String(position + 1)}: ${defect}`),
          );
        expect(defects, folder).toEqual([]);
      }
    }),
  );

  suite.effect(
    'refuses a body that opens with a lone $ and closes with $$, and accepts tagged and positional uses',
    () =>
      Effect.sync(() => {
        expect(
          dollarQuoteDefects('CREATE FUNCTION f() RETURNS trigger LANGUAGE plpgsql AS $\nBEGIN RETURN NEW; END; $$;'),
        ).toEqual([
          'a $ at offset 56 opens no dollar quote',
          '$$ opened at offset 81 is never closed in its statement',
        ]);
        expect(
          dollarQuoteDefects(
            "CREATE FUNCTION f(a int) RETURNS int LANGUAGE sql AS $body$ SELECT $1 + 1; -- '$$' $body$; SELECT 'a$b', \"x$y\", $1",
          ),
        ).toEqual([]);
      }),
  );

  suite.effect('skips a nested block comment whole, as PostgreSQL ends it only at its outermost close', () =>
    Effect.sync(() => {
      // The first */ closes the inner comment, so the $$ before the second */ is comment text and the body never closes.
      expect(dollarQuoteDefects('AS /* outer /* inner */ $$ */ $$ SELECT 1;')).toEqual([
        '$$ opened at offset 30 is never closed in its statement',
      ]);
      expect(dollarQuoteDefects('AS /* outer /* inner */ $$ */ $$ SELECT 1; $$;')).toEqual([]);
    }),
  );
});
