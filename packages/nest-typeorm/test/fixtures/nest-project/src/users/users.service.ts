import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { DataSource, Repository } from "typeorm";
import { User } from "./user.entity";

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(User) private readonly users: Repository<User>,
    private readonly dataSource: DataSource,
  ) {}

  /** Creates all of the users, or none of them. */
  createMany(names: string[]): Promise<User[]> {
    return this.dataSource.transaction(async (manager) => {
      const created: User[] = [];
      for (const name of names) {
        if (name === "") {
          throw new BadRequestException("A user needs a name");
        }
        created.push(await manager.save(User, manager.create(User, { name })));
      }
      return created;
    });
  }

  search(text: string): Promise<User[]> {
    return this.users
      .createQueryBuilder("user")
      .where("user.name LIKE :pattern", { pattern: `%${text}%` })
      .andWhere("user.active = :active", { active: true })
      .orderBy("user.name", "DESC")
      .getMany();
  }

  create(input: { name: string; active?: boolean }): Promise<User> {
    return this.users.save(this.users.create(input));
  }

  findAll(): Promise<User[]> {
    return this.users.find({ order: { id: "ASC" } });
  }

  async findOne(id: number): Promise<User> {
    const user = await this.users.findOneBy({ id });
    if (user === null) {
      throw new NotFoundException(`User ${id} not found`);
    }
    return user;
  }

  async update(id: number, changes: { name?: string; active?: boolean }): Promise<User> {
    await this.users.update(id, changes);
    return this.findOne(id);
  }

  async remove(id: number): Promise<void> {
    const result = await this.users.delete(id);
    if (!result.affected) {
      throw new NotFoundException(`User ${id} not found`);
    }
  }
}
