// False positive reproduction (adversarial review).
//
// Real sites: `packages/core-runtime/tests/unit/schema-contract.test.ts:19` and
// `verticals/contacts/tests/unit/schema-contract.test.ts:27`.
//
// The predicate adds NO hand-written refinement: its whole body is a single delegating call to
// Drizzle's own runtime guard `isTable`, narrowing a union of module exports to the framework's
// table objects. This is the same "typing seam over an existing authority" shape the rule already
// blesses for `Schema.is(S)(x)`, `Predicate.*` and `Array.isArray` — there is no second validation
// authority and nothing can drift. The suggested remedy is also inexpressible: no `Schema` can own
// "is this value a Drizzle `PgTable` instance".
import { isTable } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';

import * as schemaExports from '../../src/db/schema.ts';

type SchemaExport = (typeof schemaExports)[keyof typeof schemaExports];

export const isPgTable = (value: SchemaExport): value is Extract<SchemaExport, PgTable> => isTable(value);

export const exportedTables = Object.values(schemaExports).filter(isPgTable);
