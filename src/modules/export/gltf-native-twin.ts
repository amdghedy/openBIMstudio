/**
 * Pure glTF / GLB 2.0 Binary Exporter for Native Digital Twins & BIM Models.
 *
 * Implements high-speed, direct binary serialization of BIM geometry and metadata
 * into glTF 2.0 binary container (.glb) without requiring DOM, WebGL, or Three.js.
 *
 * Conforms strictly to the glTF 2.0 Specification (Khronos Group):
 * - 12-byte container header (0x46546C67 'glTF', version 2)
 * - 4-byte aligned structured JSON chunk (0x4E4F534A 'JSON')
 * - 4-byte aligned binary buffer chunk (0x004E4942 'BIN')
 * - Full preservation of IFC properties and twin metadata in glTF 'extras'
 * - Support for standard PBR metallic-roughness materials
 *
 * Pure module: headless, safe for Node.js test environments and browser runtime.
 */

export interface NativeTwinGlbElement {
  id: string;
  name?: string;
  category?: string;
  position?: [number, number, number];
  quaternion?: [number, number, number, number];
  scale?: [number, number, number];
  color?: [number, number, number, number]; // RGBA [0..1]
  metallic?: number;
  roughness?: number;
  properties?: Record<string, unknown>;
  geometry: {
    positions: Float32Array | number[];
    indices?: Uint32Array | Uint16Array | number[];
    normals?: Float32Array | number[];
  };
}

export interface GlbExportOptions {
  generator?: string;
  copyright?: string;
  embedPropertiesAsExtras?: boolean;
  computeNormalsIfMissing?: boolean;
}

/**
 * Generate flat vertex normals from positions and triangle indices.
 */
export function computeFlatNormals(
  positions: Float32Array | number[],
  indices?: Uint32Array | Uint16Array | number[],
): Float32Array {
  const posArray = positions instanceof Float32Array ? positions : new Float32Array(positions);
  const numVertices = Math.floor(posArray.length / 3);
  const normals = new Float32Array(numVertices * 3);

  const getIdx = indices
    ? (i: number) => indices[i]
    : (i: number) => i;

  const count = indices ? indices.length : numVertices;

  for (let i = 0; i < count; i += 3) {
    const i0 = getIdx(i);
    const i1 = getIdx(i + 1);
    const i2 = getIdx(i + 2);

    const v0x = posArray[i0 * 3];
    const v0y = posArray[i0 * 3 + 1];
    const v0z = posArray[i0 * 3 + 2];

    const v1x = posArray[i1 * 3];
    const v1y = posArray[i1 * 3 + 1];
    const v1z = posArray[i1 * 3 + 2];

    const v2x = posArray[i2 * 3];
    const v2y = posArray[i2 * 3 + 1];
    const v2z = posArray[i2 * 3 + 2];

    // Edge vectors
    const e1x = v1x - v0x;
    const e1y = v1y - v0y;
    const e1z = v1z - v0z;

    const e2x = v2x - v0x;
    const e2y = v2y - v0y;
    const e2z = v2z - v0z;

    // Cross product
    let nx = e1y * e2z - e1z * e2y;
    let ny = e1z * e2x - e1x * e2z;
    let nz = e1x * e2y - e1y * e2x;

    const len = Math.hypot(nx, ny, nz);
    if (len > 1e-9) {
      nx /= len;
      ny /= len;
      nz /= len;
    }

    // Accumulate normals for vertices
    normals[i0 * 3] += nx;
    normals[i0 * 3 + 1] += ny;
    normals[i0 * 3 + 2] += nz;

    normals[i1 * 3] += nx;
    normals[i1 * 3 + 1] += ny;
    normals[i1 * 3 + 2] += nz;

    normals[i2 * 3] += nx;
    normals[i2 * 3 + 1] += ny;
    normals[i2 * 3 + 2] += nz;
  }

  // Normalize accumulated normals
  for (let i = 0; i < numVertices; i++) {
    const nx = normals[i * 3];
    const ny = normals[i * 3 + 1];
    const nz = normals[i * 3 + 2];
    const len = Math.hypot(nx, ny, nz);
    if (len > 1e-9) {
      normals[i * 3] = nx / len;
      normals[i * 3 + 1] = ny / len;
      normals[i * 3 + 2] = nz / len;
    } else {
      normals[i * 3 + 1] = 1; // default up normal
    }
  }

  return normals;
}

