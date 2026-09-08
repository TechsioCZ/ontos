/** A8/A9 target shape: Schema route parameters, shared browser runtime, generated Effect data hooks. */
export const renderPage = (component: string): string => `import { Effect, Schema } from 'effect';
import { CustomerId } from '../../shared/identifiers.ts';
import { useEffectQuery } from '../../runtime/query-adapter.ts';
import { ${component}Client } from '../../runtime/clients.ts';

export const ${component}RouteParams = Schema.Struct({ customerId: CustomerId });
export const ${component}RouteParamsStandard = Schema.standardSchemaV1(${component}RouteParams);

export const ${component} = ({ routeParams }: { readonly routeParams: typeof ${component}RouteParams.Type }) => {
  const rows = useEffectQuery(
    Effect.gen(function* () {
      const client = yield* ${component}Client;
      return yield* client.reads.list({ payload: routeParams });
    }),
  );

  return rows;
};
`;
