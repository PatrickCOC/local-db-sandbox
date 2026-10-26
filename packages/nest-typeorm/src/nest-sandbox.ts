import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isEsModuleFile, readProjectConfig, registerTypeScript } from "../../import-typeorm/src/index.ts";
import { createSqlLogger } from "../../runtime/src/index.ts";
import type { PersistenceMode, SqlEvent, SqlEventListener, SqlLogMode } from "../../runtime/src/index.ts";
import { SideEffectConfigError, formatUnguardedSideEffects, parseNetworkConfig, parseSmtpConfig, startSideEffects } from "../../side-effects/src/index.ts";
import type { NetworkConfig, SharedCapture, SideEffectEvent, SmtpConfig } from "../../side-effects/src/index.ts";
import { formatSizeWarning } from "../../storage-json/src/index.ts";
import type { SizeWarningListener } from "../../storage-json/src/index.ts";
import { createRequestCorrelation, formatSandboxRequestEvent } from "./request-correlation.ts";
import type { SandboxRequestListener } from "./request-correlation.ts";
import { SandboxModule } from "./sandbox-module.ts";
import type { SandboxDynamicModule } from "./sandbox-module.ts";
import { isSandboxDataSource } from "./typeorm-runtime.ts";

/** Raised when an application cannot be started, or was not fully started, in sandbox mode. */
export class NestSandboxError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "NestSandboxError";
  }
}

export interface NestSandboxOptions {
  /** The application's own entry point, for example `src/main.ts`. */
  entry: string;
  /** Path to the JSON database file. */
  file: string;
  /** Port the sandbox server listens on, whatever port the entry point asks for. */
  port: number;
  /** `json` (default) writes committed changes back to the file; `memory` discards them when the server stops. */
  persistence?: PersistenceMode;
  /**
   * What is printed for each SQL statement executed on the local runtime
   * (default `summary`). `verbose` also prints SQL text and bound parameters,
   * which may contain sensitive data, and one line per HTTP request.
   */
  sqlLog?: SqlLogMode;
  /** Most returned rows shown per statement in `verbose`, and kept on SQL events (default 20; 0 for none). */
  sqlPreviewRows?: number;
  /** Replaces SQL parameters before `verbose` prints them. Nothing is redacted by default. */
  redactSqlParameters?: (parameters: unknown[], event: SqlEvent) => unknown[];
  /** Replaces returned rows before `verbose` prints them. Nothing is redacted by default. */
  redactSqlRows?: (rows: Record<string, unknown>[], event: SqlEvent) => unknown[];
  /** Receives one structured event per SQL statement, whatever `sqlLog` is. */
  onSql?: SqlEventListener;
  /** Receives one structured event per HTTP request, with the ID its SQL events carry. */
  onRequest?: SandboxRequestListener;
  /** Largest database file to accept, in MB (default 150, at most 250). */
  maxFileSizeMb?: number;
  /** Receives a structured warning when the database file is large. Default: printed to stderr. */
  onSizeWarning?: SizeWarningListener;
  /** Receives the sandbox's own status lines. Default: printed to stdout. */
  log?: (line: string) => void;
  /**
   * What to do about the application's mail. Default: nothing. With
   * `mode: "capture"` a local SMTP server keeps what the application sends,
   * and the variables of `env` are set so that the application sends it there.
   */
  smtp?: SmtpConfig;
  /** What to do about TCP connections that leave this machine. Default: nothing (`allow`). */
  network?: NetworkConfig;
  /** Receives one structured event per captured message and per connection the network guard saw. */
  onSideEffect?: (event: SideEffectEvent) => void;
  /** Where to write the file that leads the `mail` command to the capture. Without it, none is written. */
  runtimeFile?: string;
  /** A capture that the process which restarts this one runs, so that mail outlives a restart. None is started here then. */
  sharedCapture?: SharedCapture;
  /** What the sandbox's configuration is called where the sandbox says how mail capture and the network guard are turned on: the path of its file. */
  configuration?: string;
}

/** Set, as `{"host","port"}`, in the environment of a sandbox process whose watcher captures its mail. */
export const SMTP_ENVIRONMENT_VARIABLE = "LOCAL_DB_SANDBOX_SMTP";
/** `type` of the message by which such a process tells its watcher which request a connection to the capture is for. */
export const SMTP_CONNECTION_MESSAGE = "local-db-sandbox:smtp-connection";
/** Written next to the sandbox configuration while a capture runs. */
export const RUNTIME_FILE_NAME = "sandbox.runtime.json";

