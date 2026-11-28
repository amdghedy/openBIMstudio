/**
 * Annotation types — dimensions and tags that live in a VIEW, not in the
 * element model. Every annotation references the element(s) it describes
 * through the Reference system so it follows element motion.
 */
export const DEFAULT_DIM_STYLES = [
    { id: "aligned-mm", name: "Aligned 2.5 mm", unit: "mm", precision: 0, textSizePt: 2.5, color: "#1d4ed8", tick: "diagonal" },
    { id: "eng-mm", name: "Engineering 3 mm", unit: "mm", precision: 0, textSizePt: 3, color: "#1e40af", tick: "diagonal" },
    { id: "decimal-m", name: "Decimal meters", unit: "m", precision: 3, textSizePt: 2.5, color: "#1d4ed8", tick: "arrow" },
    { id: "imperial-ft", name: "Imperial feet", unit: "ft", precision: 2, textSizePt: 2.5, color: "#1d4ed8", tick: "arrow" },
];
const dimensionsByView = new Map();
const tagsByView = new Map();
const notesByView = new Map();
const calloutsByView = new Map();
export function getDimensions(viewId) { return dimensionsByView.get(viewId) ?? []; }
export function setDimensions(viewId, arr) {
    if (arr.length)
        dimensionsByView.set(viewId, arr.slice());
    else
        dimensionsByView.delete(viewId);
}
export function updateDimension(viewId, id, patch) {
    const arr = dimensionsByView.get(viewId);
    if (!arr)
        return false;
    const i = arr.findIndex((d) => d.id === id);
    if (i < 0)
        return false;
    arr[i] = { ...arr[i], ...patch };
    return true;
}
export function addDimension(d) {
    const arr = dimensionsByView.get(d.viewId) ?? [];
    arr.push(d);
    dimensionsByView.set(d.viewId, arr);
    return d;
}
export function removeDimension(viewId, id) {
    const arr = dimensionsByView.get(viewId);
    if (!arr)
        return;
    dimensionsByView.set(viewId, arr.filter((d) => d.id !== id));
}
export function getTags(viewId) { return tagsByView.get(viewId) ?? []; }
export function setTags(viewId, arr) {
    if (arr.length)
        tagsByView.set(viewId, arr.slice());
    else
        tagsByView.delete(viewId);
}
export function updateTag(viewId, id, patch) {
    const arr = tagsByView.get(viewId);
    if (!arr)
        return false;
    const i = arr.findIndex((t) => t.id === id);
    if (i < 0)
        return false;
    arr[i] = { ...arr[i], ...patch };
    return true;
}
export function addTag(t) {
    const arr = tagsByView.get(t.viewId) ?? [];
    arr.push(t);
    tagsByView.set(t.viewId, arr);
    return t;
}
export function removeTag(viewId, id) {
    const arr = tagsByView.get(viewId);
    if (!arr)
        return;
    tagsByView.set(viewId, arr.filter((t) => t.id !== id));
}
export function getNotes(viewId) { return notesByView.get(viewId) ?? []; }
export function setNotes(viewId, arr) {
    if (arr.length)
        notesByView.set(viewId, arr.slice());
    else
        notesByView.delete(viewId);
}
export function updateNote(viewId, id, patch) {
    const arr = notesByView.get(viewId);
    if (!arr)
        return false;
    const i = arr.findIndex((n) => n.id === id);
    if (i < 0)
        return false;
    arr[i] = { ...arr[i], ...patch };
    return true;
}
export function addNote(n) {
    const arr = notesByView.get(n.viewId) ?? [];
    arr.push(n);
    notesByView.set(n.viewId, arr);
    return n;
}
// ─── Section callouts ──────────────────────────────────────────────────
export function getCallouts(viewId) {
    return calloutsByView.get(viewId) ?? [];
}
export function setCallouts(viewId, arr) {
    if (arr.length)
        calloutsByView.set(viewId, arr.slice());
    else
        calloutsByView.delete(viewId);
}
export function addCallout(c) {
    const arr = calloutsByView.get(c.viewId) ?? [];
    arr.push(c);
    calloutsByView.set(c.viewId, arr);
    return c;
}
export function removeCallout(viewId, id) {
    const arr = calloutsByView.get(viewId);
    if (!arr)
        return;
    calloutsByView.set(viewId, arr.filter((c) => c.id !== id));
}
export function updateCallout(viewId, id, patch) {
    const arr = calloutsByView.get(viewId);
    if (!arr)
        return false;
    const i = arr.findIndex((c) => c.id === id);
    if (i < 0)
        return false;
    arr[i] = { ...arr[i], ...patch };
    return true;
}
/** Generate the next section label letter: A, B, C, ..., Z, AA, AB, ... */
export function nextCalloutLabel(viewId) {
    const count = getCallouts(viewId).length;
    if (count < 26)
        return String.fromCharCode(65 + count); // A-Z
    return String.fromCharCode(65) + String.fromCharCode(65 + count - 26); // AA, AB, ...
}
