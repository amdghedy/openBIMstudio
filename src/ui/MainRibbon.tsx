import React from 'react';
import { AppBar, Tabs, Tab, Button } from '@mui/material';
import { useAppDispatch, useAppSelector } from '../storeHooks';
import { undo, redo, pushCommand, select } from '../main';
import { Command } from '../commands/CommandBase';
import * as THREE from 'three';
import { IfcAPI } from 'web-ifc';
import { CreateWall } from '../commands/CreateWall';
import { ExportDWGCommand } from '../commands/ExportDWGCommand';
import { ImportGLBCommand } from '../commands/draft/ImportGLBCommand';

import { importRFA } from '../services/rfaImport';
import { roundTripToRevit } from '../services/revitRoundTrip';

export const MainRibbon: React.FC = () => {
  const dispatch = useAppDispatch();
  const api = useAppSelector((s) => s.bim.ifcAPI) as IfcAPI | null;
  const [value, setValue] = React.useState(0);

  const handleChange = (event: React.SyntheticEvent, newValue: number) => {
    setValue(newValue);
  };

  const glbInputRef = React.useRef<HTMLInputElement>(null);

  const handleGLBFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !api) return;
    const cmd = new ImportGLBCommand(file);
    const createdIds = await executeCommand(cmd);
    if (createdIds && createdIds.length > 0) {
      // dispatch selection action for the first imported element
      dispatch(select(createdIds[0]));
    }
    // reset input
    e.target.value = '';
  };
  const executeCommand = async (cmd: any) => {
    const result = await cmd.execute();
    dispatch(pushCommand(cmd));
    return result;
  };

  // Family Sketch – uses a minimal hard‑coded shape for demo purposes
  const handleFamilySketch = async () => {
    if (!api) return;
    // Create a simple square shape and extrude it (placeholder)
    class SketchCommand extends Command {
      name = 'Family Sketch';
      async execute() {
        // Placeholder geometry – real implementation would use @tldraw data
        const placement = await api!.CreateAxis2Placement3D!({ Location: [0, 0, 0] });
        const shape = await api!.CreateIfcShapeRepresentation!({
          ContextOfItems: 0,
          RepresentationIdentifier: 'Body',
          RepresentationType: 'SweptSolid',
          Items: [], // No geometry – demo only
        });
        const elem = await api!.CreateIfcBuildingElementProxy!({ ObjectPlacement: placement, Representation: shape });
        return elem.id;
      }
      async undo() { /* no‑op */ }
    };
    const cmd = new SketchCommand();
    await executeCommand(cmd);
  };

  // Adaptive Component – default hostId=0, rule="size * 0.5"
  const handleAdaptiveComponent = async () => {
    if (!api) return;
    class AdaptiveCommand extends Command {
      name = 'Adaptive Component';
      private createdId!: number;
      async execute() {
        const size = 1; // placeholder size
        const factor = size * 0.5;
        const geometry = new THREE.BoxGeometry(factor, factor, factor);
        const placement = await api!.CreateAxis2Placement3D!({ Location: [0, 0, 0] });
        const shape = await api!.CreateIfcShapeRepresentation!({
          ContextOfItems: 0,
          RepresentationIdentifier: 'Body',
          RepresentationType: 'SweptSolid',
          Items: [{ type: 'IfcFacetedBrep', geometry }],
        });
        const elem = await api!.CreateIfcBuildingElementProxy!({ ObjectPlacement: placement, Representation: shape });
        this.createdId = elem.id;
        return this.createdId;
      }
      async undo() { await api!.DeleteEntity!(this.createdId); }
    }
    const cmd = new AdaptiveCommand();
    await executeCommand(cmd);
  };

  // Worksharing lock – lock element 1 with a random user id
  const handleWorkshareLock = async () => {
    // Simple console stub – real implementation would use Y‑js
    console.log('Attempting workshare lock on element 1 (demo)');
  };

  // View Template – store a default template
  const handleViewTemplate = async () => {
    if (!api) return;
    class ViewTemplateCommand extends Command {
      name = 'View Template';
      async execute() {
        const viewId = 0; // placeholder
        const pset = await api!.CreatePropertySet!('Pset_ViewTemplate', [
          { Name: 'TemplateName', NominalValue: 'Default' },
          { Name: 'Visibility', NominalValue: 'default' },
        ]);
        await api!.AssignPropertySet!({ id: viewId } as any, pset);
      }
      async undo() { /* no‑op placeholder */ }
    }
    const cmd = new ViewTemplateCommand();
    await executeCommand(cmd);
  };

  // Auto‑Dimension – use two hard‑coded points
  const handleAutoDimension = async () => {
    if (!api) return;
    class DimCommand extends Command {
      name = 'Auto Dimension';
      private dimId!: number;
      async execute() {
        const p1: [number, number, number] = [0, 0, 0];
        const p2: [number, number, number] = [5000, 0, 0];
        const placement = await api!.CreateAxis2Placement3D!({ Location: [0, 0, 0] });
        const shape = await api!.CreateIfcShapeRepresentation!({
          ContextOfItems: 0,
          RepresentationIdentifier: 'Annotation',
          RepresentationType: 'DimensionCurve',
          Items: [{ type: 'IfcPolyline', Points: [p1, p2] }],
        });
        const dim = await api!.CreateIfcDimensionCurve!({ ObjectPlacement: placement, Representation: shape });
        this.dimId = dim.id;
        return this.dimId;
      }
      async undo() { await api!.DeleteEntity!(this.dimId); }
    }
    const cmd = new DimCommand();
    await executeCommand(cmd);
  };

  // Export Schedule – CSV with placeholder data
  const handleExportSchedule = async () => {
    if (!api) return;
    // Simple CSV generation for demo
    const csv = 'ID,Type\n1,Stair\n2,Wall';
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'schedule.csv';
    a.click();
    URL.revokeObjectURL(url);
  };

  // Call‑out – default text
  const handleCallout = async () => {
    if (!api) return;
    class CalloutCommand extends Command {
      name = 'Callout';
      private annId!: number;
      async execute() {
        const start: [number, number, number] = [0, 0, 0];
        const end: [number, number, number] = [2000, 2000, 0];
        const placement = await api!.CreateAxis2Placement3D!({ Location: start });
        const shape = await api!.CreateIfcShapeRepresentation!({
          ContextOfItems: 0,
          RepresentationIdentifier: 'Annotation',
          RepresentationType: 'Annotation2D',
          Items: [{ type: 'IfcPolyline', Points: [start, end] }],
        });
        const ann = await api!.CreateIfcAnnotation!({ ObjectPlacement: placement, Representation: shape, AnnotationText: { value: 'Demo Callout' } });
        this.annId = ann.id;
        return this.annId;
      }
      async undo() { await api!.DeleteEntity(this.annId); }
    }
    const cmd = new CalloutCommand();
    await executeCommand(cmd);
  };

  // DWG/DXF Export – already a button, just trigger here
  const handleDWGExport = async () => {
    if (!api) return;
    const cmd = new ExportDWGCommand(api!, api!.GetModelID!());
    await executeCommand(cmd);
  };

  // CAD Extras – simple console actions (keep as is)
  const handleHatch = () => console.log('Hatch Fill (placeholder)');
  const handleBlock = () => console.log('Block Insert (placeholder)');
  const handleChamfer = () => console.log('Chamfer (placeholder)');

  // Advanced Renderer – toggle a flag (demo)
  const [useAdvanced, setUseAdvanced] = React.useState(false);
  const handleToggleRenderer = () => setUseAdvanced((prev) => !prev);

  // RFA Import – placeholder using Forge (if credentials present)
  const handleRFAImport = async () => {
    if (!api) return;
    await importRFA('path/to/family.rfa', api!);
  };
  // Model link placeholders
  const handleCADLinkedDrawings = async () => console.log('Link CAD Drawing (placeholder)');
  const handleIFCLinked = async () => console.log('Link IFC (placeholder)');
  const handleFragLinkModel = async () => console.log('Link Frag Model (placeholder)');

  // Revit round‑trip – placeholder using Forge
  const handleRevitRoundTrip = async () => {
    if (!api) return;
    await roundTripToRevit(api!);
  };

  return (
    <AppBar position="static" color="default" elevation={0}>
      <Tabs value={value} onChange={handleChange} variant="scrollable" scrollButtons="auto">
        <Tab label="Home" />
        <Tab label="Insert" />
        <Tab label="Advanced" />
      </Tabs>
      {value === 0 && (
        <div style={{ padding: 8, display: 'flex', gap: 8 }}>
          <Button variant="contained" onClick={() => {
            const cmd = new CreateWall();
            executeCommand(cmd);
          }}>Add Wall</Button>
          <Button variant="contained" onClick={() => dispatch(undo())}>Undo</Button>
          <Button variant="contained" onClick={() => dispatch(redo())}>Redo</Button>
        </div>
      )}
      {value === 1 && (
        <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Button variant="contained" onClick={handleFamilySketch}>Family Sketch</Button>
          <Button variant="contained" onClick={handleAdaptiveComponent}>Adaptive Component</Button>
          <Button variant="contained" onClick={handleWorkshareLock}>Workshare Lock</Button>
          <Button variant="contained" onClick={handleViewTemplate}>View Template</Button>
          <Button variant="contained" onClick={handleAutoDimension}>Auto‑Dimension</Button>
          <Button variant="contained" onClick={handleExportSchedule}>Export Schedule</Button>
          <Button variant="contained" onClick={handleCallout}>Call‑out</Button>
          <Button variant="contained" onClick={() => glbInputRef.current?.click()}>Import GLB</Button>
          <input type="file" accept=".glb,.gltf" style={{ display: 'none' }} ref={glbInputRef} onChange={handleGLBFile} />
          <Button variant="contained" onClick={handleToggleRenderer}>Toggle Advanced Renderer</Button>
          <Button variant="contained" onClick={handleRFAImport}>Import .rfa Family</Button>
          <Button variant="contained" onClick={handleRevitRoundTrip}>Revit Round‑Trip</Button>
        </div>
      )}
    </AppBar>
  );
};
