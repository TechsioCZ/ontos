// @effect-diagnostics asyncFunction:off
import { rejectAction } from '@app/core-runtime';
import type {
  ActionAuditEventDescriptor,
  ActionDomainEventDescriptor,
  ActionHandler,
  ActionRegistration,
} from '@app/core-runtime';
import {
  deleteTaskPropertyDefinitionActionKey,
  deleteTaskPropertyDefinitionActionPayloadSchema,
  deleteTaskPropertyDefinitionActionResponseSchema,
} from '../../shared/actions/delete-task-property-definition.ts';
import { lockTaskCollectionForPropertyInitialization } from '../task-collection-property-initialization-lock.ts';
import {
  deleteTaskPropertyDefinition,
  getTaskPropertyDefinitionDeletionImpact,
  lockTaskPropertyDefinitionLifecycleTarget,
} from '../task-property-definition-lifecycle.ts';
import type {
  DeleteTaskPropertyDefinitionActionPayload,
  DeleteTaskPropertyDefinitionActionResponse,
} from '../../shared/actions/delete-task-property-definition.ts';
import type { TaskPropertyDefinition } from '../../shared/task-property-definition.ts';

const deletedDatatypeEvidence = Symbol('deletedDatatypeEvidence');

type DeleteTaskPropertyDefinitionInternalResponse = DeleteTaskPropertyDefinitionActionResponse & {
  readonly [deletedDatatypeEvidence]: TaskPropertyDefinition['datatype'];
};

const deletedDefinitionEvidence = (
  input: DeleteTaskPropertyDefinitionActionPayload,
  response: DeleteTaskPropertyDefinitionInternalResponse,
) => {
  const deletedDatatype = response[deletedDatatypeEvidence];
  return {
    changedComponents:
      deletedDatatype === 'id'
        ? ['definition', 'idPrefix', 'idAssignments', 'idSequence']
        : ['definition', 'propertyValues'],
    collectionId: input.collectionId,
    datatype: deletedDatatype,
    impactCount: response.impactCount,
    operation: 'deleted',
    propertyDefinitionId: response.deletedPropertyDefinitionId,
    revision: input.expectedRevision,
  };
};

const deleteTaskPropertyDefinitionAuditEvent = {
  evidence: deletedDefinitionEvidence,
  targetModuleKey: 'ticketing',
  targetResourceId: (_input, response) => response.deletedPropertyDefinitionId,
  targetResourceType: 'task_property_definition',
} satisfies ActionAuditEventDescriptor<
  DeleteTaskPropertyDefinitionActionPayload,
  DeleteTaskPropertyDefinitionInternalResponse
>;

const deleteTaskPropertyDefinitionDomainEvent = {
  eventType: 'ticketing.taskPropertyDefinition.deleted',
  payload: deletedDefinitionEvidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (_input, response) => response.deletedPropertyDefinitionId,
  subjectResourceType: 'task_property_definition',
} satisfies ActionDomainEventDescriptor<
  DeleteTaskPropertyDefinitionActionPayload,
  DeleteTaskPropertyDefinitionInternalResponse
>;

const deleteTaskPropertyDefinitionActionHandler: ActionHandler<
  DeleteTaskPropertyDefinitionActionPayload,
  DeleteTaskPropertyDefinitionInternalResponse
> = async (input, services) => {
  if (input.confirmed !== true) {
    throw rejectAction({
      code: 'ticketing.deleteTaskPropertyDefinition.confirmation_required',
      message: 'Task Property deletion must be explicitly confirmed.',
    });
  }

  await lockTaskCollectionForPropertyInitialization({
    collectionId: input.collectionId,
    tenantId: services.context.tenantId,
    tx: services.tx,
  });

  const target = await lockTaskPropertyDefinitionLifecycleTarget({
    collectionId: input.collectionId,
    propertyDefinitionId: input.propertyDefinitionId,
    tenantId: services.context.tenantId,
    tx: services.tx,
  });
  if (target === undefined || target.revision !== input.expectedRevision) {
    throw rejectAction({
      code: 'ticketing.deleteTaskPropertyDefinition.stale_or_missing',
      message: 'The Task Property Definition changed elsewhere or is no longer available.',
    });
  }
  const confirmation = await getTaskPropertyDefinitionDeletionImpact({
    db: services.tx,
    target,
  });
  const impactRevisionChanged =
    target.datatype === 'files_media'
      ? confirmation.impactRevision !== input.expectedImpactRevision
      : input.expectedImpactRevision !== undefined &&
        confirmation.impactRevision !== input.expectedImpactRevision;
  if (confirmation.impactCount !== input.expectedImpactCount || impactRevisionChanged) {
    throw rejectAction({
      code: 'ticketing.deleteTaskPropertyDefinition.stale_impact',
      message: 'The affected retained Tasks changed. Review the impact and confirm again.',
    });
  }

  if (!(await deleteTaskPropertyDefinition({ target, tx: services.tx }))) {
    throw rejectAction({
      code: 'ticketing.deleteTaskPropertyDefinition.stale_or_missing',
      message: 'The Task Property Definition changed elsewhere or is no longer available.',
    });
  }

  return Object.defineProperty(
    {
      deletedPropertyDefinitionId: input.propertyDefinitionId,
      impactCount: confirmation.impactCount,
    },
    deletedDatatypeEvidence,
    { value: target.datatype },
  ) as DeleteTaskPropertyDefinitionInternalResponse;
};

export const deleteTaskPropertyDefinitionActionRegistration: ActionRegistration<
  DeleteTaskPropertyDefinitionActionPayload,
  DeleteTaskPropertyDefinitionInternalResponse
> = {
  descriptor: {
    actionKey: deleteTaskPropertyDefinitionActionKey,
    auditEvent: deleteTaskPropertyDefinitionAuditEvent,
    auditProfile: 'standard',
    authorization: {
      permission: 'manage_property_definitions',
      provider: 'spicedb',
      resourceObjectId: (input) => input.collectionId,
      resourceObjectType: 'task_collection',
    },
    domainEvent: deleteTaskPropertyDefinitionDomainEvent,
    gatewayAudience: 'ticketing',
    idempotency: 'required',
    moduleStateAccess: 'mutate',
    transportRequestSchema: deleteTaskPropertyDefinitionActionPayloadSchema,
    transportResponseSchema: deleteTaskPropertyDefinitionActionResponseSchema,
  },
  handler: deleteTaskPropertyDefinitionActionHandler,
};
