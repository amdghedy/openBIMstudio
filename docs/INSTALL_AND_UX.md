# Open BIM Studio — BIM Parity Package

## Install (one step)

```bash
# From your OpenBIMStudio project root
cp -r path/to/artifacts/src/* src/
# or unzip:
# unzip OpenBIMStudio-BIM-Parity.zip -d /tmp/parity && cp -r /tmp/parity/src/* src/

npm run typecheck
npm run dev
```

`main.ts` already has `import "./critical-gaps-boot"` — no entry change.

---

## Error-safe design

| Rule | How |
|------|-----|
| Boot never hard-crashes | Every module uses `import()` inside `safe()` |
| One bad module | Logged as `[critical-gaps-boot] <name>` — rest still load |
| Notifications | Correct API: `notify(kind, message, { timeout })` |
| Missing scene | Geometry place buttons toast “Scene not ready” instead of throwing |

Console success line:

```
[critical-gaps-boot] all critical gaps wired
```

---

## Clear UI — where every function lives

### 1. BIM Command Center (primary)

Opens automatically once per session so you see the full tool map.

| Open | |
|------|--|
| Blue **RC** button | bottom-left |
| **⌘ Command Center** | bottom toolbar |
| **Ctrl+Shift+R** | keyboard |
| **Ctrl+P** → “BIM Command Center” | palette |

**Sections inside the panel**

| Section | Functions |
|---------|-----------|
| Architecture | Straight / L / U Stair · Railing · Curtain Wall · Create Room |
| Modify | Align X · Align Z · Distribute · Match Props · Paint · Group · Create Similar |
| View | Hide · Isolate · Reset Vis · Work Plane XY/XZ · 2D Draft |
| Project panels | Rooms · Phases · Design Options · Groups · Copy/Monitor · Solve Hosts |

Greyed buttons = module still loading. Re-open the panel after ~1s.

### 2. Bottom toolbar

Quick bar: Command Center · Draft · Hosts · Solve · generators · Align · Match · visibility · Phases / Rooms / Options.

### 3. Dockable panels

Rooms & Areas · Phasing · Design Options · Model Groups · Copy/Monitor  
(draggable, close with ✕)

### 4. Command palette (Ctrl+P)

Search: `Stair`, `Align`, `Match`, `Phase`, `Room`, `Hide`, `Curtain`, `Group`, `Work Plane`.

---

## Smoke test (2 minutes)

1. App loads → Command Center opens (or click **RC**).
2. Status line lists ready modules.
3. **Straight Stair** → mesh + success toast.
4. **Create Room** → room number + area toast.
5. **Phasing** → panel opens; change filter.
6. Select 2+ elements → **Align X**.
7. **Ctrl+P** → type `Match Properties`.

---

## Capability matrix

| BIM workflow | Status |
|----------------|--------|
| Parametric families / formulas / constraints | ✅ |
| Nested families / arrays | ✅ |
| Type catalogs | ✅ |
| Shared parameters | ✅ |
| Rooms & areas | ✅ |
| Phasing + filters | ✅ |
| Design options | ✅ |
| Model groups | ✅ |
| Reference planes | ✅ |
| Stairs / railings / curtain walls | ✅ |
| Align / distribute / match props | ✅ |
| Temp dimensions / hide / isolate | ✅ |
| Copy / Monitor | ✅ |
| MEP browser / nav bar / fab / P&ID | ✅ enabled |

Deferred (not blocking): native `.rfa` import, adaptive sketch editor UI, granular worksharing locks.
