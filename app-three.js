// Railway Line Waves — Three.js prototype
//
// Mirrors the TD patch system:
//   • Arc-length gradient via Ramp texture (per-rail, 3 rows = top/center/bot).
//   • Cross-section patches via 2D map (U = arc, V = perp position 0=bot/1=top).
//   • Solid rail + fog rail channels composited in one fragment shader.
//   • World-anchored scroll — pulse travels with the rail (TD freq=0 behaviour).
//
// This is a scaffold: 3 parallel straight rails, no topology yet. The goal
// is to prove the patch model ports cleanly; TrackSegment / split-merge can
// layer in next.
//
// Loaded as a non-module <script>; THREE comes from the CDN global so this
// page works when opened via file:// (Chrome blocks ES modules on file:).

// ── Config ────────────────────────────────────────────────────────────────
const CONFIG = {
  speed:        5371,   // world units / second — advances cameraX (drives topology scroll)
  pulsePeriod:  100000, // one full ramp cycle in world units
  // Per-rail phase offset (0..1, fractions of pulsePeriod). Each rail family
  // samples the gradient at gradU = fract(wx/period + phase) so the three
  // ramps can run as distinct bands along the rail X axis.
  gradPhaseTop:    0.00,
  gradPhaseCenter: 0.33,
  gradPhaseBot:    0.66,
  // Half-width (in lane-units) of the soft transition between rail-family
  // gradient colours. 0 = hard cut at ±0.5 lanes, 0.5 = colours bleed half
  // a lane on either side. Companion to sleeperColorBlend but for rails.
  railColorBlend:  0.25,
  segW:         1200,   // segment width (world units) — matches SIM.SEG_W
  laneSpace:    216,    // vertical distance between lanes (matches SIM.LANE_SPACE)
  railWidth:    95,     // rail half-thickness in world units
  // Softness profile: the rail mask is max(unioned_fill, gaussBody * railSoft).
  // railSoft = 0 → crisp SDF edges; railSoft = 1 → full Gaussian body mixed in.
  // railSigma = Gaussian width as a fraction of the rail half-width (halfW):
  //   small (≈0.3) keeps a tight peak, large (≈1.2) bleeds past the edge.
  railSoft:     0.4,
  railSigma:    0.61,
  // railBlend — smooth-min radius (world units) for the lane-SDF union.
  // 0 disables the union bridge entirely — rails read as clean separate
  // strands at merge zones. Set above 0 (e.g., 15-25) to fuse adjacent
  // rails through a soft bezier-style bridge.
  railBlend:    0.0,
  railColor:    '#1F2528',
  gradOpacity:  1.0,
  railPatchMix: 1.0,
  bgColor:      '#0B0F11',
  viewZoom:     1.52,

  // Sleepers — base (branched-state) shape. Mirrors TD's sleeper_d block:
  // Sleeperdspacing / Sleeperdwidth / Sleeperdheight / Sleeperdcorner.
  // Pill-state defaults match svg/new sleepers.svg pill stage (#646464,
  // 26.86 × 93.60 full size = 13 × 47 half-extents, fully rounded).
  sleeperSpacing: 54,
  sleeperW:       8,    // half-width along the rail axis
  sleeperH:       44,   // half-length perpendicular to the rail
  sleeperCorner:  7,
  // Per-rail sleeper colours. The shader picks between the three based on
  // the sleeper's lane Y (via railPalette), so when rails branch each
  // family gets its own colour. Defaults match: change them to differentiate.
  // Defaults match svg/v2/sleeperSpacingMorph.svg — tan centre with red
  // top/bot families, fading to sage station inner.
  sleeperColor:    '#9e947a',  // CENTER rail
  sleeperColorTop: '#e16657',  // TOP rail
  sleeperColorBot: '#e16657',  // BOT rail
  // Width (in lane-units) of the smooth crossfade between rail-family
  // sleeper colours. 0 = hard cut at ±laneSpace/2, 0.5 = colours bleed
  // half a lane on either side of the boundary.
  sleeperColorBlend: 1.0,
  sleeperOpacity: 0.71,
  // Rail constraint: clip sleeper/station alpha by the rail's own coverage,
  // so pills never extend past the rail band — matches the TD reference
  // where sleepers always sit *inside* the rail stroke. 0 = no clip (old
  // behaviour, pills can stick out). 1 = hard clip to rail mask. Default 0
  // keeps the prototype look; crank it up together with a wider railWidth
  // (e.g. 80) to match the SVG reference where the rail is a broad band.
  sleeperRailClip: 1.0,

  // Morph curve — single easing knob shared by W, H, corner and colour.
  // 0 = linear ramp from pill to station, 1 = smootherstep (zero-velocity
  // at both ends). The pill grows in place and adjacent pills fade out as
  // the morph advances; see drawSleepers().
  morphCurve: 1.0,

  // Effects — per-layer blur (texture-sample blur inside the shader) so
  // each layer can soften independently while staying inside the rail mask.
  gradBlur:     0.20,   // 1D blur along arcU when sampling the ramp (0..0.2)
  patchBlur:    0.00,   // 2D blur when sampling the patch map     (0..0.1)
  // patchEdgeFade — fades the patch alpha near lane terminations (where a
  // rail's lane has no continuation in the adjacent segment). Stops the
  // hard cutoff that appears where a rail starts or ends. 0 = off,
  // 0.5 = fade across the last half of the segment.
  patchEdgeFade: 0.30,
  grainAmount:  0.00,
  grainScale:   500,

  // Simulation
  simMode:      'scripted', // 'scripted' | 'procedural'
  simScript:    'v1',         // 'v1' or 'v5' (scripted mode only)
  loopSegs:     30,           // scripted mode only — procedural grows forever
  // Procedural-mode params (ported from TS App.tsx INITIAL_CONFIG)
  seed:         1,
  mergeChance:  0.20,
  splitChance:  0.17,
  maxTracks:    9,

  // TD split/merge behaviour — ported from /project1/prototype_glsl/pixel.
  //  stationSolid: timeline override that forces the merged-state palette
  //                even when singleLane < 1 (TD uStationForce.x).
  //  approachWeight: smooth lookahead weight, 0..1 (TD uApproachWeight.x).
  stationSolid:   0.0,
  approachWeight: 0.0,

  // ── Pill → station morph ──────────────────────────────────────────────
  // wStation (0..1) is computed per fragment by stationWeight(). It drives
  // a single eased curve `w` that morphs every Nth pill (the "station-
  // elect") in place from pill geometry to station geometry, while the
  // other (N-1) pills fade out via alpha. The pill grid spacing is FIXED —
  // no snap-grid widening — so growth is continuously visible.
  //
  //  stationEnable      : auto-detect single-lane mode on (TD uStationCtrl.x).
  //  stationWindow      : max ± segments scanned (used when segW is small).
  //  stationTransitionWidth : world-units half-width of the gradient zone
  //                       around each lane-count boundary. Smaller = snappier
  //                       transition; larger = more frames of in-betweening.
  //  stationEvery       : every Nth pill grows into a station. The other
  //                       (N-1) pills fade out as the morph advances. Higher
  //                       N = sparser stations.
  //  station{W,H}       : final wide-rectangle half-extents.
  //  stationCorner      : final corner radius. 0 = sharp.
  //  stationBodyWmul/Hmul: optional outer halo size (× station inner).
  //  stationInnerCol    : final inner colour.
  //  stationBodyCol     : optional halo colour.
  stationEnable:          1,
  stationWindow:          1,        // narrow auto-detect window — most of the
                                    // morph drive comes from the smooth
                                    // stationTransitionWidth kernel below
  stationTransitionWidth: 1560,     // world units — half-width of gradient zone
  stationEvery:           8,        // every 8th pill becomes a station
  // Station state — wide rectangle. Tuned against svg/v2/sleeperSpacingMorph.svg
  // (KF4: 121.66 × 139.73, corner 20.72) but shrunk/widened slightly for the
  // working art-direction; tweak via the Split/merge tab.
  stationW:          187,
  stationH:          69,
  stationCorner:     23,
  // Body halo defaults to OFF (mul=0) — the SVG reference is one solid
  // rectangle. Set both mul values >1 (e.g. 1.6 / 1.5) to revive the TD
  // outer-glow look.
  stationBodyWmul:   0.0,
  stationBodyHmul:   0.0,
  // Per-rail station inner colours — companions to sleeperColor{,Top,Bot}.
  // The morph eased weight `w` lerps each family's sleeper colour into its
  // station colour, so the morph is per-rail end-to-end.
  stationInnerCol:    '#f0fec6', // CENTER rail
  stationInnerColTop: '#becf9e', // TOP rail
  stationInnerColBot: '#becf9e', // BOT rail
  stationBodyCol:    '#A6A793',

  // Per-rail base colours used in the branched (multi-lane) state. These
  // get mixed with the ramp texture via branchActSmooth, so in merged
  // zones (singleLane=1) the endpoint gradient colour dominates instead.
  railCenterCol: '#ffffff',  // white      — Center
  railTopCol:    '#e0b77e',  // warm tan    — Top
  railBotCol:    '#b1c4ae',  // cool sage   — Bot

};

// ── Simulator init (global SIM from sim.js) ──────────────────────────────
SIM.setScript(CONFIG.simScript);
SIM.setLoopSegs(CONFIG.loopSegs);
SIM.setSegW(CONFIG.segW);
SIM.setLaneSpace(CONFIG.laneSpace);
SIM.setCenterY(0);
SIM.setSeed(CONFIG.seed);
SIM.setMergeChance(CONFIG.mergeChance);
SIM.setSplitChance(CONFIG.splitChance);
SIM.setMaxTracks(CONFIG.maxTracks);
SIM.setMode(CONFIG.simMode);

// World-scroll state — cameraX advances with CONFIG.speed each frame. The
// lane_data texture is rebuilt from this so visible segments track the
// scrolling camera.
const WORLD = {
  cameraX:        0,
  bufferSegs:     33,     // rows in lane_data (visible segment window)
  maxSlots:       8,      // connection slots per segment — enough for all 7
                          // pass-through lanes + a simultaneous split/merge
                          // pair. Was 4, which silently truncated v5 rails
                          // (5 simultaneous lanes) and procedural rolls with
                          // >4 active lanes. Texture cost is tiny (8×33 px).
  // Origin segment index tracked per frame; passed to the shader so it
  // can convert world-x to buffer-row.
  laneOriginSeg:  0,
};

// ── Ramp stops — [position, hex, alpha]. Alpha is optional; missing =1. ──
// The SVG linearGradients mirror this schema (stop-color + stop-opacity).
// Stops ported from svg/rails.svg (paint0/paint1/paint2/paint3). Ramps are
// periodic: the shader samples travelling gradients in BRANCHED zones, then
// samples u=0.995 as the merged-state palette for SINGLE-LANE / station
// zones. So each ramp holds its "endpoint" SVG colour at u≈1.0 — that's the
// pale green / pale teal / warm sand that dominates inside stations.
const RAMPS = {
  // Two-stop dusk ramps — each rail family gets its own start→end gradient
  // sampled along the rail length. u≈1 is the merged-state endpoint colour
  // (dominates inside stations); u=0 is the pulse start.
  top:    [ [0.00, '#683835', 1], [1.00, '#e6eecc', 1] ],  // burgundy → cream
  center: [ [0.00, '#fec73d', 1], [1.00, '#b4c5af', 1] ],  // gold      → sage
  bot:    [ [0.00, '#163c6e', 1], [1.00, '#e0b77e', 1] ],  // navy      → tan
};
// Coerce any stops missing alpha to alpha=1 (defensive; old-format compat).
for (const k of Object.keys(RAMPS)) {
  RAMPS[k] = RAMPS[k].map((s) => s.length >= 3 ? s : [s[0], s[1], 1]);
}
const stopAlpha = (s) => (s.length >= 3 ? s[2] : 1);

// ── Patch table (same schema as TD patch_table) ──────────────────────────
// arcPos/halfWidth: along-the-rail position and extent (0..1 of period).
// bandMin/bandMax:  cross-section range (0=bot edge, 0.5=center, 1=top edge).
// vMode:            'bell' | 'bot' | 'top' — peak at midpoint / bandMin / bandMax.
// rail:             'all' | 'top' | 'center' | 'bot' — which rail family the
//                   patch is painted onto. The patch atlas bakes 3 stacked
//                   strips (one per rail) and the shader samples the strip
//                   matching the fragment's lane Y. 'all' bakes into all 3.
// Colors in [r,g,b] with values 0..1.
//
// The list is fully mutable from the UI — start with one starter patch,
// use "+ Add patch" to grow the list, "×" on a row to remove. A preset
// load can replace the whole table in one go.
function defaultPatch() {
  // arcPos is in WORLD UNITS (mod period). Default = 0 so a freshly added
  // patch starts at world-X 0. halfWidth stays as a fraction of the period.
  return {
    arcPos: 0, halfWidth: 0.1,
    bandMin: 0.0, bandMax: 1.0,
    color: [0.89, 0.84, 0.72], alpha: 1.0,
    vMode: 'bell',
    rail:  'all',
    // Edge softness, split into independent X (along the rail) and
    // Y (cross-section). 0 = hard cutoff, 1 = pure gradient with a
    // long soft tail. featherX additionally extends the tail past
    // halfWidth so the patch ends fade out smoothly.
    featherX: 0.45,
    featherY: 0.45,
  };
}
// Initial patch — a soft deep-red splash on the TOP rail. Edit / add via the
// Patches tab; defaultPatch() above is the template used by "+ Add patch".
const PATCH_TABLE = [{
  arcPos:    10590,
  halfWidth: 0.039,
  bandMin:   0.0,
  bandMax:   1.0,
  color:     [0.647, 0.137, 0.129],
  alpha:     0.41,
  vMode:     'bell',
  rail:      'top',
  featherX:  1.0,
  featherY:  0.96,
}];

// ── Helpers ──────────────────────────────────────────────────────────────
const hexToRgb = (h) => {
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
};
const mix = (a, b, t) => a + (b - a) * t;
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const smoothstep = (e0, e1, x) => {
  const denom = (e0 - e1) || 1e-6;
  const t = clamp01((x - e1) / denom);
  return 1 - t * t * (3 - 2 * t);
};

