// @effect-diagnostics asyncFunction:off
import { createPersonDirectory, rowsFromResult } from '@app/core-runtime';
import type { DataAccessRegistration, ResolvedPersonDirectoryEntry } from '@app/core-runtime';
import { sql } from '@app/core-runtime/db/sql';
import {
  queryTaskPersonValuesPayloadSchema,
  queryTaskPersonValuesResponseSchema,
} from '../../shared/person-query.ts';
import type {
  QueryTaskPersonValuesPayload,
  QueryTaskPersonValuesResponse,
} from '../../shared/person-query.ts';

interface CollectionRow {
  readonly locale: string;
}

interface TaskRow {
  readonly taskId: string;
}

interface AssignmentRow {
  readonly principalId: string;
  readonly taskId: string;
}

interface TaskPeople {
  readonly people: readonly ResolvedPersonDirectoryEntry[];
  readonly principalIds: ReadonlySet<string>;
  readonly taskId: string;
}

const normalized = (value: string, locale: string) =>
  value.normalize('NFC').toLocaleLowerCase(locale);

const compareSequences = (
  left: TaskPeople,
  right: TaskPeople,
  collator: Intl.Collator,
  direction: 1 | -1,
) => {
  if (left.people.length === 0 || right.people.length === 0) {
    if (left.people.length === right.people.length) {
      return left.taskId.localeCompare(right.taskId);
    }
    return left.people.length === 0 ? 1 : -1;
  }
  const length = Math.min(left.people.length, right.people.length);
  for (let index = 0; index < length; index += 1) {
    const comparison = collator.compare(
      left.people[index]?.displayName ?? '',
      right.people[index]?.displayName ?? '',
    );
    if (comparison !== 0) {
      return comparison * direction;
    }
  }
  if (left.people.length !== right.people.length) {
    return (left.people.length - right.people.length) * direction;
  }
  for (let index = 0; index < left.people.length; index += 1) {
    const identityComparison = (left.people[index]?.principalId ?? '').localeCompare(
      right.people[index]?.principalId ?? '',
    );
    if (identityComparison !== 0) {
      return identityComparison;
    }
  }
  return left.taskId.localeCompare(right.taskId);
};

export const queryTaskPersonValuesDataAccessRegistration: DataAccessRegistration<
  QueryTaskPersonValuesPayload,
  QueryTaskPersonValuesResponse
> = {
  descriptor: {
    accessKind: 'list',
    auditProfile: 'standard',
    authorization: {
      permission: 'view_task_properties',
      provider: 'spicedb',
      resourceObjectId: (input) => input.collectionId,
      resourceObjectType: 'task_collection',
    },
    dataAccessKey: 'ticketing.taskPersonValues.query',
    evidenceCaptureMode: 'metadata_only',
    evidencePolicyKey: 'ticketing.taskPersonValues.query.metadataOnly',
    gatewayAudience: 'ticketing',
    moduleStateAccess: 'read',
    servingModuleKey: 'ticketing',
    targetModuleKey: 'ticketing',
    targetResourceType: 'task_property_definition',
    transportRequestSchema: queryTaskPersonValuesPayloadSchema,
    transportResponseSchema: queryTaskPersonValuesResponseSchema,
  },
  handler: async (input, { context, db }) => {
    const collectionResult = await db.execute(sql`
      select collection.locale
      from ticketing.task_collections as collection
      inner join ticketing.task_schemas as schema
        on schema.collection_id = collection.collection_id
        and schema.tenant_id = collection.tenant_id
      inner join ticketing.task_property_definitions as definition
        on definition.schema_id = schema.schema_id
        and definition.tenant_id = schema.tenant_id
      where collection.collection_id = ${input.collectionId}
        and collection.tenant_id = ${context.tenantId}
        and definition.property_definition_id = ${input.propertyDefinitionId}
        and definition.datatype = 'person'
    `);
    const locale = rowsFromResult<CollectionRow>(collectionResult).at(0)?.locale ?? 'en-GB';
    const taskResult = await db.execute(sql`
      select task.task_id as "taskId"
      from ticketing.tasks as task
      where task.collection_id = ${input.collectionId}
        and task.tenant_id = ${context.tenantId}
      order by task.created_at, task.task_id
    `);
    const assignmentResult = await db.execute(sql`
      select
        assignment.principal_id as "principalId",
        assignment.task_id as "taskId"
      from ticketing.task_person_assignments as assignment
      inner join ticketing.tasks as task
        on task.task_id = assignment.task_id
        and task.tenant_id = assignment.tenant_id
      where assignment.property_definition_id = ${input.propertyDefinitionId}
        and assignment.tenant_id = ${context.tenantId}
        and task.collection_id = ${input.collectionId}
      order by assignment.task_id, assignment.principal_id
    `);
    const tasks = rowsFromResult<TaskRow>(taskResult);
    const assignments = rowsFromResult<AssignmentRow>(assignmentResult);
    const resolved = await createPersonDirectory({
      db,
      tenantId: context.tenantId,
    }).resolveStoredPrincipalIds([...new Set(assignments.map(({ principalId }) => principalId))]);
    const personById = new Map(resolved.map((person) => [person.principalId, person]));
    const collator = new Intl.Collator(locale, { sensitivity: 'accent', usage: 'sort' });
    const taskPeople = tasks.map(({ taskId }) => {
      const principalIds = assignments
        .filter((assignment) => assignment.taskId === taskId)
        .map(({ principalId }) => principalId);
      return {
        people: principalIds
          .map((principalId) => personById.get(principalId))
          .filter((person) => person !== undefined)
          .toSorted(
            (left, right) =>
              collator.compare(left.displayName, right.displayName) ||
              left.principalId.localeCompare(right.principalId),
          ),
        principalIds: new Set(principalIds),
        taskId,
      } satisfies TaskPeople;
    });
    const search = input.search === undefined ? undefined : normalized(input.search, locale);
    const filtered = taskPeople.filter((task) => {
      if (
        search !== undefined &&
        !task.people.some((person) => normalized(person.displayName, locale).includes(search))
      ) {
        return false;
      }
      switch (input.filter?.operator) {
        case 'contains': {
          return task.principalIds.has(input.filter.principalId);
        }
        case 'doesNotContain': {
          return !task.principalIds.has(input.filter.principalId);
        }
        case 'isEmpty': {
          return task.people.length === 0;
        }
        case 'isNotEmpty': {
          return task.people.length > 0;
        }
        case undefined: {
          return true;
        }
        default: {
          return input.filter satisfies never;
        }
      }
    });
    const ordered =
      input.sort === undefined
        ? filtered
        : filtered.toSorted((left, right) =>
            compareSequences(left, right, collator, input.sort === 'ascending' ? 1 : -1),
          );

    const groups: QueryTaskPersonValuesResponse['groups'][number][] = [];
    if (input.group === true) {
      for (const person of resolved.toSorted(
        (left, right) =>
          collator.compare(left.displayName, right.displayName) ||
          left.principalId.localeCompare(right.principalId),
      )) {
        const taskIds = filtered
          .filter((task) => task.principalIds.has(person.principalId))
          .map(({ taskId }) => taskId);
        if (taskIds.length > 0) {
          groups.push({ person, taskIds });
        }
      }
      const emptyTaskIds = filtered
        .filter((task) => task.people.length === 0)
        .map(({ taskId }) => taskId);
      if (emptyTaskIds.length > 0) {
        groups.push({ person: null, taskIds: emptyTaskIds });
      }
    }

    return { groups, taskIds: ordered.map(({ taskId }) => taskId) };
  },
};
