import { Schema } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from 'effect/unstable/httpapi';
export declare const CustomerIdSchema: Schema.String;
export declare const CustomerVersionSchema: Schema.Finite;
export declare const ContactIdSchema: Schema.String;
export declare const ContactVersionSchema: Schema.Finite;
export declare const ContactWritableFields: {
    readonly email: Schema.optionalKey<Schema.String>;
    readonly firstName: Schema.optionalKey<Schema.String>;
    readonly jobTitle: Schema.optionalKey<Schema.String>;
    readonly lastName: Schema.optionalKey<Schema.String>;
    readonly phone: Schema.optionalKey<Schema.String>;
};
export declare const ContactFieldsSchema: Schema.Struct<{
    readonly email: Schema.optionalKey<Schema.String>;
    readonly firstName: Schema.optionalKey<Schema.String>;
    readonly jobTitle: Schema.optionalKey<Schema.String>;
    readonly lastName: Schema.optionalKey<Schema.String>;
    readonly phone: Schema.optionalKey<Schema.String>;
}>;
export type ContactFields = typeof ContactFieldsSchema.Type;
export declare const ContactViewSchema: Schema.Struct<{
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
export type ContactView = typeof ContactViewSchema.Type;
export declare const CustomerWritableFields: {
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
};
export declare const CustomerFieldsSchema: Schema.Struct<{
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
export type CustomerFields = typeof CustomerFieldsSchema.Type;
export declare const CustomerAddressSchema: Schema.NullOr<Schema.Struct<{
    readonly addressLine1: Schema.NullOr<Schema.String>;
    readonly addressLine2: Schema.NullOr<Schema.String>;
    readonly city: Schema.NullOr<Schema.String>;
    readonly countryCode: Schema.NullOr<Schema.String>;
    readonly postalCode: Schema.NullOr<Schema.String>;
    readonly region: Schema.NullOr<Schema.String>;
}>>;
export declare const CustomerViewSchema: Schema.Struct<{
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
export type CustomerView = typeof CustomerViewSchema.Type;
export interface DecodedContactCursor {
    readonly contactId: string;
    readonly normalizedFirstName: string;
    readonly normalizedLastName: string;
}
export declare const decodeContactCursorValue: (cursor: string) => DecodedContactCursor | undefined;
export declare const CustomerDirectoryListRequestSchema: Schema.Struct<{
    readonly cursor: Schema.optionalKey<Schema.String>;
    readonly limit: Schema.Finite;
    readonly operation: Schema.Literal<"list">;
}>;
export declare const CustomerDirectoryDetailRequestSchema: Schema.Struct<{
    readonly customerId: Schema.String;
    readonly operation: Schema.Literal<"detail">;
}>;
export declare const CustomerContactListRequestSchema: Schema.Struct<{
    readonly cursor: Schema.optionalKey<Schema.String>;
    readonly customerId: Schema.String;
    readonly limit: Schema.Finite;
    readonly operation: Schema.Literal<"contacts">;
}>;
export declare const CustomerContactDetailRequestSchema: Schema.Struct<{
    readonly contactId: Schema.String;
    readonly operation: Schema.Literal<"contact_detail">;
}>;
export declare const CustomerDirectoryRequestSchema: Schema.Union<readonly [Schema.Struct<{
    readonly cursor: Schema.optionalKey<Schema.String>;
    readonly limit: Schema.Finite;
    readonly operation: Schema.Literal<"list">;
}>, Schema.Struct<{
    readonly customerId: Schema.String;
    readonly operation: Schema.Literal<"detail">;
}>, Schema.Struct<{
    readonly cursor: Schema.optionalKey<Schema.String>;
    readonly customerId: Schema.String;
    readonly limit: Schema.Finite;
    readonly operation: Schema.Literal<"contacts">;
}>, Schema.Struct<{
    readonly contactId: Schema.String;
    readonly operation: Schema.Literal<"contact_detail">;
}>]>;
export type CustomerDirectoryRequest = typeof CustomerDirectoryRequestSchema.Type;
export declare const CustomerDirectoryListResponseSchema: Schema.Struct<{
    readonly items: Schema.$Array<Schema.Struct<{
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
    }>>;
    readonly nextCursor: Schema.NullOr<Schema.String>;
    readonly operation: Schema.Literal<"list">;
}>;
export declare const CustomerDirectoryDetailResponseSchema: Schema.Struct<{
    readonly customer: Schema.Struct<{
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
    readonly operation: Schema.Literal<"detail">;
}>;
export declare const CustomerContactListResponseSchema: Schema.Struct<{
    readonly customerId: Schema.String;
    readonly customerLabel: Schema.String;
    readonly items: Schema.$Array<Schema.Struct<{
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
    }>>;
    readonly nextCursor: Schema.NullOr<Schema.String>;
    readonly operation: Schema.Literal<"contacts">;
}>;
export declare const CustomerContactDetailResponseSchema: Schema.Struct<{
    readonly contact: Schema.Struct<{
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
    readonly operation: Schema.Literal<"contact_detail">;
}>;
export declare const CustomerDirectoryResponseSchema: Schema.Union<readonly [Schema.Struct<{
    readonly items: Schema.$Array<Schema.Struct<{
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
    }>>;
    readonly nextCursor: Schema.NullOr<Schema.String>;
    readonly operation: Schema.Literal<"list">;
}>, Schema.Struct<{
    readonly customer: Schema.Struct<{
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
    readonly operation: Schema.Literal<"detail">;
}>, Schema.Struct<{
    readonly customerId: Schema.String;
    readonly customerLabel: Schema.String;
    readonly items: Schema.$Array<Schema.Struct<{
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
    }>>;
    readonly nextCursor: Schema.NullOr<Schema.String>;
    readonly operation: Schema.Literal<"contacts">;
}>, Schema.Struct<{
    readonly contact: Schema.Struct<{
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
    readonly operation: Schema.Literal<"contact_detail">;
}>]>;
export type CustomerDirectoryResponse = typeof CustomerDirectoryResponseSchema.Type;
export declare const CustomerDirectoryValidationProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerDirectoryValidationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<400>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const CustomerDirectoryAuthenticationProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerDirectoryAuthenticationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<401>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const CustomerDirectoryUnavailableProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerDirectoryUnavailableProblem">;
    readonly detail: Schema.String;
    readonly retryable: Schema.Literal<true>;
    readonly status: Schema.Literal<503>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const CustomerDirectoryForbiddenProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerDirectoryForbiddenProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<403>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const CustomerDirectoryNotFoundProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerDirectoryNotFoundProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<404>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const CustomerDirectoryPolicyProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerDirectoryPolicyProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<422>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const CustomerDirectoryPolicyConflictProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerDirectoryPolicyConflictProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<409>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const CustomerDirectoryInternalProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerDirectoryInternalProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<500>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
declare const CustomerDirectorySchemaErrorMiddleware_base: HttpApiMiddleware.ServiceClass<CustomerDirectorySchemaErrorMiddleware, "crm.core/customer-directory/SchemaErrorMiddleware", {
    requires: never;
    provides: never;
    error: Schema.Struct<{
        readonly _tag: Schema.tag<"CustomerDirectoryValidationProblem">;
        readonly detail: Schema.String;
        readonly status: Schema.Literal<400>;
        readonly title: Schema.String;
        readonly type: Schema.String;
    }>;
    clientError: never;
    requiredForClient: false;
    security: never;
}, HttpApiMiddleware.HttpApiMiddleware<never, Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerDirectoryValidationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<400>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>, never>>;
export declare class CustomerDirectorySchemaErrorMiddleware extends CustomerDirectorySchemaErrorMiddleware_base {
}
export declare const CustomerDirectoryApi: HttpApi.HttpApi<"CustomerDirectoryApi", HttpApiGroup.HttpApiGroup<"reads", HttpApiEndpoint.HttpApiEndpoint<"execute", "POST", "/reads/customer-directory", HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.Json<Schema.Union<readonly [Schema.Struct<{
    readonly cursor: Schema.optionalKey<Schema.String>;
    readonly limit: Schema.Finite;
    readonly operation: Schema.Literal<"list">;
}>, Schema.Struct<{
    readonly customerId: Schema.String;
    readonly operation: Schema.Literal<"detail">;
}>, Schema.Struct<{
    readonly cursor: Schema.optionalKey<Schema.String>;
    readonly customerId: Schema.String;
    readonly limit: Schema.Finite;
    readonly operation: Schema.Literal<"contacts">;
}>, Schema.Struct<{
    readonly contactId: Schema.String;
    readonly operation: Schema.Literal<"contact_detail">;
}>]>>, HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.Json<Schema.Union<readonly [Schema.Struct<{
    readonly items: Schema.$Array<Schema.Struct<{
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
    }>>;
    readonly nextCursor: Schema.NullOr<Schema.String>;
    readonly operation: Schema.Literal<"list">;
}>, Schema.Struct<{
    readonly customer: Schema.Struct<{
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
    readonly operation: Schema.Literal<"detail">;
}>, Schema.Struct<{
    readonly customerId: Schema.String;
    readonly customerLabel: Schema.String;
    readonly items: Schema.$Array<Schema.Struct<{
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
    }>>;
    readonly nextCursor: Schema.NullOr<Schema.String>;
    readonly operation: Schema.Literal<"contacts">;
}>, Schema.Struct<{
    readonly contact: Schema.Struct<{
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
    readonly operation: Schema.Literal<"contact_detail">;
}>]>>, HttpApiEndpoint.Json<Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerDirectoryValidationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<400>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerDirectoryAuthenticationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<401>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerDirectoryUnavailableProblem">;
    readonly detail: Schema.String;
    readonly retryable: Schema.Literal<true>;
    readonly status: Schema.Literal<503>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerDirectoryForbiddenProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<403>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerDirectoryNotFoundProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<404>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerDirectoryPolicyProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<422>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerDirectoryPolicyConflictProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<409>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"CustomerDirectoryInternalProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<500>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>>, CustomerDirectorySchemaErrorMiddleware, never>, false>>;
export {};
