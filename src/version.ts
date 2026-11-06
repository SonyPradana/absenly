// Single source for the app version, shared by the CLI and the web shell.
import pkg from "../package.json" with { type: "json" };

export const VERSION = pkg.version;
