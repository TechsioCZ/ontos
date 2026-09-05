// expect-count: 2
// A shadow that does not dominate the use site must not silence the ambient global: the `const`
// lives in a nested block, and the `class` lives in a sibling function scope.
export function blockShadow(): unknown {
	{
		const Error = class Local {};
		void Error;
	}
	return new Error("the block shadow never reaches this scope");
}

function sibling(): unknown {
	class TypeError {}
	return new TypeError();
}
void sibling;

export const stillGlobal = (): unknown => new TypeError("module scope is still the global");
