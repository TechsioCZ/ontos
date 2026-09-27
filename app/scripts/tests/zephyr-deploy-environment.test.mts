import { expect, it } from 'effect-rstest';

import { createZephyrRspackPlugin } from '../../packages/shared-contracts/tooling/modern-config.ts';

const setUp = (environment: Readonly<Record<string, string>>) => {
  const applied: string[] = [];
  createZephyrRspackPlugin({
    configure: () => 'zephyr',
    getBuildConfigEnvironment: (name: string) => environment[name],
  }).setup({
    modifyRspackConfig: (configuration: string) => {
      applied.push(configuration);
    },
  });
  return applied;
};

it('registers Zephyr only for a deploy that sets ZE_CI_TOKEN and ZE_FAIL_BUILD=true', () => {
  expect(setUp({})).toEqual([]);
  expect(setUp({ ZE_CI_TOKEN: 'token', ZE_FAIL_BUILD: 'true' })).toEqual(['zephyr']);
  expect(() => setUp({ ZE_CI_TOKEN: 'token' })).toThrow(/ZE_FAIL_BUILD=true/u);
  expect(() => setUp({ ZE_CI_TOKEN: 'token', ZE_FAIL_BUILD: 'false' })).toThrow(/ZE_FAIL_BUILD=true/u);
});
