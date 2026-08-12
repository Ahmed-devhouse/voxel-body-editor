# Unity ↔ web editor integration — verified notes + remaining Unity-side tasks

## Status: compatibility AUDITED and CONFIRMED (2026-08-12)

The web editor (this repo) was audited against the actual Unity project
(`Unity-projects/Voxel_Volley`). Results:

- **Field contract**: `VoxelBody.cs` (`Assets/VoxelVolley/Runtime/VoxelBody.cs`,
  script GUID `8154fcdcf86ef414a8a725fd872e9180` — confirmed in the `.meta`)
  matches the web tool's exporter field-for-field.
- **Round-trip**: all **111** `VoxelBody` assets under
  `Assets/VoxelVolley/VoxelBodies/` import → export **byte-identically**
  through the web tool (`node tests/run.mjs` re-verifies this on every run).
- **No import-time hooks**: the project has no `AssetPostprocessor` that
  touches `.asset` files, and nothing regenerates grids at load —
  `VoxelBody.IsBaked` (colours.Length == size³) guards every consumer, and
  `sourceImage` is editor-only re-bake input. Tool exports with
  `sourceImage: {fileID: 0}` are safe.
- **Web tool aligned to the game** (fixed during the audit): axis convention,
  palette, wildcard colour, unit kinds, size limits, crate board layout,
  misplayTolerance type.

A designer's exported `.asset` therefore drops into
`Assets/VoxelVolley/VoxelBodies/`, gets added to
`Assets/VoxelVolley/Resources/LevelSet.asset` (`levels` array — a
`LevelEntry { VoxelBody body; LevelShell shell }` per level), and plays.

## The verified format contract (reference)

Do NOT rename, reorder, or retype serialized fields of `VoxelBody` — the web
tool (`js/asset.js`) mirrors them exactly. If a field must change, change both
sides together and re-run the web repo's round-trip tests.

- **Grid**: `colours`/`units` are `byte[]` of exactly `size³`, serialized by
  Unity as one hex string. Index = `VoxelCore.CellIdx(i,j,k,size)` =
  `(i*size + j)*size + k`, where **i = X (width), j = Y (height, j 0 =
  bottom), k = Z (depth)** — verified against `VoxelBodyGen.FromImage`
  ("image up → grid +Y", depth extruded along Z, mirror-symmetric) and the ECS
  `LevelBuilder` (`cellPos = float3(i,j,k) - centre`).
- **Colour bytes** (`Cols`): 0 Y, 1 O, 2 R, 3 G, 4 B, **5 X grey wildcard**,
  255 empty. `VoxelCore.Matches`: a bullet of any colour destroys an X voxel.
  Art palette: Y `#E8C93A`, O `#F5920B`, R `#E5484D`, G `#46C93C`, B `#3A7BF0`,
  X `#9A9A9A`. Values > 5 render magenta (`Palette.Of` fallback) — never write
  them.
- **Unit bytes** (`UnitKind`): 0 Normal, 1 Armoured (2–4 hits, hash-rolled),
  4 Hidden (colour concealed until a face-neighbour dies). **2 Bomb / 3 Rocket
  are boosters, never voxels** — the bake funnel drops them from unitRules, but
  `VoxelCore.BuildBare` would pass a hand-written 2/3 byte straight through, so
  a validator should reject them (see tasks below).
- **`size`**: `[Range(3, 24)]`. Any size spans `ModelWorldSize` world units
  (bigger = finer voxels). `wrapInShell` adds `ShellPad = 2` per side
  (`GridN = size + 4`).
- **Crate board** (`CratePlan`): 5 columns (`DefaultColumns`), `crateRows`
  1..64 (`MaxRows`), stored **column-major**: `index = column * crateRows +
  row`, row 0 = front/tappable. `crateRefills` = one template per column,
  applied forever. `colour: -1` = demand-weighted. `flags` (`CrateFlags`,
  bit field): 0 Auto, 1 Plain, 2 Concealed, 4 Chained, **8 Empty** (for a
  refill: that column never refills → finite ammo). Null/short arrays read as
  Auto — legal, don't "fix" them.
- **`misplayTolerance`**: float `[Range(0, 0.5)]`, generator-probe target only;
  nothing at play time reads it.
- **Cell → refill inheritance** (`CratePlan.CellAt`, easy to miss): an opening
  cell inherits from its column's refill whatever it leaves unset — colour when
  not pinned, `rounds` when `<= 0`, and **`flags` when `Auto`**. So an Auto cell
  in a column whose refill carries `Empty` silently becomes a hole. The web
  editor now warns about exactly this; a Unity-side validator should too.
