const {execSync}=require("child_process");const fs=require("fs"),os=require("os"),path=require("path"),assert=require("assert");
const out=fs.mkdtempSync(path.join(os.tmpdir(),"ntv-"));
execSync(`npx tsc src/modules/native-twin/vertical-resize.ts --outDir ${out} --module commonjs --target es2020 --skipLibCheck`,{stdio:"inherit"});
const m=require(path.join(out,"vertical-resize.js"));
let pass=0,fail=0;const t=(n,f)=>{try{f();pass++;console.log("  PASS "+n)}catch(e){fail++;console.log("  FAIL "+n+": "+e.message)}};
const near=(a,b,e=1e-9)=>assert.ok(Math.abs(a-b)<e,`${a}!=${b}`);
const box=(x0,x1,y0,y1,z0,z1)=>{const p=[];for(const x of [x0,x1])for(const y of [y0,y1])for(const z of [z0,z1])p.push(x,y,z);return p};
/** world (min,max) Y of the placed mesh */
const worldY=(pos,tr)=>{let a=1e9,b=-1e9;for(let i=0;i<pos.length;i+=3){const r=m.rotateByQuat(tr.quaternion,[pos[i]*tr.scale[0],pos[i+1]*tr.scale[1],pos[i+2]*tr.scale[2]]);const y=r[1]+tr.position[1];a=Math.min(a,y);b=Math.max(b,y)}return[a,b]};
const IDQ=[0,0,0,1], qY=a=>[0,Math.sin(a/2),0,Math.cos(a/2)];

for(const [name,pos,origin] of [
  ["origin at vertical centre",box(-2.5,2.5,-1.5,1.5,-.1,.1),[10,1.5,-2]],
  ["origin at base",box(-2.5,2.5,0,3,-.1,.1),[10,0,-2]],
  ["origin 40 m below the wall (odd source placement)",box(-2.5,2.5,40,43,-.1,.1),[10,0,-2]],
  ["nonzero level elevation (+12.5)",box(-2.5,2.5,0,3,-.1,.1),[10,12.5,-2]],
]) for (const q of [IDQ,qY(0.9)]) {
  t(`${name}${q===IDQ?"":" + rotated"}: raise Height 3 -> 5 keeps the base, top = base + 5`,()=>{
    const tr={position:origin,quaternion:q,scale:[1,1,1]};const [b0]=worldY(pos,tr);
    const r=m.heightResizeTransform({positions:pos,...tr,baseHeight:3,newHeight:5});
    const [b1,t1]=worldY(pos,{...tr,...r});near(b1,b0);near(t1,b0+5);
    assert.deepStrictEqual(r.scale.map((v,i)=>i===1?0:v),[1,0,1]);
    near(r.position[0],origin[0]);near(r.position[2],origin[2])});
  t(`${name}${q===IDQ?"":" + rotated"}: lowering to 2 keeps the base; edit is reversible`,()=>{
    const tr={position:origin,quaternion:q,scale:[1,1,1]};const [b0]=worldY(pos,tr);
    const r=m.heightResizeTransform({positions:pos,...tr,baseHeight:3,newHeight:2});
    const [b1,t1]=worldY(pos,{...tr,...r});near(b1,b0);near(t1,b0+2);
    const back=m.heightResizeTransform({positions:pos,...tr,...r,baseHeight:2,newHeight:3});
    near(back.position[1],tr.position[1]);near(back.scale[1],1)});
}
t("existing non-unit scale and a linked-model scale are respected",()=>{
  const pos=box(-1,1,0,3,-.1,.1),tr={position:[0,5,0],quaternion:IDQ,scale:[1,2,1]};
  const r=m.heightResizeTransform({positions:pos,...tr,baseHeight:6,newHeight:9});
  const [b,t2]=worldY(pos,{...tr,...r});near(b,5);near(t2,14)});
t("invalid input is rejected, not guessed",()=>{
  const pos=box(-1,1,0,3,-.1,.1),tr={position:[0,0,0],quaternion:IDQ,scale:[1,1,1]};
  for(const [b,n] of [[3,0],[3,-1],[3,NaN],[0,3],[NaN,3]])assert.strictEqual(m.heightResizeTransform({positions:pos,...tr,baseHeight:b,newHeight:n}),null);
  assert.strictEqual(m.heightResizeTransform({positions:[],...tr,baseHeight:3,newHeight:4}),null)});
t("footprint centre is the placed bbox centre, not the mesh origin",()=>{
  const c=m.footprintCenterXZ(box(0,2,0,3,0,1),[10,0,20],IDQ,[1,1,1]);near(c[0],11);near(c[1],20.5);
  const r=m.footprintCenterXZ(box(0,2,0,3,0,1),[0,0,0],qY(Math.PI/2),[1,1,1]);near(r[0],0.5,1e-9);near(r[1],-1,1e-9)});
console.log(`=== Result: ${pass} passed, ${fail} failed ===`);process.exit(fail?1:0);
