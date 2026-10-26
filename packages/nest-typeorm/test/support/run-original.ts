import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { readProjectConfig, registerTypeScript } from "../../../import-typeorm/src/index.ts";
import { findProjectRoot } from "../../src/index.ts";

/*
 * Stand-in for "nest start" in tests: runs the entry point of a NestJS
 * project exactly as it is, compiling its TypeScript on the fly. Nothing of
 * the sandbox is involved.
 *
 *   node run-original.ts <entry>
 */
const entry = resolve(process.argv[2] as string);
const root = findProjectRoot(dirname(entry));
const projectRequire = createRequire(join(root, "package.json"));
const ts = projectRequire("typescript");
registerTypeScript(ts, readProjectConfig(ts, dirname(entry)), { root });
projectRequire(entry);
