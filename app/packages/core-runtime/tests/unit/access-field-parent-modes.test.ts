import { Effect } from 'effect';
import { expect, it } from 'effect-rstest';

import type { AccessMode } from '../../src/access/model.ts';
import type { AccessDecisionRequest, DecisionCapabilityPolicy } from '../../src/access/decision/contract.ts';
import { decideAccess, decideAccessMany } from '../../src/access/decision/engine.ts';
import { ModuleKeySchema, RecordKeySchema } from '../../src/access/ids.ts';
import { at, capability, cell, makeAuthority, makeCheck, person, tenant } from './access-decision-support.ts';

const parentKey = 'demo.workforce.employee.update';
const fieldKey = 'demo.workforce.employee.write-salary';
const parent: DecisionCapabilityPolicy = {
  capabilityKey: capability(parentKey),
  kind: 'action',
  modes: ['run', 'propose', 'approve'],
  risk: 'sensitive',
  selectors: ['all'],
};
const field: DecisionCapabilityPolicy = {
  capabilityKey: capability(fieldKey),
  fieldClass: 'salaries',
  kind: 'field_write',
  modes: ['run', 'propose', 'approve'],
  risk: 'sensitive',
  selectors: [],
};
const targets = ['employee-1', 'employee-2'].map((recordKey) => ({
  moduleKey: ModuleKeySchema.make('demo.workforce'),
  recordKey: RecordKeySchema.make(recordKey),
}));
const requests = (mode: AccessMode): readonly AccessDecisionRequest[] =>
  targets.map((target) => ({
    capability: field,
    mode,
    parentRead: { capability: parent, target },
    target,
  }));
const input = (request: AccessDecisionRequest) => ({
  actor: { actor: { _tag: 'Principal' as const, principalId: person }, tenantId: tenant },
  now: at('2026-11-07T00:00:00Z'),
  request,
});

for (const mode of ['run', 'propose', 'approve'] as const) {
  it.effect(`checks every field parent in effective ${mode} mode in single and batched decisions`, () =>
    Effect.gen(function* effectiveFieldParentMode() {
      const cells = [cell({ capability: parentKey, mode }), cell({ capability: fieldKey, mode })];
      const authority = makeAuthority({ cells });
      const check = makeCheck({ authority: { cells } });
      for (const request of requests(mode)) {
        const decision = yield* decideAccess(authority.port, check.port, input(request));
        expect(decision.outcome).toBe('ALLOWED');
        expect(decision.evidence.every((evidence) => evidence.mode === mode)).toBe(true);
        expect(decision.evidence.some((evidence) => evidence.witness.purpose === 'parent_record_read')).toBe(true);
      }
      const [batched] = yield* decideAccessMany(check.port, [
        { authority: authority.port, inputs: requests(mode).map(input) },
      ]);
      expect(batched?.map((decision) => decision.outcome)).toEqual(['ALLOWED', 'ALLOWED']);
      expect(batched?.every((decision) => decision.evidence.every((evidence) => evidence.mode === mode))).toBe(true);

      const wrongMode = mode === 'approve' ? 'run' : 'approve';
      const wrong = { cells: [cell({ capability: parentKey, mode: wrongMode }), cell({ capability: fieldKey, mode })] };
      const [denied] = yield* decideAccessMany(makeCheck({ authority: wrong }).port, [
        {
          authority: makeAuthority(wrong).port,
          inputs: requests(mode).map(input),
        },
      ]);
      expect(denied?.every((decision) => decision.outcome !== 'ALLOWED')).toBe(true);
    }),
  );
}
