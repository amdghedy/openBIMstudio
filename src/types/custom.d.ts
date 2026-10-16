declare module 'fs' {
  export function writeFileSync(path: string, data: string | Uint8Array, options?: any): void;
}

declare module 'dxf-writer' {
  export class DxfWriter {
    addPoint(x: number, y: number, z?: number): void;
    stringify(): string;
  }
}

declare module '@mlightcad/libredwg-web/wasm/libredwg-web.js' {
  const mod: any;
  export default mod;
}

declare module 'three/examples/jsm/loaders/GLTFLoader' {
  export class GLTFLoader {
    parse(data: any, path: string, onLoad: (gltf:any)=>void, onError: (e:any)=>void): void;
  }
}

declare module 'three/examples/jsm/exporters/GLTFExporter' {
  export class GLTFExporter {
    parse(input: any, onDone: (result:any)=>void, options?: any): void;
  }
}

declare module '@react-three/postprocessing' {
  export const OrbitControls: any;
  export const Stats: any;
  export const EffectComposer: any;
  export const Bloom: any;
  export const SSAO: any;
}

declare module 'web-ifc' {
  declare class IfcAPI {
  CreateAxis2Placement3D(args: any): Promise<any>;
  CreateIfcShapeRepresentation(args: any): Promise<any>;
  CreateIfcBuildingElementProxy(args: any): Promise<any>;
  DeleteEntity(id: number): Promise<void>;
  CreateRectangleProfileDef(args: any): Promise<any>;
  CreateExtrudedAreaSolid(args: any): Promise<any>;
  CreateIfcWallStandardCase(args: any): Promise<any>;
  CreatePropertySet(name: string, props: any[]): Promise<any>;
  AssignPropertySet(entity: any, pset: any): Promise<void>;
  GetAllLines(modelID: number, ifcClass: string): number[];
  GetModelID(): number;
  GetLine(modelID: number, id: number): any;
  GetGeometry(modelID: number, id: number): any;
  ExportIFC(modelID: number): any;
  CreateIfcDimensionCurve?(args: any): Promise<any>;
  CreateIfcAnnotation?(args: any): Promise<any>;
  CreateIfcRoof?(args: any): Promise<any>;
  CreateIfcWindow?(args: any): Promise<any>;
  Init(): Promise<void>;

}
}
