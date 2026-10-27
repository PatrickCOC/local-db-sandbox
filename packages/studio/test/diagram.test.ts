import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TableSchema } from "../../runtime/src/index.ts";
import { DIAGRAM_LIMITS, DiagramTooLargeError, MAX_LABEL_CELLS, diagramOf, layoutDiagram, textCells } from "../src/index.ts";
import type { DiagramTable, ErDiagram } from "../src/index.ts";
import { ER_SCHEMA, MARKUP_NAME, UNICODE_TABLE, manyTables, tableName } from "./support/er-fixture.ts";

/*
 * The ER diagram as the server gives it to the page (D-053): the tables of
 * the canonical schema with their columns and keys, every foreign key with
 * all of its pairs of columns, and a place for every table that no other
 * overlaps. How the page draws it is the browser test's.
 */

const table = (diagram: ErDiagram, name: string): DiagramTable => {
  const found = diagram.tables.find((each) => each.name === name);
  assert.ok(found, `the diagram has ${name}`);
  return found;
};

/** Pairs of tables whose boxes overlap. */
function overlaps(diagram: ErDiagram): string[] {
  const found: string[] = [];
  diagram.tables.forEach((a, at) => {
    for (const b of diagram.tables.slice(at + 1)) {
      if (a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height) {
        found.push(`${a.name} / ${b.name}`);
      }
    }
  });
  return found;
}

