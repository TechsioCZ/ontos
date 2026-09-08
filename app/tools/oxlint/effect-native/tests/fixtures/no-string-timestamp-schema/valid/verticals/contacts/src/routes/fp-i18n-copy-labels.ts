// False positive: an i18n copy dictionary. The keys mirror field names so the label for a column can
// be looked up, but every value is a translated UI label ("Created", "Vytvořeno") — there is no
// temporal value here at all, and `Schema.DateTimeUtc` cannot model a label.
// Real occurrences:
//   verticals/contacts/src/routes/[lang]/contacts/customers/[id]/page.tsx:119,123,125,141
//   verticals/contacts/src/routes/[lang]/contacts/customers/[id]/contacts/[contactId]/page.tsx:75,96
export interface CustomerDetailCopy {
	readonly back: string;
	readonly createdAt: string;
	readonly dissolvedOn: string;
	readonly establishedOn: string;
	readonly loading: string;
	readonly notFound: string;
	readonly retry: string;
	readonly statusActive: string;
	readonly updatedAt: string;
}

export const czech = (t: (key: string) => string): CustomerDetailCopy => ({
	back: t("contacts.pages.customerDetail.back"),
	createdAt: t("contacts.pages.customerDetail.fields.createdAt"),
	dissolvedOn: t("contacts.pages.customerDetail.fields.dissolvedOn"),
	establishedOn: t("contacts.pages.customerDetail.fields.establishedOn"),
	loading: t("contacts.pages.customerDetail.loading"),
	notFound: t("contacts.pages.customerDetail.notFound"),
	retry: t("contacts.pages.customerDetail.retry"),
	statusActive: t("contacts.pages.customerDetail.statusActive"),
	updatedAt: t("contacts.pages.customerDetail.fields.updatedAt"),
});
