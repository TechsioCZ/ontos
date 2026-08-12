import { Schema } from 'effect';
import { HttpApi, HttpApiEndpoint, HttpApiGroup, HttpApiMiddleware } from 'effect/unstable/httpapi';
export declare const DealIdSchema: Schema.String;
export declare const DealVersionSchema: Schema.Finite;
export declare const DealStatusSchema: Schema.Literals<readonly ["New", "Qualified", "Offer sent", "Negotiation", "Won", "Lost"]>;
export type DealStatus = typeof DealStatusSchema.Type;
export declare const DealExpectedValueSchema: Schema.Finite;
export declare const DealCurrencySchema: Schema.Literals<readonly ["AED", "AFN", "ALL", "AMD", "AOA", "ARS", "AUD", "AWG", "AZN", "BAM", "BBD", "BDT", "BHD", "BIF", "BMD", "BND", "BOB", "BOV", "BRL", "BSD", "BTN", "BWP", "BYN", "BZD", "CAD", "CDF", "CHE", "CHF", "CHW", "CLF", "CLP", "CNY", "COP", "COU", "CRC", "CUP", "CVE", "CZK", "DJF", "DKK", "DOP", "DZD", "EGP", "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL", "GHS", "GIP", "GMD", "GNF", "GTQ", "GYD", "HKD", "HNL", "HTG", "HUF", "IDR", "ILS", "INR", "IQD", "IRR", "ISK", "JMD", "JOD", "JPY", "KES", "KGS", "KHR", "KMF", "KPW", "KRW", "KWD", "KYD", "KZT", "LAK", "LBP", "LKR", "LRD", "LSL", "LYD", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MRU", "MUR", "MVR", "MWK", "MXN", "MXV", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR", "NZD", "OMR", "PAB", "PEN", "PGK", "PHP", "PKR", "PLN", "PYG", "QAR", "RON", "RSD", "RUB", "RWF", "SAR", "SBD", "SCR", "SDG", "SEK", "SGD", "SHP", "SLE", "SOS", "SRD", "SSP", "STN", "SVC", "SYP", "SZL", "THB", "TJS", "TMT", "TND", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH", "UGX", "USD", "USN", "UYI", "UYU", "UYW", "UZS", "VED", "VES", "VND", "VUV", "WST", "XAD", "XAF", "XAG", "XAU", "XBA", "XBB", "XBC", "XBD", "XCD", "XCG", "XDR", "XOF", "XPD", "XPF", "XPT", "XSU", "XTS", "XUA", "XXX", "YER", "ZAR", "ZMW", "ZWG"]>;
export declare const DealExpectedCloseDateSchema: Schema.String;
export declare const DealWritableFields: {
    readonly contactId: Schema.optionalKey<Schema.NullOr<Schema.String>>;
    readonly currency: Schema.Literals<readonly ["AED", "AFN", "ALL", "AMD", "AOA", "ARS", "AUD", "AWG", "AZN", "BAM", "BBD", "BDT", "BHD", "BIF", "BMD", "BND", "BOB", "BOV", "BRL", "BSD", "BTN", "BWP", "BYN", "BZD", "CAD", "CDF", "CHE", "CHF", "CHW", "CLF", "CLP", "CNY", "COP", "COU", "CRC", "CUP", "CVE", "CZK", "DJF", "DKK", "DOP", "DZD", "EGP", "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL", "GHS", "GIP", "GMD", "GNF", "GTQ", "GYD", "HKD", "HNL", "HTG", "HUF", "IDR", "ILS", "INR", "IQD", "IRR", "ISK", "JMD", "JOD", "JPY", "KES", "KGS", "KHR", "KMF", "KPW", "KRW", "KWD", "KYD", "KZT", "LAK", "LBP", "LKR", "LRD", "LSL", "LYD", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MRU", "MUR", "MVR", "MWK", "MXN", "MXV", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR", "NZD", "OMR", "PAB", "PEN", "PGK", "PHP", "PKR", "PLN", "PYG", "QAR", "RON", "RSD", "RUB", "RWF", "SAR", "SBD", "SCR", "SDG", "SEK", "SGD", "SHP", "SLE", "SOS", "SRD", "SSP", "STN", "SVC", "SYP", "SZL", "THB", "TJS", "TMT", "TND", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH", "UGX", "USD", "USN", "UYI", "UYU", "UYW", "UZS", "VED", "VES", "VND", "VUV", "WST", "XAD", "XAF", "XAG", "XAU", "XBA", "XBB", "XBC", "XBD", "XCD", "XCG", "XDR", "XOF", "XPD", "XPF", "XPT", "XSU", "XTS", "XUA", "XXX", "YER", "ZAR", "ZMW", "ZWG"]>;
    readonly customerId: Schema.String;
    readonly description: Schema.optionalKey<Schema.String>;
    readonly expectedCloseDate: Schema.optionalKey<Schema.NullOr<Schema.String>>;
    readonly expectedValue: Schema.Finite;
    readonly title: Schema.String;
};
export declare const DealFieldsSchema: Schema.Struct<{
    readonly contactId: Schema.optionalKey<Schema.NullOr<Schema.String>>;
    readonly currency: Schema.Literals<readonly ["AED", "AFN", "ALL", "AMD", "AOA", "ARS", "AUD", "AWG", "AZN", "BAM", "BBD", "BDT", "BHD", "BIF", "BMD", "BND", "BOB", "BOV", "BRL", "BSD", "BTN", "BWP", "BYN", "BZD", "CAD", "CDF", "CHE", "CHF", "CHW", "CLF", "CLP", "CNY", "COP", "COU", "CRC", "CUP", "CVE", "CZK", "DJF", "DKK", "DOP", "DZD", "EGP", "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL", "GHS", "GIP", "GMD", "GNF", "GTQ", "GYD", "HKD", "HNL", "HTG", "HUF", "IDR", "ILS", "INR", "IQD", "IRR", "ISK", "JMD", "JOD", "JPY", "KES", "KGS", "KHR", "KMF", "KPW", "KRW", "KWD", "KYD", "KZT", "LAK", "LBP", "LKR", "LRD", "LSL", "LYD", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MRU", "MUR", "MVR", "MWK", "MXN", "MXV", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR", "NZD", "OMR", "PAB", "PEN", "PGK", "PHP", "PKR", "PLN", "PYG", "QAR", "RON", "RSD", "RUB", "RWF", "SAR", "SBD", "SCR", "SDG", "SEK", "SGD", "SHP", "SLE", "SOS", "SRD", "SSP", "STN", "SVC", "SYP", "SZL", "THB", "TJS", "TMT", "TND", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH", "UGX", "USD", "USN", "UYI", "UYU", "UYW", "UZS", "VED", "VES", "VND", "VUV", "WST", "XAD", "XAF", "XAG", "XAU", "XBA", "XBB", "XBC", "XBD", "XCD", "XCG", "XDR", "XOF", "XPD", "XPF", "XPT", "XSU", "XTS", "XUA", "XXX", "YER", "ZAR", "ZMW", "ZWG"]>;
    readonly customerId: Schema.String;
    readonly description: Schema.optionalKey<Schema.String>;
    readonly expectedCloseDate: Schema.optionalKey<Schema.NullOr<Schema.String>>;
    readonly expectedValue: Schema.Finite;
    readonly title: Schema.String;
}>;
export type DealFields = typeof DealFieldsSchema.Type;
export declare const DealViewSchema: Schema.Struct<{
    readonly contactId: Schema.NullOr<Schema.String>;
    readonly contactLabel: Schema.NullOr<Schema.String>;
    readonly createdAt: Schema.String;
    readonly currency: Schema.Literals<readonly ["AED", "AFN", "ALL", "AMD", "AOA", "ARS", "AUD", "AWG", "AZN", "BAM", "BBD", "BDT", "BHD", "BIF", "BMD", "BND", "BOB", "BOV", "BRL", "BSD", "BTN", "BWP", "BYN", "BZD", "CAD", "CDF", "CHE", "CHF", "CHW", "CLF", "CLP", "CNY", "COP", "COU", "CRC", "CUP", "CVE", "CZK", "DJF", "DKK", "DOP", "DZD", "EGP", "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL", "GHS", "GIP", "GMD", "GNF", "GTQ", "GYD", "HKD", "HNL", "HTG", "HUF", "IDR", "ILS", "INR", "IQD", "IRR", "ISK", "JMD", "JOD", "JPY", "KES", "KGS", "KHR", "KMF", "KPW", "KRW", "KWD", "KYD", "KZT", "LAK", "LBP", "LKR", "LRD", "LSL", "LYD", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MRU", "MUR", "MVR", "MWK", "MXN", "MXV", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR", "NZD", "OMR", "PAB", "PEN", "PGK", "PHP", "PKR", "PLN", "PYG", "QAR", "RON", "RSD", "RUB", "RWF", "SAR", "SBD", "SCR", "SDG", "SEK", "SGD", "SHP", "SLE", "SOS", "SRD", "SSP", "STN", "SVC", "SYP", "SZL", "THB", "TJS", "TMT", "TND", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH", "UGX", "USD", "USN", "UYI", "UYU", "UYW", "UZS", "VED", "VES", "VND", "VUV", "WST", "XAD", "XAF", "XAG", "XAU", "XBA", "XBB", "XBC", "XBD", "XCD", "XCG", "XDR", "XOF", "XPD", "XPF", "XPT", "XSU", "XTS", "XUA", "XXX", "YER", "ZAR", "ZMW", "ZWG"]>;
    readonly customerId: Schema.String;
    readonly customerLabel: Schema.String;
    readonly dealId: Schema.String;
    readonly description: Schema.NullOr<Schema.String>;
    readonly expectedCloseDate: Schema.NullOr<Schema.String>;
    readonly expectedValue: Schema.Finite;
    readonly status: Schema.Literals<readonly ["New", "Qualified", "Offer sent", "Negotiation", "Won", "Lost"]>;
    readonly title: Schema.String;
    readonly updatedAt: Schema.String;
    readonly version: Schema.Finite;
}>;
export type DealView = typeof DealViewSchema.Type;
export interface DecodedDealCursor {
    readonly dealId: string;
    readonly updatedAt: string;
}
export declare const decodeDealCursorValue: (cursor: string) => DecodedDealCursor | undefined;
export declare const DealWorkspaceListRequestSchema: Schema.Struct<{
    readonly cursor: Schema.optionalKey<Schema.String>;
    readonly customerId: Schema.optionalKey<Schema.String>;
    readonly limit: Schema.Finite;
    readonly operation: Schema.Literal<"list">;
}>;
export declare const DealWorkspaceDetailRequestSchema: Schema.Struct<{
    readonly dealId: Schema.String;
    readonly operation: Schema.Literal<"detail">;
}>;
export declare const DealWorkspaceRequestSchema: Schema.Union<readonly [Schema.Struct<{
    readonly cursor: Schema.optionalKey<Schema.String>;
    readonly customerId: Schema.optionalKey<Schema.String>;
    readonly limit: Schema.Finite;
    readonly operation: Schema.Literal<"list">;
}>, Schema.Struct<{
    readonly dealId: Schema.String;
    readonly operation: Schema.Literal<"detail">;
}>]>;
export type DealWorkspaceRequest = typeof DealWorkspaceRequestSchema.Type;
export declare const DealWorkspaceListResponseSchema: Schema.Struct<{
    readonly items: Schema.$Array<Schema.Struct<{
        readonly contactId: Schema.NullOr<Schema.String>;
        readonly contactLabel: Schema.NullOr<Schema.String>;
        readonly createdAt: Schema.String;
        readonly currency: Schema.Literals<readonly ["AED", "AFN", "ALL", "AMD", "AOA", "ARS", "AUD", "AWG", "AZN", "BAM", "BBD", "BDT", "BHD", "BIF", "BMD", "BND", "BOB", "BOV", "BRL", "BSD", "BTN", "BWP", "BYN", "BZD", "CAD", "CDF", "CHE", "CHF", "CHW", "CLF", "CLP", "CNY", "COP", "COU", "CRC", "CUP", "CVE", "CZK", "DJF", "DKK", "DOP", "DZD", "EGP", "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL", "GHS", "GIP", "GMD", "GNF", "GTQ", "GYD", "HKD", "HNL", "HTG", "HUF", "IDR", "ILS", "INR", "IQD", "IRR", "ISK", "JMD", "JOD", "JPY", "KES", "KGS", "KHR", "KMF", "KPW", "KRW", "KWD", "KYD", "KZT", "LAK", "LBP", "LKR", "LRD", "LSL", "LYD", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MRU", "MUR", "MVR", "MWK", "MXN", "MXV", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR", "NZD", "OMR", "PAB", "PEN", "PGK", "PHP", "PKR", "PLN", "PYG", "QAR", "RON", "RSD", "RUB", "RWF", "SAR", "SBD", "SCR", "SDG", "SEK", "SGD", "SHP", "SLE", "SOS", "SRD", "SSP", "STN", "SVC", "SYP", "SZL", "THB", "TJS", "TMT", "TND", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH", "UGX", "USD", "USN", "UYI", "UYU", "UYW", "UZS", "VED", "VES", "VND", "VUV", "WST", "XAD", "XAF", "XAG", "XAU", "XBA", "XBB", "XBC", "XBD", "XCD", "XCG", "XDR", "XOF", "XPD", "XPF", "XPT", "XSU", "XTS", "XUA", "XXX", "YER", "ZAR", "ZMW", "ZWG"]>;
        readonly customerId: Schema.String;
        readonly customerLabel: Schema.String;
        readonly dealId: Schema.String;
        readonly description: Schema.NullOr<Schema.String>;
        readonly expectedCloseDate: Schema.NullOr<Schema.String>;
        readonly expectedValue: Schema.Finite;
        readonly status: Schema.Literals<readonly ["New", "Qualified", "Offer sent", "Negotiation", "Won", "Lost"]>;
        readonly title: Schema.String;
        readonly updatedAt: Schema.String;
        readonly version: Schema.Finite;
    }>>;
    readonly nextCursor: Schema.NullOr<Schema.String>;
    readonly operation: Schema.Literal<"list">;
}>;
export declare const DealWorkspaceDetailResponseSchema: Schema.Struct<{
    readonly deal: Schema.Struct<{
        readonly contactId: Schema.NullOr<Schema.String>;
        readonly contactLabel: Schema.NullOr<Schema.String>;
        readonly createdAt: Schema.String;
        readonly currency: Schema.Literals<readonly ["AED", "AFN", "ALL", "AMD", "AOA", "ARS", "AUD", "AWG", "AZN", "BAM", "BBD", "BDT", "BHD", "BIF", "BMD", "BND", "BOB", "BOV", "BRL", "BSD", "BTN", "BWP", "BYN", "BZD", "CAD", "CDF", "CHE", "CHF", "CHW", "CLF", "CLP", "CNY", "COP", "COU", "CRC", "CUP", "CVE", "CZK", "DJF", "DKK", "DOP", "DZD", "EGP", "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL", "GHS", "GIP", "GMD", "GNF", "GTQ", "GYD", "HKD", "HNL", "HTG", "HUF", "IDR", "ILS", "INR", "IQD", "IRR", "ISK", "JMD", "JOD", "JPY", "KES", "KGS", "KHR", "KMF", "KPW", "KRW", "KWD", "KYD", "KZT", "LAK", "LBP", "LKR", "LRD", "LSL", "LYD", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MRU", "MUR", "MVR", "MWK", "MXN", "MXV", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR", "NZD", "OMR", "PAB", "PEN", "PGK", "PHP", "PKR", "PLN", "PYG", "QAR", "RON", "RSD", "RUB", "RWF", "SAR", "SBD", "SCR", "SDG", "SEK", "SGD", "SHP", "SLE", "SOS", "SRD", "SSP", "STN", "SVC", "SYP", "SZL", "THB", "TJS", "TMT", "TND", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH", "UGX", "USD", "USN", "UYI", "UYU", "UYW", "UZS", "VED", "VES", "VND", "VUV", "WST", "XAD", "XAF", "XAG", "XAU", "XBA", "XBB", "XBC", "XBD", "XCD", "XCG", "XDR", "XOF", "XPD", "XPF", "XPT", "XSU", "XTS", "XUA", "XXX", "YER", "ZAR", "ZMW", "ZWG"]>;
        readonly customerId: Schema.String;
        readonly customerLabel: Schema.String;
        readonly dealId: Schema.String;
        readonly description: Schema.NullOr<Schema.String>;
        readonly expectedCloseDate: Schema.NullOr<Schema.String>;
        readonly expectedValue: Schema.Finite;
        readonly status: Schema.Literals<readonly ["New", "Qualified", "Offer sent", "Negotiation", "Won", "Lost"]>;
        readonly title: Schema.String;
        readonly updatedAt: Schema.String;
        readonly version: Schema.Finite;
    }>;
    readonly operation: Schema.Literal<"detail">;
}>;
export declare const DealWorkspaceResponseSchema: Schema.Union<readonly [Schema.Struct<{
    readonly items: Schema.$Array<Schema.Struct<{
        readonly contactId: Schema.NullOr<Schema.String>;
        readonly contactLabel: Schema.NullOr<Schema.String>;
        readonly createdAt: Schema.String;
        readonly currency: Schema.Literals<readonly ["AED", "AFN", "ALL", "AMD", "AOA", "ARS", "AUD", "AWG", "AZN", "BAM", "BBD", "BDT", "BHD", "BIF", "BMD", "BND", "BOB", "BOV", "BRL", "BSD", "BTN", "BWP", "BYN", "BZD", "CAD", "CDF", "CHE", "CHF", "CHW", "CLF", "CLP", "CNY", "COP", "COU", "CRC", "CUP", "CVE", "CZK", "DJF", "DKK", "DOP", "DZD", "EGP", "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL", "GHS", "GIP", "GMD", "GNF", "GTQ", "GYD", "HKD", "HNL", "HTG", "HUF", "IDR", "ILS", "INR", "IQD", "IRR", "ISK", "JMD", "JOD", "JPY", "KES", "KGS", "KHR", "KMF", "KPW", "KRW", "KWD", "KYD", "KZT", "LAK", "LBP", "LKR", "LRD", "LSL", "LYD", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MRU", "MUR", "MVR", "MWK", "MXN", "MXV", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR", "NZD", "OMR", "PAB", "PEN", "PGK", "PHP", "PKR", "PLN", "PYG", "QAR", "RON", "RSD", "RUB", "RWF", "SAR", "SBD", "SCR", "SDG", "SEK", "SGD", "SHP", "SLE", "SOS", "SRD", "SSP", "STN", "SVC", "SYP", "SZL", "THB", "TJS", "TMT", "TND", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH", "UGX", "USD", "USN", "UYI", "UYU", "UYW", "UZS", "VED", "VES", "VND", "VUV", "WST", "XAD", "XAF", "XAG", "XAU", "XBA", "XBB", "XBC", "XBD", "XCD", "XCG", "XDR", "XOF", "XPD", "XPF", "XPT", "XSU", "XTS", "XUA", "XXX", "YER", "ZAR", "ZMW", "ZWG"]>;
        readonly customerId: Schema.String;
        readonly customerLabel: Schema.String;
        readonly dealId: Schema.String;
        readonly description: Schema.NullOr<Schema.String>;
        readonly expectedCloseDate: Schema.NullOr<Schema.String>;
        readonly expectedValue: Schema.Finite;
        readonly status: Schema.Literals<readonly ["New", "Qualified", "Offer sent", "Negotiation", "Won", "Lost"]>;
        readonly title: Schema.String;
        readonly updatedAt: Schema.String;
        readonly version: Schema.Finite;
    }>>;
    readonly nextCursor: Schema.NullOr<Schema.String>;
    readonly operation: Schema.Literal<"list">;
}>, Schema.Struct<{
    readonly deal: Schema.Struct<{
        readonly contactId: Schema.NullOr<Schema.String>;
        readonly contactLabel: Schema.NullOr<Schema.String>;
        readonly createdAt: Schema.String;
        readonly currency: Schema.Literals<readonly ["AED", "AFN", "ALL", "AMD", "AOA", "ARS", "AUD", "AWG", "AZN", "BAM", "BBD", "BDT", "BHD", "BIF", "BMD", "BND", "BOB", "BOV", "BRL", "BSD", "BTN", "BWP", "BYN", "BZD", "CAD", "CDF", "CHE", "CHF", "CHW", "CLF", "CLP", "CNY", "COP", "COU", "CRC", "CUP", "CVE", "CZK", "DJF", "DKK", "DOP", "DZD", "EGP", "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL", "GHS", "GIP", "GMD", "GNF", "GTQ", "GYD", "HKD", "HNL", "HTG", "HUF", "IDR", "ILS", "INR", "IQD", "IRR", "ISK", "JMD", "JOD", "JPY", "KES", "KGS", "KHR", "KMF", "KPW", "KRW", "KWD", "KYD", "KZT", "LAK", "LBP", "LKR", "LRD", "LSL", "LYD", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MRU", "MUR", "MVR", "MWK", "MXN", "MXV", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR", "NZD", "OMR", "PAB", "PEN", "PGK", "PHP", "PKR", "PLN", "PYG", "QAR", "RON", "RSD", "RUB", "RWF", "SAR", "SBD", "SCR", "SDG", "SEK", "SGD", "SHP", "SLE", "SOS", "SRD", "SSP", "STN", "SVC", "SYP", "SZL", "THB", "TJS", "TMT", "TND", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH", "UGX", "USD", "USN", "UYI", "UYU", "UYW", "UZS", "VED", "VES", "VND", "VUV", "WST", "XAD", "XAF", "XAG", "XAU", "XBA", "XBB", "XBC", "XBD", "XCD", "XCG", "XDR", "XOF", "XPD", "XPF", "XPT", "XSU", "XTS", "XUA", "XXX", "YER", "ZAR", "ZMW", "ZWG"]>;
        readonly customerId: Schema.String;
        readonly customerLabel: Schema.String;
        readonly dealId: Schema.String;
        readonly description: Schema.NullOr<Schema.String>;
        readonly expectedCloseDate: Schema.NullOr<Schema.String>;
        readonly expectedValue: Schema.Finite;
        readonly status: Schema.Literals<readonly ["New", "Qualified", "Offer sent", "Negotiation", "Won", "Lost"]>;
        readonly title: Schema.String;
        readonly updatedAt: Schema.String;
        readonly version: Schema.Finite;
    }>;
    readonly operation: Schema.Literal<"detail">;
}>]>;
export type DealWorkspaceResponse = typeof DealWorkspaceResponseSchema.Type;
export declare const DealWorkspaceValidationProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"DealWorkspaceValidationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<400>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const DealWorkspaceAuthenticationProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"DealWorkspaceAuthenticationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<401>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const DealWorkspaceForbiddenProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"DealWorkspaceForbiddenProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<403>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const DealWorkspaceNotFoundProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"DealWorkspaceNotFoundProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<404>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const DealWorkspacePolicyConflictProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"DealWorkspacePolicyConflictProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<409>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const DealWorkspacePolicyProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"DealWorkspacePolicyProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<422>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const DealWorkspaceUnavailableProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"DealWorkspaceUnavailableProblem">;
    readonly detail: Schema.String;
    readonly retryable: Schema.Literal<true>;
    readonly status: Schema.Literal<503>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
export declare const DealWorkspaceInternalProblemSchema: Schema.Struct<{
    readonly _tag: Schema.tag<"DealWorkspaceInternalProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<500>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>;
declare const DealWorkspaceSchemaErrorMiddleware_base: HttpApiMiddleware.ServiceClass<DealWorkspaceSchemaErrorMiddleware, "crm.core/deal-workspace/SchemaErrorMiddleware", {
    requires: never;
    provides: never;
    error: Schema.Struct<{
        readonly _tag: Schema.tag<"DealWorkspaceValidationProblem">;
        readonly detail: Schema.String;
        readonly status: Schema.Literal<400>;
        readonly title: Schema.String;
        readonly type: Schema.String;
    }>;
    clientError: never;
    requiredForClient: false;
    security: never;
}, HttpApiMiddleware.HttpApiMiddleware<never, Schema.Struct<{
    readonly _tag: Schema.tag<"DealWorkspaceValidationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<400>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>, never>>;
export declare class DealWorkspaceSchemaErrorMiddleware extends DealWorkspaceSchemaErrorMiddleware_base {
}
export declare const DealWorkspaceRequestHeadersSchema: Schema.Struct<{
    readonly authorization: Schema.optionalKey<Schema.String>;
    readonly 'x-correlation-id': Schema.NonEmptyString;
}>;
export declare const DealWorkspaceApi: HttpApi.HttpApi<"DealWorkspaceApi", HttpApiGroup.HttpApiGroup<"dealWorkspaceReads", HttpApiEndpoint.HttpApiEndpoint<"execute", "POST", "/reads/deal-workspace", HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.StringTree<never>, HttpApiEndpoint.Json<Schema.Union<readonly [Schema.Struct<{
    readonly cursor: Schema.optionalKey<Schema.String>;
    readonly customerId: Schema.optionalKey<Schema.String>;
    readonly limit: Schema.Finite;
    readonly operation: Schema.Literal<"list">;
}>, Schema.Struct<{
    readonly dealId: Schema.String;
    readonly operation: Schema.Literal<"detail">;
}>]>>, HttpApiEndpoint.StringTree<Schema.Struct<{
    readonly authorization: Schema.optionalKey<Schema.String>;
    readonly 'x-correlation-id': Schema.NonEmptyString;
}>>, HttpApiEndpoint.Json<Schema.Union<readonly [Schema.Struct<{
    readonly items: Schema.$Array<Schema.Struct<{
        readonly contactId: Schema.NullOr<Schema.String>;
        readonly contactLabel: Schema.NullOr<Schema.String>;
        readonly createdAt: Schema.String;
        readonly currency: Schema.Literals<readonly ["AED", "AFN", "ALL", "AMD", "AOA", "ARS", "AUD", "AWG", "AZN", "BAM", "BBD", "BDT", "BHD", "BIF", "BMD", "BND", "BOB", "BOV", "BRL", "BSD", "BTN", "BWP", "BYN", "BZD", "CAD", "CDF", "CHE", "CHF", "CHW", "CLF", "CLP", "CNY", "COP", "COU", "CRC", "CUP", "CVE", "CZK", "DJF", "DKK", "DOP", "DZD", "EGP", "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL", "GHS", "GIP", "GMD", "GNF", "GTQ", "GYD", "HKD", "HNL", "HTG", "HUF", "IDR", "ILS", "INR", "IQD", "IRR", "ISK", "JMD", "JOD", "JPY", "KES", "KGS", "KHR", "KMF", "KPW", "KRW", "KWD", "KYD", "KZT", "LAK", "LBP", "LKR", "LRD", "LSL", "LYD", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MRU", "MUR", "MVR", "MWK", "MXN", "MXV", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR", "NZD", "OMR", "PAB", "PEN", "PGK", "PHP", "PKR", "PLN", "PYG", "QAR", "RON", "RSD", "RUB", "RWF", "SAR", "SBD", "SCR", "SDG", "SEK", "SGD", "SHP", "SLE", "SOS", "SRD", "SSP", "STN", "SVC", "SYP", "SZL", "THB", "TJS", "TMT", "TND", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH", "UGX", "USD", "USN", "UYI", "UYU", "UYW", "UZS", "VED", "VES", "VND", "VUV", "WST", "XAD", "XAF", "XAG", "XAU", "XBA", "XBB", "XBC", "XBD", "XCD", "XCG", "XDR", "XOF", "XPD", "XPF", "XPT", "XSU", "XTS", "XUA", "XXX", "YER", "ZAR", "ZMW", "ZWG"]>;
        readonly customerId: Schema.String;
        readonly customerLabel: Schema.String;
        readonly dealId: Schema.String;
        readonly description: Schema.NullOr<Schema.String>;
        readonly expectedCloseDate: Schema.NullOr<Schema.String>;
        readonly expectedValue: Schema.Finite;
        readonly status: Schema.Literals<readonly ["New", "Qualified", "Offer sent", "Negotiation", "Won", "Lost"]>;
        readonly title: Schema.String;
        readonly updatedAt: Schema.String;
        readonly version: Schema.Finite;
    }>>;
    readonly nextCursor: Schema.NullOr<Schema.String>;
    readonly operation: Schema.Literal<"list">;
}>, Schema.Struct<{
    readonly deal: Schema.Struct<{
        readonly contactId: Schema.NullOr<Schema.String>;
        readonly contactLabel: Schema.NullOr<Schema.String>;
        readonly createdAt: Schema.String;
        readonly currency: Schema.Literals<readonly ["AED", "AFN", "ALL", "AMD", "AOA", "ARS", "AUD", "AWG", "AZN", "BAM", "BBD", "BDT", "BHD", "BIF", "BMD", "BND", "BOB", "BOV", "BRL", "BSD", "BTN", "BWP", "BYN", "BZD", "CAD", "CDF", "CHE", "CHF", "CHW", "CLF", "CLP", "CNY", "COP", "COU", "CRC", "CUP", "CVE", "CZK", "DJF", "DKK", "DOP", "DZD", "EGP", "ERN", "ETB", "EUR", "FJD", "FKP", "GBP", "GEL", "GHS", "GIP", "GMD", "GNF", "GTQ", "GYD", "HKD", "HNL", "HTG", "HUF", "IDR", "ILS", "INR", "IQD", "IRR", "ISK", "JMD", "JOD", "JPY", "KES", "KGS", "KHR", "KMF", "KPW", "KRW", "KWD", "KYD", "KZT", "LAK", "LBP", "LKR", "LRD", "LSL", "LYD", "MAD", "MDL", "MGA", "MKD", "MMK", "MNT", "MOP", "MRU", "MUR", "MVR", "MWK", "MXN", "MXV", "MYR", "MZN", "NAD", "NGN", "NIO", "NOK", "NPR", "NZD", "OMR", "PAB", "PEN", "PGK", "PHP", "PKR", "PLN", "PYG", "QAR", "RON", "RSD", "RUB", "RWF", "SAR", "SBD", "SCR", "SDG", "SEK", "SGD", "SHP", "SLE", "SOS", "SRD", "SSP", "STN", "SVC", "SYP", "SZL", "THB", "TJS", "TMT", "TND", "TOP", "TRY", "TTD", "TWD", "TZS", "UAH", "UGX", "USD", "USN", "UYI", "UYU", "UYW", "UZS", "VED", "VES", "VND", "VUV", "WST", "XAD", "XAF", "XAG", "XAU", "XBA", "XBB", "XBC", "XBD", "XCD", "XCG", "XDR", "XOF", "XPD", "XPF", "XPT", "XSU", "XTS", "XUA", "XXX", "YER", "ZAR", "ZMW", "ZWG"]>;
        readonly customerId: Schema.String;
        readonly customerLabel: Schema.String;
        readonly dealId: Schema.String;
        readonly description: Schema.NullOr<Schema.String>;
        readonly expectedCloseDate: Schema.NullOr<Schema.String>;
        readonly expectedValue: Schema.Finite;
        readonly status: Schema.Literals<readonly ["New", "Qualified", "Offer sent", "Negotiation", "Won", "Lost"]>;
        readonly title: Schema.String;
        readonly updatedAt: Schema.String;
        readonly version: Schema.Finite;
    }>;
    readonly operation: Schema.Literal<"detail">;
}>]>>, HttpApiEndpoint.Json<Schema.Struct<{
    readonly _tag: Schema.tag<"DealWorkspaceValidationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<400>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"DealWorkspaceAuthenticationProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<401>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"DealWorkspaceForbiddenProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<403>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"DealWorkspaceNotFoundProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<404>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"DealWorkspacePolicyConflictProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<409>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"DealWorkspacePolicyProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<422>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"DealWorkspaceUnavailableProblem">;
    readonly detail: Schema.String;
    readonly retryable: Schema.Literal<true>;
    readonly status: Schema.Literal<503>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}> | Schema.Struct<{
    readonly _tag: Schema.tag<"DealWorkspaceInternalProblem">;
    readonly detail: Schema.String;
    readonly status: Schema.Literal<500>;
    readonly title: Schema.String;
    readonly type: Schema.String;
}>>, DealWorkspaceSchemaErrorMiddleware, never>, false>>;
export {};
