import { Exit } from 'effect';

/** Switch discriminants belong to `prefer-match-over-tag-switch`, not to this rule. */
export const describe = (exit: Exit.Exit<number, Error>): string => {
	switch (exit._tag) {
		case 'Failure':
			return 'failed';
		case 'Success':
			return 'ok';
	}
};
