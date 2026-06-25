# ADR-0005: Pixel-art "factory floor" visualization for the web dashboard

- **Status:** Accepted
- **Date:** 2026-06-25
- **Related:** `packages/factory-ui` (Dark Factory UI), [web dashboard plan](../../thoughts/shared/plans/web-tui-dashboard.md)

## Context

The `foreman watch` TUI exposes its data through a tRPC daemon, and `packages/factory-ui`
renders that same data as a "dark factory" web dashboard. We wanted a way to make pipeline
state legible at a glance by **personifying the five pipeline phases** (Explorer →
Developer → QA → Reviewer → Finalize) as characters on a factory floor, with animation
driven by real run state (`RunSummary.status`, `RunProgress.currentPhase/turns/costUsd`).

Options considered for the character art:

1. **Hand-rolled procedural canvas sprites** — zero dependencies, but crude and not scalable.
2. **Dedicated industrial/robot sprite packs** (itch.io / CraftPix) — best theme fit, but
   each pack has a bespoke frame layout and most licenses **forbid redistribution**, so
   they cannot be committed to the repo.
3. **Liberated Pixel Cup (LPC) spritesheets** via the Universal LPC Spritesheet Character
   Generator — a *modular* system where every layer shares one 64×64 "universal" frame grid,
   licensed **CC-BY-SA 3.0 / GPL 3.0** (redistribution permitted with attribution).

## Decision

Adopt **LPC spritesheets, composited at runtime**, as the visualization's character art,
delivered first as a **self-contained demo page** at `packages/factory-ui/demo/pixel-floor.html`.

- **Asset pipeline.** `demo/scripts/fetch-lpc.mjs` reads the generator's `sheet_definitions`
  to resolve exact layer paths / `zPos` / variants, downloads the layer PNGs, and emits
  `assets/lpc/manifest.js` (`window.LPC = …`, loaded as a plain script so it works from
  `file://` with no `fetch`/CORS) plus `assets/lpc/CREDITS.md` (aggregated authors + licenses).
- **Runtime compositor.** The demo draws each character's z-ordered 64×64 layers at the
  current walk-cycle frame onto an offscreen canvas, then blits it with
  `image-rendering: pixelated`. It only uses `drawImage` (never reads pixels), so `file://`
  canvas tainting is a non-issue. The procedural sprites remain as an automatic fallback.
- **Theme.** The five phases are styled as a **steampunk-industrial crew** (Surveyor,
  Machinist, Inspector, Foreman, Loader) to fit the dark-factory aesthetic — re-styling is
  just a layer-selection change in the fetch script; the compositor is unchanged.
- **Licensing.** Only redistribution-permitting assets (LPC: CC-BY-SA 3.0 / GPL 3.0) may be
  bundled into the repo; attribution is captured in `CREDITS.md` at fetch time, per
  [ADR-0004](0004-accepted-findings-policy.md)'s spirit of recording rationale at the source.

## Consequences

**Positive**

- Real, consistent pixel art with a uniform frame layout — one compositor renders all
  characters; re-theming is a config change, not new code.
- Bindings reuse the existing `RunSummary` / `RunProgress` shapes, so the demo maps directly
  onto a future live `FloorView` fed by the Zustand store.
- License-clean to commit: assets are CC-BY-SA/GPL with generated attribution.
- The demo is dependency-free and opens straight from disk.

**Negative / trade-offs**

- The compositor is **coupled to the LPC universal layout** (64×64, standard row order).
  Per-animation LPC sheets (slash/shoot) and non-LPC packs use other geometries; supporting
  them needs per-sheet metadata in the manifest. Non-universal split layers are skipped today.
- Tools/weapons render via their **universal** layer, so they appear in-hand but do **not**
  actively swing during work (would require the per-animation sheets).
- LPC has no male robe/apron, so a few garments use **female-cut layers on the male body** —
  alignment is close but not pixel-perfect.
- ~1 MB of **binary PNG assets** now live in the repo (regenerable via `fetch-lpc.mjs`).
- The visualization is a **standalone demo**, not yet wired into the React app's tab bar.
