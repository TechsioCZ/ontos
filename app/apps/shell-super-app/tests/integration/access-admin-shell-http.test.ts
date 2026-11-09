import type { TrustedPrincipalContext } from '@app/core-runtime';
import { TrustedPrincipalContextSchema } from '@app/core-runtime/actions/principal-context';
import { createEffectBffTestHandler } from '@modern-js/bff-effect/effect-edge';
import { Effect, Layer, Option, Schema } from 'effect';
import { expect, it } from 'effect-rstest';

import { AuthenticationService } from '../../api/auth/service.ts';
import type { AuthenticationServiceContract } from '../../api/auth/service.ts';
import { makeShellAuthenticationApiRuntime, shellProductionRuntimeArguments } from '../../api/index.ts';
import {
  ListAccessApprovalsResponseSchema,
  ListAccessPeopleOptionsResponseSchema,
  ListAccessPeopleResponseSchema,
} from '../../shared/access-admin-api.ts';
import { shellAuthenticationApiContract } from '../../shared/browser-api.ts';
import { templateDatabaseLayer, withAccessAdminCase } from '../support/access-admin-real-gate-fixture.ts';
import type { AccessAdminCase, Persona } from '../support/access-admin-real-gate-fixture.ts';

/*
 * The access administration groups over HTTP, through the composition `api/index.ts` builds for
 * production: the real Shell API runtime, pointed at one real-gate case database, with the real
 * People and Approvals BFFs, the real Core stores and the real access gate over the integration
 * SpiceDB. The signed-in person is the one thing this suite supplies itself — `resolveTenantContext`
 * answers the persona a request header names, with that persona's seeded principal — because
 * authentication is not what it tests. Every authorization answer is the engine's.
 *
 * It proves that the groups the browser calls are mounted and answer: People and its options read
 * 200 for the tenant owner, a company administrator reads only their company, a plain member is
 * refused, and the approval inbox reads 200.
 */

class ShellHttpFixtureFailure extends Schema.TaggedError<ShellHttpFixtureFailure>()('ShellHttpFixtureFailure', {
  reason: Schema.String,
}) {}

const PERSONA_HEADER = 'x-p14-persona';
const { apiPrefix } = shellAuthenticationApiContract;

const unsupported = (operation: string) =>
  Effect.fail(new ShellHttpFixtureFailure({ reason: `${operation} is not part of this suite` })).pipe(Effect.orDie);

/** Signs in whichever seeded persona the request header names; every other session method is unused. */
const personaAuthentication = (principals: ReadonlyMap<string, TrustedPrincipalContext>) => {
  const service: AuthenticationServiceContract = {
    availableTenants: () => unsupported('availableTenants'),
    createFixtureUser: () => unsupported('createFixtureUser'),
    currentSession: () => unsupported('currentSession'),
    resolveShellContext: () => unsupported('resolveShellContext'),
    resolveTenantContext: (headers) =>
      Effect.succeed(
        Option.match(Option.fromNullishOr(principals.get(headers.get(PERSONA_HEADER) ?? '')), {
          onNone: () => ({ setCookieHeaders: [], state: 'anonymous' as const }),
          onSome: (principal) => ({
            identity: {
              displayName: 'P14 person',
              email: 'p14@example.test',
              principalId: principal.principalId,
              tenantId: principal.tenantId,
            },
            principal,
            setCookieHeaders: [],
            state: 'authenticated' as const,
          }),
        }),
      ),
    signIn: () => unsupported('signIn'),
    signOut: () => unsupported('signOut'),
    switchLegalEntity: () => unsupported('switchLegalEntity'),
    switchTenant: () => unsupported('switchTenant'),
  };
  return Layer.succeed(AuthenticationService, service);
};

const PERSONAS_ASKED: readonly Persona[] = ['owner', 'companyAdmin', 'member'];

/** The production Shell API runtime over this case's database, mounted as the browser reaches it. */
const shellHandlerFor = Effect.fn('AccessAdminShellHttp.handler')(function* shellHandler(accessCase: AccessAdminCase) {
  const principals = new Map<string, TrustedPrincipalContext>();
  for (const persona of PERSONAS_ASKED) {
    const scope = yield* accessCase.scopeFor(persona);
    principals.set(persona, yield* Schema.decodeUnknownEffect(TrustedPrincipalContextSchema)(scope).pipe(Effect.orDie));
  }
  const [, issuer, moduleStates] = shellProductionRuntimeArguments;
  const runtime = makeShellAuthenticationApiRuntime(
    personaAuthentication(principals),
    issuer,
    moduleStates,
    undefined,
    false,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    accessCase.databases,
  );
  return yield* Effect.acquireRelease(
    Effect.tryPromise({
      catch: () => new ShellHttpFixtureFailure({ reason: 'The Shell API handler could not be created' }),
      try: async () => await createEffectBffTestHandler({ module: { default: runtime }, prefix: apiPrefix }),
    }),
    (handler) => Effect.promise(handler.dispose.bind(handler)),
  );
});

