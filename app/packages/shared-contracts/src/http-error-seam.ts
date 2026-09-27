import { Effect, Schema, SchemaIssue } from 'effect';
import type { Types } from 'effect';
import { HttpRouter, HttpServerResponse } from 'effect/unstable/http';
import { HttpApiError } from 'effect/unstable/httpapi';

import { RequestSchemaProblemSchema } from './problem-details.ts';

const requestSchemaFormatter = SchemaIssue.makeFormatterStandardSchemaV1();
const responseSchemaKinds: ReadonlySet<HttpApiError.HttpApiSchemaError['kind']> = new Set(['Body', 'ResponseHeaders']);

const requestSchemaProblem = ({ cause: { issue }, kind }: HttpApiError.HttpApiSchemaError) =>
  Schema.encodeEffect(RequestSchemaProblemSchema)(
    RequestSchemaProblemSchema.make({
      detail: `The request ${kind.toLowerCase()} does not match its declared schema.`,
      paths: [...new Set(requestSchemaFormatter(issue).issues.map(({ path = [] }) => path.map(String).join('.')))],
      status: 400,
      title: 'Invalid request',
      type: 'https://ontos.dev/problems/request-schema-invalid',
    }),
  ).pipe(
    Effect.map((body) => HttpServerResponse.jsonUnsafe(body, { contentType: 'application/problem+json', status: 400 })),
    Effect.orDie,
  );

/**
 * Answers a request that fails its endpoint's params, headers, query or payload codec with the
 * RequestSchemaProblem naming each failing path. HttpApiBuilder raises an undeclared schema failure
 * as a defect, so the edge recovers exactly that defect; a response that fails its own codec stays
 * a defect. Endpoint-declared schema-error middleware, such as an Action's, answers first.
 */
export const RequestSchemaProblemLive = HttpRouter.middleware(
  (httpEffect): Effect.Effect<HttpServerResponse.HttpServerResponse, Types.unhandled> =>
    Effect.catchDefect(httpEffect, (defect) =>
      HttpApiError.HttpApiSchemaError.is(defect) && !responseSchemaKinds.has(defect.kind)
        ? requestSchemaProblem(defect)
        : Effect.die(defect),
    ),
  { global: true },
);
