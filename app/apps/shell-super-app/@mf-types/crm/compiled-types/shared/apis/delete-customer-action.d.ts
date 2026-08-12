import { Schema } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from 'effect/unstable/httpapi';
export declare const DeleteCustomerPayloadSchema: Schema.Struct<{
    readonly customerId: Schema.String;
    readonly expectedVersion: Schema.Finite;
}>;
export type DeleteCustomerPayload = typeof DeleteCustomerPayloadSchema.Type;
export declare const DeleteCustomerResultSchema: Schema.Struct<{
    readonly customerId: Schema.String;
    readonly deletedAt: Schema.String;
    readonly version: Schema.Finite;
}>;
export type DeleteCustomerResult = typeof DeleteCustomerResultSchema.Type;
export declare const DeleteCustomerValidationProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteCustomerValidationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<400>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const DeleteCustomerAuthenticationProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteCustomerAuthenticationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<401>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const DeleteCustomerForbiddenProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteCustomerForbiddenProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<403>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const DeleteCustomerNotFoundProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteCustomerNotFoundProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<404>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const DeleteCustomerConflictProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteCustomerConflictProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<409>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const DeleteCustomerRejectedProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteCustomerRejectedProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<422>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const DeleteCustomerPreconditionProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteCustomerPreconditionProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<428>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const DeleteCustomerInternalProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteCustomerInternalProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<500>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const DeleteCustomerUnavailableProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteCustomerUnavailableProblem">;
    readonly detail: Schema.String;
    readonly retryable: Schema.Literal<true>;
    readonly status: Schema.Literal<503>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const DeleteCustomerActionRequestHeadersSchema: Schema.Struct<{
    readonly authorization: Schema.optionalKey<Schema.String>;
    readonly 'x-correlation-id': Schema.NonEmptyString;
    readonly 'x-idempotency-key': Schema.optionalKey<Schema.NonEmptyString>;
}>;
declare const DeleteCustomerSchemaErrorMiddleware_base: HttpApiMiddleware.ServiceClass<DeleteCustomerSchemaErrorMiddleware, "crm.core/delete-customer/SchemaErrorMiddleware", {
    requires: never;
    provides: never;
    error: Schema.Struct<{
        readonly _tag: Schema.tag<"DeleteCustomerValidationProblem">;
        readonly detail: Schema.String;
        readonly status: Schema.Literal<400>;
        readonly title: Schema.String;
        readonly type: Schema.String;
    }>;
    clientError: never;
    requiredForClient: false;
    security: never;
}, HttpApiMiddleware.HttpApiMiddleware<never, Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteCustomerValidationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<400>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>, never>>;
export declare class DeleteCustomerSchemaErrorMiddleware extends DeleteCustomerSchemaErrorMiddleware_base {
}
export declare const DeleteCustomerActionApi: HttpApi.HttpApi<"DeleteCustomerActionApi", HttpApiGroup.HttpApiGroup<"deleteCustomerActions", HttpApiEndpoint.HttpApiEndpoint<"execute", "POST", "/actions/delete-customer", HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.Json<Schema.Struct<{
    readonly customerId: Schema.String;
    readonly expectedVersion: Schema.Finite;
}>>, HttpApiEndpoint.StringTree<Schema.Struct<{
    readonly authorization: Schema.optionalKey<Schema.String>;
    readonly 'x-correlation-id': Schema.NonEmptyString;
    readonly 'x-idempotency-key': Schema.optionalKey<Schema.NonEmptyString>;
}>>, HttpApiEndpoint.Json<Schema.Struct<{
    readonly customerId: Schema.String;
    readonly deletedAt: Schema.String;
    readonly version: Schema.Finite;
}>>, HttpApiEndpoint.Json<Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteCustomerValidationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<400>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteCustomerAuthenticationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<401>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteCustomerForbiddenProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<403>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteCustomerNotFoundProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<404>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteCustomerConflictProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<409>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteCustomerRejectedProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<422>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteCustomerPreconditionProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<428>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteCustomerInternalProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<500>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteCustomerUnavailableProblem">;
    readonly detail: Schema.String;
    readonly retryable: Schema.Literal<true>;
    readonly status: Schema.Literal<503>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>>, DeleteCustomerSchemaErrorMiddleware, never>, false>>;
export {};
