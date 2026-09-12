import type { ActionHandlerContext } from '@app/core-runtime';

interface EvidenceResourceRef {
  readonly moduleId: string;
  readonly resourceId: string;
  readonly resourceType: string;
}

type ProfileActionContext = Pick<ActionHandlerContext<Readonly<Record<string, never>>, unknown>, 'recordDataAccess'>;

export const recordProfileLookup = (context: ProfileActionContext, queryHash: string, resultCount: number) =>
  context.recordDataAccess({
    accessKind: 'read',
    queryHash,
    resultCount,
    servingModuleKey: 'commerce.customer-context',
  });

export const recordProfileResourceLookup = (
  context: ProfileActionContext,
  resourceRef: EvidenceResourceRef,
  queryHash: string,
  resultCount = 1,
) =>
  context.recordDataAccess({
    accessKind: 'read',
    queryHash,
    resultCount,
    servingModuleKey: 'commerce.customer-context',
    targetModuleKey: resourceRef.moduleId,
    targetResourceId: resourceRef.resourceId,
    targetResourceType: resourceRef.resourceType,
  });
