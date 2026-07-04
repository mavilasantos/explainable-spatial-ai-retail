// =============================================================================
// DAQIQ WebGIS — app.js
// Politecnico di Milano · MSc Geoinformatics Engineering
// Explainable GeoAI for Urban Retail Site Selection
//
// Phase 2 — Comune di Milano scale (971 viable H3 cells, resolution 9)
//
// Key academic constraints enforced by this file:
//   • AHP score and RF probability always rendered as SEPARATE indicators
//   • SHAP values use SIGNED colour encoding (positive=blue, negative=red)
//   • rank_diff > 100 divergence marker is MANDATORY (Phase 3 Brief §4 — "academically mandatory")
//   • ground-truth label shown ONLY in Thesis/Examiner view
//   • All legend/colour config read from gold_webgis_summary.json at runtime
// =============================================================================

const APP_CONFIG = {
  phase: "phase2",
  data: {
    summary: "./data/phase2/gold_webgis_summary.json",
    layer:   "./data/phase2/gold_webgis_layer.geojson",
  },
  // Phase 3 Brief §4: "cells where rank_diff > 100 must display a visible ⚠ icon"
  // Phase 2 max divergence: |Δ| = 538 (cell 891f99cc107ffff, AHP rank 831 vs RF rank 293)
  mandatoryDivergenceThreshold: 100,
};

// ── Application state ────────────────────────────────────────────────────────
const state = {
  summary:           null,
  geojson:           null,
  features:          [],
  filteredFeatures:  [],
  shapColumns:       [],
  selectedFeatureId: null,
  colourMode:        "combined",    // "combined" | "tier"
  audienceView:      "entrepreneur",// "entrepreneur" | "examiner"
  minimumCombinedScore: 0,
  visibleTiers:      new Set(["HIGH", "MEDIUM", "LOW"]),
  rankingLimit:      10,
  map:               null,
  pathRenderer:      null,
  featureLayer:      null,
  divergenceLayer:   null,
  _hasFittedBounds:  false,
};

// ── DOM references ───────────────────────────────────────────────────────────
const dom = {
  datasetSummary:       document.getElementById("dataset-summary"),
  visibleCount:         document.getElementById("visible-count"),
  divergenceCount:      document.getElementById("divergence-count"),
  rankingList:          document.getElementById("ranking-list"),
  detailsPanel:         document.getElementById("details-panel"),
  legendPanel:          document.getElementById("legend-panel"),
  methodologyContent:   document.getElementById("methodology-content"),
  methodologyModal:     document.getElementById("methodology-modal"),
  scoreThreshold:       document.getElementById("score-threshold"),
  scoreThresholdValue:  document.getElementById("score-threshold-value"),
  rankingLimit:         document.getElementById("ranking-limit"),
  tierHigh:             document.getElementById("tier-high"),
  tierMedium:           document.getElementById("tier-medium"),
  tierLow:              document.getElementById("tier-low"),
  modeCombined:         document.getElementById("mode-combined"),
  modeTier:             document.getElementById("mode-tier"),
  viewEntrepreneur:     document.getElementById("view-entrepreneur"),
  viewExaminer:         document.getElementById("view-examiner"),
  openMethodology:      document.getElementById("open-methodology"),
  closeMethodology:     document.getElementById("close-methodology"),
};

document.addEventListener("DOMContentLoaded", init);

// ── Initialization ───────────────────────────────────────────────────────────
async function init() {
  bindControls();

  if (!window.L) {
    renderFatalError("Leaflet failed to load. Check your connection or use a local copy of Leaflet.");
    return;
  }

  initializeMap();

  try {
    const [summary, geojson] = await Promise.all([
      fetchJson(APP_CONFIG.data.summary),
      fetchJson(APP_CONFIG.data.layer),
    ]);

    state.summary  = summary;
    state.geojson  = geojson;
    state.features = geojson.features || [];
    state.shapColumns = resolveShapColumns();

    populateDatasetSummary();
    renderMethodology();
    applyFilters();
  } catch (error) {
    console.error(error);
    renderFatalError(
      "Could not load the Phase 2 GeoJSON or summary JSON. " +
      "Serve this folder through a local web server (e.g. python -m http.server) " +
      "rather than opening it with file://."
    );
  }
}

