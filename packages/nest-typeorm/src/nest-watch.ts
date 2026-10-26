import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, watch } from "node:fs";
import type { FSWatcher } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { startSharedMailCapture } from "../../side-effects/src/index.ts";
import type { MailCapture, SideEffectEvent } from "../../side-effects/src/index.ts";
import { SMTP_CONNECTION_MESSAGE, SMTP_ENVIRONMENT_VARIABLE, findProjectRoot, readNestSandboxConfig } from "./nest-sandbox.ts";

/** Set in the environment of a sandbox process that a watcher started. */
export const WATCHED_ENVIRONMENT_VARIABLE = "LOCAL_DB_SANDBOX_WATCHED";

export type SandboxWatchEvent =
  | { type: "started"; pid: number }
  | { type: "exited"; pid: number; code: number | null }
  | { type: "changed"; files: string[] }
  /** A message was captured by the watcher's mail capture. */
  | { type: "side-effect"; event: SideEffectEvent }
  | { type: "stopped" };

export interface NestSandboxWatchOptions {
  /** `.local-db-sandbox/sandbox.config.json`. */
  configFile: string;
  /** The script that starts the sandbox once. Default: `sandbox.server.ts` next to the config file. */
  script?: string;
  /** Arguments passed on to that script. */
  args?: string[];
  /** How long changes are collected before one restart, in ms (default 150). */
  debounceMs?: number;
  /** How long a stopping sandbox process may take before it is killed, in ms (default 5000). */
  killTimeoutMs?: number;
  /** Receives the watcher's own status lines. Default: printed to stdout. */
  log?: (line: string) => void;
  /** Receives the sandbox process's output. Default: the process writes to this terminal directly. */
  output?: { stdout: { write(text: string): unknown }; stderr: { write(text: string): unknown } };
  /** Source of shutdown signals. Default: `process`. */
  signals?: {
    once(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
    off(event: "SIGINT" | "SIGTERM", listener: () => void): unknown;
  };
  /** Receives one structured event per start, exit, detected change, and stop. */
  onEvent?: (event: SandboxWatchEvent) => void;
}

export interface NestSandboxWatch {
  /** Stops watching and stops the sandbox process; resolves once it has exited. */
  stop(): Promise<void>;
  /** Resolves when the watcher has stopped, by `stop()` or by a signal. Rejects when it could not start what the configuration asks for. */
  closed: Promise<void>;
}

/** Directories whose changes never concern the running application. */
const IGNORED_DIRECTORIES = new Set(["node_modules", ".git", "dist", "build", "coverage", ".local-db-sandbox", ".idea", ".vscode"]);
/** Editor and tool leftovers. */
const IGNORED_FILE = /(~|\.swp|\.swx|\.tmp|\.log)$/;
/** Files directly in the project root that change how the application is built or configured. */
const ROOT_FILE = /^(package\.json|nest-cli\.json|tsconfig.*\.json|\.env.*)$/;

/**
 * Runs the sandbox server and restarts it when the application's sources
 * change.
 *
 * The sandbox itself is a child process started from the generated
 * `sandbox.server.ts`, exactly as without watching. A restart stops that
 * process, waits until it has exited (which frees the port), and starts a new
 * one, which loads the current sources and rebuilds the SQLite runtime from
 * the current JSON database file. The file is never regenerated or cleared.
 *
 * With `"smtp": { "mode": "capture" }` the mail capture runs here, in the
 * watcher, and not in the sandbox process: it listens for as long as the
 * watcher runs, so a restart neither loses captured mail nor closes the port
 * the application sends to. Each sandbox process is told where it is, and
 * tells the watcher which request its connections to it are for.
 *
 * Watched: the entry point's folder, recursively, any `watch` paths of the
 * config, and the project root's `package.json`, `nest-cli.json`,
 * `tsconfig*.json`, and `.env*`. Ignored: the database (file or directory),
 * `node_modules`, `.git`, `dist`, `build`, `coverage`, `.local-db-sandbox`,
 * and editor leftovers.
 *
 * An `fs.watch` event only says where to look. Windows also sends one when a
 * file is merely read: NTFS then writes the file's last-access time, and
 * `fs.watch` reports that like any other change. So the watcher records the
 * modification time and size of every watched file, and restarts only when a
 * file was added or removed or one of the two differs. Setting a new
 * modification time without changing the content (`touch`) therefore
 * restarts, which is the usual way to ask for a restart; reading, opening, or
 * changing other metadata does not.
 */
export function watchNestSandbox(options: NestSandboxWatchOptions): NestSandboxWatch {
  const configFile = resolve(options.configFile);
  const config = readNestSandboxConfig(configFile);
  const script = resolve(options.script ?? join(dirname(configFile), "sandbox.server.ts"));
  const root = findProjectRoot(dirname(config.entry));
  const sources = dirname(config.entry);
  const log = options.log ?? ((line: string) => console.log(line));
  const signals = options.signals ?? process;
  const debounceMs = options.debounceMs ?? 150;
  const killTimeoutMs = options.killTimeoutMs ?? 5000;
  const emit = (event: SandboxWatchEvent): void => {
    try {
      options.onEvent?.(event);
    } catch {
      // A failing listener must not stop the watcher.
    }
  };

  let child: ChildProcess | undefined;
  let exited: Promise<void> = Promise.resolve();
  let restarting = false;
  let restartWanted = false;
  let stopping = false;
  let timer: NodeJS.Timeout | undefined;
  /** Paths that `fs.watch` reported since the last check. */
  const reported = new Set<string>();
  /** Modification time and size of every watched file, as last seen. */
  const known = new Map<string, string>();
  const watchers: FSWatcher[] = [];
  /** The mail capture, when the configuration asks for one. It outlives every sandbox process. */
  let mail: { capture: MailCapture; close(): Promise<void> } | undefined;

  const startChild = (): void => {
    // Node warns on every start that the generated .ts file's module type is detected from its syntax.
    const started = spawn(process.execPath, ["--disable-warning=MODULE_TYPELESS_PACKAGE_JSON", script, ...(options.args ?? [])], {
      env: {
        ...process.env,
        [WATCHED_ENVIRONMENT_VARIABLE]: "1",
        ...(mail !== undefined && { [SMTP_ENVIRONMENT_VARIABLE]: JSON.stringify({ host: mail.capture.host, port: mail.capture.port }) }),
      },
      // The extra channel lets the sandbox process notice when this watcher is gone.
      stdio: options.output === undefined ? ["inherit", "inherit", "inherit", "ipc"] : ["ignore", "pipe", "pipe", "ipc"],
    });
    const pid = started.pid ?? -1;
    started.stdout?.on("data", (chunk) => options.output?.stdout.write(String(chunk)));
    started.stderr?.on("data", (chunk) => options.output?.stderr.write(String(chunk)));
    started.on("message", (message: { type?: unknown; clientPort?: unknown; requestId?: unknown }) => {
      // Which request the next message on a connection of the sandbox process to the capture is for; none when it cannot tell.
      if (message?.type === SMTP_CONNECTION_MESSAGE && typeof message.clientPort === "number") {
        mail?.capture.noteConnection(message.clientPort, typeof message.requestId === "string" ? message.requestId : undefined);
      }
    });
    child = started;
    exited = new Promise((done) => {
      started.once("exit", (code) => {
        if (child === started) {
          child = undefined;
        }
        emit({ type: "exited", pid, code });
        if (!stopping && !restarting) {
          log(`[sandbox] the sandbox process ended (code ${code ?? "none"}); waiting for changes to start it again`);
        }
        done();
      });
    });
    emit({ type: "started", pid });
  };

  /** Stops the sandbox process and waits until it is gone, so that its port is free. */
  const stopChild = async (): Promise<void> => {
    const running = child;
    if (running !== undefined) {
      running.kill();
      const force = setTimeout(() => running.kill("SIGKILL"), killTimeoutMs);
      await exited;
      clearTimeout(force);
    }
  };

  /** One restart at a time; changes that arrive meanwhile lead to one more. */
  const restart = async (): Promise<void> => {
    if (restarting) {
      restartWanted = true;
      return;
    }
    restarting = true;
    do {
      restartWanted = false;
      await stopChild();
      if (!stopping) {
        startChild();
      }
    } while (restartWanted && !stopping);
    restarting = false;
  };

  const isIgnored = (path: string): boolean => {
    // The database: a single file with its temporary sibling, or everything in a database directory. And the record of
    // its owner beside it (D-042), which every sandbox process writes when it starts: a restart for it would never end.
    if (path === config.file || path === `${config.file}.tmp` || path.startsWith(`${config.file}${sep}`) || path.startsWith(`${config.file}.owner.`) || IGNORED_FILE.test(path)) {
      return true;
    }
    return relative(root, path).split(sep).some((segment) => IGNORED_DIRECTORIES.has(segment));
  };

  /** The watched files at or below `path`, each with its modification time and size. None when the path is gone. */
  const filesAt = (path: string, found = new Map<string, string>(), linked = false): Map<string, string> => {
    if (isIgnored(path)) {
      return found;
    }
    try {
      const stats = statSync(path, { bigint: true });
      if (!stats.isDirectory()) {
        found.set(path, `${stats.mtimeNs}:${stats.size}`);
      } else if (!linked) {
        // A linked folder is not entered: it may lead back here.
        for (const entry of readdirSync(path, { withFileTypes: true })) {
          filesAt(join(path, entry.name), found, entry.isSymbolicLink());
        }
      }
    } catch {
      // Removed, or replaced, while it was looked at: the event for that leads to another look.
    }
    return found;
  };

  /** Compares the reported paths with what is known of them, and returns the files that were added, removed, or modified. */
  const takeChanges = (): string[] => {
    const files = new Set<string>();
    for (const path of reported) {
      const current = filesAt(path);
      for (const file of known.keys()) {
        if ((file === path || file.startsWith(`${path}${sep}`)) && !current.has(file)) {
          known.delete(file);
          files.add(file);
        }
      }
      for (const [file, state] of current) {
        if (known.get(file) !== state) {
          known.set(file, state);
          files.add(file);
        }
      }
    }
    reported.clear();
    return [...files].map((file) => relative(root, file).split(sep).join("/")).sort();
  };

  const onChange = (path: string): void => {
    if (stopping || isIgnored(path)) {
      return;
    }
    reported.add(path);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const files = takeChanges();
      if (files.length === 0) {
        return;
      }
      emit({ type: "changed", files });
      log(`[sandbox] ${files.length === 1 ? files[0] : `${files.length} files`} changed; restarting`);
      void restart();
    }, debounceMs);
  };

  const remember = (path: string): void => {
    for (const [file, state] of filesAt(path)) {
      known.set(file, state);
    }
  };

  // Each watcher is in place before its files are recorded, and the sandbox process starts after both:
  // a change is either in what that process loads or in an event that follows.
  const watchTree = (directory: string): void => {
    if (existsSync(directory)) {
      watchers.push(watch(directory, { recursive: true }, (_event, name) => onChange(name === null ? directory : join(directory, name))));
      remember(directory);
    }
  };
  watchTree(sources);
  for (const extra of watchPaths(configFile)) {
    watchTree(extra);
  }
  if (sources !== root) {
    watchers.push(
      watch(root, (_event, name) => {
        if (name !== null && ROOT_FILE.test(name)) {
          onChange(join(root, name));
        }
      }),
    );
    for (const name of readdirSync(root).filter((candidate) => ROOT_FILE.test(candidate))) {
      remember(join(root, name));
    }
  }

  let finish: () => void;
  let fail: (error: unknown) => void;
  const closed = new Promise<void>((done, failed) => {
    finish = done;
    fail = failed;
  });
  // Whoever does not wait for it must not be stopped by it.
  closed.catch(() => undefined);
  let failure: unknown;
  let stopped: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    stopped ??= (async () => {
      stopping = true;
      clearTimeout(timer);
      signals.off("SIGINT", onSignal);
      signals.off("SIGTERM", onSignal);
      for (const watcher of watchers) {
        watcher.close();
      }
      await stopChild();
      await mail?.close();
      emit({ type: "stopped" });
      if (failure === undefined) {
        finish();
      } else {
        fail(failure);
      }
    })();
    return stopped;
  };
  const onSignal = (): void => {
    void stop();
  };
  signals.once("SIGINT", onSignal);
  signals.once("SIGTERM", onSignal);

  log(`[sandbox] watching ${relative(root, sources).split(sep).join("/") || "."} for changes; the sandbox restarts when a source file changes`);
  if (config.smtp?.mode === "capture") {
    // The sandbox process is started once the capture listens: it is told where.
    startSharedMailCapture({
      smtp: config.smtp,
      runtimeFile: config.runtimeFile,
      log,
      onEvent: (event) => emit({ type: "side-effect", event }),
    }).then(
      (started) => {
        mail = started;
        if (stopping) {
          void started.close();
        } else {
          startChild();
        }
      },
      (error: unknown) => {
        failure = error;
        void stop();
      },
    );
  } else {
    startChild();
  }
  return { stop, closed };
}

/** Extra paths to watch, from the `watch` list of the config file. */
function watchPaths(configFile: string): string[] {
  const { watch: paths } = JSON.parse(readFileSync(configFile, "utf8")) as { watch?: unknown };
  if (paths === undefined) {
    return [];
  }
  if (!Array.isArray(paths) || paths.some((path) => typeof path !== "string")) {
    throw new TypeError(`"watch" in ${configFile} must be a list of paths.`);
  }
  return paths.map((path: string) => resolve(dirname(configFile), path));
}
