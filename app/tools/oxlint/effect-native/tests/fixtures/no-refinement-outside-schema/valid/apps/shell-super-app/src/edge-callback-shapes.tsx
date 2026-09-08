// Robustness probe (must stay silent): the blessed inline-collection-callback shape written through
// optional chaining, computed member access, redundant parentheses, a generic arrow, a function
// expression, and Effect's own data module point-free through `pipe` — plus optional-chained
// delegation to the owning Schema.
import { Array as Arr, pipe, Schema } from 'effect';

export interface Row {
  readonly id: string;
}

declare const rows: readonly (Row | undefined)[];
declare const RowSchema: Schema.Codec<Row, Row>;

export const viaOptionalChain = rows?.filter((row): row is Row => row !== undefined);
export const viaComputed = rows['filter']((row): row is Row => row !== undefined);
export const viaParens = rows.filter(((row): row is Row => row !== undefined));
export const viaGeneric = rows.filter(<Value,>(row: Value | undefined): row is Value => row !== undefined);
export const viaFunctionExpression = rows.filter(function (row): row is Row {
  return row !== undefined;
});
export const viaPipe = pipe(
  rows,
  Arr.findFirst((row): row is Row => row !== undefined),
);

export const isRow = (value: unknown): value is Row => Schema?.is(RowSchema)(value);

export const RowList = () => <ul>{viaOptionalChain?.map((row) => <li key={row.id} />)}</ul>;
