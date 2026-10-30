import { expect, test } from 'effect-rstest';

import {
  buildModulesRequest,
  defaultPolicy,
  navigationTarget,
  policyOptionState,
} from '../../../../src/routes/[lang]/pripojit/connect-view-model.ts';

test('policyOptionState disables writing modes above the agent ceiling', () => {
  expect(policyOptionState('direct', 'approval')).toEqual({
    disabled: true,
    reasonKey: 'shell.connect.policy.agentApprovalOnly',
  });
  expect(policyOptionState('approval', 'read_only')).toEqual({
    disabled: true,
    reasonKey: 'shell.connect.policy.agentReadOnly',
  });
  expect(policyOptionState('approval', 'direct')).toEqual({ disabled: false, reasonKey: null });
});

test('defaultPolicy picks the safest writing mode the ceiling allows', () => {
  expect(defaultPolicy('read_only')).toBe('read_only');
  expect(defaultPolicy('direct')).toBe('approval');
});

test('buildModulesRequest sends all or only the readable picks with write access', () => {
  expect(buildModulesRequest('all', new Map())).toBe('all');
  expect(
    buildModulesRequest(
      'pick',
      new Map([
        ['a', { read: true, write: true }],
        ['b', { read: false, write: false }],
      ]),
    ),
  ).toEqual([{ access: 'write', moduleId: 'a' }]);
});

test('navigationTarget accepts only http(s) URLs and same-origin paths', () => {
  expect(navigationTarget({ url: 'https://x/cb?code=1' }, false, '')).toBe('https://x/cb?code=1');
  expect(navigationTarget({}, true, 'http://localhost:5555/cb')).toBe('http://localhost:5555/cb');
  expect(navigationTarget({ url: ['javascript', 'x'].join(':') }, false, '')).toBeUndefined();
});
