import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { parseHttpFile, runHttpFile } from '@test/support/http-file';

let server: ReturnType<typeof Bun.serve>;
let base: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(request) {
      return Response.json({
        method: request.method,
        path: new URL(request.url).pathname,
        authorization: request.headers.get('authorization'),
        body: await request.text(),
        nested: { id: 'abc' },
      });
    },
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
  void server.stop(true);
});

const SAMPLE = `@api = http://example.invalid

### First request
# @name first
# expect: 201
POST {{api}}/things
Content-Type: application/json
Authorization: Bearer one

{"a": 1}

### Second request
GET {{api}}/things/{{first.response.body.$.nested.id}}
`;

describe('parseHttpFile', () => {
  test('reads variables, titles, names, expected statuses, headers and bodies', () => {
    expect(parseHttpFile(SAMPLE)).toEqual({
      variables: { api: 'http://example.invalid' },
      requests: [
        {
          title: 'First request',
          name: 'first',
          expectedStatus: 201,
          method: 'POST',
          url: '{{api}}/things',
          headers: [
            ['Content-Type', 'application/json'],
            ['Authorization', 'Bearer one'],
          ],
          body: '{"a": 1}',
        },
        {
          title: 'Second request',
          method: 'GET',
          url: '{{api}}/things/{{first.response.body.$.nested.id}}',
          headers: [],
        },
      ],
    });
  });

  test('refuses a block without a request line', () => {
    expect(() => parseHttpFile('### Empty\n# expect: 200\n')).toThrow(
      '"Empty" has no request line',
    );
  });
});

describe('runHttpFile', () => {
  test('lets an override replace a file variable', async () => {
    const [first] = await runHttpFile(parseHttpFile(SAMPLE), { api: base });

    expect(first?.body).toEqual({
      method: 'POST',
      path: '/things',
      authorization: 'Bearer one',
      body: '{"a": 1}',
      nested: { id: 'abc' },
    });
  });

  test('feeds a field of a named response into a later request', async () => {
    const exchanges = await runHttpFile(parseHttpFile(SAMPLE), { api: base });

    expect(
      exchanges.map((exchange) => (exchange.body as { path: string }).path),
    ).toEqual(['/things', '/things/abc']);
  });

  test('records the status and the expected status of each request', async () => {
    const exchanges = await runHttpFile(parseHttpFile(SAMPLE), { api: base });

    expect(
      exchanges.map(({ title, status, expectedStatus }) => ({
        title,
        status,
        expectedStatus,
      })),
    ).toEqual([
      { title: 'First request', status: 200, expectedStatus: 201 },
      { title: 'Second request', status: 200, expectedStatus: undefined },
    ]);
  });

  test('generates a new guid for each placeholder', async () => {
    const file = parseHttpFile(
      `### Guids\nPOST ${base}/guids\n\n{{$guid}} {{$guid}}\n`,
    );

    const [exchange] = await runHttpFile(file);
    const [first, second] = (exchange?.body as { body: string }).body.split(
      ' ',
    );

    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(first).not.toBe(second);
  });

  test('fails naming a variable that does not exist', async () => {
    const file = parseHttpFile(
      '@api = http://example.invalid\n\n### Typo\nGET {{apii}}/things\n',
    );

    await expect(runHttpFile(file, { api: base })).rejects.toThrow(
      'Unknown variable {{apii}}',
    );
  });

  test('refuses an override for a variable the file does not declare', async () => {
    const file = parseHttpFile(
      '@apii = http://example.invalid\n\n### Misspelled\nGET {{api}}/things\n',
    );

    await expect(runHttpFile(file, { api: base })).rejects.toThrow(
      'Override for undeclared variable {{api}}',
    );
  });

  test('fails when a referenced response field is missing', async () => {
    const file = parseHttpFile(
      `### Missing\nGET ${base}/things/{{first.response.body.$.id}}\n`,
    );

    await expect(runHttpFile(file)).rejects.toThrow(
      '{{first.response.body.$.id}} is not available',
    );
  });
});
