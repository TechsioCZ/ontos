import type { Schema } from '@modern-js/plugin-bff/effect-client';

export declare const getTaskPropertyEditCapabilityPayloadSchema: Schema.Struct<{
  readonly collectionId: Schema.String;
}>;
export declare const taskPropertyEditCapabilitySchema: Schema.Struct<{
  readonly canEdit: Schema.Literal<true>;
}>;
export declare const taskPropertyDefinitionEditCapabilitySchema: Schema.Struct<{
  readonly canEditDefinitions: Schema.Literal<true>;
}>;
export type GetTaskPropertyEditCapabilityPayload =
  typeof getTaskPropertyEditCapabilityPayloadSchema.Type;
export type TaskPropertyEditCapability = typeof taskPropertyEditCapabilitySchema.Type;
export type TaskPropertyDefinitionEditCapability =
  typeof taskPropertyDefinitionEditCapabilitySchema.Type;
