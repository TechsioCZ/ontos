import type { TaskPropertyDefinition } from './task-property-definition.ts';

export type TaskPropertyDefinitionValueCopyPolicy = 'always' | 'never' | 'optional';

export const getTaskPropertyDefinitionValueCopyPolicy = (
  datatype: TaskPropertyDefinition['datatype'],
): TaskPropertyDefinitionValueCopyPolicy => {
  if (datatype === 'date_range') {
    return 'always';
  }
  if (
    datatype === 'text' ||
    datatype === 'created_by' ||
    datatype === 'created_time' ||
    datatype === 'last_edited_by' ||
    datatype === 'last_edited_time'
  ) {
    return 'never';
  }
  return 'optional';
};

export const resolveTaskPropertyDefinitionValueCopy = ({
  datatype,
  requestedCopyValues,
}: {
  readonly datatype: TaskPropertyDefinition['datatype'];
  readonly requestedCopyValues: boolean;
}): boolean => {
  const policy = getTaskPropertyDefinitionValueCopyPolicy(datatype);
  return policy === 'always' || (policy === 'optional' && requestedCopyValues);
};
