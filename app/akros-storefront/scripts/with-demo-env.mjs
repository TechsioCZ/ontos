// Server process only. Never copy these values into NEXT_PUBLIC_* or next.config env.
import {existsSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {spawn} from "node:child_process";
const file=fileURLToPath(new URL("../../.env.demo.local",import.meta.url));
if(existsSync(file)) process.loadEnvFile(file);
const command=process.argv[2]??"start";
const app=fileURLToPath(new URL("../",import.meta.url));
const child=spawn(process.execPath,[`${app}node_modules/next/dist/bin/next`,command,...(command==="start"?["-p","3070","-H","127.0.0.1"]:[])],{cwd:app,env:process.env,stdio:"inherit"});
for(const signal of ["SIGTERM","SIGINT"])process.on(signal,()=>child.kill(signal));
child.on("exit",code=>process.exit(code??1));