// ── Bake the 3-row ramp texture (512 × 3 RGBA8) ──────────────────────────
// Interpolates position, RGB and alpha linearly between adjacent stops.
// Stops must already be sorted by position. The output is stored PRE-
// MULTIPLIED (rgb * a, a) so a transparent stop produces a (0,0,0,0) pixel
// and linear filtering across it behaves correctly.
function sampleRamp(stops, pos) {
  const p = ((pos % 1) + 1) % 1;
  for (let i = 0; i < stops.length - 1; i++) {
    if (p <= stops[i + 1][0]) {
      const t  = (p - stops[i][0]) / (stops[i + 1][0] - stops[i][0]);
      const ca = hexToRgb(stops[i][1]);
      const cb = hexToRgb(stops[i + 1][1]);
      const aa = stopAlpha(stops[i]);
      const ab = stopAlpha(stops[i + 1]);
      return [mix(ca[0], cb[0], t), mix(ca[1], cb[1], t), mix(ca[2], cb[2], t), mix(aa, ab, t)];
    }
  }
  const last = stops[stops.length - 1];
  const rgb  = hexToRgb(last[1]);
  return [rgb[0], rgb[1], rgb[2], stopAlpha(last)];
}
function buildRampTexture() {
  const W = 512, H = 3;
  const data = new Uint8Array(W * H * 4);
  const order = ['bot', 'top', 'center']; // matches TD row layout
  for (let row = 0; row < H; row++) {
    const stops = RAMPS[order[row]].slice().sort((a, b) => a[0] - b[0]);
    for (let x = 0; x < W; x++) {
      const u = (x + 0.5) / W;
      const [r, g, b, a] = sampleRamp(stops, u);
      const i = (row * W + x) * 4;
      // Store premultiplied RGB so linear interpolation across transparent
      // edges doesn't leak colour into the alpha=0 region.
      data[i    ] = Math.round(r * a * 255);
      data[i + 1] = Math.round(g * a * 255);
      data[i + 2] = Math.round(b * a * 255);
      data[i + 3] = Math.round(a * 255);
    }
  }
  const tex = new THREE.DataTexture(data, W, H, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.needsUpdate = true;
  return tex;
}

// ── Bake the patch map (512 × 384 RGBA8) — 3 stacked strips, one per rail ──
// Strip layout (V from 0 to 1) matches `rampRowFor`'s numbering, but the
// SVG/TD convention has the labels INVERTED relative to screen position:
// rampRowFor returns 0 for positive lane-Y (top of screen) and 1 for
// negative lane-Y (bottom of screen). The user-facing rail names follow
// screen orientation, so the mapping flips top<->bot here:
//   strip 0 (V 0..1/3)   → screen-TOP    (rampRowFor → 0)
//   strip 1 (V 1/3..2/3) → screen-BOT    (rampRowFor → 1)
//   strip 2 (V 2/3..1)   → CENTER        (rampRowFor → 2)
// Each patch with rail='top'|'center'|'bot' bakes into one strip; rail='all'
// (or missing) bakes into all three.
const PATCH_STRIP = { top: 0, bot: 1, center: 2 };
function buildPatchTexture(patches, period) {
  const W = 512, H_PER = 128, STRIPS = 3, H = H_PER * STRIPS;
  const data = new Float32Array(W * H * 4);
  const periodSafe = Math.max(1.0, period || 1.0);
  for (const p of patches) {
    const bMin = p.bandMin, bMax = p.bandMax;
    if (bMax <= bMin) continue;
    const rail = p.rail || 'all';
    const targets = (rail === 'all') ? [0, 1, 2] : [PATCH_STRIP[rail]];
    if (targets.includes(undefined)) continue;
    // featherX (along rail) and featherY (cross-section): independent
    // edge softness in each direction. 0 = hard cutoff, 1 = pure gradient.
    // Falloff stays bounded by halfWidth in U and bandMin/bandMax in V — so
    // the patch's footprint is always exactly defined by halfWidth/band, and
    // arcPos predictably moves the patch's centre. featherX shrinks the
    // solid plateau (smoothstep inner edge), giving softer ends without
    // changing the patch's size.
    // Legacy `feather` (single value) used as fallback for both.
    const fLegacy = (p.feather == null) ? 0.45 : p.feather;
    const featherX = clamp01(p.featherX == null ? fLegacy : p.featherX);
    const featherY = clamp01(p.featherY == null ? fLegacy : p.featherY);
    const innerFracX = Math.max(0.0, 1.0 - featherX);
    const innerFracY = Math.max(0.0, 1.0 - featherY);
    // arcPos is in WORLD units (0..period). Convert to atlas fraction
    // here so the stored patches are positioned in absolute world-X space.
    const arcPosFrac = ((p.arcPos / periodSafe) % 1 + 1) % 1;
    for (const stripIdx of targets) {
      const yBase = stripIdx * H_PER;
      for (let y = 0; y < H_PER; y++) {
        const v = (y + 0.5) / H_PER;
        let vW;
        if (p.vMode === 'bot') {
          // Peak at bMin (rail bot edge) — apply featherY as a "hold zone"
          // around the peak that's fully opaque before fading to bMax.
          const innerEdge = bMin + (bMax - bMin) * innerFracY;
          vW = smoothstep(bMax, innerEdge, v);
        } else if (p.vMode === 'top') {
          const innerEdge = bMax - (bMax - bMin) * innerFracY;
          vW = smoothstep(bMin, innerEdge, v);
        } else {
          const center = 0.5 * (bMin + bMax);
          const half   = Math.max(1e-5, 0.5 * (bMax - bMin));
          vW = smoothstep(half, half * innerFracY, Math.abs(v - center));
        }
        if (v < 0 || v > 1) vW = 0;
        if (vW <= 0) continue;

        for (let x = 0; x < W; x++) {
          const u = (x + 0.5) / W;
          // Wrapped arc distance — atlas U is the arcU fraction
          const du = Math.abs(((u - arcPosFrac + 0.5) % 1 + 1) % 1 - 0.5);
          const uW = smoothstep(p.halfWidth, p.halfWidth * innerFracX, du);
          if (uW <= 0) continue;
          const srcA = vW * uW * p.alpha;
          const idx = ((yBase + y) * W + x) * 4;
          const dstA = data[idx + 3];
          const outA = srcA + dstA * (1 - srcA);
          const denom = outA > 1e-6 ? outA : 1;
          for (let c = 0; c < 3; c++) {
            data[idx + c] = (p.color[c] * srcA + data[idx + c] * dstA * (1 - srcA)) / denom;
          }
          data[idx + 3] = outA;
        }
      }
    }
  }
  // Convert float accumulator → uint8
  const u8 = new Uint8Array(W * H * 4);
  for (let i = 0; i < data.length; i++) u8[i] = Math.max(0, Math.min(255, Math.round(data[i] * 255)));
  const tex = new THREE.DataTexture(u8, W, H, THREE.RGBAFormat);
  tex.magFilter = THREE.LinearFilter;
  tex.minFilter = THREE.LinearFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.needsUpdate = true;
  return tex;
}

// ── Three.js setup ───────────────────────────────────────────────────────
const canvas = document.getElementById('scene');
// preserveDrawingBuffer keeps the framebuffer readable after present, so the
// PNG exporter's canvas.toBlob() returns the actual frame instead of blank.
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setClearColor(new THREE.Color(CONFIG.bgColor));

const scene = new THREE.Scene();
const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -1, 1);

function resize() {
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  // Camera maps clip-space [-1,1] to the quad; the shader computes world coords.
}
window.addEventListener('resize', resize);
resize();

const rampTex  = buildRampTexture();
const patchTex = buildPatchTexture(PATCH_TABLE, CONFIG.pulsePeriod);

// ── Lane data — Float RGBA texture (MAX_SLOTS × BUFFER_SEGS) ─────────────
// Each pixel (slot, seg) encodes one bezier connection:
//   .r = segment start X in world units (absolute)
//   .g = world Y of this connection's start lane
//   .b = world Y of this connection's end lane
//   .a = 1 if valid, 0 otherwise (shader early-breaks on a < 0.5)
const laneDataArray = new Float32Array(WORLD.maxSlots * WORLD.bufferSegs * 4);
const laneDataTex = new THREE.DataTexture(
  laneDataArray, WORLD.maxSlots, WORLD.bufferSegs,
  THREE.RGBAFormat, THREE.FloatType
);
laneDataTex.magFilter = THREE.NearestFilter;
laneDataTex.minFilter = THREE.NearestFilter;
laneDataTex.wrapS = THREE.ClampToEdgeWrapping;
laneDataTex.wrapT = THREE.ClampToEdgeWrapping;
laneDataTex.needsUpdate = true;

// Rebuild lane_data from SIM.connectionsAt() — called each frame as the
// camera scrolls. Origin seg is chosen so the camera sits in the middle
// of the buffer window (BUFFER_SEGS/2 on each side).
function rebuildLaneData() {
  const segW = CONFIG.segW;
  const cameraSeg = Math.floor(WORLD.cameraX / segW);
  const originSeg = cameraSeg - Math.floor(WORLD.bufferSegs / 2);
  WORLD.laneOriginSeg = originSeg;

  for (let r = 0; r < WORLD.bufferSegs; r++) {
    const seg = originSeg + r;
    const conns = SIM.connectionsAt(seg);
    const sxWorld = seg * segW;
    for (let c = 0; c < WORLD.maxSlots; c++) {
      const i = (r * WORLD.maxSlots + c) * 4;
      if (c < conns.length) {
        laneDataArray[i    ] = sxWorld;
        laneDataArray[i + 1] = SIM.laneToY(conns[c].y1);
        laneDataArray[i + 2] = SIM.laneToY(conns[c].y2);
        laneDataArray[i + 3] = 1.0;
      } else {
        laneDataArray[i    ] = 0;
        laneDataArray[i + 1] = 0;
        laneDataArray[i + 2] = 0;
        laneDataArray[i + 3] = 0;
      }
    }
  }
  laneDataTex.needsUpdate = true;
}
rebuildLaneData();

