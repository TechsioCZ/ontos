import { Option } from "effect";
declare const option: Option.Option<string>;
let tag = option._tag;
tag = "Some";
export const same = tag === "Some";
let { _tag: kind } = option;
kind = "None";
export const absent = kind === "None";
