// expect-count: 1
import { ChildProcess } from 'effect/unstable/process';

const args = process.argv.slice(2);
export const command = ChildProcess.make(process.execPath, ['owner.mts', ...args]);
