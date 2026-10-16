import { diagnostics } from "../../../core/diagnostics";
import type {
  Jurisdiction, Rule, RulePack,
} from "./types";

const packs = new Map<string, RulePack>();

export function registerPack(pack: RulePack): void {
  if (packs.has(pack.id)) {
    diagnostics.warn("standards.rules", `pack "${pack.id}" already registered — replacing`);
  }
  packs.set(pack.id, pack);
}

export function listPacks(): RulePack[] {
  return [...packs.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function listPacksByJurisdiction(j: Jurisdiction): RulePack[] {
  return listPacks().filter((p) => p.jurisdiction === j);
}

export function getPack(id: string): RulePack | null {
  return packs.get(id) ?? null;
}

export function listRules(): Rule[] {
  const out: Rule[] = [];
  for (const p of packs.values()) out.push(...p.rules);
  return out;
}

export function getRule(id: string): Rule | null {
  for (const p of packs.values()) {
    const r = p.rules.find((x: Rule) => x.id === id);
    if (r) return r;
  }
  return null;
}

export function unregisterPack(id: string): boolean {
  return packs.delete(id);
}

export function clearPacks(): void {
  packs.clear();
}