import { PrimaryGeneratedColumn } from "typeorm";

export abstract class BaseRecord {
  @PrimaryGeneratedColumn()
  id!: number;
}
