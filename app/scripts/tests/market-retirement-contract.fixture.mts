import { readFileSync } from 'node:fs';

import { SyntaxKind } from '@typescript/native/unstable/ast';
import { Schema } from 'effect';

import { ActionProvisioningIntentSchema } from '../../packages/core-runtime/src/authorization/entrypoint-classification.ts';
import { OntosActionContractSchema } from '../../packages/core-runtime/src/modules/manifest.ts';
import { tokenizeGovernedClient } from '../generated-module-api-boundary.mts';
import type { GovernedClientToken } from '../generated-module-api-boundary.mts';

const DescriptorSchema = Schema.Struct({
  actionKey: OntosActionContractSchema.fields.actionKey,
  legalEntityScope: Schema.Literals(['forbidden', 'optional', 'required']),
  owningModuleKey: OntosActionContractSchema.fields.owningModuleId,
  provisioning: ActionProvisioningIntentSchema,
});

const stringBinding = (tokens: readonly GovernedClientToken[], name: string) =>
  tokens.find(
    (token, index) =>
      token.kind === SyntaxKind.StringLiteral &&
      tokens[index - 1]?.kind === SyntaxKind.EqualsToken &&
      tokens[index - 2]?.value === name &&
      tokens[index - 3]?.kind === SyntaxKind.ConstKeyword,
  )?.value;

const propertyString = (tokens: readonly GovernedClientToken[], name: string) => {
  const index = tokens.findIndex(
    (token, position) => token.value === name && tokens[position + 1]?.kind === SyntaxKind.ColonToken,
  );
  if (index === -1) {
    return null;
  }
  const value = tokens[index + 2];
  if (value?.kind === SyntaxKind.StringLiteral) {
    return value.value;
  }
  if (value?.kind === SyntaxKind.Identifier) {
    return stringBinding(tokens, value.value) ?? null;
  }
  return null;
};

/** Project real source-catalog metadata without importing or executing private owner business code. */
export const customerContextSourceAction = (slug: string) => {
  const source = readFileSync(
    new URL(`../../verticals/commerce-customer-context/src/actions/${slug}.action.ts`, import.meta.url),
    'utf-8',
  );
  const tokens = tokenizeGovernedClient(source);
  return Schema.decodeUnknownSync(DescriptorSchema)({
    actionKey: propertyString(tokens, 'actionKey'),
    legalEntityScope: propertyString(tokens, 'legalEntityScope'),
    owningModuleKey: propertyString(tokens, 'owningModuleKey'),
    provisioning: propertyString(tokens, 'provisioning'),
  });
};

export const marketRetirementSourceAction = customerContextSourceAction('reserve-market-retirement');
