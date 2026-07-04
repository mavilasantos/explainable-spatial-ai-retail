### Overview

The DAQIQ WebGIS is a browser-based interactive map application that visualises café site-suitability scores across the Comune di Milano (all 9 Municipi) using H3 hexagonal grid cells at resolution 9. It is the delivery layer of the GeoAI thesis pipeline, presenting dual AHP (expert) and Random Forest (ML) suitability rankings alongside per-cell SHAP explainability profiles.

### Pipeline position

This WebGIS sits at the end of the thesis pipeline. It consumes two Gold-layer output files produced by the upstream Google Colab notebooks (NB8) and renders them in the browser as an interactive choropleth with filtering, ranking, and cell-level explainability panels. It requires no build step, no backend server for data processing, and no database — the entire application runs as three static files loading two JSON/GeoJSON data files via `fetch()`. A local HTTP server is required only to satisfy the browser's same-origin policy for `fetch()`.

### File structure

```
webgis/
├── index.html    — Entry point: DOM structure, Leaflet CDN, script load
├── app.js        — Application logic: map, filters, ranking, details, SHAP chart, methodology
├── styles.css    — All styling: design tokens, layout grid, responsive breakpoints
└── data/
    └── phase2/
        ├── gold_webgis_layer.geojson   — 971 H3 cells, 29 fields (scores, SHAP, geometry)
        └── gold_webgis_summary.json    — Project metadata, thresholds, colour ramp, model metrics
```

### Data requirements

The application expects two files at paths relative to `index.html`:

**`./data/phase2/gold_webgis_layer.geojson`** — GeoJSON FeatureCollection, EPSG:4326. Required fields: `h3_id`, `centroid_lat`, `centroid_lng`, `ahp_score`, `rf_probability`, `combined_score`, `suitability_tier`, `rank_diff`, `top3_factors`, `shap_base_value`, and all 13 `shap_*` columns. Optional fields used in Examiner view: `label`, `cafe_count`, `ahp_rank`, `rf_rank`, `is_validation_cell`.

**`./data/phase2/gold_webgis_summary.json`** — JSON object. Required keys: `cells` (total_viable, positive_label, negative_label, positive_rate), `suitability_tiers` (HIGH, MEDIUM, LOW, thresholds), `score_ranges` (ahp_score min/max), `colour_ramp` (stops, tier_colours), `features` (shap_columns), `model_performance` (rf_auc_validation, spearman_ahp_rf_cell_level, spearman_ahp_rf_pvalue). Optional: `study_area`, `phase`, `generated`, `methodology`.

### How to run

The application cannot be opened directly as a `file://` URL because `fetch()` requests are blocked by the browser's same-origin policy. Serve it through any local HTTP server:

```bash
cd webgis/
python -m http.server 8080
```

Then open `http://localhost:8080` in a browser. Any static HTTP server works (e.g. `npx serve`, `php -S localhost:8080`, VS Code Live Server).

### UI guide

**Topbar:** Shows the project phase, study area, cell count, and model AUC. Contains three controls: a colour-mode toggle (Combined Score vs Suitability Tier), an audience toggle (Entrepreneur View vs Thesis/Examiner View), and an About/Methodology button.

**Left sidebar — Search/Filter:** Filter the map by suitability tier (HIGH/MEDIUM/LOW checkboxes), minimum combined score (slider from 0 to 1), and choose how many top-ranked cells to list (5/10/20). Live counts of visible cells and divergence cases update as filters change.

**Left sidebar — Top Ranked Cells:** An ordered list of the highest-scoring cells. Click any item to select the cell and zoom the map to its location.

**Left sidebar — Legend:** Shows the active colour ramp (continuous gradient or categorical swatches), tier thresholds, explanations of each score type (AHP, RF, Combined, SHAP), and the AHP vs RF statistical agreement summary.

**Map:** Hexagonal cells coloured by score or tier. Click any cell to inspect it. Orange ⚠ markers flag cells where expert and model rankings disagree by more than 100 positions — these are thesis case-study material.

**Right sidebar — Cell Details:** After selecting a cell, shows: H3 ID and coordinates, suitability tier badge, separate AHP Score and RF Probability metric cards with bars, Combined Score card, divergence block (if applicable), top 3 SHAP driving factors, and a full 13-feature signed SHAP bar chart (blue = increases suitability, red = decreases). In Examiner View, also shows ground-truth label, café count, ranks, rank difference, and validation set status.

**Methodology modal:** A thesis transparency panel accessed via the "About / Methodology" button. Contains: academic framing, AHP weight configuration, RF validation metrics, AHP vs RF agreement analysis, viability threshold sensitivity table, AHP vs SHAP feature comparison table, and data source credits.

### External dependencies

| Library | Version | CDN URL | Purpose |
|---------|---------|---------|---------|
| Leaflet | 1.9.4 | `https://unpkg.com/leaflet@1.9.4/dist/leaflet.js` | Map rendering and interaction |
| Leaflet CSS | 1.9.4 | `https://unpkg.com/leaflet@1.9.4/dist/leaflet.css` | Map widget styles |
| CARTO Positron | — | `https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png` | Neutral grey base map tiles |
| Google Fonts | — | `fonts.googleapis.com` | DM Serif Display, DM Mono, Inter |

### Reproducing from pipeline

The two Gold input files (`gold_webgis_layer.geojson` and `gold_webgis_summary.json`) are produced by Notebook 8 (NB8) in the Colab pipeline; re-running NB8 regenerates both files.

### Thesis context

The study area is the Comune di Milano (all 9 Municipi), gridded at H3 resolution 9 (~0.1 km² per cell) into 971 viable cells, of which 345 are positive (≥ 2 cafés) and 626 negative. The Random Forest classifier achieves a validation AUC of 0.951. Each cell is scored independently by an expert-driven Analytic Hierarchy Process (AHP, 10 spatial features, 4 clusters) and a data-driven Random Forest trained on OSM café presence labels, with SHAP (SHapley Additive exPlanations) decomposing each RF prediction into 13 signed feature contributions; the combined score is a percentile-rank average of both methods, used for choropleth colouring and ranking while preserving the methodological separation that is the thesis's core academic contribution.
