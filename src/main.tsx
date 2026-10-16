// src/main.tsx
import React, { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { Provider } from 'react-redux';
import { configureStore, createSlice, PayloadAction } from '@reduxjs/toolkit';
import { IfcAPI } from 'web-ifc';
import { MainRibbon } from '../src/ui/MainRibbon';
import { Viewport } from '../src/components/Viewport';
import { ProjectTree } from '../src/components/ProjectTree';
import { PropertyPanel } from '../src/components/PropertyPanel';
import { loadPlugins } from '../src/plugins/loader';
import './styles.css';
import * as THREE from 'three';

// ---------- Store ----------
interface BIMState {
  ifcAPI: IfcAPI | null;
  modelID: number | null;
  selectedId: number | null;
  commandLog: any[];
  undoStack: any[];
  redoStack: any[];
}
const initialState: BIMState = {
  ifcAPI: null,
  modelID: null,
  selectedId: null,
  commandLog: [],
  undoStack: [],
  redoStack: [],
};

const bimSlice = createSlice({
  name: 'bim',
  initialState,
  reducers: {
    setAPI(state, action: PayloadAction<IfcAPI>) { state.ifcAPI = action.payload; },
    setModel(state, action: PayloadAction<number>) { state.modelID = action.payload; },
    select(state, action: PayloadAction<number | null>) { state.selectedId = action.payload; },
    pushCommand(state, action: PayloadAction<any>) { state.commandLog.push(action.payload); state.undoStack.push(action.payload); state.redoStack = []; },
    undo(state) { const cmd = state.undoStack.pop(); if (cmd) { cmd.undo?.(); state.redoStack.push(cmd); } },
    redo(state) { const cmd = state.redoStack.pop(); if (cmd) { cmd.execute?.(); state.undoStack.push(cmd); } },
  },
});
export const { setAPI, setModel, select, pushCommand, undo, redo } = bimSlice.actions;
export const store = configureStore({ reducer: { bim: bimSlice.reducer } });
export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

// ---------- Bootstrap ----------
async function bootstrap() {
  // Initialize a mock IFC API – real wasm loading is omitted for this demo
  const ifc: any = {
    // Minimal stubs for required methods
    CreateAxis2Placement3D: async () => ({ /* placement */ }),
    CreateIfcShapeRepresentation: async () => ({ /* shape */ }),
    CreateIfcBuildingElementProxy: async () => ({ id: Math.floor(Math.random()*1000) }),
    DeleteEntity: async () => {},
    GetLine: () => ({}),
    GetAllLines: () => [],
    GetModelID: () => 0,
    GetGeometry: () => ({ geometry: new THREE.BoxGeometry() }),
    OpenModel: () => 0,
  } as any;
  // No real model ID – using placeholder 0
  store.dispatch(setAPI(ifc));
  store.dispatch(setModel(0));

  await loadPlugins();
  const container = document.getElementById('app')!;
  const root = createRoot(container);
  root.render(
    <Provider store={store}>
      <div className="app-layout">
        <MainRibbon />
        <div className="main-area">
          <ProjectTree />
          <Viewport />
          <PropertyPanel />
        </div>
      </div>
    </Provider>
  );
}
bootstrap();
