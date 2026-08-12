import { Schema } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from 'effect/unstable/httpapi';
export declare const EditContactPayloadSchema: Schema.Struct<{
    readonly email: Schema.optionalKey<Schema.String>;
    readonly firstName: Schema.optionalKey<Schema.String>;
    readonly jobTitle: Schema.optionalKey<Schema.String>;
    readonly lastName: Schema.optionalKey<Schema.String>;
    readonly phone: Schema.optionalKey<Schema.String>;
    readonly contactId: Schema.String;
    readonly expectedVersion: Schema.Finite;
}>;
export type EditContactPayload = typeof EditContactPayloadSchema.Type;
export declare const EditContactResultSchema: Schema.Struct<{
    readonly contactId: Schema.String;
    readonly createdAt: Schema.String;
    readonly customerId: Schema.String;
    readonly customerLabel: Schema.String;
    readonly displayName: Schema.String;
    readonly email: Schema.NullOr<Schema.String>;
    readonly firstName: Schema.NullOr<Schema.String>;
    readonly isPrimaryContact: Schema.Boolean;
    readonly jobTitle: Schema.NullOr<Schema.String>;
    readonly lastName: Schema.NullOr<Schema.String>;
    readonly phone: Schema.NullOr<Schema.String>;
    readonly updatedAt: Schema.String;
    readonly version: Schema.Finite;
}>;
export type EditContactResult = typeof EditContactResultSchema.Type;
export declare const EditContactValidationProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"EditContactValidationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<400>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const EditContactAuthenticationProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"EditContactAuthenticationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<401>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const EditContactForbiddenProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"EditContactForbiddenProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<403>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const EditContactNotFoundProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"EditContactNotFoundProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<404>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const EditContactConflictProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"EditContactConflictProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<409>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const EditContactRejectedProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"EditContactRejectedProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<422>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const EditContactPreconditionProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"EditContactPreconditionProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<428>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const EditContactInternalProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"EditContactInternalProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<500>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const EditContactUnavailableProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"EditContactUnavailableProblem">;
    readonly detail: Schema.String;
    readonly retryable: Schema.Literal<true>;
    readonly status: Schema.Literal<503>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const EditContactActionRequestHeadersSchema: Schema.Struct<{
    readonly authorization: Schema.optionalKey<Schema.String>;
    readonly 'x-correlation-id': Schema.NonEmptyString;
    readonly 'x-idempotency-key': Schema.optionalKey<Schema.NonEmptyString>;
}>;
declare const EditContactSchemaErrorMiddleware_base: HttpApiMiddleware.ServiceClass<EditContactSchemaErrorMiddleware, "crm.core/edit-contact/SchemaErrorMiddleware", {
    requires: never;
    provides: never;
    error: Schema.Struct<{
        readonly _tag: Schema.tag<"EditContactValidationProblem">;
        readonly detail: Schema.String;
        readonly status: Schema.Literal<400>;
        readonly title: Schema.String;
        readonly type: Schema.String;
    }>;
    clientError: never;
    requiredForClient: false;
    security: never;
}, HttpApiMiddleware.HttpApiMiddleware<never, Schema.Struct<{
    readonly _tag: Schema.tag<"EditContactValidationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<400>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>, never>>;
export declare class EditContactSchemaErrorMiddleware extends EditContactSchemaErrorMiddleware_base {
}
export declare const EditContactActionApi: HttpApi.HttpApi<"EditContactActionApi", HttpApiGroup.HttpApiGroup<"editContactActions", HttpApiEndpoint.HttpApiEndpoint<"execute", "POST", "/actions/edit-contact", HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.Json<Schema.Struct<{
    readonly email: Schema.optionalKey<Schema.String>;
    readonly firstName: Schema.optionalKey<Schema.String>;
    readonly jobTitle: Schema.optionalKey<Schema.String>;
    readonly lastName: Schema.optionalKey<Schema.String>;
    readonly phone: Schema.optionalKey<Schema.String>;
    readonly contactId: Schema.String;
    readonly expectedVersion: Schema.Finite;
}>>, HttpApiEndpoint.StringTree<Schema.Struct<{
    readonly authorization: Schema.optionalKey<Schema.String>;
    readonly 'x-correlation-id': Schema.NonEmptyString;
    readonly 'x-idempotency-key': Schema.optionalKey<Schema.NonEmptyString>;
}>>, HttpApiEndpoint.Json<Schema.Struct<{
    readonly contactId: Schema.String;
    readonly createdAt: Schema.String;
    readonly customerId: Schema.String;
    readonly customerLabel: Schema.String;
    readonly displayName: Schema.String;
    readonly email: Schema.NullOr<Schema.String>;
    readonly firstName: Schema.NullOr<Schema.String>;
    readonly isPrimaryContact: Schema.Boolean;
    readonly jobTitle: Schema.NullOr<Schema.String>;
    readonly lastName: Schema.NullOr<Schema.String>;
    readonly phone: Schema.NullOr<Schema.String>;
    readonly updatedAt: Schema.String;
    readonly version: Schema.Finite;
}>>, HttpApiEndpoint.Json<Schema.Struct<{
    readonly _tag: Schema.tag<"EditContactValidationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<400>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"EditContactAuthenticationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<401>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"EditContactForbiddenProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<403>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"EditContactNotFoundProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<404>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"EditContactConflictProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<409>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"EditContactRejectedProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<422>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"EditContactPreconditionProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<428>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"EditContactInternalProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<500>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"EditContactUnavailableProblem">;
    readonly detail: Schema.String;
    readonly retryable: Schema.Literal<true>;
    readonly status: Schema.Literal<503>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>>, EditContactSchemaErrorMiddleware, never>, false>>;
export {};
