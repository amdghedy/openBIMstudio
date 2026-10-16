using System;
using WinForms = System.Windows.Forms;
using Autodesk.Navisworks.Api;
using Autodesk.Navisworks.Api.Plugins;

namespace NavisworksGLBExporter
{
    [Plugin("GLBExporter", "MYCOMPANY", DisplayName = "GLB Exporter")]
    [AddInPlugin(AddInLocation.AddIn)]
    public class GLBExporterPlugin : AddInPlugin
    {
        public override int Execute(params string[] parameters)
        {
            Document doc = Autodesk.Navisworks.Api.Application.ActiveDocument;
            if (doc == null)
            {
                WinForms.MessageBox.Show("No document open.", "GLB Exporter");
                return 1;
            }

            using (WinForms.SaveFileDialog sfd = new WinForms.SaveFileDialog())
            {
                sfd.Filter = "GLB File (*.glb)|*.glb";
                sfd.Title = "Save as GLB";
                sfd.FileName = "model.glb";
                if (sfd.ShowDialog() != WinForms.DialogResult.OK) return 0;

                WinForms.Cursor.Current = WinForms.Cursors.WaitCursor;
                try
                {
                    new GLBModelExporter().Export(doc, sfd.FileName);
                    WinForms.Cursor.Current = WinForms.Cursors.Default;
                }
                catch (Exception ex)
                {
                    WinForms.Cursor.Current = WinForms.Cursors.Default;
                    WinForms.MessageBox.Show("Export failed:\n\n" + ex.Message, "GLB Exporter");
                }
            }
            return 0;
        }
    }
}
