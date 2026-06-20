/**
 * ============================================================================
 *  AutoSuVichar — पूरा Backend (FINAL)
 *  Features: content + image + short-video + delivery-video generation,
 *  approval-first posting (FB/IG/YouTube/WhatsApp), daily + festival auto-mode,
 *  Login + multi-staff (roles), Settings/OAuth token connect, Lead capture + CRM,
 *  Analytics, WhatsApp auto chat-bot, in-app notifications, logging, test mode.
 *
 *  चलाएँ:  npm install   फिर   node server.js   (Node 18+)
 *  TEST_MODE=true (default) पर बिना किसी key के पूरा system चलता है।
 *  Server पर चाहिए:  ffmpeg + fonts-noto-devanagari (deploy guide देखें)।
 * ============================================================================
 */
require("dotenv").config();
const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
const sharp = require("sharp");
const cron = require("node-cron");
const multer = require("multer");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");
const dns = require("dns");
dns.setServers(["8.8.8.8", "1.1.1.1"]); // mobile/ISP DNS fix for MongoDB SRV

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 5000;
const TEST_MODE = process.env.TEST_MODE !== "false";
const ENABLE_VIDEO = process.env.ENABLE_VIDEO !== "false";
const ENABLE_CRON = process.env.ENABLE_CRON !== "false";
const CRON_SCHEDULE = process.env.CRON_SCHEDULE || "0 9 * * *";
const MONGO_URI = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/autosuvichar";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const PUBLIC_URL = process.env.PUBLIC_URL || `http://localhost:${PORT}`;
const JWT_SECRET = process.env.JWT_SECRET || "change-this-secret-in-production";
const WA_VERIFY_TOKEN = process.env.WA_VERIFY_TOKEN || "autosuvichar-verify";
const GRAPH = "https://graph.facebook.com/v21.0";

const OUT_DIR = path.join(__dirname, "public", "generated");
const MUSIC_DIR = path.join(__dirname, "music");
const UPLOAD_DIR = path.join(__dirname, "uploads");
const LOGO_DIR = path.join(__dirname, "public", "logos");
const VEHICLE_DIR = path.join(__dirname, "public", "vehicles");
const LOG_DIR = path.join(__dirname, "logs");
[OUT_DIR, MUSIC_DIR, UPLOAD_DIR, LOGO_DIR, VEHICLE_DIR, LOG_DIR].forEach((d) => fs.mkdirSync(d, { recursive: true }));

function log(level, msg, extra) {
  const line = `[${new Date().toISOString()}] ${level} ${msg}` + (extra ? ` ${JSON.stringify(extra)}` : "");
  console[level === "ERROR" ? "error" : "log"](line);
  try { fs.appendFileSync(path.join(LOG_DIR, "app.log"), line + "\n"); } catch (_) {}
}

// ---------------------------------------------------------------------------
// Brands
// ---------------------------------------------------------------------------
const BRANDS = {
  vp_honda: { name: "VP Honda", sub: "Honda मोटरसाइकिल / स्कूटर", accent: "#E4002B", accent2: "#7a0016",
    phone: "9713394738", place: "VP Honda, परवलिया सड़क, भोपाल", products: ["Honda Shine", "SP 125", "Activa 6G", "Dio", "Unicorn"],
    logo: "vp_honda.png", handles: { fb: "VPHondaBhopal", ig: "vp_honda", yt: "VP Honda" } },
  yakuza: { name: "Yakuza EV", sub: "MD Automobiles · इलेक्ट्रिक स्कूटी", accent: "#0EA36A", accent2: "#075c3c",
    phone: "9713394738", place: "MD Automobiles, भोपाल", products: ["Yakuza Pro", "Yakuza Lite", "Yakuza Max"],
    logo: "yakuza.png", handles: { fb: "YakuzaEV", ig: "yakuza_ev", yt: "Yakuza EV" } },
  minimetro: { name: "Mini Metro", sub: "MD Automobiles · ऑटो रिक्शा", accent: "#1565C0", accent2: "#0d3c70",
    phone: "9713394738", place: "MD Automobiles, भोपाल", products: ["Mini Metro Passenger", "Mini Metro Cargo"],
    logo: "minimetro.png", handles: { fb: "MiniMetroAuto", ig: "mini_metro_auto", yt: "Mini Metro" } },
};
const TYPES = ["suvichar", "vigyapan", "festival", "suchna", "gift"];
const TYPE_LABEL = { suvichar: "सुविचार", vigyapan: "विज्ञापन", festival: "त्यौहार शुभकामना", suchna: "आवश्यक सूचना", gift: "गिफ्ट प्रचार" };

// त्यौहार auto-mode — ⚠️ ये dates सैंपल हैं, हर साल verify/update करें (panchang अनुसार)
const FESTIVALS = [
  { date: "2026-01-01", name: "नववर्ष", greet: "नया साल नई खुशियाँ और नई शुरुआत लेकर आए!", color: "#1565c0", color2: "#0b3d91" },
  { date: "2026-01-14", name: "मकर संक्रांति", greet: "तिल-गुड़ की मिठास और पतंगों की उड़ान — पर्व मंगलमय हो!", color: "#f59f00", color2: "#b35900" },
  { date: "2026-01-23", name: "वसंत पंचमी", greet: "माँ सरस्वती का आशीर्वाद आप पर सदा बना रहे!", color: "#f2c200", color2: "#c79400" },
  { date: "2026-01-26", name: "गणतंत्र दिवस", greet: "जय हिन्द! गणतंत्र दिवस की हार्दिक शुभकामनाएं।", color: "#ff9933", color2: "#138808" },
  { date: "2026-02-15", name: "महाशिवरात्रि", greet: "भोलेनाथ की कृपा आप पर सदैव बनी रहे — हर हर महादेव!", color: "#3b5bdb", color2: "#1e3a8a" },
  { date: "2026-03-04", name: "होली", greet: "रंगों का यह त्यौहार आपके जीवन में खुशियाँ भर दे!", color: "#d6336c", color2: "#7048e8" },
  { date: "2026-03-20", name: "ईद-उल-फ़ितर", greet: "ईद मुबारक — खुशियाँ और बरकत आपके साथ रहें!", color: "#0ca678", color2: "#087f5b" },
  { date: "2026-03-26", name: "राम नवमी", greet: "प्रभु श्रीराम का आशीर्वाद आप पर बना रहे — जय श्रीराम!", color: "#e8590c", color2: "#a83208" },
  { date: "2026-04-13", name: "बैसाखी", greet: "नई फसल, नई उमंग — बैसाखी की ढेरों शुभकामनाएं!", color: "#f59f00", color2: "#2b8a3e" },
  { date: "2026-04-20", name: "अक्षय तृतीया", greet: "इस शुभ दिन आपके घर सुख-समृद्धि का वास हो!", color: "#e0a800", color2: "#9c6b00" },
  { date: "2026-08-15", name: "स्वतंत्रता दिवस", greet: "जय हिन्द! स्वतंत्रता दिवस की हार्दिक शुभकामनाएं।", color: "#ff9933", color2: "#138808" },
  { date: "2026-08-28", name: "रक्षाबंधन", greet: "भाई-बहन के अटूट प्यार का पर्व मंगलमय हो!", color: "#e64980", color2: "#a61e4d" },
  { date: "2026-09-04", name: "जन्माष्टमी", greet: "नंदलाल की कृपा आप पर बनी रहे — जय श्रीकृष्ण!", color: "#3b5bdb", color2: "#1e3a8a" },
  { date: "2026-09-14", name: "गणेश चतुर्थी", greet: "गणपति बप्पा मोरया! बप्पा आपके सब विघ्न हरें।", color: "#e8590c", color2: "#a83208" },
  { date: "2026-10-11", name: "नवरात्रि", greet: "माँ दुर्गा का आशीर्वाद आप पर सदा बना रहे!", color: "#c2255c", color2: "#862e9c" },
  { date: "2026-10-20", name: "दशहरा", greet: "असत्य पर सत्य की जीत — विजयादशमी की शुभकामनाएं!", color: "#e8590c", color2: "#9c3608" },
  { date: "2026-11-06", name: "धनतेरस", greet: "धनतेरस पर सुख, समृद्धि और सेहत आपके साथ!", color: "#e0a800", color2: "#9c6b00" },
  { date: "2026-11-08", name: "दिवाली", greet: "रोशनी का यह पर्व आपके जीवन में खुशियाँ लाए — शुभ दीपावली!", color: "#e0a800", color2: "#c1121f" },
  { date: "2026-11-10", name: "भाई दूज", greet: "भाई-बहन के प्यार का पर्व शुभ हो!", color: "#e64980", color2: "#a61e4d" },
  { date: "2026-11-24", name: "गुरु नानक जयंती", greet: "गुरु नानक देव जी की कृपा आप पर बनी रहे!", color: "#f59f00", color2: "#b35900" },
  { date: "2026-12-25", name: "क्रिसमस", greet: "मेरी क्रिसमस — खुशियाँ और प्यार आपके साथ रहें!", color: "#c1121f", color2: "#2b8a3e" },
];
const FEST_BY_NAME = (n) => FESTIVALS.find((f) => f.name === n);

// ---------------------------------------------------------------------------
// Models (OverwriteModelError guard)
// ---------------------------------------------------------------------------
const model = (name, schema) => mongoose.models[name] || mongoose.model(name, schema);

const Content = model("Content", new mongoose.Schema({
  brand: { type: String, required: true }, type: { type: String, required: true }, text: { type: String, required: true },
  status: { type: String, enum: ["pending", "rejected", "sent", "failed"], default: "pending" },
  post_type: { type: String, enum: ["photo", "video"], default: "photo" },
  platforms: { fb: { type: Boolean, default: true }, ig: { type: Boolean, default: true }, yt: { type: Boolean, default: true }, wa: { type: Boolean, default: true } },
  images: { square: String, story: String, landscape: String }, video: String, music_used: String,
  imageData: { square: String, story: String }, // base64 — Render restart पर भी रहे (disk मिट जाता है)
  promo: { model: String, price: String, downPayment: String, cashback: String, features: [String], bg: String, cutout: Boolean, aiPrompt: String, offer: String, sticker: String, decor: String, photo: String },
  channels: [String], results: mongoose.Schema.Types.Mixed, sentAt: Date, error: String,
}, { timestamps: true }));

const Delivery = model("Delivery", new mongoose.Schema({
  brand: { type: String, required: true }, customerName: String, bikeName: String, offer: String, photo: String, text: String,
  images: { square: String, landscape: String }, video: String, music_used: String, post_type: { type: String, default: "video" },
  imageData: { square: String, story: String }, // base64 — restart-safe
  platforms: { fb: { type: Boolean, default: true }, ig: { type: Boolean, default: true }, yt: { type: Boolean, default: true }, wa: { type: Boolean, default: true } },
  status: { type: String, enum: ["pending", "rejected", "sent", "failed"], default: "pending" },
  channels: [String], results: mongoose.Schema.Types.Mixed, engagement_stats: mongoose.Schema.Types.Mixed, sentAt: Date,
}, { timestamps: true }));

const User = model("User", new mongoose.Schema({
  name: String, email: { type: String, unique: true, required: true }, passwordHash: String,
  role: { type: String, enum: ["super-admin", "admin", "manager", "salesman"], default: "salesman" }, brand: String,
}, { timestamps: true }));

const Setting = model("Setting", new mongoose.Schema({
  brand: { type: String, unique: true }, creds: mongoose.Schema.Types.Mixed,
}, { timestamps: true }));

const Lead = model("Lead", new mongoose.Schema({
  brand: String, name: String, mobile: String, vehicleInterest: String, source: { type: String, default: "post" },
  status: { type: String, enum: ["new", "contacted", "won", "lost"], default: "new" }, note: String,
}, { timestamps: true }));

const Notification = model("Notification", new mongoose.Schema({
  type: String, message: String, brand: String, read: { type: Boolean, default: false },
}, { timestamps: true }));

async function notify(type, message, brand) {
  try { await Notification.create({ type, message, brand }); log("INFO", "notify", { type, brand }); } catch (e) {}
}

// per-brand credentials: DB settings पहले, फिर .env
let SETTINGS_CACHE = {};
async function loadSettings() {
  SETTINGS_CACHE = {};
  (await Setting.find()).forEach((s) => (SETTINGS_CACHE[s.brand] = s.creds || {}));
}
function brandCreds(id) {
  const P = id.toUpperCase();
  const db = SETTINGS_CACHE[id] || {};
  const recRaw = db.waRecipients != null ? db.waRecipients : process.env[`${P}_WA_RECIPIENTS`] || "";
  const recipients = Array.isArray(recRaw) ? recRaw : String(recRaw).split(",").map((s) => s.trim()).filter(Boolean);
  return {
    fbPageId: db.fbPageId || process.env[`${P}_FB_PAGE_ID`] || "",
    fbToken: db.fbToken || process.env[`${P}_FB_TOKEN`] || "",
    igUserId: db.igUserId || process.env[`${P}_IG_USER_ID`] || "",
    ytRefreshToken: db.ytRefreshToken || process.env[`${P}_YT_REFRESH_TOKEN`] || "",
    waPhoneId: db.waPhoneId || process.env[`${P}_WA_PHONE_ID`] || "",
    waRecipients: recipients,
  };
}


