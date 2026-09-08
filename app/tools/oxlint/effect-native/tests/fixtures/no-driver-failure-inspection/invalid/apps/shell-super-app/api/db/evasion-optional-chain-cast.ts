// expect-count: 2
declare const rows: ReadonlyArray<{ readonly cause?: unknown }>;
export const first = rows[0]?.cause;
export const nested = ((rows[1] as { readonly cause?: unknown })!).cause;
