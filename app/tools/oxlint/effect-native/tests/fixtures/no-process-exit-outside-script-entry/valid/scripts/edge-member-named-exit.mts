// False-positive probe: a member and an object key named `exit` on something that is not the
// process object, in a file that also imports `exit` from `node:process` for its single edge site.
import { exit } from "node:process";

interface Session {
	readonly exit: () => void;
}

export const close = (session: Session): void => {
	session.exit();
};

export const makeHandlers = (): { readonly exit: () => void } => ({
	exit: (): void => {},
});

if (process.argv[1] !== undefined) {
	exit(0);
}
