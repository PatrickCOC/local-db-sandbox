import { Injectable, NotFoundException } from "@nestjs/common";
import { InjectRepository } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Category } from "./category.entity";

@Injectable()
export class CategoriesService {
  constructor(@InjectRepository(Category) private readonly categories: Repository<Category>) {}

  create(input: { code: string; label: string }): Promise<Category> {
    return this.categories.save(input);
  }

  findAll(): Promise<Category[]> {
    return this.categories.find({ order: { code: "ASC" } });
  }

  async findOne(code: string): Promise<Category> {
    const category = await this.categories.findOne({ where: { code } });
    if (category === null) {
      throw new NotFoundException(`Category ${code} not found`);
    }
    return category;
  }

  async rename(code: string, label: string): Promise<Category> {
    await this.categories.update({ code }, { label });
    return this.findOne(code);
  }

  async remove(code: string): Promise<void> {
    await this.categories.remove(await this.findOne(code));
  }
}
