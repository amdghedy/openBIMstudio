// src/components/AdvancedRenderer.tsx
import React, { useEffect, useRef } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, Stats, EffectComposer, Bloom, SSAO } from '@react-three/postprocessing';
import * as THREE from 'three';
import { IfcAPI } from 'web-ifc';

/**
 * Advanced renderer using post‑processing passes (Bloom, SSAO) and a
 * physically‑based material. This is a thin wrapper around the existing
 * Viewport but demonstrates how to enable ray‑tracing like features when the
 * hardware / browser supports WebGL2.
 */
export const AdvancedRenderer: React.FC<{ api: IfcAPI }> = ({ api }) => {
  const sceneRef = useRef<THREE.Scene>(null);

  useEffect(() => {
    if (!sceneRef.current) return;
    const modelID = api.GetModelID();
    const ids = api.GetAllLines(modelID, 'IFCPRODUCT');
    const material = new THREE.MeshStandardMaterial({ color: 0x7da7d9, roughness: 0.4, metalness: 0.1 });
    ids.forEach(id => {
      const geom = api.GetGeometry(modelID, id);
      if (!geom) return;
      const mesh = new THREE.Mesh(geom, material);
      mesh.userData.expressID = id;
      sceneRef.current!.add(mesh);
    });
  }, [api]);

  return (
    <Canvas camera={{ position: [10, 10, 10], fov: 60 }} style={{ height: '100%' }}>
      <ambientLight intensity={0.5} />
      <directionalLight position={[10, 10, 10]} intensity={0.8} castShadow />
      <OrbitControls makeDefault />
      <group ref={sceneRef as any} />
      <EffectComposer>
        <SSAO intensity={0.5} radius={5} />
        <Bloom luminanceThreshold={0} luminanceSmoothing={0.9} height={300} />
      </EffectComposer>
      <Stats />
    </Canvas>
  );
};