/** Contents of `.local-db-sandbox/sandbox.config.json`; paths are relative to that file. */
export interface NestSandboxConfig {
  entry: string;
  database: string;
  port: number;
  persistence?: PersistenceMode;
  /** `off`, `summary` (default), or `verbose`. */
  sqlLog?: SqlLogMode;
  /** Most returned rows shown per statement in `verbose` (default 20; 0 for none). */
  sqlPreviewRows?: number;
  /** Older name: `true` is `"sqlLog": "verbose"`, `false` is `"off"`. */
  logSql?: boolean;
  /** Extra folders to watch with `--watch`, besides the entry point's folder. */
  watch?: string[];
  maxFileSizeMb?: number;
  /** `{ "mode": "capture", "port": 2525, "env": { "SMTP_HOST": "{host}", "SMTP_PORT": "{port}" } }`; see `SmtpConfig`. */
  smtp?: SmtpConfig;
  /** `{ "mode": "block", "allow": ["host:port"] }`; see `NetworkConfig`. */
  network?: NetworkConfig;
}

const SQL_LOG_MODES: readonly SqlLogMode[] = ["off", "summary", "verbose"];

function sqlLogMode(value: unknown, where: string): SqlLogMode {
  if (!SQL_LOG_MODES.includes(value as SqlLogMode)) {
    throw new NestSandboxError(`${where} must be "off", "summary", or "verbose".`);
  }
  return value as SqlLogMode;
}

const TYPESCRIPT_FILE = /\.(ts|cts|mts)$/;

/** The one address a sandbox server listens on (D-047): this machine's own, and no network. */
export const LOOPBACK_HOST = "127.0.0.1";

function isPort(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 65535;
}

/** The directory of the nearest package.json at or above `directory`. */
export function findProjectRoot(directory: string): string {
  for (let current = resolve(directory); ; current = dirname(current)) {
    if (existsSync(join(current, "package.json"))) {
      return current;
    }
    if (dirname(current) === current) {
      throw new NestSandboxError(`No package.json was found at or above ${directory}.`);
    }
  }
}

function isNamed(dataSource: unknown): boolean {
  const name = typeof dataSource === "string" ? dataSource : (dataSource as { name?: unknown } | null | undefined)?.name;
  return name !== undefined && name !== "default";
}

/**
 * Starts an existing NestJS + TypeORM application in sandbox mode by running
 * its own entry point, so everything the entry point configures (global
 * prefix, pipes, filters, interceptors, CORS, Swagger, ...) is what runs.
 *
 * Before the entry point is loaded, three things are replaced in the
 * application's own copies of the libraries:
 *
 * - `TypeOrmModule.forRoot` / `forRootAsync` return the sandbox module, so the
 *   application's database options are never used. The DataSource it provides
 *   is a TypeORM DataSource on the sandbox's embedded SQLite runtime;
 * - `DataSource.prototype.initialize` throws for every other DataSource, so
 *   nothing in the process can connect to a database server;
 * - `NestApplication.prototype.listen` listens on the sandbox port, on
 *   127.0.0.1 only, whatever host the application asked for; what the server
 *   then listens on is checked, and a server that is not on 127.0.0.1 is
 *   stopped with an error.
 *
 * Resolves once the entry point has been loaded; the application finishes
 * starting on its own, as it does normally.
 */
