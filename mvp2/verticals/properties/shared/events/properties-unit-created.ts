export const propertiesUnitCreatedTopic = 'properties.unit.created';

export type PropertiesUnitCreatedPayload = {
  readonly name: string;
  readonly unitId: string;
};

export const isPropertiesUnitCreatedPayload = (
  payload: unknown,
): payload is PropertiesUnitCreatedPayload =>
  typeof payload === 'object' &&
  payload !== null &&
  'name' in payload &&
  typeof payload.name === 'string' &&
  'unitId' in payload &&
  typeof payload.unitId === 'string';

export const propertiesUnitCreatedPayloadSchema = {
  parse: (payload: unknown): PropertiesUnitCreatedPayload => {
    if (isPropertiesUnitCreatedPayload(payload)) {
      return payload;
    }

    throw new TypeError('Invalid properties.unit.created payload.');
  },
};
