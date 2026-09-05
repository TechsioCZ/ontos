import sink from "node:console";
import proc from "node:process";
export function report(sink: {error(m: string): void}, proc: {stderr: {write(m: string): void}}) {
 sink.error("injected"); proc.stderr.write("injected");
}
