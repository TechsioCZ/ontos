// expect-count: 2
// Capturing a diagnostic sink for actual emission is not vendor save/restore.
const warn = console.warn;
export const report = (message: string) => warn(message);
