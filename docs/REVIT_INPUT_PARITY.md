# BIM Input Parity — Camera, View, Mouse, Keyboard

## Mouse (matches BIM default 3D navigation)

| Action | Behaviour |
|--------|-----------|
| **MMB drag** | Pan |
| **Shift + MMB drag** | Orbit around target |
| **Ctrl + MMB drag** | Orbit around selection |
| **Scroll wheel** | Zoom to cursor |
| **Shift + Wheel** | Zoom ×3 |
| **Double-click MMB** | Zoom to fit |
| **LMB click** | Select |
| **LMB drag L→R** | Window select |
| **LMB drag R→L** | Crossing select |
| **RMB** | Context menu |

Implemented in `navigation.ts` + `bim-mouse-policy.ts` + `input-router.ts`.  
CameraControls mouse buttons are forced **OFF** so only this map drives the view (`bim-input-parity` re-asserts every 4s).

## Keyboard — view

| Keys | Action |
|------|--------|
| **ZA / ZF / ZE** | Zoom all / fit / extents |
| **ZI / ZO** | Zoom in / out |
| **VN** | Default 3D (home) view |
| **F** | Fit to view |
| **H** | Home view |
| **HH / HI / HR** | Hide / Isolate / Reset temporary |
| **Ctrl+W** | Walk mode |
| **Ctrl+/** | Mouse & keyboard help overlay |

## Keyboard — modify

| Keys | Action |
|------|--------|
| **MV / G** | Move |
| **RO / R** | Rotate |
| **S** | Scale |
| **AL** | Align |
| **MA** | Match properties |
| **CS** | Create similar |
| **GP** | Create group |
| **Delete** | Delete |
| **Esc** | Cancel / clear |
| **Ctrl+Z / Ctrl+Y** | Undo / Redo |

## Keyboard — architecture tools

| Keys | Tool |
|------|------|
| **WA** | Wall |
| **SL** | Slab |
| **CM** | Column |
| **BM** | Beam |
| **DR / WN** | Door / Window |
| **GR / LV** | Grid / Level |
| **ST / RA** | Stairs / Railing |
| **CW** | Curtain wall |
| **RM** | Room |
| **RF / CL** | Roof / Ceiling |
| **DU / PP** | Duct / Pipe |

Two-letter sequences use an ~800 ms buffer (same idea as BIM).

## Help UI

- **Ctrl+/** — full mouse + keyboard map overlay  
- Command Center → **Mouse & Keys**  
- Command palette → “Mouse & Keyboard Help”

## Files

| File | Role |
|------|------|
| `features/navigation.ts` | MMB pan / Shift-orbit / wheel zoom (canonical) |
| `core/bim-mouse-policy.ts` | MMB flags, no zoom during pan, block click after drag |
| `core/input-router.ts` | Gesture ownership |
| `core/wheel-arbiter.ts` | Wheel conflict resolution |
| `features/selection-orbit.ts` | Pivot on LMB selection only |
| `shell/default-shortcuts.ts` | Base tool + app shortcuts |
| `features/bim-input-parity.ts` | Missing BIM keys + help overlay + nav guard |
