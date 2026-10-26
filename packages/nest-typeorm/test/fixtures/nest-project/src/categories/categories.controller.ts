import { Body, Controller, Delete, Get, Param, Patch, Post } from "@nestjs/common";
import { CategoriesService } from "./categories.service";
import { Category } from "./category.entity";

@Controller("categories")
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  @Post()
  create(@Body() body: { code: string; label: string }): Promise<Category> {
    return this.categories.create(body);
  }

  @Get()
  findAll(): Promise<Category[]> {
    return this.categories.findAll();
  }

  @Get(":code")
  findOne(@Param("code") code: string): Promise<Category> {
    return this.categories.findOne(code);
  }

  @Patch(":code")
  rename(@Param("code") code: string, @Body() body: { label: string }): Promise<Category> {
    return this.categories.rename(code, body.label);
  }

  @Delete(":code")
  remove(@Param("code") code: string): Promise<void> {
    return this.categories.remove(code);
  }
}
