/**
 * Canonical Modify command registry.
 *
 * This module is deliberately UI- and renderer-independent. Ribbon, context
 * menus, shortcuts and the command palette must consume this metadata rather
 * than maintaining separate command inventories or selection rules.
 */

export type ModifyCommandId =
  | "move" | "copy" | "paste" | "rotate" | "mirror" | "array" | "offset" | "scale"
  | "create-similar" | "match-props" | "select-similar" | "align-x" | "align-z"
  | "pin" | "unpin" | "split-mid" | "join-walls" | "delete";

export type ModifyCommandGroup = "transform" | "edit" | "create-match" | "clipboard" | "constraints";
export type ModifyCommandKind = "interactive" | "immediate" | "selection" | "clipboard";
export type ModifySelectionRequirement = "none" | "one" | "two" | "clipboard";
export type ModifySourceKind = "native" | "fragment" | "linked" | "cad" | "point-cloud" | "annotation";
export type ModifyEditMode = "project" | "sketch" | "family" | "group";

export interface ModifyCommandDefinition {
  readonly id: ModifyCommandId;
  readonly label: string;
  readonly group: ModifyCommandGroup;
  readonly kind: ModifyCommandKind;
  readonly icon: string;
  /** RVT-style command alias, not a promise of a physical keyboard binding. */
  readonly commandAlias?: string;
  readonly selection: ModifySelectionRequirement;
  readonly sourceKinds: readonly ModifySourceKind[];
  readonly categories?: readonly string[];
  readonly editModes: readonly ModifyEditMode[];
  readonly danger?: boolean;
  readonly separatorBefore?: boolean;
  readonly synonyms: readonly string[];
  readonly description: string;
}

export interface ModifySelectedElement {
  readonly id: string;
  readonly category?: string;
  readonly sourceKind?: ModifySourceKind;
  readonly editable?: boolean;
  readonly pinned?: boolean;
  readonly locked?: boolean;
}

export interface ModifyCapabilityContext {
  readonly selectedCount: number;
  readonly clipboardCount?: number;
  readonly selectedElements?: readonly ModifySelectedElement[];
  readonly editMode?: ModifyEditMode;
}

export interface ModifyCapabilityResult {
  readonly commandId: ModifyCommandId;
  readonly enabled: boolean;
  readonly reason?: string;
  readonly eligibleElementIds: readonly string[];
  readonly rejectedElementIds: readonly string[];
}

const NATIVE: readonly ModifySourceKind[] = ["native"];
const PROJECT: readonly ModifyEditMode[] = ["project"];

