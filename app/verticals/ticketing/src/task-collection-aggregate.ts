import type { TaskCollectionAggregate } from '../shared/task-collection.ts';

export interface TaskCollectionAggregateRow {
  readonly collectionCreatedAt: string;
  readonly collectionId: string;
  readonly createdAt: string;
  readonly createdByPrincipalId: string;
  readonly datatype: 'title';
  readonly lastEditedAt: string;
  readonly lastEditedByPrincipalId: string;
  readonly mandatory: boolean;
  readonly name: string;
  readonly propertyDefinitionId: string;
  readonly revision: number;
  readonly schemaId: string;
  readonly taskId: string;
  readonly title: string;
}

export const taskCollectionAggregateFromRow = (
  row: TaskCollectionAggregateRow,
): TaskCollectionAggregate => ({
  collection: {
    collectionId: row.collectionId,
    createdAt: row.collectionCreatedAt,
    schemaId: row.schemaId,
  },
  schema: {
    collectionId: row.collectionId,
    propertyDefinitions: [
      {
        datatype: row.datatype,
        mandatory: row.mandatory,
        name: row.name,
        propertyDefinitionId: row.propertyDefinitionId,
      },
    ],
    schemaId: row.schemaId,
  },
  task: {
    collectionId: row.collectionId,
    createdAt: row.createdAt,
    createdByPrincipalId: row.createdByPrincipalId,
    lastEditedAt: row.lastEditedAt,
    lastEditedByPrincipalId: row.lastEditedByPrincipalId,
    revision: row.revision,
    taskId: row.taskId,
    title: row.title,
  },
});
