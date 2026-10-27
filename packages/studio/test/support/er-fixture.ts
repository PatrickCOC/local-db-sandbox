import type { TableSchema } from "../../../runtime/src/index.ts";

/*
 * Schemas for the ER Diagram tab's tests: one that has every kind of key a
 * diagram shows, with names that are not plain, and schemas of many tables.
 */

/** A name that would be markup, were it put on the page as markup. */
export const MARKUP_NAME = `<img src=x onerror="window.__xss=1">`;
/** A name in Chinese, with quotes and an ampersand. */
export const UNICODE_TABLE = `顧客 "資料" & 'x'`;

export const ER_SCHEMA: TableSchema[] = [
  {
    name: "customers",
    columns: [
      { name: "id", type: "integer", nullable: false, primary: true, autoIncrement: true },
      { name: "email", type: "text", declaredType: "varchar(120)", nullable: false, primary: false },
    ],
  },
  {
    name: "orders",
    columns: [
      { name: "id", type: "integer", nullable: false, primary: true },
      { name: "customer_id", type: "integer", nullable: true, primary: false, references: { table: "customers", column: "id", name: "orders_customer_fk", onDelete: "SET NULL" } },
    ],
  },
  {
    // A primary key over two columns, one of which refers to a table.
    name: "order_lines",
    columns: [
      { name: "order_id", type: "integer", nullable: false, primary: true, references: { table: "orders", column: "id" } },
      { name: "line_no", type: "integer", nullable: false, primary: true },
      { name: "quantity", type: "integer", nullable: false, primary: false },
    ],
    primaryKey: { name: "order_lines_pkey", columns: ["order_id", "line_no"] },
  },
  {
    // A foreign key over two columns.
    name: "shipments",
    columns: [
      { name: "id", type: "integer", nullable: false, primary: true },
      { name: "line_order", type: "integer", nullable: false, primary: false },
      { name: "line_number", type: "integer", nullable: false, primary: false },
    ],
    foreignKeys: [{ name: "shipments_line_fk", columns: ["line_order", "line_number"], references: { table: "order_lines", columns: ["order_id", "line_no"] } }],
  },
  {
    // A table that refers to itself, and to a table that refers to it: a cycle.
    name: "employees",
    columns: [
      { name: "id", type: "integer", nullable: false, primary: true },
      { name: "manager_id", type: "integer", nullable: true, primary: false, references: { table: "employees", column: "id", name: "employees_manager_fk" } },
      { name: "department_id", type: "integer", nullable: true, primary: false, references: { table: "departments", column: "id" } },
    ],
  },
  {
    name: "departments",
    columns: [
      { name: "id", type: "integer", nullable: false, primary: true },
      { name: "head_id", type: "integer", nullable: true, primary: false, references: { table: "employees", column: "id" } },
    ],
  },
  // A table with no foreign key, that none refers to.
  { name: "audit_log", columns: [{ name: "message", type: "text", nullable: true, primary: false }] },
  {
    name: MARKUP_NAME,
    columns: [{ name: `<b onmouseover="window.__xss=2">x</b>`, type: "text", nullable: true, primary: false }],
  },
  {
    name: UNICODE_TABLE,
    columns: [
      { name: "編號", type: "integer", nullable: false, primary: true },
      { name: "名稱 😀", type: "text", nullable: true, primary: false },
      { name: "customer_id", type: "integer", nullable: true, primary: false, references: { table: "customers", column: "id" } },
    ],
  },
];

/** Rows for the fixture: one value in a table that no diagram may show. */
export const ER_ROWS = (): Record<string, Record<string, unknown>[]> => ({
  customers: [{ id: 1, email: "row-value-that-is-never-in-a-diagram@example.test" }],
  orders: [{ id: 1, customer_id: 1 }],
});

/**
 * `count` tables as an application has them: a table of users most refer to, and chains of tables that refer to one
 * of the few before them. The same count gives the same schema.
 */
export function manyTables(count: number): TableSchema[] {
  let seed = 11;
  const random = (n: number): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed % n;
  };
  const tables: TableSchema[] = [];
  for (let at = 0; at < count; at += 1) {
    const columns: TableSchema["columns"] = [{ name: "id", type: "integer", nullable: false, primary: true }];
    for (let column = 0; column < 6; column += 1) {
      columns.push({ name: `field_${column}`, type: "text", nullable: column % 2 === 0, primary: false });
    }
    if (at > 0 && random(10) < 4) {
      columns.push({ name: "user_id", type: "integer", nullable: true, primary: false, references: { table: "table_000", column: "id" } });
    }
    if (at > 1 && random(10) < 5) {
      columns.push({ name: "parent_id", type: "integer", nullable: true, primary: false, references: { table: tableName(at - 1 - random(Math.min(at - 1, 5))), column: "id" } });
    }
    tables.push({ name: tableName(at), columns });
  }
  return tables;
}

export const tableName = (at: number): string => `table_${String(at).padStart(3, "0")}`;
