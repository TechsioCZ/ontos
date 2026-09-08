// expect-count: 10
import { beforeAll, it, test } from 'effect-rstest';
import * as runner from 'effect-rstest';
import { beforeAll as fakeHook } from './owned-runner';

const fakeSetup = async () => { await initialize(); };
fakeHook(fakeSetup);

const shadowSetup = async () => { await initialize(); };
function shadowed(beforeAll: (setup: unknown) => void) {
  beforeAll(shadowSetup);
}

let mutableHook = beforeAll;
mutableHook = fakeHook;
const mutableSetup = async () => { await initialize(); };
mutableHook(mutableSetup);

const mixedSetup = async () => { await initialize(); };
beforeAll(mixedSetup);
ownedService(mixedSetup);

it.effect('owned program', async () => { await initialize(); });
test.effect('owned test program', async () => { await initialize(); });
runner.it.effect('namespace program', async () => { await initialize(); });
const namedProgram = async () => { await initialize(); };
it.effect('named owned program', namedProgram);

export const ownedTestService = async () => { await initialize(); };
beforeAll(ownedTestService);

const fakeMemberSetup = async () => { await initialize(); };
runner.beforeAll.owned(fakeMemberSetup);