// Full-screen quad that runs the rail shader per fragment.
const geo = new THREE.PlaneGeometry(2, 2);
const mat = new THREE.ShaderMaterial({
  uniforms: {
    uResolution:   { value: new THREE.Vector2(1, 1) },
    uTime:         { value: 0 },
    uScrollX:      { value: 0 },
    uZoom:         { value: CONFIG.viewZoom },
    uLaneSpace:    { value: CONFIG.laneSpace },
    uRailWidth:    { value: CONFIG.railWidth },
    uRailSoft:     { value: CONFIG.railSoft },
    uRailSigma:    { value: CONFIG.railSigma },
    uRailBlend:    { value: CONFIG.railBlend },
    uPulsePeriod:  { value: CONFIG.pulsePeriod },
    uGradPhaseTop:    { value: CONFIG.gradPhaseTop },
    uGradPhaseCenter: { value: CONFIG.gradPhaseCenter },
    uGradPhaseBot:    { value: CONFIG.gradPhaseBot },
    uRailColorBlend:  { value: CONFIG.railColorBlend },
    uRailPatchMix: { value: CONFIG.railPatchMix },
    uRailColor:    { value: new THREE.Color(CONFIG.railColor) },
    uGradOpacity:  { value: CONFIG.gradOpacity },
    uGradBlur:     { value: CONFIG.gradBlur },
    uPatchBlur:    { value: CONFIG.patchBlur },
    uPatchEdgeFade: { value: CONFIG.patchEdgeFade },
    uRamp:         { value: rampTex },
    uPatch:        { value: patchTex },
    uGrainAmount:  { value: CONFIG.grainAmount },
    uGrainScale:   { value: CONFIG.grainScale },
    // Topology — lane_data buffer + associated params
    uLaneData:     { value: laneDataTex },
    uCameraX:      { value: 0 },
    uSegW:         { value: CONFIG.segW },
    uBufferSegs:   { value: WORLD.bufferSegs },
    uMaxSlots:     { value: WORLD.maxSlots },
    uLaneOriginX:  { value: 0 },

    // TD split/merge — branched/merged palette blend + rail widening.
    uRailCenterCol:  { value: new THREE.Color(CONFIG.railCenterCol) },
    uRailTopCol:     { value: new THREE.Color(CONFIG.railTopCol) },
    uRailBotCol:     { value: new THREE.Color(CONFIG.railBotCol) },
    uStationSolid:   { value: CONFIG.stationSolid },
    uApproachWeight: { value: CONFIG.approachWeight },
    uLaneSpacePerUnit: { value: CONFIG.laneSpace },  // world-Y per lane index

    // Background — shader composites over this so the canvas clear colour
    // is actually visible (fragment writes opaque RGB, so the GL clear buffer
    // alone would never show through).
    uBgColor:        { value: new THREE.Color(CONFIG.bgColor) },

    // Sleepers
    uSleeperSpacing: { value: CONFIG.sleeperSpacing },
    uSleeperW:       { value: CONFIG.sleeperW },
    uSleeperH:       { value: CONFIG.sleeperH },
    uSleeperCorner:  { value: CONFIG.sleeperCorner },
    uSleeperColor:      { value: new THREE.Color(CONFIG.sleeperColor) },
    uSleeperColorTop:   { value: new THREE.Color(CONFIG.sleeperColorTop) },
    uSleeperColorBot:   { value: new THREE.Color(CONFIG.sleeperColorBot) },
    uSleeperColorBlend: { value: CONFIG.sleeperColorBlend },
    uSleeperOpacity:    { value: CONFIG.sleeperOpacity },
    uSleeperRailClip:   { value: CONFIG.sleeperRailClip },
    uMorphCurve:        { value: CONFIG.morphCurve },

    // Pill → station morph. uStation* drives the window scan + final keyframe;
    // uMorphCurve eases the 0..1 weight; uStationEvery picks which pills grow.
    uStationEnable:          { value: CONFIG.stationEnable },
    uStationWindow:          { value: CONFIG.stationWindow },
    uStationTransitionWidth: { value: CONFIG.stationTransitionWidth },
    uStationEvery:           { value: CONFIG.stationEvery },
    uStationW:          { value: CONFIG.stationW },
    uStationH:          { value: CONFIG.stationH },
    uStationCorner:     { value: CONFIG.stationCorner },
    uStationBodyMul:    { value: new THREE.Vector2(CONFIG.stationBodyWmul, CONFIG.stationBodyHmul) },
    uStationInnerCol:    { value: new THREE.Color(CONFIG.stationInnerCol) },
    uStationInnerColTop: { value: new THREE.Color(CONFIG.stationInnerColTop) },
    uStationInnerColBot: { value: new THREE.Color(CONFIG.stationInnerColBot) },
    uStationBodyCol:     { value: new THREE.Color(CONFIG.stationBodyCol) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUV;
    void main() {
      vUV = uv;
      gl_Position = vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    precision highp float;
    varying vec2 vUV;

    uniform vec2  uResolution;
    uniform float uScrollX;
    uniform float uZoom;
    uniform float uLaneSpace;
    uniform float uRailWidth;
    uniform float uRailSoft;       // Gaussian body mix weight (0 = crisp SDF only, 1 = full soft glow)
    uniform float uRailSigma;      // Gaussian sigma as fraction of halfW
    uniform float uRailBlend;      // smooth-min radius for lane-SDF union
    uniform float uPulsePeriod;
    uniform float uGradPhaseTop;
    uniform float uGradPhaseCenter;
    uniform float uGradPhaseBot;
    uniform float uRailColorBlend;  // half-width (lanes) of soft family blend for rails
    uniform float uRailPatchMix;
    uniform vec3  uBgColor;        // canvas background — composite under content
    uniform vec3  uRailColor;      // solid base colour underneath the gradient
    uniform float uGradOpacity;    // overall gradient blend amount
    uniform float uGradBlur;       // 1D blur along arcU when sampling the ramp
    uniform float uPatchBlur;      // 2D blur when sampling the patch map
    uniform float uPatchEdgeFade;  // fade patch alpha near lane terminations
    uniform sampler2D uRamp;
    uniform sampler2D uPatch;
    uniform float uGrainAmount;
    uniform float uGrainScale;

    // Topology — lane data texture + window params
    uniform sampler2D uLaneData;
    uniform float     uCameraX;
    uniform float     uSegW;
    uniform float     uBufferSegs;
    uniform float     uMaxSlots;
    uniform float     uLaneOriginX;   // absolute world X of buffer row 0

    // TD split/merge — branched→merged blend, widening, async pulses
    uniform vec3  uRailCenterCol;
    uniform vec3  uRailTopCol;
    uniform vec3  uRailBotCol;
    const float uWidenFactor = 1.0;  // widening removed — kept as const so dInflate math compiles to 0
    uniform float uStationSolid;
    uniform float uApproachWeight;
    uniform float uLaneSpacePerUnit;

    uniform float uTime;

    // Sleepers — base shape
    uniform float uSleeperSpacing;
    uniform float uSleeperW;
    uniform float uSleeperH;
    uniform float uSleeperCorner;
    uniform vec3  uSleeperColor;     // CENTER rail sleeper colour
    uniform vec3  uSleeperColorTop;  // TOP rail sleeper colour
    uniform vec3  uSleeperColorBot;  // BOT rail sleeper colour
    uniform float uSleeperColorBlend; // half-width (lanes) of soft family blend
    uniform float uSleeperOpacity;
    uniform float uSleeperRailClip;
    // Morph easing (TD pixel_b uMorphEase). Width and height interpolate on
    // independently-eased curves of wStation; easingAmt blends linear → silky.
    uniform float uMorphCurve;          // 0=linear, 1=smootherstep (single ease knob)

    // Pill → station morph. wStation 0..1 (per fragment, from stationWeight)
    // is eased once into w; every Nth pill (the station-elect) interpolates
    // its (W, H, corner, colour) from pill values to station values by w,
    // while the other (N-1) pills fade out via alpha — pill grid spacing is
    // FIXED so every pill grows in place, never snap-jumps to a wider grid.
    uniform float uStationEnable;       // .x of TD uStationCtrl
    uniform float uStationWindow;       // .y of TD uStationCtrl — max segs scanned
    uniform float uStationTransitionWidth; // world-units half-width of gradient kernel
    uniform float uStationEvery;        // every Nth pill becomes a station
    uniform float uStationW;            // half-width  (TD uStationShape.x / 2)
    uniform float uStationH;            // half-height (TD uStationShape.y / 2)
    uniform float uStationCorner;       // TD uStationCorner.x
    uniform vec2  uStationBodyMul;      // (bodyWmul, bodyHmul) — TD uStationShape.zw
    uniform vec3  uStationInnerCol;     // CENTER rail station inner colour
    uniform vec3  uStationInnerColTop;  // TOP rail station inner colour
    uniform vec3  uStationInnerColBot;  // BOT rail station inner colour
    uniform vec3  uStationBodyCol;      // TD uStationBodyCol

    // ── World-space fractal noise for grain (zoetrope-stable) ────────────
    float hash12(vec2 p) {
      p = fract(p * vec2(443.897, 441.423));
      p += dot(p, p + 23.13);
      return fract(p.x * p.y);
    }
    float vnoise(vec2 p) {
      vec2 i = floor(p), f = fract(p);
      float a = hash12(i);
      float b = hash12(i + vec2(1, 0));
      float c = hash12(i + vec2(0, 1));
      float d = hash12(i + vec2(1, 1));
      vec2 u = f * f * (3.0 - 2.0 * f);
      return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
    }
    float fbm(vec2 p) {
      float v = 0.0, amp = 0.5;
      for (int i = 0; i < 4; i++) {
        v += amp * vnoise(p);
        p *= 2.0;
        amp *= 0.5;
      }
      return v;
    }

    // Ramp sample — returns RGBA (premultiplied RGB, straight alpha).
    // Rows: 0 = bot (v=1/6), 1 = top (v=3/6), 2 = center (v=5/6).
    vec4 sampleRamp(float arcU, int row) {
      float rowV = (float(row) + 0.5) / 3.0;
      return texture2D(uRamp, vec2(fract(arcU), rowV));
    }

    // ── Per-layer blur helpers ──────────────────────────────────────────
    // 1D 5-tap gaussian along arcU for the gradient ramp. Blur is
    // expressed in arcU units (0..1). Applied to texture-sample coords,
    // so everything stays under the rail mask that's applied at output.
    vec4 blurredRamp(float arcU, int row, float blur) {
      if (blur < 1e-4) return sampleRamp(arcU, row);
      vec4 c = sampleRamp(arcU,                row) * 4.0;
      c     += sampleRamp(arcU - blur,         row) * 2.0;
      c     += sampleRamp(arcU + blur,         row) * 2.0;
      c     += sampleRamp(arcU - blur * 2.0,   row) * 1.0;
      c     += sampleRamp(arcU + blur * 2.0,   row) * 1.0;
      return c / 10.0;
    }

    // 2D 9-tap gaussian (3x3) for the patch map. uv in texture space.
    // Patch texture is ClampToEdge on V so we can't sample beyond the
    // rail cross-section; the output is still masked by the rail SDF.
    vec4 blurredPatch(vec2 uv, float blur) {
      if (blur < 1e-4) return texture2D(uPatch, uv);
      // V is scaled to 1/3 of U because the atlas is 3 stacked strips —
      // a UV-space blur radius covers 3× more texels in V than in U.
      // Without this scale, blur in the V direction bleeds across strip
      // boundaries (top patch leaks into center, etc.).
      vec2 b = vec2(blur, blur * (1.0 / 3.0));
      vec4 c = texture2D(uPatch, uv                       ) * 4.0;
      c     += texture2D(uPatch, uv + vec2( b.x,  0.0)    ) * 2.0;
      c     += texture2D(uPatch, uv + vec2(-b.x,  0.0)    ) * 2.0;
      c     += texture2D(uPatch, uv + vec2( 0.0,  b.y)    ) * 2.0;
      c     += texture2D(uPatch, uv + vec2( 0.0, -b.y)    ) * 2.0;
      c     += texture2D(uPatch, uv + vec2( b.x,  b.y)    ) * 1.0;
      c     += texture2D(uPatch, uv + vec2( b.x, -b.y)    ) * 1.0;
      c     += texture2D(uPatch, uv + vec2(-b.x,  b.y)    ) * 1.0;
      c     += texture2D(uPatch, uv + vec2(-b.x, -b.y)    ) * 1.0;
      return c / 16.0;
    }

    // ── Lane data helpers ────────────────────────────────────────────────
    // fetchLane(slot, seg)  -> vec4(sx, y1, y2, valid)
    // Uses NearestFilter on the texture so the sample picks the exact cell.
    vec4 fetchLane(float slot, float seg) {
      float u = (slot + 0.5) / uMaxSlots;
      float v = (seg  + 0.5) / uBufferSegs;
      return texture2D(uLaneData, vec2(u, v));
    }

    // Smootherstep-interpolated Y along a connection. Matches the branch
    // curve character in svg/merge_railsSize.svg, where the chained cubic
    // beziers hold tangent-parallel control points at both endpoints
    // (C1.x == P0.x, C2'.x == P3'.x) — so the rail stays parallel to the
    // axis for longer before peeling off. Ken Perlin's smootherstep
    // s = t^3(6t^2 - 15t + 10) has zero first AND second derivatives at
    // t=0 and t=1, giving that long "held" approach and departure the SVG
    // shows. Previous smoothstep s = t^2(3 - 2t) zeroed only the first
    // derivative, so the curve began bending immediately at the junction.
    float laneYAt(float y1, float y2, float t) {
      float s = t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
      return mix(y1, y2, s);
    }

    // Pick ramp row from average Y position: top lane (neg Y), center,
    // bot lane (pos Y). Rough heuristic — works well enough for the
    // 3-family palette system from the SVG reference.
    int rampRowFor(float yc) {
      float h = uLaneSpace * 0.5;
      if (yc < -h) return 1;  // "top" palette
      if (yc >  h) return 0;  // "bot" palette
      return 2;               // center
    }

    // Count active lanes at segment index segIdx (relative to buffer row 0).
    // Used for per-pixel singleLane / multiLane classification.
    float countLanesAt(int segIdx) {
      if (segIdx < 0 || float(segIdx) >= uBufferSegs) return 0.0;
      float cnt = 0.0;
      for (int s = 0; s < 8; s++) {
        if (float(s) >= uMaxSlots) break;
        vec4 c = fetchLane(float(s), float(segIdx));
        if (c.a < 0.5) break;
        cnt += 1.0;
      }
      return cnt;
    }

    // Max merge-in activity across all connections at segment index segIdx.
    // Activity = abs(y2-y1) / (3 lane widths). Gates the branched-state
    // gradient so only branching segments pull in the ramp colour.
    float branchActAt(int segIdx) {
      if (segIdx < 0 || float(segIdx) >= uBufferSegs) return 0.0;
      float ba = 0.0;
      float dyScale = max(uLaneSpacePerUnit * 3.0, 1.0);
      for (int s = 0; s < 8; s++) {
        if (float(s) >= uMaxSlots) break;
        vec4 c = fetchLane(float(s), float(segIdx));
        if (c.a < 0.5) break;
        ba = max(ba, clamp(abs(c.g - c.b) / dyScale, 0.0, 1.0));
      }
      return ba;
    }

    // Classify a curving connection by scanning the same segment for a
    // parallel straight conn. Matches sim.js emit pattern:
    //   SPLIT emits (la→la) + (la→lb): straight conn shares y1 with branch.
    //   MERGE emits (la→lb) + (lb→lb): straight conn shares y2 with branch.
    //
    // Returns: 0 = straight / isolated, 1 = MERGE (partner at t=1 end),
    //          2 = SPLIT (partner at t=0 end).
    int connPartnerKind(int rSeg, float y1, float y2) {
      if (abs(y2 - y1) < 0.5) return 0;
      int kind = 0;
      for (int s = 0; s < 8; s++) {
        if (float(s) >= uMaxSlots) break;
        vec4 c = fetchLane(float(s), float(rSeg));
        if (c.a < 0.5) break;
        if (abs(c.g - c.b) > 0.5) continue; // only straight partners
        if (abs(c.g - y1) < 0.5) kind = 2; // split
        if (abs(c.g - y2) < 0.5) kind = 1; // merge (wins tie-break)
      }
      return kind;
    }

    // Symmetric smootherstep ribbon. Earlier revisions tried an asymmetric
    // "wedge" shape to mimic svg/merge_railsSize.svg's variable-width merge
    // silhouette, but that produced a visible kink on the inner edge at
    // the trunk junction (matching an artifact in the SVG itself) and
    // offset the ribbon midpoint from laneYAt — which clipped sleepers
    // whose rotation was still computed from smootherstep. The visual
    // "rails flowing together" effect is now produced purely by:
    //   1. Smooth smootherstep centerline for each ribbon.
    //   2. Union of all fills/bodies for alpha (no seam at overlap).
    //   3. Straight-conn priority for palette (centre rail paints on top).
    //
    // The 'kind' parameter is kept in the signature so callers don't need changing.
    vec2 ribbonEdges(float y1, float y2, float t, int kind, float halfW) {
      float tc = clamp(t, 0.0, 1.0);
      float s  = tc * tc * tc * (tc * (tc * 6.0 - 15.0) + 10.0);
      float yc = mix(y1, y2, s);
      return vec2(yc - halfW, yc + halfW);
    }

    // Envelope rail mask — for sleeper clipping only. drawRailTopology uses
    // a nearest-lane SDF, which leaves vertical gaps between diverging rails
    // in a branching region; clipping a sleeper to that mask carves bites
    // out of the pill. Here we union every active lane's contribution at wx
    // so the mask fills the whole band from the topmost to the bottommost
    // rail, including inflation + Gaussian halo (matching the rail look).
    float railEnvelopeMask(float wx, float wy) {
      // Per-pixel single-lane weight (mirrors drawRailTopology so inflation
      // matches between the body render and the sleeper clip).
      float fSegPos = (wx - uLaneOriginX) / uSegW;
      float segRowF = floor(fSegPos);
      int   segRow  = int(segRowF);
      float tXR     = fract(fSegPos);
      int   segNbr  = (tXR > 0.5) ? (segRow + 1) : (segRow - 1);
      float cntCur  = countLanesAt(segRow);
      float cntNei  = countLanesAt(segNbr);
      if (segNbr < 0 || float(segNbr) >= uBufferSegs) cntNei = cntCur;
      float singleCur = (cntCur < 1.5 && cntCur > 0.5) ? 1.0 : 0.0;
      float singleNei = (cntNei < 1.5 && cntNei > 0.5) ? 1.0 : 0.0;
      float edgeR  = abs(tXR - 0.5) * 2.0;
      float blendR = (edgeR * edgeR * (3.0 - 2.0 * edgeR)) * 0.5;
      float singleLane = mix(singleCur, singleNei, blendR);

      float halfW    = uRailWidth;
      float dInflate = halfW * (uWidenFactor - 1.0) * singleLane;
      float effHalfW = halfW + dInflate;
      float sig      = max(uRailSigma, 0.05);
      float softAmt  = clamp(uRailSoft, 0.0, 1.0);
      // fwidth() must be in uniform control flow; hoist pixel-size AA.
      float aa       = max(fwidth(wy), 1e-4);

      float mask = 0.0;
      for (int r = 0; r < 33; r++) {
        if (float(r) >= uBufferSegs) break;
        for (int s = 0; s < 8; s++) {
          if (float(s) >= uMaxSlots) break;
          vec4 conn = fetchLane(float(s), float(r));
          if (conn.a < 0.5) break;
          float sx = conn.r;
          float y1 = conn.g;
          float y2 = conn.b;
          float t  = (wx - sx) / uSegW;
          if (t < -0.01 || t > 1.01) continue;
          int kind = connPartnerKind(r, y1, y2);
          vec2 edges = ribbonEdges(y1, y2, t, kind, halfW);
          float yMid = (edges.x + edges.y) * 0.5;
          float hHalf = (edges.y - edges.x) * 0.5;
          float dY = wy - yMid;
          float dEff = (abs(dY) - hHalf) - dInflate;
          float fill = 1.0 - smoothstep(-aa, aa, dEff);
          float localEffHalf = hHalf + dInflate;
          float yN   = abs(dY) / max(localEffHalf, 1e-4);
          float body = exp(-(yN * yN) / (2.0 * sig * sig)) * softAmt;
          mask = max(mask, max(fill, body));
          if (mask > 0.999) return 1.0; // early out
        }
      }
      return mask;
    }

    // Per-rail palette blend: interpolate between top/center/bot palettes
    // using the lane's Y position (in LANE units, ~[-3,+3] for our sim).
    vec3 railPalette(float yLane, vec3 cC, vec3 cT, vec3 cB) {
      const float yMerge = 3.0;
      float wTop = smoothstep(0.0,  yMerge, yLane);
      float wBot = smoothstep(0.0, -yMerge, yLane);
      vec3 c = mix(cC, cT, wTop);
      c      = mix(c,  cB, wBot);
      return c;
    }

    // Signed distance to an axis-aligned rounded rect in local space.
    float sdRoundBox(vec2 p, vec2 halfSize, float r) {
      vec2 q = abs(p) - halfSize + r;
      return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
    }

    // Rail pass — TD-faithful split/merge port.
    //
    // Per-pixel state computed once:
    //   • segRow, tXR      — which segment / where in it (0..1)
    //   • singleLane       — 1 in merged regions, 0 in branched; smoothed
    //                        between neighbour segments so seams don't snap.
    //   • multiLane        — 1 - singleLane
    //   • branchActSmooth  — per-pixel merge-in activity (|y2-y1|/3 lanes),
    //                        smoothed across segment boundaries.
    //
    // Per-connection colour (winning ribbon):
    //   • Branched-state palette (palX_br) = mix(base, ramp, branchActX)
    //     with per-rail phase offsets (1/3 cycle apart).
    //   • Center rail collapses to (top+bot)/2 in branched state.
    //   • Merged-state palette = ramp at u=0.995 (gradient endpoint).
    //   • sL = max(singleLane, stationSolid, approachWeight) drives the
    //     branched→merged blend.
    //   • Bezier-interpolated colour across y1..y2 via smoothstep(t).
    //
    // Rail SDF widens in single-lane zones (widenFactor * singleLane).
    vec4 drawRailTopology(float wx, float wy) {
      // Segment row containing wx (relative to buffer row 0).
      float fSegPos = (wx - uLaneOriginX) / uSegW;
      float segRowF = floor(fSegPos);
      int   segRow  = int(segRowF);
      float tXR     = fract(fSegPos);
      int   segNbr  = (tXR > 0.5) ? (segRow + 1) : (segRow - 1);

      // Single-lane / branchAct computed at this pixel's segment + neighbour,
      // blended by 'blendR' that rises toward segment edges.
      float cntCur = countLanesAt(segRow);
      float cntNei = countLanesAt(segNbr);
      if (segNbr < 0 || float(segNbr) >= uBufferSegs) cntNei = cntCur;
      float singleCur = (cntCur < 1.5 && cntCur > 0.5) ? 1.0 : 0.0;
      float singleNei = (cntNei < 1.5 && cntNei > 0.5) ? 1.0 : 0.0;
      float edgeR  = abs(tXR - 0.5) * 2.0;
      float blendR = (edgeR * edgeR * (3.0 - 2.0 * edgeR)) * 0.5;
      float singleLane = mix(singleCur, singleNei, blendR);
      float multiLane  = 1.0 - singleLane;

      float baCur = branchActAt(segRow);
      float baNei = branchActAt(segNbr);
      float branchActSmooth = mix(baCur, baNei, blendR);

      // Widen the rail body in single-lane zones. dInflate reduces d so
      // the SDF covers a wider band — matches TD uRailSolidCtrl.x.
      float halfW    = uRailWidth;
      float dInflate = halfW * (uWidenFactor - 1.0) * singleLane;
      float sig      = max(uRailSigma, 0.05);
      float softK    = clamp(uRailSoft, 0.0, 1.0);
      // Pixel-size AA, hoisted out of the loop. fwidth() inside divergent
      // control flow (the per-conn loop has a continue and variable trip
      // count) is undefined in GLSL ES and returns garbage on most drivers —
      // which was wiping the rail entirely. fwidth(wy) is in uniform control
      // flow here and gives the pixel's world-y size, which is the correct
      // anti-alias width for a horizontal ribbon edge anyway.
      float aa       = max(fwidth(wy), 1e-4);

      // ── Gradient palette (computed BEFORE the loop so per-conn colour
      //    accumulation inside the loop can use it). ─────────────────────
      // World-anchored, wrapped sampling. Each rail family gets its OWN
      // phase offset along the world-X axis (uGradPhase{Top,Center,Bot})
      // so the three colour pulses run independently — top/center/bot
      // appear as visually distinct travelling bands instead of a single
      // synced tape glued to wx.
      float period   = max(uPulsePeriod, 1.0);
      float arcU     = wx / period;                 // patches still use this (tiling)
      float gradU_T  = fract(arcU + uGradPhaseTop);
      float gradU_C  = fract(arcU + uGradPhaseCenter);
      float gradU_B  = fract(arcU + uGradPhaseBot);

      vec4 gB = blurredRamp(gradU_B, 0, uGradBlur); // row 0 = bot
      vec4 gT = blurredRamp(gradU_T, 1, uGradBlur); // row 1 = top
      vec4 gC = blurredRamp(gradU_C, 2, uGradBlur); // row 2 = center

      vec3 palB = mix(uRailBotCol,    gB.rgb, uGradOpacity);
      vec3 palT = mix(uRailTopCol,    gT.rgb, uGradOpacity);
      vec3 palC = mix(uRailCenterCol, gC.rgb, uGradOpacity);
      // CENTER-collapse rule (palC = (palT+palB)/2 in branched zones)
      // intentionally removed — center now keeps its own ramp identity
      // through branch zones so all three families read distinctly.

      // Soft-blend radius for per-conn colour weighting. Uses uRailBlend
      // (the same knob that smooths the silhouette) but widened so the
      // colour crossfade kicks in slightly before lanes geometrically
      // overlap — eliminates the visible seam in branch zones.
      float colorSoft = max(uRailBlend * 1.5, halfW * 0.4);
      float invSoft2  = 1.0 / max(colorSoft * colorSoft, 1e-4);

      // Three things happen inside the loop:
      //
      //   • Palette selection — track the "winning" conn by a *biased* score
      //     dChoice (used for patch tinting and edge fade). Straight conns
      //     get a huge negative bias when interior so they always beat
      //     curving conns at the same pixel.
      //
      //   • Coverage compositing — the FILL is unioned via smooth-min across
      //     all lanes, then a single AA pass at the end gives a continuous
      //     silhouette. Body HALO stays max-unioned (atmospheric overlap).
      //
      //   • Colour blending — each lane contributes its own bezier-interp
      //     palette colour, weighted by exp(-max(dEff,0)²/colorSoft²). Inside
      //     overlap regions all overlapping lanes hit weight≈1 so colours
      //     blend smoothly; far-away lanes contribute ~nothing.
      float minD     = 1e9;
      float unionDEff = 1e9;          // SDF union (min) across all lanes
      float dChoice  = 1e9;
      float bestDy   = 0.0;
      float bestT    = 0.0;
      float bestY1   = 0.0;
      float bestY2   = 0.0;
      float bestHalf = uRailWidth;
      int   bestR    = 0;             // segment row of winning conn (for edge fade)
      int   found    = 0;
      float bodyAlpha = 0.0;
      vec3  colSum   = vec3(0.0);     // weighted colour accumulator
      float wSum     = 0.0;

      for (int r = 0; r < 33; r++) {
        if (float(r) >= uBufferSegs) break;
        for (int s = 0; s < 8; s++) {
          if (float(s) >= uMaxSlots) break;
          vec4 conn = fetchLane(float(s), float(r));
          if (conn.a < 0.5) break;
          float sx = conn.r;
          float y1 = conn.g;
          float y2 = conn.b;
          float t  = (wx - sx) / uSegW;
          if (t < -0.01 || t > 1.01) continue;
          int kind = connPartnerKind(r, y1, y2);
          vec2 edges = ribbonEdges(y1, y2, t, kind, uRailWidth);
          float yMid = (edges.x + edges.y) * 0.5;
          float hHalf = (edges.y - edges.x) * 0.5;
          float dY = wy - yMid;
          float d  = abs(dY) - hHalf;

          // SDF union via smooth-min — adjacent lanes whose distance fields
          // are within uRailBlend of each other get blended through a soft
          // bridge instead of meeting at a sharp seam. Polynomial smin:
          //   smin(a, b, k) = min(a, b) - h³·k/6, where h = max(k - |a-b|, 0)/k
          // h is non-zero only when the two distances are close (i.e., near
          // the midpoint between two rails or at a merge), so single rails
          // and far-apart rails are unaffected.
          float dEff = d - dInflate;
          float smk  = max(uRailBlend, 1e-4);
          float h_   = max(smk - abs(dEff - unionDEff), 0.0) / smk;
          unionDEff  = min(unionDEff, dEff) - h_ * h_ * h_ * smk * (1.0 / 6.0);

          // Per-conn colour contribution — weighted by smooth proximity
          // to this lane's body. Lanes containing the fragment (dEff<=0)
          // get full weight; weight falls off over colorSoft outside.
          // Two overlapping lanes both contribute, blending their colours
          // smoothly through the overlap region.
          float dPos = max(dEff, 0.0);
          float wConn = exp(-(dPos * dPos) * invSoft2);
          if (wConn > 1e-3) {
            // Soft 3-way pick by lane-Y, with the transition zone width
            // controlled by uRailColorBlend. Boundaries at yLane = ±0.5.
            // Replaces the old railPalette() smoothstep which used a
            // 3-lane wide window and let center bleed into top/bot.
            float y1L_  = y1 / max(uLaneSpacePerUnit, 1.0);
            float y2L_  = y2 / max(uLaneSpacePerUnit, 1.0);
            float bandR = max(uRailColorBlend, 1e-3);
            float wT1 = smoothstep( 0.5 - bandR,  0.5 + bandR, y1L_);
            float wB1 = smoothstep(-0.5 + bandR, -0.5 - bandR, y1L_);
            float wC1 = max(1.0 - wT1 - wB1, 0.0);
            float wT2 = smoothstep( 0.5 - bandR,  0.5 + bandR, y2L_);
            float wB2 = smoothstep(-0.5 + bandR, -0.5 - bandR, y2L_);
            float wC2 = max(1.0 - wT2 - wB2, 0.0);
            vec3  cA_ = wC1 * palC + wT1 * palT + wB1 * palB;
            vec3  cB_ = wC2 * palC + wT2 * palT + wB2 * palB;
            float tC_  = clamp(t, 0.0, 1.0);
            float kC_  = tC_ * tC_ * (3.0 - 2.0 * tC_);
            colSum    += wConn * mix(cA_, cB_, kC_);
            wSum      += wConn;
          }

          // Body halo stays per-lane, max-unioned (atmospheric haze).
          float effHalfC = hHalf + dInflate;
          float yNormC   = abs(dY) / max(effHalfC, 1e-4);
          float bodyC    = exp(-(yNormC * yNormC) / (2.0 * sig * sig)) * softK;
          bodyAlpha      = max(bodyAlpha, bodyC);

          // Palette selection — biased score so straight conns win overlap.
          bool  isStraight = abs(y2 - y1) < 0.5;
          float dc = (isStraight && d < 0.0) ? (d - 1.0e4) : d;
          if (dc < dChoice) {
            dChoice  = dc;
            minD     = d;
            bestDy   = dY;
            bestT    = clamp(t, 0.0, 1.0);
            bestY1   = y1;
            bestY2   = y2;
            bestHalf = hHalf;
            bestR    = r;
            found    = 1;
          }
        }
      }
      if (found == 0) return vec4(0.0);

      // Coverage from the smooth-unioned SDF — single AA pass on the merged
      // shape gives a continuous silhouette across overlapping lanes.
      float fillCov   = 1.0 - smoothstep(-aa, aa, unionDEff);
      float railAlpha = max(fillCov, bodyAlpha);

      // effHalfW is used below for the cross-section patch tint and for the
      // yNorm used when computing pRv. Keep it consistent with the winning
      // conn's half-width so the patch remains centred.
      float effHalfW = bestHalf + dInflate;
      float railMask = railAlpha;

      // ── Final ribbon colour from per-conn weighted accumulation. ─────
      // Lanes that overlap blend smoothly because each contributes its
      // own bezier-interp palette in proportion to its proximity weight.
      // Falls back to the winning lane's palette if accumulator is empty
      // (shouldn't happen when found==1, but keeps the function safe).
      vec3 col;
      if (wSum > 1e-4) {
        col = colSum / wSum;
      } else {
        float y1Lane = bestY1 / max(uLaneSpacePerUnit, 1.0);
        float y2Lane = bestY2 / max(uLaneSpacePerUnit, 1.0);
        vec3 cA = railPalette(y1Lane, palC, palT, palB);
        vec3 cB = railPalette(y2Lane, palC, palT, palB);
        float kCol = bestT * bestT * (3.0 - 2.0 * bestT);
        col = mix(cA, cB, kCol);
      }

      // Cross-section patch tint — the patch atlas is now 3 stacked strips
      // (bot/top/center, matching rampRowFor's numbering). Each fragment
      // samples the strip for its lane's family so a patch tagged rail='top'
      // only paints onto the top rail.
      //
      // Patch U is WORLD-ANCHORED — arcPos is in world units (mod period),
      // so a patch stays glued to a specific world-X position as the
      // camera scrolls past. Baking converts arcPos→arcPosFrac, so atlas
      // sampling here uses the same arcU as the rail pulse above.
      float pRv  = clamp(0.5 + 0.5 * (bestDy / max(effHalfW, 1e-4)), 0.0, 1.0);
      float laneAvgY = 0.5 * (bestY1 + bestY2);
      int   railFam  = rampRowFor(laneAvgY);   // 0=bot, 1=top, 2=center
      float pStripV  = (pRv + float(railFam)) * (1.0 / 3.0);
      vec4  pP   = blurredPatch(vec2(fract(arcU), pStripV), uPatchBlur);

      // Continuation-aware edge fade — softens the patch alpha where the
      // winning lane terminates with no continuation in the adjacent
      // segment (creates the hard rail-start/end cutoff in branching
      // topology). Lanes that connect into neighbours don't get faded, so
      // long stretches of continuous rail aren't visibly seamed.
      float edgeFade = 1.0;
      if (uPatchEdgeFade > 0.001) {
        float fadeRange = clamp(uPatchEdgeFade, 0.001, 0.5);
        // Look for a connection in the previous segment whose y2 ≈ bestY1
        // (i.e., a lane ending at the same Y as our winning lane's start).
        float startCont = 0.0;
        if (bestR > 0) {
          for (int sl = 0; sl < 8; sl++) {
            if (float(sl) >= uMaxSlots) break;
            vec4 cl = fetchLane(float(sl), float(bestR - 1));
            if (cl.a < 0.5) break;
            if (abs(cl.b - bestY1) < 1.0) { startCont = 1.0; break; }
          }
        }
        // Look for a connection in the next segment whose y1 ≈ bestY2.
        float endCont = 0.0;
        if (float(bestR + 1) < uBufferSegs) {
          for (int sr = 0; sr < 8; sr++) {
            if (float(sr) >= uMaxSlots) break;
            vec4 cr = fetchLane(float(sr), float(bestR + 1));
            if (cr.a < 0.5) break;
            if (abs(cr.g - bestY2) < 1.0) { endCont = 1.0; break; }
          }
        }
        // Fade only where there's no continuation. mix(fade, 1.0, cont)
        // skips the fade when cont=1 (lane continues seamlessly).
        float sFade = mix(smoothstep(0.0, fadeRange, bestT),       1.0, startCont);
        float eFade = mix(smoothstep(1.0, 1.0 - fadeRange, bestT), 1.0, endCont);
        edgeFade = sFade * eFade;
      }

      float pMix = clamp(pP.a * uRailPatchMix * edgeFade, 0.0, 1.0);
      col = mix(col, pP.rgb, pMix);

      return vec4(col * railMask, railMask);
    }

    // Station weight — world-distance kernel for smooth per-sleeper morph.
    //
    // The original port (TD-style row scan) lumped every sleeper in a
    // segment row together: with huge segW the gradient zone collapsed
    // to a single hard pill→station boundary, missing the SVG's 8-stage
    // progression. Instead we now sample lane counts in a window of
    // segment rows, weighted by a smooth WORLD-DISTANCE kernel from the
    // sample point to each segment's center. uStationTransitionWidth (in
    // world units) sets the kernel's half-width — sleepers within ±T of a
    // 1-lane↔N-lane boundary land in the gradient zone and get partial
    // wStation values that vary smoothly per-sleeper, regardless of segW.
    float stationWeight(float wxSample) {
      float wStation = 0.0;
      if (uStationEnable > 0.5) {
        float fSeg        = (wxSample - uLaneOriginX) / uSegW;
        int   sleeperSegR = int(floor(fSeg));
        int   win         = int(clamp(uStationWindow, 0.0, 10.0) + 0.5);
        float T           = max(uStationTransitionWidth, 1.0);

        float acc = 0.0;
        float tot = 0.0;
        // GLSL ES requires constant loop bounds — run +/-10, gate by 'win'.
        for (int s = -10; s <= 10; ++s) {
          if (s < -win || s > win) continue;
          int rr = sleeperSegR + s;
          if (rr < 0 || float(rr) >= uBufferSegs) continue;
          // Smooth world-distance kernel: full weight within ±0.5T of
          // the sample, fading to zero past ±1.5T. Adjacent sleepers see
          // slightly different weights → smoothly varying wStation.
          float segCenterWx = (float(rr) + 0.5) * uSegW + uLaneOriginX;
          float d = abs(segCenterWx - wxSample);
          float k = 1.0 - smoothstep(0.5 * T, 1.5 * T, d);
          if (k < 1e-4) continue;
          float cnt = countLanesAt(rr);
          acc += k * ((abs(cnt - 1.0) < 0.5) ? 1.0 : 0.0);
          tot += k;
        }
        wStation = (tot > 1e-4) ? (acc / tot) : 0.0;
      }
      // Timeline force — max'd with auto-detect so a manual stationSolid
      // override always wins upward (use 0 to let auto-detect drive).
      wStation = max(wStation, clamp(uStationSolid, 0.0, 1.0));
      return clamp(wStation, 0.0, 1.0);
    }

    // Sleeper pass — pills morph into station rectangles when wStation→1.
    // Mirrors /project1/prototype_glsl/pixel exactly:
    //   • Per-connection snap: each lane independently snaps to the nearest
    //     sleeper, so two divergent lanes at the same wx draw two sleepers
    //     (one at each lane's yc), not one fused rotated quad.
    //   • OWNERSHIP GATE: each sleeper is drawn ONCE — only by the segment
    //     row whose bezier geometrically contains the sleeper's center.
    //     Without this, a sleeper near a segment edge gets re-drawn against
    //     adjacent rows' yc and the min() picks chevron-shaped unions.
    //   • Axis-aligned (no tDir/nDir rotation). Matches TD's reference look
    //     and avoids the extreme rotation artifacts that appear at sharp
    //     branches when dydt is large.
    //   • snap grid widens by uStationSpacingMul (only every Nth pill keeps
    //     a slot, giving stations a wider footprint without overlap).
    //   • inner box half-extents lerp pill→station; corner round→sharp.
    //   • inner color lerps uSleeperColor→uStationInnerCol.
    //   • outer body box appears at wStation>0, sized as uStationBodyMul ×
    //     inner, drawn UNDER the inner so the inner reads as the platform.
    vec4 drawSleepers(float wx, float wy) {
      // ── Single-pass per-pill morph ────────────────────────────────────
      // ONE eased weight w drives BOTH the pill (W, H, corner, colour) AND
      // the snap spacing — together. As w: 0→1 each pill grows from sleeper
      // (8×44) to station (187×69) while spacing widens spF → spF*N. Because
      // shape and spacing share the same curve, every pill that is visible
      // at the start morphs continuously into a station; pills "between"
      // station-elects coalesce into the widening neighbours. No fade-out,
      // no vanishing — the pill geometry IS the morph.
      //
      // The original bug here was four separate eased curves (width, height,
      // colour, easingAmt) that desynced shape from spacing — pills barely
      // started growing before the snap grid widened past them, so they
      // visually disappeared. Sharing one curve fixes that.

      int segRowI = int(floor((wx - uLaneOriginX) / uSegW));

      float minDInner = 1e9;
      float winLx = 0.0, winLy = 0.0;
      vec3  winCol   = uSleeperColor;
      float winW     = 0.0;   // for body halo — eased pill weight
      int   hit = 0;

      for (int rowOff = -1; rowOff <= 1; rowOff++) {
        int r = segRowI + rowOff;
        if (r < 0 || float(r) >= uBufferSegs) continue;

        // Per-row morph weight, evaluated at the row centre. Stable for
        // every fragment in this row so each pill's SDF agrees on w.
        float wxRow = (float(r) + 0.5) * uSegW + uLaneOriginX;
        float wRaw  = stationWeight(wxRow);
        // Single eased curve — linear (uMorphCurve=0) ↔ smootherstep (=1).
        float wSm   = wRaw*wRaw*wRaw*(wRaw*(wRaw*6.0-15.0)+10.0);
        float w     = mix(wRaw, wSm, clamp(uMorphCurve, 0.0, 1.0));

        float N    = max(uStationEvery, 1.0);
        // Spacing AND shape both interpolate on the same w.
        float spEff     = mix(uSleeperSpacing, uSleeperSpacing * N, w);
        float effW      = mix(uSleeperW,       uStationW,           w);
        float effH      = mix(uSleeperH,       uStationH,           w);
        float effCorner = mix(uSleeperCorner,  uStationCorner,      w);

        for (int s = 0; s < 8; s++) {
          if (float(s) >= uMaxSlots) break;
          vec4 conn = fetchLane(float(s), float(r));
          if (conn.a < 0.5) break;
          float sx = conn.r;
          float y1 = conn.g;
          float y2 = conn.b;
          float t  = (wx - sx) / uSegW;
          if (t < -0.5 || t > 1.5) continue;
          float tc = clamp(t, 0.0, 1.0);
          float yc = laneYAt(y1, y2, tc);

          float sIdx = floor(wx / spEff + 0.5);
          float sleeperCenterWx = sIdx * spEff;

          // OWNERSHIP GATE — pill drawn ONLY from its owning segment row.
          int sleeperSegR = int(floor((sleeperCenterWx - uLaneOriginX) / uSegW));
          if (sleeperSegR != r) continue;

          float lx = wx - sleeperCenterWx;
          float ly = wy - yc;
          float dI = sdRoundBox(vec2(lx, ly), vec2(effW, effH), effCorner);
          if (dI < minDInner) {
            // Per-rail colour — soft 3-way blend by lane-Y, then eased
            // sleeper → station mix on the same w.
            float h_   = uLaneSpace * 0.5;
            float band = max(uLaneSpace * uSleeperColorBlend, 1e-3);
            float wTopS = smoothstep( h_ - band,  h_ + band,  yc);
            float wBotS = smoothstep(-h_ + band, -h_ - band,  yc);
            float wCenS = max(1.0 - wTopS - wBotS, 0.0);
            vec3 sCol  = wCenS * uSleeperColor
                       + wTopS * uSleeperColorTop
                       + wBotS * uSleeperColorBot;
            vec3 stCol = wCenS * uStationInnerCol
                       + wTopS * uStationInnerColTop
                       + wBotS * uStationInnerColBot;

            minDInner = dI;
            winLx = lx; winLy = ly;
            winCol = mix(sCol, stCol, w);
            winW   = w;
            hit = 1;
          }
        }
      }
      if (hit == 0) return vec4(0.0);

      // Inner pill alpha — SDF-derivative AA stays stable because winLx /
      // winLy / minDInner all come from the same pill.
      float aaI    = max(fwidth(minDInner), 1e-4);
      float innerA = (1.0 - smoothstep(-aaI, aaI, minDInner)) * uSleeperOpacity;

      // Optional body halo behind the inner — sized off the eased weight
      // so it grows in lock step with the visible pill.
      float bodyA = 0.0;
      if (winW > 1e-4 && (uStationBodyMul.x > 1e-4 || uStationBodyMul.y > 1e-4)) {
        float bodyW      = uStationW * uStationBodyMul.x * winW;
        float bodyH      = uStationH * uStationBodyMul.y * winW;
        float bodyCorner = uStationCorner * winW;
        float dB         = sdRoundBox(vec2(winLx, winLy), vec2(bodyW, bodyH), bodyCorner);
        float aaB        = max(fwidth(dB), 1e-4);
        bodyA            = (1.0 - smoothstep(-aaB, aaB, dB)) * uSleeperOpacity * winW;
      }

      // Composite: body under, inner over (straight alpha).
      vec3  outRGB = uStationBodyCol * bodyA;
      float outA   = bodyA;
      outRGB = winCol * innerA + outRGB * (1.0 - innerA);
      outA   = innerA          + outA   * (1.0 - innerA);
      return vec4(outRGB, outA);
    }

    void main() {
      // Screen → world. viewH is how many world units fit vertically;
      // uZoom scales that (smaller zoom = see more). The shader works
      // in absolute world coords, not lane_origin-relative.
      float aspect = uResolution.x / uResolution.y;
      float viewH  = 1000.0 / uZoom;
      float viewW  = viewH * aspect;
      float wx = uCameraX + (vUV.x - 0.5) * viewW;
      float wy = (vUV.y - 0.5) * viewH;

      // Rails (topology-driven) + sleepers on top.
      vec4 rail    = drawRailTopology(wx, wy);
      vec4 sleeper = drawSleepers(wx, wy);

      // Rail constraint — clip sleeper alpha to the rail envelope. We union
      // *all* active lanes at this wx rather than using rail.a (which is the
      // nearest-lane mask and leaves gaps between diverging rails in a
      // branching zone). With the envelope, a sleeper body sitting across a
      // fork is clipped to the outer perimeter of the whole rail bundle
      // instead of being carved up where no single lane dominates.
      float railEnv  = (uSleeperRailClip > 0.001) ? railEnvelopeMask(wx, wy) : 1.0;
      float railClip = mix(1.0, railEnv, clamp(uSleeperRailClip, 0.0, 1.0));
      sleeper.rgb *= railClip;
      sleeper.a   *= railClip;

      // Over-composite: rail below, sleepers on top.
      vec4 acc = rail;
      acc.rgb = sleeper.rgb + acc.rgb * (1.0 - sleeper.a);
      acc.a   = sleeper.a   + acc.a   * (1.0 - sleeper.a);

      // World-anchored grain modulation — unchanged from the static layout.
      if (uGrainAmount > 0.0) {
        vec2 nuv = vec2(wx, wy) * (uGrainScale * 0.001);
        float n  = fbm(nuv);
        acc.rgb *= (1.0 - uGrainAmount) + uGrainAmount * n * 2.0;
      }

      // Composite over background so the bgColor uniform actually shows
      // through in empty regions (acc.a = 0 outside rail/sleeper coverage).
      vec3 outRgb = acc.rgb + uBgColor * (1.0 - acc.a);
      gl_FragColor = vec4(outRgb, 1.0);
    }
  `,
});

const quad = new THREE.Mesh(geo, mat);
scene.add(quad);

// Resize handler updates the uResolution uniform.
function updateResolution() {
  const size = new THREE.Vector2();
  renderer.getSize(size);
  mat.uniforms.uResolution.value.set(size.x, size.y);
}
window.addEventListener('resize', updateResolution);
updateResolution();

// ── Animation loop ───────────────────────────────────────────────────────
// Each frame:
//   1. Advance cameraX by CONFIG.speed * dt.
//   2. Rebuild lane_data so the buffer window tracks the new camera X.
//   3. Push uCameraX into the shader.
// The sim's SEG_W and lane positions are static; only the buffer window shifts.
const clock = new THREE.Clock();
// EXPORT.active=true pauses the live loop so the PNG exporter can drive
// frames deterministically (fixed dt, reset cameraX/uTime/uScrollX) without
// the rAF loop racing it.
const EXPORT = { active: false };
function tick() {
  if (EXPORT.active) { requestAnimationFrame(tick); return; }
  const dt = clock.getDelta();
  mat.uniforms.uTime.value += dt;
  mat.uniforms.uScrollX.value += CONFIG.speed * dt;

  // Advance camera + rebuild lane data window.
  WORLD.cameraX += CONFIG.speed * dt;
  // Scripted mode: content is periodic on WORLD_LOOP, wrap to keep numbers
  // bounded. Procedural mode: WORLD_LOOP = Infinity, so skip the wrap and
  // let the cache grow forward forever.
  const worldLoop = SIM.WORLD_LOOP;
  if (Number.isFinite(worldLoop) && WORLD.cameraX >= worldLoop) WORLD.cameraX -= worldLoop;
  rebuildLaneData();
  mat.uniforms.uCameraX.value     = WORLD.cameraX;
  mat.uniforms.uLaneOriginX.value = WORLD.laneOriginSeg * CONFIG.segW;

  renderer.render(scene, camera);
  // Update the minimap playhead at ~10 Hz so it doesn't steal frame budget.
  if ((tick._acc = (tick._acc || 0) + dt) >= 0.1) {
    tick._acc = 0;
    if (typeof updateMinimapPlayhead === 'function') updateMinimapPlayhead();
  }
  requestAnimationFrame(tick);
}
tick();

// ── PNG sequence exporter ────────────────────────────────────────────────
// Pauses the live tick, drives the sim with a fixed dt = 1/fps, captures
// each frame as a PNG, packages them into a zip via JSZip, and triggers
// a download. Scripted mode → frames default to one full WORLD_LOOP, so
// the result is a seamless loop. Procedural mode → user must specify
// frame count (no natural loop).
window.exportPngSequence = async function exportPngSequence(opts = {}) {
  const fps      = opts.fps       || 60;
  const prefix   = opts.prefix    || 'railway';
  const onProg   = opts.onProgress || (() => {});
  const wl       = SIM.WORLD_LOOP;
  const autoFrames = Number.isFinite(wl) ? Math.max(1, Math.round((wl / CONFIG.speed) * fps)) : 240;
  const frames   = opts.frames || autoFrames;

  if (typeof JSZip === 'undefined') {
    alert('JSZip not loaded — check the script tag in index-three.html');
    return;
  }

  // Snapshot live state so we can restore it after export.
  const saved = {
    cameraX: WORLD.cameraX,
    uTime:   mat.uniforms.uTime.value,
    uScroll: mat.uniforms.uScrollX.value,
  };

  EXPORT.active = true;
  WORLD.cameraX = 0;
  mat.uniforms.uTime.value    = 0;
  mat.uniforms.uScrollX.value = 0;

  const zip = new JSZip();
  const dt  = 1 / fps;

  try {
    for (let i = 0; i < frames; i++) {
      // Render the current state.
      rebuildLaneData();
      mat.uniforms.uCameraX.value     = WORLD.cameraX;
      mat.uniforms.uLaneOriginX.value = WORLD.laneOriginSeg * CONFIG.segW;
      renderer.render(scene, camera);

      const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
      const name = `${prefix}_${String(i).padStart(4, '0')}.png`;
      zip.file(name, blob);

      // Advance for the next frame.
      mat.uniforms.uTime.value    += dt;
      mat.uniforms.uScrollX.value += CONFIG.speed * dt;
      WORLD.cameraX += CONFIG.speed * dt;
      if (Number.isFinite(wl) && WORLD.cameraX >= wl) WORLD.cameraX -= wl;

      // Yield to the browser every few frames so the UI stays responsive
      // and the progress callback can repaint.
      if ((i & 3) === 0) {
        onProg({ phase: 'render', frame: i, total: frames });
        await new Promise(r => setTimeout(r, 0));
      }
    }

    onProg({ phase: 'zip', frame: frames, total: frames });
    const zipBlob = await zip.generateAsync(
      { type: 'blob', compression: 'STORE' },
      meta => onProg({ phase: 'zip', percent: meta.percent })
    );

    const url = URL.createObjectURL(zipBlob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${prefix}_${frames}f_${fps}fps.zip`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    onProg({ phase: 'done', frame: frames, total: frames });
  } finally {
    // Restore live state and unpause.
    WORLD.cameraX               = saved.cameraX;
    mat.uniforms.uTime.value    = saved.uTime;
    mat.uniforms.uScrollX.value = saved.uScroll;
    EXPORT.active = false;
    clock.getDelta(); // discard the gap so live tick doesn't jump
  }
};

// Wire UI buttons (added in index-three.html).
(function wireExportUI() {
  const btn      = document.getElementById('export-png-seq');
  const btnSnap  = document.getElementById('export-png-snap');
  const fpsIn    = document.getElementById('export-fps');
  const framesIn = document.getElementById('export-frames');
  const status   = document.getElementById('export-status');
  if (!btn) return;

  btn.addEventListener('click', async () => {
    const fps    = parseInt(fpsIn.value, 10)    || 60;
    const frames = parseInt(framesIn.value, 10) || 0; // 0 = auto (one loop)
    btn.disabled = true;
    try {
      await window.exportPngSequence({
        fps,
        frames: frames > 0 ? frames : null,
        onProgress: ({ phase, frame, total, percent }) => {
          if (phase === 'render') status.textContent = `frame ${frame}/${total}`;
          else if (phase === 'zip') status.textContent = percent != null ? `zipping ${percent.toFixed(0)}%` : 'zipping…';
          else if (phase === 'done') status.textContent = `done (${total} frames)`;
        },
      });
    } catch (err) {
      console.error(err);
      status.textContent = `error: ${err.message}`;
    } finally {
      btn.disabled = false;
    }
  });

  if (btnSnap) {
    btnSnap.addEventListener('click', () => {
      // Render the current frame fresh so toBlob gets a guaranteed-valid buffer.
      renderer.render(scene, camera);
      canvas.toBlob(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `railway_${Date.now()}.png`;
        a.click();
        URL.revokeObjectURL(url);
      }, 'image/png');
    });
  }
})();

// ── UI wiring ────────────────────────────────────────────────────────────
// Global controls bind [data-k="CONFIG_KEY"] inputs → CONFIG → uniforms.
// Patch controls are generated per-row from PATCH_TABLE and trigger a
// re-bake of the patch DataTexture when any patch param changes.

function rgbToHex([r, g, b]) {
  const clamp = (x) => Math.max(0, Math.min(255, Math.round(x * 255)));
  const h = (n) => n.toString(16).padStart(2, '0');
  return '#' + h(clamp(r)) + h(clamp(g)) + h(clamp(b));
}
function hexToRgbNormalized(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
}

// Apply CONFIG values to uniforms on every change.
function applyConfig() {
  mat.uniforms.uZoom.value         = CONFIG.viewZoom;
  mat.uniforms.uLaneSpace.value    = CONFIG.laneSpace;
  mat.uniforms.uRailWidth.value    = CONFIG.railWidth;
  mat.uniforms.uRailSoft.value     = CONFIG.railSoft;
  mat.uniforms.uRailSigma.value    = CONFIG.railSigma;
  mat.uniforms.uRailBlend.value    = CONFIG.railBlend;
  // Rebake patch atlas only when pulsePeriod actually changed — arcPos
  // is in world units, so its atlas position depends on period.
  if (Math.abs(mat.uniforms.uPulsePeriod.value - CONFIG.pulsePeriod) > 0.5) {
    mat.uniforms.uPulsePeriod.value = CONFIG.pulsePeriod;
    if (typeof rebakePatchTexture === 'function') rebakePatchTexture();
  } else {
    mat.uniforms.uPulsePeriod.value = CONFIG.pulsePeriod;
  }
  mat.uniforms.uRailPatchMix.value = CONFIG.railPatchMix;
  mat.uniforms.uGradPhaseTop.value    = CONFIG.gradPhaseTop;
  mat.uniforms.uGradPhaseCenter.value = CONFIG.gradPhaseCenter;
  mat.uniforms.uGradPhaseBot.value    = CONFIG.gradPhaseBot;
  mat.uniforms.uRailColorBlend.value  = CONFIG.railColorBlend;
  mat.uniforms.uRailColor.value.set(CONFIG.railColor);
  mat.uniforms.uGradOpacity.value  = CONFIG.gradOpacity;
  mat.uniforms.uGradBlur.value     = CONFIG.gradBlur;
  mat.uniforms.uPatchBlur.value    = CONFIG.patchBlur;
  mat.uniforms.uPatchEdgeFade.value = CONFIG.patchEdgeFade;
  mat.uniforms.uGrainAmount.value  = CONFIG.grainAmount;
  mat.uniforms.uGrainScale.value   = CONFIG.grainScale;
  // Topology — push to SIM (invalidates its cache) and shader.
  SIM.setScript(CONFIG.simScript);
  SIM.setLoopSegs(CONFIG.loopSegs);
  SIM.setSegW(CONFIG.segW);
  SIM.setLaneSpace(CONFIG.laneSpace);
  // Procedural-mode params — setters trigger procReset() when changed.
  SIM.setSeed(CONFIG.seed);
  SIM.setMergeChance(CONFIG.mergeChance);
  SIM.setSplitChance(CONFIG.splitChance);
  SIM.setMaxTracks(CONFIG.maxTracks);
  SIM.setMode(CONFIG.simMode);
  rebuildLaneData();
  mat.uniforms.uSegW.value          = CONFIG.segW;
  // TD split/merge uniforms
  mat.uniforms.uRailCenterCol.value.set(CONFIG.railCenterCol);
  mat.uniforms.uRailTopCol.value.set(CONFIG.railTopCol);
  mat.uniforms.uRailBotCol.value.set(CONFIG.railBotCol);
  mat.uniforms.uStationSolid.value    = CONFIG.stationSolid;
  mat.uniforms.uApproachWeight.value  = CONFIG.approachWeight;
  mat.uniforms.uLaneSpacePerUnit.value = CONFIG.laneSpace;
  // Sleepers
  mat.uniforms.uSleeperSpacing.value = CONFIG.sleeperSpacing;
  mat.uniforms.uSleeperW.value       = CONFIG.sleeperW;
  mat.uniforms.uSleeperH.value       = CONFIG.sleeperH;
  mat.uniforms.uSleeperCorner.value  = CONFIG.sleeperCorner;
  mat.uniforms.uSleeperColor.value.set(CONFIG.sleeperColor);
  mat.uniforms.uSleeperColorTop.value.set(CONFIG.sleeperColorTop);
  mat.uniforms.uSleeperColorBot.value.set(CONFIG.sleeperColorBot);
  mat.uniforms.uSleeperColorBlend.value = CONFIG.sleeperColorBlend;
  mat.uniforms.uSleeperOpacity.value = CONFIG.sleeperOpacity;
  mat.uniforms.uSleeperRailClip.value = CONFIG.sleeperRailClip;
  mat.uniforms.uMorphCurve.value             = CONFIG.morphCurve;
  // Pill → station morph
  mat.uniforms.uStationEnable.value          = CONFIG.stationEnable;
  mat.uniforms.uStationWindow.value          = CONFIG.stationWindow;
  mat.uniforms.uStationTransitionWidth.value = CONFIG.stationTransitionWidth;
  mat.uniforms.uStationEvery.value           = CONFIG.stationEvery;
  mat.uniforms.uStationW.value          = CONFIG.stationW;
  mat.uniforms.uStationH.value          = CONFIG.stationH;
  mat.uniforms.uStationCorner.value     = CONFIG.stationCorner;
  mat.uniforms.uStationBodyMul.value.set(CONFIG.stationBodyWmul, CONFIG.stationBodyHmul);
  mat.uniforms.uStationInnerCol.value.set(CONFIG.stationInnerCol);
  mat.uniforms.uStationInnerColTop.value.set(CONFIG.stationInnerColTop);
  mat.uniforms.uStationInnerColBot.value.set(CONFIG.stationInnerColBot);
  mat.uniforms.uStationBodyCol.value.set(CONFIG.stationBodyCol);
  renderer.setClearColor(new THREE.Color(CONFIG.bgColor));
  mat.uniforms.uBgColor.value.set(CONFIG.bgColor);
  // No canvas CSS filter — blur lives inside the shader now, per-layer,
  // so the rail mask can keep it inside the rail SDF bounds.
  canvas.style.filter = '';
  // Minimap reflects sim-state changes (script, loopSegs, colours, lanes).
  if (typeof buildMinimap === 'function') buildMinimap();
  // Mode-conditional panel visibility — hide controls that don't apply to
  // the current sim mode so the panel doesn't show dead knobs.
  const scriptedOnly   = document.getElementById('scripted-only');
  const proceduralOnly = document.getElementById('procedural-only');
  if (scriptedOnly)   scriptedOnly.style.display   = CONFIG.simMode === 'scripted'   ? '' : 'none';
  if (proceduralOnly) proceduralOnly.style.display = CONFIG.simMode === 'procedural' ? '' : 'none';
}

// Wire every [data-k] input in the panel.
function bindGlobalControls() {
  document.querySelectorAll('#panel input[data-k], #panel select[data-k]').forEach((el) => {
    const key = el.dataset.k;
    if (!(key in CONFIG)) return;
    const isNum   = el.type === 'range' || el.type === 'number';
    const isBool  = el.type === 'checkbox';
    const isColor = el.type === 'color';
    // Initialise DOM from CONFIG
    if (isBool)       el.checked = !!CONFIG[key];
    else              el.value   = CONFIG[key];
    const readout = document.querySelector(`#panel [data-v="${key}"]`);
    if (readout) readout.textContent = isNum ? (+CONFIG[key]).toFixed(2) : String(CONFIG[key]);
    el.addEventListener('input', () => {
      const v = isBool  ? el.checked
              : isNum   ? parseFloat(el.value)
              : isColor ? el.value
              : el.value;
      CONFIG[key] = v;
      if (readout) readout.textContent = isNum ? v.toFixed(2) : String(v);
      applyConfig();
    });
  });
}

// ── Topology minimap (SVG) ───────────────────────────────────────────────
// Inline diagram of the full loop: ribbons = active connections, width
// widens on single-lane/station zones. Playhead shows current cameraX.
// Click to seek the camera to that segment.
const SVG_NS = 'http://www.w3.org/2000/svg';
const MM = { W: 600, H: 110, PAD_X: 6, PAD_Y: 8 };
let minimapPlayhead = null;

function mmSegX(n, loopSegs) {
  return MM.PAD_X + (n / loopSegs) * (MM.W - 2 * MM.PAD_X);
}
// Flipped so lane 0 is at the BOTTOM, matching the shader. In the shader
// wy = (vUV.y - 0.5) * viewH, so positive wy = top of screen, and since
// SIM.laneToY(0) = -(centerIdx)*laneSpace (negative), lane 0 renders at
// the bottom. The minimap mirrors that: y = H - PAD_Y for lane 0.
function mmLaneY(l, laneCount) {
  const span = Math.max(1, laneCount - 1);
  return MM.H - MM.PAD_Y - (l / span) * (MM.H - 2 * MM.PAD_Y);
}

// Cubic bezier from (x1,y1) to (x2,y2) with control points anchored at
// the endpoints' y-values — curve is flat at both ends, matching the
// chained-cubic shape in svg/merge_railsSize.svg and the shader's
// smootherstep laneYAt.
function mmSmoothstepPath(x1, y1, x2, y2) {
  const cpx = x1 + (x2 - x1) * 0.5;
  return `M ${x1.toFixed(1)} ${y1.toFixed(1)} ` +
         `C ${cpx.toFixed(1)} ${y1.toFixed(1)}, ${cpx.toFixed(1)} ${y2.toFixed(1)}, ${x2.toFixed(1)} ${y2.toFixed(1)}`;
}

// In procedural mode the track never loops — show a rolling window
// [cameraSeg - WINDOW_BEHIND, cameraSeg + WINDOW_AHEAD]. In scripted mode
// we show the full loop, and x is segment index mod loopSegs.
const MM_WINDOW_BEHIND = 6;
const MM_WINDOW_AHEAD  = 30;

function minimapWindow() {
  if (SIM.MODE === 'procedural') {
    const camSeg = Math.max(0, Math.floor(WORLD.cameraX / CONFIG.segW));
    const from = Math.max(0, camSeg - MM_WINDOW_BEHIND);
    const to   = from + (MM_WINDOW_BEHIND + MM_WINDOW_AHEAD); // fixed span
    return { from, to, span: to - from, wrapping: false };
  }
  const span = SIM.LOOP_SEGS;
  return { from: 0, to: span, span, wrapping: true };
}

function buildMinimap() {
  const svg = document.getElementById('minimap');
  if (!svg) return;
  const laneCount = SIM.LANE_COUNT;
  const win = minimapWindow();
  const loopSegs  = win.span;
  svg.innerHTML = '';
  svg.setAttribute('viewBox', `0 0 ${MM.W} ${MM.H}`);

  // Lane guide lines — subtle horizontal grid
  for (let l = 0; l < laneCount; l++) {
    const y = mmLaneY(l, laneCount);
    const ln = document.createElementNS(SVG_NS, 'line');
    ln.setAttribute('x1', MM.PAD_X); ln.setAttribute('x2', MM.W - MM.PAD_X);
    ln.setAttribute('y1', y); ln.setAttribute('y2', y);
    ln.setAttribute('stroke', 'rgba(255,255,255,0.04)');
    ln.setAttribute('stroke-width', 1);
    svg.appendChild(ln);
  }

  // Base stroke width — thicker when fewer lanes so single-lane zones read
  // as a fat capsule, matching the shader's widenFactor behaviour.
  const laneStep = (MM.H - 2 * MM.PAD_Y) / Math.max(1, laneCount - 1);
  const baseW    = Math.max(2, laneStep * 0.38);

  // Station highlight colours — sample the RAMPS' merged-state endpoints
  // so the minimap shares the palette with the main render.
  const lastStop = (ramp) => ramp[ramp.length - 1][1];
  const palTop = lastStop(RAMPS.top);
  const palCen = lastStop(RAMPS.center);
  const palBot = lastStop(RAMPS.bot);
  const centerIdx = (laneCount - 1) / 2;

  // One path per connection, ribbons drawn left-to-right.
  for (let i = 0; i < loopSegs; i++) {
    const n = win.from + i;
    const conns = SIM.connectionsAt(n) || [];
    const activeCount = SIM.activeLanesAt(n).length;
    const isStation = activeCount === 1;
    const x1 = mmSegX(i, loopSegs);
    const x2 = mmSegX(i + 1, loopSegs);
    for (const c of conns) {
      const y1 = mmLaneY(c.y1, laneCount);
      const y2 = mmLaneY(c.y2, laneCount);
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', mmSmoothstepPath(x1, y1, x2, y2));
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', CONFIG.railColor);
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-width', isStation ? baseW * 1.6 : baseW);
      svg.appendChild(path);

      // Station highlight: a thin palette-tinted overlay on top
      if (isStation) {
        const lane = c.y1; // y1===y2 in single-lane pass-through
        const col = lane < centerIdx ? palTop : lane > centerIdx ? palBot : palCen;
        const glow = document.createElementNS(SVG_NS, 'path');
        glow.setAttribute('d', mmSmoothstepPath(x1, y1, x2, y2));
        glow.setAttribute('fill', 'none');
        glow.setAttribute('stroke', col);
        glow.setAttribute('stroke-linecap', 'round');
        glow.setAttribute('stroke-width', baseW * 0.6);
        glow.setAttribute('stroke-opacity', 0.55);
        svg.appendChild(glow);
      }
    }
  }

  // Event markers — scripted mode: read declared events; procedural mode:
  // infer by comparing active-lane counts segment-to-segment.
  if (win.wrapping) {
    const script = SIM.SCRIPTS[CONFIG.simScript] || [];
    for (const ev of script) {
      const t = String(ev.type).toUpperCase();
      if (t !== 'SPLIT' && t !== 'MERGE') continue;
      const x = mmSegX(ev.seg, loopSegs);
      const mk = document.createElementNS(SVG_NS, 'circle');
      mk.setAttribute('cx', x);
      mk.setAttribute('cy', MM.H - 3);
      mk.setAttribute('r', 2);
      mk.setAttribute('fill', t === 'SPLIT' ? '#EBF4D1' : '#E0B77E');
      mk.setAttribute('fill-opacity', 0.7);
      svg.appendChild(mk);
    }
  } else {
    for (let i = 0; i < loopSegs; i++) {
      const n = win.from + i;
      const a = SIM.activeLanesAt(n).length;
      const b = SIM.activeLanesAt(n + 1).length;
      if (a === b) continue;
      const mk = document.createElementNS(SVG_NS, 'circle');
      mk.setAttribute('cx', mmSegX(i + 1, loopSegs));
      mk.setAttribute('cy', MM.H - 3);
      mk.setAttribute('r', 2);
      mk.setAttribute('fill', b > a ? '#EBF4D1' : '#E0B77E');
      mk.setAttribute('fill-opacity', 0.7);
      svg.appendChild(mk);
    }
  }

  // Playhead — vertical line at current cameraX
  const ph = document.createElementNS(SVG_NS, 'line');
  ph.setAttribute('y1', 0); ph.setAttribute('y2', MM.H);
  ph.setAttribute('stroke', '#fff');
  ph.setAttribute('stroke-opacity', 0.55);
  ph.setAttribute('stroke-width', 1);
  ph.setAttribute('pointer-events', 'none');
  svg.appendChild(ph);
  minimapPlayhead = ph;

  // Click-to-seek — scripted: absolute seg index within [0, loopSegs).
  // Procedural: seek relative to the current rolling window origin.
  svg.onclick = (e) => {
    const rect = svg.getBoundingClientRect();
    const xN = ((e.clientX - rect.left) / rect.width) * MM.W;
    const tSeg = ((xN - MM.PAD_X) / (MM.W - 2 * MM.PAD_X)) * loopSegs;
    const target = win.from + tSeg;
    const clamped = win.wrapping
      ? Math.max(0, Math.min(loopSegs - 0.001, target))
      : Math.max(0, target);
    WORLD.cameraX = clamped * CONFIG.segW;
    rebuildLaneData();
    mat.uniforms.uCameraX.value     = WORLD.cameraX;
    mat.uniforms.uLaneOriginX.value = WORLD.laneOriginSeg * CONFIG.segW;
    // Rebuild so window follows the new camera position in procedural mode.
    if (!win.wrapping) buildMinimap();
    else updateMinimapPlayhead();
  };

  // Remember which window we drew so the playhead places itself correctly
  // and procedural mode can auto-rebuild when camera scrolls off-window.
  buildMinimap._win = win;

  updateMinimapPlayhead();
}

function updateMinimapPlayhead() {
  if (!minimapPlayhead) return;
  const drawn = buildMinimap._win;
  if (!drawn) return;
  const camSeg = WORLD.cameraX / CONFIG.segW;

  if (drawn.wrapping) {
    const loopSegs = drawn.span;
    const segN = ((camSeg) % loopSegs + loopSegs) % loopSegs;
    const x = mmSegX(segN, loopSegs);
    minimapPlayhead.setAttribute('x1', x);
    minimapPlayhead.setAttribute('x2', x);
    return;
  }

  // Procedural: rolling window. Rebuild only when the ideal `from` would
  // actually move — otherwise the camera sitting near seg 0 (where `from`
  // is clamped at 0) would trigger infinite rebuild→update→rebuild recursion.
  const relSeg = camSeg - drawn.from;
  const idealFrom = Math.max(0, Math.floor(camSeg) - MM_WINDOW_BEHIND);
  if (idealFrom !== drawn.from && (relSeg < 2 || relSeg > drawn.span - 4)) {
    buildMinimap();
    return;
  }
  const x = mmSegX(relSeg, drawn.span);
  minimapPlayhead.setAttribute('x1', x);
  minimapPlayhead.setAttribute('x2', x);
}

// Rebuild the patch DataTexture from the current PATCH_TABLE — module-scope
// so preset-apply can also call it after swapping patch rows.
function rebakePatchTexture() {
  const newTex = buildPatchTexture(PATCH_TABLE, CONFIG.pulsePeriod);
  mat.uniforms.uPatch.value.dispose();
  mat.uniforms.uPatch.value = newTex;
}

// Build one control row per patch, wire each input to re-bake the texture.
// Each row has an "×" remove button; after the list, a single "+ Add patch"
// button appends a fresh patch. Any add/remove rebuilds the rows so the
// indices shown in the headings stay in sync.
function buildPatchRows() {
  const host = document.getElementById('patch-section');
  if (!host) return;
  // Clear any existing rows — applyPreset calls this fresh after loading.
  host.innerHTML = '';

  PATCH_TABLE.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'patch-row';
    const vmodeOpts = ['bell', 'bot', 'top']
      .map((m) => `<option value="${m}"${p.vMode === m ? ' selected' : ''}>${m}</option>`).join('');
    const railOpts  = ['all', 'top', 'center', 'bot']
      .map((m) => `<option value="${m}"${(p.rail || 'all') === m ? ' selected' : ''}>${m}</option>`).join('');
    row.innerHTML = `
      <div class="phead">
        <span class="pname">patch ${i}</span>
        <span class="pctrls">
          <select class="pmode-select" data-field="rail" title="Which rail this patch is painted onto">${railOpts}</select>
          <select class="pmode-select" data-field="vMode">${vmodeOpts}</select>
          <button type="button" class="patch-remove" title="Remove patch">×</button>
        </span>
      </div>
      <label>Arc pos <input type="range" min="0" max="${CONFIG.pulsePeriod}" step="1" data-field="arcPos" value="${p.arcPos}"><span data-r="arcPos">${p.arcPos.toFixed(0)}</span></label>
      <label>Half width <input type="range" min="0.005" max="0.5" step="0.001" data-field="halfWidth" value="${p.halfWidth}"><span data-r="halfWidth">${p.halfWidth.toFixed(2)}</span></label>
      <label>Feather X <input type="range" min="0" max="1" step="0.01" data-field="featherX" value="${p.featherX == null ? (p.feather == null ? 0.45 : p.feather) : p.featherX}"><span data-r="featherX">${(p.featherX == null ? (p.feather == null ? 0.45 : p.feather) : p.featherX).toFixed(2)}</span></label>
      <label>Feather Y <input type="range" min="0" max="1" step="0.01" data-field="featherY" value="${p.featherY == null ? (p.feather == null ? 0.45 : p.feather) : p.featherY}"><span data-r="featherY">${(p.featherY == null ? (p.feather == null ? 0.45 : p.feather) : p.featherY).toFixed(2)}</span></label>
      <label>Band min <input type="range" min="0" max="1" step="0.001" data-field="bandMin" value="${p.bandMin}"><span data-r="bandMin">${p.bandMin.toFixed(2)}</span></label>
      <label>Band max <input type="range" min="0" max="1" step="0.001" data-field="bandMax" value="${p.bandMax}"><span data-r="bandMax">${p.bandMax.toFixed(2)}</span></label>
      <label>Alpha <input type="range" min="0" max="1" step="0.01" data-field="alpha" value="${p.alpha}"><span data-r="alpha">${p.alpha.toFixed(2)}</span></label>
      <label>Color <input type="color" data-field="color" value="${rgbToHex(p.color)}"></label>
    `;
    host.appendChild(row);

    row.querySelectorAll('[data-field]').forEach((el) => {
      const field = el.dataset.field;
      // Some selects also fire 'change' (not 'input') when value picks via keyboard.
      const evt = (field === 'rail' || field === 'vMode') ? 'change' : 'input';
      el.addEventListener(evt, () => {
        if (field === 'color') {
          p.color = hexToRgbNormalized(el.value);
        } else if (field === 'vMode' || field === 'rail') {
          p[field] = el.value;
        } else {
          const v = parseFloat(el.value);
          p[field] = v;
          const readout = row.querySelector(`[data-r="${field}"]`);
          if (readout) readout.textContent = v.toFixed(2);
        }
        rebakePatchTexture();
      });
    });

    row.querySelector('.patch-remove').addEventListener('click', () => {
      // Keep at least zero patches allowed; the shader handles an empty
      // table by returning a fully-transparent patch tint.
      PATCH_TABLE.splice(i, 1);
      buildPatchRows();
      rebakePatchTexture();
    });
  });

  // Trailing "+ Add patch" action — always visible at the bottom.
  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'patch-add';
  addBtn.textContent = '+ Add patch';
  addBtn.addEventListener('click', () => {
    PATCH_TABLE.push(defaultPatch());
    buildPatchRows();
    rebakePatchTexture();
  });
  host.appendChild(addBtn);
}

