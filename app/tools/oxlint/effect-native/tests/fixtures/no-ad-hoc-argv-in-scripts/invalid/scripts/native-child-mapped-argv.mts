// expect-count: 1
import { ChildProcess } from 'effect/unstable/process';

export const command = ChildProcess.make(process.execPath, ['owner.mts', ...process.argv.slice(2).map((arg) => arg.trim())]);
