// expect-count: 2
import { ChildProcess } from 'effect/unstable/process';

export const hasReset = process.argv.includes('--reset');
export const command = ChildProcess.make(process.execPath, ['owner.mts', ...process.argv.slice(2)]);
