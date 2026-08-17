// ============================================================================
//  poster-layout.js — poster पर stickers/सजावट की जगह तय करने वाला
//  ---------------------------------------------------------------------------
//  ⚠️ गड़बड़ी क्या थी:
//
//  poster पर तीन अलग परतें बनती थीं, और तीनों को एक-दूसरे की ख़बर नहीं थी —
//
//     परत 1  offerSeal()       — आपके चुने हुए offer stickers
//                                जगह: [[.84,.28],[.15,.30],[.15,.56],[.84,.56],[.5,.14]]
//     परत 2  decorSVG()        — आपकी चुनी हुई सजावट (तारा, दिल…)
//                                जगह: [[.06,.20],[.94,.20],[.06,.42],[.94,.42]]
//     परत 3  autoDecorLayer()  — "ऑटो-डिज़ाइन" (UI में by-default चालू!)
//                                जगह: AUTO_SLOTS
//
//  तीनों की जगहें कोड में पहले से लिखी हुई थीं। जाँच कोई नहीं करता था।
//  नतीजा (1080×1080 पर नापा हुआ):
//
//     चुना sticker#1  ✕  auto-sticker#1  →  75px एक-दूसरे में घुसे
//     चुना sticker#2  ✕  auto-sticker#2  →  95px एक-दूसरे में घुसे
//
//  95px यानी लगभग आधा sticker दूसरे के ऊपर। poster सस्ता दिखता था।
//
//  ✅ अब: एक ही जगह से सब बँटता है। हर badge रखने से पहले नापा जाता है कि
//     पहले से रखे किसी badge से टकरा तो नहीं रहा। जगह न बचे तो badge छोड़
//     दिया जाता है — ऊपर चढ़ाने से अच्छा है कि कम हों।
// ============================================================================

"use strict";

// ── सुरक्षित पट्टियाँ ───────────────────────────────────────────────────────
//  ऊपर: दोनों logo + गाड़ी का नाम    नीचे: फ़ीचर चिप + पता बार
//  बीच: गाड़ी की तस्वीर और क़ीमत
//  badge सिर्फ़ बाएँ-दाएँ किनारों की पट्टियों में बैठते हैं।
const RAIL_L = 0.135;
const RAIL_R = 0.865;

const R_STICKER = 0.082;   // w का गुणा
const R_DECOR   = 0.038;
const PAD       = 0.014;   // दो badge के बीच कम से कम इतनी हवा

const MAX_BADGES = 6;      // इससे ज़्यादा = poster भरा-भरा, सस्ता

/**
 * poster की शक्ल के हिसाब से खाली जगहें बनाओ।
 * square (1:1) पर 6, story (9:16) पर 8 — क्योंकि लम्बे poster में जगह ज़्यादा है।
 */
function buildSlots(w, h) {
  const tall = h / w > 1.25;
  const rows = tall
    ? [0.26, 0.38, 0.50, 0.62]
    : [0.29, 0.48, 0.67];
  const slots = [];
  // दाएँ पहले — नज़र पहले वहीं जाती है
  for (const y of rows) { slots.push([RAIL_R, y]); slots.push([RAIL_L, y]); }
  return slots;
}

/**
 * क्या यह जगह ख़ाली है? पहले रखे हर badge से दूरी नापो।
 */
function fits(x, y, r, placed, w, h, pad) {
  for (const p of placed) {
    const dx = (x - p.x) * w, dy = (y - p.y) * h;
    if (Math.hypot(dx, dy) < r + p.r + pad) return false;
  }
  return true;
}

/**
 * सारे badges को टकराव-मुक्त जगहों पर बाँटो।
 *
 * @returns {Array} [{ kind:"sticker"|"decor", style, name, x, y, r, l1, l2 }]
 *                  x,y भिन्न में (0–1); r pixel में
 */
