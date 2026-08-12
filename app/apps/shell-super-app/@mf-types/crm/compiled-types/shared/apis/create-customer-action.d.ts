import { Schema } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from 'effect/unstable/httpapi';
export declare const CreateCustomerPayloadSchema: Schema.Struct<{
    readonly address: Schema.optionalKey<Schema.Struct<{
        readonly addressLine1: Schema.optionalKey<Schema.String>;
        readonly addressLine2: Schema.optionalKey<Schema.String>;
        readonly city: Schema.optionalKey<Schema.String>;
        readonly countryCode: Schema.optionalKey<Schema.String>;
        readonly postalCode: Schema.optionalKey<Schema.String>;
        readonly region: Schema.optionalKey<Schema.String>;
    }>>;
    readonly companyRegistrationNumber: Schema.optionalKey<Schema.String>;
    readonly email: Schema.optionalKey<Schema.String>;
    readonly name: Schema.String;
    readonly phone: Schema.optionalKey<Schema.String>;
    readonly taxIdentificationNumber: Schema.optionalKey<Schema.String>;
    readonly website: Schema.optionalKey<Schema.String>;
}>;
export type CreateCustomerPayload = typeof CreateCustomerPayloadSchema.Type;
export declare const CreateCustomerResultSchema: Schema.Struct<{
    readonly address: Schema.NullOr<Schema.Struct<{
        readonly addressLine1: Schema.NullOr<Schema.String>;
        readonly addressLine2: Schema.NullOr<Schema.String>;
        readonly city: Schema.NullOr<Schema.String>;
        readonly countryCode: Schema.NullOr<Schema.String>;
        readonly postalCode: Schema.NullOr<Schema.String>;
        readonly region: Schema.NullOr<Schema.String>;
    }>>;
    readonly companyRegistrationNumber: Schema.NullOr<Schema.String>;
    readonly createdAt: Schema.String;
    readonly customerId: Schema.String;
    readonly email: Schema.NullOr<Schema.String>;
    readonly name: Schema.String;
    readonly phone: Schema.NullOr<Schema.String>;
    readonly taxIdentificationNumber: Schema.NullOr<Schema.String>;
    readonly updatedAt: Schema.String;
    readonly version: Schema.Finite;
    readonly website: Schema.NullOr<Schema.String>;
}>;
export type CreateCustomerResult = typeof CreateCustomerResultSchema.Type;
export declare const CreateCustomerValidationProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"CreateCustomerValidationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<400>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const CreateCustomerAuthenticationProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"CreateCustomerAuthenticationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<401>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const CreateCustomerForbiddenProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"CreateCustomerForbiddenProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<403>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const CreateCustomerNotFoundProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"CreateCustomerNotFoundProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<404>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const CreateCustomerConflictProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"CreateCustomerConflictProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<409>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const CreateCustomerRejectedProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"CreateCustomerRejectedProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<422>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const CreateCustomerPreconditionProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"CreateCustomerPreconditionProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<428>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const CreateCustomerInternalProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"CreateCustomerInternalProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<500>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const CreateCustomerUnavailableProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"CreateCustomerUnavailableProblem">;
    readonly detail: Schema.String;
    readonly retryable: Schema.Literal<true>;
    readonly status: Schema.Literal<503>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const CreateCustomerActionRequestHeadersSchema: Schema.Struct<{
    readonly authorization: Schema.optionalKey<Schema.String>;
    readonly 'x-correlation-id': Schema.NonEmptyString;
    readonly 'x-idempotency-key': Schema.optionalKey<Schema.NonEmptyString>;
}>;
declare const CreateCustomerSchemaErrorMiddleware_base: HttpApiMiddleware.ServiceClass<CreateCustomerSchemaErrorMiddleware, "crm.core/create-customer/SchemaErrorMiddleware", {
    requires: never;
    provides: never;
    error: Schema.Struct<{
        readonly _tag: Schema.tag<"CreateCustomerValidationProblem">;
        readonly detail: Schema.String;
        readonly status: Schema.Literal<400>;
        readonly title: Schema.String;
        readonly type: Schema.String;
    }>;
    clientError: never;
    requiredForClient: false;
    security: never;
}, HttpApiMiddleware.HttpApiMiddleware<never, Schema.Struct<{
    readonly _tag: Schema.tag<"CreateCustomerValidationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<400>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>, never>>;
export declare class CreateCustomerSchemaErrorMiddleware extends CreateCustomerSchemaErrorMiddleware_base {
}
export declare const CreateCustomerActionApi: HttpApi.HttpApi<"CreateCustomerActionApi", HttpApiGroup.HttpApiGroup<"createCustomerActions", HttpApiEndpoint.HttpApiEndpoint<"execute", "POST", "/actions/create-customer", HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.Json<Schema.Struct<{
    readonly address: Schema.optionalKey<Schema.Struct<{
        readonly addressLine1: Schema.optionalKey<Schema.String>;
        readonly addressLine2: Schema.optionalKey<Schema.String>;
        readonly city: Schema.optionalKey<Schema.String>;
        readonly countryCode: Schema.optionalKey<Schema.String>;
        readonly postalCode: Schema.optionalKey<Schema.String>;
        readonly region: Schema.optionalKey<Schema.String>;
    }>>;
    readonly companyRegistrationNumber: Schema.optionalKey<Schema.String>;
    readonly email: Schema.optionalKey<Schema.String>;
    readonly name: Schema.String;
    readonly phone: Schema.optionalKey<Schema.String>;
    readonly taxIdentificationNumber: Schema.optionalKey<Schema.String>;
    readonly website: Schema.optionalKey<Schema.String>;
}>>, HttpApiEndpoint.StringTree<Schema.Struct<{
    readonly authorization: Schema.optionalKey<Schema.String>;
    readonly 'x-correlation-id': Schema.NonEmptyString;
    readonly 'x-idempotency-key': Schema.optionalKey<Schema.NonEmptyString>;
}>>, HttpApiEndpoint.Json<Schema.Struct<{
    readonly address: Schema.NullOr<Schema.Struct<{
        readonly addressLine1: Schema.NullOr<Schema.String>;
        readonly addressLine2: Schema.NullOr<Schema.String>;
        readonly city: Schema.NullOr<Schema.String>;
        readonly countryCode: Schema.NullOr<Schema.String>;
        readonly postalCode: Schema.NullOr<Schema.String>;
        readonly region: Schema.NullOr<Schema.String>;
    }>>;
    readonly companyRegistrationNumber: Schema.NullOr<Schema.String>;
    readonly createdAt: Schema.String;
    readonly customerId: Schema.String;
    readonly email: Schema.NullOr<Schema.String>;
    readonly name: Schema.String;
    readonly phone: Schema.NullOr<Schema.String>;
    readonly taxIdentificationNumber: Schema.NullOr<Schema.String>;
    readonly updatedAt: Schema.String;
    readonly version: Schema.Finite;
    readonly website: Schema.NullOr<Schema.String>;
}>>, HttpApiEndpoint.Json<Schema.Struct<{
    readonly _tag: Schema.tag<"CreateCustomerValidationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<400>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"CreateCustomerAuthenticationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<401>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"CreateCustomerForbiddenProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<403>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"CreateCustomerNotFoundProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<404>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"CreateCustomerConflictProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<409>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"CreateCustomerRejectedProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<422>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"CreateCustomerPreconditionProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<428>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"CreateCustomerInternalProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<500>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"CreateCustomerUnavailableProblem">;
    readonly detail: Schema.String;
    readonly retryable: Schema.Literal<true>;
    readonly status: Schema.Literal<503>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>>, CreateCustomerSchemaErrorMiddleware, never>, false>>;
export {};
