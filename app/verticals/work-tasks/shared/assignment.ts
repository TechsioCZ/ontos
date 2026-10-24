import type { PrincipalRef } from '@app/core-runtime/permissions/principal-ref';

/** Picker values and name-map keys preserve the complete canonical identity. */
export const principalKey = (principal: PrincipalRef): string => `${principal.tenantId}:${principal.principalId}`;

/** A departed assignment stays attached to its work; it is never turned into an assignable option. */
export const assignmentLabel = (
  principal: PrincipalRef | undefined,
  names: ReadonlyMap<string, string>,
  needsReassignment = false,
): string => {
  if (needsReassignment) {
    return principal === undefined ? 'Nepřiřazeno – přeřadit' : 'Odešel – přeřadit';
  }
  return principal === undefined ? '—' : (names.get(principalKey(principal)) ?? 'Účet mimo seznam');
};
