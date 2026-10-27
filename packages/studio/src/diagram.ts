import type { ColumnSchema, TableSchema } from "../../runtime/src/index.ts";
import { formatCanonicalType } from "../../runtime-access/src/index.ts";

/*
 * The ER Diagram tab (D-053): the tables of the canonical schema as boxes,
 * and their foreign keys as lines from column to column, laid out so that
 * the page has only to draw them.
 *
 * What it is made from is the schema the runtime has (`TableSchema`, D-036),
 * as a snapshot without rows gives it: nothing of it is a second model of a
 * schema, and no row is read. A foreign key over one column is that
 * column's `references`; one over several is in the table's `foreignKeys`.
 * Each is one connection, with every pair of columns it pairs.
 *
 * Where the boxes stand is worked out by Dagre (`@dagrejs/dagre`, MIT), a
 * layered layout: the tables that are referred to stand left of those that
 * refer to them, in an order that crosses few lines. Dagre is loaded on
 * first use, here and nowhere else, so that nothing but a diagram loads it.
 * Tables that are connected are laid out together; the groups, and the
 * tables that are connected to none, are then put in rows, the largest
 * first, so that a hundred tables are not one long line.
 *
 * Sizes are worked out here, for a monospaced font of the page: a name is
 * measured in character cells, two for a character that a terminal shows
 * wide (CJK, most emoji). A name longer than a box shows is cut, and given
 * whole beside it.
 */

/** Past these, no diagram is made: a page with more would not be usable, and laying it out could take long. */
export const DIAGRAM_LIMITS = { maxTables: 400, maxColumns: 8000 } as const;

/** The geometry the page draws with: it is the one sizes were worked out with. */
export const DIAGRAM_GEOMETRY = {
  /** Height of a table's title. */
  header: 28,
  /** Height of one column's line. */
  row: 20,
  /** Width of a character cell of the body's font (12px monospace), with some room. */
  cell: 7.4,
  /** Width of a character cell of the title's font (13px bold monospace). */
  titleCell: 8.2,
  /** Room left and right inside a box, and between the parts of a line. */
  padding: 10,
  gap: 12,
} as const;

/** A name or a type longer than this, in character cells, is cut. */
export const MAX_LABEL_CELLS = 40;

export interface DiagramColumn {
  name: string;
  /** What the box shows of the name, when that is not all of it. */
  label?: string;
  type: string;
  typeLabel?: string;
  primaryKey: boolean;
  foreignKey: boolean;
  nullable: boolean;
}

export interface DiagramTable {
  name: string;
  label?: string;
  columns: DiagramColumn[];
  /** The primary key's columns, in its order. */
  primaryKey: string[];
  /** Where the box stands: its upper left corner. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Where the parts of a column's line begin, from the box's left edge: keys, name, type, NULL. */
  slots: [number, number, number, number];
}

export interface DiagramForeignKey {
  /** Unique within the diagram. */
  id: string;
  name?: string;
  /** The table that refers, and its columns, in the key's order. */
  from: { table: string; columns: string[] };
  /** The table referred to, and the columns paired with those of `from`, in the same order. */
  to: { table: string; columns: string[] };
  /** A table that refers to itself. */
  self: boolean;
  onDelete?: string;
  onUpdate?: string;
}

export interface ErDiagram {
  tables: DiagramTable[];
  /** The foreign keys whose table is in the diagram: each one drawn. */
  foreignKeys: DiagramForeignKey[];
  /** Foreign keys that refer to a table the database does not have: not drawn, and said. */
  unresolved: DiagramForeignKey[];
  geometry: typeof DIAGRAM_GEOMETRY;
  /** The extent of the layout. */
  width: number;
  height: number;
}

export class DiagramTooLargeError extends Error {
  readonly code = "DIAGRAM_TOO_LARGE";
}

/** Throws when a schema of this size is past what a diagram is made of. */
export function checkDiagramSize(tables: number, columns: number): void {
  if (tables > DIAGRAM_LIMITS.maxTables || columns > DIAGRAM_LIMITS.maxColumns) {
    throw new DiagramTooLargeError(
      `The schema has ${tables} tables and ${columns} columns: an ER diagram is made of at most ${DIAGRAM_LIMITS.maxTables} tables and ${DIAGRAM_LIMITS.maxColumns} columns. The Rows and Export tabs show it table by table.`,
    );
  }
}

