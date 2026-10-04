import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { type ApiHarness, startApi } from '@test/support/api';
import {
  type HttpExchange,
  type HttpFile,
  parseHttpFile,
  runHttpFile,
} from '@test/support/http-file';
import { inconsistentWallets } from '@test/support/invariants';

const ISSUER = 'http://localhost:8080/realms/wagering';

let api: ApiHarness;
let file: HttpFile;

beforeAll(async () => {
  file = parseHttpFile(
    await Bun.file(resolve(import.meta.dir, '../../requests.http')).text(),
  );
  api = await startApi({
    AUTH_ISSUER: ISSUER,
    AUTH_AUDIENCE: 'wagering-api',
    AUTH_JWKS_URL: `${ISSUER}/protocol/openid-connect/certs`,
  });
});

afterAll(async () => {
  await api?.close();
});

const outcome = (exchange: HttpExchange) =>
  `${exchange.title}: ${exchange.status}`;

const bodyOf = (exchanges: readonly HttpExchange[], title: string) =>
  exchanges.find((exchange) => exchange.title === title)?.body;

describe('requests.http', () => {
  test('declares the status every request should answer', () => {
    expect(
      file.requests
        .filter((request) => request.expectedStatus === undefined)
        .map((request) => request.title),
    ).toEqual([]);
  });

  test('answers every request with the declared status, twice in a row', async () => {
    const expected = file.requests.map(
      (request) => `${request.title}: ${request.expectedStatus}`,
    );

    for (const round of [1, 2]) {
      const exchanges = await runHttpFile(file, { api: api.baseUrl });
      expect(exchanges.map(outcome), `round ${round}`).toEqual(expected);
    }

    expect(await inconsistentWallets(api.database.sql)).toEqual([]);
  });

  test('replays the repeated bet and refuses the conflicting one', async () => {
    const exchanges = await runHttpFile(file, { api: api.baseUrl });

    expect(bodyOf(exchanges, 'Repetir a mesma aposta')).toMatchObject({
      status: 'PROCESSED',
      idempotentReplay: true,
    });
    expect(
      bodyOf(exchanges, 'Mesma Idempotency-Key com outro valor'),
    ).toMatchObject({ code: 'IDEMPOTENCY_KEY_CONFLICT' });
    expect(bodyOf(exchanges, 'Apostar mais do que o saldo')).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
    });
    expect(bodyOf(exchanges, 'Reconciliar saldo com o ledger')).toMatchObject({
      consistent: true,
    });
  });
});
