// ============================================================================
//  festive-poster.js — त्यौहार वाले सजे-सजाए poster   (v1.0)
//  ---------------------------------------------------------------------------
//  server.js के नीचे, app.listen से पहले:
//
//      let FESTIVE = null;
//      try {
//        FESTIVE = require("./festive-poster.js")(app, {
//          log, BRANDS, OUT_DIR, PUBLIC_URL, requireRole, mongoose, sharp,
//          Vehicle, composeLogos, compressImage,
//        });
//      } catch (e) {
//        log("ERROR", "festive-poster चालू नहीं हुआ", { msg: e.message });
//      }
//      global.__FESTIVE = FESTIVE;
//
//  ---------------------------------------------------------------------------
//  ⚠️ पहले क्या था
//
//  auto-generate वाली post generateImages() से बनती है, जो सिर्फ़ सादा रंग और
//  बीच में लिखा हुआ text बनाता है। कोई सजावट नहीं, कोई गाड़ी नहीं।
//
//  ⚠️ अब क्या है
//
//  पूरा सजा हुआ poster — मेहराब, गेंदे की माला, घंटियाँ, मोरपंख, मटकी,
//  रंगोली, संगमरमर जैसी पृष्ठभूमि — सब code से बनते हैं। और सबसे ज़रूरी:
//  आपकी अपनी गाड़ियों की असली photo (जो अब database में हैं) कतार में,
//  परछाईं के साथ लग जाती हैं।
//
//  ⚠️ जो code नहीं बना सकता — और उसका हल
//
//  भगवान की चित्रित मूर्ति (कृष्ण, गणेश, लक्ष्मी) — वह कलाकारी है, गणित से
//  नहीं बनती। इसका सीधा हल: एक बार उस त्यौहार की तस्वीर चढ़ा दीजिए (बिना
//  background वाली PNG सबसे अच्छी)। वह database में रहेगी और हर साल उसी
//  त्यौहार पर अपने-आप लग जाएगी। एक बार का काम है।
// ============================================================================

"use strict";

const fs = require("fs");
const path = require("path");
const multer = require("multer");

