/**
 * Browser client of the shell's people administration endpoints (`/shell-super-app-api/auth/identity/demo-accounts`).
 * The page runs inside the shell origin, so the session cookie authenticates the call; the shell resolves the
 * selected company and the Core Action authorizes and audits every change.
 */
import { Effect, Schema } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/unstable/http';

const API_PREFIX = '/shell-super-app-api/auth/identity/demo-accounts';

export const PeopleRoleSchema = Schema.Struct({
  administrator: Schema.Boolean,
  description: Schema.String,
  key: Schema.String,
  label: Schema.String,
});
export type PeopleRole = typeof PeopleRoleSchema.Type;

export const PersonStatusSchema = Schema.Literals(['active', 'disabled', 'archived']);
export type PersonStatus = typeof PersonStatusSchema.Type;

export const PersonSchema = Schema.Struct({
  displayName: Schema.String,
  editable: Schema.Boolean,
  email: Schema.NullOr(Schema.String),
  otherCompanies: Schema.Array(Schema.String),
  principalId: Schema.String,
  roleKey: Schema.NullOr(Schema.String),
  roleLabel: Schema.NullOr(Schema.String),
  self: Schema.Boolean,
  status: PersonStatusSchema,
});
export type Person = typeof PersonSchema.Type;

export const AuditEntrySchema = Schema.Struct({
  actorName: Schema.NullOr(Schema.String),
  auditEventId: Schema.String,
  details: Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
  eventType: Schema.String,
  occurredAt: Schema.String,
  outcome: Schema.String,
  outcomeCode: Schema.String,
  targetName: Schema.NullOr(Schema.String),
});
export type AuditEntry = typeof AuditEntrySchema.Type;

export const PeopleOverviewSchema = Schema.Struct({
  accounts: Schema.Array(PersonSchema),
  audit: Schema.Array(AuditEntrySchema),
  canManage: Schema.Boolean,
  company: Schema.Struct({ legalEntityId: Schema.String, legalName: Schema.String }),
  roles: Schema.Array(PeopleRoleSchema),
});
export type PeopleOverview = typeof PeopleOverviewSchema.Type;

const ManageResultSchema = Schema.Struct({
  grantsCopied: Schema.Finite,
  grantsRevoked: Schema.Finite,
  operation: Schema.String,
  principalId: Schema.String,
  status: Schema.Literals(['active', 'disabled']),
});
export type ManageResult = typeof ManageResultSchema.Type;

export type PeopleCommand =
  | { readonly displayName: string; readonly email: string; readonly operation: 'create'; readonly roleKey: string }
  | { readonly operation: 'change-role'; readonly principalId: string; readonly roleKey: string }
  | {
      readonly expectedStatus: 'active' | 'disabled';
      readonly newStatus: 'active' | 'disabled';
      readonly operation: 'change-status';
      readonly principalId: string;
      readonly reason?: string;
    };

/** Every failure the page distinguishes; the shell answers with typed problem details per HTTP status. */
export type PeopleFailure = 'conflict' | 'error' | 'forbidden' | 'invalid' | 'signedOut';

export type PeopleOutcome<Value> =
  | { readonly reason: PeopleFailure; readonly status: 'failed' }
  | { readonly status: 'ok'; readonly value: Value };

const failureOf = (status: number): PeopleFailure => {
  if (status === 401) {
    return 'signedOut';
  }
  if (status === 403) {
    return 'forbidden';
  }
  if (status === 409) {
    return 'conflict';
  }
  if (status === 400 || status === 422) {
    return 'invalid';
  }
  return 'error';
};

/** POSTs one JSON body; a 200 answer is returned as raw JSON for the caller's schema. */
const post = (path: string, body: unknown, idempotencyKey?: string) =>
  Effect.gen(function* peopleAdminCall() {
    const client = yield* HttpClient.HttpClient;
    const base = HttpClientRequest.post(`${API_PREFIX}${path}`).pipe(
      HttpClientRequest.setHeader('accept', 'application/json'),
    );
    const withKey =
      idempotencyKey === undefined ? base : HttpClientRequest.setHeader(base, 'idempotency-key', idempotencyKey);
    const request = yield* HttpClientRequest.bodyJson(withKey, body);
    const response = yield* client.execute(request);
    if (response.status !== 200) {
      return { reason: failureOf(response.status), status: 'failed' as const };
    }
    const json: unknown = yield* response.json;
    return { json, status: 'ok' as const };
  });

const decodeOverview = Schema.decodeUnknownEffect(PeopleOverviewSchema);
const decodeManageResult = Schema.decodeUnknownEffect(ManageResultSchema);
const failed = (reason: PeopleFailure): { readonly reason: PeopleFailure; readonly status: 'failed' } => ({
  reason,
  status: 'failed',
});

export const loadPeopleOverview: Effect.Effect<PeopleOutcome<PeopleOverview>, never, HttpClient.HttpClient> = Effect.gen(
  function* loadOverview() {
    const answer = yield* post('/list', {});
    if (answer.status === 'failed') {
      return failed(answer.reason);
    }
    const value = yield* decodeOverview(answer.json);
    return { status: 'ok' as const, value };
  },
).pipe(Effect.orElseSucceed(() => failed('error')));

export const runPeopleCommand = (
  command: PeopleCommand,
  idempotencyKey: string,
): Effect.Effect<PeopleOutcome<ManageResult>, never, HttpClient.HttpClient> =>
  Effect.gen(function* runCommand() {
    const answer = yield* post('', command, idempotencyKey);
    if (answer.status === 'failed') {
      return failed(answer.reason);
    }
    const value = yield* decodeManageResult(answer.json);
    return { status: 'ok' as const, value };
  }).pipe(Effect.orElseSucceed(() => failed('error')));
