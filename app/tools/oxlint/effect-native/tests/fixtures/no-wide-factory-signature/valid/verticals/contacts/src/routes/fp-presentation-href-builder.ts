/**
 * FALSE POSITIVE regression fixture (currently reported — this file is expected to be silent).
 *
 * Reproduces `verticals/contacts/src/routes/[lang]/contacts/customers/page.tsx:69`
 * (`buildCustomerListHref`) and `.../customers/[id]/page.tsx:237`
 * (`buildCustomerContactListHref`).
 *
 * These are pure presentation-layer URL string builders in a React route file. Every parameter is
 * a per-render scalar (language, current query string, filter, offset); there is no collaborator,
 * no service, no Effect and no import of `effect` anywhere in the module. Audit B4 is about the
 * *dependency* vocabulary ("scoped transaction access, operation scope, collector, clocks,
 * identifiers, repositories, request identity"), so the rule's advice — "turn it into
 * `Layer.effect(Tag, Effect.gen(...))` that `yield*`s its collaborators from Context" — has no
 * meaning here. The rule spec itself lists exactly this shape under `validExamples`:
 *   `const buildHref = (lang, id, query, page) => \`/${lang}/…\`;`
 */
export const buildCustomerListHref = (
	language: string,
	currentSearch: string,
	status: 'active' | 'all' | 'archived',
	offset: number,
): string => {
	const parameters = new URLSearchParams(currentSearch);
	parameters.set('status', status);
	if (offset > 0) parameters.set('offset', String(offset));
	const search = parameters.toString();
	return `/${language}/contacts/customers${search.length === 0 ? '' : `?${search}`}`;
};

export const buildCustomerContactListHref = (
	language: string,
	customerId: string,
	currentSearch: string,
	status: 'active' | 'all' | 'archived',
	offset: number,
): string => {
	const parameters = new URLSearchParams(currentSearch);
	parameters.set('status', status);
	if (offset > 0) parameters.set('offset', String(offset));
	const search = parameters.toString();
	const pathname = `/${language}/contacts/customers/${encodeURIComponent(customerId)}`;
	return `${pathname}${search.length === 0 ? '' : `?${search}`}`;
};
