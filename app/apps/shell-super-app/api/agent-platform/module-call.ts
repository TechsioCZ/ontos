import type { OperationalScopeRequest, TrustedPrincipalContext } from '@app/core-runtime';
import {
  ActiveApplicationCompositionService,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime/modules/active-application-composition';
import type { AgentCommand } from '@app/shared-contracts/agent-proposals';
import {
  commandActionSlugOf,
  commandActionSlugsOf,
  isNamedActionPayload,
} from '@app/core-runtime/modules/mcp-contribution';
import { Data, Effect, Option, Predicate, Result, Schema } from 'effect';

import { dispatchModuleApiRequest } from '../../src/module-api/transport.ts';
import type { McpModule } from '../mcp/catalog.ts';
import { AgentReadRequestIdentity } from '../auth/agent-request-identity.ts';
import { issueGatewayContextAssertion } from '../auth/gateway-issuer.ts';
import { czechModuleFailure, isGenericProblemText } from './approval-logic.ts';
import { commandRevisionFrom, loadComposedModules, revisionQueryOf } from './composed-modules.ts';

/** The module call failed at its composition, assertion or transport boundary. */
export class AgentModuleCallError extends Data.TaggedError('AgentModuleCallError')<{
  readonly cause?: Schema.Defect['Type'];
  readonly reason: string;
  readonly stage: 'composition' | 'assertion' | 'dispatch';
}> {}

export interface ModuleCallOptions {
  readonly compositionRevision?: string;
  readonly idempotencyKey?: string;
  readonly referenceAudiences?: readonly string[];
  readonly transport?: OperationalScopeRequest;
}

export interface ModuleCallResult {
  /** JSON transport only; the owning module's caller decodes its records or review contract. */
  readonly body: Schema.Json;
  readonly status: number;
}

export type ModuleCommandOutcome =
  | { readonly body: Schema.Json; readonly ok: true }
  | { readonly code?: string; readonly message: string; readonly ok: false; readonly status: number };

const COMPOSITION_UNAVAILABLE = 'Složení aplikace teď není dostupné.';

/** The module's records read (path and body) as its contribution declares it; `/reads/records` with `{}` otherwise. */
export const recordsReadOf = Effect.fn('AgentPlatform.recordsReadOf')(
  function* recordsReadOf(appId: string) {
    const modules = yield* loadComposedModules;
    const module = modules.byAppId(appId);
    const query = yield* Schema.decodeEffect(Schema.JsonObject)(revisionQueryOf(module));
    return { module, path: module?.revision?.path ?? '/reads/records', query };
  },
  Effect.mapError(
    (cause) => new AgentModuleCallError({ cause, reason: COMPOSITION_UNAVAILABLE, stage: 'composition' }),
  ),
);

// RFC 9457 permits owner-specific extension properties; these are projections, not an owner response schema.
const ProblemTextSchema = Schema.Struct({
  detail: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
});
const ProblemCodeSchema = Schema.Struct({ code: Schema.optionalKey(Schema.String) });
const decodeProblemText = Schema.decodeUnknownOption(ProblemTextSchema);
const decodeProblemCode = Schema.decodeUnknownOption(ProblemCodeSchema);

/** Czech message from an RFC 9457 style problem body, with a generic fallback. */
export const problemMessage = (body: Schema.Json, status: number): string => {
  const problem = decodeProblemText(body);
  if (Option.isSome(problem)) {
    for (const text of [problem.value.detail, problem.value.title]) {
      if (text !== undefined && text.length > 0) {
        // Generic framework problems are English; people deciding on the platform page get Czech text instead.
        return isGenericProblemText(text) ? czechModuleFailure(text, status) : text;
      }
    }
  }
  return czechModuleFailure('', status);
};

const JsonTextSchema = Schema.fromJsonString(Schema.Json);
const encodeJson = Schema.encodeEffect(JsonTextSchema);
const decodeJson = Schema.decodeEffect(JsonTextSchema);

/** Calls one module route with a gateway assertion for `appId` (and any reference audiences) as the principal. */
export const callModuleAs = Effect.fn('AgentPlatform.callModuleAs')(
  function* callModuleAs(
    principal: TrustedPrincipalContext,
    appId: string,
    path: string,
    body: Schema.Json,
    options: ModuleCallOptions = {},
  ) {
    const authority = yield* ActiveApplicationCompositionService;
    const snapshot = yield* authority.load.pipe(
      Effect.flatMap(validateActiveApplicationCompositionSnapshot),
      Effect.mapError(
        (cause) => new AgentModuleCallError({ cause, reason: COMPOSITION_UNAVAILABLE, stage: 'composition' }),
      ),
    );
    const { revision } = snapshot.composition;
    if (options.compositionRevision !== undefined && revision !== options.compositionRevision) {
      return yield* new AgentModuleCallError({
        reason: 'Složení aplikace se během požadavku změnilo.',
        stage: 'composition',
      });
    }
    const transport = options.transport ?? (yield* AgentReadRequestIdentity);
    const issue = (audience: string) =>
      issueGatewayContextAssertion({ audience, compositionRevision: revision, principal }).pipe(
        Effect.mapError(
          (cause) =>
            new AgentModuleCallError({ cause, reason: `Modul ${audience} teď není dostupný.`, stage: 'assertion' }),
        ),
      );
    const gateway = yield* issue(appId);
    const references = yield* Effect.forEach(
      options.referenceAudiences ?? [],
      (audience) =>
        issue(audience).pipe(Effect.map((reference) => ({ audience, authorization: `Bearer ${reference.token}` }))),
      { concurrency: 3 },
    );
    const { body: encodedBody, references: encodedReferences } = yield* Effect.all(
      { body: encodeJson(body), references: encodeJson(references) },
      { concurrency: 1 },
    ).pipe(
      Effect.mapError(
        (cause) => new AgentModuleCallError({ cause, reason: 'Požadavek modulu nelze odeslat.', stage: 'dispatch' }),
      ),
    );
    // Keep the request signal alive through body consumption, not just until response headers arrive.
    // Closing this scope on failure, deadline or caller interruption also aborts the native owner fetch.
    const signal = yield* Effect.abortSignal;
    const request = yield* Effect.try({
      catch: (cause) =>
        new AgentModuleCallError({ cause, reason: 'Požadavek modulu nelze odeslat.', stage: 'dispatch' }),
      try: () => {
        const headers = new Headers({
          authorization: `Bearer ${gateway.token}`,
          'content-type': 'application/json',
          'x-correlation-id': transport.correlationId,
          'x-ontos-composition-revision': gateway.compositionRevision,
        });
        if (options.transport?.traceId !== undefined) {
          headers.set('x-trace-id', options.transport.traceId);
        }
        if (options.idempotencyKey !== undefined) {
          headers.set('idempotency-key', options.idempotencyKey);
        }
        if (references.length > 0) {
          headers.set('x-ontos-reference-credentials', encodedReferences);
        }
        const base = gateway.apiBaseUrl.startsWith('/shell-super-app-api/')
          ? gateway.apiBaseUrl.slice('/shell-super-app-api'.length)
          : gateway.apiBaseUrl;
        return new Request(`https://shell.internal${base}${path}`, {
          body: encodedBody,
          headers,
          method: 'POST',
          signal,
        });
      },
    });
    const response = yield* dispatchModuleApiRequest(request).pipe(
      Effect.mapError(
        (cause) => new AgentModuleCallError({ cause, reason: 'Modul teď neodpovídá.', stage: 'dispatch' }),
      ),
    );
    const text = yield* Effect.tryPromise({
      catch: (cause) => new AgentModuleCallError({ cause, reason: 'Odpověď modulu nelze přečíst.', stage: 'dispatch' }),
      try: response.text.bind(response),
    }).pipe(
      Effect.timeoutOrElse({
        duration: '10 seconds',
        orElse: () =>
          Effect.fail(new AgentModuleCallError({ reason: 'Čtení odpovědi modulu vypršelo.', stage: 'dispatch' })),
      }),
    );
    // These statuses intentionally have no representation. An empty or malformed JSON response otherwise fails closed.
    const parsed =
      response.status === 204 || response.status === 205
        ? null
        : yield* decodeJson(text).pipe(
            Effect.mapError(
              (cause) =>
                new AgentModuleCallError({ cause, reason: 'Modul vrátil neplatnou odpověď.', stage: 'dispatch' }),
            ),
          );
    return { body: parsed, status: response.status } satisfies ModuleCallResult;
  },
  Effect.scoped,
  Effect.timeoutOrElse({
    duration: '30 seconds',
    orElse: () => Effect.fail(new AgentModuleCallError({ reason: 'Volání modulu vypršelo.', stage: 'dispatch' })),
  }),
);

/** The person's records read of a module (undefined when the module did not answer 200). */
export const readModuleRecords = (principal: TrustedPrincipalContext, appId: string) =>
  recordsReadOf(appId).pipe(
    Effect.flatMap((read) => callModuleAs(principal, appId, read.path, read.query)),
    Effect.result,
    Effect.map((result) =>
      Result.isSuccess(result) && result.success.status === 200 ? result.success.body : undefined,
    ),
  );

const failed = (message: string, status: number, code?: string): ModuleCommandOutcome =>
  code === undefined ? { message, ok: false, status } : { code, message, ok: false, status };

/**
 * Which module Action runs a command. `exact`: the approved proposal's own Action, authorized at submit; it runs
 * exactly that Action or nothing. Otherwise the module supplied the command itself (undo plan, follow-up, AI change
 * decision): the Action whose command union accepts its tag, `preferred` first; an untagged command runs as
 * `preferred`, a named Action. Untagged payloads pass only as {@link isNamedActionPayload}: never a self-wrapped
 * command envelope, never without the module's published command map.
 */
export type ModuleCommandAction = { readonly exact: string } | { readonly preferred?: string };

interface CommandTarget {
  /** Posted as `{ command, expectedRevision }` (command-union Action) or as the payload itself (named Action). */
  readonly envelope: boolean;
  readonly slug: string;
}

/** The owning Action of a command, from the module's published command unions; undefined when it has none. */
export const commandTargetOf = (
  commandActions: McpModule['commandActions'],
  command: AgentCommand,
  action: ModuleCommandAction,
): CommandTarget | undefined => {
  const tag = command['_tag'];
  if ('exact' in action) {
    if (isNamedActionPayload(commandActions, action.exact, command)) {
      return { envelope: false, slug: action.exact };
    }
    return Predicate.isString(tag) && commandActionSlugsOf(commandActions, tag).includes(action.exact)
      ? { envelope: true, slug: action.exact }
      : undefined;
  }
  if (Predicate.isString(tag)) {
    const slug = commandActionSlugOf(commandActions, tag, action.preferred);
    return slug === undefined ? undefined : { envelope: true, slug };
  }
  return action.preferred !== undefined && isNamedActionPayload(commandActions, action.preferred, command)
    ? { envelope: false, slug: action.preferred }
    : undefined;
};

const NO_OWNING_ACTION = 'Modul nemá akci, která by tento příkaz provedla; změnu proto nelze provést.';

const attemptCommand = Effect.fn('AgentPlatform.attemptCommand')(
  function* attemptCommand(
    principal: TrustedPrincipalContext,
    appId: string,
    command: AgentCommand,
    options: { readonly action: ModuleCommandAction; readonly referenceAudiences?: readonly string[] },
    key: string,
  ) {
    const records = yield* recordsReadOf(appId);
    const target = commandTargetOf(records.module?.commandActions, command, options.action);
    if (target === undefined) {
      return failed(NO_OWNING_ACTION, 400);
    }
    // Command-union Actions get `{ command, expectedRevision }` with the revision read just now; named Actions
    // (party-registry, commerce) take the stored payload as is and have no module-wide revision.
    let body: Schema.Json = command;
    if (target.envelope) {
      const read = yield* callModuleAs(principal, appId, records.path, records.query);
      if (read.status !== 200) {
        return failed(problemMessage(read.body, read.status), read.status);
      }
      const revision = commandRevisionFrom(records.module, read.body, command);
      if (revision === undefined) {
        return failed('Modul neuvedl aktuální revizi záznamů, změnu proto nelze bezpečně provést.', 503);
      }
      body = { command, expectedRevision: revision };
    }
    const callOptions: ModuleCallOptions =
      options.referenceAudiences === undefined
        ? { idempotencyKey: key }
        : { idempotencyKey: key, referenceAudiences: options.referenceAudiences };
    const write = yield* callModuleAs(principal, appId, `/${appId}/actions/${target.slug}`, body, callOptions);
    if (write.status >= 200 && write.status < 300) {
      return { body: write.body, ok: true } satisfies ModuleCommandOutcome;
    }
    const problem = decodeProblemCode(write.body);
    const code = Option.isSome(problem) ? problem.value.code : undefined;
    return failed(problemMessage(write.body, write.status), write.status, code);
  },
  Effect.catchTag('AgentModuleCallError', (failure) => Effect.succeed(failed(failure.reason, 503))),
);

/**
 * Runs a module's command as the given person through the Action {@link commandTargetOf} selects: a command-union
 * Action reads the current revision first, then gets `{ command, expectedRevision }`; a named Action gets the
 * payload as stored. Retries once with a fresh idempotency key when the module reports a revision conflict.
 */
export const applyModuleCommand = Effect.fn('AgentPlatform.applyModuleCommand')(function* applyModuleCommand(
  principal: TrustedPrincipalContext,
  appId: string,
  command: AgentCommand,
  options: {
    readonly action: ModuleCommandAction;
    readonly idempotencyKey: string;
    readonly referenceAudiences?: readonly string[];
  },
) {
  const first = yield* attemptCommand(principal, appId, command, options, options.idempotencyKey);
  if (first.ok || first.status !== 409 || first.code === undefined || !first.code.endsWith('revision_conflict')) {
    return first;
  }
  return yield* attemptCommand(principal, appId, command, options, `${options.idempotencyKey}-retry`);
});
