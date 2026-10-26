import { readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";

/**
 * Fixture files use decorators, which need a real compile step (as a NestJS
 * build does) rather than Node's type stripping. Compiles the TypeScript
 * files under `directory` when they are imported.
 *
 * `packages` maps a package name the fixtures import to the name of the
 * installed package to load instead, so that the same fixtures can run
 * against another installed version of a library, for example
 * `{ typeorm: "typeorm-0.3.17" }`.
 */
export function compileDecorators(directory: string, packages: Record<string, string> = {}): void {
  const prefix = pathToFileURL(directory).href;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const fromFixture = context.parentURL !== undefined && context.parentURL.startsWith(prefix);
      return nextResolve(fromFixture && Object.hasOwn(packages, specifier) ? (packages[specifier] as string) : specifier, context);
    },
    load(url, context, nextLoad) {
      if (!url.startsWith(prefix) || !url.endsWith(".ts")) {
        return nextLoad(url, context);
      }
      const fileName = fileURLToPath(url);
      const output = ts.transpileModule(readFileSync(fileName, "utf8"), {
        fileName,
        compilerOptions: {
          module: ts.ModuleKind.ESNext,
          target: ts.ScriptTarget.ES2022,
          experimentalDecorators: true,
          emitDecoratorMetadata: true,
          useDefineForClassFields: false,
        },
      });
      return { format: "module", source: output.outputText, shortCircuit: true };
    },
  });
}
