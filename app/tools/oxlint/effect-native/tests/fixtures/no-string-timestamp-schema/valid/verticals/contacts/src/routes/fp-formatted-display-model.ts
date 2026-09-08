// False positive: a view model that deliberately carries BOTH a locale-formatted display string and
// the machine-readable ISO value. `createdAt` here is the output of `Intl.DateTimeFormat` (or the
// localized "unavailable" placeholder), rendered as `<time dateTime={createdAtIso}>{createdAt}</time>`;
// `createdAtIso` is the actual temporal field. The rule reports the display string and stays silent
// on the real timestamp, because `…Iso` does not match the key pattern — the signal is inverted.
// Real occurrences:
//   verticals/contacts/src/routes/[lang]/contacts/customers/[id]/page.tsx:75,79,81,87
//   verticals/contacts/src/routes/[lang]/contacts/customers/page.tsx:191,198
//   verticals/contacts/src/routes/[lang]/contacts/customers/[id]/contacts/[contactId]/page.tsx:53,62
export interface CustomerDetailReadyModel {
	/** Locale-formatted for display; the machine value lives in `createdAtIso`. */
	readonly createdAt: string;
	readonly createdAtIso: string;
	/** Locale-formatted, or the localized "unavailable" placeholder such as an em dash. */
	readonly dissolvedOn: string;
	readonly dissolvedOnIso: null | string;
	readonly name: string;
}

const formatTimestamp = (value: string, language: string): string =>
	new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(Date.parse(value));

export const toReadyModel = (
	name: string,
	createdAtIso: string,
	dissolvedOnIso: null | string,
	language: string,
	unavailableValue: string,
): CustomerDetailReadyModel => ({
	createdAt: formatTimestamp(createdAtIso, language),
	createdAtIso,
	dissolvedOn: dissolvedOnIso === null ? unavailableValue : formatTimestamp(dissolvedOnIso, language),
	dissolvedOnIso,
	name,
});
