import { Effect } from 'effect';
import type { EditCustomerPayload } from '../../shared/apis/edit-customer-action.ts';
import { operationGateway } from './action-gateway.ts';
export interface EditCustomerActionRequestOptions {
    readonly baseUrl?: string;
    readonly correlationId: string;
    readonly idempotencyKey: string;
}
export declare const executeEditCustomerActionWithAuthorization: (payload: EditCustomerPayload, authorization: string, options: EditCustomerActionRequestOptions) => Effect.Effect<import("effect/Schema").Struct.ReadonlySide<{
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
    readonly _tag: import("effect/Schema").tag<"EditCustomerValidationProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<400>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditCustomerAuthenticationProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<401>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditCustomerForbiddenProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<403>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditCustomerNotFoundProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<404>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditCustomerConflictProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<409>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditCustomerRejectedProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<422>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditCustomerPreconditionProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<428>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditCustomerInternalProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<500>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditCustomerUnavailableProblem">;
    readonly detail: import("effect/Schema").String;
    readonly retryable: import("effect/Schema").Literal<true>;
    readonly status: import("effect/Schema").Literal<503>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").SchemaError, never>;
export declare const makeExecuteEditCustomerAction: (gateway?: Pick<typeof operationGateway, 'invoke'>) => (payload: EditCustomerPayload, options: EditCustomerActionRequestOptions) => Effect.Effect<import("effect/Schema").Struct.ReadonlySide<{
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
    readonly _tag: import("effect/Schema").tag<"EditCustomerValidationProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<400>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditCustomerAuthenticationProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<401>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditCustomerForbiddenProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<403>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditCustomerNotFoundProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<404>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditCustomerConflictProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<409>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditCustomerRejectedProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<422>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditCustomerPreconditionProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<428>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditCustomerInternalProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<500>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditCustomerUnavailableProblem">;
    readonly detail: import("effect/Schema").String;
    readonly retryable: import("effect/Schema").Literal<true>;
    readonly status: import("effect/Schema").Literal<503>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("@app/shared-contracts").GatewayContextClientError, never>;
export declare const executeEditCustomerAction: (payload: EditCustomerPayload, options: EditCustomerActionRequestOptions) => Effect.Effect<import("effect/Schema").Struct.ReadonlySide<{
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
    readonly _tag: import("effect/Schema").tag<"EditCustomerValidationProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<400>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditCustomerAuthenticationProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<401>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditCustomerForbiddenProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<403>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditCustomerNotFoundProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<404>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditCustomerConflictProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<409>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditCustomerRejectedProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<422>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditCustomerPreconditionProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<428>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditCustomerInternalProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<500>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"EditCustomerUnavailableProblem">;
    readonly detail: import("effect/Schema").String;
    readonly retryable: import("effect/Schema").Literal<true>;
    readonly status: import("effect/Schema").Literal<503>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("@app/shared-contracts").GatewayContextClientError, never>;
