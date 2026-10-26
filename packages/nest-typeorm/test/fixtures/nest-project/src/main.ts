import { NestFactory } from "@nestjs/core";
import { TrimPipe } from "src/common/trim.pipe";
import { AppModule } from "./app.module";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ["error", "warn"] });
  app.setGlobalPrefix("api");
  app.enableCors();
  app.useGlobalPipes(new TrimPipe());
  await app.listen(process.env.PORT ?? 3000);
  console.log(`Application is running on: ${await app.getUrl()}`);
}
bootstrap();