// ===========================================================================
// CONTENT + IMAGE GENERATION
// ===========================================================================
function templateContent(brandId, type, festivalName) {
  const b = BRANDS[brandId];
  const prod = b.products[Math.floor(Math.random() * b.products.length)];
  const bank = {
    suvichar: [
      "🌅 शुभ प्रभात!\nइंसान के हाथ में सिर्फ़ कोशिश है,\nकामयाबी ईश्वर देता है। 🙏\nआपका दिन शुभ एवं मंगलमय हो।",
      "🪷 जय जय श्री राम 🪷\nसुबह की पहली किरण आपके जीवन में\nनई उमंग और ऊर्जा लेकर आए।\nशुभ प्रभात — दिन मंगलमय हो। 🌻",
      "🌸 सुप्रभात 🌸\nजो बीत गया उसे भूल जाइए,\nजो आने वाला है उसका स्वागत कीजिए।\nआज का दिन आपके लिए शुभ हो। ✨",
      "✨ अच्छे विचार ही अच्छे जीवन की शुरुआत हैं।\nआज मुस्कुराइए, क्योंकि यह दिन\nदोबारा नहीं आएगा। 🌞\nशुभ दिन!",
      "💫 संकल्प से ही मंज़िल मिलती है —\nहर सुबह एक नई शुरुआत है,\nबस पहला कदम बढ़ाइए। 🚀",
      "🌻 जय जय हनुमान 🌻\nमेहनत का रास्ता लंबा है,\nपर मंज़िल उतनी ही सुंदर होती है।\nशुभ प्रभात! 🙏",
      "🌷 हर सुबह एक नई दिशा देती है,\nहर पल एक नई शुरुआत लेकर आता है।\nआगे बढ़ते रहिए — शुभ दिन! 💪",
      "☀️ शुभ प्रभात!\nसफलता उन्हें मिलती है\nजो हर दिन कोशिश करते हैं।\nआज का दिन आपका है! 🌟",
      "🌺 सुप्रभात!\nजीवन में खुशियाँ तब मिलती हैं\nजब हम दूसरों के काम आते हैं।\nआज कोई अच्छा काम ज़रूर करें। 🙏",
      "💫 हरिओम 💫\nजो अपने मन को जीत लेता है,\nवही दुनिया जीत लेता है।\nशुभ प्रभात — दिन मंगलमय हो! 🪷",
      "🌅 आज का दिन विशेष है —\nकिसी को मुस्कुराने का कारण दीजिए,\nखुद भी मुस्कुराइए।\nशुभ प्रभात! 😊",
      "🔥 सपने वो नहीं जो नींद में देखे जाएँ,\nसपने वो हैं जो नींद आने न दें।\nउठिए, जागिए, आगे बढ़िए! 💫",
      "🌸 छोटी-छोटी खुशियों में जीवन का\nसबसे बड़ा सुख छुपा होता है।\nआज के हर पल को जिएँ। शुभ दिन! 🌟",
      "🌻 कोशिश करने वालों की कभी हार नहीं होती,\nलहरों से डरकर नौका पार नहीं होती।\nशुभ प्रभात! 🙏",
      "⭐ अपने काम से प्यार करें,\nतो काम कभी बोझ नहीं लगेगा।\nआज पूरे जोश के साथ काम करें! 💪",
      "🌷 ईश्वर पर भरोसा रखें,\nमेहनत करते रहें,\nसफलता ज़रूर मिलेगी।\nशुभ प्रभात! 🪷",
      "💫 जय श्री कृष्ण 💫\nहर सुबह एक नई संभावना लेकर आती है।\nआज को अपना सबसे अच्छा दिन बनाएँ! 🌅",
      "🌺 जहाँ चाह, वहाँ राह।\nसंकल्प करें, आगे बढ़ें,\nमंज़िल पास है। शुभ दिन! ✨",
      "☀️ हर नई सुबह एक तोहफ़ा है,\nइसे ख़ुशी और कृतज्ञता के साथ स्वीकार करें।\nशुभ प्रभात — दिन मंगलमय हो! 🙏",
      "🌟 अपनी मुस्कान बनाए रखें,\nयही आपकी सबसे बड़ी ताक़त है।\nआज का दिन शानदार हो! 💫",
    ],
    vigyapan: [`${prod} अब ${b.place} पर उपलब्ध!\nआसान EMI, शानदार माइलेज। 📞 ${b.phone}`, `${prod} की सवारी, हर सफर शानदार।\nबेहतरीन कीमत पर — ${b.place}।`],
    festival: [(() => { const fe = FEST_BY_NAME(festivalName); const tag = fe ? fe.greet : "आपका हर सफर सुरक्षित और खुशहाल हो।"; return `${festivalName || "त्यौहार"} की हार्दिक शुभकामनाएं!\n${tag}\n— ${b.name} परिवार`; })()],
    suchna: [`आवश्यक सूचना: इस रविवार ${b.place} खुला रहेगा।\nफ्री सर्विस कैंप — सुबह 10 से शाम 6। 📞 ${b.phone}`],
    gift: [`🎁 ${prod} पर फ्री हेलमेट + ₹5000 तक डिस्काउंट!\nसीमित समय का ऑफर — 📞 ${b.phone}`],
  };
  const arr = bank[type] || bank.suvichar;
  return arr[Math.floor(Math.random() * arr.length)];
}
async function generateText(brandId, type, festivalName) {
  // सुविचार के लिए AI ज़रूरी नहीं — हमारे 20 rich templates काफी हैं, और हर बार अलग
  if (type === "suvichar") return templateContent(brandId, "suvichar", festivalName);
  const b = BRANDS[brandId];
  const extra = festivalName ? ` त्यौहार: ${festivalName}.` : "";
  const prompt = `तुम भारतीय ऑटोमोबाइल डीलर "${b.name}" (${b.sub}) के लिए सोशल मीडिया लिखते हो।\n` +
    `उत्पाद: ${b.products.join(", ")}. फ़ोन: ${b.phone}. जगह: ${b.place}.${extra}\n` +
    `छोटा हिंदी पोस्ट बनाओ: "${TYPE_LABEL[type]}". नियम: 2-4 लाइन, आकर्षक, हर बार बिल्कुल नया अंदाज़ (पुराने जैसा नहीं), सही जगह 1-2 emoji, hashtag नहीं, भूमिका नहीं — सिर्फ़ text।`;
  // 1) Gemini text — आपकी मौजूदा GEMINI_API_KEY से FREE चलता है
  const gkey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (gkey) {
    for (const m of ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-2.5-flash-lite"]) {
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${gkey}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { temperature: 1.0, maxOutputTokens: 220 } }),
          signal: AbortSignal.timeout(25000),
        });
        if (!res.ok) continue;
        const j = await res.json();
        const t = j?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("").trim();
        if (t) return cleanAIText(t);
      } catch (e) { /* अगला model */ }
    }
  }
  // 2) OpenAI (अगर key हो)
  if (!TEST_MODE && OPENAI_API_KEY) {
  try {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
      body: JSON.stringify({ model: OPENAI_MODEL, messages: [{ role: "user", content: prompt }], max_tokens: 200, temperature: 0.9 }),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}`);
    const t = (await res.json())?.choices?.[0]?.message?.content?.trim();
    if (!t) throw new Error("empty");
    return cleanAIText(t);
  } catch (e) { log("ERROR", "OpenAI → template", { msg: e.message }); }
  }
  // 3) templates (fallback)
  return templateContent(brandId, type, festivalName);
}
// AI text को clean करो — markdown, prefix labels, extra whitespace हटाओ
function cleanAIText(t) {
  if (!t) return t;
  return t
    .replace(/\*\*(.*?)\*\*/g, "$1")        // **bold** → plain
    .replace(/\*(.*?)\*/g, "$1")            // *italic* → plain
    .replace(/^पोस्ट\s*\d+\s*[:：]\s*/gmi, "") // "पोस्ट 1:" prefix हटाओ
    .replace(/^(post|caption|text|output)\s*[:：]\s*/gmi, "") // English prefix
    .replace(/^\s*[-–—•]\s*/gm, "")         // bullet points
    .replace(/\n{3,}/g, "\n\n")             // triple newlines → double
    .trim();
}
function esc(s) { return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
// आकर्षक address बटन — हर poster के नीचे (gold border pill + pin icon)
function addrBar(b, w, h) {
  const GOLD = "#ffd400", DARK = "#141414", ACCENT = "#E4002B";
  const uid = "ab" + Math.floor(Math.random() * 1e6);
  const barH = Math.round(h * 0.155), y = h - barH, pad = Math.round(barH * 0.14);
  const bx = Math.round(w * 0.03), bw = w - bx * 2;
  const btnY = y + pad, btnH = barH - pad * 2 - 8, splitX = bx + Math.round(bw * 0.6), rx = btnH / 2, lift = 8;
  const cx = bx + rx + 6, cy = btnY + btnH / 2 - 4, pr = btnH * 0.2;
  const pin = `<path d="M ${cx} ${cy + pr} C ${cx - pr} ${cy - pr * 0.2}, ${cx - pr} ${cy - pr * 1.1}, ${cx} ${cy - pr * 1.1} C ${cx + pr} ${cy - pr * 1.1}, ${cx + pr} ${cy - pr * 0.2}, ${cx} ${cy + pr} Z" fill="${GOLD}"/><circle cx="${cx}" cy="${cy - pr * 0.45}" r="${pr * 0.35}" fill="#fff"/>`;
  return `<rect x="0" y="${y}" width="${w}" height="${barH}" fill="${DARK}"/>`
    + `<defs><linearGradient id="${uid}l" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#ff2a44"/><stop offset="100%" stop-color="${ACCENT}"/></linearGradient><linearGradient id="${uid}r" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#2b2b2b"/><stop offset="100%" stop-color="${DARK}"/></linearGradient></defs>`
    + `<rect x="${bx}" y="${btnY + lift}" width="${bw}" height="${btnH}" rx="${rx}" fill="#000" opacity="0.55"/>`
    + `<path d="M ${bx + rx} ${btnY} H ${splitX} V ${btnY + btnH} H ${bx + rx} A ${rx} ${rx} 0 0 1 ${bx + rx} ${btnY} Z" fill="url(#${uid}l)"/>`
    + `<path d="M ${splitX} ${btnY} H ${bx + bw - rx} A ${rx} ${rx} 0 0 1 ${bx + bw - rx} ${btnY + btnH} H ${splitX} Z" fill="url(#${uid}r)"/>`
    + `<rect x="${bx}" y="${btnY}" width="${bw}" height="${btnH}" rx="${rx}" fill="none" stroke="${GOLD}" stroke-width="3"/>`
    + `<rect x="${bx + 10}" y="${btnY + 4}" width="${bw - 20}" height="${btnH * 0.3}" rx="${rx * 0.6}" fill="#fff" opacity="0.12"/>`
    + `<line x1="${splitX}" y1="${btnY + 8}" x2="${splitX}" y2="${btnY + btnH - 8}" stroke="${GOLD}" stroke-width="2" opacity="0.7"/>`
    + pin
    + `<text x="${bx + rx + 34}" y="${btnY + btnH * 0.45}" font-family="Noto Sans Devanagari,Mukta,sans-serif" font-size="${Math.round(w / 30)}" font-weight="800" fill="#fff">${esc(b.name)}</text>`
    + `<text x="${bx + rx + 34}" y="${btnY + btnH * 0.8}" font-family="Noto Sans Devanagari,Mukta,sans-serif" font-size="${Math.round(w / 46)}" fill="#ffe9ec">${esc(b.place)}</text>`
    + `<text x="${splitX + (bx + bw - splitX) / 2}" y="${btnY + btnH * 0.44}" text-anchor="middle" font-family="Mukta,sans-serif" font-size="${Math.round(w / 40)}" fill="${GOLD}">फ़ोन</text>`
    + `<text x="${splitX + (bx + bw - splitX) / 2}" y="${btnY + btnH * 0.78}" text-anchor="middle" font-family="Mukta,sans-serif" font-size="${Math.round(w / 26)}" font-weight="800" fill="#fff">${esc(b.phone)}</text>`;
}
// हर item अलग रंग के 3D चिप-बटन पर (एक row, auto-scale)
function chipRow(labels, cy, ch, maxW, W) {
  if (!labels || !labels.length) return "";
  const pal = ["#E4002B", "#1565c0", "#0ca678", "#e8590c", "#7048e8", "#d6336c", "#0a9396", "#f59f00"];
  const fs = Math.round(ch * 0.5); let x = 0; const chips = [];
  labels.forEach((l, i) => { const cw = String(l).length * fs * 0.62 + ch * 1.0; chips.push({ l, x, cw, col: pal[i % pal.length] }); x += cw + ch * 0.3; });
  const total = x - ch * 0.3, k = Math.min(1, maxW / total), startX = (W - total * k) / 2;
  let g = `<g transform="translate(${startX},${cy}) scale(${k})">`;
  for (const c of chips) { const rx = ch / 2; g += `<rect x="${c.x}" y="4" width="${c.cw}" height="${ch}" rx="${rx}" fill="#000" opacity="0.3"/><rect x="${c.x}" y="0" width="${c.cw}" height="${ch}" rx="${rx}" fill="${c.col}"/><rect x="${c.x + 5}" y="3" width="${c.cw - 10}" height="${ch * 0.32}" rx="${rx * 0.5}" fill="#fff" opacity="0.18"/><text x="${c.x + c.cw / 2}" y="${ch * 0.68}" text-anchor="middle" font-family="Noto Sans Devanagari,Mukta,sans-serif" font-size="${fs}" font-weight="700" fill="#fff">${esc(c.l)}</text>`; }
  return g + `</g>`;
}
// बिना-AI तैयार backgrounds (सीधे SVG)
const READY_BG = {
  showroom: (W, H) => `<defs><linearGradient id="rb" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#3a3f47"/><stop offset="100%" stop-color="#14171a"/></linearGradient><radialGradient id="rs" cx="50%" cy="40%" r="62%"><stop offset="0%" stop-color="#ffffff" stop-opacity="0.18"/><stop offset="100%" stop-color="#ffffff" stop-opacity="0"/></radialGradient></defs><rect width="${W}" height="${H}" fill="url(#rb)"/><rect width="${W}" height="${H}" fill="url(#rs)"/>`,
  studio: (W, H) => `<defs><radialGradient id="rb" cx="50%" cy="38%" r="72%"><stop offset="0%" stop-color="#6b7280"/><stop offset="100%" stop-color="#23272e"/></radialGradient></defs><rect width="${W}" height="${H}" fill="url(#rb)"/>`,
  diwali: (W, H) => { let d = `<defs><radialGradient id="rb" cx="50%" cy="40%" r="75%"><stop offset="0%" stop-color="#c2641a"/><stop offset="100%" stop-color="#4a1505"/></radialGradient></defs><rect width="${W}" height="${H}" fill="url(#rb)"/>`; for (let i = 0; i < 22; i++) { d += `<circle cx="${i * 137 % W}" cy="${i * 91 % (H * 0.8)}" r="${4 + (i % 5) * 3}" fill="#ffd86b" opacity="${0.18 + (i % 4) * 0.07}"/>`; } return d; },
  holi: (W, H) => { const c = ["#ff2d78", "#ffd400", "#16a34a", "#1565c0", "#9b51e0"]; let d = `<defs><linearGradient id="rb" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#2a1a3a"/><stop offset="100%" stop-color="#3a1530"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#rb)"/>`; for (let i = 0; i < 14; i++) { d += `<circle cx="${i * 173 % W}" cy="${i * 121 % H}" r="${50 + (i % 4) * 40}" fill="${c[i % 5]}" opacity="0.16"/>`; } return d; },
  navratri: (W, H) => { let d = `<defs><radialGradient id="rb" cx="50%" cy="38%" r="75%"><stop offset="0%" stop-color="#9a1840"/><stop offset="100%" stop-color="#3a0818"/></radialGradient></defs><rect width="${W}" height="${H}" fill="url(#rb)"/>`; for (let i = 0; i < 18; i++) { d += `<circle cx="${i * 151 % W}" cy="${i * 97 % (H * 0.85)}" r="${8 + i % 4 * 3}" fill="${i % 2 ? "#ff8a00" : "#ffd24a"}" opacity="0.3"/>`; } return d; },
  city: (W, H) => `<defs><linearGradient id="rb" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#34506b"/><stop offset="100%" stop-color="#161e28"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#rb)"/><rect x="0" y="${H * 0.7}" width="${W}" height="${H * 0.3}" fill="#0d141c" opacity="0.6"/>`,
  sport: (W, H) => { let d = `<defs><linearGradient id="rb" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#E4002B"/><stop offset="100%" stop-color="#2a0006"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#rb)"/>`; for (let i = 0; i < 6; i++) { d += `<line x1="${i * (W / 5)}" y1="0" x2="${i * (W / 5) + W * 0.3}" y2="${H}" stroke="#fff" stroke-width="3" opacity="0.07"/>`; } return d; },
  blue: (W, H) => `<defs><linearGradient id="rb" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#1565c0"/><stop offset="100%" stop-color="#0a2a5a"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#rb)"/>`,
  showroom_pro: (W, H) => { let d = `<defs><linearGradient id="rb" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#2c313a"/><stop offset="62%" stop-color="#1a1d23"/><stop offset="100%" stop-color="#0d0f12"/></linearGradient><radialGradient id="spot" cx="50%" cy="34%" r="55%"><stop offset="0%" stop-color="#ffffff" stop-opacity="0.22"/><stop offset="100%" stop-color="#ffffff" stop-opacity="0"/></radialGradient></defs><rect width="${W}" height="${H}" fill="url(#rb)"/>`; for (let i = 0; i < 4; i++) { const x = W * (0.18 + i * 0.21); d += `<rect x="${x}" y="0" width="${W * 0.1}" height="${H * 0.04}" rx="6" fill="#fff" opacity="0.12"/>`; } d += `<rect width="${W}" height="${H}" fill="url(#spot)"/><rect x="0" y="${H * 0.72}" width="${W}" height="${H * 0.28}" fill="#000" opacity="0.35"/><ellipse cx="${W / 2}" cy="${H * 0.74}" rx="${W * 0.5}" ry="${H * 0.06}" fill="#fff" opacity="0.10"/>`; return d; },
  studio_grad: (W, H) => `<defs><radialGradient id="rb" cx="50%" cy="40%" r="78%"><stop offset="0%" stop-color="#8a9099"/><stop offset="55%" stop-color="#4a4f57"/><stop offset="100%" stop-color="#1c1f24"/></radialGradient></defs><rect width="${W}" height="${H}" fill="url(#rb)"/><ellipse cx="${W / 2}" cy="${H * 0.78}" rx="${W * 0.46}" ry="${H * 0.07}" fill="#000" opacity="0.22"/>`,
  diwali_pro: (W, H) => { let d = `<defs><radialGradient id="rb" cx="50%" cy="42%" r="80%"><stop offset="0%" stop-color="#d2761f"/><stop offset="60%" stop-color="#7a2a08"/><stop offset="100%" stop-color="#3a1203"/></radialGradient></defs><rect width="${W}" height="${H}" fill="url(#rb)"/>`; for (let i = 0; i < 26; i++) { d += `<circle cx="${i * 137 % W}" cy="${i * 91 % (H * 0.85)}" r="${4 + (i % 5) * 4}" fill="#ffd86b" opacity="${0.16 + (i % 4) * 0.06}"/>`; } for (let i = 0; i <= 12; i++) { const x = W * (i / 12); const y = H * 0.05 + Math.sin(i) * H * 0.012; d += `<circle cx="${x}" cy="${y}" r="${W * 0.012}" fill="${i % 2 ? "#ff8a00" : "#ffb703"}"/>`; } for (let i = 0; i < 5; i++) { const x = W * (0.12 + i * 0.19), y = H * 0.9; d += `<ellipse cx="${x}" cy="${y}" rx="${W * 0.035}" ry="${W * 0.014}" fill="#7a3b12"/><path d="M ${x} ${y - W * 0.04} C ${x + W * 0.012} ${y - W * 0.02}, ${x + W * 0.006} ${y - W * 0.008}, ${x} ${y - W * 0.008} C ${x - W * 0.006} ${y - W * 0.008}, ${x - W * 0.012} ${y - W * 0.02}, ${x} ${y - W * 0.04} Z" fill="#ffcb2b"/>`; } return d; },
  templearch_bg: (W, H) => { const ax = W * 0.5, top = H * 0.06, aw = W * 0.74, ah = H * 0.66; let d = `<defs><linearGradient id="rb" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#f3e0b5"/><stop offset="100%" stop-color="#d8b87a"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#rb)"/>`; d += `<path d="M ${ax - aw / 2} ${top + ah} V ${top + ah * 0.3} Q ${ax - aw / 2} ${top} ${ax} ${top} Q ${ax + aw / 2} ${top} ${ax + aw / 2} ${top + ah * 0.3} V ${top + ah}" fill="none" stroke="#b8860b" stroke-width="8" opacity="0.9"/>`; d += `<path d="M ${ax - aw / 2 * 0.92} ${top + ah} V ${top + ah * 0.32} Q ${ax - aw / 2 * 0.92} ${top + ah * 0.05} ${ax} ${top + ah * 0.05} Q ${ax + aw / 2 * 0.92} ${top + ah * 0.05} ${ax + aw / 2 * 0.92} ${top + ah * 0.32} V ${top + ah}" fill="none" stroke="#fff" stroke-width="3" stroke-dasharray="3 10" opacity="0.6"/>`; for (let i = 0; i <= 16; i++) { const t = i / 16; const x = ax - aw / 2 + aw * t; const y = top + ah * 0.3 - Math.sin(Math.PI * t) * ah * 0.26; d += `<circle cx="${x}" cy="${y}" r="${W * 0.012}" fill="${i % 2 ? "#ff8a00" : "#e8590c"}"/>`; } return d; },
  speed_road: (W, H) => { let d = `<defs><linearGradient id="rb" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#1a2740"/><stop offset="60%" stop-color="#0d1626"/><stop offset="100%" stop-color="#05080f"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#rb)"/>`; for (let i = 0; i < 10; i++) { const y = H * (0.12 + i * 0.07); const len = W * (0.3 + (i % 3) * 0.2); d += `<rect x="0" y="${y}" width="${len}" height="${3 + i % 3}" fill="#4da6ff" opacity="${0.12 + (i % 4) * 0.04}"/>`; } d += `<polygon points="${W * 0.2},${H} ${W * 0.42},${H * 0.66} ${W * 0.58},${H * 0.66} ${W * 0.8},${H}" fill="#11151c"/>`; for (let i = 0; i < 5; i++) { const t = i / 5; const y = H * (0.66 + t * 0.34); const w = (2 + t * 14); d += `<rect x="${W / 2 - w / 2}" y="${y}" width="${w}" height="${H * 0.04}" fill="#ffd400" opacity="0.7"/>`; } return d; },
  neon_city: (W, H) => { let d = `<defs><linearGradient id="rb" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#2a1147"/><stop offset="60%" stop-color="#16082b"/><stop offset="100%" stop-color="#0a0416"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#rb)"/>`; for (let i = 0; i < 12; i++) { const x = W * (i / 12), bw = W * 0.075, bh = H * (0.12 + (i * 37 % 5) * 0.05); d += `<rect x="${x}" y="${H * 0.62 - bh}" width="${bw}" height="${bh}" fill="#1d1140" opacity="0.9"/>`; for (let k = 0; k < 4; k++) d += `<rect x="${x + bw * 0.2}" y="${H * 0.62 - bh + k * bh * 0.22 + 6}" width="${bw * 0.18}" height="${bh * 0.1}" fill="#ffe066" opacity="0.5"/>`; } d += `<rect x="0" y="${H * 0.62}" width="${W}" height="4" fill="#ff2d78" opacity="0.6"/><rect x="0" y="${H * 0.66}" width="${W}" height="2" fill="#4da6ff" opacity="0.5"/><rect x="0" y="${H * 0.62}" width="${W}" height="${H * 0.38}" fill="#000" opacity="0.4"/>`; return d; },
  gold_lux: (W, H) => { let d = `<defs><radialGradient id="rb" cx="50%" cy="40%" r="80%"><stop offset="0%" stop-color="#2a2a2a"/><stop offset="100%" stop-color="#080808"/></radialGradient></defs><rect width="${W}" height="${H}" fill="url(#rb)"/>`; for (let i = -4; i < 12; i++) { const x = W * (i * 0.12); d += `<line x1="${x}" y1="0" x2="${x + W * 0.4}" y2="${H}" stroke="#caa24a" stroke-width="1.5" opacity="0.18"/>`; } const br = (x, y, sx, sy) => `<path d="M ${x} ${y + sy * H * 0.08} V ${y} H ${x + sx * W * 0.08}" stroke="#ffd86b" stroke-width="5" fill="none"/>`; d += br(W * 0.05, H * 0.05, 1, 1) + br(W * 0.95, H * 0.05, -1, 1) + br(W * 0.05, H * 0.95, 1, -1) + br(W * 0.95, H * 0.95, -1, -1); d += `<ellipse cx="${W / 2}" cy="${H * 0.78}" rx="${W * 0.42}" ry="${H * 0.05}" fill="#caa24a" opacity="0.08"/>`; return d; },
  carbon_red: (W, H) => { let d = `<defs><linearGradient id="rb" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="#3a0008"/><stop offset="55%" stop-color="#1a0004"/><stop offset="100%" stop-color="#000"/></linearGradient></defs><rect width="${W}" height="${H}" fill="url(#rb)"/>`; for (let y = 0; y < H; y += 26) for (let x = 0; x < W; x += 26) { const o = ((x + y) / 26) % 2 === 0; d += `<rect x="${x}" y="${y}" width="13" height="13" fill="#fff" opacity="${o ? 0.025 : 0.01}"/>`; } d += `<polygon points="0,${H * 0.4} ${W},${H * 0.2} ${W},${H * 0.3} 0,${H * 0.5}" fill="#E4002B" opacity="0.25"/>`; return d; },
};
function readyBgSvg(id, W, H) { return READY_BG[id] ? READY_BG[id](W, H) : ""; }
// 3D दो-रंग बटन (label + value)
function btn3d(x, y, bw, bh, label, value, lFill, vFill, vText, lSize, vSize) {
  const rx = bh / 2, split = x + bw * 0.54, lift = bh * 0.08;
  return `<rect x="${x}" y="${y + lift}" width="${bw}" height="${bh}" rx="${rx}" fill="#000" opacity="0.4"/>`
    + `<path d="M ${x + rx} ${y} H ${split} V ${y + bh} H ${x + rx} A ${rx} ${rx} 0 0 1 ${x + rx} ${y} Z" fill="${lFill}"/>`
    + `<path d="M ${split} ${y} H ${x + bw - rx} A ${rx} ${rx} 0 0 1 ${x + bw - rx} ${y + bh} H ${split} Z" fill="${vFill}"/>`
    + `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="${rx}" fill="none" stroke="#ffd400" stroke-width="2.5"/>`
    + `<rect x="${x + 8}" y="${y + 3}" width="${bw - 16}" height="${bh * 0.3}" rx="${rx * 0.6}" fill="#fff" opacity="0.14"/>`
    + `<text x="${x + (split - x) / 2}" y="${y + bh * 0.66}" text-anchor="middle" font-family="Noto Sans Devanagari,Mukta,sans-serif" font-size="${lSize}" font-weight="700" fill="#fff">${esc(label)}</text>`
    + `<text x="${split + (x + bw - split) / 2}" y="${y + bh * 0.68}" text-anchor="middle" font-family="Mukta,sans-serif" font-size="${vSize}" font-weight="800" fill="${vText || "#fff"}">${esc(value)}</text>`;
}
// image में emoji server पर डिब्बा (tofu) बनता है — हटाओ
function stripEmoji(s) { return String(s).replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{1F1E6}-\u{1F1FF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}]/gu, "").replace(/\s+/g, " ").trim(); }
function wrapLines(text, maxChars) {
  const out = [];
  for (const raw of String(text).split("\n")) {
    let line = "";
    for (const word of raw.split(/\s+/)) {
      if ((line + " " + word).trim().length > maxChars) { if (line) out.push(line.trim()); line = word; }
      else line = (line + " " + word).trim();
    }
    out.push(line.trim());
  }
  return out.filter((l) => l.length > 0);
}
// ===== 9 design styles (poster लुक) — user चुने या random =====
// id → App.jsx dropdown में यही value भेजें
const DESIGN_STYLES = [
  { id: "goldcard",   label: "गोल्ड कार्ड" },        // 0
  { id: "quote",      label: "सुविचार (कोट)" },       // 1
  { id: "sunburst",   label: "सनबर्स्ट किरणें" },     // 2
  { id: "modern",     label: "मॉडर्न पट्टियाँ" },      // 3
  { id: "mandala",    label: "मंडला आर्क" },          // 4
  { id: "temple",     label: "मंदिर-आर्क (त्यौहार)" }, // 5
  { id: "social",     label: "बधाई कार्ड (confetti)" },// 6
  { id: "boldsplit",  label: "बोल्ड स्प्लिट (ऑफर)" },  // 7
  { id: "frame",      label: "एलिगेंट फ्रेम" },        // 8
];
const DESIGN_ID2IDX = Object.fromEntries(DESIGN_STYLES.map((d, i) => [d.id, i]));
// design चुनें: user value > type-आधारित अच्छा default > random
function pickDesign(design, type) {
  if (design && design !== "auto" && DESIGN_ID2IDX[design] != null) return DESIGN_ID2IDX[design];
  if (design && /^[0-8]$/.test(String(design))) return parseInt(design, 10);
  return Math.floor(Math.random() * DESIGN_STYLES.length); // पुराना random behavior (अब 9 में से)
}
function designDecor(vnt, w, h, gold2) {
  let vDecor = "";
  if (vnt === 0) {
    vDecor = `<rect x="${w * 0.05}" y="${h * 0.27}" width="${w * 0.9}" height="${h * 0.5}" rx="30" fill="#fff" fill-opacity="0.08" stroke="${gold2}" stroke-width="2.5" stroke-opacity="0.9"/>
      <path d="M ${w * 0.08} ${h * 0.32} h ${w * 0.07} M ${w * 0.08} ${h * 0.32} v ${h * 0.045}" stroke="${gold2}" stroke-width="5" fill="none"/>
      <path d="M ${w * 0.92} ${h * 0.72} h ${-w * 0.07} M ${w * 0.92} ${h * 0.72} v ${-h * 0.045}" stroke="${gold2}" stroke-width="5" fill="none"/>`;
  } else if (vnt === 1) {
    vDecor = `<text x="${w * 0.09}" y="${h * 0.36}" font-family="Georgia,serif" font-size="${Math.round(w / 5.5)}" fill="${gold2}" opacity="0.85">\u201C</text>
      <text x="${w * 0.91}" y="${h * 0.82}" text-anchor="end" font-family="Georgia,serif" font-size="${Math.round(w / 5.5)}" fill="${gold2}" opacity="0.85">\u201D</text>
      <line x1="${w * 0.3}" y1="${h * 0.775}" x2="${w * 0.7}" y2="${h * 0.775}" stroke="${gold2}" stroke-width="3" opacity="0.8"/>`;
  } else if (vnt === 2) {
    let rays = "";
    for (let i = 0; i < 24; i++) { const a = (i * 15) * Math.PI / 180; const x2 = w / 2 + Math.cos(a) * w, y2 = h * 0.5 + Math.sin(a) * w; rays += `<line x1="${w / 2}" y1="${h * 0.5}" x2="${x2}" y2="${y2}" stroke="#fff" stroke-width="${i % 2 ? 26 : 12}" opacity="0.05"/>`; }
    vDecor = rays + `<circle cx="${w / 2}" cy="${h * 0.5}" r="${w * 0.34}" fill="#000" opacity="0.18"/><circle cx="${w / 2}" cy="${h * 0.5}" r="${w * 0.34}" fill="none" stroke="${gold2}" stroke-width="3" opacity="0.9"/>`;
  } else if (vnt === 3) {
    vDecor = `<polygon points="0,${h * 0.13} ${w * 0.42},${h * 0.13} ${w * 0.34},${h * 0.205} 0,${h * 0.205}" fill="${gold2}" opacity="0.92"/>
      <polygon points="${w},${h * 0.74} ${w * 0.58},${h * 0.74} ${w * 0.66},${h * 0.81} ${w},${h * 0.81}" fill="#fff" opacity="0.14"/>
      <rect x="0" y="${h * 0.25}" width="${w * 0.016}" height="${h * 0.52}" fill="${gold2}"/><rect x="${w * 0.984}" y="${h * 0.25}" width="${w * 0.016}" height="${h * 0.52}" fill="${gold2}"/>`;
  } else if (vnt === 4) {
    const arc = (cx, cy, r) => `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${gold2}" stroke-width="2.5" opacity="0.8"/><circle cx="${cx}" cy="${cy}" r="${r * 0.78}" fill="none" stroke="#fff" stroke-width="2" stroke-dasharray="4 10" opacity="0.5"/><circle cx="${cx}" cy="${cy}" r="${r * 0.56}" fill="none" stroke="${gold2}" stroke-width="1.5" opacity="0.55"/>`;
    vDecor = arc(0, h * 0.115, w * 0.22) + arc(w, h * 0.84, w * 0.22);
  } else if (vnt === 5) { // मंदिर-आर्क + घंटियाँ + गेंदा (त्यौहार)
    const ax = w * 0.5, top = h * 0.2, aw = w * 0.78, ah = h * 0.58;
    vDecor = `<path d="M ${ax - aw / 2} ${top + ah} V ${top + ah * 0.32} Q ${ax - aw / 2} ${top} ${ax} ${top} Q ${ax + aw / 2} ${top} ${ax + aw / 2} ${top + ah * 0.32} V ${top + ah}" fill="none" stroke="${gold2}" stroke-width="6" opacity="0.95"/>
      <path d="M ${ax - aw / 2 * 0.9} ${top + ah} V ${top + ah * 0.34} Q ${ax - aw / 2 * 0.9} ${top + ah * 0.06} ${ax} ${top + ah * 0.06} Q ${ax + aw / 2 * 0.9} ${top + ah * 0.06} ${ax + aw / 2 * 0.9} ${top + ah * 0.34} V ${top + ah}" fill="none" stroke="#fff" stroke-width="2" stroke-dasharray="3 9" opacity="0.5"/>`;
    for (let i = 0; i < 6; i++) { const x = w * 0.1 + i * (w * 0.8 / 5); vDecor += `<line x1="${x}" y1="0" x2="${x}" y2="${h * 0.07}" stroke="${gold2}" stroke-width="2" opacity="0.7"/><path d="M ${x - w * 0.018} ${h * 0.07} Q ${x} ${h * 0.045} ${x + w * 0.018} ${h * 0.07} Z" fill="${gold2}" opacity="0.85"/><circle cx="${x}" cy="${h * 0.078}" r="${w * 0.006}" fill="${gold2}"/>`; }
    const mari = (cx, cy) => { let g = ""; for (let k = 0; k < 8; k++) { const a = k * Math.PI / 4; g += `<circle cx="${cx + Math.cos(a) * w * 0.018}" cy="${cy + Math.sin(a) * w * 0.018}" r="${w * 0.013}" fill="${k % 2 ? "#ff8a00" : "#ffb703"}"/>`; } return g + `<circle cx="${cx}" cy="${cy}" r="${w * 0.016}" fill="#e8590c"/>`; };
    vDecor += mari(w * 0.12, h * 0.16) + mari(w * 0.88, h * 0.16);
  } else if (vnt === 6) { // बधाई कार्ड — confetti + card
    const c = ["#ff2d78", "#ffd400", "#16a34a", "#1565c0", "#9b51e0", "#fff"];
    let conf = ""; for (let i = 0; i < 22; i++) { conf += `<rect x="${(i * 89) % w}" y="${(i * 53) % (h * 0.22)}" width="${w * 0.018}" height="${w * 0.018}" rx="2" fill="${c[i % 6]}" transform="rotate(${i * 40} ${(i * 89) % w} ${(i * 53) % (h * 0.22)})"/>`; }
    vDecor = conf + `<rect x="${w * 0.07}" y="${h * 0.26}" width="${w * 0.86}" height="${h * 0.5}" rx="${w * 0.05}" fill="#fff" fill-opacity="0.1" stroke="#fff" stroke-width="3" stroke-opacity="0.5"/>`;
  } else if (vnt === 7) { // बोल्ड स्प्लिट — gold पट्टियाँ + तिरछा ब्लॉक
    vDecor = `<rect x="0" y="${h * 0.22}" width="${w}" height="${h * 0.04}" fill="${gold2}" opacity="0.9"/>
      <rect x="0" y="${h * 0.74}" width="${w}" height="${h * 0.04}" fill="${gold2}" opacity="0.9"/>
      <polygon points="0,${h * 0.26} ${w * 0.5},${h * 0.26} ${w * 0.42},${h * 0.74} 0,${h * 0.74}" fill="#000" opacity="0.18"/>`;
  } else if (vnt === 8) { // एलिगेंट डबल-फ्रेम
    vDecor = `<rect x="${w * 0.035}" y="${h * 0.035}" width="${w * 0.93}" height="${h * 0.93}" fill="none" stroke="${gold2}" stroke-width="3" opacity="0.9"/>
      <rect x="${w * 0.055}" y="${h * 0.055}" width="${w * 0.89}" height="${h * 0.89}" fill="none" stroke="#fff" stroke-width="1.5" opacity="0.4"/>
      <circle cx="${w * 0.5}" cy="${h * 0.235}" r="${w * 0.03}" fill="none" stroke="${gold2}" stroke-width="2.5" opacity="0.8"/>`;
  }
  return vDecor;
}
function buildSVG(brandId, text, w, h, type, opts) {
  const b = BRANDS[brandId];
  const festive = type === "festival" || type === "gift";
  const gold = "#ffd400";
  const fontSize = Math.round(w / 16);
  const maxChars = Math.max(12, Math.floor((w * 0.82) / (fontSize * 0.6)));
  const lines = wrapLines(stripEmoji(text), maxChars);
  const lineGap = Math.round(fontSize * 1.32);
  const startY = h * 0.52 - (lines.length * lineGap) / 2 + fontSize;
  const tspans = lines.map((l, i) => `<text x="50%" y="${startY + i * lineGap}" text-anchor="middle" font-family="Noto Sans Devanagari, Mukta, sans-serif" font-size="${fontSize}" font-weight="700" fill="#fff">${esc(l)}</text>`).join("");
  // festival/gift पर हल्के सजावटी गोले
  const decor = festive
    ? `<circle cx="${w * 0.12}" cy="${h * 0.3}" r="${w * 0.012}" fill="${gold}" fill-opacity="0.8"/>
       <circle cx="${w * 0.88}" cy="${h * 0.32}" r="${w * 0.016}" fill="${gold}" fill-opacity="0.7"/>
       <circle cx="${w * 0.2}" cy="${h * 0.7}" r="${w * 0.01}" fill="${gold}" fill-opacity="0.6"/>
       <circle cx="${w * 0.82}" cy="${h * 0.68}" r="${w * 0.013}" fill="${gold}" fill-opacity="0.7"/>` : "";
  const acc1 = (opts && opts.themeColor) || b.accent;
  const acc2 = (opts && opts.themeColor2) || b.accent2;
  const gold2 = "#ffd400";
  // 9 named design styles. user opts.design दे तो वही; वरना पुराना random (अब 9 में से) — backward-compatible
  const vnt = pickDesign(opts && opts.design, type);
  const vDecor = designDecor(vnt, w, h, gold2);
  return Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    ${(opts && opts.bg && opts.bg !== "auto") ? readyBgSvg(opts.bg, w, h) : `<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${acc1}"/><stop offset="100%" stop-color="${acc2}"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#bg)"/>`}
    ${decor}
    ${vDecor}
    <!-- top brand bar -->
    <rect x="0" y="0" width="${w}" height="${h * 0.11}" fill="#000" fill-opacity="0.25"/>
    <text x="${w * 0.97}" y="${h * 0.072}" text-anchor="end" font-family="Noto Sans Devanagari, Mukta, sans-serif" font-size="${Math.round(w / 22)}" font-weight="700" fill="#fff">${esc(b.name)}</text>
    <rect x="${w * 0.5 - w * 0.06}" y="${h * 0.16}" width="${w * 0.12}" height="6" rx="3" fill="${festive ? gold : "#fff"}"/>
    ${tspans}
    <!-- आकर्षक address बटन (हर poster में सबसे नीचे) -->
    ${addrBar(b, w, h)}
    <text x="${w * 0.95}" y="${h * 0.86}" text-anchor="end" font-family="Mukta, sans-serif" font-size="${Math.round(w / 55)}" fill="#ffd54f" fill-opacity="0.9">AI Generated</text>
    ${opts && opts.sticker ? stickersSVG(opts.sticker, opts.offer, {}, w, h, [[0.15, 0.205], [0.85, 0.205], [0.85, 0.775]], w * 0.082) : ""}
    ${opts && opts.decor ? decorSVG(opts.decor, w, h, w * 0.038, [[0.10, 0.165], [0.90, 0.165], [0.10, 0.795], [0.90, 0.795]]) : ""}
    ${opts && opts.autoDecor ? autoDecorLayer(opts.autoSeed || text, {}, w, h) : ""}</svg>`);
}
async function loadLogo(brandId, size) {
  const b = BRANDS[brandId];
  if (!b.logo) return null;
  const p = path.join(LOGO_DIR, b.logo);
  try {
    return await removeWhiteBg(p, size, size); // सफ़ेद डिब्बा हटाकर साफ़ logo
  } catch (_) {
    try { return await sharp(p).resize(size, size, { fit: "inside" }).png().toBuffer(); } catch (e) { return null; }
  }
}
async function generateImages(brandId, id, text, type, opts) {
  const sizes = { square: [1080, 1080], story: [1080, 1920], landscape: [1200, 630] };
  const out = {}; const b64 = {};
  for (const [k, [w, h]] of Object.entries(sizes)) {
    const f = `${id}_${k}.png`;
    let base = await sharp(buildSVG(brandId, text, w, h, type, opts)).png().toBuffer();
    const logo = await loadLogo(brandId, Math.round(w * 0.18));
    if (logo) base = await sharp(base).composite([{ input: logo, top: Math.round(h * 0.025), left: Math.round(w * 0.04) }]).png().toBuffer();
    await sharp(base).toFile(path.join(OUT_DIR, f));
    out[k] = `/generated/${f}`;
    if (k === "square" || k === "story") b64[k] = "data:image/png;base64," + base.toString("base64");
  }
  out._b64 = b64; // restart-safe base64 (route इसे doc.imageData में रखता है)
  return out;
}

// ----- PROMO: गाड़ी वाला आकर्षक विज्ञापन poster (Honda-ad style) -----
// background options (o.bg): "light" | "brand" | "dark" | "ai"
const PROMO_BG = ["light", "brand", "dark", "ai"];
function promoPalette(brandId, bg) {
  if (bg === "brand") return { kind: "grad", textDark: "#fff", footMuted: "#f0f0f0", scrim: false, transparent: false };
  if (bg === "dark") return { kind: "dark", textDark: "#fff", footMuted: "#bbb", scrim: false, transparent: false };
  if (bg === "ai") return { kind: "ai", textDark: "#fff", footMuted: "#eee", scrim: true, transparent: true };
  return { kind: "light", textDark: "#1a1a1a", footMuted: "#555", scrim: false, transparent: false };
}
// offer seal (starburst sticker) — विज्ञापन+ के offers
const OFFERS = {
  cashback: { l1: "कैशबैक", amt: "cashback" },
  lowdp: { l1: "कम डाउन", amt: "downPayment", l2def: "पेमेंट" },
  exchange: { l1: "एक्सचेंज", l2def: "बोनस" },
  student: { l1: "स्टूडेंट", l2def: "स्पेशल" },
  newyear: { l1: "नया साल", l2def: "ऑफर" },
  festival: { l1: "फेस्टिव", l2def: "ऑफर" },
  freegift: { l1: "फ्री", l2def: "गिफ्ट" },
};
const STICKER_COUNT = 10;
// sticker library — 10 design (n = 1..10)
function _poly(cx, cy, r, inner, pts) { let p = ""; for (let i = 0; i < pts * 2; i++) { const a = (Math.PI / pts) * i - Math.PI / 2; const rad = i % 2 === 0 ? r : r * inner; p += `${(cx + rad * Math.cos(a)).toFixed(1)},${(cy + rad * Math.sin(a)).toFixed(1)} `; } return p; }
function _scallop(cx, cy, r, bumps) { let d = ""; for (let i = 0; i < bumps; i++) { const a0 = (2 * Math.PI / bumps) * i - Math.PI / 2, a1 = (2 * Math.PI / bumps) * (i + 1) - Math.PI / 2, am = (a0 + a1) / 2; const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0), xm = cx + r * 1.18 * Math.cos(am), ym = cy + r * 1.18 * Math.sin(am), x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1); d += (i === 0 ? `M ${x0} ${y0} ` : "") + `Q ${xm} ${ym} ${x1} ${y1} `; } return d + "Z"; }
function buildStickerSVG(n, cx, cy, r, l1, l2) {
  const F = "Noto Sans Devanagari,Mukta,sans-serif";
  const T = (c, fs, dy, fill, wt = 800) => `<text x="${cx}" y="${cy + dy}" text-anchor="middle" font-family="${F}" font-size="${fs}" font-weight="${wt}" fill="${fill}">${esc(c)}</text>`;
  const fs1 = r * 0.30, fs2 = r * 0.46;
  const txt = (c1, c2) => T(l1, fs1, -r * 0.12, c1, 700) + (l2 ? T(l2, fs2, r * 0.36, c2) : "");
  switch (parseInt(n, 10)) {
    case 1: return `<polygon points="${_poly(cx, cy, r, 0.8, 24)}" fill="#E4002B" stroke="#ffd400" stroke-width="${r * 0.05}"/>` + txt("#fff", "#fff");
    case 2: return `<path d="${_scallop(cx, cy, r * 0.85, 14)}" fill="#E4002B"/><circle cx="${cx}" cy="${cy}" r="${r * 0.78}" fill="none" stroke="#fff" stroke-width="${r * 0.04}"/>` + txt("#fff", "#fff");
    case 3: return `<polygon points="${_poly(cx, cy, r, 0.62, 16)}" fill="#0EA36A"/>` + txt("#fff", "#fff");
    case 4: return `<polygon points="${_poly(cx, cy, r, 0.7, 40)}" fill="#1565C0" stroke="#fff" stroke-width="${r * 0.04}"/>` + txt("#fff", "#ffd400");
    case 5: return `<path d="${_scallop(cx, cy, r * 0.85, 10)}" fill="#ff8a00"/>` + txt("#fff", "#fff");
    case 6: return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#111"/><circle cx="${cx}" cy="${cy}" r="${r * 0.86}" fill="none" stroke="#ffd400" stroke-width="${r * 0.06}"/>` + txt("#ffd400", "#fff");
    case 7: return `<polygon points="${_poly(cx, cy, r, 0.85, 32)}" fill="#ffd400"/><circle cx="${cx}" cy="${cy}" r="${r * 0.7}" fill="#E4002B"/>` + txt("#fff", "#fff");
    case 8: return `<rect x="${cx - r}" y="${cy - r * 0.5}" width="${r * 2}" height="${r}" rx="${r * 0.12}" fill="#E4002B" transform="rotate(-6 ${cx} ${cy})"/><g transform="rotate(-6 ${cx} ${cy})">` + T(l1, fs1, -r * 0.05, "#fff", 700) + (l2 ? T(l2, fs2 * 0.85, r * 0.32, "#ffd400") : "") + `</g>`;
    case 9: return `<polygon points="${_poly(cx, cy, r, 0.78, 12)}" fill="#fff" stroke="#E4002B" stroke-width="${r * 0.06}"/>` + txt("#E4002B", "#E4002B");
    case 10: return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#7b1fa2"/><circle cx="${cx}" cy="${cy}" r="${r * 0.88}" fill="none" stroke="#fff" stroke-width="${r * 0.03}" stroke-dasharray="${r * 0.2} ${r * 0.1}"/>` + txt("#fff", "#ffd400");
    default: return "";
  }
}
// offer text + chosen sticker style → sticker SVG (किसी भी poster पर)
function offerTextLines(o) {
  const def = OFFERS[o.offer];
  if (def) return { l1: def.l1, l2: def.amt && o[def.amt] ? "₹" + o[def.amt] : (def.l2def || "ऑफर") };
  return { l1: "स्पेशल", l2: "ऑफर" };
}
// कई offers → कई stickers (multi-select; कई sticker-design भी cycle होते हैं)
function stickersSVG(stickerCsv, offerCsv, amounts, w, h, positions, r) {
  let styles = String(stickerCsv || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!styles.length) return "";
  let offers = String(offerCsv || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!offers.length) offers = [""];
  return offers.slice(0, positions.length).map((off, i) => {
    const def = OFFERS[off];
    const l1 = def ? def.l1 : "स्पेशल";
    const l2 = def ? (def.amt && amounts[def.amt] ? "₹" + amounts[def.amt] : (def.l2def || "ऑफर")) : "ऑफर";
    return buildStickerSVG(styles[i % styles.length], w * positions[i][0], h * positions[i][1], r, l1, l2);
  }).join("");
}
function offerSeal(o, w, h) {
  // 5 positions (पहले सिर्फ़ 3 थे) — सभी selected offers दिखें, overlap न हो
  return stickersSVG(o.sticker, o.offer, { cashback: o.cashback, downPayment: o.downPayment }, w, h,
    [[0.84, 0.28], [0.15, 0.30], [0.15, 0.56], [0.84, 0.56], [0.5, 0.14]], w * 0.088);
}
// drawn emoji/decoration library (हमेशा सही दिखते हैं, कभी डिब्बा नहीं)
const DECOR_NAMES = ["star", "heart", "flame", "gift", "sparkle", "check", "crown", "rupee", "party"];
function _star(cx, cy, r, fill) { let p = ""; for (let i = 0; i < 10; i++) { const a = (Math.PI / 5) * i - Math.PI / 2; const rad = i % 2 === 0 ? r : r * 0.42; p += `${(cx + rad * Math.cos(a)).toFixed(1)},${(cy + rad * Math.sin(a)).toFixed(1)} `; } return `<polygon points="${p}" fill="${fill}"/>`; }
function buildDecorSVG(name, cx, cy, r) {
  switch (name) {
    case "star": return _star(cx, cy, r, "#ffd400");
    case "heart": return `<path d="M ${cx} ${cy + r * 0.7} C ${cx - r * 1.3} ${cy - r * 0.4}, ${cx - r * 0.5} ${cy - r * 1.1}, ${cx} ${cy - r * 0.3} C ${cx + r * 0.5} ${cy - r * 1.1}, ${cx + r * 1.3} ${cy - r * 0.4}, ${cx} ${cy + r * 0.7} Z" fill="#e4002b"/>`;
    case "flame": return `<path d="M ${cx} ${cy - r} C ${cx + r * 0.9} ${cy - r * 0.1}, ${cx + r * 0.5} ${cy + r}, ${cx} ${cy + r} C ${cx - r * 0.5} ${cy + r}, ${cx - r * 0.9} ${cy - r * 0.1}, ${cx} ${cy - r} Z" fill="#ff7a00"/><path d="M ${cx} ${cy - r * 0.3} C ${cx + r * 0.4} ${cy + r * 0.1}, ${cx + r * 0.2} ${cy + r * 0.7}, ${cx} ${cy + r * 0.7} C ${cx - r * 0.2} ${cy + r * 0.7}, ${cx - r * 0.4} ${cy + r * 0.1}, ${cx} ${cy - r * 0.3} Z" fill="#ffd400"/>`;
    case "gift": return `<rect x="${cx - r}" y="${cy - r * 0.6}" width="${r * 2}" height="${r * 1.6}" rx="6" fill="#e4002b"/><rect x="${cx - r * 0.15}" y="${cy - r * 0.6}" width="${r * 0.3}" height="${r * 1.6}" fill="#ffd400"/><rect x="${cx - r}" y="${cy - r * 0.2}" width="${r * 2}" height="${r * 0.3}" fill="#ffd400"/><circle cx="${cx}" cy="${cy - r * 0.7}" r="${r * 0.28}" fill="none" stroke="#ffd400" stroke-width="${r * 0.18}"/>`;
    case "sparkle": return _star(cx, cy, r, "#fff") + _star(cx, cy, r * 0.6, "#ffd400");
    case "check": return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#16a34a"/><path d="M ${cx - r * 0.45} ${cy} L ${cx - r * 0.1} ${cy + r * 0.4} L ${cx + r * 0.5} ${cy - r * 0.4}" stroke="#fff" stroke-width="${r * 0.18}" fill="none" stroke-linecap="round" stroke-linejoin="round"/>`;
    case "crown": return `<polygon points="${cx - r},${cy + r * 0.5} ${cx - r},${cy - r * 0.4} ${cx - r * 0.5},${cy} ${cx},${cy - r * 0.7} ${cx + r * 0.5},${cy} ${cx + r},${cy - r * 0.4} ${cx + r},${cy + r * 0.5}" fill="#ffd400" stroke="#e0a800" stroke-width="2"/>`;
    case "rupee": return `<circle cx="${cx}" cy="${cy}" r="${r}" fill="#1565c0"/><text x="${cx}" y="${cy + r * 0.45}" text-anchor="middle" font-family="Mukta,sans-serif" font-size="${r * 1.3}" font-weight="800" fill="#fff">₹</text>`;
    case "party": return `<polygon points="${cx - r},${cy + r} ${cx + r * 0.3},${cy - r} ${cx + r},${cy + r * 0.3}" fill="#e4002b"/>` + _star(cx + r * 0.5, cy - r * 0.6, r * 0.3, "#ffd400") + _star(cx - r * 0.4, cy - r * 0.2, r * 0.22, "#16a34a");
    default: return "";
  }
}
function decorSVG(decorCsv, w, h, r, positions) {
  let names = String(decorCsv || "").split(",").map((s) => s.trim()).filter((s) => DECOR_NAMES.includes(s));
  if (!names.length) return "";
  const pos = positions || [[0.06, 0.20], [0.94, 0.20], [0.06, 0.42], [0.94, 0.42]];
  return names.slice(0, pos.length).map((n, i) => buildDecorSVG(n, w * pos[i][0], h * pos[i][1], r)).join("");
}
// ===== Honda Official Layout (original poster जैसा) =====
function buildHondaOfficialSVG(brandId, o, W, H) {
  const b = BRANDS[brandId];
  const ACCENT = b.accent || "#E4002B", GOLD = "#ffd400", DARK = "#141414", WHITE = "#ffffff";
  const model = esc(o.model || ""), tagline = esc(o.tagline || "SOLID माइलेज़");
  const price = esc(o.price || ""), dp = esc(o.downPayment || ""), cb = esc(o.cashback || "");
  const features = (o.features || []).slice(0, 4);
  const banks = (o.banks || []).slice(0, 5);
  let s = `<defs>
    <pattern id="diag" width="32" height="32" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="32" height="32" fill="#f7f7f7"/><line x1="0" y1="0" x2="0" y2="32" stroke="#e8e8e8" stroke-width="5"/></pattern>
    <filter id="sh"><feDropShadow dx="3" dy="5" stdDeviation="6" flood-color="#00000022"/></filter>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#diag)"/>
  <rect x="0" y="0" width="${W}" height="${H * 0.006}" fill="${ACCENT}"/>`;
  // Honda badge top-right
  s += `<rect x="${W * 0.84}" y="${H * 0.022}" width="${W * 0.14}" height="${H * 0.058}" rx="8" fill="${ACCENT}"/><text x="${W * 0.91}" y="${H * 0.061}" text-anchor="middle" font-family="Arial Black,sans-serif" font-size="${W * 0.028}" font-weight="900" fill="${WHITE}">HONDA</text>`;
  // Model name italic
  s += `<text x="${W * 0.04}" y="${H * 0.135}" font-family="Arial,sans-serif" font-size="${W * 0.072}" font-weight="900" font-style="italic" fill="${DARK}" filter="url(#sh)">${model}</text>`;
  s += `<rect x="${W * 0.04}" y="${H * 0.148}" width="${W * 0.34}" height="${H * 0.007}" rx="3" fill="${ACCENT}"/>`;
  // Tagline SOLID माइलेज़
  s += `<text x="${W * 0.04}" y="${H * 0.208}"><tspan font-family="Arial Black,sans-serif" font-size="${W * 0.06}" font-weight="900" fill="${ACCENT}">SOLID </tspan><tspan font-family="Noto Sans Devanagari,Arial,sans-serif" font-size="${W * 0.054}" font-weight="800" fill="${DARK}">माइलेज़</tspan></text>`;
  // RIGHT — offer boxes
  const rx = W * 0.545, bw = W * 0.425, bh = H * 0.112, gap = H * 0.022;
  s += `<text x="${rx + bw * 0.5}" y="${H * 0.125}" text-anchor="middle" font-family="Noto Sans Devanagari,Arial,sans-serif" font-size="${W * 0.03}" font-weight="800" fill="${DARK}">लिमिटेड पीरियड ऑफर</text>`;
  if (dp) {
    const b1y = H * 0.14;
    s += `<rect x="${rx}" y="${b1y}" width="${bw}" height="${bh}" rx="10" fill="${DARK}"/>
      <rect x="${rx + bw * 0.42}" y="${b1y}" width="${bw * 0.58}" height="${bh}" rx="10" fill="${GOLD}"/>
      <text x="${rx + bw * 0.21}" y="${b1y + bh * 0.42}" text-anchor="middle" font-family="Noto Sans Devanagari,Arial,sans-serif" font-size="${W * 0.024}" font-weight="700" fill="${WHITE}">डाउन</text>
      <text x="${rx + bw * 0.21}" y="${b1y + bh * 0.72}" text-anchor="middle" font-family="Noto Sans Devanagari,Arial,sans-serif" font-size="${W * 0.024}" font-weight="700" fill="${WHITE}">पेमेंट</text>
      <text x="${rx + bw * 0.72}" y="${b1y + bh * 0.68}" text-anchor="middle" font-family="Arial Black,sans-serif" font-size="${W * 0.052}" font-weight="900" fill="${ACCENT}">₹${dp}*</text>`;
  }
  if (cb) {
    const b2y = H * 0.14 + bh + gap;
    s += `<rect x="${rx}" y="${b2y}" width="${bw}" height="${bh}" rx="10" fill="${DARK}"/>
      <rect x="${rx + bw * 0.42}" y="${b2y}" width="${bw * 0.58}" height="${bh}" rx="10" fill="${ACCENT}"/>
      <text x="${rx + bw * 0.21}" y="${b2y + bh * 0.42}" text-anchor="middle" font-family="Noto Sans Devanagari,Arial,sans-serif" font-size="${W * 0.024}" font-weight="700" fill="${WHITE}">इंस्टेंट</text>
      <text x="${rx + bw * 0.21}" y="${b2y + bh * 0.72}" text-anchor="middle" font-family="Noto Sans Devanagari,Arial,sans-serif" font-size="${W * 0.024}" font-weight="700" fill="${WHITE}">कैशबैक</text>
      <text x="${rx + bw * 0.68}" y="${b2y + bh * 0.52}" text-anchor="middle" font-family="Arial Black,sans-serif" font-size="${W * 0.048}" font-weight="900" fill="${WHITE}">₹${cb}*</text>
      <text x="${rx + bw * 0.88}" y="${b2y + bh * 0.78}" text-anchor="middle" font-family="Noto Sans Devanagari,Arial,sans-serif" font-size="${W * 0.022}" fill="${WHITE}">तक</text>`;
  }
  // Ex-showroom price
  if (price) {
    const b3y = H * 0.14 + bh * 2 + gap * 2.8;
    s += `<text x="${rx + bw * 0.5}" y="${b3y}" text-anchor="middle" font-family="Noto Sans Devanagari,Arial,sans-serif" font-size="${W * 0.028}" font-weight="700" fill="${DARK}">एक्स-शोरूम (मध्यप्रदेश)</text>
      <text x="${rx + bw * 0.5}" y="${b3y + H * 0.09}" text-anchor="middle" font-family="Arial Black,sans-serif" font-size="${W * 0.078}" font-weight="900" fill="${ACCENT}">₹${price}</text>`;
  }
  // Digital meter circle (bottom-left)
  s += `<circle cx="${W * 0.115}" cy="${H * 0.74}" r="${W * 0.085}" fill="${DARK}" stroke="${ACCENT}" stroke-width="5"/>
    <text x="${W * 0.115}" y="${H * 0.728}" text-anchor="middle" font-family="monospace" font-size="${W * 0.03}" fill="${WHITE}">0  10:10</text>
    <text x="${W * 0.115}" y="${H * 0.755}" text-anchor="middle" font-family="Arial,sans-serif" font-size="${W * 0.018}" font-weight="700" fill="${GOLD}">DIGITAL</text>`;
  // VP brand circle (top-left over bike)
  s += `<circle cx="${W * 0.1}" cy="${H * 0.285}" r="${W * 0.062}" fill="${DARK}" stroke="${GOLD}" stroke-width="4"/>
    <text x="${W * 0.1}" y="${H * 0.273}" text-anchor="middle" font-family="Arial Black,sans-serif" font-size="${W * 0.03}" font-weight="900" fill="${WHITE}">${esc(b.name ? b.name.split(" ")[0] : "VP")}</text>
    <text x="${W * 0.1}" y="${H * 0.298}" text-anchor="middle" font-family="Arial Black,sans-serif" font-size="${W * 0.02}" font-weight="700" fill="${GOLD}">${esc(b.name ? b.name.split(" ").slice(1).join(" ") : "HONDA")}</text>`;
  // Features bar (red)
  const barY = H * 0.822;
  s += `<rect x="0" y="${barY}" width="${W}" height="${H * 0.082}" fill="${ACCENT}"/>`;
  if (features.length) {
    const fw = W / features.length;
    features.forEach((f, i) => {
      s += `<text x="${fw * i + fw * 0.5}" y="${barY + H * 0.054}" text-anchor="middle" font-family="Noto Sans Devanagari,Arial,sans-serif" font-size="${W * 0.023}" font-weight="700" fill="${WHITE}">${esc(f)}</text>`;
      if (i < features.length - 1) s += `<line x1="${fw * (i + 1)}" y1="${barY + H * 0.012}" x2="${fw * (i + 1)}" y2="${barY + H * 0.07}" stroke="${WHITE}" stroke-width="1.5" opacity="0.5"/>`;
    });
  }
  // Finance partners strip
  const finY = H * 0.906;
  s += `<rect x="0" y="${finY}" width="${W * 0.58}" height="${H * 0.044}" fill="#f0f0f0"/>
    <text x="${W * 0.04}" y="${finY + H * 0.015}" font-family="Arial,sans-serif" font-size="${W * 0.018}" font-weight="600" fill="${DARK}">फाइनेंस पार्टनर्स*</text>`;
  banks.slice(0, 4).forEach((bk, i) => {
    const bkx = W * 0.04 + i * W * 0.135;
    s += `<rect x="${bkx}" y="${finY + H * 0.019}" width="${W * 0.12}" height="${H * 0.022}" rx="4" fill="#ddd"/>
      <text x="${bkx + W * 0.06}" y="${finY + H * 0.034}" text-anchor="middle" font-family="Arial,sans-serif" font-size="${W * 0.016}" font-weight="700" fill="${DARK}">${esc(bk)}</text>`;
  });
  // Cashback partner (right side of finance bar)
  s += `<rect x="${W * 0.62}" y="${finY}" width="${W * 0.38}" height="${H * 0.044}" fill="#e8e8e8"/>
    <text x="${W * 0.645}" y="${finY + H * 0.015}" font-family="Arial,sans-serif" font-size="${W * 0.018}" font-weight="600" fill="${DARK}">कैशबैक पार्टनर*</text>
    <rect x="${W * 0.72}" y="${finY + H * 0.018}" width="${W * 0.24}" height="${H * 0.024}" rx="4" fill="#0054a6"/>
    <text x="${W * 0.84}" y="${finY + H * 0.034}" text-anchor="middle" font-family="Arial Black,sans-serif" font-size="${W * 0.018}" font-weight="900" fill="${WHITE}">HDFC BANK</text>`;
  // Dealer bar
  s += `<rect x="0" y="${H * 0.95}" width="${W}" height="${H * 0.05}" fill="${DARK}"/>
    <text x="${W * 0.5}" y="${H * 0.985}" text-anchor="middle" font-family="Noto Sans Devanagari,Arial,sans-serif" font-size="${W * 0.03}" font-weight="800" fill="${WHITE}">${esc(b.name)},  फ़ोन ${esc(b.phone)}  —  ${esc(b.place)}</text>`;
  return Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${s}</svg>`);
}
// safe corner slots — logo बाएँ-ऊपर (x:0.04-0.22, y:0.025-0.21) है, brand-name दाएँ-ऊपर है, address-bar नीचे है
// इसलिए: slot[0]=दाएँ-ऊपर (logo नहीं है वहाँ), slot[1]=बाएँ-नीचे, slot[2]=दाएँ-नीचे, slot[3]=बाएँ-बीच
const AUTO_SLOTS = [[0.82, 0.18], [0.18, 0.78], [0.82, 0.78], [0.18, 0.48], [0.82, 0.48], [0.5, 0.88], [0.5, 0.14]];
const AUTO_THEMES = [
  { stickers: ["1", "7"], decor: ["star", "sparkle"], offers: ["festival", "freegift"] },
  { stickers: ["6", "4"], decor: ["crown", "flame"], offers: ["newyear", "student"] },
  { stickers: ["2", "9"], decor: ["heart", "gift"], offers: ["cashback", "lowdp"] },
  { stickers: ["5", "10"], decor: ["party", "rupee"], offers: ["exchange", "festival"] },
  { stickers: ["7", "3"], decor: ["sparkle", "star"], offers: ["freegift", "cashback"] },
];
// seed (id/text आधारित) से theme चुनें — हर post पर अलग पर एक post में stable
function autoSeed(s) { let h = 0; const str = String(s || Math.random()); for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0; return h; }
// auto-design की पूरी सजावट परत (stickers + decor), केंद्र खाली, बिना overlap
function autoDecorLayer(seed, amounts, w, h) {
  const t = AUTO_THEMES[autoSeed(seed) % AUTO_THEMES.length];
  const r1 = w * 0.085, r2 = w * 0.04;
  // 2 stickers — ऊपरी दो कोनों में (text केंद्र में सुरक्षित)
  const stk = t.stickers.map((style, i) => {
    const off = t.offers[i]; const def = OFFERS[off];
    const l1 = def ? def.l1 : "स्पेशल";
    const l2 = def ? (def.amt && amounts && amounts[def.amt] ? "₹" + amounts[def.amt] : (def.l2def || "ऑफर")) : "ऑफर";
    const p = AUTO_SLOTS[i]; return buildStickerSVG(style, w * p[0], h * p[1], r1, l1, l2);
  }).join("");
  // 2 छोटे decor — निचले दो कोनों में
  const dec = t.decor.map((n, i) => { const p = AUTO_SLOTS[2 + i]; return buildDecorSVG(n, w * p[0], h * p[1], r2); }).join("");
  return stk + dec;
}
function buildPromoSVG(brandId, o, w, h) {
  const b = BRANDS[brandId];
  const bg = PROMO_BG.includes(o.bg) ? o.bg : "light";
  const p = promoPalette(brandId, bg);
  const feats = (o.features || []).slice(0, 4);
  const featLine = feats.length ? feats.join("   |   ") : "आसान EMI   |   एक्सचेंज बोनस   |   फाइनेंस सुविधा उपलब्ध";
  const bankLine = (o.banks && o.banks.length) ? o.banks.join("   •   ") : "HDB   •   IDFC First   •   Shriram Finance   •   Bajaj Finance";
  // background fill (transparent पर skip — AI/photo के लिए)
  let bgRect = "";
  if (!p.transparent) {
    if (p.kind === "grad") bgRect = `<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${b.accent}"/><stop offset="100%" stop-color="${b.accent2}"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#bg)"/>`;
    else if (p.kind === "dark") bgRect = `<rect width="${w}" height="${h}" fill="#141414"/>`;
    else bgRect = `<defs><pattern id="diag" width="40" height="40" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="40" height="40" fill="#f4f4f4"/><line x1="0" y1="0" x2="0" y2="40" stroke="#eaeaea" stroke-width="6"/></pattern></defs><rect width="${w}" height="${h}" fill="url(#diag)"/>`;
  }
  // readability scrim (AI background पर ऊपर का नाम साफ़ दिखे)
  const scrim = p.scrim ? `<defs><linearGradient id="st" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#000" stop-opacity="0.55"/><stop offset="100%" stop-color="#000" stop-opacity="0"/></linearGradient></defs><rect x="0" y="0" width="${w}" height="${h * 0.22}" fill="url(#st)"/>` : "";
  return Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
  ${bgRect}
  ${scrim}
  <rect x="0" y="0" width="${w}" height="${h * 0.013}" fill="${b.accent}"/>
  <!-- गाड़ी का नाम (बड़ा, ऊपर-बाएँ; logo top-right अलग से लगता है) -->
  <text x="${w * 0.05}" y="${h * 0.105}" font-family="Noto Sans Devanagari,Mukta,sans-serif" font-size="${Math.round(w / 12)}" font-weight="800" fill="${p.textDark}">${esc(o.model || "")}</text>
  <rect x="${w * 0.05}" y="${h * 0.122}" width="${w * 0.30}" height="6" rx="3" fill="${b.accent}"/>
  <!-- ex-showroom price (3D बटन) -->
  ${btn3d(w * 0.05, h * 0.665, w * 0.42, h * 0.078, "एक्स-शोरूम", "₹" + esc(o.price || ""), "#141414", b.accent, "#fff", Math.round(w / 40), Math.round(w / 20))}
  <!-- offers (दाएँ, 3D बटन) -->
  <text x="${w * 0.52}" y="${h * 0.638}" font-family="Noto Sans Devanagari,Mukta,sans-serif" font-size="${Math.round(w / 34)}" font-weight="800" fill="${p.textDark}">लिमिटेड पीरियड ऑफर</text>
  ${o.downPayment ? btn3d(w * 0.52, h * 0.652, w * 0.43, h * 0.055, "डाउन पेमेंट", "₹" + esc(o.downPayment), "#141414", "#ffd400", "#b00018", Math.round(w / 46), Math.round(w / 28)) : ""}
  ${o.cashback ? btn3d(w * 0.52, h * 0.715, w * 0.43, h * 0.055, "कैशबैक", "₹" + esc(o.cashback), "#141414", b.accent, "#fff", Math.round(w / 46), Math.round(w / 28)) : ""}
  <!-- feature चिप-बटन + finance/bank चिप-बटन (सिर्फ़ चुने हुए, हर एक अलग रंग) -->
  ${feats.length ? chipRow(feats, h * 0.752, h * 0.036, w * 0.94, w) : ""}
  ${(o.banks && o.banks.length) ? `<text x="${w * 0.5}" y="${h * 0.80}" text-anchor="middle" font-family="Noto Sans Devanagari,Mukta,sans-serif" font-size="${Math.round(w / 52)}" font-weight="800" fill="#ffd400">कम ब्याज पर फाइनेंस सुविधा उपलब्ध</text>${chipRow(o.banks, h * 0.808, h * 0.030, w * 0.94, w)}` : ""}
  <!-- आकर्षक address बटन -->
  ${addrBar(b, w, h)}
  <text x="${w * 0.97}" y="${h * 0.84}" text-anchor="end" font-family="Mukta,sans-serif" font-size="${Math.round(w / 60)}" fill="#999">AI Generated</text>
  ${offerSeal(o, w, h)}
  ${decorSVG(o.decor, w, h, w * 0.04, [[0.06, 0.20], [0.94, 0.20], [0.06, 0.42], [0.94, 0.42]])}
  ${o.autoDecor ? autoDecorLayer(o.autoSeed || o.model || "", { cashback: o.cashback, downPayment: o.downPayment }, w, h) : ""}
  </svg>`);
}
// Pollinations AI से background (free, बिना key) — fail होने पर null
async function fetchAIBackground(brandId, o, w, h) {
  const b = BRANDS[brandId];
  const base = (o.aiPrompt && o.aiPrompt.trim()) ? o.aiPrompt.trim()
    : "premium automobile showroom backdrop, soft studio lighting, clean floor, bokeh lights";
  const prompt = `${base}, empty centre for product, no text, no people, no vehicle, photorealistic, 4k`;
  const url = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${w}&height=${h}&nologo=true&seed=${Math.floor(Math.random() * 99999)}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error("status " + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    return await sharp(buf).resize(w, h, { fit: "cover" }).modulate({ brightness: 0.9 }).png().toBuffer();
  } catch (e) { log("ERROR", "AI bg fail → fallback", { msg: e.message }); return null; }
}
// सफ़ेद/हल्का background अपने-आप transparent (catalog फोटो के लिए)
async function removeWhiteBg(srcPath, rw, rh) {
  const img = sharp(srcPath).resize(rw, rh, { fit: "inside", withoutEnlargement: true }).ensureAlpha();
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  const ch = info.channels;
  for (let i = 0; i < data.length; i += ch) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    if (r > 236 && g > 236 && b > 236) data[i + 3] = 0;                          // near-white → clear
    else if (r > 215 && g > 215 && b > 215) data[i + 3] = Math.min(data[i + 3], 80); // soft edge
  }
  return await sharp(data, { raw: { width: info.width, height: info.height, channels: ch } }).png().toBuffer();
}
async function generatePromoImages(brandId, id, o, photoPath) {
  const b = BRANDS[brandId];
  const sizes = { square: [1080, 1080], story: [1080, 1920] };
  const out = {};
  for (const [k, [w, h]] of Object.entries(sizes)) {
    const overlay = await sharp(buildPromoSVG(brandId, o, w, h)).png().toBuffer();
    // base: AI background (bg=ai) या पूरा SVG (बाक़ी)
    let frame;
    if (o.bg === "ai") {
      const aibg = await fetchAIBackground(brandId, o, w, h);
      frame = aibg || await sharp(Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${b.accent}"/><stop offset="100%" stop-color="${b.accent2}"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#g)"/></svg>`)).png().toBuffer();
    } else {
      frame = overlay; // पूरा SVG (bg + graphics)
    }
    // गाड़ी की फोटो — बड़ी, beech में (cutout से सफ़ेद हटता है)
    let veh = null;
    try {
      if (o.cutout === false) veh = await sharp(photoPath).resize(Math.round(w * 0.86), Math.round(h * 0.46), { fit: "inside" }).png().toBuffer();
      else veh = await removeWhiteBg(photoPath, Math.round(w * 0.86), Math.round(h * 0.46));
    } catch (_) {}
    if (veh) {
      const meta = await sharp(veh).metadata();
      const vw = meta.width || Math.round(w * 0.86), vh = meta.height || Math.round(h * 0.46);
      const top = Math.round(h * 0.17), left = Math.round((w - vw) / 2);
      const shW = Math.round(vw * 0.82), shH = Math.max(18, Math.round(vh * 0.12));
      const shadow = await sharp(Buffer.from(`<svg width="${shW}" height="${shH}"><ellipse cx="${shW / 2}" cy="${shH / 2}" rx="${shW / 2}" ry="${shH / 2}" fill="#000" fill-opacity="0.25"/></svg>`)).blur(12).png().toBuffer();
      frame = await sharp(frame).composite([
        { input: shadow, top: top + vh - Math.round(shH * 0.6), left: Math.round((w - shW) / 2) },
        { input: veh, top, left },
      ]).png().toBuffer();
    }
    // AI bg पर graphics गाड़ी के ऊपर लगाएँ
    if (o.bg === "ai") frame = await sharp(frame).composite([{ input: overlay }]).png().toBuffer();
    // logo top-right (साफ़ किया हुआ)
    const logo = await loadLogo(brandId, Math.round(w * 0.13));
    if (logo) frame = await sharp(frame).composite([{ input: logo, top: Math.round(h * 0.02), left: Math.round(w * 0.84) }]).png().toBuffer();
    const f = `${id}_${k}.png`;
    await sharp(frame).toFile(path.join(OUT_DIR, f));
    out[k] = `/generated/${f}`;
  }
  const fL = `${id}_landscape.png`;
  await sharp(path.join(OUT_DIR, `${id}_square.png`)).resize(1200, 630, { fit: "contain", background: { r: 242, g: 242, b: 242 } }).png().toFile(path.join(OUT_DIR, fL));
  out.landscape = `/generated/${fL}`;
  return out;
}
// VIDEO (content quote → 9:16) + DELIVERY (multi-slide)
// ===========================================================================
function ffmpegOk() { return new Promise((r) => execFile("ffmpeg", ["-version"], (e) => r(!e))); }
async function generateVideo(id, musicFile) {
  if (!ENABLE_VIDEO) throw new Error("video disabled");
  if (!(await ffmpegOk())) throw new Error("ffmpeg not installed");
  const img = path.join(OUT_DIR, `${id}_story.png`);
  if (!fs.existsSync(img)) throw new Error("story image missing");
  const out = path.join(OUT_DIR, `${id}_video.mp4`);
  const vf = "scale=1080:1920,zoompan=z='min(zoom+0.0012,1.15)':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1080x1920:fps=25,fade=in:0:20,fade=out:355:20";
  const args = ["-y", "-loop", "1", "-i", img];
  if (musicFile) args.push("-i", musicFile);
  args.push("-t", "15", "-r", "25", "-vf", vf, "-c:v", "libx264", "-pix_fmt", "yuv420p");
  if (musicFile) args.push("-c:a", "aac", "-shortest");
  args.push(out);
  await new Promise((res, rej) => execFile("ffmpeg", args, (e, _o, se) => (e ? rej(new Error("ffmpeg: " + (se || e.message).slice(0, 200))) : res())));
  return `/generated/${id}_video.mp4`;
}
function delivSlideSVG(brandId, inner, bg) {
  const b = BRANDS[brandId];
  const back = (bg && bg !== "auto") ? readyBgSvg(bg, 1080, 1920) : `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0%" stop-color="${b.accent}"/><stop offset="100%" stop-color="${b.accent2}"/></linearGradient></defs><rect width="1080" height="1920" fill="url(#g)"/>`;
  return Buffer.from(`<svg width="1080" height="1920" xmlns="http://www.w3.org/2000/svg">${back}${inner}${addrBar(b, 1080, 1920)}</svg>`);
}
function dtext(x, y, s, t, w = "700") { return `<text x="${x}" y="${y}" text-anchor="middle" font-family="Noto Sans Devanagari,Mukta,sans-serif" font-size="${s}" font-weight="${w}" fill="#fff">${esc(t)}</text>`; }
async function buildDeliverySlides(brandId, id, d, photoPath, bg) {
  const b = BRANDS[brandId];
  const bigLogo = await loadLogo(brandId, 360);
  // 1) intro — बड़ा logo + New Delivery
  let s1 = await sharp(delivSlideSVG(brandId, dtext(540, 1180, 84, "New Delivery 🎉"), bg)).png().toBuffer();
  if (bigLogo) s1 = await sharp(s1).composite([{ input: bigLogo, top: 620, left: 360 }]).png().toBuffer();
  await sharp(s1).toFile(path.join(OUT_DIR, `${id}_s1.png`));
  // 2) main — customer photo + congrats
  const base = sharp(delivSlideSVG(brandId, dtext(540, 300, 64, "Congratulations") + dtext(540, 390, 76, d.customerName || "") + dtext(540, 1480, 56, d.bikeName || ""), bg));
  let photoBuf;
  try { photoBuf = await sharp(photoPath).resize(800, 800, { fit: "cover" }).png().toBuffer(); }
  catch (_) { photoBuf = await sharp({ create: { width: 800, height: 800, channels: 3, background: "#222" } }).png().toBuffer(); }
  const smallLogo = await loadLogo(brandId, 150);
  const mainParts = [{ input: photoBuf, top: 520, left: 140 }];
  if (smallLogo) mainParts.push({ input: smallLogo, top: 40, left: 40 });
  await base.composite(mainParts).png().toFile(path.join(OUT_DIR, `${id}_s2.png`));
  await sharp(path.join(OUT_DIR, `${id}_s2.png`)).resize(1080, 1080, { fit: "cover", position: "top" }).png().toFile(path.join(OUT_DIR, `${id}_square.png`));
  await sharp(path.join(OUT_DIR, `${id}_s2.png`)).resize(1200, 630, { fit: "cover" }).png().toFile(path.join(OUT_DIR, `${id}_landscape.png`));
  // 3) offer
  await sharp(delivSlideSVG(brandId, dtext(540, 900, 80, d.offer || "विशेष ऑफर 🎁") + dtext(540, 1020, 60, "सीमित समय के लिए"), bg)).png().toFile(path.join(OUT_DIR, `${id}_s3.png`));
  // 4) outro — logo + call now
  let s4 = await sharp(delivSlideSVG(brandId, dtext(540, 1180, 68, "कॉल करें") + dtext(540, 1290, 88, b.phone), bg)).png().toBuffer();
  if (bigLogo) s4 = await sharp(s4).composite([{ input: bigLogo, top: 560, left: 360 }]).png().toBuffer();
  await sharp(s4).toFile(path.join(OUT_DIR, `${id}_s4.png`));
}
function clipFromImage(img, dur, out) {
  const fo = dur * 25 - 12;
  return new Promise((res, rej) => execFile("ffmpeg", ["-y", "-loop", "1", "-i", img, "-t", String(dur), "-r", "25", "-vf", `scale=1080:1920,fade=in:0:12,fade=out:${fo}:12`, "-c:v", "libx264", "-pix_fmt", "yuv420p", out], (e, _o, se) => (e ? rej(new Error("clip: " + (se || e.message).slice(0, 150))) : res())));
}
async function generateDeliveryVideo(id, musicFile) {
  if (!ENABLE_VIDEO) throw new Error("video disabled");
  if (!(await ffmpegOk())) throw new Error("ffmpeg not installed");
  const durs = [2, 5, 3, 3], clips = [];
  for (let i = 0; i < 4; i++) { const o = path.join(OUT_DIR, `${id}_c${i}.mp4`); await clipFromImage(path.join(OUT_DIR, `${id}_s${i + 1}.png`), durs[i], o); clips.push(o); }
  const listFile = path.join(OUT_DIR, `${id}_list.txt`);
  fs.writeFileSync(listFile, clips.map((c) => `file '${c}'`).join("\n"));
  const out = path.join(OUT_DIR, `${id}_video.mp4`);
  const args = ["-y", "-f", "concat", "-safe", "0", "-i", listFile];
  if (musicFile) args.push("-i", musicFile);
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p");
  if (musicFile) args.push("-c:a", "aac", "-shortest");
  args.push(out);
  await new Promise((res, rej) => execFile("ffmpeg", args, (e, _o, se) => (e ? rej(new Error("concat: " + (se || e.message).slice(0, 150))) : res())));
  clips.forEach((c) => { try { fs.unlinkSync(c); } catch (_) {} });
  try { fs.unlinkSync(listFile); } catch (_) {}
  return `/generated/${id}_video.mp4`;
}
async function deliveryCaption(brandId, d) {
  const b = BRANDS[brandId];
  return `🎉 नई शुरुआत, नया सफर!\n\n${d.customerName || "ग्राहक"} जी को ${d.bikeName || "नई गाड़ी"} की हार्दिक बधाई 🚀\nआपका हर सफर सुरक्षित और शानदार हो!\n\n📍 ${b.place}\n📞 ${b.phone}`;
}

