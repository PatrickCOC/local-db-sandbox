import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn, UpdateDateColumn } from "typeorm";

/** Columns that hold JSON on PostgreSQL, declared in each way TypeORM offers. */
@Entity("documents")
export class Document {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "varchar", length: 50 })
  title!: string;

  @Column({ type: "jsonb", nullable: true })
  body!: unknown;

  @Column({ type: "json", nullable: true })
  settings!: unknown;

  @Column({ type: "simple-json", nullable: true })
  extra!: unknown;

  @Column({ type: "jsonb", default: { theme: "light" } })
  preferences!: Record<string, unknown>;

  @Column({ type: "jsonb", default: [] })
  history!: unknown[];

  /** A text column with a transformer of the application's own: stored in upper case, read in lower case. */
  @Column({
    type: "varchar",
    nullable: true,
    transformer: { to: (value?: string | null) => value?.toUpperCase() ?? value, from: (value?: string | null) => value?.toLowerCase() ?? value },
  })
  code!: string | null;
}

/**
 * The column declarations of a real application's entity. `os`, `engine`,
 * `device`, `browser`, and `location` are text columns, and the application
 * saves objects to them.
 */
@Entity()
export class AuthToken {
  @PrimaryGeneratedColumn()
  id!: number;

  @CreateDateColumn()
  createdAt!: number;

  @UpdateDateColumn()
  updatedAt!: number;

  @Column({ type: "int", nullable: true })
  userId!: number;

  @Column({ type: "text", nullable: true })
  accessToken!: string;

  @Column({ type: "text", nullable: true })
  idTokenProvider!: string;

  @Column({ type: "text", nullable: true })
  idToken!: string;

  @Column({ type: "int8", nullable: true })
  expireDate!: number;

  @Column({ type: "varchar", length: 250, nullable: true })
  ip!: string;

  @Column({ type: "varchar", length: 250, nullable: true })
  os!: string;

  @Column({ type: "varchar", length: 250, nullable: true })
  engine!: string;

  @Column({ type: "varchar", length: 250, nullable: true })
  device!: string;

  @Column({ type: "varchar", length: 250, nullable: true })
  browser!: string;

  @Column({ type: "varchar", length: 250, nullable: true })
  location!: string;

  @Column({ type: "text", nullable: true })
  userAgent!: string;
}

export enum Level {
  Low = 1,
  High = 2,
}

export enum Color {
  Red = "red",
  Blue = "blue",
}

/** One column per declared type whose values TypeORM converts between JavaScript and the database. */
@Entity("measurements")
export class Measurement {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "simple-array", nullable: true })
  labels!: string[] | null;

  @Column({ type: "int", array: true, nullable: true })
  counts!: number[] | null;

  @Column({ type: "text", array: true, default: [] })
  notes!: string[];

  /** The default is PostgreSQL's text for an empty array. */
  @Column({ type: "text", array: true, default: "{}" })
  aliases!: string[];

  @Column({ type: "enum", enum: Color, array: true, nullable: true })
  colors!: Color[] | null;

  @Column({ type: "enum", enum: Level, default: Level.Low })
  level!: Level;

  @Column({ type: "bigint", nullable: true })
  total!: string | null;

  @Column({ type: "decimal", precision: 10, scale: 2, nullable: true })
  price!: string | null;

  @Column({ type: "date", nullable: true })
  day!: string | null;

  @Column({ type: "time", nullable: true })
  at!: string | null;

  @Column({ type: "timestamp", nullable: true })
  seenAt!: Date | null;

  @Column({ type: "boolean", default: false })
  flag!: boolean;
}
