// expect-count: 3
// @effect-diagnostics anyUnknownInErrorContext:off asyncFunction:off
// @effect-diagnostics processEnv:off -- local only
// @effect-diagnostics globalDate:off -- The bootstrap seam reads the wall clock once at startup.

export const startedAt = new Date();