describe("the ER diagram of a schema", () => {
  it("has no table when the schema has none", async () => {
    const diagram = await layoutDiagram(diagramOf([]));
    assert.deepEqual([diagram.tables, diagram.foreignKeys, diagram.unresolved, diagram.width, diagram.height], [[], [], [], 0, 0]);
  });

  it("shows one table with its columns, types, keys, and NULL", async () => {
    const diagram = await layoutDiagram(diagramOf([ER_SCHEMA[0]!]));
    assert.equal(diagram.tables.length, 1);
    const customers = table(diagram, "customers");
    assert.deepEqual(customers.columns, [
      { name: "id", type: "integer", primaryKey: true, foreignKey: false, nullable: false },
      { name: "email", type: "varchar(120)", primaryKey: false, foreignKey: false, nullable: false },
    ]);
    assert.deepEqual([customers.x, customers.y, customers.primaryKey], [0, 0, ["id"]]);
    assert.equal(customers.height, diagram.geometry.header + 2 * diagram.geometry.row + 6);
    assert.deepEqual([diagram.width, diagram.height], [customers.width, customers.height]);
  });

  it("gives every table, with or without foreign keys, and every foreign key with all its pairs of columns", async () => {
    const diagram = await layoutDiagram(diagramOf(ER_SCHEMA));
    assert.deepEqual(
      diagram.tables.map((each) => each.name),
      ER_SCHEMA.map((each) => each.name),
    );
    assert.deepEqual(
      diagram.foreignKeys.map((key) => [key.name ?? null, key.from.table, key.from.columns, key.to.table, key.to.columns, key.self]),
      [
        ["orders_customer_fk", "orders", ["customer_id"], "customers", ["id"], false],
        [null, "order_lines", ["order_id"], "orders", ["id"], false],
        // Over two columns: one foreign key, both pairs.
        ["shipments_line_fk", "shipments", ["line_order", "line_number"], "order_lines", ["order_id", "line_no"], false],
        // To itself.
        ["employees_manager_fk", "employees", ["manager_id"], "employees", ["id"], true],
        // A cycle: employees to departments, and departments to employees.
        [null, "employees", ["department_id"], "departments", ["id"], false],
        [null, "departments", ["head_id"], "employees", ["id"], false],
        [null, UNICODE_TABLE, ["customer_id"], "customers", ["id"], false],
      ],
    );
    assert.deepEqual(new Set(diagram.foreignKeys.map((key) => key.id)).size, diagram.foreignKeys.length);
    assert.equal(diagram.foreignKeys[0]!.onDelete, "SET NULL");
    assert.deepEqual(diagram.unresolved, []);
    // The table no key touches is there all the same.
    assert.deepEqual(table(diagram, "audit_log").columns, [{ name: "message", type: "text", primaryKey: false, foreignKey: false, nullable: true }]);
    assert.deepEqual(overlaps(diagram), []);
  });

  it("marks a primary key over two columns on both, in the key's order, and a column that is key and foreign key as both", () => {
    const lines = table(diagramOf(ER_SCHEMA), "order_lines");
    assert.deepEqual(lines.primaryKey, ["order_id", "line_no"]);
    assert.deepEqual(
      lines.columns.map((column) => [column.name, column.primaryKey, column.foreignKey]),
      [
        ["order_id", true, true],
        ["line_no", true, false],
        ["quantity", false, false],
      ],
    );
    const shipments = table(diagramOf(ER_SCHEMA), "shipments");
    assert.deepEqual(
      shipments.columns.map((column) => [column.name, column.foreignKey]),
      [
        ["id", false],
        ["line_order", true],
        ["line_number", true],
      ],
    );
  });

  it("says, and does not draw, a foreign key to a table the database does not have", () => {
    const schema: TableSchema[] = [
      { name: "a", columns: [{ name: "b_id", type: "integer", nullable: true, primary: false, references: { table: "gone", column: "id" } }] },
      { name: "c", columns: [{ name: "x", type: "integer", nullable: true, primary: false }, { name: "y", type: "integer", nullable: true, primary: false }], foreignKeys: [{ columns: ["x", "y"], references: { table: "also_gone", columns: ["p", "q"] } }] },
    ];
    const diagram = diagramOf(schema);
    assert.deepEqual(diagram.foreignKeys, []);
    assert.deepEqual(
      diagram.unresolved.map((key) => [key.from.table, key.from.columns, key.to.table, key.to.columns]),
      [
        ["a", ["b_id"], "gone", ["id"]],
        ["c", ["x", "y"], "also_gone", ["p", "q"]],
      ],
    );
    assert.equal(table(diagram, "a").columns[0]!.foreignKey, true);
  });

  it("shows a type as the Rows tab does: as declared, else its canonical type, else how it is stored", () => {
    const schema: TableSchema[] = [
      {
        name: "t",
        columns: [
          { name: "a", type: "text", declaredType: "character varying(20)", canonicalType: { kind: "varchar", length: 20 }, nullable: true, primary: false },
          { name: "b", type: "text", canonicalType: { kind: "varchar", length: 20 }, nullable: true, primary: false },
          { name: "c", type: "json", nullable: true, primary: false },
        ],
      },
    ];
    assert.deepEqual(
      table(diagramOf(schema), "t").columns.map((column) => column.type),
      ["character varying(20)", "varchar(20)", "json"],
    );
  });

  it("keeps names as they are, and cuts only what a box shows of a long one", () => {
    const long = "x".repeat(60);
    const wide = "顧".repeat(30);
    const diagram = diagramOf([
      { name: MARKUP_NAME, columns: [{ name: long, type: "text", nullable: true, primary: false }] },
      { name: wide, columns: [{ name: "名稱 😀", type: "text", nullable: true, primary: false }] },
    ]);
    const markup = table(diagram, MARKUP_NAME);
    assert.equal(markup.label, undefined);
    assert.equal(markup.columns[0]!.name, long);
    assert.equal(markup.columns[0]!.label, `${"x".repeat(MAX_LABEL_CELLS - 1)}…`);
    const cjk = table(diagram, wide);
    assert.equal(cjk.name, wide);
    assert.equal(textCells(cjk.label!), MAX_LABEL_CELLS - 1);
    assert.equal(cjk.columns[0]!.label, undefined);
    // Wide characters take two cells, and the box is wide enough for them.
    assert.deepEqual([textCells("abc"), textCells("顧客"), textCells("😀"), textCells("名稱 😀")], [3, 4, 2, 7]);
    assert.ok(cjk.width > diagram.geometry.titleCell * (MAX_LABEL_CELLS - 1));
  });

  it("refuses a schema past its limits, before laying anything out", () => {
    const tooMany = manyTables(DIAGRAM_LIMITS.maxTables + 1);
    assert.throws(() => diagramOf(tooMany), (error: unknown) => error instanceof DiagramTooLargeError && error.code === "DIAGRAM_TOO_LARGE" && /401 tables/.test(error.message));
    const wide: TableSchema[] = [{ name: "w", columns: Array.from({ length: DIAGRAM_LIMITS.maxColumns + 1 }, (_unused, at) => ({ name: `c${at}`, type: "text" as const, nullable: true, primary: false })) }];
    assert.throws(() => diagramOf(wide), DiagramTooLargeError);
    assert.doesNotThrow(() => diagramOf(manyTables(DIAGRAM_LIMITS.maxTables)));
  });

  for (const count of [50, 100]) {
    it(`lays out ${count} tables without overlaps, the same way each time, in a shape a screen can show`, async () => {
      const schema = manyTables(count);
      const started = performance.now();
      const diagram = await layoutDiagram(diagramOf(schema));
      const took = performance.now() - started;
      assert.equal(diagram.tables.length, count);
      assert.ok(diagram.foreignKeys.length > count / 2, `${diagram.foreignKeys.length} foreign keys`);
      assert.deepEqual(overlaps(diagram), []);
      for (const each of diagram.tables) {
        assert.ok(each.x >= 0 && each.y >= 0 && each.x + each.width <= diagram.width && each.y + each.height <= diagram.height, `${each.name} is within the layout`);
      }
      // Neither a line nor a column of boxes: at most four times as long one way as the other.
      const ratio = diagram.width / diagram.height;
      assert.ok(ratio > 0.25 && ratio < 4, `${diagram.width} x ${diagram.height}`);
      assert.deepEqual(await layoutDiagram(diagramOf(schema)), diagram);
      // Generous: on this machine it takes about a tenth of a second.
      assert.ok(took < 10_000, `took ${Math.round(took)} ms`);
      assert.ok(table(diagram, tableName(count - 1)));
    });
  }

  it("lays out a table that a hundred tables refer to as a block, and not as one long line", async () => {
    const schema: TableSchema[] = [{ name: "users", columns: [{ name: "id", type: "integer", nullable: false, primary: true }] }];
    for (let at = 0; at < 100; at += 1) {
      schema.push({ name: `t${at}`, columns: [{ name: "user_id", type: "integer", nullable: true, primary: false, references: { table: "users", column: "id" } }] });
    }
    const diagram = await layoutDiagram(diagramOf(schema));
    assert.deepEqual(overlaps(diagram), []);
    const ratio = diagram.width / diagram.height;
    assert.ok(ratio > 0.25 && ratio < 4, `${diagram.width} x ${diagram.height}`);
  });
});
