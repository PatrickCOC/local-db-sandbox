import { Injectable, PipeTransform } from "@nestjs/common";

/** Trims string values of request bodies. */
@Injectable()
export class TrimPipe implements PipeTransform {
  transform(value: unknown): unknown {
    if (typeof value !== "object" || value === null) {
      return value;
    }
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typeof item === "string" ? item.trim() : item]));
  }
}
