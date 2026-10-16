import React, { useMemo } from 'react';
import { useAppSelector } from '../storeHooks';

export const PropertyPanel: React.FC = () => {
  const api = useAppSelector(s => s.bim.ifcAPI);
  const modelID = useAppSelector(s => s.bim.modelID);
  const selectedId = useAppSelector(s => s.bim.selectedId);

  const props = useMemo(() => {
    if (!api || modelID === null || selectedId === null) return null;
    const line = api.GetLine(modelID, selectedId) as any;
    const entries = Object.entries(line).filter(([k, v]) => typeof (v as any).value !== 'object');
    return entries;
  }, [api, modelID, selectedId]);

  if (!props) return <div style={{ padding: 8 }}>Select an element</div>;

  return (
    <div style={{ padding: 8, overflowY: 'auto', background: '#fff' }}>
      <h3>Properties</h3>
      <table>
        <tbody>
          {props.map(([key, value]) => (
            <tr key={key}>
              <td style={{ fontWeight: 'bold' }}>{key}</td>
              <td>{(value as any).value?.toString() ?? JSON.stringify(value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
