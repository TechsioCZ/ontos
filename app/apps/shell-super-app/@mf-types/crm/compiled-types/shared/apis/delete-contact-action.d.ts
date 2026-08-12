import { Schema } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from 'effect/unstable/httpapi';
export declare const DeleteContactPayloadSchema: Schema.Struct<{
    readonly contactId: Schema.String;
    readonly expectedVersion: Schema.Finite;
}>;
export type DeleteContactPayload = typeof DeleteContactPayloadSchema.Type;
export declare const DeleteContactResultSchema: Schema.Struct<{
    readonly contactId: Schema.String;
    readonly customerId: Schema.String;
    readonly customerLabel: Schema.String;
    readonly deletedAt: Schema.String;
    readonly version: Schema.Finite;
}>;
export type DeleteContactResult = typeof DeleteContactResultSchema.Type;
export declare const DeleteContactValidationProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteContactValidationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<400>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const DeleteContactAuthenticationProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteContactAuthenticationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<401>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const DeleteContactForbiddenProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteContactForbiddenProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<403>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const DeleteContactNotFoundProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteContactNotFoundProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<404>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const DeleteContactConflictProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteContactConflictProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<409>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const DeleteContactRejectedProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteContactRejectedProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<422>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const DeleteContactPreconditionProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteContactPreconditionProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<428>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const DeleteContactInternalProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteContactInternalProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<500>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const DeleteContactUnavailableProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteContactUnavailableProblem">;
    readonly detail: Schema.String;
    readonly retryable: Schema.Literal<true>;
    readonly status: Schema.Literal<503>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const DeleteContactActionRequestHeadersSchema: Schema.Struct<{
    readonly authorization: Schema.optionalKey<Schema.String>;
    readonly 'x-correlation-id': Schema.NonEmptyString;
    readonly 'x-idempotency-key': Schema.optionalKey<Schema.NonEmptyString>;
}>;
declare const DeleteContactSchemaErrorMiddleware_base: HttpApiMiddleware.ServiceClass<DeleteContactSchemaErrorMiddleware, "crm.core/delete-contact/SchemaErrorMiddleware", {
    requires: never;
    provides: never;
    error: Schema.Struct<{
        readonly _tag: Schema.tag<"DeleteContactValidationProblem">;
        readonly detail: Schema.String;
        readonly status: Schema.Literal<400>;
        readonly title: Schema.String;
        readonly type: Schema.String;
    }>;
    clientError: never;
    requiredForClient: false;
    security: never;
}, HttpApiMiddleware.HttpApiMiddleware<never, Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteContactValidationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<400>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>, never>>;
export declare class DeleteContactSchemaErrorMiddleware extends DeleteContactSchemaErrorMiddleware_base {
}
export declare const DeleteContactActionApi: HttpApi.HttpApi<"DeleteContactActionApi", HttpApiGroup.HttpApiGroup<"deleteContactActions", HttpApiEndpoint.HttpApiEndpoint<"execute", "POST", "/actions/delete-contact", HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.Json<Schema.Struct<{
    readonly contactId: Schema.String;
    readonly expectedVersion: Schema.Finite;
}>>, HttpApiEndpoint.StringTree<Schema.Struct<{
    readonly authorization: Schema.optionalKey<Schema.String>;
    readonly 'x-correlation-id': Schema.NonEmptyString;
    readonly 'x-idempotency-key': Schema.optionalKey<Schema.NonEmptyString>;
}>>, HttpApiEndpoint.Json<Schema.Struct<{
    readonly contactId: Schema.String;
    readonly customerId: Schema.String;
    readonly customerLabel: Schema.String;
    readonly deletedAt: Schema.String;
    readonly version: Schema.Finite;
}>>, HttpApiEndpoint.Json<Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteContactValidationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<400>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteContactAuthenticationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<401>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteContactForbiddenProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<403>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteContactNotFoundProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<404>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteContactConflictProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<409>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteContactRejectedProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<422>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteContactPreconditionProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<428>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteContactInternalProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<500>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"DeleteContactUnavailableProblem">;
    readonly detail: Schema.String;
    readonly retryable: Schema.Literal<true>;
    readonly status: Schema.Literal<503>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>>, DeleteContactSchemaErrorMiddleware, never>, false>>;
export {};
