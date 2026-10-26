import { Column, Entity, PrimaryColumn } from "typeorm";

@Entity()
export class Category {
  @PrimaryColumn()
  code: string;

  @Column()
  label: string;
}
