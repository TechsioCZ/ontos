// A5: no database provenance follows from nested functions or a field named code.
export const present = (input: object) => ((inner: object) => 'code' in inner)(input);
