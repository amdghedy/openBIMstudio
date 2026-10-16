using System;
using System.Collections.Generic;
using System.Text;
using System.Windows.Forms;
using Autodesk.Navisworks.Api;
using ComApi = Autodesk.Navisworks.Api.Interop.ComApi;
using ComBridge = Autodesk.Navisworks.Api.ComApi.ComApiBridge;

namespace NavisworksGLBExporter
{
    public class GLBModelExporter : ComApi.InwSimplePrimitivesCB
    {
        private readonly List<float> _positions = new List<float>();
        private readonly List<float> _normals   = new List<float>();
        private readonly List<uint>  _indices   = new List<uint>();
        private uint _vertexOffset = 0;
        private int _triangleCount = 0;
        private int _lineCount = 0;
        private int _pointCount = 0;
        private int _coordErrorCount = 0;
        private string _coordDiag = null;
        private float _minX = float.MaxValue, _minY = float.MaxValue, _minZ = float.MaxValue;
        private float _maxX = float.MinValue, _maxY = float.MinValue, _maxZ = float.MinValue;

        public void Export(Document doc, string filePath)
        {
            _positions.Clear(); _normals.Clear(); _indices.Clear();
            _vertexOffset = 0;
            _triangleCount = 0; _lineCount = 0; _pointCount = 0;
            _coordErrorCount = 0; _coordDiag = null;
            _minX = _minY = _minZ = float.MaxValue;
            _maxX = _maxY = _maxZ = float.MinValue;

            ModelItemCollection items = doc.CurrentSelection.SelectedItems;
            string label;
            if (items == null || items.Count == 0)
            {
                items = new ModelItemCollection();
                foreach (ModelItem it in doc.Models.RootItemDescendants) items.Add(it);
                label = "ENTIRE MODEL";
            }
            else label = "SELECTION";

            StringBuilder diag = new StringBuilder();
            diag.AppendLine("Source: " + label);
            diag.AppendLine("Items: " + items.Count);

            ComApi.InwOpState10 oState = ComBridge.State;
            ComApi.InwOpSelection oSel = ComBridge.ToInwOpSelection(items);

            int pathCount = 0, fragCount = 0, fragWithGeom = 0;
            foreach (ComApi.InwOaPath3 path in oSel.Paths())
            {
                pathCount++;
                ComApi.InwNodeFragsColl frags = path.Fragments();
                if (frags == null) continue;

                for (int fi = 1; fi <= frags.Count; fi++)
                {
                    ComApi.InwOaFragment3 frag = (ComApi.InwOaFragment3)frags[fi];
                    fragCount++;
                    int before = _positions.Count;
                    try
                    {
                        frag.GenerateSimplePrimitives(
                            ComApi.nwEVertexProperty.eNORMAL | ComApi.nwEVertexProperty.eCOLOR,
                            this);
                    }
                    catch (Exception ex) { diag.AppendLine("Fragment error: " + ex.Message); }
                    if (_positions.Count > before) fragWithGeom++;
                }
            }

            diag.AppendLine("Paths: " + pathCount);
            diag.AppendLine("Fragments: " + fragCount);
            diag.AppendLine("Fragments with geometry: " + fragWithGeom);
            diag.AppendLine("Vertices: " + (_positions.Count / 3));
            diag.AppendLine("Triangles: " + _triangleCount);
            if (_positions.Count > 0)
            {
                diag.AppendLine("Bounds X: " + _minX.ToString("F2") + " .. " + _maxX.ToString("F2"));
                diag.AppendLine("Bounds Y: " + _minY.ToString("F2") + " .. " + _maxY.ToString("F2"));
                diag.AppendLine("Bounds Z: " + _minZ.ToString("F2") + " .. " + _maxZ.ToString("F2"));
            }
            if (_coordErrorCount > 0)
                diag.AppendLine("Coord errors: " + _coordErrorCount);
            if (_coordDiag != null)
                diag.AppendLine("Coord diag: " + _coordDiag);

            if (_positions.Count == 0)
            {
                MessageBox.Show(diag.ToString(), "GLB Exporter - Diagnostics");
                return;
            }

            GLBWriter.Write(filePath, _positions, _normals, _indices);
            diag.AppendLine();
            diag.AppendLine("Saved: " + filePath);
            MessageBox.Show(diag.ToString(), "GLB Exporter - Success");
        }

        public void Triangle(ComApi.InwSimpleVertex v1,
                             ComApi.InwSimpleVertex v2,
                             ComApi.InwSimpleVertex v3)
        {
            _triangleCount++;
            AddVertex(v1); AddVertex(v2); AddVertex(v3);
            _indices.Add(_vertexOffset);
            _indices.Add(_vertexOffset + 1);
            _indices.Add(_vertexOffset + 2);
            _vertexOffset += 3;
        }

                private void AddVertex(ComApi.InwSimpleVertex v)
        {
            // Read raw coordinates (Navisworks is Z-up)
            float x = 0, y = 0, z = 0;
            bool ok = false;

            object co = null;
            try { co = v.coord; } catch { }

            if (co != null)
            {
                try
                {
                    Array ca = co as Array;
                    if (ca != null)
                    {
                        int lo = ca.GetLowerBound(0);
                        int hi = ca.GetUpperBound(0);
                        if (hi - lo >= 2)
                        {
                            x = Convert.ToSingle(ca.GetValue(lo));
                            y = Convert.ToSingle(ca.GetValue(lo + 1));
                            z = Convert.ToSingle(ca.GetValue(lo + 2));
                            ok = true;
                        }
                    }
                }
                catch { }
                if (!ok)
                {
                    try
                    {
                        float[] cf = co as float[];
                        if (cf != null && cf.Length >= 3)
                        {
                            x = cf[0]; y = cf[1]; z = cf[2]; ok = true;
                        }
                    }
                    catch { }
                }
            }

            if (!ok) _coordErrorCount++;

            // Convert Z-up (Navisworks) to Y-up (glTF spec)
            float rx =  x;
            float ry =  z;
            float rz = -y;

            _positions.Add(rx); _positions.Add(ry); _positions.Add(rz);
            if (rx < _minX) _minX = rx; if (rx > _maxX) _maxX = rx;
            if (ry < _minY) _minY = ry; if (ry > _maxY) _maxY = ry;
            if (rz < _minZ) _minZ = rz; if (rz > _maxZ) _maxZ = rz;

            // Normals: same rotation
            float nx = 0, ny = 0, nz = 1;
            try
            {
                object no = v.normal;
                if (no != null)
                {
                    Array na = no as Array;
                    if (na != null)
                    {
                        int lo = na.GetLowerBound(0);
                        int hi = na.GetUpperBound(0);
                        if (hi - lo >= 2)
                        {
                            nx = Convert.ToSingle(na.GetValue(lo));
                            ny = Convert.ToSingle(na.GetValue(lo + 1));
                            nz = Convert.ToSingle(na.GetValue(lo + 2));
                        }
                    }
                    else
                    {
                        float[] nf = no as float[];
                        if (nf != null && nf.Length >= 3)
                        {
                            nx = nf[0]; ny = nf[1]; nz = nf[2];
                        }
                    }
                }
            }
            catch { }

            _normals.Add(nx); _normals.Add(nz); _normals.Add(-ny);
        }

        public void Line(ComApi.InwSimpleVertex v1, ComApi.InwSimpleVertex v2) { _lineCount++; }
        public void Point(ComApi.InwSimpleVertex v) { _pointCount++; }
        public void SnapPoint(ComApi.InwSimpleVertex v) { }
    }
}

