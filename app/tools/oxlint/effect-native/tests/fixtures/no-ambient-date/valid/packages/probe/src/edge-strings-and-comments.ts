/** Prose mentions of the anti-pattern must never report. */
export const documentation = "call new Date() or Date.now() at your peril";
export const template = `Date.now() and ${"performance.now()"}`;
// Date.now(); new Date(); row.createdAt.toISOString();
export const leaseNote = "5 * 60 * 1000";
