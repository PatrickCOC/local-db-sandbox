import { Column, Entity, PrimaryGeneratedColumn } from "typeorm";
import { UserRole } from "src/user-role.constants";

@Entity("users")
export class User {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: "enum", enum: UserRole })
  role!: UserRole;
}
