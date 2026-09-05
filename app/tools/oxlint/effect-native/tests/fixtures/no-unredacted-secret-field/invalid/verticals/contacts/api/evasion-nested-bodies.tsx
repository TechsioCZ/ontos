// expect-count: 3
// Deeply nested: generic arrow -> returned arrow -> object literal holding a class, a Schema
// field bag and JSX. Nothing here may fall out of the visitor walk.
import { Schema } from 'effect';

export const make = <T,>(input: T) =>
  () => ({
    build: (password: string) => ({
      holder: class Holder {
        readonly apiKey: string = '';
      },
      node: <div data-input={String(input)} />,
      schema: Schema.Struct({ secret: Schema.String }),
    }),
  });