export async function startNestSandbox(options: NestSandboxOptions): Promise<void> {
  const log = options.log ?? ((line: string) => console.log(line));
  const entry = resolve(options.entry);
  if (!existsSync(entry)) {
    throw new NestSandboxError(`Entry point does not exist: ${entry}`);
  }
  if (!isPort(options.port)) {
    throw new NestSandboxError("The sandbox port must be an integer from 0 to 65535.");
  }
  const root = findProjectRoot(dirname(entry));
  const projectRequire = createRequire(join(root, "package.json"));
  const load = (name: string): Record<string, any> => {
    try {
      return projectRequire(name);
    } catch (cause) {
      throw new NestSandboxError(`Cannot load "${name}" from ${root}. The sandbox runs inside the application's project and uses its packages.`, { cause });
    }
  };
  const typeorm = load("typeorm");
  const nestTypeorm = load("@nestjs/typeorm");
  const nestCore = load("@nestjs/core");
  const { TypeOrmModule } = nestTypeorm;
  const { NestApplication, NestFactory } = nestCore;
  if (typeof TypeOrmModule?.forRoot !== "function" || typeof NestApplication?.prototype?.listen !== "function") {
    throw new NestSandboxError("This version of @nestjs/typeorm or @nestjs/core is not supported: TypeOrmModule.forRoot or NestApplication.listen was not found.");
  }

  const mode = options.sqlLog ?? "summary";
  if (options.sqlPreviewRows !== undefined && (!Number.isInteger(options.sqlPreviewRows) || options.sqlPreviewRows < 0)) {
    throw new NestSandboxError("The SQL result preview limit must be a whole number of rows, 0 or more.");
  }
  const printSql = createSqlLogger(mode, log, { redact: options.redactSqlParameters, redactRows: options.redactSqlRows });
  const correlation = createRequestCorrelation({
    onRequest: (event) => {
      if (mode === "verbose") {
        log(formatSandboxRequestEvent(event));
      }
      options.onRequest?.(event);
    },
  });

  // Mail capture and the network guard, when the configuration asks for them. Before anything of the application
  // is loaded: its mail settings are read from the environment, which this sets.
  const effects = await startSideEffects({
    smtp: options.smtp,
    network: options.network,
    sharedCapture: options.sharedCapture,
    runtimeFile: options.runtimeFile,
    context: correlation.requestId,
    onEvent: options.onSideEffect,
    log,
  });
  // What is not kept on this machine is said before the application is loaded, and so before it can reach anything:
  // only its database is replaced, and without a capture or a guard its mail and its calls to other services are real.
  // Saying it changes nothing: nothing is turned on that the configuration did not ask for.
  for (const line of formatUnguardedSideEffects(effects.status, { configuration: options.configuration ?? 'the options "smtp" and "network" of startNestSandbox' })) {
    log(line);
  }

  // One module object, however often the application asks for the root module.
  let replaced: SandboxDynamicModule | undefined;
  const sandboxModule = (method: string, moduleOptions: unknown): SandboxDynamicModule => {
    if (isNamed(moduleOptions)) {
      throw new NestSandboxError(
        `TypeOrmModule.${method}() was called for the data source "${String((moduleOptions as { name: unknown }).name)}". ` +
          "Sandbox mode replaces the default data source only; named and multiple data sources are not supported.",
      );
    }
    replaced ??= SandboxModule.forLoadedEntities({
      file: options.file,
      typeorm,
      maxFileSizeMb: options.maxFileSizeMb,
      persistence: options.persistence,
      onSizeWarning: options.onSizeWarning ?? ((warning) => console.error(formatSizeWarning(warning))),
      // Every statement is numbered within its request; SQL outside any request is "background".
      sqlContext: correlation.sqlContext,
      // Row values are only kept for the verbose log, or for a listener that may want them.
      sqlPreviewRows: mode === "verbose" || options.onSql !== undefined ? options.sqlPreviewRows : 0,
      onSql: (event) => {
        correlation.record(event);
        printSql?.(event);
        options.onSql?.(event);
      },
      onWarnings: (warnings) => {
        for (const warning of warnings) {
          console.error(`Warning: ${warning}`);
        }
      },
    });
    return replaced;
  };
  TypeOrmModule.forRoot = (moduleOptions?: unknown) => sandboxModule("forRoot", moduleOptions);
  TypeOrmModule.forRootAsync = (moduleOptions?: unknown) => sandboxModule("forRootAsync", moduleOptions);

  const forFeature = TypeOrmModule.forFeature;
  TypeOrmModule.forFeature = (entities?: unknown, dataSource?: unknown) => {
    if (isNamed(dataSource)) {
      throw new NestSandboxError(
        "TypeOrmModule.forFeature() was called for a named data source. Sandbox mode replaces the default data source only.",
      );
    }
    return forFeature.call(TypeOrmModule, entities);
  };

  const initialize = typeorm.DataSource.prototype.initialize;
  typeorm.DataSource.prototype.initialize = function sandboxInitialize(this: { options?: { type?: unknown } }): unknown {
    if (isSandboxDataSource(this)) {
      return initialize.call(this);
    }
    throw new NestSandboxError(
      `A TypeORM DataSource (type "${String(this.options?.type)}") was about to connect to a real database in sandbox mode. ` +
        "Only TypeOrmModule.forRoot() / forRootAsync() of the default data source is replaced; data sources the application creates itself are not supported.",
    );
  };

  NestFactory.createMicroservice = (): never => {
    throw new NestSandboxError("NestFactory.createMicroservice() is not supported in sandbox mode; only HTTP applications created with NestFactory.create() are.");
  };

  let listening = false;
  const listen = NestApplication.prototype.listen;
  NestApplication.prototype.listen = async function sandboxListen(this: any, requested: unknown, ...rest: unknown[]) {
    if (replaced === undefined) {
      throw new NestSandboxError(
        "The application is starting without having called TypeOrmModule.forRoot() or forRootAsync(), so there was nothing for the sandbox to replace. " +
          "Applications that set up TypeORM in another way are not supported.",
      );
    }
    // Requests are tagged on Node's HTTP server, below whichever web framework the application uses.
    const httpServer = typeof this.getHttpServer === "function" ? this.getHttpServer() : undefined;
    if (typeof httpServer?.emit === "function") {
      correlation.attach(httpServer);
    }
    // `listen(port, hostname?, callback?)`: the host is the sandbox's, this machine's own address (D-047), whatever the
    // application asked for; a callback it gave is kept. Its own start, without the sandbox, is not touched.
    const askedHost = typeof rest[0] === "string" ? rest[0] : undefined;
    const server = await listen.call(this, options.port, LOOPBACK_HOST, ...(askedHost === undefined ? rest : rest.slice(1)));
    // What the server listens on, as the operating system has it, and not what was asked for.
    const address = (typeof this.getHttpServer === "function" ? this.getHttpServer() : undefined)?.address?.();
    if (address === null || typeof address !== "object" || address.address !== LOOPBACK_HOST) {
      await this.close().catch(() => undefined);
      throw new NestSandboxError(
        `The sandbox server was to listen on ${LOOPBACK_HOST} only, and it listens on ${typeof address === "object" && address !== null ? address.address : String(address)}. It was stopped. ` +
          "The application's HTTP adapter does not take the host it is given; such an adapter is not supported in sandbox mode.",
      );
    }
    listening = true;
    log(
      `Local DB Sandbox: application running at ${await this.getUrl()}\n` +
        `  database: ${options.file}\n` +
        `  the entry point asked for port ${String(requested)}${askedHost === undefined ? "" : ` on ${askedHost}`}; the sandbox uses ${options.port} on ${LOOPBACK_HOST} (this machine only) instead.`,
    );
    return server;
  };
  process.once("beforeExit", () => {
    if (!listening) {
      console.error(`Error: ${entry} finished without calling app.listen(), so no sandbox server was started.`);
      process.exitCode = 1;
    }
  });

  if (!TYPESCRIPT_FILE.test(entry)) {
    await import(pathToFileURL(entry).href);
    return;
  }
  // Decorators need a real compile step, done with the project's own TypeScript and tsconfig.
  const ts = load("typescript");
  registerTypeScript(ts, readProjectConfig(ts, dirname(entry)), { root, esModules: true });
  if (isEsModuleFile(entry)) {
    await import(pathToFileURL(entry).href);
  } else {
    projectRequire(entry);
  }
}

