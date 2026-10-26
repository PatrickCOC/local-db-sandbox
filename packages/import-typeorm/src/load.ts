import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createRequire, isBuiltin, registerHooks } from "node:module";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export class TypeormImportError extends Error {
  /** `no-entities`: entity files were loaded, and no entity of them could be imported. Absent for whatever else went wrong. */
  readonly reason: "no-entities" | undefined;

  constructor(message: string, options?: ErrorOptions & { reason?: "no-entities" }) {
    super(message, options);
    this.name = "TypeormImportError";
    this.reason = options?.reason;
  }
}

export interface LoadedProject {
  /** The `typeorm` module as installed in the project that owns the entities. */
  typeorm: Record<string, any>;
  /** Files that were loaded, in order. */
  files: string[];
  /** Every value exported by those files. */
  exported: Set<unknown>;
}

const SOURCE_FILE = /\.(ts|cts|mts|js|cjs|mjs)$/;
const TYPESCRIPT_FILE = /\.(ts|cts|mts)$/;

/**
 * Only files that mention both "typeorm" and an entity decorator are loaded,
 * so pointing at a source folder does not execute unrelated modules such as
 * an application entry point. The file is read, and not run.
 */
export function looksLikeEntityFile(file: string): boolean {
  const source = readFileSync(file, "utf8");
  return /typeorm/.test(source) && /\b(Entity|ChildEntity|ViewEntity|EntitySchema)\b/.test(source);
}

/**
 * The files that would be loaded for `path`: the file itself, or the files
 * of a folder that look like entity files. Nothing is loaded to find them.
 */
export function findEntityFiles(path: string): string[] {
  let stats;
  try {
    stats = statSync(path);
  } catch (cause) {
    throw new TypeormImportError(`Path does not exist: ${path}`, { cause });
  }
  if (stats.isFile()) {
    return [path];
  }

  const names = readdirSync(path, { recursive: true, encoding: "utf8" }).sort();
  const files = names
    .filter((name) => SOURCE_FILE.test(name) && !/\.d\.[cm]?ts$/.test(name))
    .filter((name) => !name.split(/[\\/]/).includes("node_modules"))
    .map((name) => join(path, name));
  const present = new Set(files);
  return files
    // A compiled file next to its TypeScript source would register the same entity twice.
    .filter((file) => TYPESCRIPT_FILE.test(file) || !present.has(file.replace(/\.([cm]?)js$/, ".$1ts")))
    .filter(looksLikeEntityFile);
}

export interface ProjectConfig {
  /** The tsconfig.json that was read, if one was found. */
  file: string | undefined;
  /** Its compiler options, with `extends` applied and paths made absolute. */
  options: Record<string, any>;
}

/**
 * Reads the nearest tsconfig.json at or above `directory`, the way `tsc`
 * would find it. Without one, no module resolution settings are known and
 * only relative and installed-package imports can be resolved.
 */
export function readProjectConfig(ts: Record<string, any>, directory: string): ProjectConfig {
  const file: string | undefined = ts.findConfigFile(directory, ts.sys.fileExists);
  if (file === undefined) {
    return { file, options: {} };
  }
  const { config, error } = ts.readConfigFile(file, ts.sys.readFile);
  if (error !== undefined) {
    throw new TypeormImportError(`Cannot read ${file}: ${ts.flattenDiagnosticMessageText(error.messageText, " ")}`);
  }
  // Only the compiler options are needed; do not scan the project for source files.
  const host = { ...ts.sys, readDirectory: () => [] };
  return { file: resolve(file), options: ts.parseJsonConfigFileContent(config, host, dirname(file)).options };
}

export interface TypeScriptHooksOptions {
  /** Compile only files under this directory. Default: every TypeScript file outside node_modules. */
  root?: string;
  /**
   * Compile a file to an ES module when Node would load it as one (`.mts`, or
   * `.ts` in a package with `"type": "module"`). Default: always CommonJS.
   */
  esModules?: boolean;
}

/** `"type"` of the nearest package.json at or above each directory. */
const packageTypes = new Map<string, string | undefined>();

function packageType(directory: string): string | undefined {
  if (!packageTypes.has(directory)) {
    let type: string | undefined;
    try {
      type = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")).type;
    } catch {
      const parent = dirname(directory);
      type = parent === directory ? undefined : packageType(parent);
    }
    packageTypes.set(directory, type);
  }
  return packageTypes.get(directory);
}

/** Whether Node treats this TypeScript file as an ES module. */
export function isEsModuleFile(fileName: string): boolean {
  return /\.mts$/.test(fileName) || (/\.ts$/.test(fileName) && packageType(dirname(fileName)) === "module");
}

/**
 * Registers module hooks that compile the project's TypeScript files on the
 * fly using the project's own `typescript` package. Decorators need a real
 * compile step (`experimentalDecorators` and `emitDecoratorMetadata`), which
 * Node's built-in type stripping does not do.
 *
 * Files are compiled one at a time. Imports are resolved with the project's
 * tsconfig settings (`baseUrl`, `paths`, `moduleResolution`), so aliases
 * such as "src/..." load without being rewritten.
 */
