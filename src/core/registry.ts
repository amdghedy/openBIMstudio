// The only sanctioned way to reach cross-module services.
export interface BimServices {
  transactions: TransactionService;
  selection: SelectionService;
  ifc: IfcService;
  // migrate one service at a time; keep the interface additive
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