/** How many character cells a text takes: two for a character shown wide. */
export function textCells(text: string): number {
  let cells = 0;
  for (const character of text) {
    cells += isWide(character.codePointAt(0) ?? 0) ? 2 : 1;
  }
  return cells;
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe4f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x3fffd)
  );
}

/** The text, cut to at most `MAX_LABEL_CELLS` cells with an ellipsis; `undefined` when it fits whole. */
function cut(text: string): string | undefined {
  if (textCells(text) <= MAX_LABEL_CELLS) {
    return undefined;
  }
  let kept = "";
  let cells = 0;
  for (const character of text) {
    const width = isWide(character.codePointAt(0) ?? 0) ? 2 : 1;
    if (cells + width > MAX_LABEL_CELLS - 1) {
      break;
    }
    kept += character;
    cells += width;
  }
  return `${kept}…`;
}

/** The type as Studio's Rows tab shows it: as its source declared it, else what it is, else how it is stored. */
function typeOf(column: ColumnSchema): string {
  return column.declaredType ?? (column.canonicalType !== undefined ? formatCanonicalType(column.canonicalType) : column.type);
}

/** The foreign keys of the tables: those of single columns, then those of several, in the table's order. */
function foreignKeysOf(tables: TableSchema[]): DiagramForeignKey[] {
  const keys: DiagramForeignKey[] = [];
  for (const table of tables) {
    for (const column of table.columns) {
      if (column.references !== undefined) {
        const reference = column.references;
        keys.push({
          id: "",
          ...(reference.name !== undefined && { name: reference.name }),
          from: { table: table.name, columns: [column.name] },
          to: { table: reference.table, columns: [reference.column] },
          self: reference.table === table.name,
          ...(reference.onDelete !== undefined && { onDelete: reference.onDelete }),
          ...(reference.onUpdate !== undefined && { onUpdate: reference.onUpdate }),
        });
      }
    }
    for (const key of table.foreignKeys ?? []) {
      keys.push({
        id: "",
        ...(key.name !== undefined && { name: key.name }),
        from: { table: table.name, columns: [...key.columns] },
        to: { table: key.references.table, columns: [...key.references.columns] },
        self: key.references.table === table.name,
        ...(key.onDelete !== undefined && { onDelete: key.onDelete }),
        ...(key.onUpdate !== undefined && { onUpdate: key.onUpdate }),
      });
    }
  }
  return keys.map((key, index) => ({ ...key, id: `fk${index}` }));
}

/** A table's box, without a place yet. */
function boxOf(table: TableSchema, foreignColumns: Set<string>): DiagramTable {
  const g = DIAGRAM_GEOMETRY;
  const primaryKey = table.primaryKey?.columns ?? table.columns.filter((column) => column.primary).map((column) => column.name);
  const columns = table.columns.map((column): DiagramColumn => {
    const type = typeOf(column);
    const label = cut(column.name);
    const typeLabel = cut(type);
    return {
      name: column.name,
      ...(label !== undefined && { label }),
      type,
      ...(typeLabel !== undefined && { typeLabel }),
      primaryKey: column.primary || primaryKey.includes(column.name),
      foreignKey: foreignColumns.has(column.name),
      nullable: column.nullable,
    };
  });
  const label = cut(table.name);
  const nameCells = Math.max(4, ...columns.map((column) => textCells(column.label ?? column.name)));
  const typeCells = Math.max(4, ...columns.map((column) => textCells(column.typeLabel ?? column.type)));
  // "PK FK" and "not null" are the widest of what those parts show.
  const keys = g.padding;
  const name = keys + 5 * g.cell + g.gap;
  const type = name + nameCells * g.cell + g.gap;
  const nulls = type + typeCells * g.cell + g.gap;
  const body = nulls + 8 * g.cell + g.padding;
  const title = 2 * g.padding + textCells(label ?? table.name) * g.titleCell;
  return {
    name: table.name,
    ...(label !== undefined && { label }),
    columns,
    primaryKey: [...primaryKey],
    x: 0,
    y: 0,
    width: Math.ceil(Math.max(body, title, 160)),
    height: g.header + Math.max(1, columns.length) * g.row + 6,
    slots: [keys, Math.round(name), Math.round(type), Math.round(nulls)],
  };
}