export function registerTypeScript(
  ts: Record<string, any>,
  project: ProjectConfig,
  options: TypeScriptHooksOptions = {},
): { deregister(): void } {
  const compilerOptions = {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2022,
    experimentalDecorators: true,
    emitDecoratorMetadata: true,
    useDefineForClassFields: false,
    // Decides how the compiled code reads default and namespace imports of CommonJS packages.
    esModuleInterop: project.options.esModuleInterop ?? true,
    strict: true,
  };
  // Module URLs are compared without regard to case, since Windows drive letters vary.
  const scope = options.root === undefined ? undefined : `${pathToFileURL(realpathSync(options.root)).href.toLowerCase()}/`;
  const isProjectTypeScript = (url: string): boolean =>
    url.startsWith("file:") &&
    TYPESCRIPT_FILE.test(url) &&
    !url.includes("/node_modules/") &&
    (scope === undefined || url.toLowerCase().startsWith(scope));

  /** The project source file that tsconfig settings map `specifier` to, if any. */
  const resolveWithProjectConfig = (specifier: string, parentURL: string): string | undefined => {
    const { resolvedModule } = ts.resolveModuleName(specifier, fileURLToPath(parentURL), project.options, ts.sys);
    if (resolvedModule === undefined || resolvedModule.isExternalLibraryImport) {
      return undefined;
    }
    const fileName: string = resolvedModule.resolvedFileName;
    // A declaration file has no code to load.
    return /\.d\.[cm]?ts$/.test(fileName) ? undefined : fileName;
  };

  return registerHooks({
    resolve(specifier, context, nextResolve) {
      const relative = /^\.{1,2}\//.test(specifier);
      const fromProject = context.parentURL !== undefined && isProjectTypeScript(context.parentURL);
      if (!relative && fromProject && !isBuiltin(specifier) && !isAbsolute(specifier)) {
        // tsconfig settings take precedence over installed packages, as they do for the compiler.
        const fileName = resolveWithProjectConfig(specifier, context.parentURL as string);
        if (fileName !== undefined) {
          // `import` needs a URL; `require` needs a path.
          return nextResolve(context.conditions.includes("import") ? pathToFileURL(fileName).href : fileName, context);
        }
      }
      try {
        return nextResolve(specifier, context);
      } catch (error) {
        if (!relative) {
          const code = (error as NodeJS.ErrnoException).code;
          if (fromProject && (code === "MODULE_NOT_FOUND" || code === "ERR_MODULE_NOT_FOUND")) {
            const importer = fileURLToPath(context.parentURL as string);
            const why =
              project.file === undefined
                ? "No tsconfig.json was found for this project, so only relative imports and installed packages can be resolved."
                : `It is not an installed package and does not match baseUrl or paths in ${project.file}.`;
            throw new Error(`Cannot find module "${specifier}" imported from ${importer}. ${why}`, { cause: error });
          }
          throw error;
        }
        // TypeScript sources import "./user" or "./user.js" for a file named user.ts.
        const base = specifier.replace(/\.[cm]?js$/, "");
        for (const candidate of [`${base}.ts`, `${specifier}.ts`, `${specifier}/index.ts`]) {
          try {
            return nextResolve(candidate, context);
          } catch {
            // Try the next candidate.
          }
        }
        throw error;
      }
    },
    load(url, context, nextLoad) {
      if (!isProjectTypeScript(url)) {
        return nextLoad(url, context);
      }
      const fileName = fileURLToPath(url);
      const esModule = options.esModules === true && isEsModuleFile(fileName);
      const output = ts.transpileModule(readFileSync(fileName, "utf8"), {
        fileName,
        compilerOptions: esModule ? { ...compilerOptions, module: ts.ModuleKind.ESNext } : compilerOptions,
      });
      return { format: esModule ? "module" : "commonjs", source: output.outputText, shortCircuit: true };
    },
  });
}

/** Runs `load` with the TypeScript hooks registered, and removes them afterwards. */
function withTypeScript<T>(ts: Record<string, any>, project: ProjectConfig, load: () => T): T {
  const hooks = registerTypeScript(ts, project);
  try {
    return load();
  } finally {
    hooks.deregister();
  }
}

/** Finds entity files under `path` and loads them inside the project they belong to. */
export function loadEntityFiles(path: string): LoadedProject {
  const root = resolve(path);
  const files = findEntityFiles(root);
  if (files.length === 0) {
    throw new TypeormImportError(`No TypeORM entity files found in ${path}.`);
  }

  // Resolve packages the way the entity files themselves would.
  const projectRequire = createRequire(join(dirname(files[0] as string), "index.js"));
  const requireFromProject = (name: string, why: string): Record<string, any> => {
    try {
      return projectRequire(name);
    } catch (cause) {
      throw new TypeormImportError(`Cannot load "${name}" from the project that contains ${path}. ${why}`, { cause });
    }
  };

  const typeorm = requireFromProject("typeorm", "Run the import inside a project that has TypeORM installed.");
  const exported = new Set<unknown>();
  const loadAll = (): void => {
    for (const file of files) {
      let moduleExports: unknown;
      try {
        moduleExports = projectRequire(file);
      } catch (cause) {
        const reason = cause instanceof Error ? cause.message.split("\n")[0] : String(cause);
        throw new TypeormImportError(`Failed to load ${file}: ${reason}`, { cause });
      }
      if (typeof moduleExports === "object" && moduleExports !== null) {
        for (const value of Object.values(moduleExports)) {
          exported.add(value);
        }
      }
      exported.add(moduleExports);
    }
  };

  if (files.some((file) => TYPESCRIPT_FILE.test(file))) {
    const ts = requireFromProject(
      "typescript",
      "It is needed to read TypeScript entity files. Install it, or point the import at compiled JavaScript.",
    );
    // The nearest tsconfig.json at or above the given path is the project's.
    const directory = files[0] === root ? dirname(root) : root;
    withTypeScript(ts, readProjectConfig(ts, directory), loadAll);
  } else {
    loadAll();
  }
  return { typeorm, files, exported };
}
