import { Schema } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from 'effect/unstable/httpapi';
export declare const EditCustomerPayloadSchema: Schema.Struct<{
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
    readonly customerId: Schema.String;
    readonly expectedVersion: Schema.Finite;
}>;
export type EditCustomerPayload = typeof EditCustomerPayloadSchema.Type;
export declare const EditCustomerResultSchema: Schema.Struct<{
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
export type EditCustomerResult = typeof EditCustomerResultSchema.Type;
export declare const EditCustomerValidationProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"EditCustomerValidationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<400>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const EditCustomerAuthenticationProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"EditCustomerAuthenticationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<401>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const EditCustomerForbiddenProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"EditCustomerForbiddenProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<403>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const EditCustomerNotFoundProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"EditCustomerNotFoundProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<404>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const EditCustomerConflictProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"EditCustomerConflictProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<409>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const EditCustomerRejectedProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"EditCustomerRejectedProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<422>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const EditCustomerPreconditionProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"EditCustomerPreconditionProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<428>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const EditCustomerInternalProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"EditCustomerInternalProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<500>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const EditCustomerUnavailableProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"EditCustomerUnavailableProblem">;
    readonly detail: Schema.String;
    readonly retryable: Schema.Literal<true>;
    readonly status: Schema.Literal<503>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const EditCustomerActionRequestHeadersSchema: Schema.Struct<{
    readonly authorization: Schema.optionalKey<Schema.String>;
    readonly 'x-correlation-id': Schema.NonEmptyString;
    readonly 'x-idempotency-key': Schema.optionalKey<Schema.NonEmptyString>;
}>;
declare const EditCustomerSchemaErrorMiddleware_base: HttpApiMiddleware.ServiceClass<EditCustomerSchemaErrorMiddleware, "crm.core/edit-customer/SchemaErrorMiddleware", {
    requires: never;
    provides: never;
    error: Schema.Struct<{
        readonly _tag: Schema.tag<"EditCustomerValidationProblem">;
        readonly detail: Schema.String;
        readonly status: Schema.Literal<400>;
        readonly title: Schema.String;
        readonly type: Schema.String;
    }>;
    clientError: never;
    requiredForClient: false;
    security: never;
}, HttpApiMiddleware.HttpApiMiddleware<never, Schema.Struct<{
    readonly _tag: Schema.tag<"EditCustomerValidationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<400>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>, never>>;
export declare class EditCustomerSchemaErrorMiddleware extends EditCustomerSchemaErrorMiddleware_base {
}
export declare const EditCustomerActionApi: HttpApi.HttpApi<"EditCustomerActionApi", HttpApiGroup.HttpApiGroup<"editCustomerActions", HttpApiEndpoint.HttpApiEndpoint<"execute", "POST", "/actions/edit-customer", HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.Json<Schema.Struct<{
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
    readonly customerId: Schema.String;
    readonly expectedVersion: Schema.Finite;
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
    readonly _tag: Schema.tag<"EditCustomerValidationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<400>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"EditCustomerAuthenticationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<401>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"EditCustomerForbiddenProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<403>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"EditCustomerNotFoundProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<404>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"EditCustomerConflictProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<409>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"EditCustomerRejectedProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<422>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"EditCustomerPreconditionProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<428>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"EditCustomerInternalProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<500>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"EditCustomerUnavailableProblem">;
    readonly detail: Schema.String;
    readonly retryable: Schema.Literal<true>;
    readonly status: Schema.Literal<503>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>>, EditCustomerSchemaErrorMiddleware, never>, false>>;
export {};
