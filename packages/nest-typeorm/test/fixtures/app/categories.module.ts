import { Injectable, Module } from "@nestjs/common";
import { InjectRepository, TypeOrmModule } from "@nestjs/typeorm";
import { Repository } from "typeorm";
import { Category } from "./category.entity.ts";

@Injectable()
export class CategoriesService {
  constructor(@InjectRepository(Category) private readonly categories: Repository<Category>) {}

  create(code: string, label: string): Promise<Category> {
    return this.categories.save({ code, label });
  }

  findByCode(code: string): Promise<Category | null> {
    return this.categories.findOne({ where: { code } });
  }

  async rename(code: string, label: string): Promise<Category | null> {
    await this.categories.update({ code }, { label });
    return this.findByCode(code);
  }

  async remove(code: string): Promise<number> {
    return (await this.categories.delete(code)).affected ?? 0;
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([Category])],
  providers: [CategoriesService],
  exports: [CategoriesService],
})
export class CategoriesModule {}
