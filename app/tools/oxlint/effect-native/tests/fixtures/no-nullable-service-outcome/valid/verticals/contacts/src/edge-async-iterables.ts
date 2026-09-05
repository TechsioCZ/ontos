export interface Contact {
	readonly contactId: string;
}

/** Element types of a stream or collection are not `Promise`/`Effect` outcomes. */
export interface ContactStream {
	rows(): AsyncGenerator<Contact | undefined>;
	iterate(): AsyncIterableIterator<Contact | null>;
	list(): Array<Contact | undefined>;
	index(): Map<string, Contact | undefined>;
}

export async function* streamContacts(): AsyncGenerator<Contact | undefined> {
	yield undefined;
}
