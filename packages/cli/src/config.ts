import type { SimulationConfig, SimulationRule } from "../../server/src/index.ts";
import { maxFileSizeMbProblem } from "../../storage-json/src/index.ts";

/**
 * The `$config` object of a database file:
 *
 *   {
 *     "server":   { "host": "127.0.0.1", "port": 4783 },
 *     "limits":   { "maxFileSizeMb": 150 },
 *     "defaults": { "delayMs": 100 },
 *     "routes":   { "GET /users": { "empty": true } }
 *   }
 *
 * `defaults` applies to every request and `routes` overrides it per route.
 * All keys are optional. Unknown keys are rejected so typos are noticed.
 */
export interface SandboxConfig {
  host?: string;
  port?: number;
  /** Lowers the database file size limit. Enforced by the storage adapter; it cannot raise the limit. */
  maxFileSizeMb?: number;
  simulation: SimulationConfig;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function section(parent: Record<string, unknown>, key: string, allowed?: string[]): Record<string, unknown> {
  const value = parent[key] ?? {};
  if (!isObject(value)) {
    throw new ConfigError(`"$config.${key}" must be an object.`);
  }
  if (allowed !== undefined) {
    rejectUnknownKeys(value, allowed, `$config.${key}`);
  }
  return value;
}

function rejectUnknownKeys(value: Record<string, unknown>, allowed: string[], where: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) {
    throw new ConfigError(`Unknown key "${unknown}" in "${where}". Allowed keys: ${allowed.join(", ")}.`);
  }
}

export function isPort(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 65535;
}

/** Validates the structure of `$config`. Simulation rules are validated by the server. */
export function parseSandboxConfig(raw: unknown): SandboxConfig {
  if (raw === undefined) {
    return { simulation: {} };
  }
  if (!isObject(raw)) {
    throw new ConfigError('"$config" must be an object.');
  }
  rejectUnknownKeys(raw, ["server", "limits", "defaults", "routes"], "$config");

  const server = section(raw, "server", ["host", "port"]);
  const limits = section(raw, "limits", ["maxFileSizeMb"]);
  const defaults = section(raw, "defaults", ["delayMs", "status", "error", "empty"]);
  const routes = section(raw, "routes");

  const config: SandboxConfig = {
    simulation: { ...(defaults as SimulationRule), routes: routes as Record<string, SimulationRule> },
  };
  if (server.host !== undefined) {
    if (typeof server.host !== "string" || server.host === "") {
      throw new ConfigError('"$config.server.host" must be a non-empty string.');
    }
    config.host = server.host;
  }
  if (limits.maxFileSizeMb !== undefined) {
    const problem = maxFileSizeMbProblem(limits.maxFileSizeMb);
    if (problem !== undefined) {
      throw new ConfigError(problem);
    }
    config.maxFileSizeMb = limits.maxFileSizeMb as number;
  }
  if (server.port !== undefined) {
    if (!isPort(server.port)) {
      throw new ConfigError('"$config.server.port" must be an integer from 0 to 65535.');
    }
    config.port = server.port;
  }
  return config;
}
