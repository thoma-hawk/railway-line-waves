// Lane simulator — faithful JS port of TD `lane_sim._simulate_scripted`.
//
// Sim model:
//   • LANE_COUNT lane indices, 0..LANE_COUNT-1. CENTER_IDX = (LANE_COUNT-1)/2.
//   • Active state is a boolean array "lanes[i] = is active?".
//   • Script events fall into per-segment buckets (INIT filtered out — used
//     only to seed initial lanes; NOT re-fired every loop).
//   • Per segment n, events run in declaration order against a copy of the
//     active state (`next`). A `pass_through` set tracks which currently-
//     active lanes haven't already been written into the connections list.
//
// TD's SPLIT:
//   if current_lanes[la] and not next_lanes[lb]:
//       connections += [(la, la), (la, lb)]   # trunk continues + branch out
//       next_lanes[la] = next_lanes[lb] = True
//       pass_through.discard(la)
//
// TD's MERGE:
//   if current_lanes[la] and current_lanes[lb]:
//       connections += [(la, lb)]             # only the merging curve
//       next_lanes[la] = False
//       pass_through.discard(la)
//
// TD's final step: any lane left in pass_through that isn't already a c[0]
// in connections gets a straight (idx, idx).
//
// Using this verbatim fixes two bugs in the previous web port:
//   1. Multiple SPLITs/MERGEs at the same segment now interact correctly via
//      the shared `next` / `pass_through` state (previously only one code
//      branch fired).
//   2. The split "Y" now emits BOTH (la, la) and (la, lb) — before, the
//      trunk was only added once per unique source. Visually this means the
//      straight trunk stroke is clearly visible through the split.

