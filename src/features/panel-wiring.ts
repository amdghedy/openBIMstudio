/**
 * Panel wiring — one place that connects Federation, Standards and CDE
 * panels to the command palette and the typed service registry.
 *
 * Panels boot at different phases; every command resolves the target
 * feature lazily at call time, so this can be installed early.
 */
import { ctx } from "../core/context";
import { registerCommand, unregisterCommand, listCommands } from "./command-palette";
import { register, type PanelService } from "../core/services";
import { notify } from "../core/notify";

interface PanelModule {
  open?: () => void;
  close?: () => void;
  toggle?: () => void;
  isVisible?: () => boolean;
}

interface PanelSpec {
  key: string;
  serviceKey: "federationPanel" | "standardsPanel" | "cdePanel";
  label: string;
  kbd?: string;
  aliases: string[];
}

const PANELS: PanelSpec[] = [
  {
    key: "federationPanel",
    serviceKey: "federationPanel",
    label: "Federation",
    kbd: "Ctrl+Shift+F",
    aliases: ["federation", "federate", "models", "combine", "align"],
  },
  {
    key: "standardsPanel",
    serviceKey: "standardsPanel",
    label: "Standards",
    kbd: "Ctrl+Shift+D",
    aliases: ["standards", "code", "compliance", "rule", "check", "ids"],
  },
  {
    key: "cdePanel",
    serviceKey: "cdePanel",
    label: "Common Data Environment",
    kbd: "Ctrl+Shift+E",
    aliases: ["cde", "acc", "bim360", "cloud", "sharepoint", "onedrive", "drive"],
  },
];

function toService(mod: PanelModule): PanelService & { open(): void; close(): void } {
  return {
    toggle: () => { mod.toggle?.(); },
    isVisible: () => !!mod.isVisible?.(),
    open: () => { mod.open?.(); },
    close: () => { mod.close?.(); },
  };
}

function lookup(spec: PanelSpec): PanelModule | undefined {
  return (ctx.features as Record<string, unknown>)[spec.key] as PanelModule | undefined;
}

function installCommand(spec: PanelSpec): void {
  registerCommand({
    id: `panel.${spec.key}.toggle`,
    label: `Toggle ${spec.label}`,
    category: "Panels",
    kbd: spec.kbd,
    hint: spec.aliases.join(", "),
    run: () => {
      const mod = lookup(spec);
      if (!mod?.toggle) {
        notify("warn", `${spec.label} panel is not loaded yet`);
        return;
      }
      mod.toggle();
    },
  });

  registerCommand({
    id: `panel.${spec.key}.open`,
    label: `Open ${spec.label}`,
    category: "Panels",
    run: () => {
      const mod = lookup(spec);
      if (!mod?.open) { notify("warn", `${spec.label} panel is not loaded`); return; }
      mod.open();
    },
  });

  registerCommand({
    id: `panel.${spec.key}.close`,
    label: `Close ${spec.label}`,
    category: "Panels",
    run: () => lookup(spec)?.close?.(),
  });
}

function installServiceFacade(spec: PanelSpec): void {
  const mod = lookup(spec);
  if (!mod) return;
  try {
    register(spec.serviceKey, toService(mod) as PanelService);
  } catch (err) {
    console.warn("[panel-wiring] could not register service", spec.serviceKey, err);
  }
}

export function setupPanelWiring(): void {
  // Idempotent — re-registering a command overwrites.
  for (const spec of PANELS) installCommand(spec);

  // If a panel loads after us, its feature lands on ctx.features. Poll
  // briefly (500 ms × 20 = 10 s) then stop — this avoids a permanent timer.
  let ticks = 0;
  const timer = window.setInterval(() => {
    ticks++;
    let allReady = true;
    for (const spec of PANELS) {
      const mod = lookup(spec);
      if (!mod) { allReady = false; continue; }
      installServiceFacade(spec);
    }
    if (allReady || ticks >= 20) window.clearInterval(timer);
  }, 500);

  // Allow panels to announce themselves by dispatching an event.
  window.addEventListener("obs-panel-registered", (e) => {
    const detail = (e as CustomEvent).detail as { key?: string } | undefined;
    if (!detail?.key) return;
    const spec = PANELS.find((p) => p.key === detail.key);
    if (spec) installServiceFacade(spec);
  });

  console.log("[panel-wiring] federation / standards / CDE commands installed");

  // Also expose a tiny fan-out for the ribbon: "Panels" group button.
  (ctx.features as any).panelWiring = {
    toggleFederation: () => lookup(PANELS[0])?.toggle?.(),
    toggleStandards: () => lookup(PANELS[1])?.toggle?.(),
    toggleCde: () => lookup(PANELS[2])?.toggle?.(),
    list: () => listCommands().filter((c) => c.id.startsWith("panel.")),
  };
}