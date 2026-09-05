// Non-call references to the factory, and one single declaration, must stay silent.
import { Schema } from 'effect';

export const Status = Schema.Literals(['ok', 'fail']);
export type StatusValue = typeof Status.Type;
type Factory = typeof Schema.Literals;

export const factoryRef: Factory = Schema.Literals;
export const factories = [Schema.Literals, Schema.Struct] as const;
export const Row = Schema.Struct({ status: Status });
