/**
 * Typed service registry.
 *
 * Every feature that other features need to call registers a service here
 * with an explicit interface. Consumers call `services.selection.snapshot()`
 * and get full IntelliSense plus compile-time protection against typos.
 *
 * Late registration is supported via `services.ready("selection")` — a
 * promise that resolves when the service is registered. This is important
 * because features are set up in different phases during boot.
 *
 * Migration strategy: the old `ctx.features.X` bag remains populated for
 * backward compatibility during the transition. Both point at the same
 * object, so existing code that has not been migrated keeps working.
 */
import * as THREE from "three";
import type * as OBC from "@thatopen/components";
import type {
  AuthoredElement,
  GridDatum,
  LevelDatum,
} from "../modules/projects/types";
import type {
  ClashKind,
  ClashMethod,
  ClashRules,
  ElementClash,
} from "../features/clash-engine";
import type {
  ClashScenario,
  ClashStatus,
  ClashState,
} from "../features/clash";
import type { FragEdit } from "../features/frag-edit";
import type { FamilyService } from "../modules/families/types";
import type { NotifyKind, NotifyOptions } from "./notify";
import { ctx } from "./context";

/* ══════════════════════════════════════════════════════════════════════
   Selection
   ══════════════════════════════════════════════════════════════════════ */
export type SelectionMap = Record<string, Set<number>>;

export interface SelectionSetSummary {
  id: string;
  name: string;
  createdAt: number;
  updatedAt?: number;
  snapshot: SelectionMap | Record<string, number[]>;
}

export interface SelectionService {
  /** Immutable snapshot of the current selection. */
  snapshot(): SelectionMap;
  /** Number of elements selected across all models. */
  size(): number;
  /** Number of distinct models with at least one selected element. */
  modelCount(): number;
  isEmpty(): boolean;

  replace(map: SelectionMap): void;
  clear(): void;
  addMany(modelId: string, ids: Iterable<number>): void;
  removeMany(modelId: string, ids: Iterable<number>): void;

  selectAll(): Promise<void>;
  invert(): Promise<void>;
  selectSimilar(modelId: string, localId: number): Promise<void>;

  /** Apply a click result from the raycast layer. */
  applyClick(
    modelId: string,
    localId: number,
    mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean },
  ): void;

  /** Pull the current OBC highlighter selection into the manager. */
  adoptFromHighlighter(): void;

  /** Push the manager state into the OBC highlighter. */
  applyToHighlighter(): Promise<void>;

  /** Fit the camera to the current selection. */
  focus(): Promise<void>;
  /** World-space AABB of the current selection, or null. */
  boundingBox(): Promise<THREE.Box3 | null>;

  saveSet(name: string): SelectionSetSummary | null;
  listSets(): SelectionSetSummary[];
  loadSet(id: string): Promise<void>;

  onChange(cb: () => void): () => void;
}

/* ══════════════════════════════════════════════════════════════════════
   Authoring
   ══════════════════════════════════════════════════════════════════════ */
export type AuthoringToolName =
  | "select" | "move" | "copy" | "rotate" | "mirror" | "array" | "offset"
  | "wall" | "slab" | "column" | "beam" | "brace" | "truss" | "footing"
  | "strip" | "mline" | "duct" | "pipe" | "cable-tray" | "conduit"
  | "equipment" | "door" | "window" | "grid" | "level" | "fitting";

export interface AuthoringService {
  isActive(): boolean;
  getActiveTool(): AuthoringToolName | string | null;
  setAuthoringTool(tool: AuthoringToolName | string | null): void;

  setLevel(v: number): void;
  getLevel(): number;

  getActivePreset(): string | null;
  getLastCommand(): string | null;
  setLastCommand(cmd: string | null): void;

  getElementCount(): number;
  getElements(): AuthoredElement[];
  getSelectedIds(): string[];
  getElementById(id: string): AuthoredElement | null;

  pickAuthoredElementAt(e: MouseEvent): string | null;

  selectAllAuthored(ids: string[]): void;
  setSelectedAuthored(
    ids: string[],
    mode: "replace" | "add" | "remove",
  ): void;
  deleteSelectedElement(): void;
  clearAllElements(force?: boolean): void;
  clearDatums(): void;

  pinSelected(pinned?: boolean): number;
  createSimilarFromSelection(): string | null;
  splitSelectedAtMidpoint(): number;
  joinSelectedWalls(): number;
  alignSelectedAxis(axis: "x" | "z"): number;

