// Audit/source correction: An ambient declaration supplies a lexical external binding. Its name/type is not proof of Node global identity; audit D preserves forced injected adapters.
declare const console: { readonly log: (message: string) => void; readonly error: (message: string) => void };

export function emit(message: string): void {
	console.log(message);
	console.error(message);
}
