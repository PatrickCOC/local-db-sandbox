import { CreateDateColumn, PrimaryGeneratedColumn } from "typeorm";

export abstract class BaseRecord {
  @PrimaryGeneratedColumn()
  id!: number;

  @CreateDateColumn()
  createdAt!: Date;
}
