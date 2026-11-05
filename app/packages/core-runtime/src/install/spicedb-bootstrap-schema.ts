import { ONTOS_SPICEDB_SCHEMA } from '../permissions/schema.ts';

/*
 * The SpiceDB bootstrap files this repository ships (CUTOVER-PLAN §3.6, O62.3). A bootstrap file is read
 * by the engine only when its datastore is empty, so it carries the schema and nothing else: after
 * authorization v2 there is no seed data to publish, because a tenant's relationships are projected from
 * PostgreSQL by the one Core writer (`AccessProjectionWriter.reconcileTenant`) and a hand-written tuple
 * would be reconciled away by the next write anyway.
 *
 * Both files are generated from the one schema constant, so the engine an environment starts from is
 * exactly the schema Core serves, and a schema change is a regeneration of these two files plus the
 * review of that diff. `tests/unit/spicedb-database-bootstrap.test.ts` regenerates both and compares them
 * byte for byte, which is what makes a stale bootstrap file a failing test instead of a stage surprise.
 */

/** The one paragraph both files carry: what they are, what they are not, and where they come from. */
const preamble = [
  '# Generated from ONTOS_SPICEDB_SCHEMA (packages/core-runtime/src/permissions/schema.ts).',
  '# Do not edit by hand: change the schema constant and regenerate (see',
  '# src/install/spicedb-bootstrap-schema.ts, pinned by tests/unit/spicedb-database-bootstrap.test.ts).',
  '#',
  '# Schema only. Core projects every relationship from PostgreSQL intent, so a bootstrap file never',
  '# carries development or stage grants, and the engine reads this file only when its datastore is empty.',
];

/** Two spaces of YAML block indentation, applied to every line of the schema constant. */
const indent = (schema: string): string =>
  schema
    .replace(/\n$/u, '')
    .split('\n')
    .map((line) => (line.length === 0 ? line : `  ${line}`))
    .join('\n');

/**
 * One bootstrap file: the preamble, then the v2 schema as a literal YAML block. Nothing else — no
 * `relationships:` and no `assertions:` section, so an engine that loads it starts with a schema and an
 * empty graph.
 */
export const spicedbBootstrapYaml = (schema: string = ONTOS_SPICEDB_SCHEMA): string =>
  `${preamble.join('\n')}\nschema: |-\n${indent(schema)}\n`;
