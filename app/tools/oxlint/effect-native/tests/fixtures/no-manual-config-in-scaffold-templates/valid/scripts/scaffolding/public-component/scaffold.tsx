import type { ReactElement } from 'react';
import * as Schema from 'effect/Schema';

/** A .tsx generator emitting the Effect-native shape only. */
export const renderPublicComponent = (name: string): string => `
import { Config, Effect, Schema } from 'effect';

const ${name}Config = Config.schema(
  Schema.Struct({ ONTOS_PUBLIC_FLAGS: Schema.fromJsonString(Schema.Record(Schema.String, Schema.Boolean)) }),
);

export const ${name} = () => Effect.map(${name}Config, (flags) => <section data-flags={flags} />);
`;

export const Banner = (): ReactElement => <span>{Schema.NonEmptyString.ast._tag}</span>;
