import { Column, Entity, PrimaryGeneratedColumn } from "typeorm";
import { AUDIT_KINDS } from "@missing/audit-kinds";

@Entity()
export class Audit {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "enum", enum: AUDIT_KINDS })
  kind!: string;
}
