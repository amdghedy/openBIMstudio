/**
 * Trimble RWCX hand-off assistant.
 *
 * RWCX remains a proprietary Trimble source format. This browser workflow does not
 * decode it; it guides the user through a supported Trimble export and then hands
 * the exported LAS/PTX/PTS files to the existing point-cloud import pipeline.
 */
export function showTrimbleImportAssistant(
  sourceFiles: File[],
  onConvertedFiles: (files: File[]) => Promise<void>,
): Promise<void> {
  return new Promise((resolve) => {
    const overlay = document.createElement("div");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.setAttribute("aria-label", "Trimble point-cloud import assistant");
    overlay.style.cssText =
      "position:fixed;inset:0;z-index:100000;background:rgba(8,12,20,.72);" +
      "display:flex;align-items:center;justify-content:center;padding:20px;font:13px/1.5 system-ui,sans-serif;color:#e8edf5;";

    const panel = document.createElement("section");
    panel.style.cssText =
      "width:min(760px,96vw);max-height:88vh;overflow:auto;background:#151b26;" +
      "border:1px solid #354154;border-radius:12px;box-shadow:0 24px 70px rgba(0,0,0,.5);";
    overlay.appendChild(panel);

    const header = document.createElement("header");
    header.style.cssText = "padding:18px 20px;border-bottom:1px solid #2b3545;display:flex;justify-content:space-between;gap:16px;align-items:center;";
    const heading = document.createElement("div");
    heading.innerHTML = "<div style='font-size:17px;font-weight:700'>Trimble point-cloud import</div><div style='color:#9aa9bd;margin-top:3px'>Convert the source scan, then load the exported point cloud</div>";
    const close = document.createElement("button");
    close.type = "button";
    close.textContent = "✕";
    close.title = "Close";
    close.style.cssText = "border:0;background:transparent;color:#aebbd0;font-size:20px;cursor:pointer;padding:4px 8px;";
    header.append(heading, close);
    panel.appendChild(header);

    const body = document.createElement("div");
    body.style.cssText = "padding:18px 20px;display:grid;gap:14px;";
    panel.appendChild(body);

    const source = document.createElement("div");
    source.style.cssText = "padding:10px 12px;border:1px solid #3a4659;border-radius:8px;background:#101722;";
    source.innerHTML = "<strong>Selected source files</strong>";
    const sourceList = document.createElement("div");
    sourceList.style.cssText = "color:#aebbd0;margin-top:5px;overflow-wrap:anywhere;";
    sourceList.textContent = sourceFiles.map((f) => f.name).join(" · ");
    source.appendChild(sourceList);
    body.appendChild(source);

    const warning = document.createElement("div");
    warning.style.cssText = "padding:11px 12px;border-left:3px solid #e0a33a;background:#2a2418;color:#f4dfb5;border-radius:4px;";
    warning.textContent =
      "RWCX is not decoded by the browser. Keep the original Trimble work-order / Scan Data folder intact; companion files may be required for registration and project coordinates.";
    body.appendChild(warning);

    const tabs = document.createElement("div");
    tabs.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;";
    const instructions = document.createElement("div");
    instructions.style.cssText = "padding:14px;border:1px solid #354154;border-radius:8px;background:#101722;min-height:148px;";
    body.append(tabs, instructions);

    const makeTab = (label: string, key: "tbc" | "realworks") => {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.dataset.route = key;
      button.style.cssText = "padding:8px 13px;border:1px solid #53647d;border-radius:7px;background:#202c3c;color:#e8edf5;cursor:pointer;font-weight:600;";
      button.onclick = () => renderRoute(key);
      tabs.appendChild(button);
    };

    const renderRoute = (route: "tbc" | "realworks") => {
      for (const child of Array.from(tabs.children) as HTMLButtonElement[]) {
        const active = child.dataset.route === route;
        child.style.background = active ? "#24517a" : "#202c3c";
        child.style.borderColor = active ? "#4e9bd5" : "#53647d";
      }
      instructions.innerHTML = "";
      const title = document.createElement("div");
      title.style.cssText = "font-weight:700;font-size:14px;margin-bottom:8px;";
      const list = document.createElement("ol");
      list.style.cssText = "margin:0;padding-left:20px;color:#c6d2e2;display:grid;gap:7px;";
      const steps = route === "tbc"
        ? [
            "Open Trimble Business Center (TBC 5.80 or later with Scanning support).",
            "Import the .SPJ file from the original Siteworks Work Order folder. Do not separate the .RWCX files from their companion Scan Data files.",
            "Confirm that the scans are registered and correctly georeferenced in the TBC project.",
            "Choose Home → Data Exchange → Export → Point Cloud, then export as LAS (recommended) or PTX.",
            "Choose the intended Grid or Ground scaling deliberately. Keep any coordinate-system / scale-factor sidecar file created by TBC with the export.",
            "Return here and select the exported .LAS or .PTX file. Do not apply the project scale factor a second time."
          ]
        : [
            "Open Trimble RealWorks and import/open the original Trimble scan data while retaining its associated project and scan database files.",
            "Confirm registration, station positions, units and the project coordinate frame before exporting.",
            "Use the point-cloud export workflow and choose LAS or PTX. Export the registered scan data, not an unregistered raw subset.",
            "Save the export to a new folder; keep the original Trimble project and source data unchanged.",
            "Return here and select the exported .LAS or .PTX file.",
            "If RealWorks offers coordinate or unit options, record the selected settings and verify them against a known control point."
          ];
      title.textContent = route === "tbc" ? "Route A — Trimble Business Center" : "Route B — Trimble RealWorks";
      for (const step of steps) {
        const li = document.createElement("li");
        li.textContent = step;
        list.appendChild(li);
      }
      instructions.append(title, list);
    };

    makeTab("Trimble Business Center", "tbc");
    makeTab("Trimble RealWorks", "realworks");
    renderRoute("tbc");

    const note = document.createElement("div");
    note.style.cssText = "font-size:12px;color:#9aa9bd;";
    note.textContent =
      "This assistant does not launch or automate Trimble desktop software. It accepts LAS/PTX exports only; E57 and LAZ will be enabled after their browser decoders are implemented and tested.";
    body.appendChild(note);

    const footer = document.createElement("footer");
    footer.style.cssText = "padding:14px 20px;border-top:1px solid #2b3545;display:flex;justify-content:flex-end;gap:8px;";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.textContent = "Cancel";
    cancel.style.cssText = "padding:9px 14px;border:1px solid #53647d;border-radius:7px;background:#202c3c;color:#e8edf5;cursor:pointer;";
    const choose = document.createElement("button");
    choose.type = "button";
    choose.textContent = "Select converted LAS / PTX";
    choose.style.cssText = "padding:9px 14px;border:1px solid #367eb5;border-radius:7px;background:#24517a;color:white;cursor:pointer;font-weight:700;";
    footer.append(cancel, choose);
    panel.appendChild(footer);

    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      overlay.remove();
      resolve();
    };
    close.onclick = finish;
    cancel.onclick = finish;
    overlay.addEventListener("click", (event) => { if (event.target === overlay) finish(); });

    choose.onclick = () => {
      const input = document.createElement("input");
      input.type = "file";
      input.multiple = true;
      input.accept = ".las,.ptx,.pts,.xyz,.txt,.csv";
      input.onchange = async () => {
        const files = input.files ? Array.from(input.files) : [];
        if (!files.length) return;
        choose.disabled = true;
        choose.textContent = "Importing…";
        try {
          await onConvertedFiles(files);
          finish();
        } catch (error) {
          console.error("[trimble-import] converted point-cloud import failed", error);
          choose.disabled = false;
          choose.textContent = "Select converted LAS / PTX";
          const message = error instanceof Error ? error.message : String(error);
          window.alert("The converted point cloud could not be imported: " + message);
        }
      };
      input.click();
    };

    document.body.appendChild(overlay);
  });
}
