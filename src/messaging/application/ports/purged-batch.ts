export interface PurgedBatch<TPosition> {
  count: number;
  last: TPosition | undefined;
}
