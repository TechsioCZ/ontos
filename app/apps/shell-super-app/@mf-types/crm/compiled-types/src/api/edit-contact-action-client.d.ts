import { Effect } from 'effect';
import type { EditContactPayload } from '../../shared/apis/edit-contact-action.ts';
import { operationGateway } from './action-gateway.ts';
export interface EditContactActionRequestOptions {
    readonly baseUrl?: string;
    readonly correlationId: string;
    readonly idempotencyKey: string;
}
export declare const executeEditContactActionWithAuthorization: (payload: EditContactPayload, authorization: string, options: EditContactActionRequestOptions) => Effect.Effect<import("effect/Schema").Struct.ReadonlySide<{
    readonly contactId: import("effect/Schema").String;
    readonly createdAt: import("effect/Schema").String;
    readonly customerId: import("effect/Schema").String;
    readonly customerLabel: import("effect/Schema").String;
    readonly displayName: import("effect/Schema").String;
    readonly email: import("effect/Schema").NullOr<import("effect/Schema").String>;
    readonly firstName: import("effect/Schema").NullOr<import("effect/Schema").String>;
    readonly isPrimaryContact: import("effect/Schema").Boolean;
    readonly jobTitle: import("effect/Schema").NullOr<import("effect/Schema").String>;
    readonly lastName: import("effect/Schema").NullOr<import("effect/Schema").String>;
    readonly phone: import("effect/Schema").NullOr<import("effect/Schema").String>;
    readonly updatedAt: import("effect/Schema").String;
    readonly version: import("effect/Schema").Finite;
}, "Type">, import("effect/unstable/http/HttpClientError").HttpClientError | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditContactValidationProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<400>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditContactAuthenticationProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<401>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditContactForbiddenProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<403>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditContactNotFoundProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<404>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditContactConflictProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<409>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditContactRejectedProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<422>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditContactPreconditionProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<428>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditContactInternalProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<500>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditContactUnavailableProblem">;
    readonly detail: import("effect/Schema").String;
    readonly retryable: import("effect/Schema").Literal<true>;
    readonly status: import("effect/Schema").Literal<503>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").SchemaError, never>;
export declare const makeExecuteEditContactAction: (gateway?: Pick<typeof operationGateway, 'invoke'>) => (payload: EditContactPayload, options: EditContactActionRequestOptions) => Effect.Effect<import("effect/Schema").Struct.ReadonlySide<{
    readonly contactId: import("effect/Schema").String;
    readonly createdAt: import("effect/Schema").String;
    readonly customerId: import("effect/Schema").String;
    readonly customerLabel: import("effect/Schema").String;
    readonly displayName: import("effect/Schema").String;
    readonly email: import("effect/Schema").NullOr<import("effect/Schema").String>;
    readonly firstName: import("effect/Schema").NullOr<import("effect/Schema").String>;
    readonly isPrimaryContact: import("effect/Schema").Boolean;
    readonly jobTitle: import("effect/Schema").NullOr<import("effect/Schema").String>;
    readonly lastName: import("effect/Schema").NullOr<import("effect/Schema").String>;
    readonly phone: import("effect/Schema").NullOr<import("effect/Schema").String>;
    readonly updatedAt: import("effect/Schema").String;
    readonly version: import("effect/Schema").Finite;
}, "Type">, import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditContactValidationProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<400>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditContactAuthenticationProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<401>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditContactForbiddenProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<403>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditContactNotFoundProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<404>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditContactConflictProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<409>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditContactRejectedProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<422>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditContactPreconditionProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<428>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditContactInternalProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<500>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditContactUnavailableProblem">;
    readonly detail: import("effect/Schema").String;
    readonly retryable: import("effect/Schema").Literal<true>;
    readonly status: import("effect/Schema").Literal<503>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("@app/shared-contracts").GatewayContextClientError, never>;
export declare const executeEditContactAction: (payload: EditContactPayload, options: EditContactActionRequestOptions) => Effect.Effect<import("effect/Schema").Struct.ReadonlySide<{
    readonly contactId: import("effect/Schema").String;
    readonly createdAt: import("effect/Schema").String;
    readonly customerId: import("effect/Schema").String;
    readonly customerLabel: import("effect/Schema").String;
    readonly displayName: import("effect/Schema").String;
    readonly email: import("effect/Schema").NullOr<import("effect/Schema").String>;
    readonly firstName: import("effect/Schema").NullOr<import("effect/Schema").String>;
    readonly isPrimaryContact: import("effect/Schema").Boolean;
    readonly jobTitle: import("effect/Schema").NullOr<import("effect/Schema").String>;
    readonly lastName: import("effect/Schema").NullOr<import("effect/Schema").String>;
    readonly phone: import("effect/Schema").NullOr<import("effect/Schema").String>;
    readonly updatedAt: import("effect/Schema").String;
    readonly version: import("effect/Schema").Finite;
}, "Type">, import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditContactValidationProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<400>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditContactAuthenticationProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<401>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditContactForbiddenProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<403>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditContactNotFoundProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<404>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditContactConflictProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<409>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditContactRejectedProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<422>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditContactPreconditionProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<428>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditContactInternalProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<500>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditContactUnavailableProblem">;
    readonly detail: import("effect/Schema").String;
    readonly retryable: import("effect/Schema").Literal<true>;
    readonly status: import("effect/Schema").Literal<503>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("@app/shared-contracts").GatewayContextClientError, never>;
