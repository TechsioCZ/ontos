// expect-count: 4
import { Predicate } from 'effect';

const hasDatabaseErrorCode = (error: unknown, expectedCode: string): boolean => {
	let current: unknown = error;
	while (Predicate.isObjectKeyword(current) && current !== null) {
		if ('code' in current && current.code === expectedCode) {
			return true;
		}
		current = 'cause' in current ? current.cause : undefined;
	}
	return false;
};

export const bindingInsertFailure = (error: unknown): string =>
	hasDatabaseErrorCode(error, '23505') ? 'conflict' : 'unavailable';
