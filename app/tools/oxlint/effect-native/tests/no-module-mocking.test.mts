import { loadPluginRules, ruleTester, virtualFile } from './rule-tester.mts';

/**
 * The vendored anti-slop rule recognises the mock utility by binding: Rstest's `rs` / `rstest` from
 * `@rstest/core` or `effect-rstest`, Vitest's `vi`, Jest's `jest`, in any alias or through a namespace,
 * plus the unresolved globals. Local values that shadow those names are not the framework.
 */
const antiSlopRules = await loadPluginRules('../../anti-slop/index.ts');
const rule = antiSlopRules['no-module-mocking'];
if (rule === undefined) {
  throw new Error('anti-slop does not register no-module-mocking');
}

const filename = virtualFile('apps/demo/tests/unit/module-mocking.test.ts');
const moduleMock = (count: number) => Array.from({ length: count }, () => ({ messageId: 'moduleMock' }));

ruleTester.run('anti-slop/no-module-mocking', rule, {
  invalid: [
    {
      code: "import { rs } from '@rstest/core';\nrs.mock('../../src/auth-client.ts', () => ({}));",
      errors: moduleMock(1),
      filename,
      name: 'rs from @rstest/core',
    },
    {
      code: "import { rstest as runner } from 'effect-rstest';\nrunner.mock('../../src/auth-client.ts', () => ({}));",
      errors: moduleMock(1),
      filename,
      name: 'aliased rstest from effect-rstest',
    },
    {
      code: "import * as core from '@rstest/core';\ncore.rs.doMock('../../src/auth-client.ts');\ncore['rstest'].mock('./b.ts');",
      errors: moduleMock(2),
      filename,
      name: 'namespace imports of the framework',
    },
    {
      code: [
        "import { rs } from 'effect-rstest';",
        "rs.mockRequire('./a.cjs');",
        "rs.doMockRequire('./b.cjs');",
        "await rs.importMock('./c.ts');",
        "rs.requireMock('./d.cjs');",
      ].join('\n'),
      errors: moduleMock(4),
      filename,
      name: 'every Rstest module registry replacement',
    },
    {
      code: "vi.mock('./a.ts');\njest.mock('./b.ts');\nrstest.mock('./c.ts');\nrs.doMock('./d.ts');",
      errors: moduleMock(4),
      filename,
      name: 'unresolved framework globals',
    },
    {
      code: "import { vi as mocks } from 'vitest';\nmocks['mock']('./a.ts');\nmocks[`doMock`]('./b.ts');",
      errors: moduleMock(2),
      filename,
      name: 'computed and template keys on an aliased vi',
    },
    {
      code: "import { jest } from '@jest/globals';\njest.unstable_mockModule('./a.ts', () => ({}));\njest.setMock('./b.ts', {});",
      errors: moduleMock(2),
      filename,
      name: 'Jest module registry replacement',
    },
  ],
  valid: [
    {
      code: "const rs = { mock: (path: string) => path };\nrs.mock('./a.ts');\nconst vi = { mock: () => undefined };\nvi.mock();",
      filename,
      name: 'local objects shadowing rs and vi',
    },
    {
      code: "export const register = (jest: { mock(path: string): void }) => jest.mock('./a.ts');",
      filename,
      name: 'parameter shadowing jest',
    },
    {
      code: "import { rs } from './local-registry.ts';\nrs.mock('./a.ts');",
      filename,
      name: 'rs imported from a non-framework module',
    },
    {
      code: [
        "import { expect, rs } from '@rstest/core';",
        'const service = { save: (value: number) => value };',
        "const save = rs.spyOn(service, 'save');",
        'const onChange = rs.fn();',
        'onChange.mockImplementation(() => 1);',
        'service.save(1);',
        'expect(save).toHaveBeenCalledWith(1);',
        "await rs.importActual('./a.ts');",
        "rs.unmock('./a.ts');",
      ].join('\n'),
      filename,
      name: 'observation spies, function doubles and non-mocking registry calls',
    },
    {
      code: "const fixture = \"import { rs } from '@rstest/core';\\nrs.mock('./a.ts');\";\nexport const source = fixture;",
      filename,
      name: 'module mocking spelled inside a fixture string',
    },
  ],
});
