# Task: make the Unity project fully compatible with web-editor-authored VoxelBody assets

## Context

Our team has a web-based level editor (repo: `voxel-body-editor`, hosted on GitHub Pages)
that designers use to author `VoxelBody` ScriptableObject assets for our game **Voxel Volley**
outside of Unity. The editor writes Unity YAML `.asset` files directly. Its exporter was
built against a real asset from this project and round-trips it **byte-identically**, so the
format below is exact, not approximate.

Your job: audit and update this Unity project so that any `.asset` file produced by that
editor can be dropped into the project, added to the levels list, and *just work* — with
clear validation errors when a file is malformed instead of silent breakage.

**Prime directive: the serialized format is a contract.** The web tool
(`js/asset.js` in the editor repo) and `VoxelBody.cs` must agree field-for-field. Do NOT
rename, reorder, retype, or remove any serialized field of `VoxelBody` as part of this task.
If you find the current `VoxelBody.cs` has drifted from the format below (extra fields,
different names), do not "fix" the class — **report the exact diff** so the web tool can be
updated to match, and only proceed on the parts that already agree.

## The asset format (exact)

Each file is a standard Unity ScriptableObject YAML document:

```yaml
%YAML 1.1
%TAG !u! tag:unity3d.com,2011:
--- !u!114 &11400000
MonoBehaviour:
  m_ObjectHideFlags: 0
  m_CorrespondingSourceObject: {fileID: 0}
  m_PrefabInstance: {fileID: 0}
  m_PrefabAsset: {fileID: 0}
  m_GameObject: {fileID: 0}
  m_Enabled: 1
  m_EditorHideFlags: 0
  m_Script: {fileID: 11500000, guid: 8154fcdcf86ef414a8a725fd872e9180, type: 3}
  m_Name: bird11-removebg-preview_Body
  m_EditorClassIdentifier: Assembly-CSharp::VoxelVolley.VoxelBody
  displayName: Bird
  sourceImage: {fileID: 0}          # see "differences" below — may also be a real Texture2D ref
  sourceSlice: {fileID: 0}
  size: 14
  depth: 11
  smoothness: 47
  alphaThreshold: 0.347
  greyToWildcard: 1
  layerRules:                       # list of {layer:int, colour:int, percent:int}; may be []
  - layer: 0
    colour: 2
    percent: 100
  layerPatterns: []                 # preserved verbatim on round-trip; tool never authors these
  unitRules:                        # list of {layer:int, kind:int, count:int}; may be []
  - layer: 0
    kind: 1
    count: 1
  wrapInShell: 1
  customCrateGrid: 1
  crateRows: 10
  crateCells:                       # list of {colour:int, rounds:int, chain:int, flags:int}; may be []
  - colour: 0
    rounds: 57
    chain: 0
    flags: 1
  crateRefills:                     # same element shape; colour -1 = any/random (sample flags: 8)
  - colour: -1
    rounds: 0
    chain: 0
    flags: 8
  misplayTolerance: 0
  colours: ffff...                  # voxel grid, see encoding below
  units: 0000...                    # same-shaped grid of unit kinds
  voxelCount: 976
```

The script GUID `8154fcdcf86ef414a8a725fd872e9180` refers to `VoxelBody.cs`
(`VoxelVolley.VoxelBody`, Assembly-CSharp). Confirm this GUID in the project's
`VoxelBody.cs.meta`. If the .meta GUID ever changes, all tool exports break — flag any
code/asset churn that would regenerate it.

### Voxel grid encoding (the important part)

- `colours` and `units` are lowercase hex strings of exactly `size³` bytes
  (2 hex chars per cell). For `size: 14` that is 2744 cells / 5488 chars.
  The grid is **always a cube of `size`**, regardless of `depth`.
- Cell index: `i = x + y*size + z*size*size` (x fastest, then y, then z —
  z-major slices, each slice row-major).
