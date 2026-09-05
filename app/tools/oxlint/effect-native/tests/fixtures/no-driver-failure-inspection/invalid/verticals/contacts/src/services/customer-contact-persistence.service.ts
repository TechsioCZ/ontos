// expect-count: 6
const objectCause = (value: Record<string, unknown>): Record<string, unknown> | undefined => {
	if (!('cause' in value)) {
		return undefined;
	}
	return typeof value.cause === 'object' ? (value.cause as Record<string, unknown>) : undefined;
};

export const isCustomerIcoUniquenessFailure = (error: Record<string, unknown>): boolean => {
	let current: Record<string, unknown> | undefined = error;
	while (current !== undefined) {
		if (
			'code' in current &&
			current.code === '23505' &&
			'constraint' in current &&
			current.constraint === 'contacts_customers_tenant_ico_uk'
		) {
			return true;
		}
		current = objectCause(current);
	}
	return false;
};
