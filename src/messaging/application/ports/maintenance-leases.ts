export interface MaintenanceLeases {
  acquire(name: string, holder: string, durationMs: number): Promise<boolean>;
  release(name: string, holder: string): Promise<void>;
}
