// expect-count: 2
import { Predicate } from 'effect';

export interface PgTable {
  readonly name: string;
}
export type SchemaExport = PgTable | { readonly relation: string };

declare const isTable: (value: SchemaExport) => boolean;
declare const exports_: readonly SchemaExport[];

// Tests duplicate the same refinement vocabulary; the audit counts these too.
const isPgTable = (value: SchemaExport): value is Extract<SchemaExport, PgTable> => isTable(value);

const isRuntimeObject = <Value>(value: Value): value is Value & object =>
  value !== null && Object(value) === value;

// Blessed by the D tier and by `allowInlineCallbacks`: not reported, even inside an invalid fixture.
const tables = exports_.filter((value): value is PgTable => isPgTable(value));
const names = exports_
  .filter((value): value is PgTable => Predicate.isNotNull(value) && 'name' in value)
  .map((table) => table.name);

export const fixtures = { isRuntimeObject, names, tables };
