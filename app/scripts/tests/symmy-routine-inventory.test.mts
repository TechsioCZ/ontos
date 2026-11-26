import { expect, it } from 'effect-rstest';

import { symmyExecutionRoutineMismatches } from '../../verticals/symmy-integration/scripts/verify-db-schema.mts';
import type { SymmyExecutionRoutineFacts } from '../../verticals/symmy-integration/scripts/verify-db-schema.mts';

const privateRoutines = new Set([
  'advance_route_change_token',
  'erase_symmy_effect_payload',
  'erase_symmy_plan_payload',
  'guard_route_enrollment_record',
  'materialize_demo_group_membership_route',
  'publish_route_execution_gate',
  'symmy_original_route_active',
]);
// The route triggers run as the table owner so the runtime role can write route rows.
const invokerRoutines = new Set([...privateRoutines, 'symmy_source_selector_code', 'pin_symmy_fixture_plan']);
for (const definer of [
  'materialize_demo_group_membership_route',
  'advance_route_change_token',
  'publish_route_execution_gate',
]) {
  invokerRoutines.delete(definer);
}

// Actual migrated catalog observed on stage: no connection or credentials are needed for this regression.
const routines: readonly SymmyExecutionRoutineFacts[] = `
advance_route_change_token can_execute_symmy_job_effect claim_symmy_job_effect claim_symmy_job_notification
erase_symmy_effect_payload erase_symmy_plan_payload guard_route_enrollment_record lock_symmy_enrollment_snapshot
lock_symmy_privacy_execution mark_symmy_job_effect_blocked mark_symmy_job_effect_indeterminate
mark_symmy_job_effect_unavailable materialize_demo_group_membership_route pin_symmy_fixture_plan
publish_route_execution_gate purge_symmy_job_intents purge_symmy_sync_intents read_symmy_job_execution
read_symmy_job_lifecycle read_symmy_job_notification_wake read_symmy_privacy_execution read_symmy_sync_lifecycle
record_symmy_owner_executor record_symmy_owner_invocation record_symmy_owner_receipt record_symmy_owner_request
record_symmy_privacy_execution record_symmy_resolved_effect settle_symmy_job_effect settle_symmy_job_notification
symmy_original_route_active symmy_source_selector_code
`
  .trim()
  .split(/\s+/u)
  .toSorted()
  .map((name) => ({
    definer: !invokerRoutines.has(name),
    name,
    public_execute: false,
    runtime_execute: !privateRoutines.has(name),
    safe_settings: true,
  }));

it('accepts the real 32-routine migration inventory including the private definer materialization trigger', () => {
  expect(routines).toHaveLength(32);
  expect(symmyExecutionRoutineMismatches(routines)).toEqual([]);
});

it('names broadened execution, unsafe settings or altered security mode on the definer triggers', () => {
  for (const [mutation, mismatch] of [
    [{ public_execute: true }, 'PUBLIC may execute it'],
    [{ runtime_execute: true }, 'runtime_execute is true, expected false'],
    [{ safe_settings: false }, 'search_path or row_security setting is missing'],
    [{ definer: false }, 'security definer is false, expected true'],
  ] as const) {
    for (const name of ['materialize_demo_group_membership_route', 'publish_route_execution_gate']) {
      expect(
        symmyExecutionRoutineMismatches(
          routines.map((routine) => (routine.name === name ? { ...routine, ...mutation } : routine)),
        ),
      ).toEqual([`routine ${name}: ${mismatch}`]);
    }
  }
});

it('still rejects missing routines, extra routines and duplicate overloads', () => {
  expect(
    symmyExecutionRoutineMismatches(routines.filter(({ name }) => name !== 'materialize_demo_group_membership_route')),
  ).not.toEqual([]);
  expect(
    symmyExecutionRoutineMismatches([
      ...routines,
      {
        definer: true,
        name: 'unexpected',
        public_execute: false,
        runtime_execute: false,
        safe_settings: true,
      },
    ]),
  ).not.toEqual([]);
  const [first] = routines;
  if (first === undefined) {
    throw new Error('missing catalog fixture');
  }
  expect(symmyExecutionRoutineMismatches([...routines, first])).not.toEqual([]);
});
