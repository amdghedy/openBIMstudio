# CAD Gaps Closed

## Install

```bash
cp -r artifacts/src/* <OpenBIMStudio>/src/
npm run typecheck && npm run dev
```

## Full CAD tool matrix

| Tool | Keys | Notes |
|------|------|-------|
| Line | **L** | Two clicks |
| Polyline | **PL** | Multi-click, **Enter** finishes |
| Rectangle | **REC** | Corner–corner |
| Circle | **CC** | Center–radius |
| Arc | **A** | Center–sweep |
| Text | **DT** | Prompt for string |
| Offset | **O** | Offset last entity |
| **Trim** | **TR** | Cutting edge → object |
| **Extend** | **EX** | Boundary → object |
| **Fillet** | **FI** | Two lines + radius (**Fillet R**) |
| Erase | **E** | Click entity or last |
| Copy | **CO** | Delta X/Y prompt |
| Mirror | **MI** | Vertical axis at click |
| Distance | **DI** | Two points → px |
| Undo | **U** | |
| Ortho | **F8** | |
| Grid | **F7** | |
| Layers | panel | Click to activate |

## UI

| Entry | |
|-------|--|
| Yellow **CAD** button | bottom-left |
| **Ctrl+Shift+D** | CAD panel |
| Command Center → **CAD / Drafting** | |
| Gold **command line** bar | bottom center during tools |

## Workflow examples

**Trim**
1. TR → click cutting line → click segment to shorten  

**Extend**
1. EX → click boundary → click segment end to lengthen  

**Fillet**
1. Set radius with **Fillet R** → FI → click two lines  

**Layers**
1. CAD panel → Layers row → click layer name to make active  

## Runtime API

```js
__obsCad.engine.trimAt(cutterPt, targetPt)
__obsCad.engine.extendTo(boundaryPt, targetPt)
__obsCad.engine.filletAt(pt1, pt2, radius)
__obsCad.engine.distance(a, b)
__obsCad.engine.pickEntity(pt)
__obsCad.engine.listLayers()
```

## Still optional later

- Chamfer  
- Hatch fill patterns  
- Block / XREF library  
- Full typed command-line parser (`LINE 0,0 100,0`)
