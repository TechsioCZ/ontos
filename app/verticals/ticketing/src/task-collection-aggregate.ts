import type {
  TaskCollectionAggregate,
  TaskCollectionCreation,
  TaskCreation,
} from '../shared/task-collection.ts';

export interface TaskCollectionCreationRow {
  readonly collectionCreatedAt: string;
  readonly collectionId: string;
  readonly datatype: 'title';
  readonly mandatory: boolean;
  readonly name: string;
  readonly propertyDefinitionId: string;
  readonly schemaId: string;
}

export interface TaskCreationRow {
  readonly collectionId: string;
  readonly createdAt: string;
  readonly createdByPrincipalId: string;
  readonly lastEditedAt: string;
  readonly lastEditedByPrincipalId: string;
  readonly revision: number;
  readonly taskId: string;
  readonly title: string;
}

export interface TaskCollectionAggregateRow extends TaskCollectionCreationRow, TaskCreationRow {}

export const taskCollectionCreationFromRow = (
  row: TaskCollectionCreationRow,
): TaskCollectionCreation => ({
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
});

export const taskCreationFromRow = (row: TaskCreationRow): TaskCreation => ({
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

export const taskCollectionAggregateFromRow = (
  row: TaskCollectionAggregateRow,
): TaskCollectionAggregate => ({
  ...taskCollectionCreationFromRow(row),
  ...taskCreationFromRow(row),
});
