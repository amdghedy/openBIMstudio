export async function getItemMeta(model: any, localId: number) {
  let name = `#${localId}`;
  let category = "Unknown";
  try {
    const data = await model.getItemsData([localId], { attributesDefault: false, attributes: ["Name", "ObjectType", "Tag"] });
    if (data?.[0]) name = String(data[0].Name?.value ?? data[0].ObjectType?.value ?? data[0].Tag?.value ?? name);
  } catch { /* */ }
  try {
    const cats = await model.getItemsOfCategories([/.+/]);
    for (const [cat, ids] of Object.entries(cats)) {
      if ((ids as number[]).includes(localId)) { category = cat; break; }
    }
  } catch { /* */ }
  return { name, category };
}