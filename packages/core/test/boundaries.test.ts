import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";

const coreSrc = join(import.meta.dirname, "../src");

describe("core boundaries", () => {
  it("imports nothing outside the core itself", async () => {
    const files = (await readdir(coreSrc, { recursive: true })).filter((f) => f.endsWith(".ts"));
    assert.ok(files.length > 0);

    for (const file of files) {
      const source = await readFile(join(coreSrc, file), "utf8");
      const specifiers = [...source.matchAll(/\bfrom\s+["']([^"']+)["']|\bimport\s*\(?\s*["']([^"']+)["']/g)]
        .map((match) => match[1] ?? match[2] ?? "");

      for (const specifier of specifiers) {
        assert.match(specifier, /^\.\//, `${file} imports "${specifier}"`);
      }
      assert.doesNotMatch(source, /\bprocess\./, `${file} touches process`);
    }
  });
});
