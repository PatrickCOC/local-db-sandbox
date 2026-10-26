import { Column, Entity, PrimaryGeneratedColumn } from "typeorm";

@Entity()
export class Place {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "geometry" })
  location!: unknown;
}
