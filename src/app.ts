// Thin entrypoint: argv -> cli.ts.
import { runCli } from "./cli.ts";

process.exitCode = await runCli(Bun.argv.slice(2));
