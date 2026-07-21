import { Schema } from '@modern-js/plugin-bff/effect-client';

export const getTaskPropertyEditCapabilityPayloadSchema = Schema.Struct({
  collectionId: Schema.String,
});

export const taskPropertyEditCapabilitySchema = Schema.Struct({
  canEdit: Schema.Literal(true),
});

export type GetTaskPropertyEditCapabilityPayload =
  typeof getTaskPropertyEditCapabilityPayloadSchema.Type;
export type TaskPropertyEditCapability = typeof taskPropertyEditCapabilitySchema.Type;
