import { strict as assert } from 'node:assert';

const hasPostgreSqlCode = (error: Record<string, unknown>, expected: string): boolean =>
	('code' in error && error.code === expected) ||
	('cause' in error && hasPostgreSqlCode(error.cause as Record<string, unknown>, expected));

assert.equal(hasPostgreSqlCode({ code: '23505' }, '23505'), true);
assert.equal(hasPostgreSqlCode({ code: 'ECONNREFUSED' }, '23503'), false);
