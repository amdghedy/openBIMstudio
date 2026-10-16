import React, { useEffect } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls, Stats } from '@react-three/drei';
import { useAppSelector, useAppDispatch } from '../storeHooks';
import { select } from '../main';
import * as THREE from 'three';
import { MeshBVH, acceleratedRaycast } from 'three-mesh-bvh';

THREE.Mesh.prototype.raycast = acceleratedRaycast;

export const Viewport: React.FC = () => {
  const api = useAppSelector(s => s.bim.ifcAPI);
  const modelID = useAppSelector(s => s.bim.modelID);
  const dispatch = useAppDispatch();

  useEffect(() => {
    if (!api || modelID === null) return;
    const ids = api.GetAllLines(modelID, 'IFCPRODUCT');
    const scene = new THREE.Group();
    const material = new THREE.MeshStandardMaterial({ color: 0x7da7d9 });
    ids.forEach((id: number) => {
      const geom = api.GetGeometry(modelID, id);
      if (!geom) return;
      const mesh = new THREE.Mesh(geom.geometry, material);
      mesh.userData.expressID = id;
      // BVH for fast selection / clash
      (mesh.geometry as any).computeBoundsTree?.();
      (mesh.geometry as any).boundsTree = new MeshBVH(mesh.geometry);
      scene.add(mesh);
    });
    // expose scene globally for debugging (optional)
    (window as any).bimScene = scene;
  }, [api, modelID]);

  const handleClick = (event: any) => {
    const { clientX, clientY, target } = event;
    const rect = target.getBoundingClientRect();
    const x = ((clientX - rect.left) / rect.width) * 2 - 1;
    const y = -((clientY - rect.top) / rect.height) * 2 + 1;
    const raycaster = new THREE.Raycaster();
    const camera = (event.currentTarget as any).camera; // three-fiber exposes camera via ref
    raycaster.setFromCamera(new THREE.Vector2(x, y), camera);
    const intersects = raycaster.intersectObjects((window as any).bimScene.children, false);
    if (intersects.length > 0) {
      const id = (intersects[0].object as any).userData.expressID;
      dispatch(select(id));
    } else {
      dispatch(select(null));
    }
  };

  return (
    <Canvas onClick={handleClick} style={{ background: '#eaeaea' }} camera={{ position: [10, 10, 10], fov: 60 }}>
      <ambientLight intensity={0.5} />
      <directionalLight position={[10, 10, 10]} intensity={0.8} castShadow />
      <OrbitControls makeDefault />
      <Stats />
    </Canvas>
  );
};
