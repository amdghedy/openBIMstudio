import type {
  CdeProvider, CdeProviderId, CdeProviderMeta,
} from "./types";

const PROVIDERS = new Map<CdeProviderId, CdeProvider>();
const METAS = new Map<CdeProviderId, CdeProviderMeta>();

export function registerCdeProvider(p: CdeProvider, m?: CdeProviderMeta): void {
  const meta = m ?? p.meta;
  if (!meta) throw new Error("Provider must have meta");
  PROVIDERS.set(meta.id, p);
  METAS.set(meta.id, meta);
}

export function getCdeProvider(id: CdeProviderId): CdeProvider | null {
  return PROVIDERS.get(id) ?? null;
}

export function getCdeProviderMeta(id: CdeProviderId): CdeProviderMeta | null {
  return METAS.get(id) ?? null;
}

export function listCdeProviders(): CdeProviderMeta[] {
  return [...METAS.values()];
}