/** The tables of a schema, and their foreign keys, without places yet. Throws `DiagramTooLargeError` past the limits. */
export function diagramOf(tables: TableSchema[]): ErDiagram {
  checkDiagramSize(
    tables.length,
    tables.reduce((sum, table) => sum + table.columns.length, 0),
  );
  const names = new Set(tables.map((table) => table.name));
  const keys = foreignKeysOf(tables);
  const foreignColumns = new Map<string, Set<string>>();
  for (const key of keys) {
    const columns = foreignColumns.get(key.from.table) ?? new Set<string>();
    key.from.columns.forEach((column) => columns.add(column));
    foreignColumns.set(key.from.table, columns);
  }
  return {
    tables: tables.map((table) => boxOf(table, foreignColumns.get(table.name) ?? new Set())),
    foreignKeys: keys.filter((key) => names.has(key.to.table)),
    unresolved: keys.filter((key) => !names.has(key.to.table)),
    geometry: DIAGRAM_GEOMETRY,
    width: 0,
    height: 0,
  };
}

/** Room between the boxes, and between groups. */
const SPACING = { node: 36, rank: 110, group: 70 } as const;

/** The parts of the diagram that are connected: each a list of tables, in the diagram's order. */
function groupsOf(diagram: ErDiagram): DiagramTable[][] {
  const index = new Map(diagram.tables.map((table, at) => [table.name, at]));
  const parent = diagram.tables.map((_, at) => at);
  const root = (at: number): number => {
    while (parent[at] !== at) {
      parent[at] = parent[parent[at]!]!;
      at = parent[at]!;
    }
    return at;
  };
  for (const key of diagram.foreignKeys) {
    const a = root(index.get(key.from.table)!);
    const b = root(index.get(key.to.table)!);
    if (a !== b) {
      parent[Math.max(a, b)] = Math.min(a, b);
    }
  }
  const groups = new Map<number, DiagramTable[]>();
  diagram.tables.forEach((table, at) => {
    const group = groups.get(root(at)) ?? [];
    group.push(table);
    groups.set(root(at), group);
  });
  return [...groups.values()];
}

/**
 * Places the tables of a diagram: each connected group by Dagre, then the
 * groups in rows. The same schema is always laid out the same way.
 */
