// expect-count: 4
import { expect } from 'effect-rstest';
declare const error: unknown;
declare const tag: string;
expect(error).toMatchObject({ _tag: 'ModuleStateDeniedError' });
expect(error).not.toMatchObject({ ['_tag']: 'Missing' });
const expected = { _tag: tag };
expect(error).toMatchObject(expected);
const assertion = expect;
assertion(error).rejects.toMatchObject({ _tag: 'Missing', reason: 'denied' });
