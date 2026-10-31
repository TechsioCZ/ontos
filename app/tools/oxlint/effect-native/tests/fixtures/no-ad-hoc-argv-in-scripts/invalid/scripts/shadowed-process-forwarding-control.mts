// expect-count: 1
import { ChildProcess } from 'effect/unstable/process';

// A local process lookalike is never native argv evidence. The genuine sibling
// read is still unproved because its slice is stored instead of forwarded directly.
export const local = (process: { argv: string[]; execPath: string }) =>
  ChildProcess.make(process.execPath, ['owner.mts', ...process.argv.slice(2)]);
export const unproved = globalThis.process.argv.slice(2);
