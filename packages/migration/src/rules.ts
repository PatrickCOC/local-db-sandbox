import { namedNow } from "../../runtime/src/expression-names.ts";
import type { TypeState } from "../../schema-diff/src/index.ts";
import { enumNamesIn, hasText } from "./model.ts";
import type { ModelForeignKey, ModelTable, SchemaModel } from "./model.ts";
import { constraintNames } from "./operations.ts";
import type { Operation } from "./plan.ts";

/*
 * What a step of a migration may not do at the moment it is carried out
 * (D-038). `operations.ts` says what an operation means on any schema; this
 * says what a database refuses on the way, whatever the schema is to become:
 *
 * - A foreign key refers to a table and to columns that are there. So a
 *   table or column is not dropped while a foreign key refers to it, and a
 *   foreign key is added when what it refers to is there.
 * - A key, a foreign key, or an index is over columns that are there, and so
 *   is what a key or an index carries along, and what a check, an index's
 *   expression, or its condition names. So a column is not dropped while one
 *   of them is over it, carries it along, or names it. A database either
 *   refuses that or drops the thing with the column without saying so
 *   (PostgreSQL); a plan drops the thing first, as a step of its own. (Which
 *   columns a text names is known where the schema says it, D-040. Of a
 *   text of which it says nothing, nothing is refused.)
 * - A column is of a type that is there. So an enumerated type is there
 *   before a column takes it, and is not dropped while one has it.
 * - A value is added to a type next to a value the type has.
 * - A name is one object's where names are an object's own: a table's and a
 *   type's in the schema, a column's and a constraint's in its table, an
 *   index's in the schema (the runtime creates an index by its name).
 *
 * The planner puts the steps in an order in which none of this is met, and
 * the validator refuses a plan in which it is. These are what the canonical
 * schema's own runtime refuses and what databases refuse alike. What only
 * one database refuses (PostgreSQL: a key dropped while a foreign key rests
 * on it) is not here.
 */

const named = (noun: string, name: string | undefined): string => `the ${noun}${name === undefined ? "" : ` "${name}"`}`;

/** The foreign keys of the schema that refer to a table, each with the table it is on. */
function referring(model: SchemaModel, target: ModelTable): { table: ModelTable; key: ModelForeignKey }[] {
  return model.referencesTo(target);
}

function missingTypes(model: SchemaModel, type: TypeState): string[] {
  return [...new Set([...(type.enum === undefined ? [] : [type.enum]), ...enumNamesIn(type.canonical)])].filter((name) => model.enumType(name) === undefined);
}

/**
 * Why an operation may not be carried out on the schema as it is now, though
 * the operation itself makes sense. Empty when it may. An object that is not
 * there at all is not a reason given here: carrying the operation out says
 * so.
 */
export function blockers(model: SchemaModel, operation: Operation): string[] {
  const reasons: string[] = [];
  const table = "table" in operation ? model.table(operation.op === "renameTable" ? operation.from : operation.table) : undefined;
  const nameTaken = (name: string | undefined): void => {
    if (table !== undefined && name !== undefined && constraintNames(table).includes(name)) {
      reasons.push(`table "${table.name}" has a constraint "${name}" already.`);
    }
  };
  const indexTaken = (name: string): void => {
    const holder = model.tables.find((other) => other.indexes.some((index) => index.name === name));
    if (holder !== undefined) {
      reasons.push(`there is an index "${name}" already, of table "${holder.name}".`);
    }
  };
  const typesThere = (column: string, type: TypeState): void => {
    missingTypes(model, type).forEach((name) => reasons.push(`there is no enumerated type "${name}" for the column "${column}" to be of.`));
  };

  switch (operation.op) {
    case "dropTable": {
      if (table !== undefined) {
        for (const { table: owner, key } of referring(model, table)) {
          if (owner !== table) {
            reasons.push(`${named("foreign key", key.name)} of table "${owner.name}" refers to it.`);
          }
        }
      }
      break;
    }
    case "dropColumn": {
      if (table === undefined) {
        break;
      }
      const column = operation.column;
      /** What is in the way for a key, a constraint, or an index of the table: it is over the column, or it carries the column along. */
      const inTheWay = (what: string, object: { columns: readonly string[]; include?: readonly string[] | undefined }): void => {
        if (object.columns.includes(column)) {
          reasons.push(`${what} is over it.`);
        } else if (object.include?.includes(column) === true) {
          reasons.push(`${what} carries it along.`);
        }
      };
      if (table.primaryKey !== undefined) {
        inTheWay(named("primary key", table.primaryKey.name), table.primaryKey);
      }
      table.uniques.forEach((unique) => inTheWay(named("unique constraint", unique.name), unique));
      table.foreignKeys.forEach((key) => inTheWay(named("foreign key", key.name), key));
      table.indexes.forEach((index) => inTheWay(named("index", index.name), index));
      // A text that names the column, by whatever name the text has for it.
      table.checks.filter((check) => namedNow(check.names, "column", column)).forEach((check) => reasons.push(`${named("check", check.name)} names it.`));
      table.indexes.filter((index) => hasText(index) && namedNow(index.names, "column", column)).forEach((index) => reasons.push(`${named("index", index.name)} names it in an expression or in its condition.`));
      for (const { table: owner, key } of referring(model, table)) {
        if (key.refColumns.includes(column)) {
          reasons.push(`${named("foreign key", key.name)} of table "${owner.name}" refers to it.`);
        }
      }
      break;
    }
    case "renameIndex":
      indexTaken(operation.index);
      break;
    case "addEnumValue": {
      const anchor = operation.afterValue ?? operation.beforeValue;
      const type = model.enumType(operation.enum);
      if (type !== undefined && anchor !== undefined && !type.values.includes(anchor)) {
        reasons.push(`the type has no value "${anchor}" to put it ${operation.afterValue !== undefined ? "after" : "before"}.`);
      }
      break;
    }
    case "addTable": {
      operation.after.columns.forEach((column) => typesThere(column.name, column.type));
      const given = [operation.after.primaryKey?.name, ...operation.after.uniques.map((unique) => unique.name), ...operation.after.checks.map((check) => check.name)].filter((name): name is string => name !== undefined);
      [...new Set(given.filter((name, index) => given.indexOf(name) !== index))].forEach((name) => reasons.push(`it would have two constraints "${name}".`));
      break;
    }
    case "addColumn":
      typesThere(operation.column, operation.after.type);
      break;
    case "alterColumnType":
      typesThere(operation.column, operation.after);
      break;
    case "dropEnumType":
      model.columnsOfEnum(operation.enum).forEach(({ table: owner, column }) => reasons.push(`the column "${owner.name}"."${column.name}" is of this type.`));
      break;
    case "addPrimaryKey":
    case "addUnique":
    case "addCheck":
      nameTaken(operation.after.name);
      break;
    case "addIndex":
      indexTaken(operation.after.name);
      break;
    case "addForeignKey": {
      nameTaken(operation.after.name);
      const { table: targetName, columns } = operation.after.references;
      const target = model.table(targetName);
      if (target === undefined) {
        reasons.push(`there is no table "${targetName}" for it to refer to.`);
        break;
      }
      columns.filter((name) => !target.columns.some((column) => column.name === name)).forEach((name) => reasons.push(`table "${targetName}" has no column "${name}" for it to refer to.`));
      if (columns.length !== operation.after.columns.length) {
        reasons.push(`it has ${operation.after.columns.length} column${operation.after.columns.length === 1 ? "" : "s"} and refers to ${columns.length}.`);
      }
      break;
    }
    default:
      break;
  }
  return reasons;
}
