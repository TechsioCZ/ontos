import { AgentModuleKeySchema } from '@app/shared-contracts/agent-proposals';
import { expect, test } from 'effect-rstest';

import {
  effectiveAuthority,
  isModulesRequestWithin,
  minWritePolicy,
  offeredModules,
} from '../../../api/oauth-connections/effective-authority.ts';

const live = { read: new Set(['work.tasks', 'demo.crm']), write: new Set(['work.tasks']) };
const labelOf = (moduleId: string): string => moduleId;

test('minWritePolicy picks the more restrictive policy', () => {
  expect(minWritePolicy('approval', 'direct')).toBe('approval');
  expect(minWritePolicy('direct', 'read_only')).toBe('read_only');
});

test("requested 'all' offers every live module with write only where live write holds", () => {
  const authority = effectiveAuthority({
    labelOf,
    live,
    policyCap: 'direct',
    requested: 'all',
    requestedPolicy: 'direct',
  });
  expect(authority.modules.length).toBe(2);
  expect(authority.modules.find((m) => m.moduleId === 'work.tasks')?.write).toBe(true);
  expect(authority.modules.find((m) => m.moduleId === 'demo.crm')?.write).toBe(false);
});

test('explicit module list keeps only modules the principal holds live', () => {
  const authority = effectiveAuthority({
    labelOf,
    live: { read: new Set(['work.tasks']), write: new Set() },
    policyCap: 'direct',
    requested: [
      { access: 'write', moduleId: AgentModuleKeySchema.make('work.tasks') },
      { access: 'read', moduleId: AgentModuleKeySchema.make('finance.billing') },
    ],
    requestedPolicy: 'direct',
  });
  expect(authority.modules.map((m) => m.moduleId)).toEqual(['work.tasks']);
});

test('writePolicy is the minimum of requested policy and cap', () => {
  const authority = effectiveAuthority({
    labelOf,
    live,
    policyCap: 'approval',
    requested: 'all',
    requestedPolicy: 'direct',
  });
  expect(authority.writePolicy).toBe('approval');
});

test('read_only policy turns every write off', () => {
  const authority = effectiveAuthority({
    labelOf,
    live,
    policyCap: 'read_only',
    requested: 'all',
    requestedPolicy: 'direct',
  });
  expect(authority.modules.every((m) => !m.write)).toBe(true);
});

test('isModulesRequestWithin rejects write beyond offered write and accepts all', () => {
  const offered = offeredModules(live, 'read_only', labelOf);
  expect(
    isModulesRequestWithin([{ access: 'write', moduleId: AgentModuleKeySchema.make('work.tasks') }], offered),
  ).toBe(false);
  expect(isModulesRequestWithin([{ access: 'read', moduleId: AgentModuleKeySchema.make('work.tasks') }], offered)).toBe(
    true,
  );
  expect(isModulesRequestWithin('all', offered)).toBe(true);
});

test('isModulesRequestWithin rejects an empty module list', () => {
  expect(isModulesRequestWithin([], offeredModules(live, 'direct', labelOf))).toBe(false);
});
