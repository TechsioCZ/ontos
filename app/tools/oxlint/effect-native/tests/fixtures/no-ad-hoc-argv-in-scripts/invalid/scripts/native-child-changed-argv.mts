// expect-count: 1
import { ChildProcess } from 'effect/unstable/process';

process.argv = ['node', 'owner.mts', '--replacement'];
export const command = ChildProcess.make(process.execPath, ['owner.mts', ...process.argv.slice(2)]);
