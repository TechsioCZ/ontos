/**
 * The identity half of a demo machine principal: its `core.principals` row and its managed API key.
 *
 * Authorization v2 separated identity from authority (ADR-0030): a principal row is identity, a managed key
 * is transport, and authority is either a Role Assignment (people) or a registered workload binding (a
 * machine a carrier admits). These helpers do only the first two, so a demo operator script can create a
 * service identity without writing a SpiceDB relationship by hand.
 */
import { randomUUID } from 'node:crypto';

import { Config, ConfigProvider, Effect, FileSystem, Path, Redacted, Schema } from 'effect';
import { Cookies, HttpClient, HttpClientRequest, HttpClientResponse } from 'effect/http';

import { AuthDatabase } from '../../apps/shell-super-app/api/auth/db/client.ts';
import { principals } from '../../packages/core-runtime/src/db/schema.ts';

export class MachineIdentityError extends Schema.TaggedError<MachineIdentityError>()('MachineIdentityError', {
  reason: Schema.String,
}) {}
const fail = (reason: string) => new MachineIdentityError({ reason });

export interface MachinePrincipal {
  readonly displayName: string;
  readonly kind: 'integration' | 'service' | 'system';
  readonly legalEntityId?: string;
  readonly principalId: string;
  readonly tenantId: string;
}

/** Inserts (or reactivates) the principal rows of the reviewed machine identities. Identity only. */
export const ensureMachinePrincipals = (machines: readonly MachinePrincipal[]) =>
  Effect.gen(function* ensureMachinePrincipalsEffect() {
    const { executor } = yield* AuthDatabase;
    for (const machine of machines) {
      yield* executor
        .insert(principals)
        .values({
          displayName: machine.displayName,
          kind: machine.kind,
          principalId: machine.principalId,
          status: 'active',
          tenantId: machine.tenantId,
        })
        .onConflictDoUpdate({ set: { status: 'active' }, target: principals.principalId });
    }
    return yield* Effect.void;
  }).pipe(
    Effect.catchTag('EffectDrizzleQueryError', (cause) =>
      Effect.fail(fail(`The machine principal rows could not be written (${cause.message})`)),
    ),
  );

const SignInBodySchema = Schema.Struct({ email: Schema.String, password: Schema.Redacted(Schema.String) });
const IssueKeyBodySchema = Schema.Struct({
  name: Schema.String,
  principalId: Schema.toEncoded(Schema.String.pipe(Schema.brand('MachinePrincipalId'))),
  scope: Schema.Literal('tenant-managed'),
});
const IssuedKeySchema = Schema.Struct({ secret: Schema.Redacted(Schema.String.check(Schema.isMinLength(1))) });
const SECURE_COOKIE_PREFIX = '__Secure-';

/** The Shell signs into a `__Secure-` cookie the API-key instance reads without the prefix; send both. */
const sessionCookieHeader = (cookies: Cookies.Cookies) => {
  const aliases = Object.entries(Cookies.toRecord(cookies)).flatMap(([name, value]) =>
    name.startsWith(SECURE_COOKIE_PREFIX) ? [[name.slice(SECURE_COOKIE_PREFIX.length), value] as const] : [],
  );
  return Cookies.toCookieHeader(Cookies.setAllUnsafe(cookies, aliases));
};

const postJson = <S extends Schema.Top>(
  url: string,
  schema: S,
  body: S['Type'],
  headers: Readonly<Record<string, string>>,
) =>
  Effect.gen(function* postJsonRequest() {
    const client = yield* HttpClient.HttpClient;
    const request = yield* HttpClientRequest.schemaBodyJson(schema)(
      HttpClientRequest.post(url).pipe(HttpClientRequest.setHeaders({ 'x-correlation-id': randomUUID(), ...headers })),
      body,
    );
    return yield* client.execute(request);
  }).pipe(Effect.timeout('20 seconds'));

/** The Shell must be serving; a machine identity is only reachable through its managed-key endpoint. */
export const shellIsServing = (shellUrl: string) =>
  Effect.gen(function* probeShell() {
    const client = yield* HttpClient.HttpClient;
    return yield* client.get(`${shellUrl}/.well-known/ontos-shell-runtime.json`).pipe(
      Effect.timeout('10 seconds'),
      Effect.map(({ status }) => status === 200),
      Effect.orElseSucceed(() => false),
    );
  });

