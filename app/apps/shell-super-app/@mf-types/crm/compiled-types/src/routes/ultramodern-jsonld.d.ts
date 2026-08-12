export type JsonLdPrimitive = string | number | boolean | null;
export type JsonLdValue = JsonLdPrimitive | readonly JsonLdValue[] | {
    readonly [key: string]: JsonLdValue;
};
export type JsonLdObject = Readonly<Record<string, JsonLdValue>>;
export type RouteJsonLd = JsonLdObject | readonly JsonLdObject[];
declare const schemaContext: 'https://schema.org';
type ThingReference = string | {
    readonly '@id'?: string;
    readonly '@type'?: string;
    readonly name?: string;
    readonly url?: string;
};
export declare const defineRouteJsonLd: <TJsonLd extends RouteJsonLd>(jsonLd: TJsonLd) => TJsonLd;
export interface WebPageJsonLdInput {
    readonly name: string;
    readonly url: string;
    readonly description?: string;
    readonly inLanguage?: string | readonly string[];
    readonly isPartOf?: ThingReference;
}
export declare const webPageJsonLd: (input: WebPageJsonLdInput) => Readonly<Record<string, JsonLdValue>> & {
    readonly '@context': typeof schemaContext;
    readonly '@type': "WebPage";
} & WebPageJsonLdInput;
export interface WebApplicationJsonLdInput {
    readonly name: string;
    readonly url: string;
    readonly applicationCategory?: string;
    readonly browserRequirements?: string;
    readonly description?: string;
    readonly operatingSystem?: string;
}
export declare const webApplicationJsonLd: (input: WebApplicationJsonLdInput) => Readonly<Record<string, JsonLdValue>> & {
    readonly '@context': typeof schemaContext;
    readonly '@type': "WebApplication";
} & WebApplicationJsonLdInput;
export interface SoftwareApplicationJsonLdInput {
    readonly name: string;
    readonly url: string;
    readonly applicationCategory?: string;
    readonly applicationSubCategory?: string;
    readonly description?: string;
    readonly offers?: ThingReference;
    readonly operatingSystem?: string;
}
export declare const softwareApplicationJsonLd: (input: SoftwareApplicationJsonLdInput) => Readonly<Record<string, JsonLdValue>> & {
    readonly '@context': typeof schemaContext;
    readonly '@type': "SoftwareApplication";
} & SoftwareApplicationJsonLdInput;
export interface OrganizationJsonLdInput {
    readonly name: string;
    readonly url?: string;
    readonly logo?: string;
    readonly sameAs?: readonly string[];
}
export declare const organizationJsonLd: (input: OrganizationJsonLdInput) => Readonly<Record<string, JsonLdValue>> & {
    readonly '@context': typeof schemaContext;
    readonly '@type': "Organization";
} & OrganizationJsonLdInput;
export interface BreadcrumbListItemInput {
    readonly name: string;
    readonly item: string;
}
export declare const breadcrumbListJsonLd: (items: readonly BreadcrumbListItemInput[]) => Readonly<Record<string, JsonLdValue>> & {
    readonly '@context': typeof schemaContext;
    readonly '@type': "BreadcrumbList";
} & {
    itemListElement: {
        '@type': string;
        item: string;
        name: string;
        position: number;
    }[];
};
export interface FAQPageQuestionInput {
    readonly name: string;
    readonly acceptedAnswer: {
        readonly text: string;
    };
}
export declare const faqPageJsonLd: (questions: readonly FAQPageQuestionInput[]) => Readonly<Record<string, JsonLdValue>> & {
    readonly '@context': typeof schemaContext;
    readonly '@type': "FAQPage";
} & {
    mainEntity: {
        '@type': string;
        acceptedAnswer: {
            '@type': string;
            text: string;
        };
        name: string;
    }[];
};
export {};