const BUILT_IN_MODIFY_COMMANDS: readonly ModifyCommandDefinition[] = [
  { id: "move", label: "Move", group: "transform", kind: "interactive", icon: "✥", commandAlias: "MV", selection: "one", sourceKinds: NATIVE, editModes: PROJECT, synonyms: ["translate", "displace", "relocate"], description: "Move selected authored elements using point-to-point or numeric displacement." },
  { id: "copy", label: "Copy", group: "transform", kind: "interactive", icon: "⧉", commandAlias: "CO", selection: "one", sourceKinds: NATIVE, editModes: PROJECT, synonyms: ["duplicate", "clone"], description: "Create copies of selected authored elements." },
  { id: "paste", label: "Paste", group: "clipboard", kind: "clipboard", icon: "📋", commandAlias: "Ctrl+V", selection: "clipboard", sourceKinds: NATIVE, editModes: PROJECT, synonyms: ["paste from clipboard"], description: "Place elements previously copied to the Modify clipboard." },
  { id: "rotate", label: "Rotate", group: "transform", kind: "interactive", icon: "↻", commandAlias: "RO", selection: "one", sourceKinds: NATIVE, editModes: PROJECT, synonyms: ["turn", "spin"], description: "Rotate selected authored elements about a picked pivot." },
  { id: "mirror", label: "Mirror", group: "transform", kind: "interactive", icon: "▦", commandAlias: "MI", selection: "one", sourceKinds: NATIVE, editModes: PROJECT, synonyms: ["reflect", "flip"], description: "Reflect selected authored elements across a picked mirror axis." },
  { id: "array", label: "Array", group: "transform", kind: "interactive", icon: "⊞", commandAlias: "AR", selection: "one", sourceKinds: NATIVE, editModes: PROJECT, synonyms: ["linear array", "radial array", "repeat"], description: "Create linear or radial copies of selected authored elements." },
  { id: "offset", label: "Offset", group: "transform", kind: "interactive", icon: "⇔", commandAlias: "OF", selection: "one", sourceKinds: NATIVE, editModes: PROJECT, synonyms: ["parallel", "distance"], description: "Create a parallel offset from a supported linear element." },
  { id: "scale", label: "Scale", group: "transform", kind: "interactive", icon: "⤢", commandAlias: "SC", selection: "one", sourceKinds: NATIVE, editModes: PROJECT, synonyms: ["resize"], description: "Adjust supported authored geometry using the scale gizmo." },
  { id: "create-similar", label: "Create Similar", group: "create-match", kind: "interactive", icon: "⊕", selection: "one", sourceKinds: NATIVE, editModes: PROJECT, separatorBefore: true, synonyms: ["same type", "new instance"], description: "Start placement using the selected element's type and properties." },
  { id: "match-props", label: "Match Properties", group: "create-match", kind: "interactive", icon: "⇄", selection: "one", sourceKinds: NATIVE, editModes: PROJECT, synonyms: ["paint properties", "copy properties"], description: "Acquire properties from the selected source and apply them to a target." },
  { id: "select-similar", label: "Select Similar", group: "create-match", kind: "selection", icon: "⊟", selection: "one", sourceKinds: NATIVE, editModes: PROJECT, synonyms: ["same category", "same type selection"], description: "Select authored elements similar to the selected source element." },
  { id: "align-x", label: "Align X", group: "edit", kind: "immediate", icon: "↔", selection: "two", sourceKinds: NATIVE, editModes: PROJECT, separatorBefore: true, synonyms: ["horizontal align", "align centers x"], description: "Align selected authored elements to the first selected element along X." },
  { id: "align-z", label: "Align Z", group: "edit", kind: "immediate", icon: "↕", selection: "two", sourceKinds: NATIVE, editModes: PROJECT, synonyms: ["vertical align", "align centers z"], description: "Align selected authored elements to the first selected element along Z." },
  { id: "pin", label: "Pin", group: "constraints", kind: "immediate", icon: "📌", selection: "one", sourceKinds: NATIVE, editModes: PROJECT, separatorBefore: true, synonyms: ["lock position"], description: "Prevent accidental modification of selected authored elements." },
  { id: "unpin", label: "Unpin", group: "constraints", kind: "immediate", icon: "○", selection: "one", sourceKinds: NATIVE, editModes: PROJECT, synonyms: ["unlock position"], description: "Allow modification of selected authored elements." },
  { id: "split-mid", label: "Split at Midpoint", group: "edit", kind: "immediate", icon: "✂", selection: "one", sourceKinds: NATIVE, editModes: PROJECT, synonyms: ["divide", "split element"], description: "Split supported linear authored elements at their midpoint." },
  { id: "join-walls", label: "Join Walls", group: "edit", kind: "immediate", icon: "⋈", selection: "one", sourceKinds: NATIVE, editModes: PROJECT, synonyms: ["wall corner join"], description: "Join selected authored wall runs at compatible corners." },
  { id: "delete", label: "Delete", group: "edit", kind: "immediate", icon: "🗑", commandAlias: "Del", selection: "one", sourceKinds: NATIVE, editModes: PROJECT, danger: true, separatorBefore: true, synonyms: ["remove", "erase"], description: "Delete selected authored elements after dependency validation." },
];

const registry = new Map<ModifyCommandId, ModifyCommandDefinition>();
for (const definition of BUILT_IN_MODIFY_COMMANDS) {
  if (registry.has(definition.id)) throw new Error(`Duplicate Modify command id: ${definition.id}`);
  registry.set(definition.id, definition);
}