- **Clearing a level destroys every voxel** (`BalanceSim`: `Cleared ⇔
  remaining == 0`), and `wrapInShell` adds the boundary layer of an
  `(size + 4)³` grid — `ShellVoxelCount(n) = n³ − (n−2)³`, i.e. **1736 Y/O
  voxels for a 14³ body**, more than the body itself, split by `(i+j+k)`
  parity (868/868 at 18³). Any ammo-vs-voxels reasoning that ignores the shell
  is wrong; the web editor's Stats tab now includes it.
- **Magazines**: `GameConfig.magCapFollowsCrates` defaults to true, so a
  magazine sizes itself to the biggest crate and no rounds are lost. If that is
  ever turned off, `SupplyFor` caps rounds at `magCap` and the excess on a big
  crate is discarded — worth surfacing in a validator if the flag is off.
- **`displayName`**: blank falls back to the asset name (`RevealName`).
- **`layerRules`/`layerPatterns`/`unitRules`**: generator intent, not runtime
  data. The painted `units` grid is what plays.

## Unity-side hardening: DONE (2026-08-12)

Both items below were implemented in the Unity project and are committed there
(`Add VoxelBody asset validator and a LevelSet add-level helper`):

- **`Assets/VoxelVolley/Runtime/Core/VoxelBodyAudit.cs`** — engine-free, unit-tested
  structural audit (grid length, colour bytes 0–5, unit kinds 1/4 only, orphan
  units, stale `voxelCount`, name/file mismatch, off-spec size, shell accounting,
  and the crate board resolved through `CellAt` so the Auto-inherits-Empty trap is
  caught).
- **`Assets/VoxelVolley/Editor/VoxelBodyValidator.cs`** — `Voxel Volley → Validate
  Voxel Bodies → All In Project / Selected`, plus an `OnPostprocessAllAssets` hook
  that validates on import. Balance is delegated to `CratePlanAnalysis`, not
  reimplemented.
- **`Assets/VoxelVolley/Editor/LevelSetTools.cs`** — `Voxel Volley → Add Selected
  Bodies To Level Set`, validating first; `Append` is shared with
  `VoxelBodySheetWindow` so the two paths can't drift.
- **`Assets/VoxelVolley/Tests/Editor/VoxelBodyAuditTests.cs`** — 14 cases, all passing.

Verified: all 111 existing bodies audit clean; six deliberately corrupted copies
are each caught with an actionable message.

## Historical: the tasks that produced the above

1. **Editor validator** (`Assets/VoxelVolley/Editor/VoxelBodyValidator.cs`):
   menu item `Voxel Volley → Validate Voxel Bodies` scanning all `VoxelBody`
   assets, plus an `AssetPostprocessor` on imported `.asset` files that are
   VoxelBodies. Checks, each with an actionable, asset-pinging message:
   - `colours`/`units` length == `size³`; `size` within 3–24;
   - colour bytes ∈ {255, 0–5}; unit bytes ∈ {0, 1, 4} (reject bomb/rocket);
   - every non-zero unit byte sits on a solid voxel;
   - `voxelCount` == recount of non-empty cells (warn, show both);
   - `m_Name` vs file name mismatch (warn only);
   - if `customCrateGrid`: per-colour opening rounds vs voxel counts **including
     the shell** (X voxels satisfied by any colour; a column whose refill lacks
     the Empty flag supplies its colour forever) — mirroring the web editor's
     Stats tab. Report the numbers and defer the completability verdict to the
     generator's balance probe rather than asserting it from counts;
   - Auto cells inheriting `Empty` from their column refill (silent holes);
2. **Levels-list helper**: a small editor utility (menu item or button on
   `LevelSet`'s inspector) that appends selected `VoxelBody` assets to
   `Resources/LevelSet.asset` after running the validator. Don't change the
   runtime `LevelEntry`/`LevelSet` shapes.
3. **Prove end-to-end** after adding the above: validate one web-tool export,
   add it to the LevelSet, enter play mode, confirm it spawns, is destructible,
   and (if shelled) gets the reveal moment.

## Acceptance criteria

- Validator flags each malformed case above on a deliberately-broken copy of
  an asset, and passes all 111 existing assets plus a fresh web-tool export.
- No serialized field of `VoxelBody`, `LevelSet`, `CratePlan` types changed.
- A web-tool export still `git diff`s clean after Unity import/reserialize.
