import { Schema } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from 'effect/unstable/httpapi';
export declare const ChangeCustomerPrimaryContactPayloadSchema: Schema.Struct<{
    readonly customerId: Schema.String;
    readonly expectedCurrentPrimaryContactId: Schema.NullOr<Schema.String>;
    readonly expectedCurrentPrimaryContactVersion: Schema.NullOr<Schema.Finite>;
    readonly expectedCustomerVersion: Schema.Finite;
    readonly expectedSelectedContactVersion: Schema.NullOr<Schema.Finite>;
    readonly selectedContactId: Schema.NullOr<Schema.String>;
}>;
export type ChangeCustomerPrimaryContactPayload = typeof ChangeCustomerPrimaryContactPayloadSchema.Type;
export declare const ChangeCustomerPrimaryContactResultSchema: Schema.Struct<{
    readonly changedAt: Schema.String;
    readonly customerId: Schema.String;
    readonly customerVersion: Schema.Finite;
    readonly previousPrimaryContactId: Schema.NullOr<Schema.String>;
    readonly previousPrimaryContactVersion: Schema.NullOr<Schema.Finite>;
    readonly primaryContactId: Schema.NullOr<Schema.String>;
    readonly primaryContactVersion: Schema.NullOr<Schema.Finite>;
}>;
export type ChangeCustomerPrimaryContactResult = typeof ChangeCustomerPrimaryContactResultSchema.Type;
export declare const ChangeCustomerPrimaryContactValidationProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"ChangeCustomerPrimaryContactValidationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<400>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const ChangeCustomerPrimaryContactAuthenticationProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"ChangeCustomerPrimaryContactAuthenticationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<401>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const ChangeCustomerPrimaryContactForbiddenProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"ChangeCustomerPrimaryContactForbiddenProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<403>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const ChangeCustomerPrimaryContactNotFoundProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"ChangeCustomerPrimaryContactNotFoundProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<404>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const ChangeCustomerPrimaryContactConflictProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"ChangeCustomerPrimaryContactConflictProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<409>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const ChangeCustomerPrimaryContactRejectedProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"ChangeCustomerPrimaryContactRejectedProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<422>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const ChangeCustomerPrimaryContactPreconditionProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"ChangeCustomerPrimaryContactPreconditionProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<428>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const ChangeCustomerPrimaryContactInternalProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"ChangeCustomerPrimaryContactInternalProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<500>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const ChangeCustomerPrimaryContactUnavailableProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"ChangeCustomerPrimaryContactUnavailableProblem">;
    readonly detail: Schema.String;
    readonly retryable: Schema.Literal<true>;
    readonly status: Schema.Literal<503>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const ChangeCustomerPrimaryContactActionRequestHeadersSchema: Schema.Struct<{
    readonly authorization: Schema.optionalKey<Schema.String>;
    readonly 'x-correlation-id': Schema.NonEmptyString;
    readonly 'x-idempotency-key': Schema.optionalKey<Schema.NonEmptyString>;
}>;
declare const ChangeCustomerPrimaryContactSchemaErrorMiddleware_base: HttpApiMiddleware.ServiceClass<ChangeCustomerPrimaryContactSchemaErrorMiddleware, "crm.core/change-customer-primary-contact/SchemaErrorMiddleware", {
    requires: never;
    provides: never;
    error: Schema.Struct<{
        readonly _tag: Schema.tag<"ChangeCustomerPrimaryContactValidationProblem">;
        readonly detail: Schema.String;
        readonly status: Schema.Literal<400>;
        readonly title: Schema.String;
        readonly type: Schema.String;
    }>;
    clientError: never;
    requiredForClient: false;
    security: never;
}, HttpApiMiddleware.HttpApiMiddleware<never, Schema.Struct<{
    readonly _tag: Schema.tag<"ChangeCustomerPrimaryContactValidationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<400>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>, never>>;
export declare class ChangeCustomerPrimaryContactSchemaErrorMiddleware extends ChangeCustomerPrimaryContactSchemaErrorMiddleware_base {
}
export declare const ChangeCustomerPrimaryContactActionApi: HttpApi.HttpApi<"ChangeCustomerPrimaryContactActionApi", HttpApiGroup.HttpApiGroup<"changeCustomerPrimaryContactActions", HttpApiEndpoint.HttpApiEndpoint<"execute", "POST", "/actions/change-customer-primary-contact", HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.Json<Schema.Struct<{
    readonly customerId: Schema.String;
    readonly expectedCurrentPrimaryContactId: Schema.NullOr<Schema.String>;
    readonly expectedCurrentPrimaryContactVersion: Schema.NullOr<Schema.Finite>;
    readonly expectedCustomerVersion: Schema.Finite;
    readonly expectedSelectedContactVersion: Schema.NullOr<Schema.Finite>;
    readonly selectedContactId: Schema.NullOr<Schema.String>;
}>>, HttpApiEndpoint.StringTree<Schema.Struct<{
    readonly authorization: Schema.optionalKey<Schema.String>;
    readonly 'x-correlation-id': Schema.NonEmptyString;
    readonly 'x-idempotency-key': Schema.optionalKey<Schema.NonEmptyString>;
}>>, HttpApiEndpoint.Json<Schema.Struct<{
    readonly changedAt: Schema.String;
    readonly customerId: Schema.String;
    readonly customerVersion: Schema.Finite;
    readonly previousPrimaryContactId: Schema.NullOr<Schema.String>;
    readonly previousPrimaryContactVersion: Schema.NullOr<Schema.Finite>;
    readonly primaryContactId: Schema.NullOr<Schema.String>;
    readonly primaryContactVersion: Schema.NullOr<Schema.Finite>;
}>>, HttpApiEndpoint.Json<Schema.Struct<{
    readonly _tag: Schema.tag<"ChangeCustomerPrimaryContactValidationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<400>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"ChangeCustomerPrimaryContactAuthenticationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<401>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"ChangeCustomerPrimaryContactForbiddenProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<403>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"ChangeCustomerPrimaryContactNotFoundProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<404>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"ChangeCustomerPrimaryContactConflictProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<409>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"ChangeCustomerPrimaryContactRejectedProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<422>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"ChangeCustomerPrimaryContactPreconditionProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<428>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"ChangeCustomerPrimaryContactInternalProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<500>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"ChangeCustomerPrimaryContactUnavailableProblem">;
    readonly detail: Schema.String;
    readonly retryable: Schema.Literal<true>;
    readonly status: Schema.Literal<503>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>>, ChangeCustomerPrimaryContactSchemaErrorMiddleware, never>, false>>;
export {};
