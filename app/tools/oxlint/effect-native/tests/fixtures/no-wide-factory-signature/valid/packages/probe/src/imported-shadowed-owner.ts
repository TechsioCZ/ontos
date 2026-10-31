const Schema = { Struct: (_fields: object) => ({ Type: { read: () => 'dependency' } }), String: {} };
const DeviceSchema = Schema.Struct({ id: Schema.String });
export type ShadowedDto = typeof DeviceSchema.Type;
