// A module-level class binding named `console` is not the ambient object.
class console {
	static log(message: string): void {
		void message;
	}
}

export function emit(message: string): void {
	console.log(message);
}
