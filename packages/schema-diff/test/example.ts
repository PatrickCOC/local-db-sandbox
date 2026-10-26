import type { DatabaseSchema } from "../../runtime/src/index.ts";
import { BIGINT, INTEGER, TEXT, TIMESTAMPTZ, column, enumType, keyColumn, origin, renamed, schema, table } from "./support.ts";

/*
 * A schema and what it became: most kinds of change at once, and several of
 * some, so that their order shows. Each call gives new objects.
 *
 * What changes: the type `status` is renamed to `post_status`, its value
 * `live` to `public`, and it gains `review`; `mood` gains `great`; `kind` is
 * new and `legacy` is gone. The table `users` is renamed to `accounts`, its
 * column `name` to `full_name`; `age` becomes a bigint that is not null;
 * `created_at` and `kind` are new; one index goes and one comes, a unique
 * constraint comes, and both checks change. In `posts` the key is renamed,
 * the foreign key gets another action, `title` goes and `slug` comes.
 * `old_logs` is dropped, `comments` and `audit` are new, `tags` stays.
 */

export function exampleBefore(): DatabaseSchema {
  return schema(
    [
      table(
        "users",
        [
          keyColumn("id"),
          column("email", TEXT, { nullable: false }),
          column("name", TEXT, { origin: origin("name") }),
          column("age"),
          column("mood", enumType("mood"), { enum: { name: "mood", values: ["ok", "meh"] } }),
        ],
        {
          primaryKey: { name: "users_pkey", columns: ["id"] },
          uniques: [{ name: "users_email_key", columns: ["email"] }],
          indexes: [
            { name: "users_name_idx", columns: ["name"] },
            { name: "users_age_idx", columns: ["age"] },
          ],
          checks: [{ name: "users_age_check", expression: "age > 0" }, { expression: "name <> ''" }],
          origin: origin("users"),
        },
      ),
      table(
        "posts",
        [
          keyColumn("id"),
          column("author_id", INTEGER, { references: { table: "users", column: "id", onDelete: "CASCADE", name: "posts_author_id_fkey" } }),
          column("state", enumType("status"), { nullable: false, default: "draft", enum: { name: "status", values: ["draft", "live"] } }),
          column("title", TEXT),
        ],
        {
          primaryKey: { name: "posts_pkey", columns: ["id"], origin: origin("posts_pkey", "0001_init.sql", 2) },
          indexes: [{ name: "posts_state_idx", columns: ["state"] }],
        },
      ),
      table("old_logs", [keyColumn("id"), column("at", TIMESTAMPTZ)], { indexes: [{ name: "old_logs_at_idx", columns: ["at"] }] }),
      table("tags", [keyColumn("id"), column("label", TEXT)]),
    ],
    [
      { name: "status", values: ["draft", "live"], origin: origin("status") },
      { name: "mood", values: ["ok", "meh"] },
      { name: "legacy", values: ["x"] },
    ],
  );
}

export function exampleAfter(): DatabaseSchema {
  return schema(
    [
      table(
        "accounts",
        [
          keyColumn("id"),
          column("email", TEXT, { nullable: false }),
          column("full_name", TEXT, { origin: origin("name"), renames: [renamed("name", "full_name", "0002_rename.sql", 2)] }),
          column("age", BIGINT, { nullable: false }),
          column("mood", enumType("mood"), { enum: { name: "mood", values: ["ok", "meh", "great"] } }),
          column("created_at", TIMESTAMPTZ, { nullable: false, defaultFunction: "current_timestamp", defaultExpression: "now()" }),
          column("kind", enumType("kind"), { enum: { name: "kind", values: ["a", "b"] } }),
        ],
        {
          primaryKey: { name: "users_pkey", columns: ["id"] },
          uniques: [
            { name: "users_email_key", columns: ["email"] },
            { name: "accounts_full_name_key", columns: ["full_name"] },
          ],
          indexes: [
            { name: "users_name_idx", columns: ["full_name"] },
            { name: "accounts_created_idx", columns: ["created_at"] },
          ],
          checks: [{ name: "users_age_check", expression: "age >= 0" }, { expression: "full_name <> ''" }],
          origin: origin("users"),
          renames: [renamed("users", "accounts", "0002_rename.sql", 1)],
        },
      ),
      table(
        "posts",
        [
          keyColumn("id"),
          column("author_id", INTEGER, { references: { table: "accounts", column: "id", onDelete: "SET NULL", name: "posts_author_id_fkey" } }),
          column("state", enumType("post_status"), { nullable: false, default: "draft", enum: { name: "post_status", values: ["draft", "review", "public"] } }),
          column("slug", TEXT),
        ],
        {
          primaryKey: { name: "posts_key", columns: ["id"], origin: origin("posts_pkey", "0001_init.sql", 2), renames: [renamed("posts_pkey", "posts_key", "0002_rename.sql", 5)] },
          indexes: [{ name: "posts_state_idx", columns: ["state"] }],
        },
      ),
      table("tags", [keyColumn("id"), column("label", TEXT)]),
      table("comments", [keyColumn("id"), column("post_id", INTEGER, { references: { table: "posts", column: "id", name: "comments_post_id_fkey" } }), column("body", TEXT)], {
        primaryKey: { name: "comments_pkey", columns: ["id"] },
        indexes: [{ name: "comments_post_idx", columns: ["post_id"] }],
      }),
      table("audit", [keyColumn("id")]),
    ],
    [
      {
        name: "post_status",
        values: ["draft", "review", "public"],
        origin: origin("status"),
        renames: [renamed("status", "post_status", "0002_rename.sql", 3)],
        valueRenames: [renamed("live", "public", "0002_rename.sql", 4)],
      },
      { name: "mood", values: ["ok", "meh", "great"] },
      { name: "kind", values: ["a", "b"] },
    ],
  );
}
