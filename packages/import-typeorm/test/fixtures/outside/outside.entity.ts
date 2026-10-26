import { Entity, PrimaryGeneratedColumn } from "typeorm";

@Entity()
export class Outside {
  @PrimaryGeneratedColumn()
  id!: number;
}
