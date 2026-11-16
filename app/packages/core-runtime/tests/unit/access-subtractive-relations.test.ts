import { NodeServices } from '@effect/platform-node';
import { Effect, FileSystem } from 'effect';
import { expect, it } from 'effect-rstest';

import { SUBTRACTIVE_RELATIONS } from '../../src/access/compiler/spice-db-compiler.ts';
import { ONTOS_SPICEDB_SCHEMA } from '../../src/permissions/schema.ts';

/*
 * The compiler writes revocations before grants, and for a relation subtracted in a permission (`member - suspended`)
 * a TOUCH revokes and a DELETE grants. Every such relation must be known to the compiler: an exclusion added to the
 * schema without being listed would be written in the wrong order.
 */
const subtractedIn = (schema: string): readonly string[] => {
  const found: string[] = [];
  let definition = '';
  for (const line of schema.split('\n')) {
    const opened = /^\s*definition\s+(?<name>[a-z_/]+)\s*\{/u.exec(line);
    if (opened?.groups?.['name'] !== undefined) {
      definition = opened.groups['name'];
    }
    const permission = /^\s*permission\s+[a-z_]+\s*=\s*(?<expression>.*)$/u.exec(line);
    const parts = (permission?.groups?.['expression'] ?? '').split(' - ').slice(1);
    for (const part of parts) {
      const operand = /^[\s(]*(?<name>[a-z_]+(?:->[a-z_]+)?)/u.exec(part)?.groups?.['name'];
      if (operand !== undefined) {
        found.push(`${definition}#${operand}`);
      }
    }
  }
  return found;
};

const listed = SUBTRACTIVE_RELATIONS.map(({ relation, resourceType }) => `${resourceType}#${relation}`).toSorted();

it.layer(NodeServices.layer)('subtractive relations', (suite) => {
  suite.effect('every relation an exclusion subtracts is listed for the compiler, in both schema sources', () =>
    Effect.gen(function* everyExclusionListed() {
      const files = yield* FileSystem.FileSystem;
      const bootstrap = yield* files.readFileString(new URL('../../spicedb/bootstrap.yaml', import.meta.url).pathname);
      expect([...new Set(subtractedIn(bootstrap))].toSorted()).toEqual(listed);
      expect([...new Set(subtractedIn(ONTOS_SPICEDB_SCHEMA))].toSorted()).toEqual(listed);
    }),
  );
});
