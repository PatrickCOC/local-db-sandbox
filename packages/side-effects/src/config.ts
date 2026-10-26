import { NETWORK_GUARD_MODES, allowListProblem } from "./network-guard.ts";
import type { NetworkGuardMode } from "./network-guard.ts";
import { DEFAULT_SMTP_HOST, DEFAULT_SMTP_PORT, isLoopbackHost } from "./smtp-server.ts";

/*
 * What a sandbox configuration says about the things an application does
 * besides using its database. Both parts are off unless the configuration
 * turns them on: a sandbox that is not told to does not touch the
 * application's mail or its network connections.
 */

/** `"smtp"` in a sandbox configuration. */
export interface SmtpConfig {
  /** `off` (default): the sandbox does nothing about mail. `capture`: it runs a local SMTP server that keeps what it is sent. */
  mode: "off" | "capture";
  /** Where the capture listens: a loopback address (default 127.0.0.1). */
  host?: string;
  /** Default 2525; 0 for any free port. */
  port?: number;
  /**
   * Environment variables to set for the application, by name, so that its
   * own mail settings lead to the capture. In a value, `{host}`, `{port}`,
   * and `{url}` (`smtp://host:port`) stand for where the capture listens.
   * Nothing is set that is not listed here.
   */
  env?: Record<string, string>;
  /** `none` (default): AUTH is not offered, so credentials are not sent. `accept`: offered, for clients that insist; whatever they send is dropped. */
  auth?: "none" | "accept";
  /** Most messages kept in memory (default 500). */
  maxMessages?: number;
}

/** `"network"` in a sandbox configuration. */
export interface NetworkConfig {
  /** `allow` (default), `warn`, or `block`: what happens to a TCP connection that leaves this machine. */
  mode: NetworkGuardMode;
  /** Hosts that may be connected to although they are not this machine: `host`, `host:port`, or `*.domain`. */
  allow?: string[];
}

export class SideEffectConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SideEffectConfigError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unknownKey(value: Record<string, unknown>, known: string[], where: string): void {
  const key = Object.keys(value).find((candidate) => !known.includes(candidate));
  if (key !== undefined) {
    throw new SideEffectConfigError(`${where} has the unknown key "${key}". Its keys are ${known.join(", ")}.`);
  }
}

/** Checks `"smtp"` of a configuration. `where` names it in messages. */
export function parseSmtpConfig(value: unknown, where: string): SmtpConfig {
  if (!isPlainObject(value)) {
    throw new SideEffectConfigError(`${where} must be an object, such as { "mode": "capture" }.`);
  }
  unknownKey(value, ["mode", "host", "port", "env", "auth", "maxMessages"], where);
  if (value.mode !== "off" && value.mode !== "capture") {
    throw new SideEffectConfigError(`"mode" in ${where} must be "off" or "capture".`);
  }
  const config: SmtpConfig = { mode: value.mode };
  if (value.host !== undefined) {
    if (typeof value.host !== "string" || !isLoopbackHost(value.host)) {
      throw new SideEffectConfigError(
        `"host" in ${where} must be a loopback address (127.0.0.1, ::1, or localhost). The capture is for the application that runs in the sandbox, on this machine, and is not opened to others.`,
      );
    }
    config.host = value.host;
  }
  if (value.port !== undefined) {
    if (typeof value.port !== "number" || !Number.isInteger(value.port) || value.port < 0 || value.port > 65535) {
      throw new SideEffectConfigError(`"port" in ${where} must be a whole number from 0 to 65535.`);
    }
    config.port = value.port;
  }
  if (value.env !== undefined) {
    if (!isPlainObject(value.env)) {
      throw new SideEffectConfigError(`"env" in ${where} must be an object of environment variable names and their values.`);
    }
    config.env = {};
    for (const [name, setting] of Object.entries(value.env)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new SideEffectConfigError(`"${name}" in "env" of ${where} is not a name an environment variable can have.`);
      }
      if (typeof setting !== "string" && typeof setting !== "number" && typeof setting !== "boolean") {
        throw new SideEffectConfigError(`"${name}" in "env" of ${where} must be text, a number, or true or false.`);
      }
      config.env[name] = String(setting);
    }
  }
  if (value.auth !== undefined) {
    if (value.auth !== "none" && value.auth !== "accept") {
      throw new SideEffectConfigError(`"auth" in ${where} must be "none" or "accept".`);
    }
    config.auth = value.auth;
  }
  if (value.maxMessages !== undefined) {
    if (typeof value.maxMessages !== "number" || !Number.isInteger(value.maxMessages) || value.maxMessages < 1) {
      throw new SideEffectConfigError(`"maxMessages" in ${where} must be a whole number, 1 or more.`);
    }
    config.maxMessages = value.maxMessages;
  }
  return config;
}

/** Checks `"network"` of a configuration. `where` names it in messages. */
export function parseNetworkConfig(value: unknown, where: string): NetworkConfig {
  if (!isPlainObject(value)) {
    throw new SideEffectConfigError(`${where} must be an object, such as { "mode": "block" }.`);
  }
  unknownKey(value, ["mode", "allow"], where);
  if (!NETWORK_GUARD_MODES.includes(value.mode as NetworkGuardMode)) {
    throw new SideEffectConfigError(`"mode" in ${where} must be "allow", "warn", or "block".`);
  }
  const config: NetworkConfig = { mode: value.mode as NetworkGuardMode };
  if (value.allow !== undefined) {
    const problem = Array.isArray(value.allow) ? allowListProblem(value.allow) : "it must be a list of hosts.";
    if (problem !== undefined) {
      throw new SideEffectConfigError(`"allow" in ${where}: ${problem}`);
    }
    config.allow = value.allow as string[];
  }
  return config;
}

/** Where a capture listens, as a client is to be given it. */
export function smtpAddress(config: SmtpConfig): { host: string; port: number } {
  return { host: config.host ?? DEFAULT_SMTP_HOST, port: config.port ?? DEFAULT_SMTP_PORT };
}

/** The environment variables of `"smtp.env"`, with `{host}`, `{port}`, and `{url}` filled in for a capture that listens at `address`. */
export function smtpEnvironment(env: Record<string, string> | undefined, address: { host: string; port: number }): Record<string, string> {
  const host = address.host.includes(":") ? `[${address.host.replace(/^\[|\]$/g, "")}]` : address.host;
  const values: Record<string, string> = { host: address.host, port: String(address.port), url: `smtp://${host}:${address.port}` };
  return Object.fromEntries(Object.entries(env ?? {}).map(([name, value]) => [name, value.replace(/\{(host|port|url)\}/g, (_match, key: string) => values[key] as string)]));
}