export function listModifyCommandDefinitions(): ModifyCommandDefinition[] {
  return [...registry.values()];
}

export function getModifyCommandDefinition(id: string): ModifyCommandDefinition | undefined {
  return registry.get(id as ModifyCommandId);
}

/** Add a plugin/application command without silently replacing an existing id. */
export function registerModifyCommand(definition: ModifyCommandDefinition): void {
  if (registry.has(definition.id)) throw new Error(`Modify command already registered: ${definition.id}`);
  registry.set(definition.id, Object.freeze({ ...definition }));
}

export function unregisterModifyCommand(id: ModifyCommandId): boolean {
  if (BUILT_IN_MODIFY_COMMANDS.some((definition) => definition.id === id)) return false;
  return registry.delete(id);
}

/**
 * Resolve command availability from model context. When selected element
 * descriptors are supplied, every selected element must be eligible; partial
 * execution is intentionally not implicit.
 */
export function resolveModifyCapability(
  commandId: string,
  context: ModifyCapabilityContext,
): ModifyCapabilityResult {
  const definition = getModifyCommandDefinition(commandId);
  const empty = { commandId: commandId as ModifyCommandId, enabled: false, eligibleElementIds: [] as string[], rejectedElementIds: [] as string[] };
  if (!definition) return { ...empty, reason: `Unknown Modify command: ${commandId}` };

  const selectedCount = Math.max(0, context.selectedCount || 0);
  const clipboardCount = Math.max(0, context.clipboardCount || 0);
  if (definition.selection === "clipboard" && clipboardCount < 1) {
    return { ...empty, commandId: definition.id, reason: "Clipboard is empty" };
  }
  if (definition.selection === "one" && selectedCount < 1) {
    return { ...empty, commandId: definition.id, reason: "Select at least one authored element" };
  }
  if (definition.selection === "two" && selectedCount < 2) {
    return { ...empty, commandId: definition.id, reason: "Select at least two authored elements" };
  }

  const mode = context.editMode ?? "project";
  if (!definition.editModes.includes(mode)) {
    return { ...empty, commandId: definition.id, reason: `${definition.label} is unavailable in ${mode} edit mode` };
  }

  const selected = context.selectedElements;
  if (!selected?.length) {
    return { ...empty, commandId: definition.id, enabled: true, eligibleElementIds: [] };
  }

  const rejected: string[] = [];
  const eligible: string[] = [];
  for (const element of selected) {
    let reason = "";
    if (element.sourceKind && !definition.sourceKinds.includes(element.sourceKind)) reason = "unsupported source model";
    else if (element.editable === false) reason = "element is read-only";
    else if (element.locked) reason = "element is locked by another user";
    else if (element.pinned && definition.id !== "unpin" && definition.id !== "pin") reason = "element is pinned";
    else if (element.category && definition.categories && !definition.categories.includes(element.category)) reason = "unsupported category";
    if (reason) rejected.push(element.id);
    else eligible.push(element.id);
  }

  if (rejected.length) {
    const reason = selected.find((element) => rejected.includes(element.id));
    let message = "One or more selected elements cannot execute this command";
    if (reason) {
      if (reason.sourceKind && !definition.sourceKinds.includes(reason.sourceKind)) message = `Linked/reference elements are not editable by ${definition.label}`;
      else if (reason.editable === false) message = `Element '${reason.id}' is read-only`;
      else if (reason.locked) message = `Element '${reason.id}' is locked by another user`;
      else if (reason.pinned && definition.id !== "unpin" && definition.id !== "pin") message = `Element '${reason.id}' is pinned; unpin it first`;
      else if (reason.category && definition.categories) message = `${definition.label} does not support category '${reason.category}'`;
    }
    return { commandId: definition.id, enabled: false, reason: message, eligibleElementIds: eligible, rejectedElementIds: rejected };
  }

  return { commandId: definition.id, enabled: true, eligibleElementIds: eligible, rejectedElementIds: [] };
}
