export const isWorkspaceCustomEvent = (event: Event): event is CustomEvent<{ readonly name: string }> =>
	'detail' in event && 'initCustomEvent' in event;

export const columnOf = (table: { readonly name: string }): string =>
	'column' in table ? String(table.name) : 'id';
