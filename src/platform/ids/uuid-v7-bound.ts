export function uuidV7LowerBound(at: Date): string {
  const hex = Math.max(0, Math.floor(at.getTime()))
    .toString(16)
    .padStart(12, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7000-8000-000000000000`;
}