const SIM = (() => {

  // ── Scripts (match TD tables sim_script_v1, sim_script_v5) ───────────────
  const SCRIPTS = {
    v1: [
      { seg: 0,  type: 'INIT',  from: 3 },
      { seg: 5,  type: 'SPLIT', from: 3, to: 2 },
      { seg: 5,  type: 'SPLIT', from: 3, to: 4 },
      { seg: 13, type: 'MERGE', from: 2, to: 3 },
      { seg: 13, type: 'MERGE', from: 4, to: 3 },
      { seg: 20, type: 'SPLIT', from: 3, to: 2 },
      { seg: 20, type: 'SPLIT', from: 3, to: 4 },
      { seg: 28, type: 'MERGE', from: 2, to: 3 },
      { seg: 28, type: 'MERGE', from: 4, to: 3 },
    ],
    v5: [
      { seg: 0,  type: 'INIT',  from: 3 },
      { seg: 5,  type: 'SPLIT', from: 3, to: 2 },
      { seg: 5,  type: 'SPLIT', from: 3, to: 4 },
      { seg: 10, type: 'SPLIT', from: 2, to: 1 },
      { seg: 10, type: 'SPLIT', from: 4, to: 5 },
      { seg: 18, type: 'MERGE', from: 1, to: 2 },
      { seg: 18, type: 'MERGE', from: 5, to: 4 },
      { seg: 23, type: 'MERGE', from: 2, to: 3 },
      { seg: 23, type: 'MERGE', from: 4, to: 3 },
    ],
  };

  let ACTIVE = SCRIPTS.v1;

  // ── Mode ─────────────────────────────────────────────────────────────────
  // 'scripted'   — fixed event table (SCRIPTS.v1/v5), cached per loop, wraps
  // 'procedural' — rolling buffer, generateLogic() rolls MERGE/SPLIT/S-BEND
  //                per segment using a seeded RNG (ported from the TS App.tsx)
  let MODE = 'scripted';

  // Procedural params (defaults match the TS App.tsx INITIAL_CONFIG)
  let MERGE_CHANCE = 0.4;
  let SPLIT_CHANCE = 0.9;
  let MAX_TRACKS   = 7;
  let SEED         = 1;

  // ── Geometry ─────────────────────────────────────────────────────────────
  let LOOP_SEGS  = 30;
  let SEG_W      = 400;
  let CENTER_Y   = 0;          // Canvas renderer already translates to centre.
  let LANE_SPACE = 180;
  let LANE_COUNT = 7;          // matches TD Lanecount default
  const CENTER_IDX = () => (LANE_COUNT - 1) / 2;

  // ── Seeded RNG (mulberry32) ──────────────────────────────────────────────
  // Deterministic — same SEED + same chances = same roll every time. That's
  // what makes procedural-mode hero-video rendering reproducible.
  let rngState = 1;
  function rngReset(s) { rngState = ((s >>> 0) || 1); }
  function rng() {
    rngState = (rngState + 0x6D2B79F5) >>> 0;
    let t = rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  // TD y-coordinate: y = -(lane - center_idx) * LANE_SPACING. With SVG y-down
  // we flip the sign so outer-top lanes (< center) render above centerY.
  const laneToY = (l) => CENTER_Y + (l - CENTER_IDX()) * LANE_SPACE;

  const mod = (n, m) => ((n % m) + m) % m;

  const smoothstep = (t) => {
    const s = Math.max(0, Math.min(1, t));
    return s * s * (3 - 2 * s);
  };

  // ── Initial state (from INIT event, else lane 3) ─────────────────────────
  function initialLanes() {
    const lanes = new Array(LANE_COUNT).fill(false);
    const init = ACTIVE.find(e => String(e.type).toUpperCase() === 'INIT');
    if (init) {
      for (const tok of String(init.from).replace(/,/g, ' ').split(/\s+/)) {
        const i = parseInt(tok, 10);
        if (Number.isInteger(i) && i >= 0 && i < LANE_COUNT) lanes[i] = true;
      }
    }
    if (!lanes.some(Boolean)) lanes[Math.min(3, LANE_COUNT - 1)] = true;
    return lanes;
  }

  // ── Bucket events by loop-seg (INIT filtered, matches TD) ────────────────
  function bucketEvents() {
    const b = {};
    for (const e of ACTIVE) {
      if (String(e.type).toUpperCase() === 'INIT') continue;
      const s = mod(e.seg, LOOP_SEGS);
      (b[s] = b[s] || []).push(e);
    }
    return b;
  }

  // ── Apply all events for segment n to current lanes, returning both the ─
  // next state AND the connection list for that segment. One authoritative
  // function so activeLanesAt and connectionsAt agree.
  function stepSegment(lanes, events) {
    const next = lanes.slice();
    const active = new Set();
    for (let i = 0; i < lanes.length; i++) if (lanes[i]) active.add(i);
    const pass_through = new Set(active);
    const conns = [];

    for (const ev of events) {
      const type = String(ev.type).toUpperCase();
      const la = parseInt(ev.from, 10);
      const lb = ev.to !== undefined ? parseInt(ev.to, 10) : null;

      if (type === 'SPLIT') {
        if (la >= 0 && la < LANE_COUNT && active.has(la)
            && lb !== null && lb >= 0 && lb < LANE_COUNT && !next[lb]) {
          // Trunk continues + branch out (TD emits both).
          conns.push({ y1: la, y2: la });
          conns.push({ y1: la, y2: lb });
          next[la] = true;
          next[lb] = true;
          pass_through.delete(la);
        }
      } else if (type === 'MERGE') {
        if (la >= 0 && la < LANE_COUNT && active.has(la)
            && lb !== null && lb >= 0 && lb < LANE_COUNT && active.has(lb)) {
          conns.push({ y1: la, y2: lb });
          next[la] = false;
          pass_through.delete(la);
        }
      }
      // STATION_START / STATION_END / unknown → no state change.
    }

    // Any active lane not yet handled continues straight.
    for (const idx of pass_through) {
      if (!conns.some(c => c.y1 === idx)) {
        conns.push({ y1: idx, y2: idx });
        next[idx] = true;
      }
    }

    return { next, conns };
  }

  // ── Procedural generator (ported from TS App.tsx `generateLogic`) ───────
  // One segment at a time: roll MERGE/SPLIT/S-BEND, emit {y1,y2} conns and
  // the resulting end-lane boolean array. Fully deterministic given SEED +
  // chances. Cache is a rolling append-only buffer — camera never wraps in
  // procedural mode so we keep growing forward.
  //
  // PROC.states[n] is the active-lane bool array BEFORE segment n (same as
  // CACHE.states in scripted mode). PROC.conns[n] is the connection list
  // for segment n. PROC.length = next-to-fill index.
  const PROC = {
    states: [],   // boolean[][]
    conns:  [],   // {y1,y2}[][]
    length: 0,
    keyParams: '',
  };

  function procParamsKey() {
    return `${LANE_COUNT}|${SEED}|${MERGE_CHANCE}|${SPLIT_CHANCE}|${MAX_TRACKS}`;
  }

  function procReset() {
    PROC.states.length = 0;
    PROC.conns.length  = 0;
    PROC.length        = 0;
    PROC.keyParams     = procParamsKey();
    rngReset(SEED);
  }

  // Port of TS generateLogic: takes startLanes (bool array), returns
  // { conns: [{y1,y2}...], endLanes: bool[] }. One roll per call.
  function generateLogicProcedural(startLanes) {
    const activeIdx = [];
    for (let i = 0; i < startLanes.length; i++) if (startLanes[i]) activeIdx.push(i);
    const count = activeIdx.length;
    const r = rng();
    const centerIdx = (LANE_COUNT - 1) / 2;

    let action = 'S-BEND';
    if (count > 1) {
      if (r < MERGE_CHANCE) action = 'MERGE';
      else if (count < MAX_TRACKS && r < MERGE_CHANCE + (1 - MERGE_CHANCE) * 0.5) action = 'SPLIT';
    } else {
      if (count < MAX_TRACKS && r < SPLIT_CHANCE) action = 'SPLIT';
    }

    let conns = [];

    if (action === 'SPLIT') {
      // All existing lanes continue straight.
      conns = activeIdx.map((idx) => ({ y1: idx, y2: idx }));
      // Pick a lane to split.
      const s = activeIdx[Math.floor(rng() * count)];
      const neighbors = [s - 1, s + 1].filter(
        (v) => v >= 0 && v < LANE_COUNT && !startLanes[v]
      );
      if (neighbors.length > 0) {
        neighbors.sort((a, b) => Math.abs(a - centerIdx) - Math.abs(b - centerIdx));
        // TS picks neighbors[0] either way — keep roll parity with that code.
        rng();
        const t = neighbors[0];
        conns.push({ y1: s, y2: t });
      }
    } else if (action === 'MERGE') {
      const topOutermost    = activeIdx.find((idx) => idx < centerIdx);
      const bottomOutermost = [...activeIdx].reverse().find((idx) => idx > centerIdx);
      for (let i = 0; i < count; i++) {
        const current = activeIdx[i];
        const next    = activeIdx[i + 1];
        if (next !== undefined && Math.abs(current - next) === 1) {
          const isTopMergingIn    = current === topOutermost;
          const isBottomMergingIn = next === bottomOutermost;
          if (isTopMergingIn || isBottomMergingIn) {
            const target = Math.abs(current - centerIdx) <= Math.abs(next - centerIdx)
              ? current : next;
            conns.push({ y1: current, y2: target });
            conns.push({ y1: next,    y2: target });
            i++;
            continue;
          }
        }
        conns.push({ y1: current, y2: current });
      }
    } else {
      conns = activeIdx.map((idx) => ({ y1: idx, y2: idx }));
    }

    // End lanes = union of all c.y2 destinations.
    const endLanes = new Array(LANE_COUNT).fill(false);
    for (const c of conns) endLanes[c.y2] = true;
    return { conns, endLanes };
  }

  // Grow PROC up to and including seg index n (ensures PROC.length > n).
  // PROC.states[n] = active-lane bools BEFORE segment n (== end-lanes of n-1).
  // PROC.conns[n]  = connection list emitted by segment n.
  function procEnsureUpTo(n) {
    if (PROC.keyParams !== procParamsKey()) procReset();
    while (PROC.length <= n) {
      const sl = PROC.length === 0 ? initialLanes() : PROC._lastEnd.slice();
      const { conns, endLanes } = generateLogicProcedural(sl);
      PROC.states.push(sl);
      PROC.conns.push(conns);
      PROC._lastEnd = endLanes;
      PROC.length++;
    }
  }

  // ── Precomputed state-per-segment cache (avoids O(n²) per frame) ─────────
  let CACHE = null;   // { states: boolean[][], conns: {y1,y2}[][], key: string }

  function cacheKey() {
    return `${LOOP_SEGS}|${LANE_COUNT}|${ACTIVE.map(e =>
      `${e.seg},${String(e.type).toUpperCase()},${e.from},${e.to ?? ''}`).join(';')}`;
  }

  function rebuildCache() {
    const key = cacheKey();
    if (CACHE && CACHE.key === key) return;
    const buckets = bucketEvents();
    const states = [];
    const conns  = [];
    let lanes = initialLanes();
    for (let s = 0; s < LOOP_SEGS; s++) {
      states.push(lanes.slice());
      const events = buckets[s] || [];
      const step = stepSegment(lanes, events);
      conns.push(step.conns);
      lanes = step.next;
    }
    CACHE = { states, conns, key };
  }

  function invalidate() { CACHE = null; }

  // ── Public queries ───────────────────────────────────────────────────────
  // In procedural mode, n is an absolute (non-wrapping) segment index —
  // camera keeps advancing forever, cache grows forward. Negative indices
  // return empty (no rail behind spawn) so the lane-data buffer doesn't
  // paint ghost conns at negative world-X.
  function activeLanesAt(n) {
    if (MODE === 'procedural') {
      const idx = n | 0;
      if (idx < 0) return [];
      procEnsureUpTo(idx);
      const st = PROC.states[idx];
      const out = [];
      for (let i = 0; i < st.length; i++) if (st[i]) out.push(i);
      return out;
    }
    rebuildCache();
    const nn = mod(n, LOOP_SEGS);
    const st = CACHE.states[nn];
    const out = [];
    for (let i = 0; i < st.length; i++) if (st[i]) out.push(i);
    return out;
  }

  function connectionsAt(n) {
    if (MODE === 'procedural') {
      const idx = n | 0;
      if (idx < 0) return [];
      procEnsureUpTo(idx);
      return PROC.conns[idx];
    }
    rebuildCache();
    return CACHE.conns[mod(n, LOOP_SEGS)];
  }

  function stationWeight(n, windowN = 3) {
    let wsum = 0, acc = 0;
    const sigma = Math.max(1, windowN) / 2;
    for (let d = -windowN; d <= windowN; d++) {
      const w = Math.exp(-(d * d) / (2 * sigma * sigma));
      wsum += w;
      if (activeLanesAt(n + d).length === 1) acc += w;
    }
    return acc / wsum;
  }

  // Rail grouping — outer (farther from center) lane wins, so the "finger"
  // curve of a split/merge stays in the outer rail's path.
  function ownerLane(y1, y2) {
    if (y1 === y2) return y1;
    const c = CENTER_IDX();
    return Math.abs(y1 - c) > Math.abs(y2 - c) ? y1 : y2;
  }

  // ── Setters (panel reaches in through these) ─────────────────────────────
  function setScript(n)     { if (SCRIPTS[n]) { ACTIVE = SCRIPTS[n]; invalidate(); } }
  function setLoopSegs(n)   { LOOP_SEGS = n;  invalidate(); }
  function setSegW(w)       { SEG_W = w; }
  function setCenterY(y)    { CENTER_Y = y; }
  function setLaneSpace(s)  { LANE_SPACE = s; }
  function setLaneCount(n)  { LANE_COUNT = n; invalidate(); procReset(); }

  function setMode(m) {
    const mm = (m === 'procedural') ? 'procedural' : 'scripted';
    if (MODE !== mm) { MODE = mm; if (MODE === 'procedural') procReset(); }
  }
  function setSeed(s)          { SEED = (s >>> 0) || 1; procReset(); }
  function setMergeChance(c)   { MERGE_CHANCE = Math.max(0, Math.min(1, +c)); procReset(); }
  function setSplitChance(c)   { SPLIT_CHANCE = Math.max(0, Math.min(1, +c)); procReset(); }
  function setMaxTracks(n)     { MAX_TRACKS = Math.max(1, n | 0); procReset(); }
  function reroll()            { procReset(); }

  return {
    SCRIPTS,
    get LOOP_SEGS() { return LOOP_SEGS; },
    get SEG_W()     { return SEG_W; },
    get CENTER_Y()  { return CENTER_Y; },
    get LANE_SPACE(){ return LANE_SPACE; },
    get LANE_COUNT(){ return LANE_COUNT; },
    // In procedural mode the track never loops, so expose Infinity so
    // callers that gate on WORLD_LOOP (e.g. cameraX wrap) naturally skip.
    get WORLD_LOOP(){ return MODE === 'procedural' ? Infinity : LOOP_SEGS * SEG_W; },
    get MODE()      { return MODE; },
    get SEED()      { return SEED; },
    get MERGE_CHANCE() { return MERGE_CHANCE; },
    get SPLIT_CHANCE() { return SPLIT_CHANCE; },
    get MAX_TRACKS()   { return MAX_TRACKS; },
    laneToY,
    activeLanesAt, connectionsAt, stationWeight, ownerLane,
    smoothstep,
    setScript, setLoopSegs, setSegW, setCenterY, setLaneSpace, setLaneCount,
    setMode, setSeed, setMergeChance, setSplitChance, setMaxTracks, reroll,
  };
})();
