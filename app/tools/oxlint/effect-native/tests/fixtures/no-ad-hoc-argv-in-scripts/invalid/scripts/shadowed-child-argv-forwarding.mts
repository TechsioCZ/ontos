// expect-count: 1
import { ChildProcess } from 'effect/unstable/process';

export const forward = (ChildProcess: { make: (command: string, args: readonly string[]) => unknown }) =>
  ChildProcess.make(process.execPath, ['owner.mts', ...process.argv.slice(2)]);
void ChildProcess;