function planBadges({
  w, h,
  stickerCsv = "",       // "1,3,7"
  offerCsv = "",         // "cashback,lowdp"
  decorCsv = "",         // "star,gift"
  amounts = {},          // { cashback, downPayment }
  autoDecor = false,
  autoTheme = null,      // { stickers:[], offers:[], decor:[] }
  offerLabel,            // (offerKey, amounts) => { l1, l2 }
}) {
  const slots = buildSlots(w, h);
  const rS = w * R_STICKER, rD = w * R_DECOR, pad = w * PAD;
  const placed = [];
  const out = [];

  const put = (item, r) => {
    if (out.length >= MAX_BADGES) return false;
    for (const [sx, sy] of slots) {
      if (fits(sx, sy, r, placed, w, h, pad)) {
        placed.push({ x: sx, y: sy, r });
        out.push({ ...item, x: sx, y: sy, r });
        return true;
      }
    }
    return false;   // जगह नहीं बची — चुपचाप छोड़ दो, ऊपर मत चढ़ाओ
  };

  const list = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);

  const styles = list(stickerCsv);
  const offers = list(offerCsv);
  const decors = list(decorCsv);

  // ── 1. आपके चुने हुए offer stickers — सबसे ज़रूरी, पहले जगह इन्हें ──
  if (styles.length) {
    const n = Math.max(offers.length, 1);
    for (let i = 0; i < Math.min(n, 4); i++) {
      const key = offers[i] || "";
      const { l1, l2 } = offerLabel(key, amounts);
      put({ kind: "sticker", style: styles[i % styles.length], l1, l2 }, rS);
    }
  }

  // ── 2. आपकी चुनी हुई सजावट ────────────────────────────────────────
  for (const name of decors.slice(0, 4)) {
    put({ kind: "decor", name }, rD);
  }

  // ── 3. ऑटो-डिज़ाइन — सिर्फ़ बची हुई जगह में ─────────────────────────
  //  ⚠️ यही सबसे बड़ी गड़बड़ी थी। पहले यह परत ऊपर से चिपक जाती थी, चाहे
  //     आपने अपने stickers चुने हों या नहीं।
  //     अब नियम साफ़ है: आपने ख़ुद sticker चुना है, तो auto-sticker नहीं आएगा।
  //     सजावट तभी जुड़ेगी जब poster सचमुच ख़ाली दिख रहा हो।
  if (autoDecor && autoTheme) {
    if (!styles.length) {
      for (const [i, style] of (autoTheme.stickers || []).slice(0, 2).entries()) {
        const key = (autoTheme.offers || [])[i] || "";
        const { l1, l2 } = offerLabel(key, amounts);
        put({ kind: "sticker", style, l1, l2 }, rS);
      }
    }
    if (out.length < 4) {
      for (const name of (autoTheme.decor || []).slice(0, 2)) put({ kind: "decor", name }, rD);
    }
  }

  return out;
}

/**
 * योजना → SVG. render करने वाले server.js से आते हैं (वहीं की shapes इस्तेमाल हों)।
 */
function badgeLayerSVG(plan, w, h, renderSticker, renderDecor) {
  return plan.map((b) =>
    b.kind === "sticker"
      ? renderSticker(b.style, w * b.x, h * b.y, b.r, b.l1, b.l2)
      : renderDecor(b.name, w * b.x, h * b.y, b.r)
  ).join("");
}

/**
 * जाँच — कोई दो badge टकरा तो नहीं रहे?
 * server शुरू होते ही एक बार चला लें; ग़लती हो तो log में तुरन्त दिखेगी।
 */
function verifyNoOverlap(plan, w, h) {
  const bad = [];
  for (let i = 0; i < plan.length; i++) {
    for (let j = i + 1; j < plan.length; j++) {
      const a = plan[i], b = plan[j];
      const dist = Math.hypot((a.x - b.x) * w, (a.y - b.y) * h);
      if (dist < a.r + b.r) bad.push({ i, j, dist: Math.round(dist), need: Math.round(a.r + b.r) });
    }
  }
  return bad;
}

module.exports = {
  planBadges, badgeLayerSVG, verifyNoOverlap,
  RAIL_L, RAIL_R, R_STICKER, R_DECOR, MAX_BADGES,
};
