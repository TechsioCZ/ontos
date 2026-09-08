// expect-count: 3
export type BacktickStatus = `dead` | `pending`;

export type MixedQuoting = 'dead' | "pending" | `stale`;

export type NullishBacktick = `off` | `on` | undefined;
