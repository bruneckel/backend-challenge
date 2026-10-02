export type LogValue = string | number | boolean | null | undefined;

export type LogFields = Readonly<Record<string, LogValue>>;

export interface Logger {
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
}

export const silentLogger: Logger = {
  info() {},
  warn() {},
  error() {},
};
