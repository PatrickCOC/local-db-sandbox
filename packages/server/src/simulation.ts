/**
 * Request-level simulation: artificial latency, forced status codes, forced
 * errors, and empty results. This is plain data so it can later be loaded
 * from a config source; it never reaches the core.
 */
export interface SimulatedError {
  /** Defaults to 500. */
  status?: number;
  /** Defaults to "SIMULATED_ERROR". */
  code?: string;
  message?: string;
}

export interface SimulationRule {
  /** Wait this long before handling the request. */
  delayMs?: number;
  /** Respond with this status code; the operation still runs and its body is kept. */
  status?: number | null;
  /** Respond with this error instead of running the operation. */
  error?: SimulatedError | null;
  /** Successful list responses return no rows. */
  empty?: boolean;
}

export interface SimulationConfig extends SimulationRule {
  /**
   * Per-route overrides keyed by "[METHOD] /path", for example "/users",
   * "GET /users", or "DELETE /users/:id". A ":name" segment matches any value.
   */
  routes?: Record<string, SimulationRule>;
}

export interface ResolvedSimulation {
  delayMs: number;
  status: number | undefined;
  error: Required<SimulatedError> | undefined;
  empty: boolean;
}

export class SimulationConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SimulationConfigError";
  }
}

interface CompiledRoute {
  method: string | undefined;
  segments: string[];
  literals: number;
  rule: SimulationRule;
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkStatus(value: unknown, where: string): void {
  if (!Number.isInteger(value) || (value as number) < 200 || (value as number) > 599) {
    throw new SimulationConfigError(`${where} must be an integer from 200 to 599.`);
  }
}

function checkRule(rule: unknown, where: string): asserts rule is SimulationRule {
  if (!isObject(rule)) {
    throw new SimulationConfigError(`${where} must be an object.`);
  }
  const { delayMs, status, error, empty } = rule;
  if (delayMs !== undefined && (typeof delayMs !== "number" || !Number.isFinite(delayMs) || delayMs < 0)) {
    throw new SimulationConfigError(`${where}.delayMs must be a non-negative number.`);
  }
  if (status !== undefined && status !== null) {
    checkStatus(status, `${where}.status`);
  }
  if (empty !== undefined && typeof empty !== "boolean") {
    throw new SimulationConfigError(`${where}.empty must be a boolean.`);
  }
  if (error !== undefined && error !== null) {
    if (!isObject(error)) {
      throw new SimulationConfigError(`${where}.error must be an object.`);
    }
    if (error.status !== undefined) {
      checkStatus(error.status, `${where}.error.status`);
    }
    for (const key of ["code", "message"] as const) {
      if (error[key] !== undefined && typeof error[key] !== "string") {
        throw new SimulationConfigError(`${where}.error.${key} must be a string.`);
      }
    }
  }
}

function compileRoute(key: string, rule: unknown): CompiledRoute {
  const where = `Simulation route "${key}"`;
  const match = /^(?:([A-Za-z]+)\s+)?(\/\S*)$/.exec(key.trim());
  if (match === null) {
    throw new SimulationConfigError(`${where} must look like "/path" or "METHOD /path".`);
  }
  const method = match[1]?.toUpperCase();
  if (method !== undefined && !METHODS.includes(method)) {
    throw new SimulationConfigError(`${where} uses an unsupported method.`);
  }
  checkRule(rule, where);
  const segments = (match[2] as string).split("/").filter((segment) => segment !== "");
  return { method, segments, literals: segments.filter((segment) => !segment.startsWith(":")).length, rule };
}

function matches(route: CompiledRoute, method: string, segments: string[]): boolean {
  return (
    (route.method === undefined || route.method === method) &&
    route.segments.length === segments.length &&
    route.segments.every((segment, i) => segment.startsWith(":") || segment === segments[i])
  );
}

/**
 * Validates a simulation config and returns a resolver for requests.
 *
 * Precedence (see D-011):
 * 1. At most one route applies: the match with the most literal path
 *    segments, then one that names a method, then the first declared.
 * 2. Each field set on that route replaces the top-level default; `null`
 *    (or `0` / `false`) on the route turns a default off.
 * 3. Within the resulting rule: delay always applies, then `error` wins
 *    over `empty` and `status`.
 */
export function compileSimulation(
  config: SimulationConfig = {},
): (method: string, segments: string[] | undefined) => ResolvedSimulation {
  checkRule(config, "Simulation config");
  if (config.routes !== undefined && !isObject(config.routes)) {
    throw new SimulationConfigError("Simulation config.routes must be an object.");
  }
  const routes = Object.entries(config.routes ?? {}).map(([key, rule]) => compileRoute(key, rule));
  // Stable sort keeps declaration order among equally specific routes.
  routes.sort((a, b) => b.literals - a.literals || Number(b.method !== undefined) - Number(a.method !== undefined));

  return (method, segments) => {
    const route = segments === undefined ? undefined : routes.find((candidate) => matches(candidate, method, segments));
    const rule: SimulationRule = { ...config, ...definedFields(route?.rule) };
    const error = rule.error ?? undefined;
    return {
      delayMs: rule.delayMs ?? 0,
      status: rule.status ?? undefined,
      empty: rule.empty ?? false,
      error: error && {
        status: error.status ?? 500,
        code: error.code ?? "SIMULATED_ERROR",
        message: error.message ?? "Simulated error.",
      },
    };
  };
}

function definedFields(rule: SimulationRule | undefined): SimulationRule {
  return Object.fromEntries(Object.entries(rule ?? {}).filter(([, value]) => value !== undefined));
}
