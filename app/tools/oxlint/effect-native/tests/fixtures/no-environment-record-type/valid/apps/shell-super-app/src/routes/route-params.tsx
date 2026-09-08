/** Closed literal key sets: the generated route-param maps must never report. */
type CustomerDetailPageRouteParams = Readonly<Partial<Record<'id', string>>>;
type ContactEditPageRouteParams = Readonly<Partial<Record<'id' | 'contactId', string>>>;
type ModulePageRouteParams = Readonly<Record<string, string>>;

/** Recursive JSON / i18n shapes: the value type is not a string|undefined union. */
type LocaleResource = string | { readonly [key: string]: LocaleResource };
type JsonLdValue = string | number | boolean | { readonly [key: string]: JsonLdValue };

export const RouteHead = ({
	params,
	detail,
	edit,
	locale,
	jsonLd,
}: {
	readonly params: ModulePageRouteParams;
	readonly detail: CustomerDetailPageRouteParams;
	readonly edit: ContactEditPageRouteParams;
	readonly locale: LocaleResource;
	readonly jsonLd: JsonLdValue;
}) => (
	<span data-module={params['moduleId']} data-id={detail.id ?? edit.contactId ?? ''}>
		{String(locale)}
		{String(jsonLd)}
	</span>
);
