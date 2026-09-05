declare const error: { _tag: string; name: string };
let tag = error._tag;
tag = error.name;
export const label = tag === "Contacts";
let { _tag: kind } = error;
kind = error.name;
export const matchingLabel = kind.startsWith("Contacts");
let key = "_tag";
key = "name";
export const ordinaryProperty = error[key] === "Contacts";
export function customString(String: (value: string) => number) {
  return String(error._tag) === 1;
}
export function customRegex(RegExp: new (pattern: string) => { test(value: string): boolean }) {
  return new RegExp("x").test(error._tag);
}
