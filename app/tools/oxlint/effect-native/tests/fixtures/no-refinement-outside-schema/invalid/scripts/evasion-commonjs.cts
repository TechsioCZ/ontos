// expect-count: 2
// Crash/scope probe: `.cts` script module with `export =` style interop and a satisfies clause.
export interface RunOptions {
  readonly dryRun: boolean;
}

export const isRunOptions = (value: unknown): value is RunOptions =>
  typeof value === 'object' && value !== null && 'dryRun' in value;

export const guardBag = {
  isRunOptions: (value: unknown): value is RunOptions => typeof value === 'object' && value !== null,
} satisfies Record<string, (value: unknown) => boolean>;
