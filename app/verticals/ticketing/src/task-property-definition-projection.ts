import type { TaskPropertyDefinition } from '../shared/task-property-definition.ts';

export interface TaskPropertyDefinitionRow {
  readonly datatype:
    | 'checkbox'
    | 'created_by'
    | 'created_time'
    | 'email'
    | 'id'
    | 'number'
    | 'phone'
    | 'select'
    | 'text'
    | 'url';
  readonly format: 'number' | 'number_with_separators' | 'percent' | null;
  readonly hidden: boolean;
  readonly mandatory: boolean;
  readonly name: string;
  readonly prefix: string;
  readonly propertyDefinitionId: string;
  readonly revision: number;
}

export const taskPropertyDefinitionFromRow = (
  row: TaskPropertyDefinitionRow,
): TaskPropertyDefinition => {
  if (row.datatype === 'id') {
    return {
      datatype: row.datatype,
      hidden: row.hidden,
      mandatory: row.mandatory,
      name: row.name,
      prefix: row.prefix,
      propertyDefinitionId: row.propertyDefinitionId,
      revision: row.revision,
    };
  }
  if (row.datatype === 'number') {
    return {
      datatype: row.datatype,
      format: row.format ?? 'number',
      hidden: row.hidden,
      mandatory: row.mandatory,
      name: row.name,
      propertyDefinitionId: row.propertyDefinitionId,
      revision: row.revision,
    };
  }
  const definition = {
    datatype: row.datatype,
    hidden: row.hidden,
    mandatory: row.mandatory,
    name: row.name,
    propertyDefinitionId: row.propertyDefinitionId,
    revision: row.revision,
  };
  return definition as TaskPropertyDefinition;
};
