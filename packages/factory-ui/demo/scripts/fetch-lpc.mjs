#!/usr/bin/env node
// Fetch & assemble real LPC (Liberated Pixel Cup) character layers for the
// pixel-floor demo. Downloads the layer PNGs named by the Universal LPC
// Spritesheet Character Generator's sheet_definitions, writes them under
// demo/assets/lpc/, and emits:
//   - manifest.js   (window.LPC = {...}; — loaded directly, no fetch/CORS)
//   - CREDITS.md     (aggregated authors + licenses; required by CC-BY-SA/GPL)
//
// Run once (needs network):  node packages/factory-ui/demo/scripts/fetch-lpc.mjs
// Source repo: https://github.com/sanderfrenken/Universal-LPC-Spritesheet-Character-Generator
//
// All assets are CC-BY-SA 3.0 / GPL 3.0. See generated CREDITS.md.

import { mkdir, writeFile, readFile, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const REPO = "sanderfrenken/Universal-LPC-Spritesheet-Character-Generator";
const RAW = `https://raw.githubusercontent.com/${REPO}/master`;
const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "..", "assets", "lpc");

// Each character: ordered list of [definition-file, desired-variant].
// Variant falls back to the definition's first variant if the name is absent.
// Steampunk-industrial crew — fits the "dark factory" theme while staying on the
// LPC universal layout (so the runtime compositor is unchanged).
const CHARACTERS = [
  { key: "explorer", name: "Explorer", role: "Surveyor", layers: [
    ["body_male", "light"],            // pseudo-def handled specially below
    ["heads_human_male", "light"],
    ["legs_pants", "forest"],
    ["torso_clothes_vest", "forest"],
    ["facial_glasses_round", "base"],  // surveyor's specs
    ["hat_cap_bonnie", "forest"],      // flat cap
    ["tool_smash", "pickaxe"],         // prospector's pickaxe
  ]},
  { key: "developer", name: "Developer", role: "Machinist", layers: [
    ["body_male", "light"],
    ["heads_human_male", "light"],
    ["legs_pants", "leather"],
    ["torso_aprons_apron_full", "brown"],  // welder's apron
    ["arms_gloves", "copper"],             // brass/copper work gloves
    ["beards_handlebar", "chestnut"],
    ["facial_glasses_shades", "black"],    // welding goggles
    ["tool_smash", "hammer"],              // forge hammer
  ]},
  { key: "qa", name: "QA", role: "Inspector", layers: [
    ["body_male", "light"],
    ["heads_human_male", "light"],
    ["legs_pants", "bluegray"],
    ["torso_clothes_vest", "blue"],
    ["facial_monocle_left_frame", "black"], // inspector's monocle
    ["hat_formal_bowler", "black"],
  ]},
  { key: "reviewer", name: "Reviewer", role: "Foreman", layers: [
    ["body_male", "light"],
    ["heads_human_male", "light"],
    ["legs_pants", "charcoal"],
    ["torso_clothes_vest", "charcoal"],
    ["beards_handlebar", "ash"],
    ["facial_glasses_round", "base"],
    ["hat_formal_tophat", "black"],        // the boss
    ["weapon_polearm_cane", "cane"],       // supervisor's cane/pointer
  ]},
  { key: "finalize", name: "Finalize", role: "Loader", layers: [
    ["body_male", "light"],
    ["heads_human_male", "light"],
    ["legs_pants", "maroon"],
    ["torso_aprons_overalls", "leather"],  // dockworker overalls
    ["arms_gloves", "iron"],
    ["hat_cap_bonnie", "leather"],
  ]},
];

// body has no sheet_definition we can treat uniformly; hard-code its layer.
const SPECIAL = {
  body_male: {
    variants: ["light"],
    layers: [{ z: 10, path: "body/bodies/male/" }],
    credits: [{ file: "body/bodies/male", authors: ["LPC contributors (see opengameart.org/content/lpc-character-bases)"], licenses: ["CC-BY-SA 3.0", "GPL 3.0"], urls: ["https://opengameart.org/content/lpc-character-bases"] }],
  },
};

const BODYTYPE_KEYS = ["male", "adult", "thin", "universal", "muscular", "teen", "child"];
// Keep only universal/base weapon layers. Per-animation weapon sheets (walk/,
// slash/, …) use a non-universal frame geometry, so they can't be indexed at the
// universal walk row — skip them. Body/head/torso/legs/hat/shield are universal.
const SKIP_PATH = /attack_|hurt|\b(walk|slash|thrust|shoot|spellcast|watering|combat|run|jump|sit|climb|emote)\//;

const exists = (p) => access(p).then(() => true, () => false);

async function getJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.json();
}

