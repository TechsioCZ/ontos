import { Array as Arr, pipe } from 'effect';

export interface Row {
  readonly id: string;
  readonly label: string | null;
}

declare const rows: readonly (Row | undefined)[];
declare const entries: readonly [string, string | undefined][];

// D tier: native collection operations where Effect collection APIs add no semantic value.
export const present = rows.filter((row): row is Row => row !== undefined);
export const first = rows.find((row): row is Row => row !== undefined);
export const last = rows.findLast((row): row is Row => row !== undefined);
export const allPresent = rows.every((row): row is Row => row !== undefined);
export const anyPresent = rows.some((row): row is Row => row !== undefined);
export const labels = rows.flatMap((row): row is Row => row !== undefined);
export const pairs = entries.filter((entry): entry is [string, string] => entry[1] !== undefined);

// The same narrowing through Effect's own data module, point-free through `pipe`.
export const effectPresent = pipe(
  rows,
  Arr.filter((row): row is Row => row !== undefined),
);

export const RowList = () => <ul>{present.map((row) => <li key={row.id}>{row.label}</li>)}</ul>;
