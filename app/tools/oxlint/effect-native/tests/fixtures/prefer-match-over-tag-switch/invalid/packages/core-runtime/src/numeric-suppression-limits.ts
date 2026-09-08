// expect-count: 4
//
// The numeric suppression is narrow on purpose: it releases ONLY a `discriminantProperties` access
// whose every non-`default` case is numeric. These four switches must all still report.
declare const invalid: () => string;

interface Loaded {
	readonly _tag: 'Loaded';
}

interface Failed {
	readonly _tag: 'Failed';
}

// 1. `_tag` is never suppressed, even with (nonsensical) numeric cases: an Effect discriminator is
// a string, so numeric cases here mean the code is wrong, not that the space is an open protocol.
export const tagWithNumericCases = (value: { readonly _tag: number }): string => {
	switch (value._tag) {
		case 1: {
			return 'one';
		}
		case 2: {
			return 'two';
		}
		default: {
			return 'other';
		}
	}
};

// 2. Mixed numeric and string cases are not an open numeric protocol space.
export const mixedCases = (response: { readonly status: number | string }): string => {
	switch (response.status) {
		case 404: {
			return 'missing';
		}
		case 'gone': {
			return 'gone';
		}
		default: {
			return 'unavailable';
		}
	}
};

// 3. A string-cased `status` is exactly the B5 hand-rolled vocabulary the audit names.
export const stringStatus = (job: { readonly status: string }): string => {
	switch (job.status) {
		case 'queued': {
			return 'waiting';
		}
		case 'running': {
			return 'busy';
		}
		case 'done': {
			return 'finished';
		}
		default: {
			return invalid();
		}
	}
};

// 4. A tagged union dispatched on `_tag` — the A4 classifier, reported as always.
export const classify = (state: Loaded | Failed): string => {
	switch (state._tag) {
		case 'Loaded': {
			return 'ready';
		}
		case 'Failed': {
			return invalid();
		}
	}
};