module.exports = function mountFestivePoster(app, deps) {
  const {
    BRANDS = {}, OUT_DIR, PUBLIC_URL = "", requireRole, mongoose, sharp,
    Vehicle, composeLogos, compressImage,
  } = deps;
  const log = deps.log || ((l, m, x) => console.log(`[${l}] ${m}`, x || ""));
  const L = (m, x) => log("INFO", "[festive] " + m, x);
  const bad = (res, e, c = 500) => res.status(c).json({ error: e.message || String(e) });
  const esc = (s) => String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // ══════════════════════════════════════════════════════════════════════════
  //  हर त्यौहार का अपना रंग और सजावट
  // ══════════════════════════════════════════════════════════════════════════
  const THEMES = {
    janmashtami: {
      label: "जन्माष्टमी", head: "#7b1fa2", title: "#8e0000",
      bg1: "#fdf6e6", bg2: "#efe0c2", gold: "#c9a227",
      motifs: ["feather", "matki", "garland", "arch", "rangoli"],
    },
    diwali: {
      label: "दिवाली", head: "#e65100", title: "#b71c1c",
      bg1: "#fff3e0", bg2: "#ffe0b2", gold: "#ff8f00",
      motifs: ["diya", "garland", "arch", "rangoli", "sparkle"],
    },
    ganesh: {
      label: "गणेश चतुर्थी", head: "#c62828", title: "#ad1457",
      bg1: "#fff8e1", bg2: "#ffecb3", gold: "#d4a017",
      motifs: ["modak", "garland", "arch", "rangoli"],
    },
    navratri: {
      label: "नवरात्रि", head: "#ad1457", title: "#6a1b9a",
      bg1: "#fce4ec", bg2: "#f8bbd0", gold: "#e91e63",
      motifs: ["garland", "arch", "rangoli", "sparkle"],
    },
    holi: {
      label: "होली", head: "#6a1b9a", title: "#c2185b",
      bg1: "#fff9c4", bg2: "#ffe0b2", gold: "#f57f17",
      motifs: ["sparkle", "rangoli", "garland"],
    },
    general: {
      label: "आम त्यौहार", head: "#8e0000", title: "#5d4037",
      bg1: "#fdf6e6", bg2: "#efe0c2", gold: "#c9a227",
      motifs: ["garland", "arch", "rangoli"],
    },
  };

  const themeFor = (name = "") => {
    const n = String(name).toLowerCase();
    if (/जन्माष्टमी|janmashtami|कृष्ण|krishna/.test(n)) return "janmashtami";
    if (/दिवाली|दीपावली|diwali|deepawali/.test(n)) return "diwali";
    if (/गणेश|ganesh|चतुर्थी/.test(n)) return "ganesh";
    if (/नवरात्रि|navratri|दुर्गा|durga|दशहरा|dussehra/.test(n)) return "navratri";
    if (/होली|holi|रंग/.test(n)) return "holi";
    return "general";
  };

  // ══════════════════════════════════════════════════════════════════════════
  //  त्यौहार की तस्वीर — एक बार चढ़ाइए, हर साल काम आएगी
  // ══════════════════════════════════════════════════════════════════════════
  const FestiveArt = mongoose.models.FestiveArt || mongoose.model("FestiveArt",
    new mongoose.Schema({
      festival: { type: String, required: true, index: true },  // janmashtami, diwali…
      name: String,
      data: String,            // base64 png
      sizeKB: Number,
      active: { type: Boolean, default: true },
      addedBy: String,
    }, { timestamps: true }));

  const artUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 10 * 1024 * 1024 },
    fileFilter: (req, f, cb) => cb(null, /^image\//.test(f.mimetype)),
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  सजावट के टुकड़े — सब गणित से बनते हैं
  // ══════════════════════════════════════════════════════════════════════════

  function marbleBg(W, H, t) {
    let s = `<defs>
      <linearGradient id="mb" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="${t.bg1}"/><stop offset="50%" stop-color="${t.bg1}"/>
        <stop offset="100%" stop-color="${t.bg2}"/></linearGradient>
      <radialGradient id="gw" cx="50%" cy="26%" r="58%">
        <stop offset="0%" stop-color="#fffdf5" stop-opacity="0.85"/>
        <stop offset="100%" stop-color="#fffdf5" stop-opacity="0"/></radialGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#mb)"/>`;
    // संगमरमर जैसी हल्की धारियाँ — एक ही seed से, ताकि हर बार वही दिखे
    let seed = 7;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let i = 0; i < 22; i++) {
      const y = rnd() * H, x = rnd() * W, l = W * (0.2 + rnd() * 0.5);
      s += `<path d="M ${x.toFixed(0)} ${y.toFixed(0)} q ${(l * 0.4).toFixed(0)} ${(-20 + rnd() * 40).toFixed(0)} ${l.toFixed(0)} ${(-10 + rnd() * 20).toFixed(0)}" stroke="${t.gold}" stroke-width="${(0.8 + rnd() * 1.4).toFixed(1)}" fill="none" opacity="0.16"/>`;
    }
    return s + `<rect width="${W}" height="${H}" fill="url(#gw)"/>`;
  }

  const frame = (W, H, t) => `
    <rect x="12" y="12" width="${W - 24}" height="${H - 24}" fill="none" stroke="${t.gold}" stroke-width="7"/>
    <rect x="30" y="30" width="${W - 60}" height="${H - 60}" fill="none" stroke="${t.head}" stroke-width="2" stroke-dasharray="12 9" opacity="0.55"/>`;

  const arch = (W, H, t) => {
    const ax = W / 2, top = H * 0.03, aw = W * 0.9, ah = H * 0.15;
    return `<path d="M ${ax - aw / 2} ${top + ah} V ${top + ah * 0.45} Q ${ax - aw / 2} ${top} ${ax} ${top} Q ${ax + aw / 2} ${top} ${ax + aw / 2} ${top + ah * 0.45} V ${top + ah}" fill="none" stroke="${t.gold}" stroke-width="10" opacity="0.9"/>`;
  };

  function garland(W, H, t, cx) {
    let g = "";
    const n = 9, y0 = H * 0.045, step = H * 0.026, r = W * 0.017;
    for (let i = 0; i < n; i++) {
      const y = y0 + i * step;
      g += `<circle cx="${cx}" cy="${y.toFixed(0)}" r="${r.toFixed(1)}" fill="${i % 2 ? "#ff9800" : "#ffb300"}"/>`;
      g += `<circle cx="${cx}" cy="${y.toFixed(0)}" r="${(r * 0.45).toFixed(1)}" fill="#ef6c00" opacity="0.55"/>`;
    }
    // नीचे घंटी
    const by = y0 + n * step + H * 0.018;
    g += `<path d="M ${cx - W * 0.023} ${by.toFixed(0)} Q ${cx} ${(by - H * 0.026).toFixed(0)} ${cx + W * 0.023} ${by.toFixed(0)} Q ${cx + W * 0.023} ${(by + H * 0.017).toFixed(0)} ${cx} ${(by + H * 0.017).toFixed(0)} Q ${cx - W * 0.023} ${(by + H * 0.017).toFixed(0)} ${cx - W * 0.023} ${by.toFixed(0)} Z" fill="${t.gold}"/>`;
    g += `<circle cx="${cx}" cy="${(by + H * 0.022).toFixed(0)}" r="${(W * 0.008).toFixed(1)}" fill="${t.head}"/>`;
    return g;
  }

  const feather = (cx, cy, rot, s) => `<g transform="translate(${cx},${cy}) rotate(${rot}) scale(${s})">
    <ellipse cx="0" cy="0" rx="26" ry="54" fill="#1b8a6b" opacity="0.5"/>
    <ellipse cx="0" cy="-9" rx="16" ry="29" fill="#0d5c8c" opacity="0.7"/>
    <ellipse cx="0" cy="-13" rx="9" ry="15" fill="#2e7d32"/>
    <circle cx="0" cy="-15" r="6" fill="#f9a825"/></g>`;

  const matki = (cx, cy, s) => `<g transform="translate(${cx},${cy}) scale(${s})">
    <path d="M -46 -10 Q -57 34 0 43 Q 57 34 46 -10 Q 30 -27 0 -27 Q -30 -27 -46 -10 Z" fill="#a1662f"/>
    <path d="M -44 -8 Q 0 8 44 -8" stroke="#c9a227" stroke-width="4" fill="none"/>
    <ellipse cx="0" cy="-27" rx="30" ry="9" fill="#8d5524"/>
    <ellipse cx="0" cy="-29" rx="24" ry="6" fill="#fffde7"/></g>`;

  const diya = (cx, cy, s) => `<g transform="translate(${cx},${cy}) scale(${s})">
    <path d="M -34 0 Q 0 26 34 0 Q 20 12 0 12 Q -20 12 -34 0 Z" fill="#a1662f"/>
    <ellipse cx="0" cy="0" rx="34" ry="9" fill="#8d5524"/>
    <path d="M 0 -4 Q -9 -22 0 -34 Q 9 -22 0 -4 Z" fill="#ff9800"/>
    <path d="M 0 -8 Q -5 -19 0 -27 Q 5 -19 0 -8 Z" fill="#fff176"/></g>`;

  const modak = (cx, cy, s) => `<g transform="translate(${cx},${cy}) scale(${s})">
    <path d="M 0 -34 Q 24 -6 30 20 Q 0 30 -30 20 Q -24 -6 0 -34 Z" fill="#ffca28"/>
    <path d="M 0 -34 Q 8 -22 0 -16 Q -8 -22 0 -34 Z" fill="#f9a825"/>
    <ellipse cx="0" cy="21" rx="30" ry="7" fill="#f57f17" opacity="0.7"/></g>`;

  function rangoli(W, cx, cy, r, t) {
    let s = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${t.gold}" stroke-width="3" opacity="0.45"/>
      <circle cx="${cx}" cy="${cy}" r="${(r * 0.62).toFixed(0)}" fill="none" stroke="${t.head}" stroke-width="2" opacity="0.3"/>`;
    const cols = ["#e53935", "#1e88e5", "#43a047", "#fb8c00"];
    for (let i = 0; i < 20; i++) {
      const a = (i * Math.PI) / 10;
      const px = cx + Math.cos(a) * r * 0.8, py = cy + Math.sin(a) * r * 0.32;
      s += `<ellipse cx="${px.toFixed(0)}" cy="${py.toFixed(0)}" rx="${(r * 0.11).toFixed(0)}" ry="${(r * 0.045).toFixed(0)}" transform="rotate(${(i * 18).toFixed(0)} ${px.toFixed(0)} ${py.toFixed(0)})" fill="${cols[i % 4]}" opacity="0.5"/>`;
    }
    return s;
  }

  function sparkles(W, H, t) {
    let s = ""; let seed = 31;
    const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let i = 0; i < 26; i++) {
      const x = rnd() * W, y = rnd() * H * 0.85, r = W * (0.004 + rnd() * 0.008);
      s += `<path d="M ${x.toFixed(0)} ${(y - r * 2.4).toFixed(0)} L ${(x + r * 0.7).toFixed(0)} ${(y - r * 0.7).toFixed(0)} L ${(x + r * 2.4).toFixed(0)} ${y.toFixed(0)} L ${(x + r * 0.7).toFixed(0)} ${(y + r * 0.7).toFixed(0)} L ${x.toFixed(0)} ${(y + r * 2.4).toFixed(0)} L ${(x - r * 0.7).toFixed(0)} ${(y + r * 0.7).toFixed(0)} L ${(x - r * 2.4).toFixed(0)} ${y.toFixed(0)} L ${(x - r * 0.7).toFixed(0)} ${(y - r * 0.7).toFixed(0)} Z" fill="${t.gold}" opacity="${(0.25 + rnd() * 0.4).toFixed(2)}"/>`;
    }
    return s;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  पूरा poster
  // ══════════════════════════════════════════════════════════════════════════

  function buildFestiveSVG(W, H, o) {
    const t = THEMES[o.theme] || THEMES.general;
    const m = new Set(t.motifs);
    let s = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">`;
    s += marbleBg(W, H, t);
    s += frame(W, H, t);
    if (m.has("arch")) s += arch(W, H, t);
    if (m.has("garland")) s += garland(W, H, t, Math.round(W * 0.085)) + garland(W, H, t, Math.round(W * 0.915));
    if (m.has("feather")) s += feather(W * 0.15, H * 0.05, -28, W / 1080) + feather(W * 0.85, H * 0.05, 28, W / 1080);
    if (m.has("sparkle")) s += sparkles(W, H, t);

    // ── शीर्षक ──────────────────────────────────────────────────
    const T = (y, sz, txt, fill, wt) =>
      `<text x="50%" y="${Math.round(y)}" text-anchor="middle" font-family="Noto Sans Devanagari, Mukta, sans-serif" font-size="${Math.round(sz)}" font-weight="${wt || 800}" fill="${fill}">${esc(txt)}</text>`;

    // तस्वीर लगेगी तो शीर्षक थोड़ा नीचे
    const hasArt = !!o.hasArt;
    let y = hasArt ? H * 0.30 : H * 0.16;

    if (o.kicker) { s += T(y, W * 0.048, o.kicker, t.head); y += H * 0.045; }
    s += T(y, W * (o.title && o.title.length > 12 ? 0.062 : 0.082), o.title || t.label, t.title, 900);
    y += H * 0.038;
    if (o.sub) { s += T(y, W * 0.040, o.sub, "#5d4037", 700); y += H * 0.032; }
    s += `<line x1="${Math.round(W * 0.3)}" y1="${Math.round(y)}" x2="${Math.round(W * 0.7)}" y2="${Math.round(y)}" stroke="${t.gold}" stroke-width="3"/>`;

    // ── गाड़ियों के नीचे रंगोली ───────────────────────────────────
    const vehY = o.vehTop + o.vehH;
    if (m.has("rangoli")) s += rangoli(W, W / 2, vehY - H * 0.01, W * 0.30, t);

    // ── बग़ल की सजावट ────────────────────────────────────────────
    const sc = W / 1080;
    if (m.has("matki")) s += matki(W * 0.10, vehY - H * 0.025, sc) + matki(W * 0.90, vehY - H * 0.025, sc);
    if (m.has("diya")) s += diya(W * 0.10, vehY - H * 0.02, sc * 1.1) + diya(W * 0.90, vehY - H * 0.02, sc * 1.1);
    if (m.has("modak")) s += modak(W * 0.11, vehY - H * 0.03, sc) + modak(W * 0.89, vehY - H * 0.03, sc);

    // ── नीचे का सन्देश ───────────────────────────────────────────
    let by = vehY + H * 0.055;
    if (o.line1) { s += T(by, W * 0.046, o.line1, t.title, 900); by += H * 0.042; }
    if (o.line2) { s += T(by, W * 0.030, o.line2, "#5d4037", 700); by += H * 0.036; }
    if (o.line3) {
      s += `<line x1="${Math.round(W * 0.22)}" y1="${Math.round(by - H * 0.012)}" x2="${Math.round(W * 0.78)}" y2="${Math.round(by - H * 0.012)}" stroke="${t.gold}" stroke-width="2" opacity="0.6"/>`;
      s += T(by + H * 0.022, W * 0.034, o.line3, t.head, 800);
    }
    return s + "</svg>";
  }

  /**
   * गाड़ियों की असली photo कतार में, परछाईं के साथ।
   * ⚠️ सिर्फ़ वही गाड़ियाँ जिनकी photo database में सचमुच है।
   */
  async function vehicleRow(brandId, W, H, maxN) {
    const rows = await Vehicle.find({ brand: brandId, active: true, inStock: true, photoData: { $nin: [null, ""] } })
      .select("photoData name").sort({ updatedAt: -1 }).limit(maxN).lean();
    if (!rows.length) return { parts: [], count: 0 };

    const n = rows.length;
    const bandW = W * 0.88, slot = bandW / n;
    const vh = Math.round(H * 0.20);
    const parts = [];

    for (let i = 0; i < n; i++) {
      try {
        const buf = Buffer.from(rows[i].photoData, "base64");
        const img = await sharp(buf).resize(Math.round(slot * 0.94), vh, { fit: "inside", withoutEnlargement: false }).png().toBuffer();
        const meta = await sharp(img).metadata();
        const left = Math.round(W * 0.06 + i * slot + (slot - (meta.width || slot)) / 2);
        const top = Math.round(H * 0.34 + (vh - (meta.height || vh)));
        // ज़मीन पर परछाईं — गाड़ी चिपकी हुई न लगे
        const shW = Math.round((meta.width || slot) * 0.8), shH = Math.max(8, Math.round(vh * 0.05));
        const shadow = await sharp({ create: { width: shW, height: shH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.22 } } })
          .png().blur(6).toBuffer();
        parts.push({ input: shadow, top: top + (meta.height || vh) - Math.round(shH / 2), left: left + Math.round(((meta.width || slot) - shW) / 2) });
        parts.push({ input: img, top, left });
      } catch (_) {}
    }
    return { parts, count: n, top: H * 0.34, height: vh };
  }

  /**
   * @param opts { brand, festival, title, kicker, sub, line1, line2, line3, sizes }
   */
  async function buildFestivePoster(id, opts) {
    const brandId = opts.brand;
    const theme = opts.theme || themeFor(opts.festival || opts.title);
    const art = await FestiveArt.findOne({ festival: theme, active: true }).sort({ createdAt: -1 }).lean();

    const sizes = opts.sizes || { square: [1080, 1080], story: [1080, 1920], landscape: [1200, 630] };
    const out = {}; const b64 = {};

    for (const [key, [W, H]] of Object.entries(sizes)) {
      const veh = await vehicleRow(brandId, W, H, W > H ? 5 : 4);

      let svg = buildFestiveSVG(W, H, {
        theme, hasArt: !!art,
        kicker: opts.kicker, title: opts.title, sub: opts.sub,
        line1: opts.line1, line2: opts.line2, line3: opts.line3,
        vehTop: veh.top || H * 0.34, vehH: veh.height || H * 0.20,
      });

      let base = await sharp(Buffer.from(svg)).png().toBuffer();

      const layers = [];
      // त्यौहार की तस्वीर सबसे ऊपर बीच में
      if (art?.data) {
        try {
          const aw = Math.round(W * 0.42);
          const a = await sharp(Buffer.from(art.data, "base64")).resize(aw, Math.round(H * 0.22), { fit: "inside" }).png().toBuffer();
          const am = await sharp(a).metadata();
          layers.push({ input: a, top: Math.round(H * 0.045), left: Math.round((W - (am.width || aw)) / 2) });
        } catch (_) {}
      }
      layers.push(...veh.parts);
      if (layers.length) base = await sharp(base).composite(layers).png().toBuffer();

      if (composeLogos) base = await composeLogos(base, brandId, W, H, 0.15, 0.022);

      const f = `${id}_fest_${key}.png`;
      const { buf } = compressImage ? await compressImage(base) : { buf: base };
      fs.writeFileSync(path.join(OUT_DIR, f), buf);
      out[key] = `/generated/${f}`;
      if (key === "square" || key === "story") b64[key] = "data:image/png;base64," + buf.toString("base64");
    }

    out._b64 = b64;
    out._meta = { theme, vehicles: 0, hasArt: !!art };
    return out;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  ROUTES
  // ══════════════════════════════════════════════════════════════════════════

  app.get("/api/festive/themes", async (req, res) => {
    try {
      const arts = await FestiveArt.find({ active: true }).select("festival name sizeKB").lean();
      const have = new Set(arts.map((a) => a.festival));
      const withPhoto = await Vehicle.countDocuments({
        brand: req.query.brand || "vp_honda", active: true, photoData: { $nin: [null, ""] },
      });
      res.json({
        themes: Object.entries(THEMES).map(([id, t]) => ({
          id, label: t.label, hasArt: have.has(id),
          note: have.has(id) ? "तस्वीर लगी है" : "तस्वीर नहीं — poster बिना देवता के बनेगा",
        })),
        vehiclesWithPhoto: withPhoto,
        hint: withPhoto ? "" : "किसी गाड़ी की photo नहीं लगी — poster में गाड़ियाँ नहीं आएँगी",
      });
    } catch (e) { bad(res, e); }
  });

  /** त्यौहार की तस्वीर चढ़ाओ — एक बार, हर साल काम आएगी */
  app.post("/api/festive/art/:festival", requireRole("super-admin", "admin"),
    artUpload.single("art"), async (req, res) => {
      try {
        if (!THEMES[req.params.festival]) return bad(res, new Error("यह त्यौहार सूची में नहीं"), 400);
        if (!req.file) return bad(res, new Error("तस्वीर नहीं मिली"), 400);

        // बिना background वाली PNG सबसे अच्छी लगती है — इसलिए png ही रखते हैं
        const buf = await sharp(req.file.buffer)
          .resize(700, 700, { fit: "inside", withoutEnlargement: true })
          .png({ quality: 88, compressionLevel: 9 }).toBuffer();
        const kb = Math.round(buf.length / 1024);
        if (buf.length > 2.5 * 1024 * 1024) return bad(res, new Error(`तस्वीर भारी है (${kb}KB) — छोटी कीजिए`), 400);

        await FestiveArt.deleteMany({ festival: req.params.festival });
        const doc = await FestiveArt.create({
          festival: req.params.festival,
          name: req.body.name || THEMES[req.params.festival].label,
          data: buf.toString("base64"), sizeKB: kb, addedBy: req.user?.email,
        });
        L("त्यौहार की तस्वीर लगी", { festival: req.params.festival, kb });
        res.json({ ok: true, festival: doc.festival, sizeKB: kb, url: `${PUBLIC_URL}/festive-art/${doc.festival}` });
      } catch (e) { bad(res, e); }
    });

  app.get("/festive-art/:festival", async (req, res) => {
    try {
      const a = await FestiveArt.findOne({ festival: req.params.festival, active: true }).select("data").lean();
      if (!a?.data) return res.status(404).send("नहीं मिली");
      const buf = Buffer.from(a.data, "base64");
      res.set({ "Content-Type": "image/png", "Content-Length": buf.length, "Cache-Control": "public, max-age=86400", "Access-Control-Allow-Origin": "*" });
      res.end(buf);
    } catch (e) { res.status(500).send("error"); }
  });

  app.delete("/api/festive/art/:festival", requireRole("super-admin", "admin"), async (req, res) => {
    try { await FestiveArt.deleteMany({ festival: req.params.festival }); res.json({ ok: true }); }
    catch (e) { bad(res, e); }
  });

  /** नमूना बनाकर देखो */
  app.post("/api/festive/preview", requireRole("super-admin", "admin", "manager"), async (req, res) => {
    try {
      const b = req.body || {};
      if (!BRANDS[b.brand]) return bad(res, new Error("brand चाहिए"), 400);
      const id = "prev" + Date.now();
      const imgs = await buildFestivePoster(id, { ...b, sizes: { story: [1080, 1920] } });
      res.json({ ok: true, url: imgs.story, fullUrl: PUBLIC_URL + imgs.story, meta: imgs._meta });
    } catch (e) { bad(res, e); }
  });

  L("त्यौहार वाले poster चालू");
  return { buildFestivePoster, THEMES, themeFor, FestiveArt };
};
