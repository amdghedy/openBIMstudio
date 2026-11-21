# Third-party fixtures

Real-world IFC files vendored verbatim from outside this project. They are
the corpus's only non-synthetic models: everything else here is emitted by
the project's own writer, so without these two files no claim about
"importing real IFC" would have any evidence behind it.

## Files

| File | Schema | Size | Origin |
|---|---|---|---|
| `duplex-a.ifc` | IFC2X3 | 2,380,763 bytes | Duplex Apartment, architectural model (Revit Architecture 2011, Coordination View) |
| `duplex-mep.ifc` | IFC2X3 | 17,871,432 bytes | Duplex Apartment, MEP model (Revit MEP 2011, Coordination View) |

## Source

buildingSMART Community Sample Test Files, `IFC 2.3.0.1 (IFC 2x3)/Duplex
Apartment/`:

https://github.com/buildingsmart-community/Community-Sample-Test-Files

The files are stored in that repository with Git LFS. The vendored bytes
are byte-identical to the LFS objects: each file's sha256 equals its LFS
oid (`b347a2c8…` for `duplex-a.ifc`, `13976a8e…` for `duplex-mep.ifc`),
verified at vendoring time (2026-11-21). No byte has been changed, so no
"changes made" note is owed under the licence.

## Licence — CC BY 4.0, attribution required

The source README states (verbatim, typos included):

> These files were originally provided under Creative Commons Liscence.
> These files are provided here under this same liscence. Creative Commons
> (CC BY 4.0). You are free (1) to copy and resitribute this material any
> way you like, (2) you may change the information any way you want, (3)
> you must identify the source of the infomation as "BSI (2020) "Duplex
> Apartment Test Files," buildingSMART International" and add this GitHub
> URL, and (4) if you may changes to these files you must indicate the
> types of changes made.

Attribution, as required: **BSI (2020) "Duplex Apartment Test Files,"
buildingSMART International**,
https://github.com/buildingsmart-community/Community-Sample-Test-Files —
also recorded per fixture in `manifest.json` (`license: "CC BY 4.0"`).

The files stay CC BY 4.0 inside this MIT-licensed repository: do not
re-licence them, and do not strip this notice. The project's own
`*.ifc text eol=lf` git attribute does not alter them (both files are
LF-terminated already — verified at vendoring).

## Why they live in `third-party/` and not at the top level

The fuzz gate (`scripts/fuzz-ifc-corpus.mjs`) seeds on top-level valid
fixtures plus `invalid/`. A 17.9 MB seed would make every nightly run pay
a real-world parse per mutation. The files are still covered by the
manifest test (pre-flight accepts, web-ifc parses as IFC2X3, semantic
validation error-free, golden snapshot exists), by the per-entity
fidelity report (its script walks recursively), and by the browser
import-timeout spec (which imports the MEP file with a small timeout).
They are deliberately *not* fuzz seeds; that trade-off is recorded here
and in `scripts/generate-ifc-corpus.mjs`.

## Known limit

Neither file carries an `IfcSystem` grouping (Revit 2011 Coordination
View did not emit one), so MEP *system membership* is still uncovered
anywhere in the corpus — the writer gap noted in the manifest stands.
`duplex-mep.ifc` covers real MEP segments, equipment and spaces, not
systems.

## Re-fetching

If a file ever needs re-verifying against upstream, fetch the LFS objects
(no `git-lfs` binary is needed):

```sh
curl -s -X POST \
  https://github.com/buildingsmart-community/Community-Sample-Test-Files.git/info/lfs/objects/batch \
  -H "Accept: application/vnd.git-lfs+json" \
  -H "Content-Type: application/vnd.git-lfs+json" \
  -d '{"operation":"download","transfers":["basic"],"objects":[{"oid":"<oid>","size":<size>}]}'
# then download the returned href; sha256 must equal the oid
```

Oids: `duplex-a.ifc` `b347a2c8aa8fff6db896a4417a9c50c22ac0ccd7c5cfc22b99b8d29336c606ed`
(size 2380763); `duplex-mep.ifc`
`13976a8e223f177a6d7123679e4b02e750cd90c13f7bb20c593be125d9407119`
(size 17871432).
