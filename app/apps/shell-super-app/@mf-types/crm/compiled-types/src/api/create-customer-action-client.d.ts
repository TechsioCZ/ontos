import { Effect } from 'effect';
import type { CreateCustomerPayload } from '../../shared/apis/create-customer-action.ts';
import { operationGateway } from './action-gateway.ts';
export interface CreateCustomerActionRequestOptions {
    readonly baseUrl?: string;
    readonly correlationId: string;
    readonly idempotencyKey: string;
}
export declare const executeCreateCustomerActionWithAuthorization: (payload: CreateCustomerPayload, authorization: string, options: CreateCustomerActionRequestOptions) => Effect.Effect<import("effect/Schema").Struct.ReadonlySide<{
    readonly address: import("effect/Schema").NullOr<import("effect/Schema").Struct<{
        readonly addressLine1: import("effect/Schema").NullOr<import("effect/Schema").String>;
        readonly addressLine2: import("effect/Schema").NullOr<import("effect/Schema").String>;
        readonly city: import("effect/Schema").NullOr<import("effect/Schema").String>;
        readonly countryCode: import("effect/Schema").NullOr<import("effect/Schema").String>;
        readonly postalCode: import("effect/Schema").NullOr<import("effect/Schema").String>;
        readonly region: import("effect/Schema").NullOr<import("effect/Schema").String>;
    }>>;
    readonly companyRegistrationNumber: import("effect/Schema").NullOr<import("effect/Schema").String>;
    readonly createdAt: import("effect/Schema").String;
    readonly customerId: import("effect/Schema").String;
    readonly email: import("effect/Schema").NullOr<import("effect/Schema").String>;
    readonly name: import("effect/Schema").String;
    readonly phone: import("effect/Schema").NullOr<import("effect/Schema").String>;
    readonly taxIdentificationNumber: import("effect/Schema").NullOr<import("effect/Schema").String>;
    readonly updatedAt: import("effect/Schema").String;
    readonly version: import("effect/Schema").Finite;
    readonly website: import("effect/Schema").NullOr<import("effect/Schema").String>;
}, "Type">, import("effect/unstable/http/HttpClientError").HttpClientError | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateCustomerValidationProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<400>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateCustomerAuthenticationProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<401>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateCustomerForbiddenProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<403>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateCustomerNotFoundProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<404>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateCustomerConflictProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<409>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateCustomerRejectedProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<422>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateCustomerPreconditionProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<428>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateCustomerInternalProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<500>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateCustomerUnavailableProblem">;
    readonly detail: import("effect/Schema").String;
    readonly retryable: import("effect/Schema").Literal<true>;
    readonly status: import("effect/Schema").Literal<503>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").SchemaError, never>;
export declare const makeExecuteCreateCustomerAction: (gateway?: Pick<typeof operationGateway, 'invoke'>) => (payload: CreateCustomerPayload, options: CreateCustomerActionRequestOptions) => Effect.Effect<import("effect/Schema").Struct.ReadonlySide<{
    readonly address: import("effect/Schema").NullOr<import("effect/Schema").Struct<{
        readonly addressLine1: import("effect/Schema").NullOr<import("effect/Schema").String>;
        readonly addressLine2: import("effect/Schema").NullOr<import("effect/Schema").String>;
        readonly city: import("effect/Schema").NullOr<import("effect/Schema").String>;
        readonly countryCode: import("effect/Schema").NullOr<import("effect/Schema").String>;
        readonly postalCode: import("effect/Schema").NullOr<import("effect/Schema").String>;
        readonly region: import("effect/Schema").NullOr<import("effect/Schema").String>;
    }>>;
    readonly companyRegistrationNumber: import("effect/Schema").NullOr<import("effect/Schema").String>;
    readonly createdAt: import("effect/Schema").String;
    readonly customerId: import("effect/Schema").String;
    readonly email: import("effect/Schema").NullOr<import("effect/Schema").String>;
    readonly name: import("effect/Schema").String;
    readonly phone: import("effect/Schema").NullOr<import("effect/Schema").String>;
    readonly taxIdentificationNumber: import("effect/Schema").NullOr<import("effect/Schema").String>;
    readonly updatedAt: import("effect/Schema").String;
    readonly version: import("effect/Schema").Finite;
    readonly website: import("effect/Schema").NullOr<import("effect/Schema").String>;
}, "Type">, import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateCustomerValidationProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<400>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateCustomerAuthenticationProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<401>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateCustomerForbiddenProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<403>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateCustomerNotFoundProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<404>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateCustomerConflictProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<409>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateCustomerRejectedProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<422>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateCustomerPreconditionProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<428>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateCustomerInternalProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<500>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateCustomerUnavailableProblem">;
    readonly detail: import("effect/Schema").String;
    readonly retryable: import("effect/Schema").Literal<true>;
    readonly status: import("effect/Schema").Literal<503>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("@app/shared-contracts").GatewayContextClientError, never>;
export declare const executeCreateCustomerAction: (payload: CreateCustomerPayload, options: CreateCustomerActionRequestOptions) => Effect.Effect<import("effect/Schema").Struct.ReadonlySide<{
    readonly address: import("effect/Schema").NullOr<import("effect/Schema").Struct<{
        readonly addressLine1: import("effect/Schema").NullOr<import("effect/Schema").String>;
        readonly addressLine2: import("effect/Schema").NullOr<import("effect/Schema").String>;
        readonly city: import("effect/Schema").NullOr<import("effect/Schema").String>;
        readonly countryCode: import("effect/Schema").NullOr<import("effect/Schema").String>;
        readonly postalCode: import("effect/Schema").NullOr<import("effect/Schema").String>;
        readonly region: import("effect/Schema").NullOr<import("effect/Schema").String>;
    }>>;
    readonly companyRegistrationNumber: import("effect/Schema").NullOr<import("effect/Schema").String>;
    readonly createdAt: import("effect/Schema").String;
    readonly customerId: import("effect/Schema").String;
    readonly email: import("effect/Schema").NullOr<import("effect/Schema").String>;
    readonly name: import("effect/Schema").String;
    readonly phone: import("effect/Schema").NullOr<import("effect/Schema").String>;
    readonly taxIdentificationNumber: import("effect/Schema").NullOr<import("effect/Schema").String>;
    readonly updatedAt: import("effect/Schema").String;
    readonly version: import("effect/Schema").Finite;
    readonly website: import("effect/Schema").NullOr<import("effect/Schema").String>;
}, "Type">, import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateCustomerValidationProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<400>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateCustomerAuthenticationProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<401>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateCustomerForbiddenProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<403>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateCustomerNotFoundProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<404>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateCustomerConflictProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<409>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateCustomerRejectedProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<422>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateCustomerPreconditionProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<428>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateCustomerInternalProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<500>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CreateCustomerUnavailableProblem">;
    readonly detail: import("effect/Schema").String;
    readonly retryable: import("effect/Schema").Literal<true>;
    readonly status: import("effect/Schema").Literal<503>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("@app/shared-contracts").GatewayContextClientError, never>;