export async function layoutDiagram(diagram: ErDiagram): Promise<ErDiagram> {
  // On first use, and here alone (D-053).
  const { default: dagre } = await import("@dagrejs/dagre");
  const placed = new Map<string, { x: number; y: number }>();
  const blocks: { tables: DiagramTable[]; width: number; height: number }[] = [];

  for (const group of groupsOf(diagram)) {
    if (group.length === 1) {
      const [table] = group as [DiagramTable];
      placed.set(table.name, { x: 0, y: 0 });
      blocks.push({ tables: group, width: table.width, height: table.height });
      continue;
    }
    const members = new Set(group.map((table) => table.name));
    // A table that is connected to one other alone is a leaf of it. When a table has many leaves, they would stand in
    // one rank, as long as all of them. Instead, the layout is told that the first few follow the table, and each of
    // the others follows a leaf before it: they make a block of a few ranks. Only where the boxes stand comes of this;
    // the page draws every foreign key from its own columns.
    const neighbours = new Map<string, Set<string>>(group.map((table) => [table.name, new Set<string>()]));
    for (const key of diagram.foreignKeys) {
      if (!key.self && members.has(key.from.table)) {
        neighbours.get(key.from.table)!.add(key.to.table);
        neighbours.get(key.to.table)!.add(key.from.table);
      }
    }
    const leaves = new Map<string, string[]>();
    for (const [name, around] of neighbours) {
      const [hub] = around;
      if (around.size === 1 && neighbours.get(hub!)!.size > 1) {
        leaves.set(hub!, [...(leaves.get(hub!) ?? []), name]);
      }
    }
    /** Of a leaf that follows another leaf in the layout: that one. */
    const follows = new Map<string, string>();
    for (const list of leaves.values()) {
      const perRank = Math.max(4, Math.ceil(Math.sqrt(list.length * 1.5)));
      list.forEach((name, at) => {
        if (at >= perRank) {
          follows.set(name, list[at - perRank]!);
        }
      });
    }
    const edges = new Set<string>();
    const ordered: [string, string][] = [];
    const edge = (from: string, to: string): void => {
      const id = JSON.stringify([from, to]);
      if (!edges.has(id)) {
        edges.add(id);
        ordered.push([from, to]);
      }
    };
    for (const key of diagram.foreignKeys) {
      // The table referred to stands before the one that refers to it. A table's reference to itself places nothing.
      if (!key.self && members.has(key.from.table)) {
        const before = follows.get(key.from.table) ?? follows.get(key.to.table);
        if (before !== undefined) {
          edge(before, follows.has(key.from.table) ? key.from.table : key.to.table);
        } else {
          edge(key.to.table, key.from.table);
        }
      }
    }
    // Left to right, and top to bottom: the one whose shape is nearer a screen's is kept. A table referred to by many
    // makes a long line of those that refer to it, which is better across a screen than down it, or the other way round.
    let best: { places: Map<string, { x: number; y: number }>; width: number; height: number; score: number } | undefined;
    for (const rankdir of ["LR", "TB"] as const) {
      const graph = new dagre.graphlib.Graph();
      graph.setGraph({ rankdir, nodesep: SPACING.node, ranksep: rankdir === "LR" ? SPACING.rank : SPACING.rank * 0.7, edgesep: 12, marginx: 0, marginy: 0 });
      graph.setDefaultEdgeLabel(() => ({}));
      for (const table of group) {
        graph.setNode(table.name, { width: table.width, height: table.height });
      }
      for (const [from, to] of ordered) {
        graph.setEdge(from, to);
      }
      dagre.layout(graph);
      let left = Infinity;
      let top = Infinity;
      let right = -Infinity;
      let bottom = -Infinity;
      const places = new Map<string, { x: number; y: number }>();
      for (const table of group) {
        const at = graph.node(table.name);
        const x = at.x - table.width / 2;
        const y = at.y - table.height / 2;
        places.set(table.name, { x, y });
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x + table.width);
        bottom = Math.max(bottom, y + table.height);
      }
      for (const [name, at] of places) {
        places.set(name, { x: at.x - left, y: at.y - top });
      }
      const width = right - left;
      const height = bottom - top;
      // How large it is shown when fitted to a view of 16:10. Lines run from the side of a column to the side of another,
      // which reads best left to right: top to bottom is kept only when it is shown more than twice as large (a table
      // that many refer to makes a line of them that is long either way, and longer left to right).
      const score = Math.min(1600 / Math.max(1, width), 1000 / Math.max(1, height)) * (rankdir === "LR" ? 2 : 1);
      if (best === undefined || score > best.score) {
        best = { places, width, height, score };
      }
    }
    for (const [name, at] of best!.places) {
      placed.set(name, at);
    }
    blocks.push({ tables: group, width: best!.width, height: best!.height });
  }

  // The groups in rows: the larger ones first, then the tables that stand alone, by name.
  blocks.sort((a, b) => b.tables.length - a.tables.length || (a.tables.length === 1 ? a.tables[0]!.name.localeCompare(b.tables[0]!.name) : b.height - a.height));
  const area = blocks.reduce((sum, block) => sum + (block.width + SPACING.group) * (block.height + SPACING.group), 0);
  const rowWidth = Math.max(...blocks.map((block) => block.width), Math.sqrt(area * 1.6), 0);
  let x = 0;
  let y = 0;
  let rowHeight = 0;
  let width = 0;
  for (const block of blocks) {
    if (x > 0 && x + block.width > rowWidth) {
      x = 0;
      y += rowHeight + SPACING.group;
      rowHeight = 0;
    }
    for (const table of block.tables) {
      const at = placed.get(table.name)!;
      placed.set(table.name, { x: at.x + x, y: at.y + y });
    }
    x += block.width + SPACING.group;
    rowHeight = Math.max(rowHeight, block.height);
    width = Math.max(width, x - SPACING.group);
  }

  return {
    ...diagram,
    tables: diagram.tables.map((table) => {
      const at = placed.get(table.name)!;
      return { ...table, x: Math.round(at.x), y: Math.round(at.y) };
    }),
    width: Math.ceil(width),
    height: Math.ceil(y + rowHeight),
  };
}
