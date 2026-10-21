import { randomUUID } from 'node:crypto';

import type { TrustedPrincipalContext } from '@app/core-runtime';
import {
  ActiveApplicationCompositionService,
  validateActiveApplicationCompositionSnapshot,
} from '@app/core-runtime/modules/active-application-composition';
import { Data, Effect, Schema } from 'effect';

import { issueGatewayContextAssertion } from '../auth/gateway-issuer.ts';
import { dispatchModuleApiRequest } from '../../src/module-api/transport.ts';

/** A module call could not even be attempted (composition, assertion or dispatch failed before the module ran). */
export class AgentModuleCallError extends Data.TaggedError('AgentModuleCallError')<{
  readonly reason: string;
  readonly stage: 'composition' | 'assertion' | 'dispatch';
}> {}

export interface ModuleCallOptions {
  readonly idempotencyKey?: string;
  readonly referenceAudiences?: readonly string[];
}

export interface ModuleCallResult {
  readonly body: unknown;
  readonly status: number;
}

export type ModuleCommandOutcome =
  | { readonly body: unknown; readonly ok: true }
  | { readonly code?: string; readonly message: string; readonly ok: false; readonly status: number };

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Modules read their current revision from the merchandise `view` projection; the others need no query. */
export const recordsQueryFor = (appId: string): Readonly<Record<string, unknown>> =>
  appId === 'merchandise' ? { view: {} } : {};

/** Czech message from an RFC 9457 style problem body, with a generic fallback. */
export const problemMessage = (body: unknown, status: number): string => {
  // Generic framework problems are English; people deciding on the platform page get Czech text instead.
  const generic = isRecord(body) && typeof body['detail'] === 'string' && /^[\u0020-\u007E]*$/u.test(body['detail']);
  if (generic && status === 409) {
    return 'Záznam se od návrhu změnil nebo už byl vyřízen. Obnovte seznam; zastaralý návrh zamítněte.';
  }
  if (generic && status === 403) {
    return 'K této změně nemáte v modulu oprávnění.';
  }
  if (isRecord(body)) {
    const detail = body['detail'];
    if (typeof detail === 'string' && detail.length > 0) return detail;
    const title = body['title'];
    if (typeof title === 'string' && title.length > 0) return title;
  }
  return `Modul odpověděl chybou HTTP ${status}.`;
};

/** JSON text of an arbitrary wire value (request bodies and headers). */
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** Calls one module route with a gateway assertion for `appId` (and any reference audiences) as the principal. */
export const callModuleAs = Effect.fn('AgentPlatform.callModuleAs')(function* callModuleAs(
  principal: TrustedPrincipalContext,
  appId: string,
  path: string,
  body: unknown,
  options: ModuleCallOptions = {},
) {
  const authority = yield* ActiveApplicationCompositionService;
  const snapshot = yield* authority.load.pipe(
    Effect.flatMap(validateActiveApplicationCompositionSnapshot),
    Effect.mapError(
      () => new AgentModuleCallError({ reason: 'Složení aplikace teď není dostupné.', stage: 'composition' }),
    ),
  );
  const revision = snapshot.composition.revision;
  const issue = (audience: string) =>
    issueGatewayContextAssertion({ audience, compositionRevision: revision, principal }).pipe(
      Effect.mapError(
        () => new AgentModuleCallError({ reason: `Modul ${audience} teď není dostupný.`, stage: 'assertion' }),
      ),
    );
  const gateway = yield* issue(appId);
  const references = yield* Effect.forEach(options.referenceAudiences ?? [], (audience) =>
    issue(audience).pipe(Effect.map((reference) => ({ audience, authorization: `Bearer ${reference.token}` }))),
  );
  const headers = new Headers({
    authorization: `Bearer ${gateway.token}`,
    'content-type': 'application/json',
    'x-correlation-id': randomUUID(),
    'x-ontos-composition-revision': gateway.compositionRevision,
  });
  if (options.idempotencyKey !== undefined) headers.set('idempotency-key', options.idempotencyKey);
  if (references.length > 0) headers.set('x-ontos-reference-credentials', encodeJson(references));
  const base = gateway.apiBaseUrl.startsWith('/shell-super-app-api/')
    ? gateway.apiBaseUrl.slice('/shell-super-app-api'.length)
    : gateway.apiBaseUrl;
  const response = yield* dispatchModuleApiRequest(
    new Request(`https://shell.internal${base}${path}`, {
      body: encodeJson(body),
      headers,
      method: 'POST',
    }),
  ).pipe(Effect.mapError(() => new AgentModuleCallError({ reason: 'Modul teď neodpovídá.', stage: 'dispatch' })));
  const text = yield* Effect.promise(() => response.text());
  const parsed: unknown = (() => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  })();
  return { body: parsed, status: response.status } satisfies ModuleCallResult;
});

const failed = (message: string, status: number, code?: string): ModuleCommandOutcome => ({
  message,
  ok: false,
  status,
  ...(code === undefined ? {} : { code }),
});

const attemptCommand = (
  principal: TrustedPrincipalContext,
  appId: string,
  command: Readonly<Record<string, unknown>>,
  options: { readonly actionSlug?: string; readonly referenceAudiences?: readonly string[] },
  key: string,
) =>
  Effect.gen(function* () {
    const slug = options.actionSlug ?? 'apply-command';
    // Named Actions (party-registry, commerce) take the stored payload as is and have no module-wide revision;
    // apply-command modules get `{ command, expectedRevision }` with the revision read just now.
    let body: unknown = command;
    if (slug === 'apply-command') {
      const read = yield* callModuleAs(principal, appId, '/reads/records', recordsQueryFor(appId));
      const revision = isRecord(read.body) ? read.body['revision'] : undefined;
      if (read.status !== 200 || typeof revision !== 'number') {
        return failed(problemMessage(read.body, read.status), read.status === 200 ? 503 : read.status);
      }
      body = { command, expectedRevision: revision };
    }
    const write = yield* callModuleAs(
      principal,
      appId,
      `/${appId}/actions/${slug}`,
      body,
      {
        idempotencyKey: key,
        ...(options.referenceAudiences === undefined ? {} : { referenceAudiences: options.referenceAudiences }),
      },
    );
    if (write.status >= 200 && write.status < 300) {
      return { body: write.body, ok: true } satisfies ModuleCommandOutcome;
    }
    const code = isRecord(write.body) && typeof write.body['code'] === 'string' ? write.body['code'] : undefined;
    return failed(problemMessage(write.body, write.status), write.status, code);
  }).pipe(Effect.catchTag('AgentModuleCallError', (error) => Effect.succeed(failed(error.reason, 503))));

/**
 * Runs a module's command as the given person. apply-command: reads the current revision first, then posts
 * `{ command, expectedRevision }`; named Actions are posted as stored.
 * Retries once with a fresh idempotency key when the module reports a revision conflict.
 */
export const applyModuleCommand = Effect.fn('AgentPlatform.applyModuleCommand')(function* applyModuleCommand(
  principal: TrustedPrincipalContext,
  appId: string,
  command: Readonly<Record<string, unknown>>,
  options: {
    readonly actionSlug?: string;
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
