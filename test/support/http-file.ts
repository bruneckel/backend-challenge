export interface HttpRequest {
  readonly title: string;
  readonly name?: string;
  readonly expectedStatus?: number;
  readonly method: string;
  readonly url: string;
  readonly headers: readonly (readonly [string, string])[];
  readonly body?: string;
}

export interface HttpFile {
  readonly variables: Readonly<Record<string, string>>;
  readonly requests: readonly HttpRequest[];
}

export interface HttpExchange {
  readonly title: string;
  readonly expectedStatus?: number;
  readonly status: number;
  readonly body: unknown;
}

const VARIABLE = /^@([A-Za-z_][\w-]*)\s*=\s*(.*)$/;
const NAME = /^#\s*@name\s+(\S+)$/;
const EXPECT = /^#\s*expect:\s*(\d{3})$/;
const REQUEST_LINE = /^([A-Z]+)\s+(\S+)$/;
const HEADER = /^([A-Za-z0-9-]+):\s*(.*)$/;
const PLACEHOLDER = /\{\{\s*([^}]+?)\s*\}\}/g;
const RESPONSE_FIELD = /^([\w-]+)\.response\.body\.\$\.(.+)$/;

function parseBlock(title: string, lines: readonly string[]): HttpRequest {
  let name: string | undefined;
  let expectedStatus: number | undefined;
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!.trim();
    const named = NAME.exec(line);
    const expected = EXPECT.exec(line);
    if (named !== null) {
      name = named[1];
    } else if (expected !== null) {
      expectedStatus = Number(expected[1]);
    } else if (line !== '' && !line.startsWith('#')) {
      break;
    }
    index += 1;
  }
  const requestLine = REQUEST_LINE.exec(lines[index]?.trim() ?? '');
  if (requestLine === null) {
    throw new Error(`"${title}" has no request line`);
  }
  const headers: [string, string][] = [];
  index += 1;
  while (index < lines.length && lines[index]!.trim() !== '') {
    const header = HEADER.exec(lines[index]!.trim());
    if (header === null) {
      throw new Error(`"${title}" has an invalid header: ${lines[index]}`);
    }
    headers.push([header[1]!, header[2]!]);
    index += 1;
  }
  const body = lines
    .slice(index + 1)
    .join('\n')
    .trim();
  return {
    title,
    method: requestLine[1]!,
    url: requestLine[2]!,
    headers,
    ...(name === undefined ? {} : { name }),
    ...(expectedStatus === undefined ? {} : { expectedStatus }),
    ...(body === '' ? {} : { body }),
  };
}

export function parseHttpFile(text: string): HttpFile {
  const variables: Record<string, string> = {};
  const requests: HttpRequest[] = [];
  let title: string | undefined;
  let block: string[] = [];
  const flush = () => {
    if (title !== undefined) {
      requests.push(parseBlock(title, block));
    }
  };
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (line.startsWith('###')) {
      flush();
      title = line.slice(3).trim();
      block = [];
    } else if (title === undefined) {
      const variable = VARIABLE.exec(line.trim());
      if (variable !== null) {
        variables[variable[1]!] = variable[2]!.trim();
      }
    } else {
      block.push(line);
    }
  }
  flush();
  return { variables, requests };
}

function fieldOf(body: unknown, path: string): unknown {
  let value = body;
  for (const key of path.split('.')) {
    value =
      typeof value === 'object' && value !== null
        ? (value as Record<string, unknown>)[key]
        : undefined;
  }
  return value;
}

function substitute(
  text: string,
  variables: Readonly<Record<string, string>>,
  responses: ReadonlyMap<string, unknown>,
): string {
  return text.replace(PLACEHOLDER, (_, expression: string) => {
    if (expression === '$guid') {
      return crypto.randomUUID();
    }
    const reference = RESPONSE_FIELD.exec(expression);
    if (reference !== null) {
      const value = fieldOf(responses.get(reference[1]!), reference[2]!);
      if (value === undefined) {
        throw new Error(`{{${expression}}} is not available`);
      }
      return String(value);
    }
    const variable = variables[expression];
    if (variable === undefined) {
      throw new Error(`Unknown variable {{${expression}}}`);
    }
    return substitute(variable, variables, responses);
  });
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function runHttpFile(
  file: HttpFile,
  overrides: Readonly<Record<string, string>> = {},
): Promise<HttpExchange[]> {
  const variables = { ...file.variables, ...overrides };
  const responses = new Map<string, unknown>();
  const exchanges: HttpExchange[] = [];
  for (const request of file.requests) {
    const fill = (text: string) => substitute(text, variables, responses);
    const response = await fetch(fill(request.url), {
      method: request.method,
      headers: request.headers.map(
        ([name, value]) => [name, fill(value)] as [string, string],
      ),
      ...(request.body === undefined ? {} : { body: fill(request.body) }),
    });
    const body = parseBody(await response.text());
    if (request.name !== undefined) {
      responses.set(request.name, body);
    }
    exchanges.push({
      title: request.title,
      status: response.status,
      body,
      ...(request.expectedStatus === undefined
        ? {}
        : { expectedStatus: request.expectedStatus }),
    });
  }
  return exchanges;
}
