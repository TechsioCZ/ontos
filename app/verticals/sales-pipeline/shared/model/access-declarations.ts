import type { AccessDeclarationInput, AccessFieldGroupInput } from '@app/core-runtime';

const group = 'sales-pipeline';

export const salesPipelineRecordsReadDeclaration = {
  key: 'demo.sales-pipeline.api-records.read',
  kind: 'read',
  modes: ['run'],
  placement: { group, level: 'basic' },
  risk: 'sensitive',
  selectors: ['all', 'entrusted'],
} as const satisfies AccessDeclarationInput;
export const salesPipelineApplyCommandDeclaration = {
  key: 'demo.sales-pipeline.apply-command.write',
  kind: 'action',
  modes: ['run', 'propose', 'approve'],
  placement: { group, level: 'manage' },
  risk: 'sensitive',
  selectors: [],
} as const satisfies AccessDeclarationInput;
export const salesPipelineEntrustGroup = {
  fieldClass: 'authority_metadata',
  fields: ['command.entrustedPrincipalRef', 'command.patch.entrustedPrincipalRef'],
  key: 'demo.sales-pipeline.opportunity-entrust.assign',
  kind: 'field_write',
  modes: ['run', 'propose', 'approve'],
  placement: { group, level: 'manage' },
  risk: 'sensitive',
  selectors: [],
} as const satisfies AccessFieldGroupInput;
