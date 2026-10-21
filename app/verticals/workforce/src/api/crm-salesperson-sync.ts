/**
 * Keeps the CRM salespeople (Obchodníci) in step with "Lidé a role" (CRM.md §8: "Správce přidá/deaktivuje účet,
 * přidělí roli"). An account with a salesperson role (Hanák „Obchodník“, Siampark „Externí obchodník“) becomes an
 * active CRM salesperson, so it can own clients and sees them in „Mí klienti“; losing that role or the sign-in
 * retires it again (CRM refuses while the salesperson still holds active clients). The change runs as the signed-in administrator through the CRM owner's own governed
 * Action (`RegisterSalesperson` / `SetSalespersonActive`, `demo.crm.assign`), so CRM authorizes and audits it; a
 * company without CRM, or an administrator without CRM assignment rights, is reported back and left unchanged.
 */
import { makeOperationGateway } from '@app/shared-contracts';
import { Effect, Schema } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/unstable/http';

/** Role keys of `demo-accounts.ts` whose holders work as CRM salespeople. */
const SALES_ROLE_KEYS: ReadonlySet<string> = new Set(['crmRep', 'external']);
export const isCrmSalesRole = (roleKey: string | null | undefined) =>
  roleKey !== null && roleKey !== undefined && SALES_ROLE_KEYS.has(roleKey);

const crmGateway = makeOperationGateway('crm');

const SalespersonSchema = Schema.Struct({
  active: Schema.Boolean,
  id: Schema.String,
  name: Schema.String,
  principalId: Schema.optionalKey(Schema.String),
});
const RecordsSchema = Schema.Struct({
  revision: Schema.Int,
  state: Schema.Struct({ salespeople: Schema.Array(SalespersonSchema) }),
  viewer: Schema.Struct({ assign: Schema.Boolean }),
});
const ProblemSchema = Schema.Struct({ detail: Schema.optionalKey(Schema.String) });

export interface SalespersonAccount {
  readonly active: boolean;
  readonly displayName: string;
  readonly email: string | null;
  readonly principalId: string;
  /** Role before this change; a salesperson is retired only when it loses a salesperson role or its sign-in. */
  readonly previousRoleKey?: string | null;
  readonly roleKey: string | null;
}

export type SalespersonSync =
  /** Nothing to change (the account is not a salesperson and never was one, or CRM already matches). */
  | { readonly kind: 'unchanged' }
  | { readonly kind: 'registered' | 'reactivated' | 'retired'; readonly name: string }
  /** CRM refused or is unreachable; `reason` is CRM's own Czech message when it sent one. */
  | { readonly kind: 'failed'; readonly reason: string | undefined };

type Command =
  | {
      readonly _tag: 'RegisterSalesperson';
      readonly email?: string;
      readonly name: string;
      readonly principalId: string;
    }
  | { readonly _tag: 'SetSalespersonActive'; readonly active: boolean; readonly salespersonId: string };

const failed = (reason?: string): SalespersonSync => ({ kind: 'failed', reason });

const post = (
  client: HttpClient.HttpClient,
  correlationId: string,
  path: string,
  body: unknown,
  authorization: string,
  target: { readonly apiBaseUrl: string; readonly compositionRevision: string },
  idempotencyKey?: string,
) =>
  Effect.gen(function* crmPost() {
    const base = HttpClientRequest.post(`${target.apiBaseUrl}${path}`).pipe(
      HttpClientRequest.setHeaders({
        accept: 'application/json',
        authorization,
        'x-correlation-id': correlationId,
        'x-ontos-composition-revision': target.compositionRevision,
      }),
    );
    const request = yield* HttpClientRequest.bodyJson(
      idempotencyKey === undefined ? base : HttpClientRequest.setHeader(base, 'idempotency-key', idempotencyKey),
      body,
    );
    const response = yield* client.execute(request).pipe(Effect.timeout('10 seconds'));
    const json: unknown = yield* response.json.pipe(Effect.orElseSucceed(() => ({})));
    return { json, status: response.status };
  });

const problemDetail = (json: unknown) =>
  Schema.decodeUnknownEffect(ProblemSchema)(json).pipe(
    Effect.map((problem) => problem.detail),
    Effect.orElseSucceed(() => undefined),
  );

/** Brings the CRM salesperson of one account in line with its role and sign-in state. */
export const syncCrmSalesperson = (
  account: SalespersonAccount,
  idempotencyKey: string,
): Effect.Effect<SalespersonSync, never, HttpClient.HttpClient> =>
  Effect.gen(function* syncCrmSalespersonEffect() {
    const client = yield* HttpClient.HttpClient;
    const correlation = `workforce:crm-salesperson:${idempotencyKey}`;
    return yield* crmGateway.invoke((authorization, target) =>
      Effect.gen(function* syncSalesperson() {
        const read = yield* post(client, correlation, '/reads/records', {}, authorization, target);
        if (read.status !== 200) {
          return failed(yield* problemDetail(read.json));
        }
        const records = yield* Schema.decodeUnknownEffect(RecordsSchema)(read.json);
        const existing = records.state.salespeople.find((person) => person.principalId === account.principalId);
        const wanted = account.active && isCrmSalesRole(account.roleKey);
        let command: Command | undefined;
        let kind: 'registered' | 'reactivated' | 'retired' = 'registered';
        if (wanted && existing === undefined) {
          command = {
            _tag: 'RegisterSalesperson',
            name: account.displayName,
            principalId: account.principalId,
            ...(account.email === null ? {} : { email: account.email }),
          };
        } else if (wanted && existing?.active === false) {
          command = { _tag: 'SetSalespersonActive', active: true, salespersonId: existing.id };
          kind = 'reactivated';
        } else if (
          !wanted &&
          existing?.active === true &&
          (!account.active || isCrmSalesRole(account.previousRoleKey))
        ) {
          command = { _tag: 'SetSalespersonActive', active: false, salespersonId: existing.id };
          kind = 'retired';
        }
        if (command === undefined) {
          return { kind: 'unchanged' } satisfies SalespersonSync;
        }
        if (!records.viewer.assign) {
          return failed();
        }
        const applied = yield* post(
          client,
          correlation,
          '/crm/actions/apply-command',
          { command, expectedRevision: records.revision },
          authorization,
          target,
          `${idempotencyKey}:crm-salesperson`,
        );
        if (applied.status !== 200) {
          return failed(yield* problemDetail(applied.json));
        }
        return { kind, name: existing?.name ?? account.displayName } satisfies SalespersonSync;
      }),
    );
  }).pipe(Effect.orElseSucceed(() => failed()));
