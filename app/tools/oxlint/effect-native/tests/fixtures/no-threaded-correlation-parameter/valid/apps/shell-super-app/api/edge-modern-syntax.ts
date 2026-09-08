// Parser stress: decorators, `using`, static blocks, top-level await — no identity declared.
function Injectable(): ClassDecorator {
	return () => undefined;
}

export const ready = await Promise.resolve('ok');

@Injectable()
export class Gateway {
	readonly id: string = '';

	handle(input: { readonly id: string }): string {
		using _resource = { [Symbol.dispose]: () => undefined };
		return input.id;
	}

	static {
		void 0;
	}
}
