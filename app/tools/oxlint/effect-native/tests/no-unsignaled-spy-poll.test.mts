import { testEffectNativeRule, virtualFile } from './rule-tester.mts';

const filename = virtualFile('apps/demo/tests/unit/spy-poll.test.tsx');
const poll = (count: number) => Array.from({ length: count }, () => ({ messageId: 'poll' }));
const spies = "import { expect, rs } from '@rstest/core';\nconst onSave = rs.fn();";

testEffectNativeRule('no-unsignaled-spy-poll', {
  invalid: [
    {
      code: [
        "import { waitFor } from '@testing-library/react';",
        spies,
        'await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1));',
        'await waitFor(() => expect(onSave).toHaveBeenLastCalledWith(expect.objectContaining({ id: 1 })));',
      ].join('\n'),
      errors: poll(2),
      filename,
      name: 'Testing Library waitFor on spy matchers',
    },
    {
      code: [
        "import { screen, waitFor as settle } from '@testing-library/react';",
        spies,
        'await settle(() => {',
        "  expect(screen.getByText('Saved')).toBeTruthy();",
        '  expect(onSave).not.toHaveBeenCalled();',
        '});',
      ].join('\n'),
      errors: poll(1),
      filename,
      name: 'aliased waitFor with a block mixing DOM and spy assertions',
    },
    {
      code: [
        "import * as dom from '@testing-library/dom';",
        "import { expect as assert, vi } from 'vitest';",
        'const onSave = vi.fn();',
        'await dom.waitFor(() => assert(onSave.mock.calls).toHaveLength(2));',
      ].join('\n'),
      errors: poll(1),
      filename,
      name: 'namespace waitFor on a recorder',
    },
    {
      code: [
        "import { expect, rstest } from 'effect-rstest';",
        'const onSave = rstest.fn();',
        'await rstest.waitUntil(() => onSave.mock.calls.length > 0);',
        'await rstest.waitFor(() => expect(onSave).toHaveBeenCalled());',
      ].join('\n'),
      errors: poll(2),
      filename,
      name: 'framework waitUntil and waitFor',
    },
    {
      code: [
        spies,
        'await expect.poll(() => onSave.mock.calls.length).toBe(1);',
        'await expect.poll(() => onSave).not.toHaveBeenCalled();',
        'await expect.poll(() => onSave).toHaveBeenCalledOnce();',
      ].join('\n'),
      errors: poll(3),
      filename,
      name: 'expect.poll on spy state',
    },
  ],
  valid: [
    {
      code: [
        "import { screen, waitFor } from '@testing-library/react';",
        spies,
        'declare const rows: readonly HTMLElement[];',
        "await waitFor(() => expect(screen.getByText('Saved')).toBeTruthy());",
        'await waitFor(() => expect(rows).toHaveLength(3));',
        "await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());",
        'expect(onSave).toHaveBeenCalledTimes(1);',
      ].join('\n'),
      filename,
      name: 'DOM and data polling, and direct spy assertions',
    },
    {
      code: [
        spies,
        'const waitFor = (check: () => void) => check();',
        'waitFor(() => expect(onSave).toHaveBeenCalled());',
      ].join('\n'),
      filename,
      name: 'local waitFor helper',
    },
    {
      code: [
        "import { Effect } from 'effect';",
        'const waitFor = Effect.fn(function* waitFor(count: number) { return count; });',
        'export const program = waitFor(1);',
      ].join('\n'),
      filename,
      name: 'Effect waitFor helper',
    },
    {
      code: [
        "import { waitFor } from '@testing-library/react';",
        "import { expect } from './assertions.ts';",
        'declare const onSave: () => void;',
        'await waitFor(() => expect(onSave).toHaveBeenCalled());',
      ].join('\n'),
      filename,
      name: 'expect from a non-framework module',
    },
    {
      code: [
        spies,
        'declare const fetchState: { mock: { calls: number } };',
        "await expect.poll(() => document.querySelectorAll('li').length).toBe(2);",
        'await expect.poll(() => fetchState.mock).toEqual({ calls: 1 });',
      ].join('\n'),
      filename,
      name: 'expect.poll on DOM and data',
    },
    {
      code: 'const fixture = "await waitFor(() => expect(onSave).toHaveBeenCalled());";\nexport { fixture };',
      filename,
      name: 'spy polling spelled inside a fixture string',
    },
  ],
});
