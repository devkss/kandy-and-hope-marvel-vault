# Kandy & Hope's Marvel Card Vault (2026 Chrome & Neon)

A fun, interactive, collector-grade showcase website built for **Kandy** and **Hope** featuring all **180 verified cards** across 5 wall displays.

## Quick Start
1. Unzip this folder anywhere on your PC (or push directly to a GitHub Pages repo).
2. Double-click **`index.html`** to open it in Chrome, Edge, Safari, or Firefox—no server or build tools required!

## Project Folder Structure
```
kandy-and-hope-marvel-vault/
├── index.html                        # Open this file in your browser
├── css/styles.css                    # Bubble Pop + Dark Vault UI & 3D foil styles
├── js/data.js                        # All 180 verified cards, odds, sets & GBP values
├── js/app.js                         # Interactive gallery, wall view, modals & photo auto-swap
├── CARD_NAMING_GUIDE.csv             # Excel-ready checklist of all 180 exact filenames
├── assets/
│   ├── photos/
│   │   ├── kandy-and-hope.svg        # Placeholder hero badge
│   │   └── kandy-and-hope.jpg        # <-- Drop your photo of Kandy & Hope here!
│   └── cards/
│       ├── display-1-moon-girl/      # 36 cards (d1_r1c1_... to d1_r5c8_...)
│       ├── display-2-devil-dinosaur/ # 30 cards (d2_r1c1_... to d2_r5c3_...)
│       ├── display-3-chrome-hits/    # 35 cards (d3_r1c1_... to d3_r5c7_...)
│       ├── display-4-chrome-inserts/ # 40 cards (d4_top01_... to d4_r5c6_...)
│       └── display-5-neon-marvel/    # 39 cards (d5_r1c1_... to d5_r5c7_...)
```

## Replacing Temporary Cards with Your Real Photos
Every folder under `assets/cards/` already contains **temporary crystal-clear `.svg` replacement cards** named with the exact naming pattern:

`d<display>_r<row>c<col>_<character>_<parallel>_<serial>.jpg`

- Simply save your flat-cropped real card photo into the matching folder using the **same filename** with a **`.jpg`**, **`.png`**, or **`.webp`** extension (e.g. `d1_r1c1_moon-girl_black-clawed_06-10.jpg`).
- You do **not** need to edit any code or delete the `.svg` file—the website automatically looks for `.jpg` → `.jpeg` → `.png` → `.webp` first and falls back to the `.svg` placeholder if your real photo isn't there yet.
- You can also click **"📁 Load Card Photos Folder"** right inside the site (or open any card and click **"📸 Preview Real Photo Now"**) to test photos live!
