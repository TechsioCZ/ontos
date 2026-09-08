/**
 * A8/A9 target shape for route parameters (Schema.Struct over branded identifiers, exposed through
 * Schema.standardSchemaV1). The unrelated analytics label map below is not a route argument type, so
 * the `routeParams` group must not reach across the template and claim it.
 */
export const renderPage = (component: string): string => `import { Schema } from 'effect';
import { CustomerId } from '../../shared/identifiers.ts';

export const ${component}RouteParams = Schema.Struct({ customerId: CustomerId });
export const ${component}RouteParamsStandard = Schema.standardSchemaV1(${component}RouteParams);

type ${component}AnalyticsLabels = Readonly<Partial<Record<AnalyticsKey, string>>>;

export const ${component}Labels: ${component}AnalyticsLabels = {};
`;
