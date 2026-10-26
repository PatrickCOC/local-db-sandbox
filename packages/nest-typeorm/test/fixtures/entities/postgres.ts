import { Column, Entity, PrimaryGeneratedColumn } from "typeorm";

export enum EventKind {
  Info = "info",
  Alert = "alert",
}

/** Declared with PostgreSQL column types, as a production entity would be. */
@Entity("events")
export class Event {
  @PrimaryGeneratedColumn("uuid")
  id!: string;

  @Column({ type: "enum", enum: EventKind, default: EventKind.Info })
  kind!: EventKind;

  @Column({ name: "display_name", type: "character varying", length: 50 })
  displayName!: string;

  @Column({ type: "jsonb", nullable: true })
  payload!: Record<string, unknown> | null;

  @Column({ type: "text", array: true, nullable: true })
  tags!: string[] | null;

  @Column({ type: "timestamptz" })
  occurredAt!: Date;

  @Column({ type: "decimal", precision: 10, scale: 2, nullable: true })
  amount!: number | null;

  @Column({ type: "float8", nullable: true })
  ratio!: number | null;

  @Column({ type: "bool", default: false })
  acknowledged!: boolean;
}
