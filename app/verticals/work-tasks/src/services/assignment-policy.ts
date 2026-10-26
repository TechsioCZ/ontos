import { defineMicroverticalPolicy, denyPolicy } from '@app/core-runtime';
import { loadAssignmentPreflightSnapshot, resolveAssignee } from '@app/core-runtime/auth/assignable-principals';
import type { PrincipalRef } from '@app/core-runtime/permissions/principal-ref';
import { and, eq } from 'drizzle-orm';
import { Effect, Match, Option, Schema } from 'effect';
import type { ApplyCommandPayload, WorkCommand } from '../../shared/actions/apply-command.ts';
import { WorkStateSchema } from '../../shared/apis/records.ts';
import type { WorkState } from '../../shared/apis/records.ts';
import { workStates } from '../database/schema.ts';

const samePrincipal = (left: PrincipalRef | undefined, right: PrincipalRef) =>
  left?.tenantId === right.tenantId && left.principalId === right.principalId;

/** An unchanged historical assignment is not a new assignment, even when the editor sends it back. */
export const changedAssignmentTarget = (command: WorkCommand, state?: WorkState): PrincipalRef | undefined =>
  Match.value(command).pipe(
    Match.tags({
      AddTaskComment: () => Option.none<PrincipalRef>(),
      AssignTask: ({ ownerPrincipalRef }) => Option.some(ownerPrincipalRef),
      BulkAssignTasks: ({ ownerPrincipalRef }) => ownerPrincipalRef,
      BulkChangeTaskState: () => Option.none<PrincipalRef>(),
      ChangeTaskState: () => Option.none<PrincipalRef>(),
      CreateProject: ({ responsiblePrincipalRef }) => Option.some(responsiblePrincipalRef),
      CreateTask: ({ ownerPrincipalRef }) => Option.fromUndefinedOr(ownerPrincipalRef),
      SetTaskArchived: () => Option.none<PrincipalRef>(),
      UpdateProject: ({ id, responsiblePrincipalRef }) =>
        samePrincipal(
          state?.projects?.find((project) => project.id === id)?.responsiblePrincipalRef,
          responsiblePrincipalRef,
        )
          ? Option.none<PrincipalRef>()
          : Option.some(responsiblePrincipalRef),
      UpdateTask: ({ ownerPrincipalRef, taskRef }) => {
        const task = state?.tasks.find(
          ({ ref }) => ref.resourceId === taskRef.resourceId && ref.tenantId === taskRef.tenantId,
        );
        return (ownerPrincipalRef ?? Option.none<PrincipalRef>()).pipe(
          Option.filter((target) => !samePrincipal(task?.ownerPrincipalRef, target)),
        );
      },
    }),
    Match.exhaustive,
    Option.getOrUndefined,
  );

/** Core evaluates policies before opening the mutation transaction. Never perform SpiceDB I/O in its handler. */
export const assignmentPolicy = defineMicroverticalPolicy<ApplyCommandPayload, 'work.tasks'>({
  evaluate: Effect.fn('Work.assignmentPreflight')(
    function* assignmentPreflight({ payload, principal, transport }) {
      if (changedAssignmentTarget(payload.command) === undefined) {
        return;
      }
      const legalEntityId = yield* Effect.succeed(principal.legalEntityId).pipe(
        Effect.filterOrFail(
          (value) => value !== undefined,
          () => denyPolicy('assignment_scope_required', 'A trusted company scope is required'),
        ),
      );
      const { directory, value } = yield* loadAssignmentPreflightSnapshot(
        { ...principal, correlationId: transport.correlationId, legalEntityId },
        Effect.fn('Work.loadAssignmentPreflight')(function* loadAssignmentPreflight(transaction) {
          const [row] = yield* transaction
            .select({ revision: workStates.revision, state: workStates.state })
            .from(workStates)
            .where(and(eq(workStates.tenantId, principal.tenantId), eq(workStates.legalEntityId, legalEntityId)))
            .limit(1);
          return row === undefined
            ? { revision: 0, state: Option.none<WorkState>() }
            : {
                revision: row.revision,
                state: Option.some(yield* Schema.decodeUnknownEffect(WorkStateSchema)(row.state)),
              };
        }),
      );
      // The handler checks this same revision before any write. A stale request cannot exploit
      // the unchanged-target exemption, and retains the normal owner revision-conflict response.
      if (value.revision !== payload.expectedRevision) {
        return;
      }
      const target = changedAssignmentTarget(payload.command, Option.getOrUndefined(value.state));
      if (target !== undefined) {
        yield* resolveAssignee(directory, target, { moduleId: 'work.tasks', permission: 'module.access' });
      }
    },
    Effect.catchTags({
      AssignablePrincipalsUnavailable: () =>
        Effect.fail(denyPolicy('assignment_unavailable', 'Assignment authorization is unavailable')),
      AssigneeIneligible: () => Effect.fail(denyPolicy('assignment_ineligible', 'Assignment target is not eligible')),
    }),
  ),
  owningModuleKey: 'work.tasks',
  policyKey: 'work.tasks.assignment-target.v1',
});