type ShellHandler = Effect.Success<ReturnType<typeof shellHandlerFor>>;

/** One JSON POST of the browser's own shape: the persona header, an idempotency-free read. */
const post = Effect.fn('AccessAdminShellHttp.post')(function* postJson(
  handler: ShellHandler,
  input: { readonly path: string; readonly payload: object; readonly persona: Persona },
) {
  const body = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(input.payload).pipe(Effect.orDie);
  const response = yield* Effect.tryPromise({
    catch: () => new ShellHttpFixtureFailure({ reason: `POST ${input.path} did not answer` }),
    try: async () =>
      await handler.handler(
        new Request(`http://shell.test${apiPrefix}${input.path}`, {
          body,
          headers: { 'content-type': 'application/json', [PERSONA_HEADER]: input.persona },
          method: 'POST',
        }),
      ),
  });
  const text = yield* Effect.promise(async () => await response.text());
  return { status: response.status, text };
});

const decodeBody = <Value, Encoded>(schema: Schema.Codec<Value, Encoded>, text: string) =>
  Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(text).pipe(Effect.orDie);

/** Every scope a page of people names a membership in. */
const membershipScopesOf = (page: typeof ListAccessPeopleResponseSchema.Type) =>
  page.items.flatMap(({ memberships }) => memberships.map(({ scope }) => scope));

it.layer(templateDatabaseLayer, { excludeTestServices: true, timeout: '180 seconds' })(
  'the Shell API serves People and Ke schválení',
  (suite) => {
    suite.effect('People, its options and the approval inbox answer 200 through the production composition', () =>
      withAccessAdminCase((accessCase) =>
        Effect.scoped(
          Effect.gen(function* servedThroughShell() {
            const handler = yield* shellHandlerFor(accessCase);
            const owner = accessCase.ids.get('owner')?.principalId;
            const companyAdmin = accessCase.ids.get('companyAdmin')?.principalId;

            const people = yield* post(handler, {
              path: '/shell/access/people/list',
              payload: { limit: 50 },
              persona: 'owner',
            });
            expect({ status: people.status, text: people.status === 200 ? '' : people.text }).toEqual({
              status: 200,
              text: '',
            });
            const listed = yield* decodeBody(ListAccessPeopleResponseSchema, people.text);
            expect(listed.items.map(({ principalId }) => principalId)).toEqual(
              expect.arrayContaining([owner, companyAdmin]),
            );

            const options = yield* post(handler, {
              path: '/shell/access/people/options',
              payload: { limit: 100 },
              persona: 'owner',
            });
            expect(options.status).toBe(200);
            const offered = yield* decodeBody(ListAccessPeopleOptionsResponseSchema, options.text);
            // The screen reads both and refuses a mismatch, so the two answers must name one revision.
            expect(offered.revision).toBe(listed.revision);
            // The write gate ships closed, so every write control is reported unavailable.
            expect(Object.values(offered.writeAvailability).every((available) => !available)).toBe(true);

            const narrowed = yield* post(handler, {
              path: '/shell/access/people/list',
              payload: { limit: 50 },
              persona: 'companyAdmin',
            });
            expect(narrowed.status).toBe(200);
            const company = yield* decodeBody(ListAccessPeopleResponseSchema, narrowed.text);
            const [companyA] = accessCase.companies;
            // A company administrator sees only company A's rows: no tenant-context membership of anybody.
            expect(membershipScopesOf(company)).not.toContainEqual({
              kind: 'tenant',
            });
            expect(membershipScopesOf(company)).toContainEqual({
              kind: 'company',
              legalEntityId: companyA,
            });

            const refused = yield* post(handler, {
              path: '/shell/access/people/list',
              payload: { limit: 50 },
              persona: 'member',
            });
            expect(refused.status).toBe(403);

            const approvals = yield* post(handler, {
              path: '/shell/access/approvals/list',
              payload: { limit: 50 },
              persona: 'owner',
            });
            expect({ status: approvals.status, text: approvals.status === 200 ? '' : approvals.text }).toEqual({
              status: 200,
              text: '',
            });
            const inbox = yield* decodeBody(ListAccessApprovalsResponseSchema, approvals.text);
            expect(inbox).toEqual({ items: [], nextCursor: null });
          }),
        ),
      ),
    );
  },
);
