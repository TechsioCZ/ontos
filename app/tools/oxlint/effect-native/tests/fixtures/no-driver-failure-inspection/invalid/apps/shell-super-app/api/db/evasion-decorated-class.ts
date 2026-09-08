// expect-count: 1
// A5: sqlState is driver-specific; a bare code field is covered by the valid boundary twin.
const log = (_target: unknown, _key: unknown, descriptor: PropertyDescriptor): PropertyDescriptor => descriptor;

export class Repo {
	static {
		Reflect.defineProperty(Repo, 'ready', { value: true });
	}

	accessor label: string = 'repo';

	@log
	insert(error: Record<string, unknown>): boolean {
		return 'sqlState' in error;
	}
}
