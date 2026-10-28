/**
 * Expands element context menu Modify section with full toolkit.
 * Call after setupElementContextMenu().
 */
import { getSelectedIds } from "./authoring";
import {
  listModifyActions,
  runModifyAction,
  isModifyActionEnabled,
} from "./modify-actions";

type Any = Record<string, any>;

export function expandElementContextModifyMenu(): void {
  const api = (window as Any).__obsElementCtxMenu;
  if (!api || typeof api.buildItems !== "function") {
    console.warn("[expand-modify-menu] element ctx menu API not ready");
    return;
  }
  if (api.__modifyExpanded) return;
  const original = api.buildItems.bind(api);

  api.buildItems = (elementId: string | null) => {
    const items: Any[] = original(elementId) ?? [];
    const stripIds = new Set([
      "create-similar",
      "match-props",
      "select-similar",
      "align",
      "delete",
    ]);
    const filtered = items.filter((it) => !stripIds.has(it?.id));

    let insertAt = filtered.findIndex((it) => it?.id === "sep4" || it?.id === "group");
    if (insertAt < 0) insertAt = filtered.length;

    let count = 0;
    try {
      count = (getSelectedIds() as string[])?.length ?? 0;
    } catch {
      count = elementId ? 1 : 0;
    }
    if (!count && elementId) count = 1;

    const injected: Any[] = [];
    for (const def of listModifyActions()) {
      if (def.separatorBefore) {
        injected.push({ id: `sep-mod-${def.id}`, label: "", separator: true });
      }
      injected.push({
        id: `mod-${def.id}`,
        label: def.label,
        icon: def.icon,
        shortcut: def.shortcut,
        disabled: !isModifyActionEnabled(def, count),
        danger: !!def.danger,
        action: () => runModifyAction(def.id),
      });
    }

    filtered.splice(insertAt, 0, ...injected);
    return filtered;
  };

  api.__modifyExpanded = true;
  console.info("[expand-modify-menu] full Modify actions installed on element context menu");
}
