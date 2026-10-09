import { defineScopedRoutine } from '@app/core-runtime';
import { Schema } from 'effect';

const MutationRowSchema = Schema.Struct({ payload: Schema.Unknown });

const ownerModuleKey = 'commerce.market-catalog';
const schema = 'commerce_market_catalog';
const parameters = [
  { source: 'tenantId', type: 'uuid' },
  { source: 'legalEntityId', type: 'uuid' },
  { source: 'input', type: 'jsonb' },
] as const;

const mutationRoutine = (name: string, routineKey: string) =>
  defineScopedRoutine({
    name,
    ownerModuleKey,
    parameters,
    resultSchema: MutationRowSchema,
    routineKey,
    schema,
  });

export const createMarketRoutine = mutationRoutine('create_market', 'market-administration.create');
export const reviseMarketDefinitionRoutine = mutationRoutine(
  'revise_market_definition',
  'market-administration.revise-definition',
);
export const transitionMarketLifecycleRoutine = mutationRoutine(
  'transition_market_lifecycle',
  'market-administration.transition-lifecycle',
);
export const associateStorefrontRoutine = mutationRoutine(
  'associate_storefront',
  'market-administration.associate-storefront',
);
export const reviseStorefrontAssociationRoutine = mutationRoutine(
  'revise_storefront_association',
  'market-administration.revise-storefront-association',
);
export const removeStorefrontAssociationRoutine = mutationRoutine(
  'remove_storefront_association',
  'market-administration.remove-storefront-association',
);
