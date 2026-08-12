import { Effect } from 'effect';
import type { CreateContactPayload } from '../../shared/apis/create-contact-action.ts';
import { operationGateway } from './action-gateway.ts';
export interface CreateContactActionRequestOptions {
    readonly baseUrl?: string;
    readonly correlationId: string;
    readonly idempotencyKey: string;
}
export declare const executeCreateContactActionWithAuthorization: (payload: CreateContactPayload, authorization: string, options: CreateContactActionRequestOptions) => Effect.Effect<import("effect/Schema").Struct.ReadonlySide<{
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
    readonly _tag: import("effect/Schema").tag<"CreateContactValidationProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<400>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateContactAuthenticationProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<401>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateContactForbiddenProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<403>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateContactNotFoundProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<404>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateContactConflictProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<409>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateContactRejectedProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<422>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateContactPreconditionProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<428>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateContactInternalProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<500>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateContactUnavailableProblem">;
    readonly detail: import("effect/Schema").String;
    readonly retryable: import("effect/Schema").Literal<true>;
    readonly status: import("effect/Schema").Literal<503>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").SchemaError, never>;
export declare const makeExecuteCreateContactAction: (gateway?: Pick<typeof operationGateway, 'invoke'>) => (payload: CreateContactPayload, options: CreateContactActionRequestOptions) => Effect.Effect<import("effect/Schema").Struct.ReadonlySide<{
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
    readonly _tag: import("effect/Schema").tag<"CreateContactValidationProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<400>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateContactAuthenticationProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<401>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateContactForbiddenProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<403>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateContactNotFoundProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<404>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateContactConflictProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<409>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateContactRejectedProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<422>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateContactPreconditionProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<428>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateContactInternalProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<500>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateContactUnavailableProblem">;
    readonly detail: import("effect/Schema").String;
    readonly retryable: import("effect/Schema").Literal<true>;
    readonly status: import("effect/Schema").Literal<503>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("@app/shared-contracts").GatewayContextClientError, never>;
export declare const executeCreateContactAction: (payload: CreateContactPayload, options: CreateContactActionRequestOptions) => Effect.Effect<import("effect/Schema").Struct.ReadonlySide<{
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
    readonly _tag: import("effect/Schema").tag<"CreateContactValidationProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<400>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateContactAuthenticationProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<401>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateContactForbiddenProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<403>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateContactNotFoundProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<404>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateContactConflictProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<409>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateContactRejectedProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<422>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateContactPreconditionProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<428>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateContactInternalProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<500>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateContactUnavailableProblem">;
    readonly detail: import("effect/Schema").String;
    readonly retryable: import("effect/Schema").Literal<true>;
    readonly status: import("effect/Schema").Literal<503>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("@app/shared-contracts").GatewayContextClientError, never>;