// Collapse toggle for the whole panel.
const panel = document.getElementById('panel');
const toggleBtn = document.getElementById('panel-toggle');
if (toggleBtn) {
  toggleBtn.addEventListener('click', () => {
    panel.classList.toggle('collapsed');
    toggleBtn.textContent = panel.classList.contains('collapsed') ? '+' : '–';
  });
}

// Reset → re-apply the current "default" snapshot. The default starts as the
// boot-time capture from registerStarterPresets() but can be overwritten by
// the user via the Save default button (persisted in localStorage and
// re-loaded at boot — see SAVED_DEFAULT_KEY below).
const resetBtn = document.getElementById('panel-reset');
if (resetBtn) {
  resetBtn.addEventListener('click', () => {
    const def = BUILT_IN_PRESETS['default'];
    if (def) applyPreset(def.data);
  });
}

// Save default → snapshot current state, persist to localStorage, and swap
// it into BUILT_IN_PRESETS['default'] so subsequent Reset clicks return here.
// Survives page reloads via loadSavedDefault() called after preset registration.
const SAVED_DEFAULT_KEY = 'railway.savedDefault.v1';
const saveDefaultBtn = document.getElementById('panel-save-default');
if (saveDefaultBtn) {
  saveDefaultBtn.addEventListener('click', () => {
    const s = snapshot();
    try {
      localStorage.setItem(SAVED_DEFAULT_KEY, JSON.stringify(s));
    } catch (e) {
      console.warn('Save default failed:', e);
      saveDefaultBtn.textContent = 'Save failed';
      setTimeout(() => { saveDefaultBtn.textContent = 'Save default'; }, 1500);
      return;
    }
    if (BUILT_IN_PRESETS['default']) {
      BUILT_IN_PRESETS['default'].data = JSON.parse(JSON.stringify(s));
    }
    saveDefaultBtn.textContent = 'Saved ✓';
    setTimeout(() => { saveDefaultBtn.textContent = 'Save default'; }, 1200);
  });
}

