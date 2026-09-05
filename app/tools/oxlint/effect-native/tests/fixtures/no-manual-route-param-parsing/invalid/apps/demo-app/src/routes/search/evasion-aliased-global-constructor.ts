// expect-count: 2
const Params = URLSearchParams;
const Form = globalThis.FormData;

export const parseSearch = (search: string): string | null => new Params(search).get('offset');
export const readForm = (element: HTMLFormElement): FormDataEntryValue | null => new Form(element).get('login');
