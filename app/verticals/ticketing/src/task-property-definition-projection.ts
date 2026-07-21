import type { TaskPropertyDefinition } from '../shared/task-property-definition.ts';

interface TaskPropertyDefinitionFields {
  readonly hidden: boolean;
  readonly mandatory: boolean;
  readonly name: string;
  readonly propertyDefinitionId: string;
  readonly revision: number;
}

export type TaskPropertyDefinitionRow =
  | (TaskPropertyDefinitionFields & {
      readonly datatype:
        | 'checkbox'
        | 'created_by'
        | 'created_time'
        | 'last_edited_time'
        | 'date'
        | 'email'
        | 'files_media'
        | 'phone'
        | 'text'
        | 'url';
    })
  | (TaskPropertyDefinitionFields & { readonly datatype: 'id'; readonly prefix: string })
  | (TaskPropertyDefinitionFields & {
      readonly datatype: 'number';
      readonly format: 'number' | 'number_with_separators' | 'percent' | null;
    })
  | (TaskPropertyDefinitionFields & {
      readonly cardinality: 'one' | 'unlimited';
      readonly datatype: 'person';
    });

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
  if (row.datatype === 'person') {
    return {
      cardinality: row.cardinality,
      datatype: row.datatype,
      hidden: row.hidden,
      mandatory: row.mandatory,
      name: row.name,
      propertyDefinitionId: row.propertyDefinitionId,
      revision: row.revision,
    };
  }
  return {
    datatype: row.datatype,
    hidden: row.hidden,
    mandatory: row.mandatory,
    name: row.name,
    propertyDefinitionId: row.propertyDefinitionId,
    revision: row.revision,
  };
};