/**
 * Helper to generate simple 3D Box geometry for BIM proxy twins and tests.
 */
export function createBoxGeometry(width = 1, height = 1, depth = 1): {
  positions: Float32Array;
  indices: Uint32Array;
  normals: Float32Array;
} {
  const hx = width / 2;
  const hy = height / 2;
  const hz = depth / 2;

  // 24 vertices (4 per face)
  // prettier-ignore
  const positions = new Float32Array([
    // Front face
    -hx, -hy,  hz,   hx, -hy,  hz,   hx,  hy,  hz,  -hx,  hy,  hz,
    // Back face
    -hx, -hy, -hz,  -hx,  hy, -hz,   hx,  hy, -hz,   hx, -hy, -hz,
    // Top face
    -hx,  hy, -hz,  -hx,  hy,  hz,   hx,  hy,  hz,   hx,  hy, -hz,
    // Bottom face
    -hx, -hy, -hz,   hx, -hy, -hz,   hx, -hy,  hz,  -hx, -hy,  hz,
    // Right face
     hx, -hy, -hz,   hx,  hy, -hz,   hx,  hy,  hz,   hx, -hy,  hz,
    // Left face
    -hx, -hy, -hz,  -hx, -hy,  hz,  -hx,  hy,  hz,  -hx,  hy, -hz,
  ]);

  // prettier-ignore
  const indices = new Uint32Array([
    0, 1, 2,     0, 2, 3,    // Front
    4, 5, 6,     4, 6, 7,    // Back
    8, 9, 10,    8, 10, 11,  // Top
    12, 13, 14,  12, 14, 15, // Bottom
    16, 17, 18,  16, 18, 19, // Right
    20, 21, 22,  20, 22, 23, // Left
  ]);

  const normals = computeFlatNormals(positions, indices);
  return { positions, indices, normals };
}

/**
 * Builds a standard GLB binary container buffer from JSON and binary chunks.
 */
export function buildGlbContainer(jsonChunkObj: Record<string, unknown>, binBuffer: Uint8Array): Uint8Array {
  const jsonStr = JSON.stringify(jsonChunkObj);
  const jsonBytes = new TextEncoder().encode(jsonStr);

  // Pad JSON chunk to 4-byte alignment with 0x20 (space)
  const jsonPadLen = (4 - (jsonBytes.byteLength % 4)) % 4;
  const jsonPaddedLength = jsonBytes.byteLength + jsonPadLen;

  // Pad BIN chunk to 4-byte alignment with 0x00
  const binPadLen = (4 - (binBuffer.byteLength % 4)) % 4;
  const binPaddedLength = binBuffer.byteLength + binPadLen;

  // Total GLB length = 12 (header) + 8 (json chunk header) + jsonPadded + 8 (bin chunk header) + binPadded
  const totalLength = 12 + 8 + jsonPaddedLength + 8 + binPaddedLength;

  const result = new Uint8Array(totalLength);
  const view = new DataView(result.buffer, result.byteOffset, result.byteLength);

  // 1. GLB Header (12 bytes)
  view.setUint32(0, 0x46546C67, true); // magic: 'glTF'
  view.setUint32(4, 2, true);          // version: 2
  view.setUint32(8, totalLength, true); // total length

  // 2. JSON Chunk Header (8 bytes)
  view.setUint32(12, jsonPaddedLength, true); // chunkLength
  view.setUint32(16, 0x4E4F534A, true);       // chunkType: 'JSON'
  result.set(jsonBytes, 20);
  for (let i = 0; i < jsonPadLen; i++) {
    result[20 + jsonBytes.byteLength + i] = 0x20; // space padding
  }

  // 3. BIN Chunk Header (8 bytes)
  const binHeaderOffset = 20 + jsonPaddedLength;
  view.setUint32(binHeaderOffset, binPaddedLength, true); // chunkLength
  view.setUint32(binHeaderOffset + 4, 0x004E4942, true);  // chunkType: 'BIN\0'
  result.set(binBuffer, binHeaderOffset + 8);
  for (let i = 0; i < binPadLen; i++) {
    result[binHeaderOffset + 8 + binBuffer.byteLength + i] = 0x00; // zero padding
  }

  return result;
}

