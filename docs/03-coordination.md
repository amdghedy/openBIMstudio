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
