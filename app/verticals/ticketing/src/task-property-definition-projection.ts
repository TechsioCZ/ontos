import type { TaskPropertyDefinition } from '../shared/task-property-definition.ts';

export interface TaskPropertyDefinitionRow {
  readonly datatype: 'checkbox' | 'id';
  readonly hidden: boolean;
  readonly mandatory: boolean;
  readonly name: string;
  readonly prefix: string;
  readonly propertyDefinitionId: string;
  readonly revision: number;
}

export const taskPropertyDefinitionFromRow = (
  row: TaskPropertyDefinitionRow,
): TaskPropertyDefinition =>
  row.datatype === 'id'
    ? row
    : {
        datatype: row.datatype,
        hidden: row.hidden,
        mandatory: row.mandatory,
        name: row.name,
        propertyDefinitionId: row.propertyDefinitionId,
        revision: row.revision,
      };
