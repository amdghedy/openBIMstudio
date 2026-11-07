# Coordination & Clash Detection

## Clash Detective
OpenBIMStudio features a Web Worker-based clash detection engine that can handle millions of triangle intersections without locking the UI.

![Clash Results](assets/clash-results.png)

### Workflow
1. Open the Clash Detective tab.
2. Select your "A" categories (e.g., Walls) and "B" categories (e.g., Ducts).
3. Click "Run Test".
4. The engine will find collisions and display them in the Clash Review panel.

## BCF (BIM Collaboration Format)
You can export clashes and issues as a BCF file to share with other BIM software. The viewpoints will automatically capture the camera position and the specific elements involved.


## How a clash test decides (and what it cannot promise)

1. **Which elements:** every IFC model that is loaded (linked models are just more models), plus native elements modelled in this app. Selection A and Selection B can be any mix of models and categories, including two categories of the same file. With scope *A vs B* only A-against-B pairs are tested.
2. **Broad phase:** a spatial hash on bounding boxes finds candidate pairs.
3. **Hard clash (triangles):** exact triangle-triangle intersection. If no surfaces cross, the engine also checks whether one element lies completely inside the other (a pipe embedded in a wall), assuming closed solids.
4. **Touching:** surfaces within the tolerance (default 5 mm) are *touching*, not a clash. A wall resting on a slab is therefore not reported as a hard clash.
5. **Clearance:** pairs closer than the clearance distance, measured between hulls.
6. **Coverage:** after each run the status line says how many elements were tested, how many only by bounding box (no usable geometry, or over 120,000 triangles, which may over-report) and how many were skipped.

No tool can promise to find every clash in every model: open or badly modelled meshes, missing geometry and unloaded links are the usual reasons. The coverage line tells you when that applies.