  transformElements(
    ids: string[],
    transform: (el: AuthoredElement, idx: number) => void,
  ): void;

  getElementWorldBox(el: AuthoredElement): THREE.Box3 | null;
  rebuildAuthored(): void;

  getWallLocationLine(): string;
  setWallLocationLine(v: string): void;
  getWallChain(): boolean;
  setWallChain(v: boolean): void;
  getWallOffset(): number;
  setWallOffset(v: number): void;
  getWallJoinStatus(): string;
  setWallJoinStatus(v: string): void;

  getGrids(): GridDatum[];
  setGrids(list: GridDatum[] | null | undefined): void;
  getLevels(): LevelDatum[];
  setLevels(list: LevelDatum[] | null | undefined): void;

  onAuthoringChange(cb: () => void): () => void;

  /** Normalise every MEP elbow radius to >= one duct width and re-trim
   *  the two ducts feeding it. Idempotent; safe to call repeatedly.
   *  Returns the number of fittings changed. */
  migrateMepFittingRadii(onlyId?: string, forceRadius?: number): number;
  /** Set an elbow's bend radius and re-trim connected runs. False if it would collapse a run. */
  setElbowBendRadius(fittingId: string, radius: number): boolean;
}

/* ══════════════════════════════════════════════════════════════════════
   Camera / view
   ══════════════════════════════════════════════════════════════════════ */
export type Projection = "perspective" | "orthographic";
export type ExactView = "top" | "bottom" | "front" | "back" | "right" | "left";
export type ScreenshotPreset = "current" | "hd" | "4k" | "8k";

export interface CameraService {
  fitAll(): void;
  fitToMap(map: OBC.ModelIdMap): Promise<void>;
  focusOnPoint(p: THREE.Vector3): void;
  focusOnBox(box: THREE.Box3): void;
  zoomBy(factor: number, focusPoint?: THREE.Vector3): void;
  gotoDir(dir: THREE.Vector3): void;
  gotoExactView(view: ExactView): void;
  setProjection(mode: Projection): boolean;
  getProjection(): Projection;

  saveHome(): void;
  goHome(): void;

  screenshot(opts?: { width?: number; height?: number; format?: "png" | "jpeg" }): void;
  getScreenshotPreset(): ScreenshotPreset;
  setScreenshotPreset(p: ScreenshotPreset): void;

  computeSceneBounds(): void;
  recoverView(): void;
  updateClipping(): void;

  /** Shared mutable scene metadata — kept here so consumers read the same refs. */
  readonly scene: {
    center: THREE.Vector3;
    box: THREE.Box3;
    radius(): number;
  };
}

/* ══════════════════════════════════════════════════════════════════════
   Clash
   ══════════════════════════════════════════════════════════════════════ */
export interface ClashService {
  run(): Promise<void>;
  clear(): Promise<void>;
  cancel(): void;

  listClashes(): ElementClash[];
  getClashCount(): number;
  getActiveClashIndex(): number;
  focusActiveClash(): Promise<void>;
  focusNextClash(): Promise<void>;
  focusPreviousClash(): Promise<void>;
  focusClashByIndex(idx: number): Promise<void>;
  isolateClashPair(c: ElementClash): Promise<void>;

  getClashState(c: ElementClash): ClashState;
  setClashStatus(c: ElementClash, status: ClashStatus): void;
  addClashComment(c: ElementClash, text: string): void;
  cycleActiveClashStatus(): void;
  setStatusForAll(status: ClashStatus): void;

  getRules(): ClashRules;
  setRules(r: Partial<ClashRules>): void;
  getMethod(): ClashMethod;
  setMethod(m: ClashMethod): void;

  createScenario(name?: string): ClashScenario;
  listScenarios(): ClashScenario[];
  loadScenario(id: string): Promise<void>;
  deleteScenario(id: string): void;

  exportCsv(): void;

  /* Coordination helpers */
  addSelectionToA(): Promise<void>;
  addSelectionToB(): Promise<void>;
  swapSelections(): void;
  clearSelectionA(): void;
  clearSelectionB(): void;
  isolateSelectionA(): Promise<void>;
  isolateSelectionB(): Promise<void>;
  showAllElements(): Promise<void>;

  listGroups(): unknown[];
  getActiveGroupId(): string | null;
  focusGroup(groupId: string): void;
  isolateGroup(groupId: string): Promise<void>;

