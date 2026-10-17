# BIM Authoring

## Overview
OpenBIMStudio is a full authoring environment, not just a viewer. 

## Walls & Openings
- When drawing walls, the system automatically joins and miters corners.
- Doors and Windows are "hosted" to walls. When you place them, the engine uses CSG (Constructive Solid Geometry) to automatically cut a perfect hole in the wall geometry.

![Placing a Door](assets/do-or-placement.png)

## Parametric Families
Families are the building blocks of the model. You can open the Family Browser to select components, or create custom ones using the Formula Engine.

### Example Formula
If you are editing a Door family, you can set the Width to a formula like:
```
root_width = width * 0.95
```
This will dynamically recalculate the geometry whenever the main width changes.
