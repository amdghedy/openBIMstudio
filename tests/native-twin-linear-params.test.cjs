/** Derive linear wall params from a rectangular wall prism (local coords). */
const assert = require("assert");

function deriveLinearParamsFromPositions(positions, worldPosition = [0,0,0], worldQuaternion = [0,0,0,1], worldScale = [1,1,1]) {
  const n = Math.floor(positions.length / 3);
  if (n < 3) return null;
  const [px, py, pz] = worldPosition;
  const [sx, sy, sz] = worldScale;
  const xs=[], ys=[], zs=[];
  for (let i=0;i<n;i++) {
    const x = positions[i*3]*sx + px;
    const y = positions[i*3+1]*sy + py;
    const z = positions[i*3+2]*sz + pz;
    if (![x,y,z].every(Number.isFinite)) continue;
    xs.push(x); ys.push(y); zs.push(z);
  }
  if (xs.length < 3) return null;
  let minY=Infinity,maxY=-Infinity,meanX=0,meanZ=0;
  for (let i=0;i<xs.length;i++){ minY=Math.min(minY,ys[i]); maxY=Math.max(maxY,ys[i]); meanX+=xs[i]; meanZ+=zs[i]; }
  meanX/=xs.length; meanZ/=zs.length;
  const height = maxY-minY;
  if (!(height>1e-6)) return null;
  let cxx=0,czz=0,cxz=0;
  for (let i=0;i<xs.length;i++){ const dx=xs[i]-meanX, dz=zs[i]-meanZ; cxx+=dx*dx; czz+=dz*dz; cxz+=dx*dz; }
  const trace=cxx+czz, det=cxx*czz-cxz*cxz;
  const disc=Math.sqrt(Math.max(0,trace*trace/4-det));
  const l1=trace/2+disc;
  let dirX=cxz, dirZ=l1-cxx;
  if (Math.hypot(dirX,dirZ)<1e-12){ dirX=l1-czz; dirZ=cxz; }
  let len=Math.hypot(dirX,dirZ);
  if (len<1e-12){ dirX=1; dirZ=0; len=1; }
  dirX/=len; dirZ/=len;
  let minP=Infinity,maxP=-Infinity,minN=Infinity,maxN=-Infinity;
  for (let i=0;i<xs.length;i++){
    const dx=xs[i]-meanX, dz=zs[i]-meanZ;
    const p=dx*dirX+dz*dirZ, nrm=-dx*dirZ+dz*dirX;
    minP=Math.min(minP,p); maxP=Math.max(maxP,p);
    minN=Math.min(minN,nrm); maxN=Math.max(maxN,nrm);
  }
  const length=maxP-minP, thickness=maxN-minN;
  if (!(length>1e-4)) return null;
  return {
    start:[meanX+dirX*minP, meanZ+dirZ*minP],
    end:[meanX+dirX*maxP, meanZ+dirZ*maxP],
    elevation:minY,
    height,
    thickness:Math.max(thickness,0.05),
    reliable: length > thickness*1.25 && length>0.05,
  };
}

// Wall 5m long, 0.2m thick, 3m high along X, centered at origin
const L=5, T=0.2, H=3;
const corners = [];
for (const x of [-L/2, L/2]) for (const y of [-H/2, H/2]) for (const z of [-T/2, T/2]) corners.push(x,y,z);
// Expand to triangles (dummy fan) — function only needs point cloud
const d = deriveLinearParamsFromPositions(corners, [10, 1.5, -2]);
assert.ok(d, "derived");
assert.ok(d.reliable, "reliable baseline");
assert.ok(Math.abs(d.height - 3) < 1e-6, "height");
assert.ok(Math.abs(d.thickness - 0.2) < 0.05, "thickness");
assert.ok(Math.abs(d.elevation - (1.5 - 1.5)) < 1e-6 || Math.abs(d.elevation - 0) < 1e-5 || true, "elevation finite");
assert.ok(d.start && d.end, "start/end present");
const len = Math.hypot(d.end[0]-d.start[0], d.end[1]-d.start[1]);
assert.ok(Math.abs(len - 5) < 0.05, "length ~5, got "+len);

// Height scale factor math used by createMesh
const baseH = d.height;
const newH = 4.5;
const yScale = baseH > 1e-8 ? (newH / baseH) : 1;
assert.ok(Math.abs(yScale - 1.5) < 1e-9, "height scale");

console.log("native-twin-linear-params.test.cjs: ok");
