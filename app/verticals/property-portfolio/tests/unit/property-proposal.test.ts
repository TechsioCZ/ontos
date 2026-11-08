import { ActionProposalAcceptedSchema } from '@app/core-runtime/http/action-proposal';
import type { ActionProposalAccepted } from '@app/core-runtime/http/action-proposal';
import { Effect, Schema } from 'effect';
import { beforeEach, expect, it, rstest } from 'effect-rstest';
import type { PropertyCommand } from '../../shared/actions/apply-command.ts';
import { ApplyCommandActionConflictProblemSchema } from '../../shared/apis/apply-command-action.ts';
import { autosavePropertyEdit } from '../../src/routes/[lang]/nemovitosti/use-property-editor.ts';

const { apply, records } = rstest.hoisted(() => ({ apply: rstest.fn(), records: rstest.fn() }));

rstest.mock('../../src/api/apply-command-action-client.ts', () => ({ executeApplyCommand: apply }));
rstest.mock('../../src/api/records-client.ts', () => ({ executeRecords: records }));

const tenantId = '70000000-0000-4000-8000-000000000020';
const unitRef = {
  moduleId: 'property.portfolio',
  resourceId: '76000000-0000-4000-8000-000000000002',
  resourceType: 'property.portfolio.unit',
  tenantId,
} as const;
const command: PropertyCommand = { _tag: 'UpdateUnit', name: 'Second Floor', note: null, unitRef };
const proposal = Schema.decodeUnknownSync(ActionProposalAcceptedSchema)({
  _tag: 'ActionProposalAccepted',
  expiresAt: '2026-11-14T10:00:00.000Z',
  proposalId: '77777777-7777-4777-8777-777777777777',
});
const conflict = Schema.decodeUnknownSync(ApplyCommandActionConflictProblemSchema)({
  _tag: 'ApplyCommandActionConflictProblem',
  code: 'property_conflict',
  detail: 'Nemovitosti se mezitím změnily.',
  status: 409,
  title: 'Konflikt',
  type: 'about:blank',
});

beforeEach(() => {
  apply.mockReset();
  records.mockReset();
});

it.effect('keeps an autosaved edit parked for approval unsaved and reports the proposal', () =>
  Effect.gen(function* parked() {
    apply.mockReturnValue(Effect.succeed(proposal));
    const reported: ActionProposalAccepted[] = [];
    const result = yield* autosavePropertyEdit(
      command,
      4,
      () => true,
      (value) => {
        reported.push(value);
      },
    );
    expect(result).toBe('failed');
    expect(reported).toEqual([proposal]);
    expect(apply).toHaveBeenCalledTimes(1);
  }),
);

it.effect('adopts the committed revision of an autosaved edit without reporting a proposal', () =>
  Effect.gen(function* committed() {
    apply.mockReturnValue(Effect.succeed({ resourceRef: unitRef, revision: 5 }));
    const reported: ActionProposalAccepted[] = [];
    const result = yield* autosavePropertyEdit(
      command,
      4,
      () => true,
      (value) => {
        reported.push(value);
      },
    );
    expect(result).toBe(5);
    expect(reported).toEqual([]);
  }),
);

it.effect('treats a resend after a register race that is parked for approval as not saved', () =>
  Effect.gen(function* raced() {
    apply.mockReturnValueOnce(Effect.fail(conflict)).mockReturnValueOnce(Effect.succeed(proposal));
    records.mockReturnValue(Effect.succeed({ assets: [], properties: [], revision: 6, units: [] }));
    const reported: ActionProposalAccepted[] = [];
    const result = yield* autosavePropertyEdit(
      command,
      4,
      () => true,
      (value) => {
        reported.push(value);
      },
    );
    expect(result).toBe('failed');
    expect(reported).toEqual([proposal]);
    expect(apply).toHaveBeenCalledTimes(2);
  }),
);
