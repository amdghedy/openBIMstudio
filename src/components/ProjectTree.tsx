import React from 'react';
import { TreeItem, TreeView } from '@mui/lab';
import { useAppSelector, useAppDispatch } from '../storeHooks';
import { select } from '../main';

export const ProjectTree: React.FC = () => {
  const api = useAppSelector(s => s.bim.ifcAPI);
  const modelID = useAppSelector(s => s.bim.modelID);
  const dispatch = useAppDispatch();

  if (!api || modelID === null) return <div>Loading…</div>;

  const projects = api.GetAllLines(modelID, 'IFCPROJECT');
  if (projects.length == 0) return <div>No project</div>;
  const projectId = projects[0];
  const project = api.GetLine(modelID, projectId);

  const renderNode = (expressID: number) => {
    const line = api.GetLine(modelID, expressID) as any;
    const label = line.Name?.value ?? line.constructor.name;
    // collect direct children via IfcRelAggregates where RelatingObject = expressID
    const children: number[] = [];
    const rels = api.GetAllLines(modelID, 'IFCRELAGGREGATES');
    rels.forEach((relId: number) => {
      const rel = api.GetLine(modelID, relId) as any;
      if (rel.RelatingObject?.value === expressID) {
        (rel.RelatedObjects ?? []).forEach((obj:any) => children.push(obj.value));
      }
    });
    return (
      <TreeItem key={expressID} nodeId={expressID.toString()} label={label} onLabelClick={() => dispatch(select(expressID))}>
        {children.map(renderNode)}
      </TreeItem>
    );
  };

  return (
    <TreeView
      defaultCollapseIcon={<span>-</span>}
      defaultExpandIcon={<span>+</span>}
      sx={{ height: '100%', overflowY: 'auto', bgcolor: '#fafafa' }}
    >
      {renderNode(projectId)}
    </TreeView>
  );
};
