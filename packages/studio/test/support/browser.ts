import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

/*
 * A browser to look at Studio's page with, as a person's browser shows it:
 * a Chromium-based browser that is installed on this machine (Chrome, Edge,
 * Chromium), run headless with a profile of its own that is thrown away,
 * and told what to do over its DevTools protocol. No package is installed
 * for this: the protocol is JSON over a WebSocket, which Node has.
 *
 * A machine without such a browser has no such test: `openBrowser` gives
 * `undefined`, and says why.
 */

const CANDIDATES: Record<string, string[]> = {
  win32: [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
  ],
  darwin: ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "/Applications/Chromium.app/Contents/MacOS/Chromium"],
  linux: ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/microsoft-edge"],
};

/** Set to a browser's path to use that one, or to `none` to have no browser. */
const CHOICE = "LOCAL_DB_SANDBOX_TEST_BROWSER";

export interface Browser {
  /** What went wrong in the page: exceptions of its script, and what the browser refused it. */
  problems: string[];
  open(url: string): Promise<void>;
  /** The value of an expression in the page; a promise is waited for. */
  evaluate<T = unknown>(expression: string): Promise<T>;
  /** Waits until an expression is true in the page; fails with what the page shows when it never is. */
  until(expression: string, what: string, timeoutMs?: number): Promise<void>;
  /** A real mouse: pressed, moved, or released at a point of the page (CSS pixels), or its wheel turned there. */
  mouse(type: "mousePressed" | "mouseMoved" | "mouseReleased" | "mouseWheel", x: number, y: number, deltaY?: number): Promise<void>;
  /** What the page shows now, as a PNG. */
  screenshot(): Promise<Buffer>;
  close(): Promise<void>;
}

export function findBrowser(): string | undefined {
  const chosen = process.env[CHOICE];
  if (chosen !== undefined) {
    return chosen !== "none" && existsSync(chosen) ? chosen : undefined;
  }
  return (CANDIDATES[process.platform] ?? []).find((path) => existsSync(path));
}

/** Starts the browser. `undefined` with a reason when there is none, or it does not start. */
export async function openBrowser(): Promise<{ browser?: Browser; unavailable?: string }> {
  const path = findBrowser();
  if (path === undefined) {
    return { unavailable: `no Chromium-based browser was found on this machine (set ${CHOICE} to the path of one)` };
  }
  if (typeof WebSocket !== "function") {
    return { unavailable: "this Node has no WebSocket client" };
  }
  const profile = await mkdtemp(join(tmpdir(), "local-db-sandbox-browser-"));
  const child: ChildProcess = spawn(path, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--window-size=1400,1000", "about:blank"], { stdio: "ignore" });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const discard = async (): Promise<void> => {
    child.kill();
    await Promise.race([exited, delay(5000)]);
    await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }).catch(() => undefined);
  };

  // The browser says in its profile which port it listens on for this.
  let endpoint: string | undefined;
  for (let waited = 0; waited < 200 && endpoint === undefined; waited += 1) {
    await delay(100);
    try {
      const [port] = readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n");
      const pages = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as { type: string; webSocketDebuggerUrl: string }[];
      endpoint = pages.find((page) => page.type === "page")?.webSocketDebuggerUrl;
    } catch {
      // Not there yet.
    }
  }
  if (endpoint === undefined) {
    await discard();
    return { unavailable: `the browser at ${path} did not start` };
  }

  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve);
    socket.addEventListener("error", reject);
  });
  let last = 0;
  const waiting = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  const problems: string[] = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (message.id !== undefined) {
      const asked = waiting.get(message.id);
      waiting.delete(message.id);
      if (message.error) {
        asked?.reject(new Error(JSON.stringify(message.error)));
      } else {
        asked?.resolve(message.result);
      }
    } else if (message.method === "Runtime.exceptionThrown") {
      problems.push(`exception: ${message.params.exceptionDetails.text} ${message.params.exceptionDetails.exception?.description ?? ""}`);
    } else if (message.method === "Log.entryAdded" && message.params.entry.source === "security") {
      // What the browser refused the page: something its Content-Security-Policy does not allow.
      problems.push(`refused: ${message.params.entry.text}`);
    }
  });
  const send = (method: string, params: object = {}): Promise<any> =>
    new Promise((resolve, reject) => {
      last += 1;
      waiting.set(last, { resolve, reject });
      socket.send(JSON.stringify({ id: last, method, params }));
    });
  await send("Page.enable");
  await send("Runtime.enable");
  await send("Log.enable");

  const evaluate = async <T>(expression: string): Promise<T> => {
    const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(`in the page: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}\n  ${expression.slice(0, 300)}`);
    }
    return result.result.value as T;
  };
  return {
    browser: {
      problems,
      evaluate,
      async open(url) {
        await send("Page.navigate", { url });
      },
      async until(expression, what, timeoutMs = 20_000) {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          if (await evaluate(expression).catch(() => false)) {
            return;
          }
          if (Date.now() > deadline) {
            throw new Error(`never happened: ${what}\nThe page shows:\n${await evaluate<string>("document.body ? document.body.innerText.slice(0, 1200) : '(nothing)'").catch(() => "(it cannot be asked)")}`);
          }
          await delay(100);
        }
      },
      async mouse(type, x, y, deltaY) {
        await send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" || type === "mouseWheel" ? "none" : "left", buttons: type === "mouseReleased" || type === "mouseWheel" ? 0 : 1, clickCount: type === "mouseMoved" || type === "mouseWheel" ? 0 : 1, ...(type === "mouseWheel" && { deltaX: 0, deltaY: deltaY ?? 0 }) });
      },
      async screenshot() {
        return Buffer.from((await send("Page.captureScreenshot", { format: "png" })).data, "base64");
      },
      async close() {
        socket.close();
        await discard();
      },
    },
  };
}

