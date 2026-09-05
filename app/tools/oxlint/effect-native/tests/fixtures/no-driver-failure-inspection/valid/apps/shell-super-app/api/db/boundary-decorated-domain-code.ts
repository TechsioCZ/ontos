// A5 targets driver taxonomy, not a bare domain code field. Decorators do not prove provenance.
const log = (_target: unknown, _key: unknown, descriptor: PropertyDescriptor): PropertyDescriptor => descriptor;

export class Repo {
	static {
		Reflect.defineProperty(Repo, 'ready', { value: true });
	}

	accessor label: string = 'repo';

	@log
	insert(error: Record<string, unknown>): boolean {
		return 'code' in error;
	}
}
