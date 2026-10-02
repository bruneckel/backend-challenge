export interface PayloadFingerprinter {
  fingerprint(payload: unknown): string;
}
