/**
 * View definitions — the single source of truth for every 2D projection.
 *
 * A ViewDef is a *configuration*. It contains no geometry; it describes how
 * to project the element model onto a plane. The generator produces a
 * Scene2D from a ViewDef + the element model. The renderer draws the Scene2D.
 *
 * This separation is what lets plan / section / elevation share the same
 * renderer, annotation engine, and selection system.
 */
export {};
