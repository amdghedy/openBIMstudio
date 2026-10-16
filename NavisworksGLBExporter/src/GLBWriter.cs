using System;
using System.IO;
using System.Text;
using System.Collections.Generic;
using System.Globalization;

namespace NavisworksGLBExporter
{
    public static class GLBWriter
    {
        public static void Write(string filePath,
                                 List<float> positions,
                                 List<float> normals,
                                 List<uint>  indices)
        {
            int vertexCount = positions.Count / 3;

            float minX = float.MaxValue, minY = float.MaxValue, minZ = float.MaxValue;
            float maxX = float.MinValue, maxY = float.MinValue, maxZ = float.MinValue;
            for (int i = 0; i < positions.Count; i += 3)
            {
                float x = positions[i], y = positions[i+1], z = positions[i+2];
                if (x < minX) minX = x; if (x > maxX) maxX = x;
                if (y < minY) minY = y; if (y > maxY) maxY = y;
                if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
            }

            byte[] posBytes = new byte[positions.Count * 4];
            Buffer.BlockCopy(positions.ToArray(), 0, posBytes, 0, posBytes.Length);
            byte[] nrmBytes = new byte[normals.Count * 4];
            Buffer.BlockCopy(normals.ToArray(), 0, nrmBytes, 0, nrmBytes.Length);
            byte[] idxBytes = new byte[indices.Count * 4];
            Buffer.BlockCopy(indices.ToArray(), 0, idxBytes, 0, idxBytes.Length);

            int idxPad = (4 - (idxBytes.Length % 4)) % 4;
            int posOffset = 0;
            int nrmOffset = posBytes.Length;
            int idxOffset = nrmOffset + nrmBytes.Length;
            int totalBinarySize = idxOffset + idxBytes.Length + idxPad;

            byte[] binaryBuffer = new byte[totalBinarySize];
            Buffer.BlockCopy(posBytes, 0, binaryBuffer, posOffset, posBytes.Length);
            Buffer.BlockCopy(nrmBytes, 0, binaryBuffer, nrmOffset, nrmBytes.Length);
            Buffer.BlockCopy(idxBytes, 0, binaryBuffer, idxOffset, idxBytes.Length);

            var inv = CultureInfo.InvariantCulture;
            string json = "{"
                + "\"asset\":{\"version\":\"2.0\",\"generator\":\"Navisworks GLB Exporter\"},"
                + "\"scene\":0,"
                + "\"scenes\":[{\"nodes\":[0]}],"
                + "\"nodes\":[{\"mesh\":0}],"
                + "\"meshes\":[{\"primitives\":[{\"attributes\":{\"POSITION\":0,\"NORMAL\":1},\"indices\":2,\"mode\":4}]}],"
                + "\"accessors\":["
                    + "{\"bufferView\":0,\"componentType\":5126,\"count\":" + vertexCount + ",\"type\":\"VEC3\","
                    + "\"min\":[" + minX.ToString(inv) + "," + minY.ToString(inv) + "," + minZ.ToString(inv) + "],"
                    + "\"max\":[" + maxX.ToString(inv) + "," + maxY.ToString(inv) + "," + maxZ.ToString(inv) + "]},"
                    + "{\"bufferView\":1,\"componentType\":5126,\"count\":" + vertexCount + ",\"type\":\"VEC3\"},"
                    + "{\"bufferView\":2,\"componentType\":5125,\"count\":" + indices.Count + ",\"type\":\"SCALAR\"}"
                + "],"
                + "\"bufferViews\":["
                    + "{\"buffer\":0,\"byteOffset\":" + posOffset + ",\"byteLength\":" + posBytes.Length + ",\"target\":34962},"
                    + "{\"buffer\":0,\"byteOffset\":" + nrmOffset + ",\"byteLength\":" + nrmBytes.Length + ",\"target\":34962},"
                    + "{\"buffer\":0,\"byteOffset\":" + idxOffset + ",\"byteLength\":" + idxBytes.Length + ",\"target\":34963}"
                + "],"
                + "\"buffers\":[{\"byteLength\":" + totalBinarySize + "}]"
                + "}";

            byte[] jsonBytes = Encoding.UTF8.GetBytes(json);
            int jsonPad = (4 - (jsonBytes.Length % 4)) % 4;
            int jsonChunkLen = jsonBytes.Length + jsonPad;
            int binaryChunkLen = totalBinarySize;
            int totalLength = 12 + 8 + jsonChunkLen + 8 + binaryChunkLen;

            using (var fs = new FileStream(filePath, FileMode.Create))
            using (var bw = new BinaryWriter(fs))
            {
                bw.Write(new byte[] { 0x67, 0x6C, 0x54, 0x46 });
                bw.Write(2);
                bw.Write(totalLength);
                bw.Write(jsonChunkLen);
                bw.Write(new byte[] { 0x4A, 0x53, 0x4F, 0x4E });
                bw.Write(jsonBytes);
                byte[] jsonPadBytes = new byte[jsonPad];
for (int i = 0; i < jsonPad; i++) jsonPadBytes[i] = 0x20; // space
                bw.Write(jsonPadBytes);
                bw.Write(binaryChunkLen);
                bw.Write(new byte[] { 0x42, 0x49, 0x4E, 0x00 });
                bw.Write(binaryBuffer);
            }
        }
    }
}


