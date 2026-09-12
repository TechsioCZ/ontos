import { Schema } from 'effect';

export class HistoryAccessDenied extends Schema.TaggedError<HistoryAccessDenied>()('HistoryAccessDenied', {
  code: Schema.Literal('history_access_denied'),
  reason: Schema.Literals([
    'ARCHIVE_PERMISSION_REQUIRED',
    'COUNTERPARTY_ACCESS_REQUIRED',
    'COUNTERPARTY_HISTORY_PERMISSION_REQUIRED',
    'CURRENT_BINDING_REQUIRED',
    'HISTORY_PERMISSION_REQUIRED',
    'OWNER_POLICY_DENIED',
    'PURCHASE_PERMISSION_REQUIRED',
    'RESOURCE_READ_REQUIRED',
    'REPEAT_PERMISSION_REQUIRED',
    'TARGET_CONTEXT_MISMATCH',
  ]),
}) {}