// ── SVG drag-and-drop → rail gradients ──────────────────────────────────────
// Drop any SVG file anywhere on the page; the first 3 <linearGradient> defs
// (in document order) become the TOP, BOT, CENTER ramps respectively. Matches
// the rails.svg port convention (paint0 = top, paint1 = bot, paint2/3 = center).
function parseSvgGradients(svgText) {
  let doc;
  try {
    doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  } catch (_) {
    return [];
  }
  if (doc.querySelector('parsererror')) return [];
  return Array.from(doc.querySelectorAll('linearGradient')).map((g) => {
    return Array.from(g.querySelectorAll('stop')).map((s) => {
      const pos = parseFloat(s.getAttribute('offset')) || 0;
      // stop-color may be in a style="..." attribute (Figma exports do this).
      let hex = s.getAttribute('stop-color') || '';
      let opacityAttr = s.getAttribute('stop-opacity');
      const styleAttr = s.getAttribute('style') || '';
      if (!hex) {
        const m = styleAttr.match(/stop-color\s*:\s*([^;]+)/i);
        if (m) hex = m[1].trim();
      }
      if (opacityAttr == null) {
        const m = styleAttr.match(/stop-opacity\s*:\s*([^;]+)/i);
        if (m) opacityAttr = m[1].trim();
      }
      // Coerce named/rgb colours to a 6-char hex via a temporary canvas hack.
      if (!/^#[0-9a-f]{6,8}$/i.test(hex)) {
        const probe = document.createElement('div');
        probe.style.color = hex || '#888';
        document.body.appendChild(probe);
        const rgb = getComputedStyle(probe).color;
        document.body.removeChild(probe);
        const m = rgb.match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
        if (m) {
          const toHex = (n) => Number(n).toString(16).padStart(2, '0');
          hex = '#' + toHex(m[1]) + toHex(m[2]) + toHex(m[3]);
        } else {
          hex = '#888888';
        }
      }
      const alpha = opacityAttr == null ? 1 : Math.max(0, Math.min(1, parseFloat(opacityAttr)));
      return [pos, hex.slice(0, 7), alpha];
    });
  }).filter((stops) => stops.length > 0);
}

