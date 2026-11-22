/* shot-printer.reaplugin
 *
 * Prints the espresso shot graph plus shot details on a network ESC/POS
 * receipt printer (raw TCP, port 9100).
 *
 * Flow: shotStored event -> fetch the full shot from the Decaid API ->
 * render a 1-bit bitmap graph -> encode receipt as ESC/POS -> send over TCP.
 *
 * HTTP endpoints (served at /api/v1/plugins/shot-printer.reaplugin/<id>):
 *   preview[?shotId=]  on-screen preview of the receipt with a Print button
 *   print[?shotId=]    print a shot (latest when shotId is omitted)
 *   status             plugin configuration and last print result as JSON
 */

function createPlugin(host) {
  "use strict";

  const PLUGIN_ID = "shot-printer.reaplugin";
  const API = "http://localhost:8080/api/v1";
  const SHOT_FETCH_DELAY_MS = 3000;
  // Decaid also sends shotStored for shots imported from backups. Only shots
  // pulled within this window (either side of now, for clock skew) are
  // auto-printed, so an import doesn't print the whole history.
  const AUTO_PRINT_MAX_AGE_MS = 10 * 60 * 1000;
  const CONNECT_TIMEOUT_MS = 8000;
  const RASTER_BAND_ROWS = 128;
  // Imported shots are untrusted. Without limits, absurd values make the axis
  // loops in renderGraph run practically forever.
  const MAX_BAR_OR_FLOW = 25;
  const MAX_WEIGHT_G = 5000;
  const MAX_SHOT_SECONDS = 3600;
  const MAX_SAMPLES = 20000;

  let config = readSettings({});
  let queue = Promise.resolve();
  let lastResult = null;
  let pendingTimers = [];

  function log(msg) {
    host.log(`[shot-printer] ${msg}`);
  }

  // ---------------------------------------------------------------------------
  // Settings
  // ---------------------------------------------------------------------------

  function readSettings(s) {
    const num = (v, d) => {
      const n = Number(v);
      return v === undefined || v === null || v === "" || !Number.isFinite(n) ? d : n;
    };
    const bool = (v, d) => (v === undefined || v === null ? d : v === true || v === "true");
    const str = (v) => (typeof v === "string" ? v.trim() : "");
    return {
      host: str(s.PrinterHost),
      port: Math.round(num(s.PrinterPort, 9100)),
      paper: s.PaperWidth === "58mm" ? "58mm" : "80mm",
      autoPrint: bool(s.AutoPrint, true),
      minShotSeconds: num(s.MinShotSeconds, 10),
      header: str(s.HeaderText),
      footer: str(s.FooterText),
      showTargets: bool(s.ShowTargets, false),
      cut: bool(s.CutPaper, true),
    };
  }

  function paperSpec(paper) {
    return paper === "58mm" ? { dots: 384, chars: 32 } : { dots: 576, chars: 48 };
  }

  // ---------------------------------------------------------------------------
  // Shot data
  // ---------------------------------------------------------------------------

  async function getJson(url) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  }

  async function fetchShot(shotId) {
    let id = shotId;
    if (!id) {
      const latest = await getJson(`${API}/shots/latest`);
      if (!latest || !latest.id) throw new Error("No shots recorded yet.");
      id = latest.id;
    }
    return await getJson(`${API}/shots/${encodeURIComponent(id)}`);
  }

  async function fetchRecentShots(limit) {
    try {
      const page = await getJson(`${API}/shots?limit=${limit}&offset=0&order=desc`);
      return Array.isArray(page) ? page : page.items || [];
    } catch (e) {
      log(`Could not list recent shots: ${e.message}`);
      return [];
    }
  }

  function isEspressoFrame(m) {
    const sub = m && m.machine && m.machine.state && m.machine.state.substate;
    return sub === "preinfusion" || sub === "pouring";
  }

  function espressoMeasurements(measurements) {
    const first = measurements.findIndex(isEspressoFrame);
    if (first < 0) {
      return measurements.filter(
        (m) => m && m.machine && m.machine.state && m.machine.state.state === "espresso"
      );
    }
    let last = first;
    for (let i = first + 1; i < measurements.length; i++) {
      if (!isEspressoFrame(measurements[i])) break;
      last = i;
    }
    return measurements.slice(first, last + 1);
  }

  function finiteOr(v, d) {
    const n = Number(v);
    return v === null || v === undefined || !Number.isFinite(n) ? d : n;
  }

  function positiveOrNull(v) {
    const n = finiteOr(v, null);
    return n !== null && n > 0 ? n : null;
  }

  function barOrFlow(v) {
    return Math.min(MAX_BAR_OR_FLOW, Math.max(0, finiteOr(v, 0)));
  }

  function extractSeries(shot) {
    const ms = espressoMeasurements(Array.isArray(shot.measurements) ? shot.measurements : []);
    const s = { t: [], pressure: [], flow: [], weight: [], targetPressure: [], targetFlow: [] };
    if (ms.length === 0) return s;
    if (ms.length > MAX_SAMPLES) throw new Error("This shot has too many measurements to plot.");
    const t0 = new Date(ms[0].machine.timestamp).getTime();
    let lastT = -1;
    for (const m of ms) {
      const t = (new Date(m.machine.timestamp).getTime() - t0) / 1000;
      if (!Number.isFinite(t) || t < lastT) continue;
      if (t > MAX_SHOT_SECONDS) throw new Error("This shot is too long to plot.");
      lastT = t;
      s.t.push(t);
      const weight = m.scale ? finiteOr(m.scale.weight, null) : null;
      s.pressure.push(barOrFlow(m.machine.pressure));
      s.flow.push(barOrFlow(m.machine.flow));
      s.weight.push(weight === null ? null : Math.min(MAX_WEIGHT_G, weight));
      s.targetPressure.push(barOrFlow(m.machine.targetPressure));
      s.targetFlow.push(barOrFlow(m.machine.targetFlow));
    }
    return s;
  }

  function summarize(shot, series) {
    const wf = shot.workflow || {};
    const ctx = wf.context || {};
    const ann = shot.annotations || {};
    const profile = wf.profile || {};
    const duration = series.t.length ? series.t[series.t.length - 1] : 0;
    const weights = series.weight.filter((w) => w !== null);
    const lastWeight = weights.length ? weights[weights.length - 1] : null;
    const dose = positiveOrNull(ann.actualDoseWeight) || positiveOrNull(ctx.targetDoseWeight);
    let yieldG = positiveOrNull(ann.actualYield);
    if (yieldG === null && lastWeight !== null && lastWeight > 0.5) yieldG = lastWeight;
    return {
      id: shot.id,
      when: shot.timestamp ? new Date(shot.timestamp) : null,
      profile: profile.title || wf.name || "Espresso",
      duration,
      dose,
      yieldG,
      targetYield: positiveOrNull(ctx.targetYield),
      peakPressure: series.pressure.length ? Math.max.apply(null, series.pressure) : null,
      coffee: [ctx.coffeeRoaster, ctx.coffeeName].filter(Boolean).join(" - "),
      grinder: [ctx.grinderModel, ctx.grinderSetting].filter((v) => v !== null && v !== undefined && v !== "").join(" @ "),
      tds: positiveOrNull(ann.drinkTds),
      ey: positiveOrNull(ann.drinkEy),
      enjoyment: positiveOrNull(ann.enjoyment),
      barista: ctx.baristaName || "",
      drinker: ctx.drinkerName || "",
      notes: ann.espressoNotes || "",
    };
  }

  // ---------------------------------------------------------------------------
  // 1-bit bitmap and drawing
  // ---------------------------------------------------------------------------

  const FONT_ROWS = {
    "0": "01110 10001 10011 10101 11001 10001 01110",
    "1": "00100 01100 00100 00100 00100 00100 01110",
    "2": "01110 10001 00001 00010 00100 01000 11111",
    "3": "11111 00010 00100 00010 00001 10001 01110",
    "4": "00010 00110 01010 10010 11111 00010 00010",
    "5": "11111 10000 11110 00001 00001 10001 01110",
    "6": "00110 01000 10000 11110 10001 10001 01110",
    "7": "11111 00001 00010 00100 01000 01000 01000",
    "8": "01110 10001 10001 01110 10001 10001 01110",
    "9": "01110 10001 10001 01111 00001 00010 01100",
    "A": "01110 10001 10001 11111 10001 10001 10001",
    "B": "11110 10001 10001 11110 10001 10001 11110",
    "C": "01110 10001 10000 10000 10000 10001 01110",
    "D": "11100 10010 10001 10001 10001 10010 11100",
    "E": "11111 10000 10000 11110 10000 10000 11111",
    "F": "11111 10000 10000 11110 10000 10000 10000",
    "G": "01110 10001 10000 10111 10001 10001 01111",
    "H": "10001 10001 10001 11111 10001 10001 10001",
    "I": "01110 00100 00100 00100 00100 00100 01110",
    "J": "00111 00010 00010 00010 00010 10010 01100",
    "K": "10001 10010 10100 11000 10100 10010 10001",
    "L": "10000 10000 10000 10000 10000 10000 11111",
    "M": "10001 11011 10101 10101 10001 10001 10001",
    "N": "10001 10001 11001 10101 10011 10001 10001",
    "O": "01110 10001 10001 10001 10001 10001 01110",
    "P": "11110 10001 10001 11110 10000 10000 10000",
    "Q": "01110 10001 10001 10001 10101 10010 01101",
    "R": "11110 10001 10001 11110 10100 10010 10001",
    "S": "01111 10000 10000 01110 00001 00001 11110",
    "T": "11111 00100 00100 00100 00100 00100 00100",
    "U": "10001 10001 10001 10001 10001 10001 01110",
    "V": "10001 10001 10001 10001 10001 01010 00100",
    "W": "10001 10001 10001 10101 10101 10101 01010",
    "X": "10001 10001 01010 00100 01010 10001 10001",
    "Y": "10001 10001 10001 01010 00100 00100 00100",
    "Z": "11111 00001 00010 00100 01000 10000 11111",
    ".": "00000 00000 00000 00000 00000 01100 01100",
    ":": "00000 01100 01100 00000 01100 01100 00000",
    "/": "00000 00001 00010 00100 01000 10000 00000",
    "-": "00000 00000 00000 11111 00000 00000 00000",
    "(": "00010 00100 01000 01000 01000 00100 00010",
    ")": "01000 00100 00010 00010 00010 00100 01000",
    "%": "11000 11001 00010 00100 01000 10011 00011",
    " ": "00000 00000 00000 00000 00000 00000 00000",
  };
  const FONT = {};
  Object.keys(FONT_ROWS).forEach((ch) => {
    FONT[ch] = FONT_ROWS[ch].split(" ").map((row) => parseInt(row, 2));
  });

  function createBitmap(w, h) {
    const rowBytes = Math.ceil(w / 8);
    const data = new Array(rowBytes * h);
    for (let i = 0; i < data.length; i++) data[i] = 0;
    return { w, h, rowBytes, data };
  }

  function setPixel(bmp, x, y) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= bmp.w || y >= bmp.h) return;
    bmp.data[y * bmp.rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
  }

  function stamp(bmp, x, y, r) {
    if (r <= 0) return setPixel(bmp, x, y);
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy <= r * r + r) setPixel(bmp, x + dx, y + dy);
      }
    }
  }

  // points: [[x, y] | null]; null breaks the line. style: {r, on, off}
  function drawPolyline(bmp, points, style) {
    const period = style.off > 0 ? style.on + style.off : 0;
    let dist = 0;
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      if (!a || !b) continue;
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      const steps = Math.max(1, Math.ceil(len * 2));
      for (let k = 0; k <= steps; k++) {
        const d = dist + (len * k) / steps;
        if (period && d % period >= style.on) continue;
        stamp(bmp, a[0] + ((b[0] - a[0]) * k) / steps, a[1] + ((b[1] - a[1]) * k) / steps, style.r);
      }
      dist += len;
    }
  }

  function hLine(bmp, x0, x1, y, every) {
    for (let x = x0; x <= x1; x += every || 1) setPixel(bmp, x, y);
  }

  function vLine(bmp, x, y0, y1, every) {
    for (let y = y0; y <= y1; y += every || 1) setPixel(bmp, x, y);
  }

  function textWidth(str, scale) {
    return str.length ? str.length * 6 * scale - scale : 0;
  }

  function drawText(bmp, x, y, str, scale) {
    const text = String(str).toUpperCase();
    for (let i = 0; i < text.length; i++) {
      const glyph = FONT[text[i]] || FONT[" "];
      const gx = x + i * 6 * scale;
      for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 5; col++) {
          if (!(glyph[row] & (0x10 >> col))) continue;
          for (let sy = 0; sy < scale; sy++) {
            for (let sx = 0; sx < scale; sx++) setPixel(bmp, gx + col * scale + sx, y + row * scale + sy);
          }
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Graph rendering
  // ---------------------------------------------------------------------------

  const STYLES = {
    pressure: { r: 1, on: 1, off: 0 },
    flow: { r: 1, on: 12, off: 8 },
    weight: { r: 1, on: 2, off: 7 },
    target: { r: 0, on: 2, off: 4 },
  };

  function niceTimeAxis(duration, plotWidth, scale) {
    const steps = [5, 10, 15, 20, 30, 60, 120, 300, 600];
    for (const step of steps) {
      const max = Math.max(step * 2, Math.ceil(Math.max(duration, 1) / step) * step);
      const spacing = (plotWidth * step) / max;
      if (spacing >= textWidth(String(max), scale) + 14) return { max, step };
    }
    const step = steps[steps.length - 1];
    return { max: Math.ceil(Math.max(duration, 1) / step) * step, step };
  }

  function niceLeftAxis(maxValue) {
    const step = maxValue > 12 ? 4 : 2;
    const max = Math.max(10, Math.ceil(maxValue / step) * step);
    return { max, step };
  }

  function niceRightAxis(maxWeight, ticks) {
    const candidates = [1, 2, 5, 10, 15, 20, 25, 50, 100];
    for (const c of candidates) {
      if (c * ticks >= maxWeight) return { max: c * ticks, step: c };
    }
    const c = Math.ceil(maxWeight / ticks / 100) * 100;
    return { max: c * ticks, step: c };
  }

  function renderGraph(series, summary, widthDots, showTargets) {
    const scale = 2;
    const charH = 7 * scale;
    const weights = series.weight.map((w) => (w === null ? 0 : w));
    const maxWeight = Math.max(0, ...weights, summary.targetYield || 0);
    const hasWeight = weights.some((w) => w > 0.5);

    const leftMaxData = Math.max(
      0,
      ...series.pressure,
      ...series.flow,
      ...(showTargets ? series.targetPressure.concat(series.targetFlow) : [])
    );
    const left = niceLeftAxis(leftMaxData);
    const ticks = left.max / left.step;
    const right = hasWeight ? niceRightAxis(maxWeight, ticks) : null;

    const leftLabelW = textWidth(String(left.max), scale);
    const rightLabelW = right ? textWidth(String(right.max), scale) : 0;
    const L = leftLabelW + 10;
    const R = widthDots - 1 - (right ? rightLabelW + 10 : 12);
    const time = niceTimeAxis(summary.duration, R - L, scale);
    const T = charH + 12;
    const plotH = Math.round(widthDots * 0.5);
    const B = T + plotH;

    const legend = [
      { label: "PRESSURE BAR", style: STYLES.pressure },
      { label: "FLOW ML/S", style: STYLES.flow },
    ];
    if (hasWeight) legend.push({ label: "WEIGHT G", style: STYLES.weight });
    if (showTargets) legend.push({ label: "TARGET", style: STYLES.target });

    const sampleW = 36;
    const itemGap = 22;
    const rows = [[]];
    let rowW = 0;
    legend.forEach((item) => {
      const w = sampleW + 8 + textWidth(item.label, scale);
      if (rows[rows.length - 1].length && rowW + itemGap + w > widthDots) {
        rows.push([]);
        rowW = 0;
      }
      rowW += (rows[rows.length - 1].length ? itemGap : 0) + w;
      rows[rows.length - 1].push({ item, w });
    });

    const xLabelY = B + 8;
    const xTitleY = xLabelY + charH + 8;
    const legendY = xTitleY + charH + 18;
    const legendRowH = charH + 12;
    const height = legendY + rows.length * legendRowH + 4;
    const bmp = createBitmap(widthDots, height);

    const xOf = (t) => L + ((R - L) * t) / time.max;
    const yLeft = (v) => B - ((B - T) * Math.min(Math.max(v, 0), left.max)) / left.max;
    const yRight = (v) => B - ((B - T) * Math.min(Math.max(v, 0), right.max)) / right.max;

    drawText(bmp, 0, 0, "BAR ML/S", scale);
    if (right) drawText(bmp, widthDots - textWidth("G", scale), 0, "G", scale);

    for (let i = 0; i <= ticks; i++) {
      const v = i * left.step;
      const y = Math.round(yLeft(v));
      if (i > 0) hLine(bmp, L, R, y, 4);
      const lbl = String(v);
      drawText(bmp, L - 6 - textWidth(lbl, scale), y - charH / 2, lbl, scale);
      if (right) drawText(bmp, R + 8, y - charH / 2, String(i * right.step), scale);
    }
    for (let t = 0; t <= time.max; t += time.step) {
      const x = Math.round(xOf(t));
      if (t > 0) vLine(bmp, x, T, B, 4);
      const lbl = String(t);
      drawText(bmp, x - textWidth(lbl, scale) / 2, xLabelY, lbl, scale);
    }
    const xTitle = "SECONDS";
    drawText(bmp, L + (R - L - textWidth(xTitle, scale)) / 2, xTitleY, xTitle, scale);

    vLine(bmp, L, T, B);
    hLine(bmp, L, R, B);
    if (right) vLine(bmp, R, T, B);

    const toPoints = (values, yFn, skipZero) =>
      values.map((v, i) => (v === null || (skipZero && v <= 0) ? null : [xOf(series.t[i]), yFn(v)]));

    if (showTargets) {
      drawPolyline(bmp, toPoints(series.targetPressure, yLeft, true), STYLES.target);
      drawPolyline(bmp, toPoints(series.targetFlow, yLeft, true), STYLES.target);
    }
    if (hasWeight) drawPolyline(bmp, toPoints(series.weight, yRight, false), STYLES.weight);
    drawPolyline(bmp, toPoints(series.flow, yLeft, false), STYLES.flow);
    drawPolyline(bmp, toPoints(series.pressure, yLeft, false), STYLES.pressure);

    rows.forEach((row, r) => {
      const total = row.reduce((acc, e, i) => acc + e.w + (i ? itemGap : 0), 0);
      let x = Math.max(0, Math.round((widthDots - total) / 2));
      const y = legendY + r * legendRowH;
      row.forEach(({ item, w }) => {
        const midY = y + charH / 2;
        drawPolyline(bmp, [[x + 2, midY], [x + sampleW - 2, midY]], item.style);
        drawText(bmp, x + sampleW + 8, y, item.label, scale);
        x += w + itemGap;
      });
    });

    return bmp;
  }

  // ---------------------------------------------------------------------------
  // Receipt layout (device independent blocks)
  // ---------------------------------------------------------------------------

  function asciiText(value) {
    let s = String(value === null || value === undefined ? "" : value);
    try {
      s = s.normalize("NFD").replace(/[̀-ͯ]/g, "");
    } catch (e) {
      // normalize is optional in some JS engines
    }
    s = s.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-");
    return s.replace(/[\r\n\t]+/g, " ").replace(/[^\x20-\x7e]/g, "?");
  }

  function wrap(text, width) {
    const words = asciiText(text).split(" ");
    const lines = [];
    let line = "";
    words.forEach((word) => {
      while (word.length > width) {
        if (line) {
          lines.push(line);
          line = "";
        }
        lines.push(word.slice(0, width));
        word = word.slice(width);
      }
      if (!line) line = word;
      else if (line.length + 1 + word.length <= width) line += " " + word;
      else {
        lines.push(line);
        line = word;
      }
    });
    if (line) lines.push(line);
    return lines;
  }

  function kv(key, value, width) {
    const k = asciiText(key);
    const v = asciiText(value);
    if (k.length + 1 + v.length <= width) {
      return [k + " ".repeat(width - k.length - v.length) + v];
    }
    return [k].concat(wrap(v, width - 2).map((l) => "  " + l));
  }

  function fmt(n, digits) {
    return Number(n).toFixed(digits);
  }

  function pad2(n) {
    return (n < 10 ? "0" : "") + n;
  }

  function formatDate(d) {
    if (!d || isNaN(d.getTime())) return "";
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  }

  function buildReceipt(shot, cfg) {
    const spec = paperSpec(cfg.paper);
    const W = spec.chars;
    const series = extractSeries(shot);
    if (series.t.length < 2) throw new Error("This shot has no espresso measurements to plot.");
    const sum = summarize(shot, series);
    const blocks = [];
    const text = (t, opts) => blocks.push(Object.assign({ type: "text", text: asciiText(t) }, opts || {}));

    if (cfg.header) {
      wrap(cfg.header, Math.floor(W / 2)).forEach((l) => text(l, { align: "center", big: true }));
      text("");
    }
    wrap(sum.profile, W).forEach((l) => text(l, { align: "center", bold: true }));
    if (sum.when) text(formatDate(sum.when), { align: "center" });
    text("-".repeat(W));

    const lines = [];
    if (sum.dose !== null) lines.push(...kv("Dose", `${fmt(sum.dose, 1)} g`, W));
    if (sum.yieldG !== null) lines.push(...kv("Yield", `${fmt(sum.yieldG, 1)} g`, W));
    if (sum.dose && sum.yieldG) lines.push(...kv("Ratio", `1:${fmt(sum.yieldG / sum.dose, 1)}`, W));
    lines.push(...kv("Time", `${fmt(sum.duration, 1)} s`, W));
    if (sum.peakPressure !== null) lines.push(...kv("Peak pressure", `${fmt(sum.peakPressure, 1)} bar`, W));
    if (sum.coffee) lines.push(...kv("Coffee", sum.coffee, W));
    if (sum.grinder) lines.push(...kv("Grinder", sum.grinder, W));
    if (sum.tds !== null) lines.push(...kv("TDS", `${fmt(sum.tds, 2)} %`, W));
    if (sum.ey !== null) lines.push(...kv("EY", `${fmt(sum.ey, 1)} %`, W));
    if (sum.enjoyment !== null) lines.push(...kv("Enjoyment", `${fmt(sum.enjoyment, 0)} / 10`, W));
    if (sum.barista) lines.push(...kv("Barista", sum.barista, W));
    if (sum.drinker) lines.push(...kv("For", sum.drinker, W));
    lines.forEach((l) => text(l));
    text("");

    blocks.push({ type: "image", bitmap: renderGraph(series, sum, spec.dots, cfg.showTargets) });

    if (sum.notes) {
      text("");
      wrap(sum.notes, W).forEach((l) => text(l));
    }
    if (cfg.footer) {
      text("");
      wrap(cfg.footer, W).forEach((l) => text(l, { align: "center" }));
    }
    return { blocks, summary: sum };
  }

  // ---------------------------------------------------------------------------
  // ESC/POS encoding
  // ---------------------------------------------------------------------------

  function encodeEscPos(blocks, cfg) {
    const out = [];
    const push = (...bytes) => {
      for (const b of bytes) out.push(b & 0xff);
    };
    const pushText = (s) => {
      for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0x7f);
    };

    push(0x1b, 0x40);
    for (const block of blocks) {
      if (block.type === "text") {
        push(0x1b, 0x61, block.align === "center" ? 1 : 0);
        push(0x1b, 0x45, block.bold ? 1 : 0);
        push(0x1d, 0x21, block.big ? 0x11 : 0x00);
        pushText(block.text);
        push(0x0a);
      } else if (block.type === "image") {
        const bmp = block.bitmap;
        push(0x1b, 0x61, 0);
        for (let y0 = 0; y0 < bmp.h; y0 += RASTER_BAND_ROWS) {
          const rows = Math.min(RASTER_BAND_ROWS, bmp.h - y0);
          push(0x1d, 0x76, 0x30, 0x00, bmp.rowBytes & 0xff, bmp.rowBytes >> 8, rows & 0xff, rows >> 8);
          const start = y0 * bmp.rowBytes;
          for (let i = 0; i < rows * bmp.rowBytes; i++) out.push(bmp.data[start + i]);
        }
      }
    }
    push(0x1b, 0x61, 0, 0x1b, 0x45, 0, 0x1d, 0x21, 0);
    push(0x1b, 0x64, 4);
    if (cfg.cut) push(0x1d, 0x56, 0x42, 0x00);
    return out;
  }

  const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

  function base64(bytes) {
    const parts = [];
    let chunk = "";
    for (let i = 0; i < bytes.length; i += 3) {
      const a = bytes[i];
      const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
      const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
      chunk +=
        B64[a >> 2] +
        B64[((a & 3) << 4) | (b >> 4)] +
        (i + 1 < bytes.length ? B64[((b & 15) << 2) | (c >> 6)] : "=") +
        (i + 2 < bytes.length ? B64[c & 63] : "=");
      if (chunk.length >= 8192) {
        parts.push(chunk);
        chunk = "";
      }
    }
    parts.push(chunk);
    return parts.join("");
  }

  // ---------------------------------------------------------------------------
  // Printing
  // ---------------------------------------------------------------------------

  function withTimeout(promise, ms, message) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(message)), ms);
      promise.then(
        (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        }
      );
    });
  }

  async function sendToPrinter(bytes, cfg) {
    if (!cfg.host) throw new Error("Printer IP address is not set. Add it in the plugin settings.");
    const opened = await withTimeout(
      host.transport.open({ kind: "tcp", host: cfg.host, port: cfg.port }),
      CONNECT_TIMEOUT_MS,
      `Could not reach the printer at ${cfg.host}:${cfg.port}.`
    );
    const handle = opened.handle;
    host.transport.onEvent(handle, (event) => {
      if (event.type === "error") log(`Printer connection error: ${event.message || event.code}`);
    });
    try {
      await host.transport.send(handle, { type: "binary", data: base64(bytes) });
    } finally {
      try {
        await host.transport.close(handle);
      } catch (e) {
        log(`Closing printer connection failed: ${e.message}`);
      }
    }
  }

  function isRecent(timestamp) {
    // NaN (missing or invalid) compares false, so it is never auto-printed.
    return Math.abs(Date.now() - Date.parse(timestamp)) <= AUTO_PRINT_MAX_AGE_MS;
  }

  function printShot(shotId, reason) {
    const job = queue.then(async () => {
      const cfg = config;
      try {
        const shot = await fetchShot(shotId);
        if (reason === "auto" && !isRecent(shot.timestamp)) {
          log(`Skipping shot ${shot.id}: recorded ${shot.timestamp}, not recent enough to auto-print (imported?)`);
          lastResult = { ok: true, skipped: true, reason: "old", shotId: shot.id, at: new Date().toISOString() };
          return lastResult;
        }
        const receipt = buildReceipt(shot, cfg);
        if (reason === "auto" && receipt.summary.duration < cfg.minShotSeconds) {
          log(`Skipping shot ${shot.id}: ${receipt.summary.duration.toFixed(1)} s is under the minimum length`);
          lastResult = { ok: true, skipped: true, shotId: shot.id, at: new Date().toISOString() };
          return lastResult;
        }
        const bytes = encodeEscPos(receipt.blocks, cfg);
        await sendToPrinter(bytes, cfg);
        log(`Printed shot ${shot.id} (${bytes.length} bytes) to ${cfg.host}:${cfg.port}`);
        lastResult = { ok: true, shotId: shot.id, bytes: bytes.length, at: new Date().toISOString() };
      } catch (e) {
        log(`Print failed: ${e.message}`);
        lastResult = { ok: false, shotId: shotId || null, error: e.message, at: new Date().toISOString() };
      }
      return lastResult;
    });
    queue = job.catch(() => undefined);
    return job;
  }

  // ---------------------------------------------------------------------------
  // HTTP endpoints
  // ---------------------------------------------------------------------------

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  // JSON.stringify alone lets "</script>" in imported data end the inline script.
  function scriptLiteral(value) {
    return JSON.stringify(value).replace(/</g, "\\u003c");
  }

  function html(status, body) {
    return { status, headers: { "Content-Type": "text/html; charset=utf-8" }, body };
  }

  // Decaid only accepts string response bodies.
  function json(status, body) {
    return { status, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
  }

  const PAGE_STYLE = `
    :root { color-scheme: light dark; --bg:#f4f1ec; --fg:#1d1b18; --muted:#6b645b; --card:#fff; --line:#d9d3ca; --accent:#1d1b18; }
    @media (prefers-color-scheme: dark) { :root { --bg:#171513; --fg:#eeeae4; --muted:#a39a8f; --card:#221f1c; --line:#3a3530; --accent:#eeeae4; } }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.45 system-ui, -apple-system, Segoe UI, sans-serif; }
    main { max-width: 720px; margin: 0 auto; padding: 24px 16px 48px; }
    h1 { font-size: 20px; margin: 0 0 4px; }
    .muted { color: var(--muted); font-size: 13px; }
    .bar { display:flex; flex-wrap:wrap; gap:10px; align-items:center; margin: 18px 0; }
    select, button { font: inherit; padding: 9px 12px; border-radius: 8px; border: 1px solid var(--line); background: var(--card); color: var(--fg); }
    button.primary { background: var(--accent); color: var(--bg); border-color: var(--accent); font-weight: 600; }
    .paper { background:#fff; color:#000; margin: 0 auto; padding: 18px 14px; box-shadow: 0 2px 14px rgba(0,0,0,.18); border-radius: 2px; }
    .sheet { container-type: inline-size; margin: 0 auto; }
    .paper pre { margin:0; font: 13px/1.35 ui-monospace, Menlo, Consolas, monospace; font-size: calc(100cqw / (var(--chars) * 0.61)); white-space: pre; overflow: hidden; }
    .paper .c { text-align:center; } .paper .b { font-weight:700; } .paper .big { font-size: calc(200cqw / (var(--chars) * 0.61)); line-height: 1.3; font-weight:700; }
    .paper canvas { display:block; margin: 4px auto; width: 100%; image-rendering: pixelated; }
    #msg { min-height: 1.4em; }
    .err { color: #c0392b; }
  `;

  function previewPage(receipt, cfg, recent, shotId) {
    const spec = paperSpec(cfg.paper);
    const paperPx = spec.chars * 9;
    const parts = receipt.blocks.map((b) => {
      if (b.type === "text") {
        const cls = [b.align === "center" ? "c" : "", b.bold ? "b" : "", b.big ? "big" : ""].join(" ").trim();
        return `<pre class="${cls}">${escapeHtml(b.text) || "&nbsp;"}</pre>`;
      }
      const bmp = b.bitmap;
      return `<canvas data-w="${bmp.w}" data-h="${bmp.h}" data-bits="${base64(bmp.data)}"></canvas>`;
    });
    const options = recent
      .map((s) => {
        const title = (s.workflow && s.workflow.profile && s.workflow.profile.title) || "Shot";
        const when = s.timestamp ? formatDate(new Date(s.timestamp)) : "";
        const sel = s.id === shotId ? " selected" : "";
        return `<option value="${escapeHtml(s.id)}"${sel}>${escapeHtml(when + "  " + title)}</option>`;
      })
      .join("");
    const printerLine = cfg.host
      ? `Printer ${escapeHtml(cfg.host)}:${cfg.port}, ${cfg.paper} paper`
      : `<span class="err">No printer IP set yet. Add it in the plugin settings.</span>`;
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Shot Printer</title><style>${PAGE_STYLE}</style></head><body><main>
<h1>Shot Printer</h1><div class="muted">${printerLine}</div>
<div class="bar">
  ${options ? `<select id="shot" aria-label="Shot">${options}</select>` : ""}
  <button class="primary" id="print">Print this shot</button>
  <span id="msg" class="muted"></span>
</div>
<div class="paper" style="max-width:${Math.round(paperPx + 28)}px"><div class="sheet" style="--chars:${spec.chars}">${parts.join("\n")}</div></div>
</main>
<script>
document.querySelectorAll("canvas[data-bits]").forEach(function (c) {
  var w = +c.dataset.w, h = +c.dataset.h, raw = atob(c.dataset.bits), rb = Math.ceil(w / 8);
  c.width = w; c.height = h;
  var ctx = c.getContext("2d"), img = ctx.createImageData(w, h);
  for (var y = 0; y < h; y++) for (var x = 0; x < w; x++) {
    var on = raw.charCodeAt(y * rb + (x >> 3)) & (0x80 >> (x & 7)), i = (y * w + x) * 4, v = on ? 0 : 255;
    img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
});
var sel = document.getElementById("shot");
if (sel) sel.onchange = function () { location.search = "?shotId=" + encodeURIComponent(sel.value); };
var shotId = ${scriptLiteral(shotId || receipt.summary.id || "")};
document.getElementById("print").onclick = function () {
  var msg = document.getElementById("msg"), btn = this;
  btn.disabled = true; msg.className = "muted"; msg.textContent = "Printing...";
  fetch("print?format=json&shotId=" + encodeURIComponent(shotId)).then(function (r) { return r.json(); }).then(function (r) {
    msg.textContent = r.ok ? "Sent to printer." : (r.error || "Print failed.");
    if (!r.ok) msg.className = "err";
  }).catch(function (e) { msg.className = "err"; msg.textContent = String(e); })
    .finally(function () { btn.disabled = false; });
};
</script></body></html>`;
  }

  function messagePage(title, detail, isError) {
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Shot Printer</title><style>${PAGE_STYLE}</style></head><body><main>
<h1>${escapeHtml(title)}</h1><p class="${isError ? "err" : "muted"}">${escapeHtml(detail)}</p>
<p><a href="preview">Open the preview</a></p></main></body></html>`;
  }

  async function handleHttpRequest(request) {
    const query = request.query || {};
    const shotId = query.shotId ? String(query.shotId) : "";
    try {
      switch (request.endpoint) {
        case "status":
          return json(200, {
            printer: config.host ? `${config.host}:${config.port}` : null,
            paper: config.paper,
            autoPrint: config.autoPrint,
            lastResult,
          });
        case "print": {
          const result = await printShot(shotId || null, "manual");
          if (query.format === "json") return json(result.ok ? 200 : 502, result);
          return html(
            result.ok ? 200 : 502,
            result.ok
              ? messagePage("Sent to printer", `Shot ${result.shotId} was sent to ${config.host}.`, false)
              : messagePage("Print failed", result.error, true)
          );
        }
        case "preview": {
          const shot = await fetchShot(shotId || null);
          const receipt = buildReceipt(shot, config);
          const recent = await fetchRecentShots(15);
          return html(200, previewPage(receipt, config, recent, shot.id));
        }
        default:
          return json(404, { error: `Unknown endpoint ${request.endpoint}` });
      }
    } catch (e) {
      log(`${request.endpoint} failed: ${e.message}`);
      if (request.endpoint === "status" || query.format === "json") return json(500, { ok: false, error: e.message });
      return html(500, messagePage("Something went wrong", e.message, true));
    }
  }

  // ---------------------------------------------------------------------------
  // Plugin object
  // ---------------------------------------------------------------------------

  return {
    id: PLUGIN_ID,
    version: "0.2.1",

    onLoad(settings) {
      config = readSettings(settings || {});
      log(
        `Loaded. Printer ${config.host ? `${config.host}:${config.port}` : "not configured"}, ` +
          `${config.paper}, auto print ${config.autoPrint ? "on" : "off"}`
      );
    },

    onUnload() {
      pendingTimers.forEach((t) => clearTimeout(t));
      pendingTimers = [];
    },

    onEvent(event) {
      if (!event || !event.name) return;
      if (event.name === "shotStored") {
        if (!config.autoPrint) return;
        if (!config.host) {
          log("Shot stored, but no printer IP is set; skipping");
          return;
        }
        const id = event.payload && event.payload.id;
        const timer = setTimeout(() => {
          pendingTimers = pendingTimers.filter((t) => t !== timer);
          printShot(id || null, "auto");
        }, SHOT_FETCH_DELAY_MS);
        pendingTimers.push(timer);
      } else if (event.name === "settingsUpdated" && event.payload) {
        config = readSettings(Object.assign({}, rawSettingsFrom(config), event.payload));
      }
    },

    handleHttpRequest,

    // Exposed for the offline test harness; not used by Decaid.
    __test: { buildReceipt, encodeEscPos, renderGraph, extractSeries, summarize, base64 },
  };

  function rawSettingsFrom(cfg) {
    return {
      PrinterHost: cfg.host,
      PrinterPort: cfg.port,
      PaperWidth: cfg.paper,
      AutoPrint: cfg.autoPrint,
      MinShotSeconds: cfg.minShotSeconds,
      HeaderText: cfg.header,
      FooterText: cfg.footer,
      ShowTargets: cfg.showTargets,
      CutPaper: cfg.cut,
    };
  }
}
