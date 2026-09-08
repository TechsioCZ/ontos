// expect-count: 5
import assert from 'node:assert/strict';
import * as assertions from 'node:assert';
import { expect } from 'effect-rstest';
declare const error: { _tag: string };
const { strictEqual } = assert;
strictEqual(error._tag, 'Missing');
const { strictEqual: equal } = assert;
equal(error._tag, 'Missing');
const { ['deepStrictEqual']: deepEqual } = assertions;
deepEqual([error._tag], ['Missing']);
const source = assertions.strict;
const { equal: check } = source;
const alias = check;
alias(error._tag, 'Missing');
const { toBe: matches } = expect(error._tag);
matches('Missing');
