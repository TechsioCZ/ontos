import { beforeAll, afterAll as teardown, beforeEach, afterEach } from '@app/effect-rstest';
import * as runner from '@app/effect-rstest';

const setup = async () => { await initialize(); };
beforeAll(setup);
const cleanup = async () => { await release(); };
teardown(cleanup);
const prepare = async () => { await initialize(); };
beforeEach(prepare);
const reset = async () => { await release(); };
afterEach(reset);

const register = runner.beforeAll;
const aliasedSetup = async () => { await initialize(); };
register(aliasedSetup);
const namespaceCleanup = async () => { await release(); };
runner.afterAll(namespaceCleanup);
const namespacePrepare = async () => { await initialize(); };
runner['beforeEach'](namespacePrepare);
const namespaceReset = async () => { await release(); };
runner.afterEach(namespaceReset);

beforeAll(async () => { await initialize(); });
runner.afterAll(async () => { await release(); });
