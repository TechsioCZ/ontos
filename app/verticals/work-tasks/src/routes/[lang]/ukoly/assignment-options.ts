import { Option } from 'effect';
import type { PrincipalRef } from '@app/core-runtime/permissions/principal-ref';
import type { WorkCommand } from '../../../../shared/actions/apply-command.ts';
import type { AssignmentPrincipal } from '../../../../shared/apis/records.ts';
import { principalKey } from '../../../../shared/assignment.ts';

export const assignmentOptions = (principals: readonly AssignmentPrincipal[]) =>
  principals.map((principal) => ({
    displayValue: principal.displayName,
    label: principal.displayName,
    value: principalKey(principal.principalRef),
  }));

export const selectedPrincipal = (principals: readonly AssignmentPrincipal[], value: string) =>
  principals.find((principal) => principalKey(principal.principalRef) === value)?.principalRef;

/** Keep an untouched assignment out of the patch; an emptied selection is the native explicit clear. */
export const assignmentPatch = (
  previous: PrincipalRef | undefined,
  selected: PrincipalRef | undefined,
): Pick<Extract<WorkCommand, { readonly _tag: 'UpdateTask' }>, 'ownerPrincipalRef'> => {
  if (previous?.tenantId === selected?.tenantId && previous?.principalId === selected?.principalId) {
    return {};
  }
  return { ownerPrincipalRef: Option.fromUndefinedOr(selected) };
};