/**
 * High-speed direct export of Native Twin elements into a GLB binary package.
 */
export function exportNativeTwinToGlb(
  elements: NativeTwinGlbElement[],
  options: GlbExportOptions = {},
): Uint8Array {
  const binaryParts: Uint8Array[] = [];
  let currentByteOffset = 0;

  const bufferViews: Array<{
    buffer: number;
    byteOffset: number;
    byteLength: number;
    target?: number;
  }> = [];

  const accessors: Array<{
    bufferView: number;
    byteOffset: number;
    componentType: number;
    count: number;
    type: string;
    max?: number[];
    min?: number[];
  }> = [];

  const meshes: Array<{
    name?: string;
    primitives: Array<{
      attributes: Record<string, number>;
      indices?: number;
      material?: number;
    }>;
  }> = [];

  const materials: Array<{
    name?: string;
    pbrMetallicRoughness: {
      baseColorFactor: [number, number, number, number];
      metallicFactor: number;
      roughnessFactor: number;
    };
  }> = [];

  const nodes: Array<{
    name?: string;
    mesh?: number;
    translation?: [number, number, number];
    rotation?: [number, number, number, number];
    scale?: [number, number, number];
    extras?: Record<string, unknown>;
  }> = [];

  const sceneNodes: number[] = [];

  function appendBuffer(
    data: Uint8Array,
    target?: number,
  ): { bufferViewIndex: number; byteOffset: number; byteLength: number } {
    // 4-byte align the buffer view offset
    const alignPadding = (4 - (currentByteOffset % 4)) % 4;
    if (alignPadding > 0) {
      binaryParts.push(new Uint8Array(alignPadding));
      currentByteOffset += alignPadding;
    }

    const bvOffset = currentByteOffset;
    binaryParts.push(data);
    currentByteOffset += data.byteLength;

    const bvIndex = bufferViews.length;
    bufferViews.push({
      buffer: 0,
      byteOffset: bvOffset,
      byteLength: data.byteLength,
      target,
    });

    return { bufferViewIndex: bvIndex, byteOffset: 0, byteLength: data.byteLength };
  }

  for (const el of elements) {
    if (!el.geometry || !el.geometry.positions) continue;

    const pos = el.geometry.positions instanceof Float32Array
      ? el.geometry.positions
      : new Float32Array(el.geometry.positions);

    if (pos.length === 0) continue;

    const numVertices = Math.floor(pos.length / 3);

    // Compute bounding box for positions accessor min/max
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let i = 0; i < pos.length; i += 3) {
      const x = pos[i], y = pos[i + 1], z = pos[i + 2];
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    }

    // 1. Position bufferView & accessor (target 34962 = ARRAY_BUFFER)
    const posBytes = new Uint8Array(pos.buffer, pos.byteOffset, pos.byteLength);
    const posBv = appendBuffer(posBytes, 34962);
    const posAccessorIdx = accessors.length;
    accessors.push({
      bufferView: posBv.bufferViewIndex,
      byteOffset: 0,
      componentType: 5126, // FLOAT
      count: numVertices,
      type: "VEC3",
      min: [minX, minY, minZ],
      max: [maxX, maxY, maxZ],
    });

    // 2. Normals bufferView & accessor
    let normals = el.geometry.normals;
    if (!normals && options.computeNormalsIfMissing !== false) {
      normals = computeFlatNormals(pos, el.geometry.indices);
    }
    let normalAccessorIdx: number | undefined;
    if (normals) {
      const norm = normals instanceof Float32Array ? normals : new Float32Array(normals);
      const normBytes = new Uint8Array(norm.buffer, norm.byteOffset, norm.byteLength);
      const normBv = appendBuffer(normBytes, 34962);
      normalAccessorIdx = accessors.length;
      accessors.push({
        bufferView: normBv.bufferViewIndex,
        byteOffset: 0,
        componentType: 5126, // FLOAT
        count: numVertices,
        type: "VEC3",
      });
    }

    // 3. Indices bufferView & accessor (target 34963 = ELEMENT_ARRAY_BUFFER)
    let indexAccessorIdx: number | undefined;
    if (el.geometry.indices && el.geometry.indices.length > 0) {
      const ind = el.geometry.indices instanceof Uint32Array
        ? el.geometry.indices
        : new Uint32Array(el.geometry.indices);
      const indBytes = new Uint8Array(ind.buffer, ind.byteOffset, ind.byteLength);
      const indBv = appendBuffer(indBytes, 34963);
      indexAccessorIdx = accessors.length;

      let minIdx = Infinity, maxIdx = -Infinity;
      for (let i = 0; i < ind.length; i++) {
        if (ind[i] < minIdx) minIdx = ind[i];
        if (ind[i] > maxIdx) maxIdx = ind[i];
      }

      accessors.push({
        bufferView: indBv.bufferViewIndex,
        byteOffset: 0,
        componentType: 5125, // UNSIGNED_INT
        count: ind.length,
        type: "SCALAR",
        min: [minIdx],
        max: [maxIdx],
      });
    }

    // 4. Material
    const matIdx = materials.length;
    materials.push({
      name: `${el.name || el.id}_mat`,
      pbrMetallicRoughness: {
        baseColorFactor: el.color || [0.8, 0.8, 0.82, 1.0],
        metallicFactor: el.metallic ?? 0.1,
        roughnessFactor: el.roughness ?? 0.7,
      },
    });

    // 5. Mesh & Primitive
    const meshIdx = meshes.length;
    const attributes: Record<string, number> = {
      POSITION: posAccessorIdx,
    };
    if (normalAccessorIdx !== undefined) {
      attributes.NORMAL = normalAccessorIdx;
    }

    meshes.push({
      name: el.name || el.id,
      primitives: [
        {
          attributes,
          indices: indexAccessorIdx,
          material: matIdx,
        },
      ],
    });

    // 6. Node
    const nodeIdx = nodes.length;
    const extras: Record<string, unknown> = {
      id: el.id,
      category: el.category || "IfcBuildingElementProxy",
    };
    if (options.embedPropertiesAsExtras !== false && el.properties) {
      extras.properties = el.properties;
    }

    nodes.push({
      name: el.name || el.id,
      mesh: meshIdx,
      translation: el.position,
      rotation: el.quaternion,
      scale: el.scale,
      extras,
    });

    sceneNodes.push(nodeIdx);
  }

  // Combine binary parts into one contiguous buffer
  const binBuffer = new Uint8Array(currentByteOffset);
  let writeOffset = 0;
  for (const part of binaryParts) {
    binBuffer.set(part, writeOffset);
    writeOffset += part.byteLength;
  }

  // Build glTF JSON object
  const gltfJson: Record<string, unknown> = {
    asset: {
      version: "2.0",
      generator: options.generator || "openBIMstudio Native Twin glTF Exporter",
      copyright: options.copyright || "openBIMstudio",
    },
    scene: 0,
    scenes: [
      {
        name: "NativeTwinScene",
        nodes: sceneNodes,
      },
    ],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [
      {
        byteLength: binBuffer.byteLength,
      },
    ],
  };

  return buildGlbContainer(gltfJson, binBuffer);
}
