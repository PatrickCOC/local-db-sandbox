# Third-party Notices

Local DB Sandbox does not copy or bundle the code of other projects: its runtime dependencies are installed by npm beside it, each with its own license. This page records the licenses of all of them, and of the packages they bring with them.

## Studio's ER Diagram tab

| Package | Version | License | Used for |
|---|---|---|---|
| [`@dagrejs/dagre`](https://github.com/dagrejs/dagre) | 3.1.3 (pinned) | MIT | Where the tables of the ER diagram stand: a layered graph layout, computed by Studio's server. Imported in `packages/studio/src/diagram.ts` alone, on first use. |
| [`@dagrejs/graphlib`](https://github.com/dagrejs/graphlib) | 4.0.6 (a dependency of `@dagrejs/dagre`) | MIT | The graph structure Dagre lays out. Installed with Dagre; its ES module build already contains what it uses. |

No example, template, or code of a paid product was used. The page draws the diagram with its own script.

Both packages carry this license:

```text
Copyright (c) 2012-2014 Chris Pettitt

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## The other runtime dependencies

| Package | Version | License | Used for |
|---|---|---|---|
| [`libpg-query`](https://github.com/constructive-io/libpg-query-node) | 18.1.5 (pinned) | MIT | PostgreSQL's own parser, as WebAssembly: reading migrations (`init`, the schema commands), checking generated SQL, and Studio's SQL export (D-034). |
| [`@pgsql/types`](https://github.com/constructive-io/libpg-query-node) | 18.0.0 (a dependency of `libpg-query`) | MIT | The types of PostgreSQL's parse tree. |
| [`postgres`](https://github.com/porsager/postgres) | 3.4.9 (pinned) | Unlicense | The client `init-pg` reads a server's catalog with (D-049). |

`libpg-query` and `@pgsql/types` are installed with their MIT license files (copyright Dan Lynch, and Constructive). `postgres` declares the Unlicense, which dedicates it to the public domain and asks for no notice; its package carries no license file.

Local DB Sandbox itself is under the MIT License: see `LICENSE` at the root of the repository and of the package.
