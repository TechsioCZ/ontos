import type { OwnerAccessFacts } from '@app/core-runtime';

/** The owner fact naming the destination parent of a create or move, read by the destination authority. */
export const PROJECT_DESTINATION_PARENT_FACT = 'destinationParentProjectId';

/** An absent parent is an explicit move to the tenant root, not an unproved destination. */
export const projectDestinationParentFacts = (parentProjectId: null | string | undefined): OwnerAccessFacts =>
  parentProjectId === null || parentProjectId === undefined
    ? {}
    : { [PROJECT_DESTINATION_PARENT_FACT]: parentProjectId };
