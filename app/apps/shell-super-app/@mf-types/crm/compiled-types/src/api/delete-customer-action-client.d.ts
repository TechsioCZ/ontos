import { Effect } from 'effect';
import type { DeleteCustomerPayload } from '../../shared/apis/delete-customer-action.ts';
import { operationGateway } from './action-gateway.ts';
export interface DeleteCustomerActionRequestOptions {
    readonly baseUrl?: string;
    readonly correlationId: string;
    readonly idempotencyKey: string;
}
export declare const executeDeleteCustomerActionWithAuthorization: (payload: DeleteCustomerPayload, authorization: string, options: DeleteCustomerActionRequestOptions) => Effect.Effect<import("effect/Schema").Struct.ReadonlySide<{
    readonly customerId: import("effect/Schema").String;
    readonly deletedAt: import("effect/Schema").String;
    readonly version: import("effect/Schema").Finite;
}, "Type">, import("effect/unstable/http/HttpClientError").HttpClientError | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"DeleteCustomerValidationProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<400>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"DeleteCustomerAuthenticationProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<401>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"DeleteCustomerForbiddenProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<403>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"DeleteCustomerNotFoundProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<404>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"DeleteCustomerConflictProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<409>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"DeleteCustomerRejectedProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<422>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"DeleteCustomerPreconditionProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<428>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"DeleteCustomerInternalProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<500>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"DeleteCustomerUnavailableProblem">;
    readonly detail: import("effect/Schema").String;
    readonly retryable: import("effect/Schema").Literal<true>;
    readonly status: import("effect/Schema").Literal<503>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").SchemaError, never>;
export declare const makeExecuteDeleteCustomerAction: (gateway?: Pick<typeof operationGateway, 'invoke'>) => (payload: DeleteCustomerPayload, options: DeleteCustomerActionRequestOptions) => Effect.Effect<import("effect/Schema").Struct.ReadonlySide<{
    readonly customerId: import("effect/Schema").String;
    readonly deletedAt: import("effect/Schema").String;
    readonly version: import("effect/Schema").Finite;
}, "Type">, import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"DeleteCustomerValidationProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<400>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"DeleteCustomerAuthenticationProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<401>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"DeleteCustomerForbiddenProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<403>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"DeleteCustomerNotFoundProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<404>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"DeleteCustomerConflictProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<409>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"DeleteCustomerRejectedProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<422>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"DeleteCustomerPreconditionProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<428>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"DeleteCustomerInternalProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<500>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"DeleteCustomerUnavailableProblem">;
    readonly detail: import("effect/Schema").String;
    readonly retryable: import("effect/Schema").Literal<true>;
    readonly status: import("effect/Schema").Literal<503>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("@app/shared-contracts").GatewayContextClientError, never>;
export declare const executeDeleteCustomerAction: (payload: DeleteCustomerPayload, options: DeleteCustomerActionRequestOptions) => Effect.Effect<import("effect/Schema").Struct.ReadonlySide<{
    readonly customerId: import("effect/Schema").String;
    readonly deletedAt: import("effect/Schema").String;
    readonly version: import("effect/Schema").Finite;
}, "Type">, import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"DeleteCustomerValidationProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<400>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"DeleteCustomerAuthenticationProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<401>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"DeleteCustomerForbiddenProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<403>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"DeleteCustomerNotFoundProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<404>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"DeleteCustomerConflictProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<409>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"DeleteCustomerRejectedProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<422>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"DeleteCustomerPreconditionProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<428>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"DeleteCustomerInternalProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<500>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"DeleteCustomerUnavailableProblem">;
    readonly detail: import("effect/Schema").String;
    readonly retryable: import("effect/Schema").Literal<true>;
    readonly status: import("effect/Schema").Literal<503>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("@app/shared-contracts").GatewayContextClientError, never>;
