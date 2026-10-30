import { documentNavigationModules } from '@app/shared-contracts';
import { Effect } from 'effect';

const SALES_PIPELINE_MODULE = 'demo.sales-pipeline';
const MERCHANDISE_MODULE = 'demo.merchandise';

/**
 * Which optional reference reads to send, from the module ids the shell pinned on the document. Without that hint
 * nothing is known: keep the provider's own authorization and error handling.
 */
export const referenceAccessFromModules = (modules?: ReadonlySet<string>) => ({
  opportunitiesReadable: modules === undefined || modules.has(SALES_PIPELINE_MODULE),
  productsReadable: modules === undefined || modules.has(MERCHANDISE_MODULE),
});

/** Read from the shell's per-document hint: no request, and switches of company or account reload the document. */
export const financeReferenceAccess = Effect.sync(() => referenceAccessFromModules(documentNavigationModules()));

const PROPERTY_MODULE = 'property.portfolio';
const AGREEMENTS_MODULE = 'legal.agreements';

/** Nájempark object modules (property/unit, contracts) the company can read; other companies get no object picker. */
export const objectAccessFromModules = (modules?: ReadonlySet<string>) => ({
  contractsReadable: modules === undefined || modules.has(AGREEMENTS_MODULE),
  propertiesReadable: modules === undefined || modules.has(PROPERTY_MODULE),
});

export const financeObjectAccess = Effect.sync(() => objectAccessFromModules(documentNavigationModules()));