  serializeStates(): Array<{
    key: string;
    status: ClashStatus;
    comments: Array<{ id: string; author: string; text: string; date: number }>;
    assignee?: string;
    updatedAt: number;
  }>;
  deserializeStates(list: unknown): void;
}

/* ══════════════════════════════════════════════════════════════════════
   Frag edit (Native Twins)
   ══════════════════════════════════════════════════════════════════════ */
export interface FragEditService {
  begin(modelId: string, localId: number): Promise<FragEdit | null>;
  beginFromSelection(): Promise<number>;
  remove(id: string): Promise<void>;
  clearAll(): Promise<void>;
  list(): FragEdit[];
  count(): number;
  select(id: string | null): void;
  focus(id: string): void;
  serialize(): FragEdit[];
  deserialize(edits: FragEdit[] | null | undefined): Promise<void>;
  getSelected(): FragEdit | null;
  setOverride(id: string, key: string, value: unknown): boolean;
  setDimensions(id: string, w: number, h: number, d: number): boolean;
  clearOverrides(id: string): void;
  exportNativeTwin(id: string): boolean;
  showAllPreservingTwins?(): Promise<void>;
  togglePanel(): void;
  isPanelVisible(): boolean;
}

/* ══════════════════════════════════════════════════════════════════════
   Panels & UI
   ══════════════════════════════════════════════════════════════════════ */
export interface PanelService {
  toggle(): void;
  isVisible(): boolean;
}

export interface PlanViewService extends PanelService {
  setTool(tool: string): void;
}

export interface AppLoaderService {
  begin(msg: string, opts?: { cancellable?: boolean; onCancel?: () => void }): void;
  set(status: string, progress?: number): void;
  finish(): void;
  isActive(): boolean;
}

export interface IssuesService {
  createIssue(title: string, description?: string): { id: string; title: string };
}

export interface SchedulesService {
  getDefinition(): { id: string; name: string } | null;
  diffLatest(): {
    snapshotLabel: string;
    snapshotAt: number;
    added: unknown[];
    removed: unknown[];
    changed: unknown[];
    unchanged: number;
  } | null;
  load(id: string): void;
}

export interface ProjectsService {
  getCurrentProject(): { id: string; name: string } | null;
  onModelImported?(modelId: string, name: string, bytes: Uint8Array): void;
}

/* ══════════════════════════════════════════════════════════════════════
   Registry
   ══════════════════════════════════════════════════════════════════════ */
export interface ServiceMap {
  selection: SelectionService;
  authoring: AuthoringService;
  family: FamilyService;
  camera: CameraService;
  clash: ClashService;
  fragEdit: FragEditService;
  issues: IssuesService;
  schedules: SchedulesService;
  projects: ProjectsService;
  planView: PlanViewService;
  propertyPalette: PanelService;
  schedulesPanel: PanelService;
  sheetsPanel: PanelService;
  issuesPanel: PanelService;
  timelinePanel: PanelService;
  idsPanel: PanelService;
  savedViewsPanel: PanelService;
  modelTreePanel: PanelService;
  costPanel: PanelService;
  automationPanel: PanelService;
  bimToolbox: PanelService;
  bimObjectStudio: PanelService;
  projectBrowser: PanelService;
  aiChat: PanelService & {
    send(): Promise<void>;
    regenerate(): Promise<void>;
    clear(): void;
    newChat(): void;
    getProvider(): { kind: string; model: string };
    setProvider(patch: Record<string, unknown>): void;
  };
  appLoader: AppLoaderService;
  fileInterop: {
    importFiles(files: File[]): Promise<void>;
    pickAndImport(): void;
    ACCEPT_ALL: string;
    getAuxBox(): THREE.Box3 | null;
    getAuxObjects(): THREE.Object3D[];
    clearAux(): void;
    restoreAux(blob: Blob, name: string): Promise<void>;
  };
  walkMode: PanelService;
  mepColoring: PanelService;
  commandPalette: {
    open(): void;
    close(): void;
    toggle(): void;
    isOpen(): boolean;
  };

