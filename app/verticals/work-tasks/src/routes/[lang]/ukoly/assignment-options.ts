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
