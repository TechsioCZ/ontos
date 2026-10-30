import { Effect, Schema } from 'effect';

const Text = Schema.String.check(Schema.isMaxLength(300));
const InvocationIdSchema = Text.pipe(Schema.brand('InvocationId'));
const LogSchema = Schema.Struct({
  action: Schema.Literals(['proposed', 'approved']),
  actorPrincipalId: Text,
  at: Schema.DateTimeUtcFromString,
  id: Text,
  invocationId: InvocationIdSchema,
  message: Text,
});
type Log = typeof LogSchema.Type;
const AuditContextSchema = Schema.Struct({
  invocationId: InvocationIdSchema,
  now: Schema.DateTimeUtc,
  principalId: Text,
});
type AuditContext = typeof AuditContextSchema.Type;

// Same parameter shape as createLogEntry: DateTime, brands and omitted audit fields are data.
export const buildAuditEntry = Effect.fn('buildAuditEntry')(function* buildAuditEntryData(
  context: AuditContext,
  index: number,
  entry: Omit<Log, 'actorPrincipalId' | 'at' | 'id' | 'invocationId'>,
) {
  return { ...entry, actorPrincipalId: context.principalId, at: context.now,
    id: `${context.invocationId}:${index}`, invocationId: context.invocationId };
});

interface LegacyEntry {
  id: string;
  message: string;
  read(): string;
}
// Projection checks the retained fields rather than rejecting every base with an omitted method.
export const makeMessage = (prefix: string, index: number, entry: Omit<LegacyEntry, 'read'>) =>
  `${prefix}:${index}:${entry.message}`;
