import { Schema } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from 'effect/unstable/httpapi';
export declare const CreateContactPayloadSchema: Schema.Struct<{
    readonly email: Schema.optionalKey<Schema.String>;
    readonly firstName: Schema.optionalKey<Schema.String>;
    readonly jobTitle: Schema.optionalKey<Schema.String>;
    readonly lastName: Schema.optionalKey<Schema.String>;
    readonly phone: Schema.optionalKey<Schema.String>;
    readonly customerId: Schema.String;
}>;
export type CreateContactPayload = typeof CreateContactPayloadSchema.Type;
export declare const CreateContactResultSchema: Schema.Struct<{
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
export type CreateContactResult = typeof CreateContactResultSchema.Type;
export declare const CreateContactValidationProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"CreateContactValidationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<400>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const CreateContactAuthenticationProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"CreateContactAuthenticationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<401>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const CreateContactForbiddenProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"CreateContactForbiddenProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<403>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const CreateContactNotFoundProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"CreateContactNotFoundProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<404>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const CreateContactConflictProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"CreateContactConflictProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<409>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const CreateContactRejectedProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"CreateContactRejectedProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<422>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const CreateContactPreconditionProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"CreateContactPreconditionProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<428>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const CreateContactInternalProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"CreateContactInternalProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<500>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const CreateContactUnavailableProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"CreateContactUnavailableProblem">;
    readonly detail: Schema.String;
    readonly retryable: Schema.Literal<true>;
    readonly status: Schema.Literal<503>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const CreateContactActionRequestHeadersSchema: Schema.Struct<{
    readonly authorization: Schema.optionalKey<Schema.String>;
    readonly 'x-correlation-id': Schema.NonEmptyString;
    readonly 'x-idempotency-key': Schema.optionalKey<Schema.NonEmptyString>;
}>;
declare const CreateContactSchemaErrorMiddleware_base: HttpApiMiddleware.ServiceClass<CreateContactSchemaErrorMiddleware, "crm.core/create-contact/SchemaErrorMiddleware", {
    requires: never;
    provides: never;
    error: Schema.Struct<{
        readonly _tag: Schema.tag<"CreateContactValidationProblem">;
        readonly detail: Schema.String;
        readonly status: Schema.Literal<400>;
        readonly title: Schema.String;
        readonly type: Schema.String;
    }>;
    clientError: never;
    requiredForClient: false;
    security: never;
}, HttpApiMiddleware.HttpApiMiddleware<never, Schema.Struct<{
    readonly _tag: Schema.tag<"CreateContactValidationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<400>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>, never>>;
export declare class CreateContactSchemaErrorMiddleware extends CreateContactSchemaErrorMiddleware_base {
}
export declare const CreateContactActionApi: HttpApi.HttpApi<"CreateContactActionApi", HttpApiGroup.HttpApiGroup<"createContactActions", HttpApiEndpoint.HttpApiEndpoint<"execute", "POST", "/actions/create-contact", HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.Json<Schema.Struct<{
    readonly email: Schema.optionalKey<Schema.String>;
    readonly firstName: Schema.optionalKey<Schema.String>;
    readonly jobTitle: Schema.optionalKey<Schema.String>;
    readonly lastName: Schema.optionalKey<Schema.String>;
    readonly phone: Schema.optionalKey<Schema.String>;
    readonly customerId: Schema.String;
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
    readonly _tag: Schema.tag<"CreateContactValidationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<400>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"CreateContactAuthenticationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<401>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"CreateContactForbiddenProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<403>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"CreateContactNotFoundProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<404>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"CreateContactConflictProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<409>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"CreateContactRejectedProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<422>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"CreateContactPreconditionProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<428>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"CreateContactInternalProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<500>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"CreateContactUnavailableProblem">;
    readonly detail: Schema.String;
    readonly retryable: Schema.Literal<true>;
    readonly status: Schema.Literal<503>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>>, CreateContactSchemaErrorMiddleware, never>, false>>;
export {};
