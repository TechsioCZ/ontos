// expect-count: 2
/* eslint-disable @typescript-eslint/no-explicit-any -- Better Auth exposes untyped adapter callbacks at this single boundary. */
/* oxlint-disable
   promise/avoid-new
   -- Child-process events are bounded explicitly by the harness. */

export const bridge = (value: unknown): unknown => value;
