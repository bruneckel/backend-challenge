export abstract class ApplicationError extends Error {
  abstract readonly code: string;

  get details(): Readonly<Record<string, string>> | undefined {
    return undefined;
  }

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}
