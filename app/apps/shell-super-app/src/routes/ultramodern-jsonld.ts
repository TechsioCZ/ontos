export type JsonLdPrimitive = string | number | boolean | null;
export type JsonLdValue =
  | JsonLdPrimitive
  | readonly JsonLdValue[]
  | { readonly [key: string]: JsonLdValue };
export type JsonLdObject = Readonly<Record<string, JsonLdValue>>;
export type RouteJsonLd = JsonLdObject | readonly JsonLdObject[];

const schemaContext = 'https://schema.org' as const;

type SchemaObject<TType extends string> = JsonLdObject & {
  readonly '@context': typeof schemaContext;
  readonly '@type': TType;
};

type ThingReference =
  | string
  | {
      readonly '@id'?: string;
      readonly '@type'?: string;
      readonly name?: string;
      readonly url?: string;
    };

const withSchemaContext = <TType extends string, TInput extends object>(
  type: TType,
  input: TInput,
): SchemaObject<TType> & TInput => ({
  '@context': schemaContext,
  '@type': type,
  ...input,
});

export const defineRouteJsonLd = <TJsonLd extends RouteJsonLd>(jsonLd: TJsonLd): TJsonLd => jsonLd;

export interface WebPageJsonLdInput {
  readonly description?: string;
  readonly inLanguage?: string | readonly string[];
  readonly isPartOf?: ThingReference;
  readonly name: string;
  readonly url: string;
}

export const webPageJsonLd = (input: WebPageJsonLdInput) => withSchemaContext('WebPage', input);

export interface WebApplicationJsonLdInput {
  readonly applicationCategory?: string;
  readonly browserRequirements?: string;
  readonly description?: string;
  readonly name: string;
  readonly operatingSystem?: string;
  readonly url: string;
}

export const webApplicationJsonLd = (input: WebApplicationJsonLdInput) =>
  withSchemaContext('WebApplication', input);

export interface SoftwareApplicationJsonLdInput {
  readonly applicationCategory?: string;
  readonly applicationSubCategory?: string;
  readonly description?: string;
  readonly name: string;
  readonly offers?: ThingReference;
  readonly operatingSystem?: string;
  readonly url: string;
}

export const softwareApplicationJsonLd = (input: SoftwareApplicationJsonLdInput) =>
  withSchemaContext('SoftwareApplication', input);

export interface OrganizationJsonLdInput {
  readonly logo?: string;
  readonly name: string;
  readonly sameAs?: readonly string[];
  readonly url?: string;
}

export const organizationJsonLd = (input: OrganizationJsonLdInput) =>
  withSchemaContext('Organization', input);

export interface BreadcrumbListItemInput {
  readonly item: string;
  readonly name: string;
}

export const breadcrumbListJsonLd = (items: readonly BreadcrumbListItemInput[]) =>
  withSchemaContext('BreadcrumbList', {
    itemListElement: items.map((entry, index) => ({
      '@type': 'ListItem',
      item: entry.item,
      name: entry.name,
      position: index + 1,
    })),
  });

export interface FAQPageQuestionInput {
  readonly acceptedAnswer: {
    readonly text: string;
  };
  readonly name: string;
}

export const faqPageJsonLd = (questions: readonly FAQPageQuestionInput[]) =>
  withSchemaContext('FAQPage', {
    mainEntity: questions.map((question) => ({
      '@type': 'Question',
      acceptedAnswer: {
        '@type': 'Answer',
        text: question.acceptedAnswer.text,
      },
      name: question.name,
    })),
  });
