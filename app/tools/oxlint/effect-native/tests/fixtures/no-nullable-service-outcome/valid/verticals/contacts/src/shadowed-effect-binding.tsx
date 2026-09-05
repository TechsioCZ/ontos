import { Effect } from "./local-effect";

export interface Row {
	readonly rowId: string;
}

/** `Effect` here is a local module, not `effect`, so nothing is reported. */
export interface NotEffectPort {
	readonly claimNext: () => Effect.Effect<Row | null, Error>;
}

export function ContactsWidget() {
	return <span className="contacts">ok</span>;
}
