import { GatewayContextResponseSchema, GatewayDelegatedContextRequestSchema } from '@app/shared-contracts';
import { problemDetailsContentType } from '@app/shared-contracts/problem-details';
import { ConfigProvider, Effect, Layer, Schema } from 'effect';
import { FetchHttpClient } from 'effect/http';

import { holdTestModuleCredentials } from '../../../../packages/core-runtime/tests/support/module-credentials.ts';

import {
  OrderFinalizationWorkResponseSchema,
  OrderPreparationProgressSchema,
  OrderProofProgressSchema,
} from '../../shared/domain/order-commitment.ts';
import type { OrderCommitmentState } from '../../shared/domain/order-commitment.ts';
import { approvedProposalEvidence } from './order-approval-gateway-state.ts';
import { orderPreparationInput } from './order-preparation-input.ts';
import {
  failedOrderPreparationWork,
  orderPreparationPayload,
  orderProofPayload,
  pendingOrderPreparationWork,
} from './order-preparation-work.ts';

export const orderDelegatedGatewayPath = '/shell-super-app-api/auth/delegated/gateway-context';
export const orderWorkPath = '/reads/order-finalization-work';
export const completeOrderPreparationPath = '/commerce-order/actions/complete-order-preparation';
export const recordOrderProofSetPath = '/commerce-order/actions/record-order-proof-set';
export const approvalEvidencePath = '/reads/order-service-approval-evidence';
export const revalidateApprovalPath = '/commerce-customer-context/actions/revalidate-order-purchase-approval';
export const consumeApprovalPath = '/commerce-customer-context/actions/consume-order-purchase-approval';
export const quotationVerificationPath = '/reads/quotation-verification';
export const manageCommitmentConfirmationPath = '/pricing/actions/manage-commitment-confirmation';
export const commitmentConfirmationVerificationPath = '/reads/commitment-confirmation-verification';

/** An owner peer's answer to one request. Throwing is `fetch`'s own contract for a response never received. */
export type OwnerReply = () => Response;

const jsonType = 'application/json';
const respond = (text: string, status: number, contentType = jsonType): Response =>
  new Response(text, { headers: { 'content-type': contentType }, status });

/** A declared success answer, encoded by the owner's own contract schema (a parked proposal answers 202). */
export const ownerWire = <T, E>(schema: Schema.Codec<T, E>, value: T, status = 200): OwnerReply => {
  const text = Schema.encodeSync(Schema.fromJsonString(schema))(value);
  return () => respond(text, status);
};
/** A declared Problem Details failure, encoded by its contract schema and sent with its own status. */
export const ownerProblem = <T extends { readonly status: number }, E>(
  schema: Schema.Codec<T, E>,
  problem: T,
): OwnerReply => {
  const text = Schema.encodeSync(Schema.fromJsonString(schema))(problem);
  return () => respond(text, problem.status, problemDetailsContentType);
};
/**
 * A conforming answer whose encoded text was rewritten afterwards, as no owner honouring its contract could
 * send it. The caller's own decoding at the boundary must refuse it.
 */
export const ownerForgery = <T, E>(
  schema: Schema.Codec<T, E>,
  value: T,
  rewrite: (encoded: string) => string,
): OwnerReply => {
  const text = rewrite(Schema.encodeSync(Schema.fromJsonString(schema))(value));
  return () => respond(text, 200);
};
export const lostOwnerResponse: OwnerReply = () => {
  throw new TypeError('The owner response was lost in transport');
};

/** The bytes the actual Effect fetch transport hands to `fetch` as the request body. */
const bodyText = (body: RequestInit['body']): string => {
  if (Schema.is(Schema.String)(body)) {
    return body;
  }
  return ArrayBuffer.isView(body) ? new TextDecoder().decode(body) : '';
};

interface SentRequest {
  readonly body: string;
  readonly request: Request;
}

/**
 * Fake Shell and owner peers behind the actual Effect transport. The Shell issues the bearer for each
 * delegation, bound to the given composition; each owner route answers its scripted replies in order,
 * repeating the last one. Anything unscripted is an unknown route. A test installs `answer` as its
 * `FetchHttpClient.Fetch` through `ownerTransportLayer`.
 */
