// expect-count: 3
import { expect } from 'effect-rstest';
declare const error: unknown;
const fake = (value: unknown) => value;
let reassigned = expect;
reassigned = fake;
let { arrayContaining: detached } = expect;
detached = fake;
expect.objectContaining = fake;
expect(error).toEqual(expect.arrayContaining([{ _tag: 'Missing' }]));
const alias = expect;
expect(error).toEqual(alias.arrayContaining([{ _tag: 'Missing' }]));
const { arrayContaining: items } = expect;
expect(error).toEqual(items([{ _tag: 'Missing' }]));
