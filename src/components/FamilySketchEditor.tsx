// src/components/FamilySketchEditor.tsx
import React, { useEffect, useRef } from 'react';
import { Tldraw } from '@tldraw/editor';
import { useAppDispatch } from '../storeHooks';
import { pushCommand } from '../main';
import { Command } from '../commands/CommandBase';
import { IfcAPI } from 'web-ifc';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter';

/**
 * A very thin wrapper around @tldraw/editor that lets the user sketch a 2‑D profile
 * and then extrudes it into a parametric family.
 * The UI is inserted as a modal (simple div for now). When the user clicks "Create",
 * the sketch data is converted to a THREE.Shape, extruded, and wrapped in an IFC
 * command (CreateFamilyInstance) that will be added to the model.
 */
export const FamilySketchEditor: React.FC<{ api: IfcAPI; onClose: () => void }> = ({ api, onClose }) => {
  const editorRef = useRef<any>(null);
  const dispatch = useAppDispatch();

  const handleCreate = async () => {
    if (!editorRef.current) return;
    const geometries = editorRef.current.getScene()?.shapes ?? [];
    if (geometries.length === 0) {
      alert('Draw a closed shape first');
      return;
    }
    // Take the first shape (for demo) and build a THREE.Shape
    const points = geometries[0].points.map((p: any) => new THREE.Vector2(p.x, p.y));
    const shape = new THREE.Shape(points);
    const extrude = new THREE.ExtrudeGeometry(shape, { depth: 3000, bevelEnabled: false });
    // Export to GLTF (placeholder) – you could also directly feed into IFC API.
    const exporter = new GLTFExporter();
    exporter.parse(
      extrude,
      (gltf: any) => {
        // In a real implementation we would store this GLTF as a family asset
        console.log('Exported GLTF', gltf);
        // For now we just dispatch a generic command placeholder
        class SketchFamilyCommand extends Command {
          name = 'Sketch Family';
          async execute() {
            // Insert geometry into IFC as a generic IfcBuildingElementProxy
            const placement = await api.CreateAxis2Placement3D({ Location: [0, 0, 0] });
            const shapeRep = await api!.CreateIfcShapeRepresentation!({
              ContextOfItems: 0,
              RepresentationIdentifier: 'Body',
              RepresentationType: 'SweptSolid',
              Items: [{ type: 'IfcFacetedBrep', geometry: extrude }],
            });
            const entity = await api!.CreateIfcBuildingElementProxy!({
              ObjectPlacement: placement,
              Representation: shapeRep,
            });
            return entity.id;
          }
          async undo() {
            // Not implemented – in a full version we would store the id and delete it.
          }
        }
        const cmd = new SketchFamilyCommand();
        cmd.execute();
        dispatch(pushCommand(cmd));
        onClose();
      },
      { binary: false }
    );
  };

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 2000, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, background: '#fff' }}>
        <Tldraw ref={editorRef} schema="web" />
      </div>
      <div style={{ padding: 8, background: '#eee', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button onClick={onClose}>Cancel</button>
        <button onClick={handleCreate}>Create Family</button>
      </div>
    </div>
  );
};
