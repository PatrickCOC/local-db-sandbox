import { SandboxLimitError } from "../../core/src/index.ts";
import { JsonStorageError } from "./storage-error.ts";

/*
 * Size policy for JSON databases. Size on disk (serialized bytes) is the
 * only measure; there is no row-count limit. For a single-file database it is
 * the size of the file; for a directory database it is the total size of the
 * files the database consists of (manifest, schema, and table files).
 */

export const BYTES_PER_MB = 1024 * 1024;

/** From this size a warning is reported. Not configurable. */
export const WARNING_SIZE_MB = 25;
/** From this size a stronger warning is reported. Not configurable. */
export const STRONG_WARNING_SIZE_MB = 75;
/** Hard limit unless the caller starting the sandbox raises it or the file's config lowers it. */
export const DEFAULT_MAX_FILE_SIZE_MB = 150;
/** No setting can put the hard limit above this. */
export const ABSOLUTE_MAX_FILE_SIZE_MB = 250;

export interface SizeWarning {
  /** `strong` from 75 MB, `warning` from 25 MB. */
  level: "warning" | "strong";
  /** Whether the size was seen when loading the file or after saving it. */
  phase: "load" | "save";
  sizeBytes: number;
  /** The threshold that was reached. */
  thresholdBytes: number;
  /** The hard limit in effect. */
  limitBytes: number;
  /** Set to `directory` when the size is the total of a directory database's files. */
  format?: "file" | "directory";
}

export type SizeWarningListener = (warning: SizeWarning) => void;

export function formatMb(bytes: number): string {
  const mb = bytes / BYTES_PER_MB;
  return `${mb >= 10 || Number.isInteger(mb) ? mb.toFixed(mb >= 10 ? 1 : 0) : mb.toFixed(2)} MB`.replace(/\.0 MB$/, " MB");
}

const ADVICE =
  "Local DB Sandbox is intended for small development fixtures; reduce the dataset or split it into multiple sandbox databases.";

/**
 * Checks a maximum file size in MB. Returns a message when it is invalid.
 * `setting` names where the value came from, for the message.
 */
export function maxFileSizeMbProblem(value: unknown, setting = '"$config.limits.maxFileSizeMb"'): string | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0 || value > ABSOLUTE_MAX_FILE_SIZE_MB) {
    return `${setting} must be a number greater than 0 and at most ${ABSOLUTE_MAX_FILE_SIZE_MB}.`;
  }
  return undefined;
}

export function sizeLevel(sizeBytes: number): SizeWarning["level"] | undefined {
  if (sizeBytes >= STRONG_WARNING_SIZE_MB * BYTES_PER_MB) {
    return "strong";
  }
  return sizeBytes >= WARNING_SIZE_MB * BYTES_PER_MB ? "warning" : undefined;
}

export function sizeWarning(sizeBytes: number, limitBytes: number, phase: SizeWarning["phase"]): SizeWarning | undefined {
  const level = sizeLevel(sizeBytes);
  if (level === undefined) {
    return undefined;
  }
  const thresholdMb = level === "strong" ? STRONG_WARNING_SIZE_MB : WARNING_SIZE_MB;
  return { level, phase, sizeBytes, thresholdBytes: thresholdMb * BYTES_PER_MB, limitBytes };
}

/**
 * Throws when `sizeBytes` is above `limitBytes`. A size equal to the limit is
 * allowed. `format` only chooses the wording: for a directory database the
 * size is the total of its files.
 */
export function assertWithinSizeLimit(sizeBytes: number, limitBytes: number, phase: "load" | "save", format: "file" | "directory" = "file"): void {
  if (sizeBytes <= limitBytes) {
    return;
  }
  const subject = format === "directory" ? "database directory" : "database file";
  const what =
    phase === "load"
      ? `The ${subject} is ${formatMb(sizeBytes)}, above the limit of ${formatMb(limitBytes)}, and was not loaded.`
      : `This change would make the ${subject} ${formatMb(sizeBytes)}, above the limit of ${formatMb(limitBytes)}, and was not saved.`;
  throw new SandboxLimitError(`${what} ${ADVICE}`, sizeBytes, limitBytes);
}

/**
 * The hard limit for a database with this configuration: `limits.maxFileSizeMb`
 * in it may lower the ceiling the database was opened with, never raise it.
 */
export function configuredLimitBytes(config: unknown, ceilingBytes: number): number {
  const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
  const limits = isObject(config) ? config.limits : undefined;
  const value = isObject(limits) ? limits.maxFileSizeMb : undefined;
  if (value === undefined) {
    return ceilingBytes;
  }
  const problem = maxFileSizeMbProblem(value);
  if (problem !== undefined) {
    throw new JsonStorageError(problem);
  }
  return Math.min(ceilingBytes, (value as number) * BYTES_PER_MB);
}

/** Reports a size warning when a database is loaded, and after a save only when its level rises. */
export class SizeWatch {
  readonly #listener: SizeWarningListener | undefined;
  readonly #format: "file" | "directory" | undefined;
  #level: SizeWarning["level"] | undefined;

  constructor(listener: SizeWarningListener | undefined, format?: "file" | "directory") {
    this.#listener = listener;
    this.#format = format;
  }

  /** Forgets what was reported, as when the database is loaded anew. */
  reset(): void {
    this.#level = undefined;
  }

  report(sizeBytes: number, limitBytes: number, phase: SizeWarning["phase"]): void {
    const warning = sizeWarning(sizeBytes, limitBytes, phase);
    const changed = warning?.level !== this.#level;
    const rose = warning !== undefined && (this.#level === undefined || warning.level === "strong");
    this.#level = warning?.level;
    if (warning !== undefined && changed && rose) {
      this.#listener?.(this.#format === undefined ? warning : { ...warning, format: this.#format });
    }
  }
}

/** One-line text for a size warning. The structured warning stays the source of truth. */
export function formatSizeWarning(warning: SizeWarning): string {
  const size = `the database ${warning.format === "directory" ? "directory" : "file"} is ${formatMb(warning.sizeBytes)} (limit ${formatMb(warning.limitBytes)})`;
  return warning.level === "strong"
    ? `Strong warning: ${size}. It is close to the size where the sandbox stops working. ${ADVICE}`
    : `Warning: ${size}. Loading and saving will be slow. ${ADVICE}`;
}
