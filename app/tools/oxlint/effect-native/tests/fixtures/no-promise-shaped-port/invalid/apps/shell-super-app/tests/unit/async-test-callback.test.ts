// expect-count: 6
import { it as check, test } from 'effect-rstest';
import * as suite from 'effect-rstest';
import { test as rawTest } from '@rstest/core';
import { it as vitestIt } from 'vitest';
import { test as nodeTest } from 'node:test';

test('plain callback', async () => {});
check.live('live callback', async () => {});
suite.test.each([1])('parameterized callback', async () => {});
rawTest('raw callback', async () => {});
vitestIt('vitest callback', async () => {});
nodeTest('node callback', async () => {});
