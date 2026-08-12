import { Effect } from 'effect';
import type { CustomerDirectoryRequest } from '../../shared/apis/customer-directory.ts';
export declare const executeCustomerDirectoryWithAuthorization: (payload: CustomerDirectoryRequest, authorization: string, correlationId: string, baseUrl?: string) => Effect.Effect<import("effect/Schema").Struct.ReadonlySide<{
    readonly items: import("effect/Schema").$Array<import("effect/Schema").Struct<{
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
    }>>;
    readonly nextCursor: import("effect/Schema").NullOr<import("effect/Schema").String>;
    readonly operation: import("effect/Schema").Literal<"list">;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly customer: import("effect/Schema").Struct<{
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
    }>;
    readonly operation: import("effect/Schema").Literal<"detail">;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly customerId: import("effect/Schema").String;
    readonly customerLabel: import("effect/Schema").String;
    readonly items: import("effect/Schema").$Array<import("effect/Schema").Struct<{
        readonly contactId: import("effect/Schema").String;
        readonly createdAt: import("effect/Schema").String;
        readonly customerId: import("effect/Schema").String;
        readonly customerLabel: import("effect/Schema").String;
        readonly displayName: import("effect/Schema").String;
        readonly email: import("effect/Schema").NullOr<import("effect/Schema").String>;
        readonly firstName: import("effect/Schema").NullOr<import("effect/Schema").String>;
        readonly isPrimaryContact: import("effect/Schema").Boolean;
        readonly jobTitle: import("effect/Schema").NullOr<import("effect/Schema").String>;
        readonly lastName: import("effect/Schema").NullOr<import("effect/Schema").String>;
        readonly phone: import("effect/Schema").NullOr<import("effect/Schema").String>;
        readonly updatedAt: import("effect/Schema").String;
        readonly version: import("effect/Schema").Finite;
    }>>;
    readonly nextCursor: import("effect/Schema").NullOr<import("effect/Schema").String>;
    readonly operation: import("effect/Schema").Literal<"contacts">;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly contact: import("effect/Schema").Struct<{
        readonly contactId: import("effect/Schema").String;
        readonly createdAt: import("effect/Schema").String;
        readonly customerId: import("effect/Schema").String;
        readonly customerLabel: import("effect/Schema").String;
        readonly displayName: import("effect/Schema").String;
        readonly email: import("effect/Schema").NullOr<import("effect/Schema").String>;
        readonly firstName: import("effect/Schema").NullOr<import("effect/Schema").String>;
        readonly isPrimaryContact: import("effect/Schema").Boolean;
        readonly jobTitle: import("effect/Schema").NullOr<import("effect/Schema").String>;
        readonly lastName: import("effect/Schema").NullOr<import("effect/Schema").String>;
        readonly phone: import("effect/Schema").NullOr<import("effect/Schema").String>;
        readonly updatedAt: import("effect/Schema").String;
        readonly version: import("effect/Schema").Finite;
    }>;
    readonly operation: import("effect/Schema").Literal<"contact_detail">;
}, "Type">, import("effect/unstable/http/HttpClientError").HttpClientError | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CustomerDirectoryValidationProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<400>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CustomerDirectoryAuthenticationProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<401>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CustomerDirectoryForbiddenProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<403>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CustomerDirectoryNotFoundProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<404>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CustomerDirectoryPolicyConflictProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<409>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CustomerDirectoryPolicyProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<422>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CustomerDirectoryUnavailableProblem">;
    readonly detail: import("effect/Schema").String;
    readonly retryable: import("effect/Schema").Literal<true>;
    readonly status: import("effect/Schema").Literal<503>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CustomerDirectoryInternalProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<500>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").SchemaError, never>;
export declare const executeCustomerDirectory: (payload: CustomerDirectoryRequest, correlationId: string) => Effect.Effect<import("effect/Schema").Struct.ReadonlySide<{
    readonly items: import("effect/Schema").$Array<import("effect/Schema").Struct<{
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
    }>>;
    readonly nextCursor: import("effect/Schema").NullOr<import("effect/Schema").String>;
    readonly operation: import("effect/Schema").Literal<"list">;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly customer: import("effect/Schema").Struct<{
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
    }>;
    readonly operation: import("effect/Schema").Literal<"detail">;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly customerId: import("effect/Schema").String;
    readonly customerLabel: import("effect/Schema").String;
    readonly items: import("effect/Schema").$Array<import("effect/Schema").Struct<{
        readonly contactId: import("effect/Schema").String;
        readonly createdAt: import("effect/Schema").String;
        readonly customerId: import("effect/Schema").String;
        readonly customerLabel: import("effect/Schema").String;
        readonly displayName: import("effect/Schema").String;
        readonly email: import("effect/Schema").NullOr<import("effect/Schema").String>;
        readonly firstName: import("effect/Schema").NullOr<import("effect/Schema").String>;
        readonly isPrimaryContact: import("effect/Schema").Boolean;
        readonly jobTitle: import("effect/Schema").NullOr<import("effect/Schema").String>;
        readonly lastName: import("effect/Schema").NullOr<import("effect/Schema").String>;
        readonly phone: import("effect/Schema").NullOr<import("effect/Schema").String>;
        readonly updatedAt: import("effect/Schema").String;
        readonly version: import("effect/Schema").Finite;
    }>>;
    readonly nextCursor: import("effect/Schema").NullOr<import("effect/Schema").String>;
    readonly operation: import("effect/Schema").Literal<"contacts">;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly contact: import("effect/Schema").Struct<{
        readonly contactId: import("effect/Schema").String;
        readonly createdAt: import("effect/Schema").String;
        readonly customerId: import("effect/Schema").String;
        readonly customerLabel: import("effect/Schema").String;
        readonly displayName: import("effect/Schema").String;
        readonly email: import("effect/Schema").NullOr<import("effect/Schema").String>;
        readonly firstName: import("effect/Schema").NullOr<import("effect/Schema").String>;
        readonly isPrimaryContact: import("effect/Schema").Boolean;
        readonly jobTitle: import("effect/Schema").NullOr<import("effect/Schema").String>;
        readonly lastName: import("effect/Schema").NullOr<import("effect/Schema").String>;
        readonly phone: import("effect/Schema").NullOr<import("effect/Schema").String>;
        readonly updatedAt: import("effect/Schema").String;
        readonly version: import("effect/Schema").Finite;
    }>;
    readonly operation: import("effect/Schema").Literal<"contact_detail">;
}, "Type">, import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CustomerDirectoryValidationProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<400>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CustomerDirectoryAuthenticationProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<401>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CustomerDirectoryForbiddenProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<403>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CustomerDirectoryNotFoundProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<404>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CustomerDirectoryPolicyConflictProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<409>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CustomerDirectoryPolicyProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<422>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CustomerDirectoryUnavailableProblem">;
    readonly detail: import("effect/Schema").String;
    readonly retryable: import("effect/Schema").Literal<true>;
    readonly status: import("effect/Schema").Literal<503>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("effect/Schema").Struct.ReadonlySide<{
    readonly _tag: import("effect/Schema").tag<"CustomerDirectoryInternalProblem">;
    readonly detail: import("effect/Schema").String;
    readonly status: import("effect/Schema").Literal<500>;
    readonly title: import("effect/Schema").String;
    readonly type: import("effect/Schema").String;
}, "Type"> | import("@app/shared-contracts").GatewayContextClientError, never>;