  i18n: {
    t: (key: string, vars?: Record<string, string | number>) => string;
    setLocale: (l: string) => void;
    getLocale: () => string;
    getDirection: () => "ltr" | "rtl";
    isRTL: () => boolean;
    listLocales: () => Array<{ id: string; meta: { name: string; nativeName: string; dir: "ltr" | "rtl" } }>;
    onChange: (cb: (l: string) => void) => () => void;
    register: (locale: string, catalog: Record<string, unknown>) => void;
    listMissing: () => string[];
  };
  units: {
    formatLength: (m: number, o?: any) => string;
    formatArea: (m2: number, o?: any) => string;
    formatVolume: (m3: number, o?: any) => string;
    formatMass: (kg: number, o?: any) => string;
    formatAngle: (rad: number, o?: any) => string;
    formatTemperature: (k: number, o?: any) => string;
    parseLengthInput: (s: string) => number | null;
    getSystem: () => string;
    setSystem: (s: string) => void;
    getConfig: () => any;
    onChange: (cb: (config: any, system: string) => void) => () => void;
  };
  standards: {
    run: () => Promise<any>;
  };
  cdePanel: PanelService;
  federationPanel: PanelService;
  standardsPanel: PanelService;
}

type ServiceKey = keyof ServiceMap;

const registry = new Map<ServiceKey, ServiceMap[ServiceKey]>();
const readyResolvers = new Map<ServiceKey, Array<(v: ServiceMap[ServiceKey]) => void>>();

/**
 * Register a service. Re-registration overwrites and wakes any pending
 * `ready()` calls. This is what happens during HMR or a project reload.
 */
export function register<K extends ServiceKey>(key: K, value: ServiceMap[K]): void {
  registry.set(key, value);

  // Mirror into the legacy ctx.features bag so unmigrated code keeps working.
  try {
    (ctx.features as Record<string, unknown>)[key as string] = value;
  } catch {
    /* */
  }

  const waiters = readyResolvers.get(key);
  if (waiters) {
    readyResolvers.delete(key);
    for (const cb of waiters) {
      try { cb(value); } catch { /* */ }
    }
  }
}

export function use<K extends ServiceKey>(key: K): ServiceMap[K] {
  const v = registry.get(key);
  if (!v) {
    throw new ServiceNotReadyError(key);
  }
  return v as ServiceMap[K];
}

export function tryUse<K extends ServiceKey>(key: K): ServiceMap[K] | null {
  return (registry.get(key) as ServiceMap[K]) ?? null;
}

export function hasService<K extends ServiceKey>(key: K): boolean {
  return registry.has(key);
}

/**
 * Resolve when the service is registered. If it is already registered, the
 * returned promise resolves on the next microtask so callers can always
 * `await` without branching.
 */
export function ready<K extends ServiceKey>(key: K): Promise<ServiceMap[K]> {
  const existing = registry.get(key);
  if (existing) return Promise.resolve(existing as ServiceMap[K]);

  return new Promise<ServiceMap[K]>((resolve) => {
    const list = readyResolvers.get(key) ?? [];
    list.push(resolve as (v: ServiceMap[ServiceKey]) => void);
    readyResolvers.set(key, list);
  });
}

export class ServiceNotReadyError extends Error {
  constructor(public readonly key: ServiceKey) {
    super(
      `Service "${String(key)}" was requested before it was registered. ` +
      `Call services.ready("${String(key)}") to await it, or use ` +
      `services.tryUse("${String(key)}") if it is optional.`,
    );
    this.name = "ServiceNotReadyError";
  }
}

/** Convenience re-exports for call sites. */
export const services = {
  get selection(): SelectionService { return use("selection"); },
  get authoring(): AuthoringService { return use("authoring"); },
  get family(): FamilyService { return use("family"); },
  get camera(): CameraService { return use("camera"); },
  get clash(): ClashService { return use("clash"); },
  get fragEdit(): FragEditService { return use("fragEdit"); },
  get issues(): IssuesService { return use("issues"); },
  get schedules(): SchedulesService { return use("schedules"); },
  get projects(): ProjectsService { return use("projects"); },
  get planView(): PlanViewService { return use("planView"); },
  get appLoader(): AppLoaderService { return use("appLoader"); },
  get commandPalette() { return use("commandPalette"); },

  register,
  ready,
  use,
  tryUse,
  has: hasService,
};

/* ══════════════════════════════════════════════════════════════════════
   Debug helpers
   ══════════════════════════════════════════════════════════════════════ */
export function listRegisteredServices(): ServiceKey[] {
  return [...registry.keys()];
}

/** Print a snapshot of registered services to the console. */
export function dumpServiceRegistry(): void {
  console.group("[services] registry");
  for (const k of listRegisteredServices()) {
    console.log("  •", k);
  }
  console.groupEnd();
}