/** What a person does on the page, given to the page as functions: press the button that says something, fill a box, read a grid. */
export const PAGE_HELPERS = String.raw`
window.__t = {
  text: (selector) => { const found = document.querySelector(selector); return found ? found.innerText : null; },
  all: (selector) => [...document.querySelectorAll(selector)].map((each) => each.innerText.replace(/\s+/g, " ").trim()),
  shown: (selector) => { const found = document.querySelector(selector); return Boolean(found && !found.hidden && found.getClientRects().length > 0); },
  press: (label, within) => {
    const scope = within ? document.querySelector(within) : document;
    const found = scope ? [...scope.querySelectorAll("button")].find((each) => each.innerText.trim() === label || each.innerText.trim().startsWith(label)) : undefined;
    if (!found) throw new Error("no button says " + label + " in " + (within || "the page"));
    if (found.disabled) throw new Error("the button that says " + label + " cannot be pressed");
    found.click();
    return true;
  },
  fill: (selector, value, at) => {
    const found = document.querySelectorAll(selector)[at || 0];
    if (!found) throw new Error("nothing to fill at " + selector);
    found.value = value;
    found.dispatchEvent(new Event("input", { bubbles: true }));
    found.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  },
  tick: (selector, checked) => {
    const found = document.querySelector(selector);
    if (!found) throw new Error("nothing to tick at " + selector);
    if (found.checked !== checked) found.click();
    return true;
  },
  grid: (within) => {
    const table = document.querySelector((within || "#view-table") + " .scroll table");
    if (!table) return null;
    return {
      heads: [...table.querySelectorAll("thead th")].map((each) => each.innerText.replace(/\s+/g, " ").trim()),
      rows: [...table.querySelectorAll("tbody tr")].map((row) => [...row.querySelectorAll("td:not(.actions)")].map((each) => each.innerText.trim())),
      actions: [...table.querySelectorAll("tbody tr")].map((row) => [...row.querySelectorAll("td.actions button")].map((each) => each.innerText.trim())),
    };
  },
  rowButton: (index, label) => {
    const row = document.querySelectorAll("#view-table .scroll tbody tr")[index];
    const found = row ? [...row.querySelectorAll("button")].find((each) => each.innerText.trim() === label) : undefined;
    if (!found) throw new Error("row " + index + " has no button that says " + label);
    found.click();
    return true;
  },
};
true;
`;