/** Reads `sandbox.config.json` into options for `startNestSandbox`. */
export function readNestSandboxConfig(configFile: string): NestSandboxOptions {
  const file = resolve(configFile);
  let config: Partial<NestSandboxConfig>;
  try {
    config = JSON.parse(readFileSync(file, "utf8"));
  } catch (cause) {
    throw new NestSandboxError(`Cannot read ${file}. Run "local-db-sandbox init-nest" to create it.`, { cause });
  }
  if (typeof config?.entry !== "string" || typeof config.database !== "string" || !isPort(config.port)) {
    throw new NestSandboxError(`${file} must contain "entry" and "database" paths and a "port" from 0 to 65535.`);
  }
  let smtp: SmtpConfig | undefined;
  let network: NetworkConfig | undefined;
  try {
    smtp = config.smtp === undefined ? undefined : parseSmtpConfig(config.smtp, `"smtp" in ${file}`);
    network = config.network === undefined ? undefined : parseNetworkConfig(config.network, `"network" in ${file}`);
  } catch (error) {
    if (error instanceof SideEffectConfigError) {
      throw new NestSandboxError(error.message);
    }
    throw error;
  }
  return {
    entry: resolve(dirname(file), config.entry),
    file: resolve(dirname(file), config.database),
    port: config.port,
    ...(config.persistence !== undefined && { persistence: config.persistence }),
    ...(config.sqlLog !== undefined
      ? { sqlLog: sqlLogMode(config.sqlLog, `"sqlLog" in ${file}`) }
      : config.logSql !== undefined && { sqlLog: config.logSql ? ("verbose" as const) : ("off" as const) }),
    ...(config.sqlPreviewRows !== undefined && { sqlPreviewRows: config.sqlPreviewRows }),
    ...(config.maxFileSizeMb !== undefined && { maxFileSizeMb: config.maxFileSizeMb }),
    ...(smtp !== undefined && { smtp }),
    ...(network !== undefined && { network }),
    // Only a sandbox that captures mail writes it.
    ...(smtp?.mode === "capture" && { runtimeFile: join(dirname(file), RUNTIME_FILE_NAME) }),
    configuration: shownPath(file),
  };
}

