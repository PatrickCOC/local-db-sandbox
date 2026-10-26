# Local DB Sandbox 使用指南

適用版本：`local-db-sandbox` 0.1.0（V1 Developer Preview）。本指南的每個指令都對照過目前實作的 `--help`，並在合成（synthetic）範例專案上實際執行過。輸出範例節錄自實際執行：很長的本機路徑縮短成 `...`，環境變數名稱換成範例設定裡的名稱；你看到的路徑、pid、時間與金鑰會不同。

每個指令、選項與檔案格式的完整英文說明在 [REFERENCE.md](REFERENCE.md)；SQLite runtime 的精確行為在 [COMPATIBILITY.md](COMPATIBILITY.md)。指令本身的說明：`npx local-db-sandbox <command> --help`。

## 目錄

- [0. 開始之前](#0-開始之前)
- [1. Quick Start](#1-quick-start)
- [2. Local DB Studio](#2-local-db-studio)
- [3. SQL Migration Simulation](#3-sql-migration-simulation)
- [4. Schema Comparison](#4-schema-comparison)
- [5. Troubleshooting](#5-troubleshooting)
- [6. Safety](#6-safety)
- [7. 延伸閱讀](#7-延伸閱讀)

---

## 0. 開始之前

### 這個工具做什麼

Local DB Sandbox 在你自己的電腦上，替專案做一個**可以丟棄的本機資料庫**：

- 從專案的 schema 建立本機資料庫：PostgreSQL migrations（`init`）或 NestJS + TypeORM entities（`init-nest`）。
- 讓專案自己的後端跑在這個資料庫上（`npm run sandbox`），或用 PostgREST 子集服務 supabase-js 應用程式（`postgrest`）。
- 用瀏覽器看、改資料，並對本機 API 送出請求（Local DB Studio）。
- 在資料庫的**副本**上試跑 SQL script（`simulate`）。
- 比較兩份 schema，並產生 PostgreSQL migration（`diff-schema`、`plan-migration`、`generate-migration`）。

除了「把 JSON 檔當成 mock REST API」的模式（使用自己的 JSON engine）之外，底層都是 SQLite（Node 內建的 `node:sqlite`）。它是開發工具，不會連線到任何資料庫伺服器，也不會修改真正的資料庫。

### 先備條件

- **Node.js 22.18 以上**：`node --version`。
- **NestJS 專案**：專案本身要已安裝 `@nestjs/core`、`@nestjs/typeorm`、`typeorm`、`typescript`（本套件不附帶，使用專案自己的版本）。
- **瀏覽器**：用來開 Studio。

會載入 SQLite 的指令（`init`、`sql`、`simulate`、`postgrest`、standalone 的 Studio、NestJS sandbox）會先印一行 Node 的警告，可以忽略：

```text
ExperimentalWarning: SQLite is an experimental feature and might change at any time
```

### 安裝

套件已發佈到 npm，目前版本是 beta `0.1.0-beta.1`（dist-tags `beta` 與 `latest`）。在你的專案安裝：

```sh
npm install --save-dev local-db-sandbox@beta
npx local-db-sandbox --version          # 0.1.0-beta.1
```

也可以從原始碼自行打包成 tarball 再安裝：

```sh
# 在本儲存庫（https://github.com/PatrickCOC/local-db-sandbox）
npm install
npm pack                     # 先 build，再在這裡產生 local-db-sandbox-<version>.tgz

# 在你的專案
npm install --save-dev /path/to/local-db-sandbox-<version>.tgz
```

`npm pack --pack-destination <已存在的資料夾>` 可以把 tarball 寫到別的地方。

### 預設 port

| 用途 | 預設 | 修改方式 |
|---|---|---|
| NestJS sandbox（`npm run sandbox`） | `3001` | `init-nest --port <n>`，或 `.local-db-sandbox/sandbox.config.json` 的 `port` |
| Local DB Studio 頁面 | `4583` | `studio --port <n>`（`0` = 任一空閒 port） |
| PostgREST endpoint | `54321` | `postgrest --port <n>` |
| JSON 檔的 mock REST API | `4783` | `--port <n>` |
| SMTP capture | `2525` | `sandbox.config.json` 的 `smtp.port` |

---

## 1. Quick Start

### 1.1 PostgreSQL migration 專案

適用：migrations 放在 `supabase/migrations`、`migrations`、`db/migrations`、`database/migrations` 或 `sql/migrations` 的專案（Supabase、Flyway 或一般 `.sql` 檔）。

```text
my-project/
  supabase/migrations/0001_init.sql
  supabase/migrations/0002_....sql
  ...
```

**步驟 1：建立本機資料庫**

```sh
cd my-project
npx local-db-sandbox init .
```

```text
Read 7 migrations (21 statements) from .../my-project/supabase/migrations
Created .../my-project/.local-db-sandbox/sandbox.db
  assets: 3 columns, 0 rows
  asset_rates: 8 columns, 0 rows
  pair_snapshots: 7 columns, 0 rows
  job_state: 6 columns, 1 row
Statements: 16 applied, 1 inserting rows, 1 kept as information, 9 not reproduced, 0 without effect, 0 unsupported
Not reproduced locally, on purpose:
  row level security and policies: 6 statements
  extensions: 2 statements
  scheduled jobs: 1 statement
Kept as information, not enforced:
  0003_snapshots_and_state.sql:10: Check constraint "job_state_singleton" (id = 1) is kept as information and not enforced locally.
Report: .../my-project/.local-db-sandbox/sandbox.db.report.json
Next: local-db-sandbox postgrest .local-db-sandbox\sandbox.db
```

產出位置：

- 資料庫：`.local-db-sandbox/sandbox.db`（一個資料夾：`manifest.json`、`schema.json`、每個 table 一個 JSON 檔）。
- 報告：`.local-db-sandbox/sandbox.db.report.json`，列出每一個 statement 的處理結果。

migrations 用 PostgreSQL 自己的 parser 讀取並依序套用。Row level security、roles、extensions、functions、triggers、排程工作（`pg_cron`）、views 不會重現，會列在輸出與報告中；check constraints 只保留為資訊、不會強制。

> 注意：`init .` 會先看專案根目錄本身有沒有 `.sql` 檔。**根目錄只要有任何 `.sql` 檔，整個根目錄就會被當成 migrations 資料夾**。給 `simulate` 用的 script 請放在獨立資料夾（例如 `sandbox-scripts/`），見 [5.8](#58-專案根目錄的-sql-檔讓-init-與-diff-schema-讀錯)。

**步驟 2：用 Studio 看資料**

```sh
npx local-db-sandbox studio .local-db-sandbox/sandbox.db
```

打開它印出的網址（見 [第 2 節](#2-local-db-studio)）。

**步驟 3（選用）：給 supabase-js 應用程式使用**

```sh
npx local-db-sandbox postgrest .local-db-sandbox/sandbox.db
```

```text
Local DB Sandbox PostgREST endpoint (subset) at http://127.0.0.1:54321/rest/v1
  database:    .../my-project/.local-db-sandbox/sandbox.db
  tables:      assets, asset_rates, pair_snapshots, job_state
  Supabase URL for clients: http://127.0.0.1:54321 (any key is accepted)
  No Row Level Security, Auth, Storage, Realtime, RPC, or Edge Functions: every client can read and write every table.
  Press Ctrl+C to stop.
```

把應用程式的 Supabase URL 指到 sandbox（任何 key 都接受），例如 Vite 前端：

```sh
VITE_SUPABASE_URL=http://127.0.0.1:54321 VITE_SUPABASE_ANON_KEY=local npm run dev
```

請用 `127.0.0.1`，不要用 `localhost`：本機若另有一套 Supabase（例如在 Docker 裡）也佔用 54321，`localhost` 可能連到那一套（見 [5.9](#59-port-54321-已被本機的-supabase-或-docker-使用)）。PostgREST 只支援子集：`select`、`eq`、`gte`、`lt`、`range`、`single()`、`maybeSingle()`、primary key 上的 `upsert()`、帶 filter 的 `delete()`；其他一律以 `501 SANDBOX_POSTGREST_UNSUPPORTED` 拒絕，不會默默忽略。例如寫入時要求回傳資料（`Prefer: return=representation`，也就是 supabase-js 的 `.upsert(...).select()`）會被拒絕，請另外再讀一次。

**之後有新的 migration**：先用 `diff-schema` 看差異（[第 4 節](#4-schema-comparison)）；要重建資料庫時執行 `npx local-db-sandbox init . --force`。**`--force` 會清掉資料庫裡的資料列**，而且資料庫正被某個 process 使用時會被拒絕。

### 1.2 NestJS / TypeORM 專案

適用條件：

- TypeORM 的預設 data source 是用 `TypeOrmModule.forRoot()` 或 `forRootAsync()` 設定的。
- 進入點（預設 `nest-cli.json` 指定的檔案，或 `src/main.ts`）自己呼叫 `NestFactory.create(<RootModule>)` 和 `app.listen()`。

**步驟 1：設定一次**

```sh
cd my-nest-app
npx local-db-sandbox init-nest
```

```text
Nest entry point: src/main.ts
  root module: AppModule (./app.module)
  TypeORM root: src/app.module.ts
Imported 2 TypeORM entities from src
  category (Category): code, label
  users (User): id, name, active, createdAt
Not imported exactly (2):
  [note] User.createdAt: @CreateDateColumn is imported as a plain field; the sandbox does not set or update it.
  [ambiguous] Category: The sandbox identifies rows by a field named "id", but the primary column is: code. Routes such as /category/:id will not find rows by that key.
Wrote sandbox.db (database directory: an empty file per table, and their definitions).
Wrote .local-db-sandbox/sandbox.server.ts
Wrote .local-db-sandbox/sandbox.config.json
Sandbox port: 3001
Added the "sandbox" script to package.json.
Start the sandbox with: npm run sandbox   (restarts when the application's sources change)
Start it once, without watching: node .local-db-sandbox/sandbox.server.ts
The application's own sources and start command are unchanged.
```

產出位置：

| 檔案 | 內容 |
|---|---|
| `sandbox.db/`（專案根目錄） | 由 entities 建立的本機資料庫（每個 table 一個 JSON 檔，加上 table 定義） |
| `.local-db-sandbox/sandbox.config.json` | `entry`、`database`、`port`，以及之後加上的 `smtp`、`network` |
| `.local-db-sandbox/sandbox.server.ts` | 啟動 sandbox 的小程式（不要手改，重新執行 `init-nest` 會重寫） |
| `package.json` 的 `"sandbox"` script | `node .local-db-sandbox/sandbox.server.ts --watch` |

應用程式自己的原始碼與啟動指令都不會被修改。entities 從進入點所在的資料夾讀取，可用 `--entities <path>` 改；port 用 `--port <n>` 改。

**步驟 2：先開啟 mail capture 與 network guard（強烈建議）**

應用程式在 sandbox 裡仍然會照自己的設定寄信、呼叫外部服務。正式使用前，編輯 `.local-db-sandbox/sandbox.config.json`（`env` 裡的變數名稱要換成**你的應用程式讀取的名稱**）：

```json
{
  "entry": "../src/main.ts",
  "database": "../sandbox.db",
  "port": 3001,
  "smtp": { "mode": "capture", "env": { "SMTP_HOST": "{host}", "SMTP_PORT": "{port}" } },
  "network": { "mode": "block" }
}
```

細節見 [6.3](#63-smtp-capture-與-network-guard)。

**步驟 3：啟動後端**

```sh
npm run sandbox
```

```text
[sandbox] watching src for changes; the sandbox restarts when a source file changes
Local DB Sandbox: SMTP capture on 127.0.0.1:2525. Mail is kept in memory and sent to no one; see it with "local-db-sandbox mail list".
  set for the application, to lead its mail to 127.0.0.1:2525: SMTP_HOST, SMTP_PORT
Local DB Sandbox: network guard "block": TCP connections that leave this machine are refused. It is a development aid, not a security boundary.
Local DB Sandbox: application running at http://127.0.0.1:3001
  database: .../my-nest-app/sandbox.db
  the entry point asked for port 3000; the sandbox uses 3001 on 127.0.0.1 (this machine only) instead.
```

你的後端（同一份程式碼，含 global prefix、pipes、guards 等）現在在 `http://127.0.0.1:3001`，資料存在 `sandbox.db`。原本的 `npm run start:dev` 照常使用原本的資料庫與 port，兩者可以同時執行。修改 `src` 裡的檔案時 sandbox 會自動重啟，資料保留。

**步驟 4：開 Studio（另一個終端機）**

```sh
npx local-db-sandbox studio sandbox.db --api http://127.0.0.1:3001/
```

```text
Local DB Studio at http://127.0.0.1:4583/#key=3f9c...
  database:  .../my-nest-app/sandbox.db (database directory)
  mode:      attached to the NestJS sandbox (pid 33436): Studio looks into its runtime, and does not open the database
  access:    read/write
  tables:    2
  api:       http://127.0.0.1:3001/ (the API tab starts from it; Studio does not start the API)
```

打開印出的網址。`mode: attached` 代表 Studio 正在看 sandbox 執行中的資料：在 API 分頁送出的請求寫入的資料，會立刻出現在 Rows 與 SQL。

**之後新增或修改 entity**：先 `npx local-db-sandbox diff-schema sandbox.db .` 看差異，然後**先停掉 `npm run sandbox` 與 Studio**，再執行 `npx local-db-sandbox init-nest`（既有資料保留）。`init-nest` 寫入既有資料庫時不會檢查有沒有其他 process 正在使用它，所以要自己先停掉。

**建議加入 `.gitignore`**：

```text
*.owner.json
*-preview.db/
```

`*.owner.json` 是執行中 process 的擁有者紀錄（含本機 token），不該 commit；`*-preview.db/` 是 `simulate` 的拋棄式副本。

### 1.3 各指令的產出一覽

| 指令 | 寫入什麼、在哪裡 |
|---|---|
| `init .` | `.local-db-sandbox/sandbox.db/`、`.local-db-sandbox/sandbox.db.report.json` |
| `init-nest` | `sandbox.db/`、`.local-db-sandbox/sandbox.config.json`、`.local-db-sandbox/sandbox.server.ts`、`package.json` 的 `"sandbox"` script |
| `simulate <db> <script>` | `<名稱>-preview.db/`，在原資料庫旁邊（例如 `sandbox.db` → `sandbox-preview.db`） |
| `generate-migration ... --out <file>` | 你指定的 SQL 檔（已存在的檔案絕不覆蓋） |
| 任何正在寫入資料庫的 process | `<資料庫>.owner.json`，結束時自動刪除 |

---

## 2. Local DB Studio

Studio 是一個只在本機開放的網頁，用來看、改 sandbox 資料庫，並對本機 API 送請求。所有操作都由 sandbox 的 SQLite runtime 執行；Studio 不連線到任何資料庫伺服器。

### 2.1 啟動 Studio

```sh
npx local-db-sandbox studio <database>
```

- `<database>`：資料庫資料夾（例如 `sandbox.db`、`.local-db-sandbox/sandbox.db`）或單一 JSON 檔。
- 打開它印出的網址，例如 `http://127.0.0.1:4583/#key=...`。`#key=` 後面是這次 session 的金鑰，頁面讀到後會從網址列移除；沒有金鑰的請求一律被拒絕。
- 頁面只在 `127.0.0.1` 提供，沒有選項可以改成其他位址。
- 結束：在 Studio 的終端機按 Ctrl+C。

常用選項：

| 選項 | 作用 |
|---|---|
| `-p, --port <n>` | 頁面的 port（預設 4583；`0` = 任一空閒 port） |
| `--read-only` | 只看不改：瀏覽、執行讀取的 SQL |
| `--api <url>` | API 分頁預設的網址（只接受本機位址，例如 `http://127.0.0.1:3001/`） |
| `--max-file-size <MB>` | 可開啟的最大資料庫（預設 150，最多 250） |

### 2.2 Standalone 與 Attached 模式

Studio 依資料庫的狀態自動決定模式，啟動時的 `mode:` 一行與頁面上方的 Mode 都會顯示：

| 資料庫狀態 | 模式 | 說明 |
|---|---|---|
| 資料夾，沒有任何 process 開著 | **Standalone** | Studio 自己獨佔資料庫，改動直接存檔。這段期間 sandbox 會被拒絕啟動（見 [2.7](#27-writer-ownership-與-studio--api-交接)）。 |
| 被 `npm run sandbox`、`postgrest` 或另一個 Studio 開著 | **Attached** | Studio 不開資料庫，而是透過那個 process 的 runtime 操作：只有一個 runtime、一個寫入者。應用程式寫的資料 Studio 立刻看得到，Studio 改的應用程式也立刻讀得到。 |
| 單一 JSON 檔（`sandbox.db.json`） | **唯讀** | 一律唯讀。要修改請先轉成資料夾：`npx local-db-sandbox convert sandbox.db.json --out sandbox.db` |

搭配 `npm run sandbox`（watch mode）時，原始碼一改 sandbox 就重啟：頁面會先顯示「not connected」，接著自動找到新的 sandbox process 並重新讀取所有資料，不需要重開 Studio。

### 2.3 Rows：瀏覽、新增、編輯、刪除

- **瀏覽**：左側列出所有 table 與列數。選一個 table 後可看到欄位（型別、可否為 NULL、primary key、預設值），資料分頁顯示（每頁 25～500 列）；按欄位名稱排序；可加多個條件篩選：`=`、`!=`、`>`、`>=`、`<`、`<=`、contains、is NULL、is not NULL。
- **新增（Add a row）**：勾選「give a value」的欄位才會送出值，其餘交給資料庫（預設值、自動編號）。
  - TypeORM 自己填時間的欄位（`@CreateDateColumn`、`@UpdateDateColumn`）在資料庫沒有預設值；不填的話，Studio 會填入新增當下的時間，就像應用程式自己新增時一樣。你填的值會原樣保留。
  - 其他必填欄位沒給值時，資料庫的錯誤會顯示在表單裡，例如 `NOT NULL constraint failed: users.name`，表單保持開啟、資料庫不變。
- **編輯（Edit）**：只改你動過的欄位，以 primary key 找到那一列。沒有 primary key 的 table 只能用 SQL 修改。
- **刪除（Delete）**：會先確認，確認後無法復原。
- **Refresh**：重新讀取全部資料。

值以應用程式看到的形式顯示（`true`、ISO 日期時間、JSON）。太長的值會被截斷並標示，開啟那一列可看全文。

### 2.4 SQL Editor

- 輸入 `SELECT`、`INSERT`、`UPDATE`、`DELETE`；多個 statement 用分號分隔；Ctrl+Enter 執行。
- 預設只能讀：會改資料的 statement 由 SQLite 本身拒絕（`READ_ONLY`）。
- 勾選 **Allow changes (INSERT, UPDATE, DELETE), as one transaction** 後可寫入：執行前頁面會先確認；所有 statement 包成一個 transaction，全部成功才 commit，任何一句失敗就全部撤回。
- 結果會顯示回傳的列、影響的列數與本機執行時間（只代表本機 SQLite，與正式資料庫的效能無關）。每個 statement 最多顯示的列數可選 50、200（預設）或 1000。

注意：

- 這是 **SQLite 的 SQL**，PostgreSQL 專屬語法會失敗（見 [5.6](#56-不支援的-sql-statement)）。
- SQL 分頁**不會**自動填 `@CreateDateColumn` 欄位。直接 `INSERT` 而沒給 `createdAt` 會得到 `NOT NULL constraint failed: users.createdAt`；請自己給值，或改用 Rows 的 Add a row。
- Studio 不能建立、修改或刪除 table。要試 schema 變更請用 `simulate`（[第 3 節](#3-sql-migration-simulation)）。

### 2.5 API Request 分頁

一次送出一個 HTTP 請求到**本機**的 API：

| 欄位 | 說明 |
|---|---|
| Method | `GET`、`POST`、`PUT`、`PATCH`、`DELETE` |
| URL | 只接受 `http://127.0.0.1:<port>/...`、`http://localhost:<port>/...`、`http://[::1]:<port>/...` |
| Headers | 每行一個 `Name: value`（例如 `Authorization: Bearer ...`） |
| Body | JSON；`GET` 不能帶 body |

按 **Send** 後顯示 HTTP status 與狀態文字、耗時、response headers，以及 body（JSON 會自動排版）。例如：`201 Created (11.6 ms, on this machine)`。

限制與保護：

- 不會送到別台機器：其他 host 或位址、`https:`、Studio 自己的 port 都會被拒絕，也不做 DNS 查詢（`localhost` 直接連 `127.0.0.1`，不通再試 `::1`）。
- 不會跟隨 redirect：3xx 會顯示出來，包含 `Location`。
- 單次請求最多 10 秒；response body 最多讀 1 MiB，超過會截斷並標示。
- 請求的網址、headers、body 與回應都不會被記錄、寫檔或保存；API 設定的 cookie 只顯示名稱、不顯示值。
- 2xx 不代表業務邏輯正確：請自己看回應，再到 Rows 或 SQL 確認資料庫的變化。

### 2.6 讓 Studio 連上執行中的 sandbox API

**NestJS 專案**（實際驗證過的流程）：

1. 終端機 A：`npm run sandbox`
2. 終端機 B：`npx local-db-sandbox studio sandbox.db --api http://127.0.0.1:3001/`（確認輸出是 `mode: attached ...`）
3. 打開網址，切到 **API** 分頁。URL 欄位已預先填好 `--api` 的位址，補上路徑（含應用程式的 global prefix，例如 `http://127.0.0.1:3001/api/users`）。
4. 選 `POST`、Body 填 `{ "name": "Ada" }`，按 Send，看到 `201 Created`。
5. 切回 **Rows** 選該 table，或在 **SQL** 執行 `SELECT * FROM users`，確認剛寫入的資料。

**PostgreSQL 專案 + PostgREST**：

1. 終端機 A：`npx local-db-sandbox postgrest .local-db-sandbox/sandbox.db`
2. 終端機 B：`npx local-db-sandbox studio .local-db-sandbox/sandbox.db --api http://127.0.0.1:54321/rest/v1/`（`mode: attached to the PostgREST endpoint`）
3. API 分頁：`POST http://127.0.0.1:54321/rest/v1/assets`，Headers 填

   ```text
   apikey: local
   Prefer: resolution=merge-duplicates
   ```

   Body 填 `[{"id":"btc","label":"Bitcoin"}]`，得到 `201 Created`（body 是空的，這是 PostgREST 預設的 `return=minimal`）。
4. 到 Rows 看 `assets`。

Studio 不會啟動你的應用程式；應用程式要自己先跑起來。

### 2.7 Writer ownership 與 Studio → API 交接

**規則：同一時間只有一個 process 可以寫入一個資料庫。**

會寫入的 process（REST mock server、`postgrest`、NestJS sandbox、可存檔的 `sql` console、獨佔資料庫的 Studio）啟動時，會在資料庫旁邊寫一個擁有者紀錄 `<資料庫>.owner.json`，正常結束時刪除。第二個要寫入的 process 會被拒絕，並告訴你是誰佔用，例如：

```text
Error: .../.local-db-sandbox/sandbox.db is open in the PostgREST endpoint (pid 10448, since 2026-10-12T08:48:47.706Z). One process has a database open to write at a time: stop that one first.
To look at the database as it is stored, without changing it, add --read-only. To look into the database of a running sandbox, and change it there, use "local-db-sandbox studio <database>".
```

Studio 不會成為第二個寫入者：資料庫被 sandbox 或 `postgrest` 開著時，Studio 會 attach 到那個 process。

**正確的交接方式（Studio 先開、之後要跑 sandbox）**

Studio 以 standalone 模式獨佔資料庫時，啟動時就會提醒：

```text
Note: Studio has this database to itself. While it runs, a sandbox that is started on the database is refused: one process has a database open to write at a time. To use the database with an application, stop Studio (Ctrl+C in its terminal), start the sandbox, and start Studio again. It then attaches to the sandbox, and both show the same rows.
```

這時若執行 `npm run sandbox`，sandbox 會被拒絕。訊息出現在 NestJS 的錯誤輸出中（前後會有一長串 stack trace），重點是這一句：

```text
DatabaseOwnedError: .../sandbox.db is open in Local DB Studio (pid 20320, since ...). One process has a database open to write at a time: stop that one first. That Studio has the database to itself. To run the sandbox on it: stop that Studio (Ctrl+C in its terminal), start the sandbox, and start Studio again. It then attaches to the sandbox, and both show the same rows.
...
[sandbox] the sandbox process ended (code 1); waiting for changes to start it again
```

交接步驟：

1. 在 Studio 的終端機按 Ctrl+C 停止 Studio。
2. 啟動 sandbox。如果 `npm run sandbox` 還開著並顯示 `waiting for changes to start it again`，先按 Ctrl+C 停掉再重新執行（或存檔任一個 `src` 裡的檔案觸發重啟）。
3. 重新啟動 Studio：`npx local-db-sandbox studio sandbox.db --api http://127.0.0.1:3001/`，它會 attach 到 sandbox。

沒有任何東西會自動交出資料庫，也不會自動啟動 sandbox。

### 2.8 資料保存、備份，以及 V1 還沒有的功能

- **Studio 的改動會保存在本機資料庫。** 在 Rows 新增、編輯、刪除，或在 SQL 分頁（勾選 Allow changes）寫入的資料，都存進資料庫資料夾；重新啟動 Studio 或 sandbox 之後仍然存在。Attached 模式下，存檔的是開著資料庫的那個 process。
- **要保留一份完整的副本：先停掉寫入者，再備份整個資料庫資料夾。** 寫入者是正開著資料庫的 process（`npm run sandbox`、`postgrest`，或 standalone 的 Studio）；在它的終端機按 Ctrl+C，再複製整個資料夾。不要只複製其中幾個檔案：`manifest.json` 記錄每個 table 目前存在哪個檔案，少了任何一個都不完整。

  ```sh
  cp -r sandbox.db sandbox-backup.db                      # bash
  Copy-Item -Recurse sandbox.db sandbox-backup.db         # PowerShell
  ```

  旁邊的 `<資料庫>.owner.json` 不是資料庫的一部分，不需要複製。
- **SQL Export 是規劃中的功能，V1 沒有。** 目前無法把 table 定義或資料列匯出成 `.sql` script。
- **直接掃描 PostgreSQL 資料庫的 schema 是規劃中的功能，V1 沒有。** V1 的任何指令都不會連線到資料庫伺服器。
- **目前支援的 schema 來源仍然是** TypeORM entities（`init-nest`）與支援的 PostgreSQL migration 檔（`init`）。migration 歷史不完整（例如最早建立 table 的 migration 不在專案裡）時，`init` 會在第一個失敗的 statement 停止，而且不寫入任何東西。

上面標示為規劃中的項目尚未實作。

---

## 3. SQL Migration Simulation

`simulate` 在資料庫的**拋棄式副本**上執行一個 SQL script，原資料庫完全不變。適合在真正改 schema 或資料之前，先看看 script 會造成什麼結果。

### 3.1 準備 SQL script

- script 由 sandbox 的 **SQLite** 執行，**不是 PostgreSQL**，也不會轉譯。
- 把 script 放在**獨立資料夾**，例如 `sandbox-scripts/`。不要放在專案根目錄或 migrations 資料夾：含有 `.sql` 檔的資料夾會被 `init` 與 schema 指令當成 migrations。
- 一個 statement 以分號結尾，可以跨行；最後一句可省略分號。

副本會保留的變更：

| 類別 | statement |
|---|---|
| 資料列 | `INSERT`、`UPDATE`、`DELETE` |
| table | `CREATE TABLE`、`DROP TABLE` |
| 欄位 | `ALTER TABLE ... ADD COLUMN`、`ALTER TABLE ... DROP COLUMN` |

新增欄位與 table 使用 SQLite 的型別名稱：`INTEGER`、`INT`、`BIGINT`、`REAL`、`DOUBLE`、`NUMERIC`、`DECIMAL(p, s)`、`TEXT`、`VARCHAR(n)`、`BLOB`，以及 sandbox 自己的 `BOOLEAN`、`DATE`、`DATETIME`；預設值可以是常數、`CURRENT_TIMESTAMP`（DATETIME 欄位）或 `CURRENT_DATE`（DATE 欄位）。

範例 `sandbox-scripts/add-watchlist.sql`：

```sql
ALTER TABLE assets ADD COLUMN decimals INTEGER NOT NULL DEFAULT 8;
UPDATE assets SET decimals = 18 WHERE id = 'eth';
CREATE TABLE watchlist (id INTEGER PRIMARY KEY, asset_id TEXT NOT NULL REFERENCES assets (id), note TEXT);
INSERT INTO watchlist (asset_id, note) VALUES ('btc', 'core');
```

### 3.2 執行 simulate

```sh
npx local-db-sandbox simulate .local-db-sandbox/sandbox.db sandbox-scripts/add-watchlist.sql
```

```text
OK (0.1 ms)
1 row affected (0.0 ms)
OK (0.0 ms)
1 row affected (0.0 ms)
Simulated: the 4 statements of sandbox-scripts/add-watchlist.sql ran on a copy of .local-db-sandbox/sandbox.db. .local-db-sandbox/sandbox.db was not changed.
Copy: .local-db-sandbox\sandbox-preview.db
Tables of the copy: column "assets"."decimals" added; table "watchlist" made.
To look at it:   local-db-sandbox studio .local-db-sandbox\sandbox-preview.db
                 local-db-sandbox sql .local-db-sandbox\sandbox-preview.db
To compare:      local-db-sandbox diff-schema .local-db-sandbox/sandbox.db .local-db-sandbox\sandbox-preview.db
To discard it:   delete .local-db-sandbox\sandbox-preview.db
```

在 Windows 上，自動產生的副本路徑會以 `\` 顯示。在 cmd 或 PowerShell 可以直接使用；**在 Git Bash 請把 `\` 改成 `/` 再貼上**（bash 會把 `\` 當成跳脫字元，路徑會變成 `.local-db-sandboxsandbox-preview.db`）。

- 副本預設是原資料庫旁的 `<名稱>-preview.db`；`--out <path>` 可指定位置（格式要和原資料庫相同：資料夾對資料夾、`.json` 對 `.json`）。
- 副本已經存在時不會覆蓋，會出現：

  ```text
  Error: .local-db-sandbox\sandbox-preview.db exists already, and a simulation does not write over it. Delete it if it is a copy you are done with, give another --out, or add --replace.
  ```

  加 `--replace` 才會覆蓋；副本正被 Studio 等 process 開著時，`--replace` 也會被拒絕，且什麼都不執行。
- 原資料庫正被 sandbox 開著也沒關係：副本從**已存檔**的內容開始，並印出一行 Note。

### 3.3 開啟 preview database

```sh
npx local-db-sandbox studio .local-db-sandbox/sandbox-preview.db
```

副本是一個獨立的資料庫，Studio 會以 standalone 模式開啟（Rows、SQL 都可以用）。只想看不想改：

```sh
npx local-db-sandbox sql .local-db-sandbox/sandbox-preview.db --read-only --file sandbox-scripts/check.sql
```

### 3.4 檢查結果

用 `diff-schema` 比較原資料庫與副本的 schema：

```sh
npx local-db-sandbox diff-schema .local-db-sandbox/sandbox.db .local-db-sandbox/sandbox-preview.db
```

```text
Before: .local-db-sandbox/sandbox.db (database directory)
After:  .local-db-sandbox/sandbox-preview.db (database directory)
3 changes:
  + table watchlist (3 columns, primary key (id))
  + column assets.decimals INTEGER not null default 8
  + foreign key watchlist (asset_id) -> assets (id)
```

資料的變化在 Studio 的 Rows 或 SQL 查看。確認完畢就刪除副本：

```sh
rm -rf .local-db-sandbox/sandbox-preview.db                       # bash
Remove-Item -Recurse .local-db-sandbox/sandbox-preview.db         # PowerShell
```

### 3.5 原資料庫保持不變

- `simulate` 只**讀取**原資料庫，從不以寫入模式開啟它，也不佔用它的擁有者紀錄。
- 整個 script 在記憶體中的 SQLite 執行，結束後才一次寫出副本。
- 成功或失敗，原資料庫的每個檔案都不變（V1 驗收以檔案雜湊確認過）。

### 3.6 失敗與部分寫入

script 在**第一個錯誤**就停止。失敗的那一句不會造成任何改變，之後的不會執行；副本仍會寫出，內容是失敗之前已執行的部分，並明確標示為 partial，指令的 exit code 是 1：

```text
Error: SQLite cannot run this statement: near "ALTER": syntax error. The sandbox runs SQL on embedded SQLite and does not translate the syntax or functions of other databases.
  SQL: ALTER TABLE assets ALTER COLUMN label TYPE varchar(40)
Simulation failed at statement 2 of 3: ALTER TABLE assets ALTER COLUMN label TYPE varchar(40)
Statement 1 ran; statement 2 changed nothing; statement 3 did not run.
.local-db-sandbox/sandbox.db was not changed.
Copy (partial): .local-db-sandbox/try2.db, with what statement 1 changed. It is not what the whole script would give.
```

- script 裡用 `BEGIN` 開始、但失敗時還沒 `COMMIT` 的 transaction 會被撤回，那些變更不在副本中；輸出會說明是哪幾句。
- script 結束時仍有未 commit 的 transaction，也會撤回並回報。
- 少數情況完全不寫副本（例如結果無法再被當成 sandbox 資料庫開啟），輸出會說明原因。

### 3.7 不支援的 SQL

以下都會讓**那一句失敗**（該句不造成任何改變），並說明原因：

| 類別 | 例子 |
|---|---|
| PostgreSQL 專屬語法 | `ALTER COLUMN ... TYPE`、`::` cast、`ILIKE`、`now()` |
| index、view、trigger | `CREATE INDEX`、`DROP INDEX`、`CREATE VIEW`、`CREATE TRIGGER` |
| 改名 | `ALTER TABLE ... RENAME TO`、`RENAME COLUMN` |
| 副本無法保存的定義 | `CHECK` constraint、`COLLATE`、`DEFERRABLE`、`ON CONFLICT` 子句、generated column、`STRICT`、`WITHOUT ROWID` |
| SQLite 沒有對應意義的型別 | `serial`、`uuid`、`timestamptz`、`json`、`jsonb` |
| 運算式預設值 | `DEFAULT (lower('X'))` 之類 |
| 會寫到副本以外的指令 | `ATTACH`、`DETACH`、`VACUUM`（直接不執行） |

例如：

```text
Error: The index "assets_label" was made: a simulated copy keeps tables and their columns, and no index that SQL makes or changes. The statement was undone.
```

`simulate` 不是 PostgreSQL migration 的模擬器：它不讀專案的 migrations，也不轉譯 SQL。要比較 migrations，請用第 4 節的指令。

---

## 4. Schema Comparison

三個指令都**只讀取**兩邊的 schema，不修改任何東西，也不連線到任何資料庫：

| 指令 | 用途 |
|---|---|
| `diff-schema <before> <after>` | 列出差異：table、欄位、型別、預設值、keys、constraints、indexes、enum |
| `plan-migration <before> <after>` | 列出可以依序執行的步驟（必要時加入暫時改名等輔助步驟） |
| `generate-migration <before> <after> --dialect postgres` | 把步驟寫成 **PostgreSQL** 的 SQL migration |

### 4.1 可以比較的來源

`<before>` 和 `<after>` 各自可以是：

| 來源 | 例子 |
|---|---|
| 資料庫資料夾 | `sandbox.db`、`.local-db-sandbox/sandbox.db`、`sandbox-preview.db` |
| schema 檔 | 資料庫資料夾裡的 `schema.json`（或它的複本） |
| PostgreSQL migrations | 含 `.sql` 的資料夾，或 `init` 找得到 migrations 的專案（例如 `.`） |
| TypeORM entities | NestJS 專案（例如 `.`）、entity 檔所在資料夾、或單一 entity 檔 |

讀取 entities 時不會啟動應用程式：只載入宣告 entity 的檔案，載入期間任何連到本機以外的連線都會被拒絕。同一個專案同時有 migrations 和 entities 時會要求你直接給資料夾（例如 `supabase/migrations` 或 `src`）。

### 4.2 diff-schema

```sh
npx local-db-sandbox diff-schema old/migrations supabase/migrations
```

```text
Before: old/migrations (PostgreSQL migrations, 3 files)
After:  supabase/migrations (PostgreSQL migrations, 7 files)
10 changes:
  ~ column asset_rates.rate renamed to reference_rate (0004_liquidity.sql:6)
  + column asset_rates.high_ratio numeric
  + column asset_rates.input_volume numeric not null default 0
  ...
```

常見用法：

```sh
npx local-db-sandbox diff-schema .local-db-sandbox/sandbox.db .    # 資料庫 vs 專案目前的 migrations
npx local-db-sandbox diff-schema sandbox.db .                      # NestJS：資料庫 vs 目前的 entities
```

資料庫與建立它的來源一致時輸出 `No differences.`。只有 migration 明確改名（`ALTER TABLE ... RENAME`）才算 rename；其他名稱不同一律視為刪除加新增，不靠相似度猜測。`--json` 輸出 JSON。

entities 不會描述 indexes、unique 與 check constraints（以及部分預設值）；和描述較完整的一方比較時，這些會列為差異並附上提示，可能只是 entities 沒寫出來。

### 4.3 plan-migration

```sh
npx local-db-sandbox plan-migration old/migrations supabase/migrations
```

```text
Before: old/migrations (PostgreSQL migrations, 3 files)
After:  supabase/migrations (PostgreSQL migrations, 7 files)
10 steps:
   1. ~ column asset_rates.rate renamed to reference_rate (0004_liquidity.sql:6)
   2. + column asset_rates.high_ratio numeric
   ...
```

計畫裡沒有 SQL，也不執行任何東西。

### 4.4 generate-migration

```sh
npx local-db-sandbox generate-migration old/migrations supabase/migrations --dialect postgres
```

```text
-- PostgreSQL migration: 10 statements in one transaction.
BEGIN;
ALTER TABLE "asset_rates" RENAME COLUMN "rate" TO "reference_rate";
ALTER TABLE "asset_rates" ADD COLUMN "high_ratio" numeric;
ALTER TABLE "asset_rates" ADD COLUMN "input_volume" numeric DEFAULT 0 NOT NULL;
...
COMMIT;
```

- `--out <file>` 寫入檔案（已存在的檔案絕不覆蓋）；`--json` 輸出每一步的分類與 statements。
- 每一步會被分類：`safe`（直接寫出）、`requiresDataMigration`（是否可行取決於資料，例如欄位變成 `NOT NULL`；只有加上 `--assume-valid-data` 才寫出並標示）、`requiresExplicitCast`（型別轉換方式要你自己決定，拒絕）、`unsupported`（拒絕）。有任何一步被拒絕就不產生 migration，並說明原因。
- 產生的 SQL 會先交給 PostgreSQL 自己的 parser 檢查。
- 只支援 PostgreSQL；沒有反向 migration，也不會轉換或補填資料。

### 4.5 重要：產生 SQL 不會修改任何資料庫

`generate-migration` 只**印出或寫出** SQL。它不連線、不執行，也不會修改 sandbox 資料庫或真正的資料庫。

- 要讓 **sandbox 資料庫**跟上新的 migrations：重新執行 `init . --force`（資料列會清掉），或先用 `simulate` 在副本上試。
- 要套用到**真正的資料庫**：那是你自己在本工具之外的步驟。請先讀過 SQL、先在開發用的資料庫試跑；多段式 migration 要用一次送一個 statement 的 client（例如 `psql -f`）。**不要直接套用到 production。**

---

## 5. Troubleshooting

### 5.1 資料庫已被其他 process 佔用

```text
Error: .../sandbox.db is open in the PostgREST endpoint (pid 10448, since ...). One process has a database open to write at a time: stop that one first.
```

- 照訊息停掉那個 process（在它的終端機按 Ctrl+C），再執行你的指令。
- 只想看資料：`sql` 加 `--read-only` 不需要佔用資料庫。
- 想在 sandbox 執行中改資料：用 Studio（它會 attach）。
- `init --force` 遇到被佔用的資料庫會拒絕，並說明「Nothing was replaced: the database is as it was.」

### 5.2 Studio 無法 attach

| 情況 | 訊息重點 | 處理方式 |
|---|---|---|
| 資料庫被 REST mock server 或可存檔的 `sql` console 開著 | `That process does not serve its runtime, so Studio cannot look into the database through it. With --read-only, Studio shows the database as it is stored.` | 停掉那個 process，或用 `studio --read-only` 只看已存檔的內容 |
| 開著資料庫的 process 沒有回應 | `The process that has the database open does not answer. Studio did not start.` | 確認 sandbox 是否還在執行；必要時重開它 |
| sandbox 剛啟動 | `That process has not said where it serves its runtime: it may still be starting. Try again in a moment.` | 等幾秒再啟動 Studio |
| watch mode 重啟中 | 頁面顯示 not connected | 不用處理，Studio 會自動重新連上 |
| 想 attach 但 Studio 顯示 `standalone` | 啟動 Studio 時 sandbox 還沒在跑 | 照 [2.7](#27-writer-ownership-與-studio--api-交接) 交接 |
| 找不到資料庫 | `Database not found: ...` | 檢查路徑：NestJS 是 `sandbox.db`，PostgreSQL 專案是 `.local-db-sandbox/sandbox.db` |

### 5.3 API 連線被拒絕

```text
Nothing listens at http://127.0.0.1:3999. Start the API, or check its port.
```

- 確認 `npm run sandbox`（或你的 API）正在執行，且輸出顯示 `application running at http://127.0.0.1:3001`。
- 確認 port：NestJS sandbox 預設是 **3001**（不是應用程式原本的 3000），以 `.local-db-sandbox/sandbox.config.json` 的 `port` 為準。
- 確認路徑包含 global prefix（例如 `/api`）。得到 404 代表有連上，但路徑不對。
- `https:` 會被拒絕：`Only http: is sent, and the URL is https:. An API on this machine is asked over http://127.0.0.1:<port>/.`
- 別台機器的位址一律拒絕（`... is not this machine: the API tab sends requests to 127.0.0.1, localhost, or [::1] only.`）。

### 5.4 找不到 TypeORM entities

| 訊息 | 原因與處理 |
|---|---|
| `Entry point does not exist: .../src/main.ts. Pass the path of the file that starts the application.` | 進入點不在預設位置：`npx local-db-sandbox init-nest path/to/main.ts` |
| `... does not call NestFactory.create(<RootModule>). Pass the file that creates the application; ...` | 給真正建立應用程式的那個檔案；把建立工作委派給別的檔案的進入點不支援 |
| `No TypeORM entity files found in <path>.` | entities 不在進入點的資料夾：`init-nest --entities <entity 資料夾>` |
| `... nor TypeORM entities (TypeORM is not installed for this project: install its packages, and its entities can be read).` | 專案的套件還沒安裝：先 `npm install` |
| `... has PostgreSQL migrations (...) and TypeORM entities (...) both. Give the one to compare.` | 直接給資料夾，例如 `src` 或 `supabase/migrations` |

`init-nest` 匯入時的 `Not imported exactly` 清單是提醒，不是錯誤：例如 many-to-many 的 join table、embedded columns、`EntitySchema`、table inheritance 不會產生 table。

### 5.5 必填欄位或時間戳記錯誤

```text
NOT NULL constraint failed: users.name
NOT NULL constraint failed: users.createdAt
```

- 第一種：必填欄位沒給值。在 Add a row 勾選並填入，或在 SQL 裡給值。
- 第二種（`@CreateDateColumn` / `@UpdateDateColumn`）：Studio 的 **Add a row** 會自動填入新增時間；**SQL 分頁**、`sql` console 與 `simulate` 不會，要自己給值，例如 `INSERT INTO users (name, active, createdAt) VALUES ('Cy', 1, CURRENT_TIMESTAMP)`。
- Studio 的 Edit 不會更新 `@UpdateDateColumn`。

### 5.6 不支援的 SQL statement

```text
Error: SQLite cannot run this statement: no such function: now. The sandbox runs SQL on embedded SQLite and does not translate the syntax or functions of other databases.
Error: SQLite cannot run this statement: near "ILIKE": syntax error. ...
Error: SQLite cannot run this statement: unrecognized token: ":". ...
```

SQL 由 SQLite 執行，PostgreSQL 專屬的語法與函式不會被轉譯。改用 SQLite 的寫法，例如：`now()` → `CURRENT_TIMESTAMP`、`ILIKE` → `LIKE`（SQLite 的 `LIKE` 對 ASCII 字母本來就不分大小寫）、`'1'::int` → `CAST('1' AS INTEGER)`。例外：`$1` 形式的 placeholder，以及日期的 `TO_CHAR(date, 'YYYY-MM-DD')`。`simulate` 另有自己的限制，見 [3.7](#37-不支援的-sql)。

### 5.7 Windows 強制結束與殘留的擁有者紀錄

- 正常停止（在終端機按 Ctrl+C）時，process 會刪除自己的 `<資料庫>.owner.json`。
- 被強制結束（關掉終端機視窗、工作管理員結束工作、`taskkill /F`、當機）時，紀錄會留下來。**下一個要用這個資料庫的 process 會發現原本的 process 已不存在，自動接手**，通常不需要做任何事（V1 驗收以強制結束實際驗證過）。
- 例外：如果拒絕訊息指名的 process 其實已經不在（例如 PID 被別的程式重用），訊息會附上 `If that process is gone, delete <record>.`，這時手動刪除那個 `.owner.json` 即可。
- **不要刪除仍在執行中的 process 的紀錄**：兩個 process 同時寫入會互相覆蓋資料。
- 備註：本次驗證環境只能用強制結束；一般終端機中的 Ctrl+C 正常停止流程在 Windows 上沒有在此環境實測。

### 5.8 專案根目錄的 .sql 檔讓 init 與 diff-schema 讀錯

症狀：

```text
Error: .../my-project/migration.sql:2: relation "assets" does not exist. Nothing was written.
```

原因：資料夾本身含有 `.sql` 檔時，就會被當成 migrations 資料夾（不論裡面還有什麼）。專案根目錄放了一個 script（例如給 `simulate` 用的）時，`init .` 與 `diff-schema <db> .` 就會讀到它。處理：把 script 移到 `sandbox-scripts/` 之類的資料夾，或直接給 migrations 資料夾（例如 `diff-schema .local-db-sandbox/sandbox.db supabase/migrations`）。

### 5.9 port 54321 已被本機的 Supabase 或 Docker 使用

本機若有用 Docker 跑的 Supabase stack，它通常也佔用 54321。sandbox 的 PostgREST 綁在 `127.0.0.1:54321`，仍可能啟動成功，但用 `localhost:54321` 的 client 可能會連到 Docker 那一套。處理：client 一律用 `http://127.0.0.1:54321`，或給 sandbox 另一個 port：`npx local-db-sandbox postgrest .local-db-sandbox/sandbox.db --port 54331`，再把 client 的 Supabase URL 改成那個 port。

### 5.10 其他常見訊息

- **`[MODULE_TYPELESS_PACKAGE_JSON] Warning: Module type of .../sandbox.server.ts is not specified ...`**：專案的 `package.json` 沒有 `"type": "module"` 時，`npm run sandbox` 啟動時會出現。無害，不需要修改專案。
- **資料庫格式較舊**：`Database format 2 is older than the format this build writes (5). ...` 先 `npx local-db-sandbox inspect sandbox.db` 查看，再 `npx local-db-sandbox migrate sandbox.db`（可先加 `--dry-run`）。migrate 前請先停掉使用這個資料庫的 process。
- **資料庫太大**：超過 25 MB 會警告，預設上限 150 MB（`--max-file-size` 最多 250）。sandbox 是給開發用的小型資料集。

---

## 6. Safety

### 6.1 使用合成資料

- 建議只放**合成（synthetic）資料**：自己編的使用者、假的 email（`example.com`）、假的金額。
- 不要把 production 的 dump 或真實個資匯入 sandbox。
- `sqlLog: "verbose"` 會把 SQL 的參數與回傳資料原樣印在終端機（不做遮蔽），只在可以接受的地方使用。

### 6.2 應用程式仍可能對外連線

sandbox 只替換 **TypeORM 的預設 data source**。應用程式的寄信、對外 HTTP 呼叫、cache、message broker 等，預設**照它自己的設定連到真的服務**。沒有任何設定時，每次啟動都會警告：

```text
Local DB Sandbox: SMTP capture is off. The application sends its mail wherever its own settings say.
Local DB Sandbox: network guard is off ("allow"). TCP connections that leave this machine are opened, and are not reported.
Warning: nothing keeps this application from real services. Its mail and its calls to other services go where its own settings say, and may reach real ones.
```

看到這段警告，代表應用程式可能真的寄出信、真的呼叫付款或其他 API。

### 6.3 SMTP capture 與 network guard

都設定在 `.local-db-sandbox/sandbox.config.json`，修改後要重新啟動 `npm run sandbox`：

```json
{
  "smtp": { "mode": "capture", "env": { "SMTP_HOST": "{host}", "SMTP_PORT": "{port}" } },
  "network": { "mode": "block" }
}
```

- **`smtp.mode: "capture"`**：在 `127.0.0.1:2525` 開一個本機 SMTP server，信件只存在記憶體、不寄給任何人。
  - `env` 的**名稱要換成你的應用程式讀取的環境變數**（例如 `MAIL_HOST`、`MAIL_PORT`），值用 `{host}`、`{port}`、`{url}` 代入；沒列出的變數不會被設定。
  - 應用程式若有 TLS 或 SSL 設定，也請在 `env` 裡關掉（capture 只支援 plain SMTP）。
  - 查看信件：`npx local-db-sandbox mail list`、`mail show <id>`、`mail clear`（在專案目錄執行）。
- **`network.mode`**：`allow`（預設，不檢查）、`warn`（照樣連線但記錄）、`block`（連線開啟前就拒絕，應用程式收到 `ESANDBOXNETWORK` 錯誤）。本機（`localhost`、`127.x.x.x`、`::1`）永遠允許；必要的服務可用 `"allow": ["host:port", "*.domain"]` 放行。
- network guard 是**開發輔助，不是安全邊界**：只涵蓋應用程式 process 內透過 Node 的 `net`／`dns` 建立的 TCP 連線（`http`、`https`、`fetch` 及以它們為基礎的 client），不涵蓋 UDP、子 process、worker threads、自己開 socket 的 native 模組。不要用它來隔離不受信任的程式碼。

設定好之後，啟動訊息會變成：

```text
Local DB Sandbox: SMTP capture on 127.0.0.1:2525. Mail is kept in memory and sent to no one; see it with "local-db-sandbox mail list".
Local DB Sandbox: network guard "block": TCP connections that leave this machine are refused. It is a development aid, not a security boundary.
```

### 6.4 只在本機開放（loopback）

- **Local DB Studio**：只在 `127.0.0.1` 提供，沒有其他選項。API 分頁只送到本機。
- **NestJS sandbox**（`npm run sandbox`、`node .local-db-sandbox/sandbox.server.ts`）：不論應用程式的 `app.listen` 要求哪個 host，一律綁定 `127.0.0.1`，並在啟動後確認；若無法確認是 `127.0.0.1`，sandbox 會停止並報錯。
- **PostgREST endpoint 與 REST mock server**：預設 `127.0.0.1`，但接受 `--host`。不要給 `0.0.0.0`。
- **已知例外**：應用程式自己在 root module 改用 `SandboxModule.forRoot(...)` 時，應用程式照常啟動，listen 的位置由它自己的 `app.listen` 決定。要限制在本機，請在程式裡寫 `app.listen(port, "127.0.0.1")`；`init-nest` 產生的 sandbox server 則會自動處理。

### 6.5 不要拿 production 資料庫做實驗

- 本工具的任何指令都不會連線到資料庫伺服器。在 sandbox 中，除了被替換掉的預設 data source 以外，應用程式自己建立的其他 TypeORM `DataSource` 嘗試連線時會直接報錯、不會連線；不經過 TypeORM 的連線（cache、其他資料庫 client 等）則要靠 network guard 擋下。
- `generate-migration` 產生的 SQL 不會被執行。套用到任何真實資料庫之前，請先讀過、先在開發用的資料庫試跑。**不要直接對 production 執行**。
- `.local-db-sandbox/sandbox.config.json` 不需要也不應該放任何正式環境的連線資訊或密碼。

### 6.6 不要 commit 的檔案

- `*.owner.json`：執行中 process 的擁有者紀錄，含本機 endpoint 的 token。
- `*-preview.db/`：`simulate` 的拋棄式副本。
- 沒有必要時，也不要 commit 含有真實資料的 sandbox 資料庫。

---

## 7. 延伸閱讀

| 文件 | 內容 |
|---|---|
| [REFERENCE.md](REFERENCE.md) | 每個指令與選項、檔案格式、size limits、SQL logs、mail capture、network guard（英文） |
| [COMPATIBILITY.md](COMPATIBILITY.md) | SQLite runtime、importers、PostgREST 子集、Studio、generator 的精確行為（英文） |
| [ARCHITECTURE.md](ARCHITECTURE.md) | packages 與它們的邊界（英文） |
| [FORMAT.md](FORMAT.md) | 資料庫檔案與資料庫目錄的儲存格式（英文） |