function applySvgGradients(svgText) {
  const grads = parseSvgGradients(svgText);
  if (grads.length === 0) return { ok: false, count: 0 };
  // First 3 gradients → TOP, BOT, CENTER (rails.svg paint0/1/2 order).
  const targets = ['top', 'bot', 'center'];
  let applied = 0;
  for (let i = 0; i < Math.min(grads.length, targets.length); i++) {
    RAMPS[targets[i]].length = 0;
    grads[i].forEach((s) => RAMPS[targets[i]].push(s.slice()));
    applied++;
  }
  rebuildRampTexture();
  buildGradientUI();
  return { ok: true, count: applied };
}

// Drop overlay + handlers. Counter pattern handles dragenter/leave fanning
// across child elements without flicker.
function setupSvgDrop() {
  let overlay = null;
  function ensureOverlay() {
    if (overlay) return overlay;
    overlay = document.createElement('div');
    overlay.id = 'svg-drop-overlay';
    Object.assign(overlay.style, {
      position: 'fixed', inset: '0', zIndex: '1000',
      background: 'rgba(32, 90, 180, 0.35)',
      backdropFilter: 'blur(2px)',
      pointerEvents: 'none',
      display: 'none',
      alignItems: 'center', justifyContent: 'center',
      font: '600 18px ui-monospace, monospace',
      color: '#fff', letterSpacing: '0.04em',
    });
    overlay.textContent = 'Drop SVG to load gradients';
    document.body.appendChild(overlay);
    return overlay;
  }
  let depth = 0;
  function show() { ensureOverlay().style.display = 'flex'; }
  function hide() { if (overlay) overlay.style.display = 'none'; }
  function flash(msg, color) {
    const o = ensureOverlay();
    o.textContent = msg;
    o.style.background = color;
    o.style.display = 'flex';
    setTimeout(() => { o.style.display = 'none'; o.textContent = 'Drop SVG to load gradients'; o.style.background = 'rgba(32, 90, 180, 0.35)'; }, 1400);
  }
  document.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault();
    depth++;
    show();
  });
  document.addEventListener('dragover', (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) e.preventDefault();
  });
  document.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) hide();
  });
  document.addEventListener('drop', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    depth = 0;
    hide();
    const file = e.dataTransfer.files[0];
    if (!/\.svg$/i.test(file.name) && file.type !== 'image/svg+xml') {
      flash('Not an SVG file', 'rgba(180, 60, 60, 0.5)');
      return;
    }
    file.text().then((txt) => {
      const r = applySvgGradients(txt);
      if (r.ok) flash(`Applied ${r.count} gradient${r.count === 1 ? '' : 's'}: ${file.name}`, 'rgba(60, 140, 80, 0.5)');
      else      flash('No <linearGradient> defs in SVG', 'rgba(180, 60, 60, 0.5)');
    });
  });
}
setupSvgDrop();

