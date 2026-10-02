import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  Body,
  Controller,
  Get,
  Injectable,
  Module,
  Post,
  StandardSchemaValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { z } from 'zod';

@Injectable()
class GreetingService {
  greet(): string {
    return 'ok';
  }
}

const echoSchema = z
  .object({ amount: z.string().regex(/^\d+\.\d{2}$/) })
  .strict();
type EchoBody = z.infer<typeof echoSchema>;

@Controller('spike')
class SpikeController {
  constructor(private readonly greeting: GreetingService) {}

  @Get('ping')
  ping(): { status: string } {
    return { status: this.greeting.greet() };
  }

  @Post('echo')
  echo(@Body({ schema: echoSchema }) body: EchoBody): EchoBody {
    return body;
  }
}

@Module({ controllers: [SpikeController], providers: [GreetingService] })
class SpikeModule {}

describe('NestJS 12 on Bun', () => {
  let app: INestApplication;
  let baseUrl: string;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [SpikeModule],
    }).compile();
    app = moduleRef.createNestApplication({ logger: false });
    app.useGlobalPipes(new StandardSchemaValidationPipe());
    await app.listen(0, '127.0.0.1');
    baseUrl = await app.getUrl();
  });

  afterAll(async () => {
    await app.close();
  });

  test('resolves constructor dependencies through emitted decorator metadata', async () => {
    const response = await fetch(`${baseUrl}/spike/ping`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  test('validates a request body with a Zod schema through Standard Schema', async () => {
    const post = (body: unknown) =>
      fetch(`${baseUrl}/spike/echo`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });

    const valid = await post({ amount: '25.00' });
    const invalid = await post({ amount: 25 });

    expect(valid.status).toBe(201);
    expect(await valid.json()).toEqual({ amount: '25.00' });
    expect(invalid.status).toBe(400);
  });
});
