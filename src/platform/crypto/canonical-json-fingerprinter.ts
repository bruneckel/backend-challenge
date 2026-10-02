import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { PayloadFingerprinter } from '@shared/application/payload-fingerprinter';

export class CanonicalJsonFingerprinter implements PayloadFingerprinter {
  fingerprint(payload: unknown): string {
    const canonical = canonicalize(payload);
    if (canonical === undefined) {
      throw new TypeError('The payload has no JSON representation');
    }
    return createHash('sha256').update(canonical, 'utf8').digest('hex');
  }
}
