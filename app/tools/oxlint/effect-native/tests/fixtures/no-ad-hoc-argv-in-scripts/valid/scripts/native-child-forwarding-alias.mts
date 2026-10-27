import { ChildProcess as SDK } from 'effect/unstable/process';
import processHost from 'node:process';

const make = SDK.make;
export const command = make(processHost.execPath, ['reset-demo.mts', '--sales-demo', ...processHost.argv['slice'](2)]);
