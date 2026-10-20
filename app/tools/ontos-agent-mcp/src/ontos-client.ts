/**
 * OntOS vertical client: calls a vertical's actions and reads through the shell.
 *
 * URL patterns, derived from the sources (no live server was contacted):
 *
 * - Shell origin: ONTOS_SHELL_URL (default http://localhost:3020, .env.example:10).
 * - Audience = the vertical's stable app ID, e.g. "siampark-work"
 *   (packages/shared-contracts/src/gateway-context.ts:29-33; verticals/siampark-work/src/api/action-gateway.ts:10).
 * - Assertion response apiBaseUrl is the vertical's base path on the shell origin:
 *     /shell-super-app-api/module-api/<appId>/<buildMarker>/<appId>-api
 *   (apps/shell-super-app/api/auth/gateway-issuer.ts:256-258;
 *    packages/core-runtime/src/http/module-release-identity.ts:9-10).
 *   We never build this path ourselves: the build marker comes from the response.
 * - Action:  POST {shell}{apiBaseUrl}/{vertical}/actions/{actionSlug}
 *   (verticals/siampark-work/shared/apis/apply-command-action.ts:143 "/siampark-work/actions/apply-command";
 *    prefix at verticals/siampark-work/src/api/apply-command-action-client.ts:39).
 * - Records read: POST {shell}{apiBaseUrl}/reads/{readName}
 *   (verticals/siampark-work/shared/apis/records.ts:83 "/reads/records";
 *    prefix at verticals/siampark-work/src/api/records-client.ts:26). Query fields go in the JSON body.
 * - Headers: Authorization: Bearer <assertion> (packages/shared-contracts/src/operation-gateway.ts:51),
 *   x-ontos-composition-revision (packages/shared-contracts/src/client-runtime.ts:130), x-correlation-id.
 *   Actions also need `idempotency-key` (packages/shared-contracts/src/client-runtime.ts:128); without it the
 *   vertical answers 428. Each send is a new invocation, so a retry after a revision conflict uses a new key.
 * - Assertions are single-use, so every call issues a fresh one (see gateway.ts).
 */
import { randomUUID } from 'node:crypto';
import { Option, Result, Schema } from 'effect';
import { getConfig } from './config.ts';
import { getGatewayContext } from './gateway.ts';
import type { GatewayContext } from './gateway.ts';

/** A JSON object sent as an action payload or a read query. */
export type JsonObject = Readonly<Record<string, Schema.Json>>;

/** Keeps the defined fields only, so optional fields are omitted from the body rather than sent as `undefined`. */
export const withoutUndefined = (fields: Readonly<Record<string, Schema.Json | undefined>>) =>
  Object.fromEntries(Object.entries(fields).filter((entry): entry is [string, Schema.Json] => entry[1] !== undefined));

const segment = (value: string): string => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(value)) {
    throw new Error(`Invalid path segment: ${JSON.stringify(value)}`);
  }
  return encodeURIComponent(value);
};

/** RFC 9457 problem details. Every field is optional: a vertical may answer with any JSON body. */
const ProblemDetails = Schema.Struct({
  code: Schema.optionalKey(Schema.String),
  detail: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
});

const decodeProblem = Schema.decodeUnknownOption(Schema.fromJsonString(ProblemDetails));

const problemOf = (text: string): typeof ProblemDetails.Type =>
  Option.getOrElse(decodeProblem(text), (): typeof ProblemDetails.Type => ({}));

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value === '' ? undefined : value;

/** A non-2xx answer from the shell or a vertical. `code`, `title` and `detail` come from the RFC 9457 body. */
export class OntosRequestError extends Schema.TaggedError<OntosRequestError>()('OntosRequestError', {
  code: Schema.optionalKey(Schema.String),
  detail: Schema.optionalKey(Schema.String),
  message: Schema.String,
  status: Schema.Number,
  title: Schema.optionalKey(Schema.String),
}) {}

const requestFailure = (path: string, status: number, text: string): OntosRequestError => {
  const problem = problemOf(text);
  const code = nonEmpty(problem.code);
  const suffix = code === undefined ? '' : ` ${code}`;
  const detail = nonEmpty(problem.detail);
  const title = nonEmpty(problem.title);
  // optionalKey fields reject an explicit undefined, so absent problem fields are omitted.
  return new OntosRequestError({
    ...(code === undefined ? {} : { code }),
    ...(detail === undefined ? {} : { detail }),
    message: `OntosRequest ${path} failed: HTTP ${status}${suffix}`,
    status,
    ...(title === undefined ? {} : { title }),
  });
};

/** POSTs JSON to a vertical path through the shell and decodes the answer with `schema`. */
const postJson = async <S extends Schema.Codec<unknown>>(
  context: GatewayContext,
  path: string,
  body: JsonObject,
  schema: S,
  headers: Readonly<Record<string, string>> = {},
): Promise<S['Type']> => {
  const { shellUrl } = getConfig();
  const response = await fetch(`${shellUrl}${context.apiBaseUrl}${path}`, {
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${context.token}`,
      'content-type': 'application/json',
      'x-correlation-id': randomUUID(),
      'x-ontos-composition-revision': context.compositionRevision,
      ...headers,
    },
    method: 'POST',
  });

  const text = await response.text();
  if (!response.ok) {
    throw requestFailure(path, response.status, text);
  }
  const decoded = Schema.decodeUnknownResult(Schema.fromJsonString(schema))(text);
  if (Result.isFailure(decoded)) {
    throw decoded.failure;
  }
  return decoded.success;
};

/**
 * Invokes a vertical action. The audience is the vertical ID; the answer is decoded by `schema`.
 * `idempotencyKey` defaults to a fresh UUID; pass a stable key so a repeated logical request is executed once.
 */
export const callAction = async <S extends Schema.Codec<unknown>>(
  vertical: string,
  actionSlug: string,
  payload: JsonObject,
  schema: S,
  idempotencyKey: string = randomUUID(),
  referenceAudiences: readonly string[] = [],
): Promise<S['Type']> => {
  const context = await getGatewayContext(vertical);
  const references = await Promise.all(
    referenceAudiences.map(async (audience) => {
      const reference = await getGatewayContext(audience);
      return { audience, authorization: `Bearer ${reference.token}` };
    }),
  );
  return await postJson(context, `/${segment(vertical)}/actions/${segment(actionSlug)}`, payload, schema, {
    'idempotency-key': idempotencyKey,
    ...(references.length === 0 ? {} : { 'x-ontos-reference-credentials': JSON.stringify(references) }),
  });
};

/** Reads a vertical's records endpoint. `readName` "records" maps to POST .../reads/records. */
export const readRecords = async <S extends Schema.Codec<unknown>>(
  vertical: string,
  readName: string,
  query: JsonObject,
  schema: S,
): Promise<S['Type']> => {
  const context = await getGatewayContext(vertical);
  return await postJson(context, `/reads/${segment(readName)}`, query, schema);
};
