/**
 * FragEdit record type (types-only module).
 *
 * This type lives here — not in `features/frag-edit.ts` — so the
 * typed service registry (`core/services.ts`) can reference it
 * without importing the frag-edit implementation module. That import
 * was one of two type-only edges that put `services.ts` inside the
 * 19-module static import cycle (hardening item 18): `import type`
 * is erased at compile time, so the edge never existed at runtime,
 * but the static graph counts it. Moving the type here detaches
 * `services.ts` from the cycle in the static graph too.
 *
 * This module must stay types-only: no value imports, no runtime
 * code. `features/frag-edit.ts` re-exports this name so existing
 * importers keep working unchanged.
 */
export interface FragEdit {
  id: string;
  modelId: string;
  localId: number;
  name: string;
  category: string;
  position: [number, number, number];
  quaternion: [number, number, number, number];
  scale: [number, number, number];
  createdAt: number;
  updatedAt: number;
  sourceType?: "IFC" | "FRAG" | "openBIM";
  sourceFormat?: string;
  nativeId?: string;
  nativeElementId?: string;
  nativeEntity?: string;
  sourceGlobalId?: string;
  sourceEntity?: string;
  sourceModelName?: string;
  sourceTag?: string;
  predefinedType?: string;
  description?: string;
  dimensions?: {
    width: number; height: number; depth: number;
    min: [number, number, number];
    max: [number, number, number];
    center: [number, number, number];
  };
  objectPlacement?: number[];
  sourceData?: Record<string, unknown>;
  /** Unflattened getItemsData record for lossless archive. */
  sourceRaw?: unknown;
  propertySets?: Record<string, unknown>;
  quantities?: Record<string, unknown>;
  overrides?: Record<string, unknown>;
  geometry?: { positions: number[] };
}
