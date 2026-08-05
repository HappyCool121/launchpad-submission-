let bootCompleted = false;
let draining = false;
const activeReservations = new Set<string>();

export function markBootCompleted(): void { bootCompleted = true; }
export function beginDraining(): void { draining = true; }
export function isReady(): boolean { return bootCompleted && !draining; }
export function isDraining(): boolean { return draining; }
export function trackReservation(id: string): void { activeReservations.add(id); }
export function releaseReservation(id: string): void { activeReservations.delete(id); }
export function unresolvedReservations(): string[] { return [...activeReservations]; }
export function activeRequestCount(): number { return activeReservations.size; }
