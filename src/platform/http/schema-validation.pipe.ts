import { type ArgumentMetadata, Injectable, type PipeTransform } from '@nestjs/common';
import { RequestValidationError } from './request-errors';

@Injectable()
export class SchemaValidationPipe implements PipeTransform {
  async transform(value: unknown, metadata: ArgumentMetadata): Promise<unknown> {
    const schema = metadata.schema;
    if (schema === undefined) {
      return value;
    }
    const result = await schema['~standard'].validate(value);
    if (result.issues !== undefined) {
      throw new RequestValidationError(metadata.type, result.issues);
    }
    return result.value;
  }
}
