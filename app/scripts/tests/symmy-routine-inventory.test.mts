import { expect, it } from 'effect-rstest';

import { symmyExecutionRoutineInventoryMatches } from '../../verticals/symmy-integration/scripts/verify-db-schema.mts';
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
const invokerRoutines = new Set([...privateRoutines, 'symmy_source_selector_code', 'pin_symmy_fixture_plan']);
invokerRoutines.delete('materialize_demo_group_membership_route');

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
  .sort()
  .map((name) => ({
    name,
    definer: !invokerRoutines.has(name),
    public_execute: false,
    runtime_execute: !privateRoutines.has(name),
    safe_settings: true,
  }));

it('accepts the real 32-routine migration inventory including the private definer materialization trigger', () => {
  expect(routines).toHaveLength(32);
  expect(symmyExecutionRoutineInventoryMatches(routines)).toBe(true);
});

it('rejects broadened execution, unsafe settings or altered security mode on the materialization trigger', () => {
  for (const mutation of [
    { public_execute: true },
    { runtime_execute: true },
    { safe_settings: false },
    { definer: false },
  ]) {
    expect(
      symmyExecutionRoutineInventoryMatches(
        routines.map((routine) =>
          routine.name === 'materialize_demo_group_membership_route' ? { ...routine, ...mutation } : routine,
        ),
      ),
    ).toBe(false);
  }
});

it('still rejects missing routines, extra routines and duplicate overloads', () => {
  expect(
    symmyExecutionRoutineInventoryMatches(
      routines.filter(({ name }) => name !== 'materialize_demo_group_membership_route'),
    ),
  ).toBe(false);
  expect(
    symmyExecutionRoutineInventoryMatches([
      ...routines,
      {
        name: 'unexpected',
        definer: true,
        public_execute: false,
        runtime_execute: false,
        safe_settings: true,
      },
    ]),
  ).toBe(false);
  const first = routines[0];
  if (first === undefined) throw new Error('missing catalog fixture');
  expect(symmyExecutionRoutineInventoryMatches([...routines, first])).toBe(false);
});
