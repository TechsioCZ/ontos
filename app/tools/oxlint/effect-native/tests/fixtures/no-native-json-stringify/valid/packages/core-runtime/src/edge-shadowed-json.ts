// Any binding named `JSON` shadows the global: parameter, local, catch binding, block scope.
declare const v: unknown;

export function withParameter(JSON: { readonly stringify: (value: unknown) => string }): string {
	return JSON.stringify(v);
}

export function withLocal(): string {
	const JSON = { stringify: (value: unknown) => String(value) };
	return JSON.stringify(v);
}

export function withCatchBinding(): string {
	try {
		throw new Error("boom");
	} catch (JSON: any) {
		return JSON.stringify(v);
	}
}

export function withBlockScope(): void {
	{
		const JSON = { stringify: (value: unknown) => String(value) };
		void JSON.stringify(v);
	}
}