// At boot, load the saved default (if any) and replace BUILT_IN_PRESETS['default']
// so Reset returns to the user's saved state, not the file's literal defaults.
// Also applies the snapshot immediately so the initial render reflects it.
function loadSavedDefault() {
  try {
    const raw = localStorage.getItem(SAVED_DEFAULT_KEY);
    if (!raw) return false;
    const s = JSON.parse(raw);
    if (BUILT_IN_PRESETS['default']) {
      BUILT_IN_PRESETS['default'].data = s;
    }
    applyPreset(s);
    return true;
  } catch (e) {
    console.warn('Load saved default failed:', e);
    return false;
  }
}

// Rebuild the ramp texture and swap it into the uniform.
function rebuildRampTexture() {
  const newTex = buildRampTexture();
  mat.uniforms.uRamp.value.dispose();
  mat.uniforms.uRamp.value = newTex;
}

// Render the per-rail stop editors inside #gradient-section. Each rail gets:
//   • A horizontal preview bar showing the current gradient with a checker
//     background so alpha<1 regions are visually obvious (Figma-style).
//   • Per-stop rows: [pos slider] [pos] [alpha slider] [color] [remove].
//   • "+ add stop" button that appends a mid-grey opaque stop.
function buildGradientUI() {
  const host = document.getElementById('gradient-section');
  if (!host) return;
  // Clear dynamically-created blocks (applyPreset calls this after swapping
  // RAMPS). Preserve <h2>, any <label> (static UI controls like the phase
  // and family-blend sliders), and elements with .grad-static.
  Array.from(host.querySelectorAll(':scope > :not(h2):not(label):not(.grad-static)')).forEach((n) => n.remove());

  // Build a CSS linear-gradient string from a rail's stops (includes alpha).
  function stopsToCSS(stops) {
    const rgbOf = (hex) => {
      const n = parseInt(hex.slice(1), 16);
      return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
    };
    return stops
      .slice().sort((a, b) => a[0] - b[0])
      .map((s) => {
        const [r, g, b] = rgbOf(s[1]);
        const a = stopAlpha(s);
        return `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)}) ${(s[0] * 100).toFixed(2)}%`;
      })
      .join(', ');
  }

  ['top', 'center', 'bot'].forEach((railName) => {
    const block = document.createElement('div');
    block.className = 'grad-block';
    block.dataset.rail = railName;
    block.innerHTML = `
      <h3>${railName} rail</h3>
      <div class="grad-preview"></div>
      <div class="stops"></div>
    `;
    const preview = block.querySelector('.grad-preview');
    const stopsEl = block.querySelector('.stops');
    const addBtn  = document.createElement('button');
    addBtn.className = 'grad-add';
    addBtn.textContent = '+ add stop';
    block.appendChild(addBtn);
    host.appendChild(block);

    function updatePreview() {
      // Gradient painted over a checker so alpha<1 is clearly visible.
      preview.style.backgroundImage =
        `linear-gradient(to right, ${stopsToCSS(RAMPS[railName])}),` +
        `conic-gradient(from 0deg, #2a2d30 25%, #3a3d40 25% 50%, #2a2d30 50% 75%, #3a3d40 75%)`;
    }

    function redraw() {
      stopsEl.innerHTML = '';
      RAMPS[railName].sort((a, b) => a[0] - b[0]);
      RAMPS[railName].forEach((stop, i) => {
        const row = document.createElement('div');
        row.className = 'grad-stop';
        row.innerHTML = `
          <input type="range" class="pos"   min="0" max="1" step="0.001" value="${stop[0]}">
          <span class="pos-readout">${stop[0].toFixed(3)}</span>
          <input type="range" class="alpha" min="0" max="1" step="0.01"  value="${stopAlpha(stop)}">
          <input type="color" value="${stop[1]}">
          <button class="del" title="Remove stop">×</button>
        `;
        const posIn   = row.querySelector('input.pos');
        const posRead = row.querySelector('.pos-readout');
        const alphaIn = row.querySelector('input.alpha');
        const colorIn = row.querySelector('input[type="color"]');
        const delBtn  = row.querySelector('button.del');

        // Visual cue: tint the alpha slider's thumb/track by current alpha.
        alphaIn.title = `Alpha: ${stopAlpha(stop).toFixed(2)}`;

        posIn.addEventListener('input', () => {
          stop[0] = parseFloat(posIn.value);
          posRead.textContent = stop[0].toFixed(3);
          rebuildRampTexture();
          updatePreview();
        });
        posIn.addEventListener('change', redraw);
        alphaIn.addEventListener('input', () => {
          stop[2] = parseFloat(alphaIn.value);
          alphaIn.title = `Alpha: ${stop[2].toFixed(2)}`;
          rebuildRampTexture();
          updatePreview();
        });
        colorIn.addEventListener('input', () => {
          stop[1] = colorIn.value;
          rebuildRampTexture();
          updatePreview();
        });
        delBtn.addEventListener('click', () => {
          if (RAMPS[railName].length <= 2) return;
          RAMPS[railName].splice(i, 1);
          redraw();
          rebuildRampTexture();
          updatePreview();
        });
        stopsEl.appendChild(row);
      });
    }

    addBtn.addEventListener('click', () => {
      RAMPS[railName].push([0.5, '#808080', 1]);
      redraw();
      rebuildRampTexture();
      updatePreview();
    });

    redraw();
    updatePreview();
  });
}

