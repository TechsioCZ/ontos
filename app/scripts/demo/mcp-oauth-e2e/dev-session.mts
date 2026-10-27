// Developer helper for live checks of the OntOS MCP resource server.
//
//   node scripts/demo/mcp-oauth-e2e/dev-session.mts connect <file> <persona> <read_only|approval|direct>
//   node scripts/demo/mcp-oauth-e2e/dev-session.mts call <file> <tool> '<json args>'
//   node scripts/demo/mcp-oauth-e2e/dev-session.mts tools <file>
//   node scripts/demo/mcp-oauth-e2e/dev-session.mts revoke <file>
//
// <file> keeps the tokens outside the repository. Access tokens are refreshed on demand.
import { NodeServices } from '@effect/platform-node';
import { isSpecType } from '@modelcontextprotocol/client';
import type { StoredOAuthTokens, Tool } from '@modelcontextprotocol/client';
import { Cause, Clock, Config, Console, Effect, Exit, FiberSet, FileSystem, Redacted, Runtime, Schema } from 'effect';
import { Argument, Command } from 'effect/unstable/cli';
import { decodeJwt } from 'jose';
import { E2eSettings, loadE2eSettings, CIMD_CLIENT_ID, GRANT_CLAIM } from './env.mts';
import { startLoopbackCallback } from './loopback.mts';
import { E2eOAuthProvider } from './provider.mts';
import { runOAuthFlow, rotateRefreshToken } from './flow.mts';
import { connectMcp, callJson } from './mcp.mts';
import { openSharedTab, approveConnection, ensureLoggedIn, sessionPost } from './browser.mts';

const ToolsSchema = Schema.Array(Schema.declare<Tool>(isSpecType.Tool));
const TokensSchema = Schema.declare<StoredOAuthTokens>(isSpecType.OAuthTokens);
const GrantIdSchema = Schema.String.pipe(Schema.brand('OAuthProofGrantId'));
const SavedSessionSchema = Schema.Struct({
  grantId: GrantIdSchema,
  persona: Schema.String,
  tokens: TokensSchema,
  writeMode: Schema.String,
});
type SavedSession = typeof SavedSessionSchema.Type;
const SavedSessionDocumentSchema = Schema.StructWithRest(SavedSessionSchema, [
  Schema.Record(Schema.String, Schema.Union([Schema.Json, TokensSchema])),
]);
const savedSessionJson = Schema.fromJsonString(SavedSessionDocumentSchema, { space: 1 });
const jsonArguments = Schema.fromJsonString(Schema.JsonObject);
const ConnectedSchema = Schema.Struct({
  grantId: GrantIdSchema,
  iss: Schema.OptionFromNullOr(Schema.String),
  persona: Schema.String,
  writeMode: Schema.Literals(['read_only', 'approval', 'direct']),
});
const CallSummarySchema = Schema.Struct({ chars: Schema.Number, isError: Schema.Boolean, text: Schema.String });
const RevokeSummarySchema = Schema.Struct({ status: Schema.Number, text: Schema.String });

class DevSessionUsageInvalid extends Schema.TaggedError<DevSessionUsageInvalid>()('DevSessionUsageInvalid', {
  message: Schema.String,
}) {}

const driverSync = <A,>(operation: () => A) => Effect.try(operation);

const load = (file: string) =>
  Effect.gen(function* loadSession() {
    const fs = yield* FileSystem.FileSystem;
    return yield* Schema.decodeUnknownEffect(savedSessionJson)(yield* fs.readFileString(file));
  });

const save = (file: string, session: SavedSession) =>
  Effect.gen(function* saveSession() {
    const fs = yield* FileSystem.FileSystem;
    const json = yield* Schema.encodeUnknownEffect(savedSessionJson)(session);
    yield* fs.writeFileString(file, json, { mode: 0o600 });
  });

const providerFor = (tokens?: StoredOAuthTokens) =>
  Effect.gen(function* savedTokenProvider() {
    const runtime = yield* FiberSet.makeRuntimePromise<never, string, Cause.NoSuchElementError>();
    const provider = new E2eOAuthProvider(
      {
        clientMetadataUrl: CIMD_CLIENT_ID,
        clientName: 'Claude Code',
        redirectUrl: 'http://localhost:1/callback',
      },
      runtime,
    );
    if (tokens !== undefined) {
      provider.saveTokens(tokens);
    }
    return provider;
  });

const freshAccess = (file: string) =>
  Effect.gen(function* freshAccessToken() {
    const E2E = yield* E2eSettings;
    const session = yield* load(file);
    const claims = yield* driverSync(() => decodeJwt(session.tokens.access_token));
    const expiresAt = (claims.exp ?? 0) * 1000;
    if (expiresAt - (yield* Clock.currentTimeMillis) > 30_000) {
      return Redacted.make(session.tokens.access_token);
    }
    const provider = yield* providerFor(session.tokens);
    const next = yield* Effect.suspend(() =>
      rotateRefreshToken({ issuer: E2E.issuer, provider, resource: E2E.mcpUrl }),
    );
    const tokens = yield* provider.currentTokens();
    yield* save(file, { ...session, tokens });
    return next.accessToken;
  });