// Resolve a definition file -> { variants, layers:[{z,path}], credits:[] }
async function resolveDef(def) {
  if (SPECIAL[def]) return SPECIAL[def];
  const j = await getJson(`${RAW}/sheet_definitions/${def}.json`);
  const layers = [];
  for (const k of Object.keys(j)) {
    if (!k.startsWith("layer_")) continue;
    const L = j[k];
    const key = BODYTYPE_KEYS.find((b) => typeof L[b] === "string")
      ?? Object.keys(L).find((kk) => kk !== "zPos" && typeof L[kk] === "string");
    if (!key) continue;
    layers.push({ z: L.zPos ?? 0, path: L[key] });
  }
  return { variants: j.variants ?? [], layers, credits: j.credits ?? [] };
}

function sanitize(s) { return s.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, ""); }

async function download(url, dest) {
  if (await exists(dest)) return true;
  const r = await fetch(url);
  if (!r.ok) { console.warn(`  ✗ ${r.status}  ${url}`); return false; }
  await writeFile(dest, Buffer.from(await r.arrayBuffer()));
  return true;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const manifestChars = [];
  const creditsByFile = new Map();

  for (const ch of CHARACTERS) {
    console.log(`\n▸ ${ch.name} (${ch.role})`);
    const outLayers = [];
    for (const [def, wantVariant] of ch.layers) {
      let resolved;
      try { resolved = await resolveDef(def); }
      catch (e) { console.warn(`  ! skip ${def}: ${e.message}`); continue; }

      const variant = resolved.variants.includes(wantVariant)
        ? wantVariant
        : (resolved.variants[0] ?? "");
      if (variant !== wantVariant) console.warn(`  ~ ${def}: "${wantVariant}" missing → "${variant}"`);
      for (const c of resolved.credits) creditsByFile.set(c.file ?? def, c);

      for (const layer of resolved.layers) {
        if (SKIP_PATH.test(layer.path)) continue;
        // Skip behind/front weapon-tool halves that only exist for attack frames
        // (768x512 etc.). Keep "universal/background|foreground" which are full sheets.
        if (/(background|foreground)\//.test(layer.path) && !/universal\//.test(layer.path)) continue;
        const v = variant.replace(/ /g, "_"); // generator stores "kite blue blue" as kite_blue_blue.png
        const url = encodeURI(`${RAW}/spritesheets/${layer.path}${v}.png`);
        const file = `${sanitize(def)}__${sanitize(layer.path)}__${sanitize(variant)}.png`;
        const ok = await download(url, join(OUT, file));
        if (ok) { outLayers.push({ file, z: layer.z }); console.log(`  ✓ z${layer.z}  ${file}`); }
      }
    }
    outLayers.sort((a, b) => a.z - b.z);
    manifestChars.push({ key: ch.key, name: ch.name, role: ch.role, layers: outLayers });
  }

  // Manifest as assignable JS (works from file:// without fetch()).
  const manifest = {
    source: `https://github.com/${REPO}`,
    frame: { w: 64, h: 64, cols: 13 },
    // Standard LPC universal row layout; down-facing = row + 2 (up,left,down,right).
    anims: {
      walk:  { row: 8,  frames: 9 },
      slash: { row: 12, frames: 6 },
      thrust:{ row: 4,  frames: 8 },
      spell: { row: 0,  frames: 7 },
      hurt:  { row: 20, frames: 6, single: true },
    },
    characters: manifestChars,
  };
  await writeFile(join(OUT, "manifest.js"),
    `// AUTO-GENERATED by scripts/fetch-lpc.mjs — do not edit by hand.\nwindow.LPC = ${JSON.stringify(manifest, null, 2)};\n`);

  // Attribution file (license requirement).
  let credits = `# LPC Asset Credits\n\nAssembled from the **Universal LPC Spritesheet Character Generator**\n(${manifest.source}).\n\nAll assets licensed **CC-BY-SA 3.0** and/or **GPL 3.0**. Derivatives (this demo)\nmust retain attribution and remain under compatible terms.\n\n`;
  for (const [file, c] of creditsByFile) {
    credits += `## ${file}\n`;
    if (c.authors?.length) credits += `- Authors: ${c.authors.join(", ")}\n`;
    if (c.licenses?.length) credits += `- Licenses: ${c.licenses.join(", ")}\n`;
    if (c.urls?.length) credits += c.urls.map((u) => `- ${u}`).join("\n") + "\n";
    if (c.notes) credits += `- ${c.notes}\n`;
    credits += "\n";
  }
  await writeFile(join(OUT, "CREDITS.md"), credits);

  console.log(`\n✓ Wrote manifest.js + CREDITS.md for ${manifestChars.length} characters → ${OUT}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
