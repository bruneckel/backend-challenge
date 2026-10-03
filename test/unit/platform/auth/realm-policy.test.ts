import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';

interface Realm {
  clients: { clientId: string; fullScopeAllowed?: boolean }[];
  scopeMappings?: { client: string; roles: string[] }[];
}

const realm = (): Promise<Realm> =>
  Bun.file(
    resolve(import.meta.dir, '../../../../keycloak/wagering-realm.json'),
  ).json();

describe('wagering realm', () => {
  test('gives each client only the roles mapped to it', async () => {
    const { clients, scopeMappings = [] } = await realm();

    expect(
      clients
        .filter((client) => client.fullScopeAllowed !== false)
        .map((client) => client.clientId),
    ).toEqual([]);
    expect(
      Object.fromEntries(
        scopeMappings.map((mapping) => [mapping.client, mapping.roles]),
      ),
    ).toEqual({
      'wagering-operator': ['operator'],
      'wagering-metrics': ['metrics-reader'],
    });
  });
});
