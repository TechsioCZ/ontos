// Regression fixture for a false positive.
//
// The audit's D tier and this rule's own header bless HTTP-status classification: an open numeric
// protocol space is not a closed tagged vocabulary. `verticals/contacts/src/integrations/ares/
// ares-subject.service.ts:163` escapes the rule only because its discriminant is a bare identifier
// (`switch (status)`). The identical classifier written against the response object reports,
// because the tag/discriminant-property branch never looks at the case tests.
export const classifyAresStatus = (response: { readonly status: number }): string => {
	switch (response.status) {
		case 400: {
			return 'invalid_ico';
		}
		case 401:
		case 403: {
			return 'denied';
		}
		case 404: {
			return 'not_found';
		}
		case 429: {
			return 'throttled';
		}
		default: {
			return 'unavailable';
		}
	}
};

// Same shape, numeric `kind` (e.g. a TypeScript `SyntaxKind` dispatch in a codemod).
export const describeNode = (node: { readonly kind: number }): string => {
	switch (node.kind) {
		case 262: {
			return 'function';
		}
		case 264: {
			return 'interface';
		}
		default: {
			return 'other';
		}
	}
};

// Numeric literals in every non-`default` spelling the suppression must recognise: negative,
// unary-plus, hexadecimal and bigint. All of these are still an open numeric protocol space.
export const classifyExitCode = (proc: { readonly status: number }): string => {
	switch (proc.status) {
		case -1: {
			return 'signalled';
		}
		case +0: {
			return 'ok';
		}
		case 0x7f: {
			return 'not_executable';
		}
		default: {
			return 'failed';
		}
	}
};

export const classifySyntaxKind = (node: { readonly kind: bigint }): string => {
	switch (node.kind) {
		case 262n: {
			return 'function';
		}
		case 264n: {
			return 'interface';
		}
		default: {
			return 'other';
		}
	}
};

// A numeric-cased `switch` reached through optional chaining and a non-null assertion: the
// suppression looks at the case tests, so the unwrapping does not change the verdict.
export const classifyOptional = (response?: { readonly status?: number }): string => {
	switch (response?.status!) {
		case 400: {
			return 'invalid';
		}
		case 404: {
			return 'missing';
		}
		default: {
			return 'unavailable';
		}
	}
};