export const makeOrderOwnerTransport = (input: {
  readonly compositionRevision: string;
  readonly expiresAt: number;
  readonly token: string;
}) => {
  const sent: SentRequest[] = [];
  const replies = new Map<string, OwnerReply[]>();
  const shellGrant = Schema.encodeSync(Schema.fromJsonString(GatewayContextResponseSchema))({
    apiBaseUrl: '/owner-api',
    compositionRevision: input.compositionRevision,
    expiresAt: input.expiresAt,
    token: input.token,
  });
  const answer = (target: RequestInfo | URL, init?: RequestInit): Response => {
    const request = new Request(target, init);
    sent.push({ body: bodyText(init?.body), request });
    const { pathname } = new URL(request.url);
    if (pathname === orderDelegatedGatewayPath) {
      return respond(shellGrant, 200);
    }
    const scripted = [...replies.entries()].find(([path]) => pathname.endsWith(path))?.[1] ?? [];
    const next = scripted.length > 1 ? scripted.shift() : scripted[0];
    return next === undefined ? Response.json({ detail: 'Unscripted owner route' }, { status: 404 }) : next();
  };
  const sentTo = (path: string) =>
    sent.filter(({ request }) => new URL(request.url).pathname.endsWith(path)).map(({ request }) => request);
  /** What the caller sent to one route, decoded by that route's own request contract. */
  const bodies = <T, E>(path: string, schema: Schema.Codec<T, E>): Effect.Effect<readonly T[], Schema.SchemaError> =>
    Effect.forEach(
      sent.filter(({ request }) => new URL(request.url).pathname.endsWith(path)),
      ({ body }) => Schema.decodeUnknownEffect(Schema.fromJsonString(schema))(body),
    );
  return {
    answer,
    bodies,
    delegations: () => bodies(orderDelegatedGatewayPath, GatewayDelegatedContextRequestSchema),
    reply: (path: string, ...next: readonly OwnerReply[]) => {
      replies.set(path, [...next]);
    },
    requests: () => sent.map(({ request }) => request),
    sentTo,
  };
};

/**
 * The delegated client's settings and the given `fetch` behind the actual Effect transport. The delegated
 * client's own settings win; anything else the run reads keeps its ambient value. The Order module holds its own
 * key, handed over through the hosted credential store the way the host does; no configuration names a module key.
 */
export const ownerTransportLayer = (fetch: typeof globalThis.fetch) =>
  Layer.mergeAll(
    Layer.effectDiscard(holdTestModuleCredentials({ 'commerce-order': 'order-unit-module-key' })),
    ConfigProvider.layerAdd(
      ConfigProvider.fromUnknown({
        ONTOS_SHELL_GATEWAY_BASE_URL: 'https://shell.unit.invalid/shell-super-app-api',
      }),
      { asPrimary: true },
    ),
    Layer.succeed(FetchHttpClient.Fetch, fetch),
  );

const answered =
  (text: string): OwnerReply =>
  () =>
    respond(text, 200);
const workText = Schema.encodeUnknownSync(Schema.fromJsonString(OrderFinalizationWorkResponseSchema));

/** The Order owner's read answer for still-pending preparation work, with schema-valid owner evidence. */
export const pendingOrderPreparationAnswer = answered(
  workText({ ...pendingOrderPreparationWork, evidence: approvedProposalEvidence, input: orderPreparationInput() }),
);
/** The Order owner's read answer once preparation failed terminally. */
export const failedOrderPreparationAnswer = answered(workText(failedOrderPreparationWork));
/** The FAILED progress the preparation completion Action answers. */
export const failedPreparationProgressAnswer = answered(
  Schema.encodeUnknownSync(Schema.fromJsonString(OrderPreparationProgressSchema))({
    binding: null,
    intentRef: orderPreparationPayload.intentRef,
    status: 'FAILED',
  }),
);

/**
 * The Order owner's proof work over one retained commitment state: the pending read answer, the failed
 * observation after completion, and the FAILED progress the proof-set Action answers.
 */
export const orderProofAnswers = (state: OrderCommitmentState) => ({
  failed: answered(workText({ intentRef: orderProofPayload.intentRef, stage: 'PROOF', status: 'FAILED' })),
  failedProgress: answered(
    Schema.encodeUnknownSync(Schema.fromJsonString(OrderProofProgressSchema))({
      binding: state.attempt.binding,
      intentRef: orderProofPayload.intentRef,
      revalidationRef: null,
      status: 'FAILED',
      validUntil: null,
    }),
  ),
  pending: answered(
    workText({
      approvalIdempotencyKey: 'approval:original',
      intentRef: orderProofPayload.intentRef,
      pricingIdempotencyKey: 'pricing:proof:original',
      stage: 'PROOF',
      state,
      status: 'PENDING',
      work: pendingOrderPreparationWork.work,
    }),
  ),
});
