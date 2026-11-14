// The owner-side copies of the CRM Authorization v2 declarations (ADR-0030). The registered
// descriptors carry the same values as closed inline literals, because the catalog accepts only
// literal custody; the owner asks the one access gate about exactly these keys, and
// crm-access-reach.test.ts pins both sides equal.
import type { AccessDeclarationInput, AccessFieldGroupInput } from '@app/core-runtime';

import {
  crmApplyCommandCapability,
  crmClientOwnerAssignCapability,
  crmRecordSelectors,
  crmRecordsReadCapability,
} from './access.ts';

/** The record-scoped records read: `all`, `assigned` and `entrusted` are the reviewed CRM reaches. */
export const crmRecordsReadDeclaration = {
  key: crmRecordsReadCapability,
  kind: 'read',
  modes: ['run'],
  placement: { group: 'crm', level: 'basic' },
  risk: 'sensitive',
  selectors: [...crmRecordSelectors],
} as const satisfies AccessDeclarationInput;

/** The one CRM write Action. Scope-wide: a holder-relative Action selector is unsupported (R5a-7). */
export const crmApplyCommandDeclaration = {
  key: crmApplyCommandCapability,
  kind: 'action',
  modes: ['run', 'propose', 'approve'],
  placement: { group: 'crm', level: 'manage' },
  risk: 'sensitive',
  selectors: [],
} as const satisfies AccessDeclarationInput;

/**
 * Reassignment stays its own authority: a payload that names a new client owner asks for this
 * `field_write` group on top of the write capability, so a salesperson who may change their own
 * clients still cannot hand one to somebody else.
 */
export const crmClientOwnerAssignGroup = {
  fieldClass: 'authority_metadata',
  fields: ['command.toSalespersonId'],
  key: crmClientOwnerAssignCapability,
  kind: 'field_write',
  modes: ['run', 'propose', 'approve'],
  placement: { group: 'crm', level: 'manage' },
  risk: 'sensitive',
  selectors: [],
} as const satisfies AccessFieldGroupInput;
