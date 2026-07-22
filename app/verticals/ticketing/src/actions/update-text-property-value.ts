// @effect-diagnostics asyncFunction:off
import { coreReferenceRegistry, rejectAction, rowsFromResult } from '@app/core-runtime';
import type {
  ActionAuditEventDescriptor,
  ActionDomainEventDescriptor,
  ActionHandler,
  ActionRegistration,
} from '@app/core-runtime';
import { sql } from '@app/core-runtime/db/sql';
import {
  updateTextPropertyValueActionKey,
  updateTextPropertyValueActionPayloadSchema,
  updateTextPropertyValueActionResponseSchema,
} from '../../shared/actions/update-text-property-value.ts';
import type {
  UpdateTextPropertyValueActionPayload,
  UpdateTextPropertyValueActionResponse,
} from '../../shared/actions/update-text-property-value.ts';
import type { CoreReference, TextDocument } from '../../shared/text-property.ts';
import {
  normalizeTextDocument,
  validateTextDocumentReferences,
} from '../text-property-document.ts';
import { rejectTaskEditWithEmptyMandatoryProperty } from '../task-mandatory-validation.ts';

interface CurrentTextValueRow {
  readonly document: TextDocument | null;
  readonly mandatory: boolean;
  readonly propertyDefinitionId: string;
  readonly readableText: string | null;
  readonly revision: number;
  readonly taskRevision: number;
}

type UpdatedTextValueRow = Omit<CurrentTextValueRow, 'mandatory'>;

const coreReferenceIdentityKey = (reference: CoreReference): string =>
  JSON.stringify([
    reference.ownerModuleKey,
    reference.targetTenantId,
    reference.entityType,
    reference.entityId,
    reference.token,
    reference.kind,
  ]);

const textPropertyValueEvidence = (
  input: UpdateTextPropertyValueActionPayload,
  response: UpdateTextPropertyValueActionResponse,
) => ({
  changedComponents: ['textValue'],
  collectionId: input.collectionId,
  datatype: 'text',
  operation: 'changed',
  propertyDefinitionId: input.propertyDefinitionId,
  revision: response.value.revision,
  taskId: input.taskId,
  taskRevision: response.taskRevision,
});

const updateTextPropertyValueAuditEvent = {
  evidence: textPropertyValueEvidence,
  targetModuleKey: 'ticketing',
  targetResourceId: (input) => input.taskId,
  targetResourceType: 'task',
} satisfies ActionAuditEventDescriptor<
  UpdateTextPropertyValueActionPayload,
  UpdateTextPropertyValueActionResponse
>;

const updateTextPropertyValueDomainEvent = {
  eventType: 'ticketing.taskPropertyValue.changed',
  payload: textPropertyValueEvidence,
  producerModuleKey: 'ticketing',
  subjectModuleKey: 'ticketing',
  subjectResourceId: (input) => input.taskId,
  subjectResourceType: 'task',
} satisfies ActionDomainEventDescriptor<
  UpdateTextPropertyValueActionPayload,
  UpdateTextPropertyValueActionResponse
>;

const updateTextPropertyValueActionHandler: ActionHandler<
  UpdateTextPropertyValueActionPayload,
  UpdateTextPropertyValueActionResponse
