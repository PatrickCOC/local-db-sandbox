import { Column, CreateDateColumn, DeleteDateColumn, Entity, Generated, PrimaryColumn, PrimaryGeneratedColumn, UpdateDateColumn, VersionColumn } from "typeorm";

/*
 * Made-up entities, one per family of column types, declared as an
 * application written for PostgreSQL or MySQL declares them. They exist to
 * check what value an application gets back for each type; nothing about
 * them is taken from a real schema.
 */

export enum Status {
  Draft = "draft",
  Published = "published",
}

export enum Priority {
  Low = 1,
  High = 2,
}

@Entity("flags")
export class Flag {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "boolean" })
  enabled!: boolean;

  @Column({ type: "bool", nullable: true })
  verified!: boolean | null;

  /** No type given: TypeORM takes it from the property's type. */
  @Column({ nullable: true })
  plain!: boolean;

  @Column({ type: "boolean", default: true })
  active!: boolean;

  @Column({ type: "boolean", default: false })
  archived!: boolean;
}

@Entity("moments")
export class Moment {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "timestamp", nullable: true })
  stamp!: Date | null;

  @Column({ type: "timestamptz", nullable: true })
  stampZone!: Date | null;

  @Column({ type: "timestamp with time zone", nullable: true })
  stampLong!: Date | null;

  @Column({ type: "datetime", nullable: true })
  dateTime!: Date | null;

  /** No type given: a Date property. */
  @Column({ nullable: true })
  plain!: Date;

  @Column({ type: "date", nullable: true })
  day!: string | null;

  @Column({ type: "time", nullable: true })
  clock!: string | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn({ type: "timestamptz" })
  updatedAt!: Date;

  @DeleteDateColumn()
  deletedAt!: Date | null;

  @VersionColumn()
  version!: number;
}

/** Times of day with a zone, which SQLite's dialect has no name for. */
@Entity("clocks")
export class Clock {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "time with time zone", nullable: true })
  zoned!: string | null;

  @Column({ type: "timetz", nullable: true })
  short!: string | null;

  @Column({ type: "time without time zone", nullable: true })
  local!: string | null;
}

@Entity("papers")
export class Paper {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "json", nullable: true })
  json!: unknown;

  @Column({ type: "jsonb", nullable: true })
  jsonb!: unknown;

  @Column({ type: "simple-json", nullable: true })
  simple!: unknown;
}

@Entity("choices")
export class Choice {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "enum", enum: Status, default: Status.Draft })
  status!: Status;

  @Column({ type: "enum", enum: Priority, nullable: true })
  priority!: Priority | null;

  @Column({ type: "simple-enum", enum: Status, nullable: true })
  simple!: Status | null;

  @Column({ type: "enum", enum: Status, array: true, nullable: true })
  several!: Status[] | null;
}

@Entity("amounts")
export class Amount {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "bigint", nullable: true })
  big!: string | null;

  @Column({ type: "int8", nullable: true })
  big8!: string | null;

  @Column({ type: "decimal", precision: 12, scale: 2, nullable: true })
  price!: string | null;

  @Column({ type: "numeric", precision: 20, scale: 6, nullable: true })
  rate!: string | null;

  /** No precision or scale. */
  @Column({ type: "numeric", nullable: true })
  loose!: string | null;

  @Column({ type: "float8", nullable: true })
  ratio!: number | null;

  @Column({ type: "double precision", nullable: true })
  wide!: number | null;

  @Column({ type: "real", nullable: true })
  narrow!: number | null;

  @Column({ type: "int4", nullable: true })
  count!: number | null;

  @Column({ type: "smallint", nullable: true })
  small!: number | null;

  @Column({ type: "decimal", precision: 12, scale: 2, default: 0 })
  balance!: string;

  /** The application's own way of getting a number: it parses the text its driver returns. */
  @Column({
    type: "decimal",
    precision: 12,
    scale: 2,
    nullable: true,
    transformer: { to: (value?: number | null) => value, from: (value?: string | null) => (typeof value === "string" ? Number.parseFloat(value) : value) },
  })
  parsed!: number | null;
}

@Entity("lists")
export class List {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "simple-array", nullable: true })
  simple!: string[] | null;

  @Column({ type: "int", array: true, nullable: true })
  numbers!: number[] | null;

  @Column({ type: "text", array: true, nullable: true })
  words!: string[] | null;

  @Column({ type: "boolean", array: true, nullable: true })
  switches!: boolean[] | null;

  @Column({ type: "timestamptz", array: true, nullable: true })
  times!: Date[] | null;
}

@Entity("identities")
export class Identity {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "uuid", nullable: true })
  ref!: string | null;

  @Column({ type: "uuid" })
  @Generated("uuid")
  token!: string;

  @Column({ type: "varchar", length: 40, nullable: true })
  name!: string | null;

  @Column({ type: "citext", nullable: true })
  email!: string | null;

  @Column({ type: "char", length: 2, nullable: true })
  code!: string | null;
}

/** A key that is not generated, and binary data as PostgreSQL and MySQL name it. */
@Entity("attachments")
export class Attachment {
  @PrimaryColumn({ type: "uuid" })
  id!: string;

  @Column({ type: "bytea", nullable: true })
  bytes!: Buffer | null;

  @Column({ type: "blob", nullable: true })
  blob!: Buffer | null;

  @Column({ type: "varbinary", length: 16, nullable: true })
  short!: Buffer | null;
}