- `colours` values: `ff` = empty cell; `00`–`04` = colour index 0–4 (the game's 5 colours).
  Values outside this set are possible in principle (e.g. wildcard encodings) —
  the loader should treat any non-`ff` byte as a solid voxel and validation should
  warn if a byte is not in the known set.
- `units` values: `00` = no unit; any other byte = a unit of that **kind** embedded at
  that cell. Units only appear on cells that are solid in `colours`.
- `voxelCount` = number of non-`ff` bytes in `colours`. It is precomputed and correct
  in tool exports, but the loader should not trust it blindly — recompute or validate.
- `depth`, `smoothness`, `alphaThreshold`, `greyToWildcard` are **voxelizer parameters
  stored for reference**. For hand-built models they are vestigial: `depth` may not match
  the actual occupied extent. Nothing at runtime should re-derive geometry from them —
  the `colours`/`units` grids are the sole authority.
- Number formatting: integers as plain integers, floats as plain decimals
  (e.g. `0.347`), never exponent notation.

### How tool-authored assets differ from Unity-generated ones

1. **`sourceImage` is `{fileID: 0}`** for models built or generated in the web tool
   (assets that were round-tripped keep their original texture reference). Any code that
   assumes a valid `sourceImage` — editor previews, re-voxelize-on-import logic,
   `OnValidate` regeneration, runtime fallbacks — must null-check and must NOT
   regenerate/overwrite the grids when `sourceImage` is missing. This is the most likely
   breakage point; audit it first.
2. **`m_Name` may not match the file name** if a designer renames the downloaded file.
   Unity tolerates this but it confuses humans and some tooling (Addressables keys,
   `name`-based lookups). Validation should warn on mismatch; do not hard-fail.
3. **`size` can be anything from 4 to 40** (Unity-generated assets happened to be 14).
   Audit for hardcoded 14s / 2744s / 5488s anywhere in decode, pooling, camera framing,
   or shader/mesh assumptions.
4. **Lists may legitimately be empty** (`unitRules: []`, `crateCells: []`) and zero values
   are legitimate (`depth: 0`, `crateRows: 0` survive round-trips). Guard divisions and
   index math accordingly.
5. **Painted units are authoritative.** `unitRules` describes design intent (count per
   onion layer); the `units` grid is what the designer actually placed. If existing code
   spawns units from `unitRules` at load time, it must instead (or additionally) honour
   the `units` grid when it is non-empty. Report which behaviour the code currently has
   before changing it.

## What to do (in order)

1. **Locate and read** `VoxelBody.cs`, its `.meta` (confirm GUID
   `8154fcdcf86ef414a8a725fd872e9180`), and every consumer: search for `VoxelBody`,
   `colours`, `units`, `voxelCount`, `crateCells`, `layerRules`, `sourceImage`.
2. **Verify the field contract**: serialized field names, types, and order in
   `VoxelBody.cs` against the YAML above. Produce a table: field → matches / drifted.
   Stop and report if anything drifted.
3. **Audit the grid decoder**: find where `colours`/`units` hex strings become voxel
   data. Confirm the `i = x + y*size + z*size*size` convention and byte semantics above.
   Confirm decode allocates from `size`, never a constant.
4. **Audit sourceImage dependencies** (difference #1). Fix any path that breaks or
   regenerates when `sourceImage` is `{fileID: 0}`.
5. **Add an editor-side validator** (e.g. `Assets/Editor/VoxelBodyValidator.cs`):
   - menu item `Voxel Volley → Validate Voxel Bodies` that scans all `VoxelBody` assets, plus
     an `AssetPostprocessor` hook that validates on import of any `*.asset` that is a `VoxelBody`;
   - checks: hex string lengths == `size*size*size*2`; hex parses cleanly; colour bytes
     ∈ {ff, 00–04} (warn otherwise); every non-zero `units` byte sits on a solid voxel;
     `voxelCount` matches recount (warn + show both); `size` within 4–40; `m_Name` vs
     file name (warn); crate ammo per colour vs voxel count per colour (warn if any
     colour is short, listing numbers) — mirror of the web editor's own validation;
   - output: one consolidated, clearly-worded log entry per asset; errors ping the asset.
6. **Streamline the levels list**: identify how levels reference `VoxelBody` assets today.
   Add a small editor utility (menu item or list-inspector button) that appends a selected
   `VoxelBody` asset to the levels list, running the validator first. Do not change the
   runtime list structure.
7. **Prove it end-to-end**: take one existing Unity-generated VoxelBody asset and one
   web-tool export (ask for a file, or create a minimal one by hand following the format
   above with a small `size: 6` grid), import both, validate both, add the new one to the
   levels list, enter play mode, and confirm the body spawns and is destructible like
   existing levels. Use the project's headless/edit-mode test setup if one exists.
8. **Report**: contract table from step 2, every code change with file paths, validator
   behaviour on both test assets, and anything that must be mirrored back into the web
   tool (`js/asset.js` is its single format module).

## Acceptance criteria

- A designer's exported `.asset` dropped into `Assets/` imports with no console errors,
  passes the validator, and plays correctly after being added to the levels list.
- No serialized field of `VoxelBody` was renamed/reordered/retyped.
- Round-trip safety intact: exporting an existing asset from the web tool and re-importing
  it produces zero diff in the project (`git diff` on the asset file is empty).
- Validator catches: truncated hex, wrong-length grid, units on empty cells,
  out-of-range colour bytes, voxelCount mismatch — each with an actionable message.
- Missing `sourceImage` never triggers regeneration or errors, in editor or at runtime.