> = async (input, services) => {
  if (!validateTextDocumentReferences(input.document)) {
    throw rejectAction({
      code: 'ticketing.updateTextPropertyValue.invalid_reference',
      message: 'Text references require a valid opaque Core Reference envelope.',
    });
  }
  const currentResult = await services.tx.execute(sql`
    select
      value.document,
      definition.mandatory,
      value.property_definition_id as "propertyDefinitionId",
      value.readable_text as "readableText",
      value.revision,
      task.revision as "taskRevision"
    from ticketing.task_text_values as value
    inner join ticketing.tasks as task
      on task.task_id = value.task_id
      and task.tenant_id = value.tenant_id
    inner join ticketing.task_property_definitions as definition
      on definition.property_definition_id = value.property_definition_id
      and definition.tenant_id = value.tenant_id
      and definition.datatype = 'text'
    where value.task_id = ${input.taskId}
      and value.property_definition_id = ${input.propertyDefinitionId}
      and value.revision = ${input.expectedRevision}
      and value.tenant_id = ${services.context.tenantId}
      and task.collection_id = ${input.collectionId}
    for update of value, task
  `);
  const current = rowsFromResult<CurrentTextValueRow>(currentResult).at(0);

  if (current === undefined) {
    throw rejectAction({
      code: 'ticketing.updateTextPropertyValue.stale_or_missing',
      message: 'The Text value changed elsewhere or is no longer available.',
    });
  }

  const currentReferences = new Map(
    (current.document?.content ?? [])
      .filter((node) => node.type === 'reference')
      .map((node) => [coreReferenceIdentityKey(node.reference), node.reference]),
  );
  const validatedDocument =
    input.document === null
      ? null
      : {
          ...input.document,
          content: await Promise.all(
            input.document.content.map(async (node) => {
              if (node.type !== 'reference') {
                return node;
              }
              const inserted = await coreReferenceRegistry.insert({
                context: {
                  principalId: services.context.principalId,
                  tenantId: services.context.tenantId,
                },
                kind: node.reference.kind,
                source: { type: 'opaqueToken', value: node.reference.token },
              });
              if (
                inserted._tag === 'CoreReferenceInserted' &&
                inserted.reference.entityId === node.reference.entityId &&
                inserted.reference.entityType === node.reference.entityType &&
                inserted.reference.ownerModuleKey === node.reference.ownerModuleKey &&
                inserted.reference.targetTenantId === node.reference.targetTenantId
              ) {
                return { ...node, reference: inserted.reference };
              }
              const retained = currentReferences.get(coreReferenceIdentityKey(node.reference));
              if (
                retained !== undefined &&
                retained.entityId === node.reference.entityId &&
                retained.entityType === node.reference.entityType &&
                retained.kind === node.reference.kind &&
                retained.ownerModuleKey === node.reference.ownerModuleKey &&
                retained.targetTenantId === node.reference.targetTenantId
              ) {
                return { ...node, reference: retained };
              }
              throw rejectAction({
                code: 'ticketing.updateTextPropertyValue.invalid_reference',
                message: 'Text references require a Core-recognized opaque token.',
              });
            }),
          ),
        };
  const normalized = normalizeTextDocument(validatedDocument);

  if (current.mandatory && normalized.document === null) {
    throw rejectAction({
      code: 'ticketing.updateTextPropertyValue.mandatory_empty',
      message: 'Mandatory Text must contain meaningful content.',
    });
  }

  await rejectTaskEditWithEmptyMandatoryProperty({
    collectionId: input.collectionId,
    db: services.tx,
    taskId: input.taskId,
    tenantId: services.context.tenantId,
  });

  if (JSON.stringify(current.document) === JSON.stringify(normalized.document)) {
    services.markNoOp();
    return {
      taskRevision: current.taskRevision,
      value: {
        document: current.document,
        propertyDefinitionId: current.propertyDefinitionId,
        readableText: current.readableText,
        revision: current.revision,
      },
    };
  }

  const serializedDocument =
    normalized.document === null ? null : JSON.stringify(normalized.document);
  const changedAt = services.clock.now().toISOString();
  const result = await services.tx.execute(sql`
    with updated_value as (
      update ticketing.task_text_values as value
      set
        document = ${serializedDocument}::jsonb,
        readable_text = ${normalized.readableText},
        revision = value.revision + 1
      where value.task_id = ${input.taskId}
        and value.property_definition_id = ${input.propertyDefinitionId}
        and value.revision = ${input.expectedRevision}
        and value.tenant_id = ${services.context.tenantId}
      returning
        value.document,
        value.property_definition_id,
        value.readable_text,
        value.revision,
        value.task_id
    ),
    updated_task as (
      update ticketing.tasks as task
      set
        last_edited_at = ${changedAt}::timestamptz,
        last_edited_by_principal_id = ${services.effectiveEditorPrincipalId},
        revision = task.revision + 1
      from updated_value
      where task.task_id = updated_value.task_id
        and task.tenant_id = ${services.context.tenantId}
      returning task.last_edited_at, task.revision, task.task_id
    ),
    created_revision as (
      insert into ticketing.task_revisions (
        changed_at,
        changed_by_principal_id,
        reason,
        revision,
        task_id,
        tenant_id
      )
      select
        updated_task.last_edited_at,
        ${services.effectiveEditorPrincipalId},
        'text_value_changed',
        updated_task.revision,
        updated_task.task_id,
        ${services.context.tenantId}
      from updated_task
      returning task_id
    )
    select
      updated_value.document,
      updated_value.property_definition_id as "propertyDefinitionId",
      updated_value.readable_text as "readableText",
      updated_value.revision,
      updated_task.revision as "taskRevision"
    from updated_value
    inner join updated_task using (task_id)
    inner join created_revision using (task_id)
  `);
  const updated = rowsFromResult<UpdatedTextValueRow>(result).at(0);

  if (updated === undefined) {
    throw rejectAction({
      code: 'ticketing.updateTextPropertyValue.stale_or_missing',
      message: 'The Text value changed elsewhere or is no longer available.',
    });
  }

  return {
    taskRevision: updated.taskRevision,
    value: {
      document: updated.document,
      propertyDefinitionId: updated.propertyDefinitionId,
      readableText: updated.readableText,
      revision: updated.revision,
    },
  };
};

export const updateTextPropertyValueActionRegistration: ActionRegistration<
  UpdateTextPropertyValueActionPayload,
  UpdateTextPropertyValueActionResponse
> = {
  descriptor: {
    actionKey: updateTextPropertyValueActionKey,
    auditEvent: updateTextPropertyValueAuditEvent,
    auditProfile: 'sensitive',
    authorization: {
      permission: 'edit_task_property_values',
      provider: 'spicedb',
      resourceObjectId: (input) => input.collectionId,
      resourceObjectType: 'task_collection',
    },
    domainEvent: updateTextPropertyValueDomainEvent,
    gatewayAudience: 'ticketing',
    idempotency: 'required',
    moduleStateAccess: 'mutate',
    transportRequestSchema: updateTextPropertyValueActionPayloadSchema,
    transportResponseSchema: updateTextPropertyValueActionResponseSchema,
  },
  handler: updateTextPropertyValueActionHandler,
};
