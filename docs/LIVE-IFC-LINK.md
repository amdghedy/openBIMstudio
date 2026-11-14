# Live IFC link

Edit in Open BIM Studio and a linked IFC4 file on disk follows your edits, with no export step. If another program changes
that file, the app tells you and waits instead of overwriting it.

**Start:** File → *Live IFC link…* (or Ctrl+P → "IFC: Live link"). Choose where the IFC file goes. A small panel
("Live IFC link") shows the file, the state, the number of elements and writes.

**What is written:** every Native Twin (Insert → *Make editable*) as one federated IFC4 file. It is rewritten about two seconds
after your edits change.

**Outside changes:** the file's modified time is checked every two seconds. If something else changed it, auto-save pauses and
the panel offers *Reload from file* (loads it back into the app) or *Keep mine (overwrite)*.

**Stop:** the panel's *Stop* button, or Ctrl+P → "IFC: Stop live link". The file keeps its last saved state.

## What it is not

- It never writes to your original model: you pick a separate output file.
- It does not read or write Revit `.rvt` files and does not talk to Revit.
- Edited elements are written as IFC building-element proxies with their name, placement and properties; the original IFC
  class and geometry detail of untouched elements are not rewritten.
- Needs a Chromium browser (Chrome or Edge); other browsers do not offer the File System Access API.
- Change history ("git for BIM") already exists as *Native IFC versions* (commit, log, diff, restore); the link adds the
  automatic write-back and outside-change detection.

## Verification

`tests/live-ifc-link.test.cjs` (11 checks): write decisions, conflict handling, IFC output. A real-browser test drives the real
link code against an in-memory stand-in for the file picker: first write, write on edit, outside change detected and not
overwritten, Keep-mine resolves it, Stop removes the panel. Not verified: the real browser file picker and disk, very large
edit sets (the change check serialises all edits every two seconds), and opening the written file in Revit or other tools.