function bindControls() {
  dom.scoreThreshold.addEventListener("input", (e) => {
    state.minimumCombinedScore = Number(e.target.value);
    dom.scoreThresholdValue.textContent = state.minimumCombinedScore.toFixed(2);
    applyFilters();
  });

  dom.rankingLimit.addEventListener("change", (e) => {
    state.rankingLimit = Number(e.target.value);
    renderRanking();
  });

  dom.tierHigh.addEventListener("change",   () => toggleTier("HIGH",   dom.tierHigh.checked));
  dom.tierMedium.addEventListener("change", () => toggleTier("MEDIUM", dom.tierMedium.checked));
  dom.tierLow.addEventListener("change",    () => toggleTier("LOW",    dom.tierLow.checked));

  dom.modeCombined.addEventListener("click", () => setColourMode("combined"));
  dom.modeTier.addEventListener("click",     () => setColourMode("tier"));

  dom.viewEntrepreneur.addEventListener("click", () => setAudienceView("entrepreneur"));
  dom.viewExaminer.addEventListener("click",     () => setAudienceView("examiner"));

  dom.openMethodology.addEventListener("click",  () => toggleMethodology(true));
  dom.closeMethodology.addEventListener("click", () => toggleMethodology(false));
  dom.methodologyModal.addEventListener("click", (e) => {
    if (e.target.dataset.closeModal === "true") toggleMethodology(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") toggleMethodology(false);
  });
}

// ── Map initialization ───────────────────────────────────────────────────────
function initializeMap() {
  state.map = L.map("map", { zoomControl: false, preferCanvas: true });
  state.pathRenderer = L.canvas({ padding: 0.5 });

  L.control.zoom({ position: "topright" }).addTo(state.map);

  // CARTO Positron — neutral grey that does not compete with the choropleth
  L.tileLayer(
    "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
    {
      attribution:
        '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors ' +
        '&copy; <a href="https://carto.com/">CARTO</a>',
      maxZoom: 19,
    }
  ).addTo(state.map);

  state.featureLayer = L.geoJSON([], {
    style: styleFeature,
    onEachFeature: bindFeatureInteractions,
  }).addTo(state.map);

  state.divergenceLayer = L.layerGroup().addTo(state.map);
}

async function fetchJson(path) {
  const response = await fetch(path);
  if (!response.ok) throw new Error(`Failed to fetch ${path}: ${response.status}`);
  return response.json();
}

// ── Dataset summary header ───────────────────────────────────────────────────
function populateDatasetSummary() {
  const s         = state.summary;
  const cells     = s?.cells?.total_viable ?? state.features.length;
  // Phase 2 defaults: full Comune di Milano, all 9 municipios, 971 viable cells
  const studyArea = s?.study_area || "Comune di Milano (9 municipios)";
  const generated = s?.generated  || "";
  const phase     = s?.phase      || "Phase 2";
  const auc       = s?.model_performance?.rf_auc_validation;
  const aucStr    = Number.isFinite(Number(auc)) ? ` · RF AUC ${Number(auc).toFixed(4)}` : "";

  dom.datasetSummary.textContent =
    `${phase} · ${studyArea} · ${cells.toLocaleString()} H3 cells (res 9)` +
    `${aucStr} · Generated ${generated}`;
}

// ── Resolve SHAP column names from GeoJSON ──────────────────────────────────
// Phase 2 drops office_density and university_proximity from AHP,
// but BOTH remain in the RF/SHAP output. We read whatever shap_* columns
// are present in the feature — never hardcode the list.
function resolveShapColumns() {
  const firstFeature = state.features[0];
  if (!firstFeature) return [];

  // Prefer the ordered list from summary JSON (matches gold_ahp_vs_shap_comparison.csv order)
  const summaryColumns = state.summary?.features?.shap_columns || [];
  if (summaryColumns.length > 0) {
    const available = new Set(Object.keys(firstFeature.properties));
    const resolved  = summaryColumns.filter((col) => available.has(col));
    if (resolved.length > 0) return resolved;
  }

  // Fallback: any shap_* property on the first feature
  return Object.keys(firstFeature.properties).filter((k) => k.startsWith("shap_"));
}

// ── Filter application ───────────────────────────────────────────────────────
function toggleTier(tier, enabled) {
  if (enabled) state.visibleTiers.add(tier);
  else         state.visibleTiers.delete(tier);
  applyFilters();
}

function setColourMode(mode) {
  state.colourMode = mode;
  dom.modeCombined.classList.toggle("is-active", mode === "combined");
  dom.modeTier.classList.toggle("is-active",     mode === "tier");
  redrawFeatures();
  renderLegend();
}

function setAudienceView(view) {
  state.audienceView = view;
  dom.viewEntrepreneur.classList.toggle("is-active", view === "entrepreneur");
  dom.viewExaminer.classList.toggle("is-active",     view === "examiner");
  renderDetails(getSelectedFeature());
}

function applyFilters() {
  state.filteredFeatures = state.features.filter((f) => {
    const p        = f.properties;
    const combined = Number(p.combined_score || 0);
    return state.visibleTiers.has(p.suitability_tier) &&
           combined >= state.minimumCombinedScore;
  });

  // Deselect if the selected cell was filtered out
  if (!state.filteredFeatures.some((f) => f.properties.h3_id === state.selectedFeatureId)) {
    state.selectedFeatureId = null;
  }

  redrawFeatures();
  renderLegend();
  renderRanking();
  renderDetails(getSelectedFeature());
  updateCounts();
}

// ── Map rendering ────────────────────────────────────────────────────────────
function redrawFeatures() {
  state.featureLayer.clearLayers();
  state.divergenceLayer.clearLayers();

  state.featureLayer.addData({
    type: "FeatureCollection",
    features: state.filteredFeatures,
  });

  // Mandatory divergence markers (Phase 3 Brief §4, academic requirement)
  // Uses Math.abs() because rank_diff may be signed (AHP_rank − RF_rank);
  // a cell where AHP ranks higher (negative diff) is equally divergent.
  state.filteredFeatures.forEach((f) => {
    const p = f.properties;
    if (Math.abs(Number(p.rank_diff || 0)) > APP_CONFIG.mandatoryDivergenceThreshold) {
      const marker = L.marker(
        [Number(p.centroid_lat), Number(p.centroid_lng)],
        {
          icon: L.divIcon({
            className: "",
            html: '<div class="divergence-icon" aria-hidden="true">&#9888;</div>',
            iconSize: [24, 24],
            iconAnchor: [12, 12],
          }),
          zIndexOffset: 400,
        }
      );
      marker.bindTooltip(
        `Expert–model disagreement · |Δrank| = ${Math.abs(Number(p.rank_diff))} · Click for SHAP details`,
        { direction: "top", offset: [0, -14] }
      );
      marker.on("click", () => selectFeature(f, true));
      state.divergenceLayer.addLayer(marker);
    }
  });

  if (state.filteredFeatures.length > 0) {
    const bounds = state.featureLayer.getBounds();
    if (bounds.isValid() && !state._hasFittedBounds) {
      state.map.fitBounds(bounds); // Remove the padding for a tighter initial fit
      
      // Force the map one integer zoom level closer after a tiny delay for visual smoothness
      setTimeout(() => {
        state.map.zoomIn(1);
      }, 150);
      
      state._hasFittedBounds = true;
    }
  }
}

function bindFeatureInteractions(feature, layer) {
  layer.on({
    click:     () => selectFeature(feature),
    mouseover: () => layer.setStyle(hoverStyle(feature)),
    mouseout:  () => state.featureLayer.resetStyle(layer),
  });
}

function selectFeature(feature, zoomToFeature = false) {
  state.selectedFeatureId = feature.properties.h3_id;
  redrawFeatures();
  renderDetails(feature);
  if (zoomToFeature) {
    const bounds = L.geoJSON(feature).getBounds();
    if (bounds.isValid()) state.map.fitBounds(bounds.pad(1.4));
  }
}

function getSelectedFeature() {
  return state.filteredFeatures.find(
    (f) => f.properties.h3_id === state.selectedFeatureId
  ) || null;
}

// ── Feature styles ───────────────────────────────────────────────────────────
function styleFeature(feature) {
  const p          = feature.properties;
  const isSelected = p.h3_id === state.selectedFeatureId;
  const fillColor  = state.colourMode === "tier"
    ? getTierColor(p.suitability_tier)
    : getContinuousColor(Number(p.combined_score || 0));

  return {
    renderer:    state.pathRenderer,
    fillColor,
    fillOpacity: isSelected ? 0.90 : 0.72,
    color:       isSelected ? "#111820" : "#cccccc",
    weight:      isSelected ? 2.0 : 0.8,
    opacity:     isSelected ? 1.0 : 0.35,
  };
}

function hoverStyle(feature) {
  const base = styleFeature(feature);
  return {
    ...base,
    weight:      Math.max(base.weight, 1.4),
    opacity:     0.85,
    fillOpacity: Math.min(base.fillOpacity + 0.10, 0.94),
  };
}

// ── Colour functions ─────────────────────────────────────────────────────────
function getTierColor(tier) {
  return state.summary?.colour_ramp?.tier_colours?.[tier] || "#aaaaaa";
}

function getContinuousColor(value) {
  const stops = state.summary?.colour_ramp?.stops;
  if (!Array.isArray(stops) || stops.length === 0) return "#aaaaaa";

  const clamped = Math.max(0, Math.min(1, value));
  if (clamped <= stops[0][0]) return stops[0][1];

  for (let i = 0; i < stops.length - 1; i++) {
    const [s0, c0] = stops[i];
    const [s1, c1] = stops[i + 1];
    if (clamped >= s0 && clamped <= s1) {
      const ratio = (clamped - s0) / (s1 - s0 || 1);
      return interpolateColor(c0, c1, ratio);
    }
  }
  return stops[stops.length - 1][1];
}

function interpolateColor(c0, c1, ratio) {
  const a = hexToRgb(c0);
  const b = hexToRgb(c1);
  const lerp = (x, y) => Math.round(x + (y - x) * ratio);
  return `rgb(${lerp(a.r, b.r)}, ${lerp(a.g, b.g)}, ${lerp(a.b, b.b)})`;
}

function hexToRgb(hex) {
  const n = parseInt(hex.replace("#", ""), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

// ── Counts ───────────────────────────────────────────────────────────────────
function updateCounts() {
  dom.visibleCount.textContent = state.filteredFeatures.length.toLocaleString();
  dom.divergenceCount.textContent = state.filteredFeatures
    .filter((f) => Math.abs(Number(f.properties.rank_diff || 0)) > APP_CONFIG.mandatoryDivergenceThreshold)
    .length
    .toLocaleString();
}

// ── Ranking sidebar ──────────────────────────────────────────────────────────
function renderRanking() {
  const items = [...state.filteredFeatures]
    .sort((a, b) => Number(b.properties.combined_score) - Number(a.properties.combined_score))
    .slice(0, state.rankingLimit);

  dom.rankingList.innerHTML = "";

  if (items.length === 0) {
    dom.rankingList.innerHTML = `<li class="helper-text" style="padding:8px 0">No cells match the current filters.</li>`;
    return;
  }

  items.forEach((f, idx) => {
    const p    = f.properties;
    const tier = (p.suitability_tier || "").toLowerCase();
    const isDivergent = Math.abs(Number(p.rank_diff || 0)) > APP_CONFIG.mandatoryDivergenceThreshold;

    const li = document.createElement("li");
    li.innerHTML = `
      <button class="ranking-item" type="button" aria-label="Select cell ${p.h3_id}">
        <div class="ranking-head">
          <span class="ranking-id">#${idx + 1} · ${p.h3_id}</span>
          <span class="badge ${tier}">${p.suitability_tier}</span>
        </div>
        <div class="ranking-scores">
          Combined ${fmt4(p.combined_score)}
          &nbsp;·&nbsp; AHP ${fmt4(p.ahp_score)}
          &nbsp;·&nbsp; RF ${fmt4(p.rf_probability)}
          ${isDivergent ? ' &nbsp;⚠' : ''}
        </div>
      </button>
    `;
    li.querySelector("button").addEventListener("click", () => selectFeature(f, true));
    dom.rankingList.appendChild(li);
  });
}

// ── Legend ───────────────────────────────────────────────────────────────────
function renderLegend() {
  if (!state.summary) { dom.legendPanel.innerHTML = ""; return; }

  const tierEntries = getTierEntries();
  const stops       = state.summary.colour_ramp?.stops || [];
  const gradient    = stops.map(([v, c]) => `${c} ${v * 100}%`).join(", ");
  // Always show the true combined_score scale [0, 1] — not the last colour-stop value.
  // The JSON colour ramp stops at 0.65 for visual anchoring, but combined_score is
  // uniformly distributed in [0,1] (gold_webgis_summary.json → colour_ramp.note).
  const scaleMin    = "0.00";
  const scaleMax    = "1.00";

  const thresholdEntries = Object.entries(
    state.summary.suitability_tiers?.thresholds || {}
  ).filter(([k, v]) => !["logic", "informational_only"].includes(k) && typeof v === "number");

  const tierRows = tierEntries.map((t) => `
    <div class="tier-row">
      <span class="tier-swatch" style="background:${t.color}"></span>
      <span>${t.name}</span>
      <strong>${Number(t.count || 0).toLocaleString()}</strong>
    </div>
  `).join("");

  const thresholdRows = thresholdEntries.length > 0
    ? thresholdEntries.map(([k, v]) => `
        <div class="tier-row" style="font-family:var(--font-mono);font-size:0.76rem">
          <span class="tier-swatch" style="background:transparent;border:1px solid var(--line)"></span>
          <span>${normalizeText(k.replaceAll("_", " "))}</span>
          <span>${fmt4(v)}</span>
        </div>
      `).join("")
    : `<div class="legend-copy">Thresholds loaded from summary JSON.</div>`;

  // Feature-level rho: not in summary JSON — hardcode Phase 2 value (NB7).
  // Cell-level rho: from model_performance in summary JSON.
  const cellRho    = fmtNullable(state.summary.model_performance?.spearman_ahp_rf_cell_level, 4);
  const FEATURE_LEVEL_RHO = "-0.4073"; // Phase 2 NB7, fixed — not exported to summary JSON

  dom.legendPanel.innerHTML = `
    <div>
      <div class="section-title">${state.colourMode === "combined" ? "Combined Score" : "Suitability Tier"}</div>
      ${state.colourMode === "combined" ? `
        <div class="legend-ramp" style="background:linear-gradient(90deg,${gradient})"></div>
        <div class="legend-scale"><span>Low (${scaleMin})</span><span>High (${scaleMax})</span></div>
      ` : tierRows}
    </div>

    ${state.colourMode === "tier" ? "" : `<div>${tierRows}</div>`}

    <div>
      <div class="section-title">Tier thresholds (combined_score)</div>
      ${thresholdRows}
      <div class="legend-copy" style="margin-top:5px">${normalizeText(state.summary.suitability_tiers?.thresholds?.logic || "")}</div>
    </div>

    <div class="legend-copy">
      <strong>AHP score</strong> — expert multi-criteria judgment (Analytic Hierarchy Process).
      Independent of the machine-learning model.
    </div>
    <div class="legend-copy">
      <strong>RF probability</strong> — data-driven score from Random Forest trained on OSM café presence.
      SHAP decomposes this prediction per cell.
    </div>
    <div class="legend-copy">
      <strong>Combined score</strong> — percentile-rank average of AHP and RF.
      Used for choropleth colouring and ranking only.
    </div>
    <div class="legend-copy">
      <strong>SHAP</strong> — positive values (blue) push the RF probability up;
      negative values (red) push it down from the base rate
      (Phase 2 base: ${fmt4(state.summary?.shap_base_value ?? state.summary?.model_performance?.shap_base_value ?? 0.5222)}).
    </div>

    <div class="legend-agreement-box">
      AHP vs RF agreement (Phase 2)<br>
      Cell-level ρ = <strong>${cellRho}</strong> &nbsp;·&nbsp;
      Feature-level ρ = <strong>${FEATURE_LEVEL_RHO}</strong><br>
      <span style="font-size:0.73rem;opacity:0.85">
        Cell-level (ρ = ${cellRho}, p = ${fmtNullable(state.summary.model_performance?.spearman_ahp_rf_pvalue, 4, "0.0000")}):
        observed agreement does not exceed
        the permutation null 95th percentile (ρ₉₅ = 0.8534, n = 10,000, empirical p = 0.6441) —
        attributable to shared spatial autocorrelation; not independent methodological convergence.<br>
        Feature-level (ρ = ${FEATURE_LEVEL_RHO}, permutation p = 0.2412, null interval [−0.6322, 0.6383]):
        null result — single-analyst AHP weight vector and SHAP importance ranking are
        statistically indistinguishable from uncorrelated. Negative sign is not evidence of
        systematic inversion. Study is underpowered at n=10 features to detect moderate agreement.
      </span>
    </div>
  `;
}

function getTierEntries() {
  const counts  = state.summary?.suitability_tiers || {};
  const colours = state.summary?.colour_ramp?.tier_colours || {};
  const names   = Object.keys(colours).length > 0
    ? Object.keys(colours)
    : Object.keys(counts).filter((k) => typeof counts[k] === "number");

  return names.map((name) => ({
    name,
    color: colours[name] || "#cccccc",
    count: counts[name]  || 0,
  }));
}

// ── Cell details panel ───────────────────────────────────────────────────────
function renderDetails(feature) {
  if (!feature) {
    dom.detailsPanel.innerHTML = `
      <div class="empty-state">
        <h3>No cell selected</h3>
        <p>Click a hexagon on the map or a ranking item to inspect its AHP score,
           RF probability, and SHAP factor breakdown.</p>
      </div>
    `;
    return;
  }

  const p          = feature.properties;
  const tier       = p.suitability_tier || "LOW";
  const tierClass  = tier.toLowerCase();
  const topFactors = parseTopFactors(p.top3_factors);

  const ahpRange    = state.summary?.score_ranges?.ahp_score || { min: 0, max: 1 };
  const ahpWidth    = normalizeRange(p.ahp_score,      ahpRange.min, ahpRange.max);
  const rfWidth     = normalizeRange(p.rf_probability, 0, 1);
  const combWidth   = normalizeRange(p.combined_score, 0, 1);

  const isDivergent = Math.abs(Number(p.rank_diff || 0)) > APP_CONFIG.mandatoryDivergenceThreshold;

  dom.detailsPanel.innerHTML = `

    <!-- ── Cell identity ── -->
    <div class="cell-header">
      <div>
        <div class="cell-h3-id">${p.h3_id}</div>
        <div class="cell-coords">
          ${fmt5(p.centroid_lat)}, ${fmt5(p.centroid_lng)}
        </div>
      </div>
      <div class="badge-row">
        <span class="badge ${tierClass}">${tier}</span>
        ${isDivergent ? '<span class="badge divergence">⚠ Divergence</span>' : ""}
      </div>
    </div>

    <!-- ── AHP / RF / Combined — always separate (thesis requirement) ── -->
    <div class="metric-grid">
      <article class="metric-card">
        <div class="metric-row">
          <span>AHP Score</span>
          <strong>${fmt4(p.ahp_score)}</strong>
        </div>
        <div class="metric-bar ahp"><span style="width:${ahpWidth}%"></span></div>
        <div class="metric-helper">Expert multi-criteria (MCDM) judgment.</div>
      </article>

      <article class="metric-card">
        <div class="metric-row">
          <span>RF Probability</span>
          <strong>${fmt4(p.rf_probability)}</strong>
        </div>
        <div class="metric-bar rf"><span style="width:${rfWidth}%"></span></div>
        <div class="metric-helper">Data-driven ML score.</div>
      </article>

      <article class="metric-card full-span">
        <div class="metric-row">
          <span>Combined Score</span>
          <strong>${fmt4(p.combined_score)}</strong>
        </div>
        <div class="metric-bar combined"><span style="width:${combWidth}%"></span></div>
        <div class="metric-helper">
          Percentile-rank synthesis used for choropleth and ranking.
          AHP rank: <strong>${p.ahp_rank ?? "–"}</strong> &nbsp;·&nbsp;
          RF rank: <strong>${p.rf_rank ?? "–"}</strong>
        </div>
      </article>
    </div>

    <!-- ── Divergence detail block (only when applicable) ── -->
    ${isDivergent ? renderDivergenceBlock(p) : ""}

    <!-- ── Top 3 factors ── -->
    <div>
      <div class="section-title">Top 3 drivers (RF SHAP)</div>
      <div class="factor-list">
        ${topFactors.map((f) => `
          <span class="factor-chip ${f.direction}">
            <span>${f.symbol}</span>
            <span>${f.label}</span>
          </span>
        `).join("")}
      </div>
    </div>

    <!-- ── SHAP waterfall chart ── -->
    <div class="chart-wrap">
      <div class="chart-title-row">
        <strong>SHAP Feature Contributions</strong>
        <span class="chart-axis-label">Impact on RF probability</span>
      </div>
      <div class="shap-key">
        <div class="shap-key-item">
          <span class="shap-key-swatch pos"></span>
          <span>Increases suitability</span>
        </div>
        <div class="shap-key-item">
          <span class="shap-key-swatch neg"></span>
          <span>Decreases suitability</span>
        </div>
      </div>
      <div id="shap-chart" class="shap-list"></div>
      ${renderShapAdditivityNote(p)}
      <div class="shap-chart-note">
        Base RF probability: <span style="font-family:var(--font-mono)">
        ${fmt4(p.shap_base_value ?? state.summary?.shap_base_value ?? state.summary?.model_performance?.shap_base_value ?? 0.5222)}</span>
        (Phase 2: 0.5222 — exceeds natural positive class rate
        ${((state.summary?.cells?.positive_rate ?? 0.3512) * 100).toFixed(2)}% because
        the RF was trained on a balanced 50/50 sample; reflects training
        distribution, not population prevalence).
        Sum of all SHAP values + base ≈ RF probability.
      </div>
    </div>

    <!-- ── Thesis/Examiner view (label hidden in Entrepreneur view) ── -->
    ${state.audienceView === "examiner" ? renderExaminerBlock(p) : ""}
  `;

  renderShapChart(feature);
}

function renderDivergenceBlock(p) {
  return `
    <div class="divergence-block">
      <div class="divergence-block-head">⚠ Expert–Model Disagreement</div>
      <div class="divergence-rank-row">
        <div class="divergence-rank-cell">
          <div class="rank-label">AHP Rank</div>
          <div class="rank-val">#${p.ahp_rank ?? "–"}</div>
        </div>
        <div class="divergence-rank-sep">vs</div>
        <div class="divergence-rank-cell">
          <div class="rank-label">RF Rank</div>
          <div class="rank-val">#${p.rf_rank ?? "–"}</div>
        </div>
      </div>
      <div class="divergence-interp">
        |Δ| = ${Math.abs(Number(p.rank_diff))} · The expert model and the Random Forest disagree on
        this location's relative suitability. This cell is thesis case-study material:
        use the SHAP breakdown below to identify which features drive the disagreement.
      </div>
    </div>
  `;
}

function renderExaminerBlock(p) {
  const validationNote = getValidationNote(p);
  return `
    <div class="examiner-section">
      <div class="examiner-section-head">Thesis / Examiner Fields</div>
      <div class="examiner-grid">
        <div class="examiner-cell">
          <span class="status-label">Ground Truth Label</span>
          <strong>${p.label ?? "–"}</strong>
        </div>
        <div class="examiner-cell">
          <span class="status-label">Café Count (OSM)</span>
          <strong>${p.cafe_count ?? "–"}</strong>
        </div>
        <div class="examiner-cell">
          <span class="status-label">AHP Rank</span>
          <strong>${p.ahp_rank ?? "–"}</strong>
        </div>
        <div class="examiner-cell">
          <span class="status-label">RF Rank</span>
          <strong>${p.rf_rank ?? "–"}</strong>
        </div>
        <div class="examiner-cell">
          <span class="status-label">|Δ Rank|</span>
          <strong>${p.rank_diff ?? "–"}</strong>
        </div>
        <div class="examiner-cell">
          <span class="status-label">Validation Note</span>
          <strong style="font-size:0.78rem">${validationNote}</strong>
        </div>
      </div>
    </div>
  `;
}

// ── SHAP bar chart ────────────────────────────────────────────────────────────
// Bars are SIGNED (positive=blue right, negative=red left) — thesis requirement.
// Phase 3 Brief: "Do NOT display absolute SHAP values in the popup. The sign matters."
function renderShapChart(feature) {
  const container = document.getElementById("shap-chart");
  if (!container) return;

  const p      = feature.properties;
  const values = state.shapColumns.map((col) => Number(p[col] || 0));
  const maxAbs = Math.max(...values.map(Math.abs), 1e-9);

  // Sort by absolute value descending for readability
  const sorted = state.shapColumns
    .map((col, i) => ({ col, val: values[i] }))
    .sort((a, b) => Math.abs(b.val) - Math.abs(a.val));

  container.innerHTML = sorted.map(({ col, val }) => {
    const pct       = (Math.abs(val) / maxAbs) * 50; // 50% = max half of track
    const direction = val >= 0 ? "positive" : "negative";
    const sign      = val >= 0 ? "+" : "";
    return `
      <div class="shap-row">
        <div class="shap-label" title="${prettifyFeatureName(col)}">
          ${prettifyFeatureName(col)}
        </div>
        <div class="shap-track" title="${prettifyFeatureName(col)}: ${sign}${fmt4(val)}">
          <span class="shap-bar ${direction}" style="width:${pct}%"></span>
        </div>
        <div class="shap-value" style="color:var(${val >= 0 ? '--shap-pos' : '--shap-neg'})">
          ${sign}${fmt4(val)}
        </div>
      </div>
    `;
  }).join("");
}

// Shows the SHAP additivity note only if base value is available
function renderShapAdditivityNote(p) {
  // Use per-cell value first, then summary JSON, then the canonical Phase 2 constant.
  // Without this fallback the additivity check silently disappears when shap_base_value
  // is absent from both the cell properties and the summary JSON.
  const SHAP_BASE_PHASE2 = 0.5222;
  const base = Number(
    p.shap_base_value ??
    state.summary?.shap_base_value ??
    state.summary?.model_performance?.shap_base_value ??
    SHAP_BASE_PHASE2
  );
  if (!Number.isFinite(base)) return "";

  const shapSum = state.shapColumns
    .reduce((acc, col) => acc + Number(p[col] || 0), 0);
  const reconstructed = base + shapSum;
  const error = Math.abs(reconstructed - Number(p.rf_probability || 0));
  const errorClass = error < 0.01 ? "✓" : "⚠";

  return `
    <div class="shap-additivity-note">
      SHAP additivity check:
      base (${fmt4(base)}) + Σ SHAP (${fmt4(shapSum)}) = ${fmt4(reconstructed)}
      vs RF probability (${fmt4(p.rf_probability)}) · max error &lt; 0.01 ${errorClass}
    </div>
  `;
}

// ── Methodology panel ─────────────────────────────────────────────────────────
// Phase 2 correction: references "10 AHP features" not 12 (office_density and
// university_proximity dropped from AHP cluster per master_handover_revised_v3.md §Appendix).
function renderMethodology() {
  if (!state.summary) {
    dom.methodologyContent.innerHTML = `
      <section class="card">
        <div class="card-header">
          <h2>About / Methodology</h2>
          <p>Loading methodology metadata…</p>
        </div>
      </section>
    `;
    return;
  }

  const m           = state.summary.methodology || {};
  const rfM         = m.rf      || {};
  const dataCredits = Array.isArray(m.data_credits) ? m.data_credits : [];

  // Pre-calculate AUC delta for the ablation row
  const valAuc = rfM.validation_auc_reported ?? state.summary?.model_performance?.rf_auc_validation;
  const ablationAuc = state.summary?.model_performance?.rf_auc_no_local_cafe_density;
  const aucDelta = (valAuc && ablationAuc) ? (ablationAuc - valAuc) : null;
  const aucDeltaStr = aucDelta !== null ? `(Δ = ${aucDelta < 0 ? '−' : '+'}${Math.abs(aucDelta).toFixed(4)})` : "";

  // Phase 2 canonical SHAP base value (NB7 — RF trained on balanced 50/50 sample).
  // Not exported to gold_webgis_summary.json; hardcoded here as the single authoritative
  // constant for this delivery. If a future export adds shap_base_value to the JSON,
  // the JSON value takes precedence via the ?? chain below.
  const SHAP_BASE_VALUE_PHASE2 = 0.5222;
  const shapBaseValue =
    state.summary?.shap_base_value ??
    state.summary?.model_performance?.shap_base_value ??
    SHAP_BASE_VALUE_PHASE2;

  // AHP cluster weights — read from gold_webgis_summary.json (features.ahp_clusters).
  // The JSON carries cluster-level weights and feature lists (Phase 2 canonical values,
  // eigenvector-derived, CR = 0.0175). Sub-weights and effective weights are not exported
  // to the summary JSON and remain as a hardcoded fallback map below.
  //
  // Resolution order:
  //   1. summary JSON  →  features.ahp_clusters  (cluster weight + feature list)
  //   2. FALLBACK_AHP_CLUSTERS  →  used only if the JSON key is absent or empty
  //
  // Sub-weights (Level-2 expert assignments) and effective weights are enriched from
  // FALLBACK_AHP_CLUSTERS regardless of source, because they are not in the JSON.

  const FALLBACK_AHP_CLUSTERS = [
    {
      name: "Accessibility",
      weight: "37.6%",
      features: [
        { name: "Metro Access",          sub: "0.25", eff: "9.4%" },
        { name: "Bus/Tram Density",      sub: "0.40", eff: "15.0%" },
        { name: "Network Centrality",    sub: "0.35", eff: "13.2%" },
      ],
    },
    {
      name: "Demand Potential",
      weight: "30.0%",
      features: [
        { name: "Population Density",    sub: "0.45", eff: "13.5%" },
        { name: "Night Light",           sub: "0.55", eff: "16.5%" },
      ],
      note: "office_density and university_proximity excluded from AHP (RF-only features)",
    },
    {
      name: "Urban Context",
      weight: "25.3%",
      features: [
        { name: "Retail Density",        sub: "0.30", eff: "7.6%" },
        { name: "POI Diversity",         sub: "0.25", eff: "6.3%" },
        { name: "Pedestrian Street",     sub: "0.25", eff: "6.3%" },
        { name: "Tourist POIs",          sub: "0.20", eff: "5.1%" },
      ],
    },
    {
      name: "Competition",
      weight: "7.0%",
      features: [
        { name: "Market Opportunity (competitor saturation inv.)", sub: "1.00", eff: "7.0%" },
      ],
      note: "local_cafe_density excluded from AHP (RF-only feature)",
    },
  ];

  // Sub-weight / effective-weight lookup keyed by feature name — enriches JSON-sourced clusters.
  const AHP_SUB_WEIGHTS = {
    "Metro Access":          { sub: "0.25", eff: "9.4%"  },
    "Bus/Tram Density":      { sub: "0.40", eff: "15.0%" },
    "Network Centrality":    { sub: "0.35", eff: "13.2%" },
    "Population Density":    { sub: "0.45", eff: "13.5%" },
    "Night Light":           { sub: "0.55", eff: "16.5%" },
    "Retail Density":        { sub: "0.30", eff: "7.6%"  },
    "POI Diversity":         { sub: "0.25", eff: "6.3%"  },
    "Pedestrian Street":     { sub: "0.25", eff: "6.3%"  },
    "Tourist POIs":          { sub: "0.20", eff: "5.1%"  },
    "Market Opportunity":    { sub: "1.00", eff: "7.0%"  },
  };

  // Build PHASE2_AHP_CLUSTERS: prefer JSON, fall back to hardcoded constant.
  const jsonAhpClusters = state.summary?.features?.ahp_clusters;
  const PHASE2_AHP_CLUSTERS = (jsonAhpClusters && Object.keys(jsonAhpClusters).length > 0)
    ? Object.entries(jsonAhpClusters).map(([clusterName, clusterData]) => {
        const weightPct = `${(Number(clusterData.weight) * 100).toFixed(1)}%`;
        const features  = (clusterData.features || []).map((featureName) => {
          const sw = AHP_SUB_WEIGHTS[featureName] || { sub: "—", eff: "—" };
          return { name: featureName, sub: sw.sub, eff: sw.eff };
        });
        // Preserve cluster-level notes from the fallback where applicable
        const fallbackCluster = FALLBACK_AHP_CLUSTERS.find(
          (fc) => fc.name.toLowerCase() === clusterName.toLowerCase()
        );
        return {
          name:     clusterName,
          weight:   weightPct,
          features,
          note:     fallbackCluster?.note,
        };
      })
    : FALLBACK_AHP_CLUSTERS;

  const ahpFeatureCount = PHASE2_AHP_CLUSTERS.reduce((n, c) => n + c.features.length, 0);
  // Verify: must equal 10 for Phase 2
  // Accessibility(3) + Demand(2) + Urban(4) + Competition(1) = 10 ✓

  const clusterRows = PHASE2_AHP_CLUSTERS.map((c) => `
    <tr>
      <td>
        <strong>${c.name}</strong>
        ${c.note ? `<br><em style="font-size:0.72rem;color:var(--muted)">${c.note}</em>` : ""}
      </td>
      <td style="font-family:var(--font-mono)">${c.weight}</td>
      <td>
        ${c.features.map((f) =>
          `${f.name} <span style="font-family:var(--font-mono);font-size:0.75rem;color:var(--muted)">(sub ${f.sub} · eff ${f.eff})</span>`
        ).join("<br>")}
      </td>
    </tr>
  `).join("");

dom.methodologyContent.innerHTML = `

    <section class="card">
      <div class="card-header">
        <h2>Academic framing</h2>
        <p>Thesis transparency panel — for committee review.</p>
      </div>
      <p class="helper-text">
        This interface is a spatial analysis communication tool for thesis review.
        Methodological transparency and reproducibility take priority over
        product-style abstraction. AHP scores, RF probabilities, and SHAP
        explanations are visibly separated throughout so the committee can audit
        agreement and disagreement between the two independent ranking logics.
        The combined score is a synthesis layer only — not a replacement for the two methods.
      </p>
      <p class="helper-text" style="margin-top:8px">
        <strong>Unified null conclusion (Phase 2):</strong>
        Cell-level Spearman ρ = ${fmtNullable(state.summary.model_performance?.spearman_ahp_rf_cell_level, 4)}
        (p = ${fmtNullable(state.summary.model_performance?.spearman_ahp_rf_pvalue, 4, "0.0000")}, n=316 validation cells) is consistent with, but does not exceed,
        the permutation null 95th percentile (ρ₉₅ = 0.8534, n=10,000 permutations,
        empirical p = 0.6441) — this agreement is attributable to shared spatial
        autocorrelation in the feature set rather than independent methodological convergence.
        Feature-level ρ = −0.4073
        (permutation p = 0.2412, null interval [−0.6322, 0.6383], n=10,000) is a null result:
        the single-analyst AHP weight vector and SHAP importance ranking are statistically
        indistinguishable from uncorrelated. Note: the study is underpowered at n=10 features
        to detect moderate agreement (ρ ≈ 0.5–0.6); the null result is a finding about the
        limits of this comparison methodology. Both comparisons yield null or near-null results —
        the thesis does not claim independent alignment at either level of analysis.
      </p>
      <p class="helper-text" style="margin-top:8px">
        <strong>Scope of the audit:</strong>
        SHAP importances are not a direct measure of commercial viability — they
        reflect what a specific RF model learned from OSM café presence labels.
        OSM contributor density in Milan likely correlates with the same walkable,
        commercially vibrant zones the model scores highly, introducing a potential
        circularity: the empirical layer may partly reflect the OSM contributor
        distribution rather than commercial viability. The audit therefore compares
        a single-analyst AHP prior against a model-mediated, label-dependent
        construct — not against an objective ground truth.
      </p>
    </section>

    <section class="method-grid">
      <article class="table-card">
        <div class="card-header">
          <h2>AHP Configuration — Phase 2</h2>
          <p>${ahpFeatureCount}-feature expert model (local_cafe_density, office_density, &amp; university_proximity excluded from AHP; retained as RF-only).</p>
        </div>
        <table>
          <thead><tr><th>Cluster (global weight)</th><th>Global&nbsp;%</th><th>Features · sub-weight · eff. weight</th></tr></thead>
          <tbody>${clusterRows}</tbody>
          <tfoot><tr><td colspan="3">
            Phase 2 design: <code>local_cafe_density</code>, <code>office_density</code> and
            <code>university_proximity</code> excluded from AHP on theoretical and
            data-quality grounds (block-level ISTAT 2021 population density subsumes
            the office/residential demand signal; campus proximity is retained as an
            RF-only feature; local_cafe_density excluded due to label proximity). All three features appear in RF/SHAP output and represent 35.6% of the sum of mean absolute SHAP values (NB7).
          </td></tr></tfoot>
        </table>
        <p class="table-note">
          AHP Consistency Ratio (CR): 0.0175
          &nbsp;·&nbsp; CR &lt; 0.10 → Level-1 judgment matrix accepted.
          Level-2 sub-weights are directly assigned expert weights (not eigenvector-derived).
          Cluster weights above are eigenvector-derived from the Phase 2 4×4 pairwise matrix.
        </p>
      </article>

      <article class="table-card">
        <div class="card-header">
          <h2>Random Forest — Phase 2 Validation</h2>
          <p>Full Comune di Milano scale (971 viable cells).</p>
        </div>
        <table>
          <tbody>
            <tr>
              <th>Validation AUC</th>
              <td style="font-family:var(--font-mono)">${fmtNullable(valAuc, 4)}</td>
            </tr>
            <tr>
              <th>Ablation AUC (no Café Density)</th>
              <td style="font-family:var(--font-mono)">
                ${fmtNullable(ablationAuc, 4)} <span style="color:var(--muted)">${aucDeltaStr}</span>
                <span style="display:block;font-family:var(--font-body);font-size:0.75rem;color:var(--muted);margin-top:2px;">
                  Model without local_cafe_density; normatively relevant for new market entrants.<br>
                  Makes the agglomeration-saturation indeterminacy argument visible.
                </span>
              </td>
            </tr>
            <tr>
              <th>Validation Precision</th>
              <td style="font-family:var(--font-mono)">${fmtNullable(state.summary.model_performance?.val_precision, 4)}</td>
            </tr>
            <tr>
              <th>Validation Recall</th>
              <td style="font-family:var(--font-mono)">${fmtNullable(state.summary.model_performance?.val_recall, 4)}</td>
            </tr>
            <tr>
              <th>Val TP / TN / FP / FN</th>
              <td style="font-family:var(--font-mono)">
                ${state.summary.model_performance?.val_tp ?? "—"} /
                ${state.summary.model_performance?.val_tn ?? "—"} /
                ${state.summary.model_performance?.val_fp ?? "—"} /
                ${state.summary.model_performance?.val_fn ?? "—"}
              </td>
            </tr>
            <tr>
              <th>CV mean AUC</th>
              <td style="font-family:var(--font-mono)">${fmtNullable(state.summary.model_performance?.rf_cv_auc_mean, 4)}</td>
            </tr>
            <tr>
              <th>CV std AUC</th>
              <td style="font-family:var(--font-mono)">${fmtNullable(state.summary.model_performance?.rf_cv_auc_std, 4)}</td>
            </tr>
            <tr>
              <th>SHAP base value</th>
              <td style="font-family:var(--font-mono)">${fmt4(shapBaseValue)}</td>
            </tr>
            <tr>
              <th>Positive class rate (Phase 2)</th>
              <td style="font-family:var(--font-mono)">
                ${fmtNullable(state.summary?.cells?.positive_rate, 4)}
                (${((state.summary?.cells?.positive_rate ?? 0.3553) * 100).toFixed(2)}%)
                &nbsp;<span style="font-family:var(--font-body);font-size:0.75rem;color:var(--muted)">
                  natural distribution · ${state.summary?.cells?.positive_label ?? "345"} positive /
                  ${state.summary?.cells?.total_viable ?? "971"} total viable cells
                </span>
              </td>
            </tr>
          </tbody>
          <tfoot><tr><td colspan="2">
            CV method: StratifiedGroupKFold (5-fold) on natural-distribution training set
            (n=655), grouped by H3 resolution-7 parent cells to prevent spatial leakage.
            Phase 2 held-out validation AUC 0.9510 confirms stability across 3→9 municipio boundary extension.
            SHAP base value (0.5222) exceeds the natural positive class rate (35.5%)
            because the RF was trained on a balanced 50/50 sample — this is expected
            behaviour (NB7); base value reflects training distribution, not prevalence.
          </td></tr></tfoot>
        </table>
      </article>
    </section>

    <!-- ROW 3: COMPARISONS -->
    <section class="method-grid">
      <article class="table-card">
        <div class="card-header">
          <h2>AHP vs RF Agreement</h2>
          <p>Cell-level agreement vs feature-level disagreement.</p>
        </div>
        <table>
          <tbody>
            <tr>
              <th>Cell-level ρ (Spearman)</th>
              <td style="font-family:var(--font-mono)">${fmtNullable(state.summary.model_performance?.spearman_ahp_rf_cell_level, 4)}</td>
            </tr>
            <tr>
              <th>Cell-level p-value</th>
              <td style="font-family:var(--font-mono)">${fmtNullable(state.summary.model_performance?.spearman_ahp_rf_pvalue, 4)}</td>
            </tr>
            <tr>
              <th>Feature-level ρ</th>
              <td style="font-family:var(--font-mono)">−0.4073</td>
            </tr>
            <tr>
              <th>Cell-level permutation p</th>
              <td style="font-family:var(--font-mono)">0.6441 (null — does not reject H₀)</td>
            </tr>
            <tr>
              <th>Feature-level permutation p</th>
              <td style="font-family:var(--font-mono)">0.2412 (null result)</td>
            </tr>
            <tr>
              <th>Divergence cells (|Δ| &gt; 100)</th>
              <td style="font-family:var(--font-mono)">${
                state.features.filter(
                  (f) => Math.abs(Number(f.properties.rank_diff || 0)) > APP_CONFIG.mandatoryDivergenceThreshold
                ).length
              }</td>
            </tr>
            <tr>
              <th>Interpretation</th>
              <td>
                <strong>Cell-level (spatial co-location):</strong> Observed ρ = ${fmtNullable(state.summary.model_performance?.spearman_ahp_rf_cell_level, 4)}
                (p = ${fmtNullable(state.summary.model_performance?.spearman_ahp_rf_pvalue, 4, "0.0000")})
                is consistent with, but does not exceed, the permutation null 95th percentile
                (ρ₉₅ = 0.8534, n=10,000, empirical p = 0.6441). Agreement is attributable to
                shared spatial autocorrelation; <em>not</em> independent methodological convergence.
                The raw significance (p = 0.000) reflects n=316 — not methodological alignment.
                <br><br>
                <strong>Feature-level (weight ordering):</strong> ρ = −0.4073 lies well inside
                the permutation null interval [−0.6322, 0.6383] (empirical p = 0.2412, n=10 features).
                Null result — single-analyst AHP weight vector and SHAP importance ranking are
                statistically indistinguishable from uncorrelated. The negative sign is
                <em>not</em> evidence of systematic inversion. The study is underpowered at
                n=10 features to detect moderate agreement (ρ ≈ 0.5–0.6); this null result
                is a finding about the limits of the comparison methodology.
              </td>
            </tr>
          </tbody>
        </table>
      </article>

      <article class="table-card">
        <div class="card-header">
          <h2>AHP vs SHAP Feature Comparison</h2>
          <p>Phase 2 NB7 — 10 AHP-scored features, 3 RF-only excluded from AHP.</p>
        </div>
        <table>
          <thead>
            <tr>
              <th>Feature</th>
              <th>AHP rank</th>
              <th>SHAP rank</th>
              <th>|Δ|</th>
              <th>Direction</th>
            </tr>
          </thead>
          <tbody>
            <tr style="background:var(--shap-neg-bg)">
              <td>Café Density <em style="font-size:0.72rem;color:var(--muted)">(RF-only)</em></td>
              <td style="font-family:var(--font-mono);color:var(--muted)">N/A</td>
              <td style="font-family:var(--font-mono)">1</td>
              <td style="font-family:var(--font-mono);color:var(--muted)">—</td>
              <td style="font-size:0.75rem;color:var(--muted)">RF-only</td>
            </tr>
            <tr>
              <td>POI Diversity</td>
              <td style="font-family:var(--font-mono)">8</td>
              <td style="font-family:var(--font-mono)">2</td>
              <td style="font-family:var(--font-mono);color:var(--div-warn)"><strong>6</strong></td>
              <td style="font-size:0.75rem;color:var(--shap-pos)">SHAP &gg; AHP</td>
            </tr>
            <tr>
              <td>Market Opportunity <em style="font-size:0.72rem;color:var(--muted)">(competitor saturation inv.)</em></td>
              <td style="font-family:var(--font-mono)">7</td>
              <td style="font-family:var(--font-mono)">3</td>
              <td style="font-family:var(--font-mono)">4</td>
              <td style="font-size:0.75rem;color:var(--muted)">Moderate divergence</td>
            </tr>
            <tr>
              <td>Tourist POIs</td>
              <td style="font-family:var(--font-mono)">10</td>
              <td style="font-family:var(--font-mono)">4</td>
              <td style="font-family:var(--font-mono);color:var(--div-warn)"><strong>6</strong></td>
              <td style="font-size:0.75rem;color:var(--shap-pos)">SHAP &gt; AHP</td>
            </tr>
            <tr>
              <td>Retail Density</td>
              <td style="font-family:var(--font-mono)">6</td>
              <td style="font-family:var(--font-mono)">5</td>
              <td style="font-family:var(--font-mono)">1</td>
              <td style="font-size:0.75rem;color:var(--muted)">Minor divergence</td>
            </tr>
            <tr style="background:var(--div-bg)">
              <td>Metro Access</td>
              <td style="font-family:var(--font-mono)">5</td>
              <td style="font-family:var(--font-mono)">13</td>
              <td style="font-family:var(--font-mono);color:var(--div-warn)"><strong>8</strong></td>
              <td style="font-size:0.75rem;color:var(--div-warn)">AHP &gg; SHAP ⚠</td>
            </tr>
            <tr style="background:var(--div-bg)">
              <td>Network Centrality</td>
              <td style="font-family:var(--font-mono)">4</td>
              <td style="font-family:var(--font-mono)">11</td>
              <td style="font-family:var(--font-mono);color:var(--div-warn)"><strong>7</strong></td>
              <td style="font-size:0.75rem;color:var(--div-warn)">AHP &gg; SHAP ⚠</td>
            </tr>
          </tbody>
          <tfoot>
            <tr><td colspan="5">
              Feature-level Spearman ρ = −0.4073 (permutation p = 0.2412,
              null interval [−0.6322, 0.6383], n=10,000 permutations, n=10 AHP features).
              Null result — single-analyst AHP weight vector and SHAP importance ranking are
              statistically indistinguishable from uncorrelated. The negative sign is not
              evidence of systematic inversion. Study is underpowered at n=10 features to
              detect moderate agreement (ρ ≈ 0.5–0.6); this is a finding about the limits
              of the comparison methodology.
              ⚠ rows are thesis case-study divergences. RF-only features
              (local café density, office density, university proximity) represent
              35.6% of the sum of mean absolute SHAP values (NB7).
            </td></tr>
          </tfoot>
        </table>
      </article>
    </section>

    <!-- ROW 4: DATA & ROBUSTNESS -->
    <section class="method-grid">
      <article class="table-card">
        <div class="card-header">
          <h2>Viability Threshold Sensitivity</h2>
          <p>NB_SA_viability_sensitivity sweep: 10 / 20 / 30% overlap — empirical justification for 20% canonical choice.</p>
        </div>
        <table>
          <thead>
            <tr>
              <th>Threshold</th>
              <th>Viable cells</th>
              <th>Positive (≥2)</th>
              <th>Negative</th>
              <th>Pos rate</th>
              <th>Val AUC</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td style="font-family:var(--font-mono)">10%</td>
              <td style="font-family:var(--font-mono)">971</td>
              <td style="font-family:var(--font-mono)">345</td>
              <td style="font-family:var(--font-mono)">626</td>
              <td style="font-family:var(--font-mono)">35.53%</td>
              <td style="font-family:var(--font-mono)">0.9434</td>
            </tr>
            <tr style="background:var(--accent-xlight)">
              <td style="font-family:var(--font-mono)"><strong>20% ★</strong></td>
              <td style="font-family:var(--font-mono)">${state.summary?.cells?.total_viable ?? 971}</td>
              <td style="font-family:var(--font-mono)">${state.summary?.cells?.positive_label ?? 345}</td>
              <td style="font-family:var(--font-mono)">${state.summary?.cells?.negative_label ?? 626}</td>
              <td style="font-family:var(--font-mono)">${((state.summary?.cells?.positive_rate ?? 0.3553) * 100).toFixed(2)}%</td>
              <td style="font-family:var(--font-mono)"><strong>${fmtNullable(state.summary?.model_performance?.rf_auc_validation, 4)}</strong></td>
            </tr>
            <tr>
              <td style="font-family:var(--font-mono)">30%</td>
              <td style="font-family:var(--font-mono)">857</td>
              <td style="font-family:var(--font-mono)">337</td>
              <td style="font-family:var(--font-mono)">520</td>
              <td style="font-family:var(--font-mono)">39.32%</td>
              <td style="font-family:var(--font-mono)">0.9606</td>
            </tr>
          </tbody>
          <tfoot>
            <tr><td colspan="6">
              AUC range = 0.0172 &lt; 0.02 threshold. The 20% choice does not
              materially affect model performance — empirical justification for
              canonical threshold (NB_SA_viability_sensitivity, <code>gold_threshold_sensitivity.csv</code>).
              The 20% row (★) reads live from <code>gold_webgis_summary.json</code>;
              10% and 30% rows are from the NB_SA_viability_sensitivity export.
            </td></tr>
          </tfoot>
        </table>
      </article>

      <article class="table-card">
        <div class="card-header">
          <h2>Data Sources & Reproducibility</h2>
          <p>Open data, open source — thesis reproducibility requirement.</p>
        </div>
        <ul class="credit-list" style="margin-top:8px; line-height: 1.4;">
          <li><strong>OpenStreetMap:</strong> Ingested via osmnx (Network and amenity snapshot: April 2026).</li>
          <li><strong>Copernicus:</strong> Urban Atlas 2021 (Land use & viability filter).</li>
          <li><strong>ISTAT:</strong> 2021 Census Tracts (Population density; <code>R03_21_WGS84.shp</code>).</li>
          <li><strong>Earth Observation Group:</strong> VIIRS VNL v2.2 2024 Annual Average (Night-time radiance).</li>
        </ul>
        <p class="table-note" style="margin-top:10px">
          <strong>Pinned Core Dependencies:</strong> osmnx 2.1.0 · h3 4.4.2 · geopandas 1.1.3 · shap 0.51.0 · scikit-learn 1.6.1 · folium 0.20.0 (Full environment pinned in <code>requirements.txt</code>).
        </p>
        <p class="table-note" style="margin-top:8px">
          CRS: WGS84 (EPSG:4326) throughout — GeoJSON standard, no reprojection.
          H3 resolution 9 · ~0.1 km² per cell.
        </p>
      </article>
    </section>
  `;
}

function toggleMethodology(show) {
  dom.methodologyModal.classList.toggle("hidden", !show);
}

// ── Utility — parsing ────────────────────────────────────────────────────────
function parseTopFactors(value) {
  return normalizeText(value || "")
    .split("|")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const symbol    = s[0] || "";
      const direction = symbol === "\u2193" ? "negative" : "positive";
      return { symbol, direction, label: s.slice(1).trim() };
    });
}

function prettifyFeatureName(col) {
  return normalizeText(col.replace(/^shap_/, "").replaceAll("_", " "));
}

function normalizeRange(value, min, max) {
  const n   = Number(value || 0);
  const den = Number(max) - Number(min);
  if (!Number.isFinite(den) || den <= 0) return 0;
  return ((n - Number(min)) / den) * 100;
}

function getValidationNote(properties) {
  // Phase 2 canonical column: is_validation_cell (boolean, set in NB7, propagated to WebGIS in NB8)
  // True = held-out validation set (316 cells); False = training set (655 cells)
  // SHAP global importance is computed on validation cells only to prevent memorization inflation.
  const keys = ["is_validation_cell", "validation_note", "validation_set_note",
                 "in_validation_set", "is_validation_set", "validation_set", "validation"];
  for (const key of keys) {
    if (key in properties) {
      const raw = properties[key];
      if (typeof raw === "boolean" || raw === 1 || raw === 0) {
        return (raw === true || raw === 1)
          ? "Held-out validation set (n=316) — SHAP importance reliable"
          : "Training set (n=655) — SHAP may reflect memorisation";
      }
      return normalizeText(String(raw));
    }
  }
  return "Not supplied in this delivery";
}

// Repairs double-encoded UTF-8 arrow characters (↑ ↓) from Python GeoJSON export
function normalizeText(value) {
  if (typeof value !== "string") return value;
  try {
    const bytes    = Uint8Array.from([...value].map((c) => c.charCodeAt(0)));
    const repaired = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
    const broken   = /Ã|Â|â/.test(value);
    const better   = !/Ã|Â|â/.test(repaired) && repaired.length > 0;
    return broken && better ? repaired : value;
  } catch { return value; }
}

// ── Utility — formatting ─────────────────────────────────────────────────────
const fmt2    = (v) => Number(v).toFixed(2);
const fmt4    = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(4) : "N/A";
};
const fmt5    = (v) => Number(v).toFixed(5);
const fmtPct  = (v) => `${(Number(v || 0) * 100).toFixed(1)}%`;
const fmtNullable = (v, digits = 4, fallback = "—") => {
  const n = Number(v);
  return Number.isFinite(n) ? n.toFixed(digits) : fallback;
};

// ── Fatal error display ──────────────────────────────────────────────────────
function renderFatalError(message) {
  dom.datasetSummary.textContent = `Error — ${message}`;
  dom.detailsPanel.innerHTML = `
    <div class="error-card">
      <h3>Application error</h3>
      <p class="helper-text">${message}</p>
      <p class="helper-text" style="margin-top:6px">
        Run: <code>python -m http.server 8080</code> in the project folder,
        then open <code>http://localhost:8080</code>.
      </p>
    </div>
  `;
}
