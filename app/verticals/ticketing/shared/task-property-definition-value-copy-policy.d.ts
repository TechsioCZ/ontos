import type { TaskPropertyDefinition } from './task-property-definition.ts';
export type TaskPropertyDefinitionValueCopyPolicy = 'always' | 'never' | 'optional';
export declare const getTaskPropertyDefinitionValueCopyPolicy: (datatype: TaskPropertyDefinition['datatype']) => TaskPropertyDefinitionValueCopyPolicy;
export declare const resolveTaskPropertyDefinitionValueCopy: ({ datatype, requestedCopyValues, }: {
    readonly datatype: TaskPropertyDefinition['datatype'];
    readonly requestedCopyValues: boolean;
}) => boolean;