// ===========================================================================
// PUBLISHERS
// ===========================================================================
async function postFacebook(c, item) {
  if (!c.fbPageId || !c.fbToken) throw new Error("FB creds missing");
  const imgUrl = item.imgUrl ? `${process.env.PUBLIC_URL || "https://autosuvichar-backend.onrender.com"}${item.imgUrl}` : item.images?.square || item.images?.landscape;
  if (!imgUrl) throw new Error("FB: image URL नहीं मिला");
  // Step 1: पहले Page Access Token लो (User token से)
  const pageTokenR = await fetch(`${GRAPH}/${c.fbPageId}?fields=access_token&access_token=${c.fbToken}`);
  const pageTokenD = await pageTokenR.json();
  const pageToken = pageTokenD.access_token || c.fbToken; // fallback to user token
  // Step 2: /feed endpoint — publish_actions नहीं चाहिए, pages_manage_posts permission से काम करता है
  // पहले photo upload करो (link attach के साथ)
  const r = await fetch(`${GRAPH}/${c.fbPageId}/photos`, {
    method: "POST",
    body: new URLSearchParams({ url: imgUrl, caption: item.text, access_token: pageToken, published: "true" })
  });
  const d = await r.json();
  if (d.error) {
    log("ERROR", "FB photo post error", { err: d.error, imgUrl });
    // Fallback: /feed पर text+link post करो
    const r2 = await fetch(`${GRAPH}/${c.fbPageId}/feed`, {
      method: "POST",
      body: new URLSearchParams({ message: item.text, link: imgUrl, access_token: pageToken })
    });
    const d2 = await r2.json();
    if (d2.error) throw new Error("FB: " + d2.error.message);
    return d2.id;
  }
  return d.post_id || d.id;
}
async function postInstagram(c, item) {
  if (!c.igUserId || !c.fbToken) throw new Error("IG creds missing");
  const imgUrl = item.imgUrl ? `${process.env.PUBLIC_URL || "https://autosuvichar-backend.onrender.com"}${item.imgUrl}` : item.images?.square;
  if (!imgUrl) throw new Error("IG: image URL नहीं मिला");
  // Step 1: Instagram Business Account ID लो (igUserId Page ID हो सकता है)
  // पहले check करो कि यह IG account ID है या FB Page ID
  const igIdToUse = c.igUserId;
  // Media container बनाओ
  const cr = await (await fetch(`${GRAPH}/${igIdToUse}/media`, {
    method: "POST",
    body: new URLSearchParams({ image_url: imgUrl, caption: item.text, access_token: c.fbToken })
  })).json();
  if (cr.error) {
    log("ERROR", "IG container error", { err: cr.error, igIdToUse, imgUrl });
    throw new Error("IG container: " + cr.error.message);
  }
  // Publish करो
  const pub = await (await fetch(`${GRAPH}/${igIdToUse}/media_publish`, {
    method: "POST",
    body: new URLSearchParams({ creation_id: cr.id, access_token: c.fbToken })
  })).json();
  if (pub.error) throw new Error("IG publish: " + pub.error.message);
  return pub.id;
}
async function uploadYouTube(c, item) {
  if (!item.video) throw new Error("कोई video नहीं — पहले video बनाएँ");
  if (!c.ytRefreshToken) throw new Error("YT token missing");
  const { google } = require("googleapis");
  const oauth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, `${PUBLIC_URL}/api/oauth/google/callback`);
  oauth.setCredentials({ refresh_token: c.ytRefreshToken });
  const yt = google.youtube({ version: "v3", auth: oauth });
  const res = await yt.videos.insert({
    part: ["snippet", "status"],
    requestBody: { snippet: { title: (item.text.split("\n")[0] || "Post").slice(0, 90) + " #Shorts", description: item.text + "\n\n(AI Generated)", categoryId: "2" }, status: { privacyStatus: "public", selfDeclaredMadeForKids: false } },
    media: { body: fs.createReadStream(path.join(OUT_DIR, `${item._id}_video.mp4`)) },
  });
  return res.data.id;
}
async function sendWhatsApp(c, item) {
  if (!c.waPhoneId || !process.env.WA_TOKEN) throw new Error("WA creds missing");
  if (!c.waRecipients.length) throw new Error("कोई WA recipient नहीं");
  const out = [];
  for (const to of c.waRecipients) {
    const r = await fetch(`${GRAPH}/${c.waPhoneId}/messages`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.WA_TOKEN}` }, body: JSON.stringify({ messaging_product: "whatsapp", to, type: "image", image: { link: item.images.square, caption: item.text } }) });
    out.push(await r.json());
  }
  return out;
}
async function publish(item) {
  const c = brandCreds(item.brand);
  const chosen = Object.entries(item.platforms).filter(([, on]) => on).map(([k]) => k);
  const results = [];
  for (const ch of chosen) {
    try {
      if (TEST_MODE) { log("INFO", `[TEST] would post → ${ch}`, { brand: item.brand }); results.push({ platform: ch, ok: true, test: true }); continue; }
      let id;
      if (ch === "fb") id = await postFacebook(c, item);
      else if (ch === "ig") id = await postInstagram(c, item);
      else if (ch === "yt") id = await uploadYouTube(c, item);
      else if (ch === "wa") { await sendWhatsApp(c, item); id = "sent"; }
      results.push({ platform: ch, ok: true, id });
    } catch (e) { log("ERROR", `publish ${ch} failed`, { msg: e.message }); results.push({ platform: ch, ok: false, error: e.message }); }
  }
  return results;
}

// ===========================================================================
// Express + Auth
// ===========================================================================
const app = express();
app.use(cors());
app.use(express.json());
app.use("/generated", express.static(OUT_DIR));
// restart-safe: disk file न मिले तो DB के base64 से image serve करो
app.get("/api/image/:coll/:id/:kind", async (req, res) => {
  try {
    const { coll, id, kind } = req.params;
    const Model = coll === "delivery" ? Delivery : Content;
    const doc = await Model.findById(id).select("imageData images");
    if (!doc) return res.status(404).end();
    const data = doc.imageData && doc.imageData[kind === "story" ? "story" : "square"];
    if (data && data.startsWith("data:")) {
      const b64 = data.split(",")[1];
      res.set("Content-Type", "image/png");
      return res.send(Buffer.from(b64, "base64"));
    }
    // fallback: disk path अगर अभी मौजूद है
    const p = doc.images && doc.images[kind === "story" ? "story" : "square"];
    if (p) return res.redirect(p);
    res.status(404).end();
  } catch (e) { res.status(500).json({ error: e.message }); }
});

function sign(u) { return jwt.sign({ id: String(u._id), role: u.role, name: u.name }, JWT_SECRET, { expiresIn: "7d" }); }

// Public paths (बाक़ी सब login-protected)
const PUBLIC = [/^\/generated\//, /^\/api\/health$/, /^\/api\/auth\/login$/, /^\/api\/festivals$/, /^\/api\/designs$/, /^\/api\/image\//, /^\/api\/lead$/, /^\/api\/whatsapp\/webhook$/, /^\/api\/oauth\/google\/callback$/, /^\/api\/ig-account-id$/];
app.use((req, res, next) => {
  if (req.method === "OPTIONS") return next();
  if (PUBLIC.some((rx) => rx.test(req.path)) || !req.path.startsWith("/api/")) return next();
  try { req.user = jwt.verify((req.headers.authorization || "").replace("Bearer ", ""), JWT_SECRET); next(); }
  catch (e) { res.status(401).json({ error: "unauthorized — login करें" }); }
});
const requireRole = (...roles) => (req, res, next) => roles.includes(req.user.role) ? next() : res.status(403).json({ error: "इस काम की अनुमति नहीं" });

app.get("/api/health", (req, res) => res.json({ ok: true, version: "v41-publish-fix2", testMode: TEST_MODE, video: ENABLE_VIDEO, cron: ENABLE_CRON ? CRON_SCHEDULE : false, brands: Object.keys(BRANDS), aiImageKey: !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY), aiTextKey: !!process.env.OPENAI_API_KEY }));

// ---- Auth ----
app.post("/api/auth/login", async (req, res) => {
  try {
    const u = await User.findOne({ email: (req.body.email || "").toLowerCase() });
    if (!u || !(await bcrypt.compare(req.body.password || "", u.passwordHash))) return res.status(401).json({ error: "ग़लत email/password" });
    res.json({ token: sign(u), user: { name: u.name, email: u.email, role: u.role, brand: u.brand } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/auth/me", (req, res) => res.json(req.user));
app.post("/api/auth/register", requireRole("super-admin", "admin"), async (req, res) => {
  try {
    const { name, email, password, role, brand } = req.body;
    if (!email || !password) return res.status(400).json({ error: "email व password चाहिए" });
    const passwordHash = await bcrypt.hash(password, 10);
    const u = await User.create({ name, email: email.toLowerCase(), passwordHash, role: role || "salesman", brand });
    res.json({ id: u._id, email: u.email, role: u.role });
  } catch (e) { res.status(500).json({ error: e.code === 11000 ? "यह email पहले से है" : e.message }); }
});
app.get("/api/users", requireRole("super-admin", "admin"), async (req, res) => {
  res.json(await User.find({}, "name email role brand createdAt").sort({ createdAt: -1 }));
});

// ---- Brands / Settings ----
app.get("/api/brands", (req, res) => res.json(BRANDS));
app.get("/api/settings", requireRole("super-admin", "admin"), async (req, res) => {
  const out = {};
  for (const id of Object.keys(BRANDS)) {
    const c = brandCreds(id);
    out[id] = { // tokens masked
      fbPageId: c.fbPageId || "", fbToken: c.fbToken ? "••••set" : "", igUserId: c.igUserId || "",
      ytRefreshToken: c.ytRefreshToken ? "••••set" : "", waPhoneId: c.waPhoneId || "", waRecipients: c.waRecipients,
    };
  }
  res.json(out);
});
app.put("/api/settings/:brand", requireRole("super-admin", "admin"), async (req, res) => {
  try {
    if (!BRANDS[req.params.brand]) return res.status(400).json({ error: "invalid brand" });
    const existing = (await Setting.findOne({ brand: req.params.brand }))?.creds || {};
    const creds = { ...existing };
    ["fbPageId", "fbToken", "igUserId", "ytRefreshToken", "waPhoneId", "waRecipients"].forEach((k) => {
      if (req.body[k] !== undefined && req.body[k] !== "••••set") creds[k] = req.body[k];
    });
    await Setting.findOneAndUpdate({ brand: req.params.brand }, { creds }, { upsert: true });
    await loadSettings();
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- YouTube OAuth (UI से connect) ----
app.get("/api/oauth/google", requireRole("super-admin", "admin"), (req, res) => {
  try {
    const { google } = require("googleapis");
    const oauth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, `${PUBLIC_URL}/api/oauth/google/callback`);
    const url = oauth.generateAuthUrl({ access_type: "offline", prompt: "consent", scope: ["https://www.googleapis.com/auth/youtube.upload"], state: req.query.brand });
    res.json({ url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/oauth/google/callback", async (req, res) => {
  try {
    const { google } = require("googleapis");
    const oauth = new google.auth.OAuth2(process.env.GOOGLE_CLIENT_ID, process.env.GOOGLE_CLIENT_SECRET, `${PUBLIC_URL}/api/oauth/google/callback`);
    const { tokens } = await oauth.getToken(req.query.code);
    const brand = req.query.state;
    if (tokens.refresh_token && BRANDS[brand]) {
      const existing = (await Setting.findOne({ brand }))?.creds || {};
      await Setting.findOneAndUpdate({ brand }, { creds: { ...existing, ytRefreshToken: tokens.refresh_token } }, { upsert: true });
      await loadSettings();
    }
    res.send("<h2>YouTube connect हो गया ✅ — यह tab बंद कर दें।</h2>");
  } catch (e) { res.status(500).send("OAuth error: " + e.message); }
});

// ---- AI tools for the app (background image + caption text) ----
// Google से पूछो कौन-से image-model इस key पर उपलब्ध हैं
async function listGeminiImageModels(key) {
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}&pageSize=1000`, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return [];
    const j = await res.json();
    return (j.models || []).filter((m) => /image/i.test(m.name) && !/embedding|imagen/i.test(m.name) && (m.supportedGenerationMethods || []).includes("generateContent")).map((m) => m.name.replace(/^models\//, ""));
  } catch (e) { return []; }
}
// Gemini image (FREE, बिना billing) — उपलब्ध model खुद ढूँढकर
async function fetchGeminiImage(prompt, w, h) {
  const key = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!key) return { buf: null, error: "no-key" };
  const discovered = await listGeminiImageModels(key);
  const models = [...new Set([...discovered, "gemini-2.5-flash-image", "gemini-2.5-flash-image-preview", "gemini-3-pro-image-preview"])];
  const errs = [];
  for (const m of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${key}`;
      const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ["TEXT", "IMAGE"] } }), signal: AbortSignal.timeout(60000) });
      const raw = await res.text();
      if (!res.ok) { errs.push(`${m}:${res.status}`); continue; }
      const j = JSON.parse(raw);
      const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
      const img = parts.find((p) => p.inlineData && p.inlineData.data);
      if (!img) { errs.push(`${m}:no-img`); continue; }
      return { buf: await sharp(Buffer.from(img.inlineData.data, "base64")).resize(w, h, { fit: "cover" }).png().toBuffer(), error: null, model: m };
    } catch (e) { errs.push(`${m}:${(e.message || "").slice(0, 40)}`); }
  }
  return { buf: null, error: (discovered.length ? "उपलब्ध: " + discovered.join(",") + " | " : "कोई image-model नहीं | ") + errs.join("; ") };
}
app.post("/api/ai-bg", async (req, res) => {
  try {
    const w = Math.min(parseInt(req.body.w, 10) || 1080, 1080), h = Math.min(parseInt(req.body.h, 10) || 1080, 1080);
    const prompt = (req.body.prompt || "premium automobile showroom backdrop, clean studio lighting, empty centre") + ", no text, no watermark, photorealistic, 4k";
    const g = await fetchGeminiImage(prompt, w, h);          // असली AI (key हो तो)
    if (g.buf) return res.json({ dataUrl: "data:image/png;base64," + g.buf.toString("base64"), source: "gemini" });
    const pol = await fetchAIBackground(req.body.brand || "vp_honda", { aiPrompt: req.body.prompt || "" }, w, h); // free fallback
    if (pol) return res.json({ dataUrl: "data:image/png;base64," + pol.toString("base64"), source: "pollinations", note: g.error || "" });
    const is429 = (g.error || "").includes("429");
    const msg = g.error === "no-key"
      ? "Render env में GEMINI_API_KEY नहीं मिली — नाम बिल्कुल GEMINI_API_KEY रखें व redeploy करें"
      : is429
        ? "Google मुफ़्त में AI-image नहीं दे रहा (429 = quota शून्य)। AI-image के लिए Google account में billing चालू करनी होगी (pay-per-use, बहुत सस्ता)। बाकी सब features चलते हैं।"
        : "Google AI image नहीं बनी — " + (g.error || "अज्ञात");
    return res.status(502).json({ error: msg });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/ai-text", async (req, res) => {
  try {
    const { brand, type } = req.body;
    if (!BRANDS[brand]) return res.status(400).json({ error: "invalid brand" });
    const fe = req.body.festival ? FEST_BY_NAME(req.body.festival) : null;
    const text = await generateText(brand, TYPES.includes(type) ? type : "vigyapan", fe ? fe.name : undefined);
    res.json({ text });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
// ---- Content ----
app.get("/api/festivals", (req, res) => {
  const today = new Date().toISOString().slice(0, 10);
  const upcoming = FESTIVALS.filter((f) => f.date >= today).sort((a, b) => a.date.localeCompare(b.date))[0];
  res.json({ festivals: FESTIVALS.map((f) => ({ name: f.name, date: f.date, color: f.color })), upcoming: upcoming ? upcoming.name : (FESTIVALS[0] && FESTIVALS[0].name) });
});
// Instagram Business Account ID helper — Settings में सही ID दिखाए
app.get("/api/ig-account-id", requireRole("super-admin", "admin"), async (req, res) => {
  try {
    const { pageId, token, useSaved, brand } = req.query;
    if (!pageId) return res.status(400).json({ error: "pageId चाहिए" });
    // token: query से या saved creds से
    let useToken = token;
    if (!useToken || useSaved === "1") {
      // brand guess करो pageId से
      const bId = Object.keys(BRANDS).find((k) => brandCreds(k).fbPageId === pageId) || Object.keys(BRANDS)[0];
      useToken = brandCreds(bId).fbToken;
    }
    if (!useToken) return res.status(400).json({ error: "FB Token नहीं मिला — Settings में FB Token save करें" });
    const r = await fetch(`${GRAPH}/${pageId}?fields=instagram_business_account&access_token=${useToken}`);
    const d = await r.json();
    if (d.error) return res.status(400).json({ found: false, msg: d.error.message });
    const igId = d.instagram_business_account?.id;
    if (!igId) return res.json({ found: false, msg: "इस Page से कोई Instagram Business Account linked नहीं है। Meta Business Suite में connect करें।" });
    res.json({ found: true, igId, msg: `Instagram Business Account ID: ${igId}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/designs", (req, res) => res.json({ designs: DESIGN_STYLES }));

// Settings debug — MongoDB में क्या saved है check करो
app.get("/api/debug/settings", requireRole("super-admin", "admin"), async (req, res) => {
  try {
    await loadSettings();
    const dbDocs = await Setting.find().lean();
    const out = {};
    Object.keys(BRANDS).forEach((id) => {
      const c = brandCreds(id);
      out[id] = { hasFbPageId: !!c.fbPageId, hasFbToken: !!c.fbToken, hasIgUserId: !!c.igUserId, hasWaPhoneId: !!c.waPhoneId, waRecipients: c.waRecipients, dbDoc: dbDocs.find(d => d.brand === id) ? "found in DB" : "NOT IN DB", cacheKeys: Object.keys(SETTINGS_CACHE[id] || {}) };
    });
    res.json({ resolved: out, dbDocs: dbDocs.map(d => ({ brand: d.brand, keys: Object.keys(d.creds || {}) })) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/generate", async (req, res) => {
  try {
    const { brand, type } = req.body;
    if (!BRANDS[brand] || !TYPES.includes(type)) return res.status(400).json({ error: "invalid brand/type" });
    const fe = (type === "festival" && req.body.festival) ? FEST_BY_NAME(req.body.festival) : null;
    const customText = (req.body.customText || "").trim();
    const cleanText = customText ? cleanAIText(customText) : await generateText(brand, type, fe ? fe.name : undefined);
    const tags = (req.body.tags || "").trim();
    const opts = { sticker: req.body.sticker || "", offer: req.body.offer || "", decor: req.body.decor || "", bg: req.body.bg || "auto", design: req.body.design || "auto", autoDecor: req.body.autoDecor === true || req.body.autoDecor === "true", autoSeed: req.body.autoSeed || "", themeColor: fe ? fe.color : undefined, themeColor2: fe ? fe.color2 : undefined };
    const doc = await Content.create({ brand, type, text: cleanText + (tags ? `\n${tags}` : ""), status: "pending" });
    const imgs = await generateImages(brand, doc._id, cleanText, type, opts);
    const b64 = imgs._b64 || {}; delete imgs._b64;
    doc.images = imgs;
    if (b64.square) doc.imageData = { square: b64.square, story: b64.story };
    await doc.save(); res.json(doc);
  } catch (e) { log("ERROR", "/generate", { msg: e.message }); res.status(500).json({ error: e.message }); }
});
app.delete("/api/content/:id", requireRole("super-admin", "admin", "manager"), async (req, res) => {
  try { await Content.findByIdAndDelete(req.params.id); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.delete("/api/delivery/:id", requireRole("super-admin", "admin", "manager"), async (req, res) => {
  try { await Delivery.findByIdAndDelete(req.params.id); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/content", async (req, res) => {
  try { const q = {}; if (req.query.brand) q.brand = req.query.brand; if (req.query.status) q.status = req.query.status;
    const docs = await Content.find(q).select("-imageData").sort({ createdAt: -1 }).limit(20).allowDiskUse(true).lean();
    // हर post को restart-safe image URL दो (DB से serve होगा, disk मिटे तो भी चले)
    docs.forEach((d) => { const hasImg = d.images && (d.images.square || d.images.story); if (hasImg) { d.imgUrl = `/api/image/content/${d._id}/square`; d.imgUrlStory = `/api/image/content/${d._id}/story`; } });
    res.json(docs); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.patch("/api/content/:id", async (req, res) => {
  try {
    const doc = await Content.findById(req.params.id); if (!doc) return res.status(404).json({ error: "not found" });
    if (typeof req.body.text === "string") doc.text = req.body.text;
    if (req.body.platforms) doc.platforms = { ...doc.platforms, ...req.body.platforms };
    if (typeof req.body.text === "string") doc.images = await generateImages(doc.brand, doc._id, doc.text, doc.type);
    await doc.save(); res.json(doc);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/content/:id/video", async (req, res) => {
  try {
    const doc = await Content.findById(req.params.id); if (!doc) return res.status(404).json({ error: "not found" });
    const mf = req.body.music ? path.join(MUSIC_DIR, path.basename(req.body.music)) : null;
    if (mf && !fs.existsSync(mf)) return res.status(400).json({ error: "music not found" });
    doc.video = await generateVideo(doc._id, mf); doc.music_used = req.body.music || null; doc.post_type = "video";
    await doc.save(); res.json(doc);
  } catch (e) { log("ERROR", "/video", { msg: e.message }); res.status(500).json({ error: e.message }); }
});
app.post("/api/content/:id/approve", requireRole("super-admin", "admin", "manager"), async (req, res) => {
  try {
    const doc = await Content.findById(req.params.id); if (!doc) return res.status(404).json({ error: "not found" });
    if (doc.status !== "pending") return res.status(400).json({ error: `already ${doc.status}` });
    // restart-safe image URL — disk file न मिले तो DB से serve होगा
    if (doc.images && (doc.images.square || doc.images.landscape)) {
      doc.imgUrl = `/api/image/content/${doc._id}/square`;
      doc.imgUrlLandscape = `/api/image/content/${doc._id}/landscape`;
    }
    const results = await publish(doc); const ok = results.filter((r) => r.ok).map((r) => r.platform);
    doc.results = results; doc.channels = ok; doc.status = ok.length ? "sent" : "failed"; doc.sentAt = new Date();
    await doc.save();
    if (doc.status === "failed") {
      const errDetail = results.filter(r => !r.ok).map(r => `${r.platform}: ${r.error}`).join(", ");
      notify("post_failed", `${BRANDS[doc.brand].name}: पोस्ट fail हुई — ${errDetail}`, doc.brand);
    }
    res.json(doc);
  } catch (e) { log("ERROR", "/approve", { msg: e.message }); res.status(500).json({ error: e.message }); }
});
// सहेजा हुआ poster दोबारा भेजें (वही image फिर से publish)
app.post("/api/content/:id/resend", requireRole("super-admin", "admin", "manager"), async (req, res) => {
  try {
    const doc = await Content.findById(req.params.id); if (!doc) return res.status(404).json({ error: "not found" });
    const results = await publish(doc); const ok = results.filter((r) => r.ok).map((r) => r.platform);
    doc.results = results; doc.channels = ok; doc.status = ok.length ? "sent" : "failed"; doc.sentAt = new Date();
    await doc.save();
    res.json(doc);
  } catch (e) { log("ERROR", "/resend", { msg: e.message }); res.status(500).json({ error: e.message }); }
});
app.post("/api/content/:id/reject", async (req, res) => {
  try { const doc = await Content.findByIdAndUpdate(req.params.id, { status: "rejected" }, { new: true }); if (!doc) return res.status(404).json({ error: "not found" }); res.json(doc); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Music ----
app.get("/api/music", (req, res) => res.json(fs.readdirSync(MUSIC_DIR).filter((f) => /\.(mp3|m4a|wav)$/i.test(f))));
const musicUpload = multer({ storage: multer.diskStorage({ destination: MUSIC_DIR, filename: (req, f, cb) => cb(null, f.originalname) }), limits: { fileSize: 15 * 1024 * 1024 } });
app.post("/api/music/upload", musicUpload.single("file"), (req, res) => req.file ? res.json({ ok: true, file: req.file.originalname }) : res.status(400).json({ error: "no file" }));

// ---- Delivery ----
const photoUpload = multer({ storage: multer.diskStorage({ destination: UPLOAD_DIR, filename: (req, f, cb) => cb(null, Date.now() + "_" + f.originalname.replace(/\s+/g, "_")) }), limits: { fileSize: 12 * 1024 * 1024 } });
app.post("/api/delivery", photoUpload.single("photo"), async (req, res) => {
  try {
    const { brand, customerName, bikeName, offer, music, bg } = req.body;
    if (!BRANDS[brand]) return res.status(400).json({ error: "invalid brand" });
    const doc = await Delivery.create({ brand, customerName, bikeName, offer, photo: req.file?.filename, status: "pending" });
    await buildDeliverySlides(brand, doc._id, doc, req.file ? req.file.path : null, bg || "auto");
    doc.images = { square: `/generated/${doc._id}_square.png`, landscape: `/generated/${doc._id}_landscape.png` };
    doc.text = await deliveryCaption(brand, doc); await doc.save();
    // पहले तुरंत response दो (502 रोकने के लिए); video background में बनाओ
    res.json(doc);
    // background में video बनाओ — Render timeout/crash से बचाव
    setImmediate(async () => {
      try {
        let mf = null; if (music) { const m = path.join(MUSIC_DIR, path.basename(music)); if (fs.existsSync(m)) mf = m; }
        doc.video = await generateDeliveryVideo(doc._id, mf); doc.music_used = mf ? path.basename(mf) : null;
        await doc.save();
        notify("delivery", `${BRANDS[brand].name}: ${customerName || "ग्राहक"} की delivery video तैयार — review करें`, brand);
      } catch (e) { log("ERROR", "/delivery video bg", { msg: e.message }); }
    });
  } catch (e) { log("ERROR", "/delivery", { msg: e.message }); if (!res.headersSent) res.status(500).json({ error: e.message }); }
});

// गाड़ी वाला आकर्षक विज्ञापन (photo + price + offer) → pending (Content में)
app.post("/api/promo", photoUpload.single("photo"), async (req, res) => {
  try {
    const { brand, model: vmodel, price, downPayment, cashback, bg, vehicle, aiPrompt, offer, sticker } = req.body;
    if (!BRANDS[brand]) return res.status(400).json({ error: "invalid brand" });
    const features = (req.body.features || "").split(",").map((s) => s.trim()).filter(Boolean);
    const banks = (req.body.banks || "").split(",").map((s) => s.trim()).filter(Boolean);
    const tags = (req.body.tags || "").trim();
    // गाड़ी की फोटो: या तो अभी upload हुई, या library से चुनी गई
    let photoPath = req.file ? req.file.path : null;
    if (!photoPath && vehicle) {
      const vp = path.join(VEHICLE_DIR, brand, path.basename(vehicle));
      if (fs.existsSync(vp)) photoPath = vp;
    }
    const layout = req.body.layout || "standard";
    const o = { model: vmodel, price, downPayment, cashback, tagline: req.body.tagline || "", features, banks, bg: bg || "light", cutout: req.body.cutout !== "false", aiPrompt: aiPrompt || "", offer: offer || "", sticker: sticker || "", decor: req.body.decor || "", autoDecor: req.body.autoDecor === true || req.body.autoDecor === "true", autoSeed: req.body.autoSeed || "", photo: req.file?.filename || vehicle };
    const promoSVGFn = (brand, opts, w, h) => layout === "honda_official" ? buildHondaOfficialSVG(brand, opts, w, h) : buildPromoSVG(brand, opts, w, h);
    const initText = `${vmodel || ""} अब ${BRANDS[brand].place} पर! 📞 ${BRANDS[brand].phone}` + (tags ? `\n${tags}` : "");
    const doc = await Content.create({ brand, type: "vigyapan", post_type: "photo", text: initText, status: "pending", promo: o });
    doc.images = await generatePromoImages(brand, doc._id, o, photoPath);
    const b = BRANDS[brand];
    doc.text = `${vmodel || ""} अब ${b.place} पर!\nएक्स-शोरूम ₹${price || ""}` +
      (downPayment ? ` • डाउन ₹${downPayment}` : "") + (cashback ? ` • कैशबैक ₹${cashback}` : "") +
      `\n📞 ${b.phone}` + (tags ? `\n${tags}` : "");
    await doc.save();
    res.json(doc);
  } catch (e) { log("ERROR", "/promo", { msg: e.message }); res.status(500).json({ error: e.message }); }
});
// editor में बना/edit किया हुआ poster सीधे Review queue में (फिर FB/IG/WA post हो सकता है)
const outUpload = multer({ storage: multer.diskStorage({ destination: OUT_DIR, filename: (req, f, cb) => cb(null, Date.now() + "_" + f.fieldname + ".png") }), limits: { fileSize: 10 * 1024 * 1024 } });
app.post("/api/promo-image", outUpload.fields([{ name: "square", maxCount: 1 }, { name: "story", maxCount: 1 }]), async (req, res) => {
  try {
    const { brand } = req.body;
    if (!BRANDS[brand]) return res.status(400).json({ error: "invalid brand" });
    if (!req.files || !req.files.square) return res.status(400).json({ error: "image required" });
    const b = BRANDS[brand];
    const text = req.body.caption || `${req.body.model || ""} — ${b.name}\nफ़ोन ${b.phone} • ${b.place}`;
    const doc = await Content.create({ brand, type: "vigyapan", post_type: "photo", text, status: "pending" });
    const images = { square: `/generated/${path.basename(req.files.square[0].path)}` };
    if (req.files.story) images.story = `/generated/${path.basename(req.files.story[0].path)}`;
    doc.images = images;
    // base64 भी DB में — Render restart पर disk मिटे तो भी post + image बने रहें
    try {
      const sqBuf = fs.readFileSync(req.files.square[0].path);
      doc.imageData = { square: "data:image/png;base64," + sqBuf.toString("base64") };
      if (req.files.story) { const stBuf = fs.readFileSync(req.files.story[0].path); doc.imageData.story = "data:image/png;base64," + stBuf.toString("base64"); }
    } catch (e) { log("WARN", "imageData base64 save failed", { msg: e.message }); }
    await doc.save();
    res.json(doc);
  } catch (e) { log("ERROR", "/promo-image", { msg: e.message }); res.status(500).json({ error: e.message }); }
});
// गाड़ी library: एक बार upload, फिर dropdown से select
const vehUpload = multer({ storage: multer.diskStorage({
  destination: (req, f, cb) => { const d = path.join(VEHICLE_DIR, req.body.brand || "vp_honda"); fs.mkdirSync(d, { recursive: true }); cb(null, d); },
  filename: (req, f, cb) => cb(null, f.originalname.replace(/\s+/g, "_")),
}), limits: { fileSize: 12 * 1024 * 1024 } });
app.get("/api/vehicles", (req, res) => {
  const d = path.join(VEHICLE_DIR, req.query.brand || "vp_honda");
  try { res.json(fs.readdirSync(d).filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f))); }
  catch (_) { res.json([]); }
});
app.post("/api/vehicles/upload", vehUpload.single("photo"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "no file" });
  res.json({ ok: true, file: req.file.originalname.replace(/\s+/g, "_") });
});
app.get("/api/deliveries", async (req, res) => {
  try { const q = {}; if (req.query.brand) q.brand = req.query.brand; if (req.query.status) q.status = req.query.status;
    res.json(await Delivery.find(q).select("-imageData").sort({ createdAt: -1 }).limit(20).allowDiskUse(true).lean()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/delivery/:id/approve", requireRole("super-admin", "admin", "manager"), async (req, res) => {
  try {
    const doc = await Delivery.findById(req.params.id); if (!doc) return res.status(404).json({ error: "not found" });
    if (doc.status !== "pending") return res.status(400).json({ error: `already ${doc.status}` });
    const results = await publish(doc); const ok = results.filter((r) => r.ok).map((r) => r.platform);
    doc.results = results; doc.channels = ok; doc.status = ok.length ? "sent" : "failed"; doc.sentAt = new Date();
    await doc.save();
    if (doc.status === "failed") notify("post_failed", `${BRANDS[doc.brand].name}: delivery पोस्ट fail`, doc.brand);
    res.json(doc);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/delivery/:id/resend", requireRole("super-admin", "admin", "manager"), async (req, res) => {
  try {
    const doc = await Delivery.findById(req.params.id); if (!doc) return res.status(404).json({ error: "not found" });
    const results = await publish(doc); const ok = results.filter((r) => r.ok).map((r) => r.platform);
    doc.results = results; doc.channels = ok; doc.status = ok.length ? "sent" : "failed"; doc.sentAt = new Date();
    await doc.save();
    res.json(doc);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/delivery/:id/reject", async (req, res) => {
  try { const doc = await Delivery.findByIdAndUpdate(req.params.id, { status: "rejected" }, { new: true }); if (!doc) return res.status(404).json({ error: "not found" }); res.json(doc); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Leads / CRM ----
app.post("/api/lead", async (req, res) => { // PUBLIC — "Interested? Click here" form से
  try {
    const { brand, name, mobile, vehicleInterest, source } = req.body;
    if (!mobile) return res.status(400).json({ error: "mobile चाहिए" });
    const lead = await Lead.create({ brand, name, mobile, vehicleInterest, source: source || "post" });
    notify("lead", `नया lead: ${name || mobile} (${vehicleInterest || "—"})`, brand);
    res.json({ ok: true, id: lead._id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/leads", async (req, res) => {
  try { const q = {}; if (req.query.brand) q.brand = req.query.brand; if (req.query.status) q.status = req.query.status;
    res.json(await Lead.find(q).sort({ createdAt: -1 }).limit(200)); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.patch("/api/leads/:id", async (req, res) => {
  try { const u = {}; if (req.body.status) u.status = req.body.status; if (req.body.note !== undefined) u.note = req.body.note;
    res.json(await Lead.findByIdAndUpdate(req.params.id, u, { new: true })); } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Analytics (हमारे DB से; platform "views" के लिए Insights API बाद में) ----
app.get("/api/analytics", async (req, res) => {
  try {
    const brand = req.query.brand; const q = brand ? { brand } : {};
    const since = new Date(Date.now() - 7 * 864e5);
    const [contentSent, contentPending, deliveriesSent, deliveriesPending, leadsTotal, leadsNew] = await Promise.all([
      Content.countDocuments({ ...q, status: "sent" }), Content.countDocuments({ ...q, status: "pending" }),
      Delivery.countDocuments({ ...q, status: "sent" }), Delivery.countDocuments({ ...q, status: "pending" }),
      Lead.countDocuments(q), Lead.countDocuments({ ...q, status: "new" }),
    ]);
    const leadsByVehicle = await Lead.aggregate([{ $match: q }, { $group: { _id: "$vehicleInterest", n: { $sum: 1 } } }, { $sort: { n: -1 } }, { $limit: 8 }]);
    const postsLast7 = await Content.aggregate([{ $match: { ...q, status: "sent", sentAt: { $gte: since } } }, { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$sentAt" } }, n: { $sum: 1 } } }, { $sort: { _id: 1 } }]);
    res.json({ contentSent, contentPending, deliveriesSent, deliveriesPending, leadsTotal, leadsNew, leadsByVehicle, postsLast7, note: "Views/reach के असली आँकड़े platform Insights API से बाद में जुड़ेंगे।" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Notifications ----
app.get("/api/notifications", async (req, res) => {
  const items = await Notification.find().sort({ createdAt: -1 }).limit(30);
  res.json({ items, unread: await Notification.countDocuments({ read: false }) });
});
app.post("/api/notifications/read", async (req, res) => { await Notification.updateMany({ read: false }, { read: true }); res.json({ ok: true }); });

// ---- WhatsApp auto chat-bot (webhook) ----
function botReply(brandId, text) {
  const b = BRANDS[brandId]; const t = (text || "").toLowerCase();
  if (/price|कीमत|रेट|दाम|kitne|kitna/.test(t)) return `${b.name}: हमारे पास ${b.products.slice(0, 3).join(", ")} उपलब्ध हैं। कीमत व EMI के लिए 📞 ${b.phone}`;
  if (/mileage|माइलेज|average|range/.test(t)) return `बढ़िया माइलेज/रेंज! पूरी जानकारी के लिए 📞 ${b.phone} या ${b.place} पधारें 🙏`;
  if (/loan|emi|लोन|किस्त|finance|फाइनेंस/.test(t)) return `जी हाँ, आसान EMI/loan उपलब्ध है ✅ कागज़ात व ब्याज़ दर के लिए 📞 ${b.phone}`;
  return `नमस्ते 🙏 ${b.name} में स्वागत है। आप पूछ सकते हैं: price / mileage / loan — या सीधे कॉल करें 📞 ${b.phone}`;
}
app.get("/api/whatsapp/webhook", (req, res) => { // Meta verification
  if (req.query["hub.mode"] === "subscribe" && req.query["hub.verify_token"] === WA_VERIFY_TOKEN) return res.send(req.query["hub.challenge"]);
  res.sendStatus(403);
});
app.post("/api/whatsapp/webhook", async (req, res) => {
  res.sendStatus(200); // Meta को तुरंत 200
  try {
    const v = req.body?.entry?.[0]?.changes?.[0]?.value; const msg = v?.messages?.[0];
    if (!msg) return;
    const phoneId = v?.metadata?.phone_number_id;
    const brandId = Object.keys(BRANDS).find((id) => brandCreds(id).waPhoneId === phoneId) || "vp_honda";
    const reply = botReply(brandId, msg.text?.body);
    log("INFO", "WA bot reply", { brandId, from: msg.from });
    if (TEST_MODE || !process.env.WA_TOKEN) return;
    await fetch(`${GRAPH}/${phoneId}/messages`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.WA_TOKEN}` }, body: JSON.stringify({ messaging_product: "whatsapp", to: msg.from, type: "text", text: { body: reply } }) });
  } catch (e) { log("ERROR", "WA webhook", { msg: e.message }); }
});

// ===========================================================================
// CRON — रोज़ generate→pending + festival auto-mode (auto-post नहीं!)
// ===========================================================================
async function genToPending(brand, type, festivalName) {
  const text = await generateText(brand, type, festivalName);
  const doc = await Content.create({ brand, type, text, status: "pending" });
  doc.images = await generateImages(brand, doc._id, text, type); await doc.save();
  log("INFO", "cron → pending", { brand, type, id: String(doc._id) });
}
if (ENABLE_CRON) {
  cron.schedule(CRON_SCHEDULE, async () => {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // YYYY-MM-DD
    const fest = FESTIVALS.find((f) => f.date === today);
    log("INFO", "Cron run", { today, festival: fest?.name || null });
    for (const brand of Object.keys(BRANDS)) {
      try {
        if (fest) { await genToPending(brand, "festival", fest.name); }
        else { await genToPending(brand, "suvichar"); }
      } catch (e) { log("ERROR", "cron gen failed", { brand, msg: e.message }); }
    }
    if (fest) await notify("festival", `${fest.name}: तीनों brands की शुभकामना पोस्ट pending में — review करें`, null);
  }, { timezone: "Asia/Kolkata" });
}

// ===========================================================================
// Boot — admin seed + settings load
// ===========================================================================
(async () => {
  try { await mongoose.connect(MONGO_URI); log("INFO", "MongoDB connected"); }
  catch (e) { log("ERROR", "MongoDB failed", { msg: e.message }); process.exit(1); }
  await loadSettings();
  if ((await User.countDocuments()) === 0) {
    const email = (process.env.SEED_ADMIN_EMAIL || "admin@vphonda.com").toLowerCase();
    const pass = process.env.SEED_ADMIN_PASSWORD || "vphonda@123";
    await User.create({ name: "Admin", email, passwordHash: await bcrypt.hash(pass, 10), role: "super-admin" });
    log("INFO", `Seed admin बनाया: ${email} (password बदल लें!)`);
  }
  // आपातकालीन reset: Render env में RESET_ADMIN_PASS डालो → admin का password वही हो जाएगा (फिर env हटा दो)
  if (process.env.RESET_ADMIN_PASS) {
    const email = (process.env.SEED_ADMIN_EMAIL || "admin@vphonda.com").toLowerCase();
    await User.findOneAndUpdate({ email }, { name: "Admin", email, role: "super-admin", passwordHash: await bcrypt.hash(process.env.RESET_ADMIN_PASS, 10) }, { upsert: true });
    log("INFO", `Admin password RESET हुआ → इस EMAIL से login करें: ${email} (फिर RESET_ADMIN_PASS env हटा दें)`);
  }
  // मौजूद सभी logins की सूची (असली email पता करने के लिए)
  try {
    const all = await User.find({}, { email: 1, role: 1, _id: 0 }).lean();
    log("INFO", `मौजूद logins (${all.length}): ` + all.map((u) => `${u.email}[${u.role}]`).join(", "));
  } catch (_) {}
  app.listen(PORT, () => log("INFO", `AutoSuVichar backend on ${PUBLIC_URL} (TEST_MODE=${TEST_MODE})`));
})();
