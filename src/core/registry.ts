// The only sanctioned way to reach cross-module services.
// Member sets fill in as each service migrates behind the registry;
// keep the interface additive.
export interface TransactionService {}
export interface SelectionService {}
export interface IfcService {}

export interface BimServices {
  transactions: TransactionService;
  selection: SelectionService;
  ifc: IfcService;
}

let services: BimServices | null = null;

export function registerServices(s: BimServices): void {
  if (services) throw new Error('registry already initialized: duplicate boot');
  services = s;
}

export function svc(): BimServices {
  if (!services) throw new Error('registry used before boot: wiring bug');
  return services;
}
