// expect-count: 5
import { Effect as E, Exit as Ex } from 'effect';

export const run = (terminationExit: Ex.Exit<void>, originalPrincipalExit: Ex.Exit<void>) =>
	E.sync(() => {
		if (terminationExit?._tag === 'Failure') return 'terminated';
		if (originalPrincipalExit!._tag === 'Failure') return 'principal';
		if ((terminationExit as Ex.Exit<void>)._tag === 'Failure') return 'cast';
		if (terminationExit._tag == 'Success') return 'loose-eq';
		return terminationExit._tag === `Failure` ? 'template' : 'ok';
	});