const command = Command.make(
  'dev-session',
  {
    command: Argument.Literals('command', ['connect', 'call', 'tools', 'revoke']),
    file: Argument.String('file'),
    rest: Argument.variadic(Argument.String('arguments')),
  },
  ({ command: operation, file, rest }) =>
    Effect.gen(function* devSession() {
      const E2E = yield* E2eSettings;
      if (operation === 'connect') {
        const [persona, writeMode] = rest;
        if (
          persona === undefined ||
          (writeMode !== 'read_only' && writeMode !== 'approval' && writeMode !== 'direct')
        ) {
          return yield* new DevSessionUsageInvalid({ message: 'connect <file> <persona> <read_only|approval|direct>' });
        }
        const tab = yield* Effect.acquireRelease(
          Effect.suspend(() => openSharedTab()),
          (value) => value.close.pipe(Effect.orDie),
        );
        const loopback = yield* Effect.acquireRelease(
          Effect.suspend(() => startLoopbackCallback()),
          (value) => value.close.pipe(Effect.orDie),
        );
        const temporaryDirectory = yield* Config.String('TMPDIR').pipe(Config.withDefault('.'));
        const shotsDir = yield* Config.String('DEV_SHOTS_DIR').pipe(
          Config.withDefault(`${temporaryDirectory}/mcp-dev-shots`),
        );
        const approve = (url: URL) =>
          approveConnection(tab.page, url.toString(), {
            actAs: { kind: 'me' },
            email: persona,
            password: E2E.password,
            shotPrefix: `dev-${persona.split('@')[0] ?? 'x'}`,
            shotsDir,
            writeMode,
          });
        const flow = yield* runOAuthFlow({
          approve,
          loopback,
          providerOptions: {
            clientMetadataUrl: CIMD_CLIENT_ID,
            clientName: 'Claude Code',
            redirectUrl: loopback.redirectUrl,
          },
          serverUrl: E2E.mcpUrl,
        });
        const { provider } = flow;
        const claims = yield* driverSync(() => decodeJwt(Redacted.value(flow.accessToken)));
        const grantId = yield* Schema.decodeUnknownEffect(GrantIdSchema)(String(claims[GRANT_CLAIM]));
        const tokens = yield* provider.currentTokens();
        yield* save(file, { grantId, persona, tokens, writeMode });
        const json = yield* Schema.encodeEffect(Schema.fromJsonString(ConnectedSchema))({
          grantId,
          iss: flow.iss,
          persona,
          writeMode,
        });
        yield* Console.log(json);
      } else if (operation === 'tools' || operation === 'call') {
        // DEV_MCP_URL selects another server instance with the same resource/audience.
        const mcpUrl = yield* Config.String('DEV_MCP_URL').pipe(Config.withDefault(E2E.mcpUrl));
        const accessToken = yield* freshAccess(file);
        const { client } = yield* Effect.acquireRelease(
          Effect.suspend(() => connectMcp(mcpUrl, accessToken)),
          (value) => Effect.tryPromise(async () => await value.client.close()).pipe(Effect.orDie),
        );
        if (operation === 'tools') {
          const listed = yield* Effect.tryPromise(async () => await client.listTools());
          const tools = yield* Schema.decodeUnknownEffect(ToolsSchema)(listed.tools);
          yield* Console.log(yield* Schema.encodeEffect(Schema.fromJsonString(ToolsSchema, { space: 1 }))(tools));
        } else {
          const [tool, json] = rest;
          const args = yield* Schema.decodeUnknownEffect(jsonArguments)(json ?? '{}');
          const outcome = yield* Effect.suspend(() => callJson(client, tool ?? 'ontos_whoami', args));
          yield* Console.log(
            yield* Schema.encodeEffect(Schema.fromJsonString(CallSummarySchema))({
              chars: outcome.text.length,
              isError: outcome.isError,
              text: outcome.text,
            }),
          );
        }
      } else {
        const session = yield* load(file);
        const tab = yield* Effect.acquireRelease(
          Effect.suspend(() => openSharedTab()),
          (value) => value.close.pipe(Effect.orDie),
        );
        yield* Effect.suspend(() => ensureLoggedIn(tab.page, E2E.shellUrl, session.persona, E2E.password));
        const result = yield* Effect.suspend(() =>
          sessionPost(tab.page, E2E.shellUrl, '/shell-super-app-api/auth/oauth-connections/revoke', {
            grantId: session.grantId,
            reason: 'user',
          }),
        );
        yield* Console.log(
          yield* Schema.encodeEffect(Schema.fromJsonString(RevokeSummarySchema))({
            status: result.status,
            text: result.text.slice(0, 300),
          }),
        );
      }
      return yield* Effect.void;
    }).pipe(Effect.scoped),
);

const abort = new AbortController();
const interrupt = (): void => {
  abort.abort();
};
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
const exit = await Effect.runPromiseExit(
  Command.run(command, { version: '1.0.0' }).pipe(
    Effect.provideServiceEffect(E2eSettings, loadE2eSettings),
    Effect.provide(NodeServices.layer),
    Effect.tapCause((cause) =>
      Runtime.getErrorReported(Cause.squash(cause)) ? Console.error(Cause.pretty(cause)) : Effect.void,
    ),
  ),
  { signal: abort.signal },
);
process.off('SIGINT', interrupt);
process.off('SIGTERM', interrupt);
const outcomeCode = Exit.match(exit, {
  onFailure: (cause) => (Cause.hasInterruptsOnly(cause) ? 130 : Runtime.getErrorExitCode(Cause.squash(cause))),
  onSuccess: () => 0,
});
process.exitCode = outcomeCode;
