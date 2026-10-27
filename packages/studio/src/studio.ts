import type { DatabaseFormat } from "../../storage-json/src/index.ts";
import { startStudioServer } from "./server.ts";
import type { StudioExporter } from "./server.ts";
import { openStudioSession } from "./session.ts";
import type { StudioMode, StudioSessionOptions, StudioStatus } from "./session.ts";

/* Local DB Studio as one thing to start and stop: a session on a database (`session.ts`), and the page for it (`server.ts`). */

export interface StartStudioOptions extends StudioSessionOptions {
  /** Port of the page (default 4583; 0 for any free port). It is served on this machine's own address, always. */
  port?: number;
  /** The address of a local API that the API tab starts from. Only a loopback address is taken. */
  api?: string;
  /** What writes the Export tab's script. */
  exporter?: StudioExporter;
}

export interface RunningStudio {
  /** `http://127.0.0.1:<port>`. */
  url: string;
  port: number;
  /** The key of this session. */
  key: string;
  /** The address to open in a browser: the page, with the key behind a `#`. */
  address: string;
  /** Whether Studio has the database to itself, or looks into it through the process that has it open. */
  mode: StudioMode;
  /** The database, by its canonical path. */
  database: string;
  format: DatabaseFormat;
  /** What Studio has to say about how it opened the database. */
  notices: string[];
  status(): Promise<StudioStatus>;
  /** Stops the page, and ends the session: a database Studio had to itself is let go of. Harmless when done twice. */
  stop(): Promise<void>;
}

/** Opens a database in Studio, and serves the page for it. */
export async function startStudio(options: StartStudioOptions): Promise<RunningStudio> {
  const session = await openStudioSession(options);
  let server;
  try {
    server = await startStudioServer({
      session,
      ...(options.port !== undefined && { port: options.port }),
      ...(options.api !== undefined && { api: options.api }),
      ...(options.exporter !== undefined && { exporter: options.exporter }),
    });
  } catch (error) {
    await session.close();
    throw error;
  }
  const serving = server;
  let stopped: Promise<void> | undefined;
  return {
    url: serving.url,
    port: serving.port,
    key: serving.key,
    address: serving.address,
    mode: session.mode,
    database: session.database,
    format: session.format,
    notices: session.notices,
    status: () => session.status(),
    stop() {
      stopped ??= (async () => {
        try {
          await serving.stop();
        } finally {
          await session.close();
        }
      })();
      return stopped;
    },
  };
}