bindGlobalControls();
buildGradientUI();
buildPatchRows();
buildMinimap();
applyConfig();

// Re-roll button — picks a fresh random seed, resets the procedural cache,
// resets camera, rebuilds minimap. Also updates the seed input's DOM value.
(function bindReroll() {
  const btn = document.getElementById('reroll-btn');
  if (!btn) return;
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    CONFIG.seed = 1 + Math.floor(Math.random() * 99998);
    const seedEl = document.querySelector('[data-k="seed"]');
    if (seedEl) seedEl.value = CONFIG.seed;
    // Snap camera back so the fresh roll is visible from the start.
    WORLD.cameraX = 0;
    applyConfig();
  });
})();

// ── Presets ──────────────────────────────────────────────────────────────
// A preset is a full snapshot of { CONFIG, RAMPS, PATCH_TABLE }. Loading a
// preset mutates the live objects in place (so closures / DOM bindings stay
// valid), then rebuilds the gradient + patch UIs and pushes every value to
// the shader uniforms via applyConfig.
//
// URL hash ('#s=<base64json>') persists the current state so a tab reload
// (or a "Copy URL" share) restores the same look. Built-in presets sit in
// BUILT_IN_PRESETS; user saves land in localStorage.USER_PRESETS_KEY under
// their own names (future extension — for now only built-ins + URL state).
const USER_PRESETS_KEY = 'railway-three-user-presets-v1';

function snapshot() {
  return {
    v: 1,
    CONFIG: JSON.parse(JSON.stringify(CONFIG)),
    RAMPS:  JSON.parse(JSON.stringify(RAMPS)),
    PATCH_TABLE: JSON.parse(JSON.stringify(PATCH_TABLE)),
  };
}

// Apply a snapshot in-place. Silently ignores unknown CONFIG keys so older
// snapshots keep working after we add new knobs.
function applyPreset(s) {
  if (!s || typeof s !== 'object') return;
  // CONFIG — copy only known keys so stray fields don't pollute live state.
  if (s.CONFIG) {
    for (const k of Object.keys(CONFIG)) {
      if (k in s.CONFIG) CONFIG[k] = s.CONFIG[k];
    }
  }
  // RAMPS — replace each rail's stops in place.
  if (s.RAMPS) {
    for (const k of Object.keys(RAMPS)) {
      if (Array.isArray(s.RAMPS[k])) {
        RAMPS[k].length = 0;
        s.RAMPS[k].forEach((stop) => RAMPS[k].push(stop.slice()));
      }
    }
  }
  // PATCH_TABLE — same length or replace.
  if (Array.isArray(s.PATCH_TABLE)) {
    PATCH_TABLE.length = 0;
    s.PATCH_TABLE.forEach((p) => PATCH_TABLE.push({
      arcPos:    +p.arcPos    || 0,
      halfWidth: +p.halfWidth || 0.1,
      bandMin:   +p.bandMin   || 0,
      bandMax:   +p.bandMax   || 1,
      color:     Array.isArray(p.color) ? p.color.slice(0, 3).map(Number) : [0.5, 0.5, 0.5],
      alpha:     p.alpha == null ? 1 : +p.alpha,
      vMode:     p.vMode || 'bell',
      rail:      p.rail  || 'all',
      featherX:  p.featherX != null ? +p.featherX : (p.feather != null ? +p.feather : 0.45),
      featherY:  p.featherY != null ? +p.featherY : (p.feather != null ? +p.feather : 0.45),
    }));
  }

  // Rebuild all UI that was generated from the tables.
  buildGradientUI();
  buildPatchRows();

  // Push CONFIG → DOM inputs so sliders / selects reflect the loaded state.
  document.querySelectorAll('#panel [data-k]').forEach((el) => {
    const k = el.dataset.k;
    if (!(k in CONFIG)) return;
    if (el.type === 'checkbox')   el.checked = !!CONFIG[k];
    else                          el.value   = CONFIG[k];
    const readout = document.querySelector(`#panel [data-v="${k}"]`);
    if (readout) {
      const isNum = el.type === 'range' || el.type === 'number';
      readout.textContent = isNum ? (+CONFIG[k]).toFixed(2) : String(CONFIG[k]);
    }
  });

  // Re-bake textures + push uniforms + refresh minimap.
  rebuildRampTexture();
  rebakePatchTexture();
  applyConfig();
}

// Built-in starter presets. The "default" one is captured live on boot so
// "Reset" really does return to the stock look. The other two tweak
// CONFIG on top of the default snapshot.
const BUILT_IN_PRESETS = {};
function registerStarterPresets() {
  const base = snapshot();
  BUILT_IN_PRESETS['default'] = {
    label: 'Default',
    data:  base,
  };
  // Hero — slower, station-heavy, v5 script for more topology variety.
  const hero = JSON.parse(JSON.stringify(base));
  Object.assign(hero.CONFIG, {
    simMode:       'scripted',
    simScript:     'v5',
    speed:         300,
    viewZoom:      0.5,
  });
  BUILT_IN_PRESETS['hero'] = { label: 'Hero · station heavy', data: hero };
  // Frantic — procedural, aggressive splits, fast speed, bigger max tracks.
  const frantic = JSON.parse(JSON.stringify(base));
  Object.assign(frantic.CONFIG, {
    simMode:      'procedural',
    speed:        1400,
    mergeChance:  0.25,
    splitChance:  0.95,
    maxTracks:    7,
    seed:         42,
    viewZoom:     0.5,
  });
  BUILT_IN_PRESETS['frantic'] = { label: 'Frantic · procedural', data: frantic };
}

// ── URL-hash encoding (base64 JSON) ──────────────────────────────────────
// Opaque but debuggable — readers can base64-decode and inspect the JSON.
function encodeHash(s) {
  try { return btoa(unescape(encodeURIComponent(JSON.stringify(s)))); }
  catch { return ''; }
}
function decodeHash(h) {
  try { return JSON.parse(decodeURIComponent(escape(atob(h)))); }
  catch { return null; }
}
function readHashPreset() {
  const h = location.hash.slice(1);
  if (!h.startsWith('s=')) return null;
  return decodeHash(h.slice(2));
}
function writeHashPreset() {
  const enc = encodeHash(snapshot());
  if (!enc) return;
  history.replaceState(null, '', '#s=' + enc);
}

// Debounced hash writer so rapid slider drags don't thrash history.
let _hashTimer = null;
function scheduleHashWrite() {
  if (_hashTimer) clearTimeout(_hashTimer);
  _hashTimer = setTimeout(writeHashPreset, 400);
}

// ── Preset panel wiring ──────────────────────────────────────────────────
function bindPresetPanel() {
  const sel     = document.getElementById('preset-select');
  const loadBtn = document.getElementById('preset-load');
  const copyBtn = document.getElementById('preset-copyurl');
  const resetBtn= document.getElementById('preset-reset');
  const status  = document.getElementById('preset-status');
  if (!sel) return;

  // Populate the dropdown from BUILT_IN_PRESETS.
  sel.innerHTML = '';
  for (const [id, p] of Object.entries(BUILT_IN_PRESETS)) {
    const opt = document.createElement('option');
    opt.value = id; opt.textContent = p.label;
    sel.appendChild(opt);
  }

  function say(msg) {
    if (!status) return;
    status.textContent = msg;
    // Auto-clear after a couple seconds so the panel stays tidy.
    clearTimeout(say._t);
    say._t = setTimeout(() => { status.textContent = ''; }, 2500);
  }

  loadBtn?.addEventListener('click', () => {
    const id = sel.value;
    const p  = BUILT_IN_PRESETS[id];
    if (!p) return;
    applyPreset(p.data);
    WORLD.cameraX = 0;
    writeHashPreset();
    say(`loaded · ${p.label}`);
  });

  resetBtn?.addEventListener('click', () => {
    const p = BUILT_IN_PRESETS['default'];
    if (!p) return;
    applyPreset(p.data);
    sel.value = 'default';
    WORLD.cameraX = 0;
    history.replaceState(null, '', location.pathname + location.search);
    say('reset to default');
  });

  copyBtn?.addEventListener('click', async () => {
    writeHashPreset();
    const url = location.href;
    try { await navigator.clipboard.writeText(url); say('URL copied'); }
    catch { say('copy failed — select URL bar manually'); }
  });
}

// ── Boot sequence for presets ────────────────────────────────────────────
// Must run AFTER the first applyConfig() so the "default" snapshot captures
// the live CONFIG / RAMPS / PATCH_TABLE accurately. A URL-hash preset, if
// present, overrides the default on boot.
registerStarterPresets();
bindPresetPanel();
// Saved default (localStorage) wins over the file's built-in default but loses
// to a URL-hash preset (explicit share link should override saved state).
loadSavedDefault();
{
  const urlPreset = readHashPreset();
  if (urlPreset) {
    applyPreset(urlPreset);
    const s = document.getElementById('preset-status');
    if (s) { s.textContent = 'loaded from URL'; setTimeout(() => s.textContent = '', 2500); }
  }
}

// Write the URL hash whenever any control changes — light autosave.
document.querySelectorAll('#panel [data-k]').forEach((el) => {
  el.addEventListener('input', scheduleHashWrite);
});

// Expose for console tweaking
window.RAILWAY = {
  CONFIG, PATCH_TABLE, RAMPS, mat, applyConfig, rebuildRampTexture,
  renderer, scene, camera, WORLD, rebuildLaneData,
  snapshot, applyPreset, BUILT_IN_PRESETS,
};
console.log('Three.js prototype booted. Tweak with RAILWAY.CONFIG / RAILWAY.mat.uniforms');