/** A path as it is said to whoever started the sandbox: from where they are, when it is below that. */
function shownPath(file: string): string {
  const fromHere = relative(process.cwd(), file);
  return (fromHere === "" || fromHere.startsWith("..") || isAbsolute(fromHere) ? file : fromHere).replaceAll("\\", "/");
}

/** The capture of the watcher that started this process, from the environment it gave it. */
function sharedCaptureOfWatcher(): SharedCapture | undefined {
  const announced = process.env[SMTP_ENVIRONMENT_VARIABLE];
  if (announced === undefined || process.send === undefined) {
    return undefined;
  }
  let address: { host?: unknown; port?: unknown };
  try {
    address = JSON.parse(announced);
  } catch {
    return undefined;
  }
  if (typeof address.host !== "string" || !isPort(address.port)) {
    return undefined;
  }
  return {
    host: address.host,
    port: address.port,
    note: (clientPort, requestId) => {
      // The watcher may be gone; this process then ends by itself.
      if (process.connected) {
        process.send?.({ type: SMTP_CONNECTION_MESSAGE, clientPort, requestId });
      }
    },
  };
}

/**
 * Starts the sandbox described by a `sandbox.config.json`. Used by the
 * generated `sandbox.server.ts`: a failure is printed and sets the exit code.
 *
 * Arguments of the script:
 * - `--watch`: keep running and restart the sandbox when the application's
 *   sources change (see `watchNestSandbox`). Without it the sandbox is started
 *   once, in this process.
 * - `--sql-log=off|summary|verbose`: overrides `sqlLog` of the config file.
 * - `--sql-preview-rows=<n>`: overrides `sqlPreviewRows` of the config file.
 */
export async function runNestSandbox(configFile: string, argv: string[] = process.argv.slice(2)): Promise<void> {
  try {
    const unknown = argv.find((argument) => argument !== "--watch" && !argument.startsWith("--sql-log=") && !argument.startsWith("--sql-preview-rows="));
    if (unknown !== undefined) {
      throw new NestSandboxError(`Unknown option ${unknown}. Options: --watch, --sql-log=off|summary|verbose, --sql-preview-rows=<n>.`);
    }
    const options = readNestSandboxConfig(configFile);
    const sqlLog = argv.find((argument) => argument.startsWith("--sql-log="))?.slice("--sql-log=".length);
    if (sqlLog !== undefined) {
      options.sqlLog = sqlLogMode(sqlLog, "--sql-log");
    }
    const previewRows = argv.find((argument) => argument.startsWith("--sql-preview-rows="))?.slice("--sql-preview-rows=".length);
    if (previewRows !== undefined) {
      options.sqlPreviewRows = /^[0-9]+$/.test(previewRows) ? Number(previewRows) : Number.NaN;
    }
    if (argv.includes("--watch")) {
      // Imported here because the watcher imports this module.
      const { watchNestSandbox } = await import("./nest-watch.ts");
      await watchNestSandbox({ configFile, script: process.argv[1], args: argv.filter((argument) => argument !== "--watch") }).closed;
      return;
    }
    if (process.env.LOCAL_DB_SANDBOX_WATCHED === "1" && process.send !== undefined) {
      // Started by a watcher: do not outlive it, or the port would stay taken.
      process.once("disconnect", () => process.exit(0));
      // The channel to the watcher alone must not keep a failed start alive.
      process.channel?.unref();
      // A watcher that captures mail does so for every process it starts; this one starts no capture of its own.
      options.sharedCapture = sharedCaptureOfWatcher();
    }
    await startNestSandbox(options);
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