/**
 * Issues (or reissues) one managed API key for a machine principal, signed in as the operator that
 * administers the tenant. The secret is returned, never logged.
 */
export const issueManagedKey = (input: {
  readonly keyName: string;
  readonly operatorEmail: string;
  readonly password: Redacted.Redacted;
  readonly principalId: string;
  readonly shellUrl: string;
}) =>
  Effect.gen(function* issueManagedKeyEffect() {
    const signIn = yield* postJson(
      `${input.shellUrl}/shell-super-app-api/auth/sign-in`,
      SignInBodySchema,
      { email: input.operatorEmail, password: input.password },
      { origin: input.shellUrl },
    );
    if (signIn.status !== 200) {
      return yield* fail(`Sign-in as ${input.operatorEmail} failed with HTTP ${String(signIn.status)}`);
    }
    const issued = yield* postJson(
      `${input.shellUrl}/shell-super-app-api/auth/identity/api-keys/managed`,
      IssueKeyBodySchema,
      { name: input.keyName, principalId: input.principalId, scope: 'tenant-managed' },
      {
        cookie: sessionCookieHeader(signIn.cookies),
        'idempotency-key': `demo-machine-${input.keyName}-${randomUUID()}`,
        origin: input.shellUrl,
      },
    );
    if (issued.status !== 200) {
      const detail = yield* issued.text;
      return yield* fail(`Managed API key issuance failed with HTTP ${String(issued.status)}: ${detail.slice(0, 300)}`);
    }
    const { secret } = yield* HttpClientResponse.schemaBodyJson(IssuedKeySchema)(issued);
    return secret;
  });

const envLinePattern = /^(?<key>[A-Z][A-Z0-9_]*)=(?<value>.*)$/u;

/** Reads an env file into a value map, preserving every other line when it is written back. */
export const readEnvValues = (text: string): ReadonlyMap<string, string> =>
  new Map(
    text.split('\n').flatMap((line) => {
      const groups = envLinePattern.exec(line.trim())?.groups;
      const key = groups?.key;
      return key === undefined ? [] : [[key, groups?.value ?? ''] as const];
    }),
  );

/** Writes the given values beside the existing ones, mode 600. Secrets stay with the caller. */
export const writeEnvValues = (input: {
  readonly header: string;
  readonly path: string;
  readonly values: ReadonlyMap<string, string>;
}) =>
  Effect.gen(function* writeEnvValuesEffect() {
    const fs = yield* FileSystem.FileSystem;
    const existing = (yield* fs.exists(input.path))
      ? readEnvValues(yield* fs.readFileString(input.path))
      : new Map<string, string>();
    const merged = new Map([...existing, ...input.values]);
    const text = [`# ${input.header}`, ...[...merged.entries()].map(([key, value]) => `${key}=${value}`), ''].join(
      '\n',
    );
    yield* fs.writeFileString(input.path, text, { mode: 0o600 });
    yield* fs.chmod(input.path, 0o600);
  });

/** The operator environment of one demo machine-identity run. */
export const machineIdentityEnvironment = (root: string) =>
  Effect.gen(function* loadMachineIdentityEnvironment() {
    const path = yield* Path.Path;
    const provider = ConfigProvider.orElse(
      ConfigProvider.fromEnv(),
      yield* ConfigProvider.fromDotEnv({ path: path.join(root, '.env') }),
    );
    const values = yield* Config.all({
      password: Config.Redacted('ONTOS_DEMO_PASSWORD').pipe(Config.withDefault(Redacted.make('password1234'))),
      shellUrl: Config.String('ONTOS_SHELL_URL').pipe(Config.withDefault('http://localhost:3020')),
    }).parse(provider);
    return { password: values.password, shellUrl: values.shellUrl };
  });

/** The workspace root of a script under `scripts/demo/`. */
export const workspaceRootOf = (metaUrl: string): URL => new URL('../..', metaUrl);
