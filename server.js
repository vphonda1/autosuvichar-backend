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
const { spawn } = require("child_process");
sharp.cache(false);
sharp.concurrency(1);

// ── Image Compression: Primary JPEG → Fallback PNG ──
async function compressImage(buf, maxKB = 400) {
  // Method 1: JPEG quality 82
  try {
    const j = await sharp(buf).jpeg({ quality: 82 }).toBuffer();
    if (j.length < maxKB * 1024) return { buf: j, ext: "jpg", mime: "image/jpeg" };
    // बड़ा है — quality 60 try करो
    const j2 = await sharp(buf).jpeg({ quality: 65 }).toBuffer();
    console.log(`[compress] JPEG q60 ${Math.round(j2.length/1024)}KB`);
    return { buf: j2, ext: "jpg", mime: "image/jpeg" };
  } catch (e) {
    console.log("[compress] JPEG fail →", e.message);
    // Method 2: PNG compressed fallback
    try {
      const p = await sharp(buf).png({ compressionLevel: 9 }).toBuffer();
      console.log(`[compress] PNG fallback ${Math.round(p.length/1024)}KB`);
      return { buf: p, ext: "png", mime: "image/png" };
    } catch (e2) {
      console.log("[compress] PNG fail →", e2.message);
      return { buf, ext: "png", mime: "image/png" }; // original as-is
    }
  }
}

// ── Video Compression: H.264 CRF28 → Copy fallback ──
function compressVideo(inPath, outPath) {
  return new Promise((resolve) => {
    // Method 1: libx264 re-encode (small size)
    const ff = spawn("ffmpeg", ["-y","-i",inPath,"-vcodec","libx264","-crf","28","-preset","fast","-movflags","+faststart","-acodec","aac","-b:a","96k",outPath]);
    ff.on("close", code => {
      if (code === 0) { console.log("[compress-video] H.264 ok"); resolve(true); return; }
      console.log("[compress-video] H.264 fail → copy fallback");
      // Method 2: stream copy (no re-encode)
      const ff2 = spawn("ffmpeg", ["-y","-i",inPath,"-c","copy",outPath]);
      ff2.on("close", c2 => { console.log("[compress-video] copy", c2===0?"ok":"fail"); resolve(c2===0); });
    });
  });
}
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
// ⚠️ तीनों brands का single source of truth — accent रंग असली logo से मिलाए गए हैं
//   kind: "ice2w" = पेट्रोल दोपहिया | "ev2w" = इलेक्ट्रिक दोपहिया | "ev3w" = इलेक्ट्रिक तिपहिया
//   logoOnLight: true = logo गहरे रंग का है (dark background पर सफ़ेद chip चाहिए)
//   logoCutout : false = logo का सफ़ेद हिस्सा design का भाग है, उसे मत हटाओ
const BRANDS = {
  vp_honda: {
    name: "VP Honda", sub: "अधिकृत Honda डीलर · मोटरसाइकिल व स्कूटर",
    company: "VP Honda", kind: "ice2w", vehicleWord: "गाड़ी", oem: "HONDA",
    accent: "#E4002B", accent2: "#7A0016", gold: "#FFD400",
    phone: "9713394738", whatsapp: "9713394738",
    place: "VP Honda, नरसिंहगढ़ रोड, परवलिया सड़क, भोपाल (म.प्र.)",
    products: ["Shine 100", "Shine 125", "SP 125", "Livo", "Activa 6G", "Dio 125", "Unicorn 160"],
    financePartners: ["HDB", "IDFC First", "Shriram", "Bajaj"],
    hashtags: ["#VPHonda", "#Honda", "#Bhopal", "#HondaBhopal"],
    // ⚠️ ये सिर्फ़ शुरुआती सुझाव हैं। असली फ़ैसला App के "Logo सेटिंग" से होता है,
    //    और सिर्फ़ वही file लगती है जो सच में public/logos/ में मौजूद हो।
    //    Code अपने आप कोई logo नहीं बनाता।
    logo: "vp_honda.png", companyLogo: null, logoOnLight: false, logoCutout: true,
    handles: { fb: "VPHondaBhopal", ig: "vp_honda", yt: "VP Honda" },
  },
  yakuza: {
    name: "Yakuza EV", sub: "MD Automobile · इलेक्ट्रिक स्कूटर",
    company: "MD Automobile", kind: "ev2w", vehicleWord: "स्कूटर", oem: "YAKUZA",
    // 🌱 हरा रंग जान-बूझकर — यह इलेक्ट्रिक वाहन है और green energy का प्रतीक है।
    //    (logo लाल-काला है, पर हरे background पर वो साफ़ उभरकर दिखता है)
    accent: "#0EA36A", accent2: "#064E36", gold: "#FFD400",
    phone: "9713394738", whatsapp: "9713394738",
    place: "MD Automobile, परवलिया सड़क, भोपाल (म.प्र.)",
    products: ["Yakuza Pro", "Yakuza Lite", "Yakuza Max"],
    financePartners: ["HDB", "IDFC First", "Shriram"],
    hashtags: ["#YakuzaEV", "#ElectricScooter", "#Bhopal", "#MDAutomobile"],
    logo: "yakuza.png", companyLogo: "yakuza.png", logoOnLight: false, logoCutout: true,
    handles: { fb: "YakuzaEV", ig: "yakuza_ev", yt: "Yakuza EV" },
  },
  minimetro: {
    name: "Mini Metro", sub: "MD Automobile · इलेक्ट्रिक लोडर व सवारी ऑटो",
    company: "MD Automobile", kind: "ev3w", vehicleWord: "ऑटो", oem: "MINI METRO",
    accent: "#16256B", accent2: "#0A1136", gold: "#E01F26",
    phone: "9713394738", whatsapp: "9713394738",
    place: "MD Automobile, परवलिया सड़क, भोपाल (म.प्र.)",
    products: ["Mini Metro सवारी ऑटो", "Mini Metro लोडर"],
    financePartners: ["HDB", "IDFC First", "Shriram"],
    hashtags: ["#MiniMetro", "#EAuto", "#Bhopal", "#MDAutomobile"],
    // Mini Metro logo नेवी+लाल है, उसका सफ़ेद outline design का हिस्सा है — मत हटाओ
    logo: "minimetro.png", companyLogo: "minimetro.png", logoOnLight: true, logoCutout: false,
    handles: { fb: "MiniMetroAuto", ig: "mini_metro_auto", yt: "Mini Metro" },
  },
};
// ── मालिक का अपना (personal) logo — तीनों brands के हर poster पर बाएँ तरफ़ ──
//    दाएँ तरफ़ हमेशा उस brand की कंपनी का logo (Honda / Yakuza / Mini Metro) रहता है।
//    file: public/logos/owner_logo.png  (env OWNER_LOGO_FILE से बदल सकते हैं)
const OWNER_LOGO_FILE = process.env.OWNER_LOGO_FILE || "owner_logo.png";
const SHOW_OWNER_LOGO = process.env.SHOW_OWNER_LOGO !== "false";

// public/logos/ में जो भी files पड़ी हैं, उनकी सूची
function availableLogos() {
  try {
    return fs.readdirSync(LOGO_DIR)
      .filter((f) => /\.(png|jpg|jpeg|webp|svg)$/i.test(f))
      .sort();
  } catch (_) { return []; }
}

// App से चुनी हुई settings — हर बार DB नहीं पढ़ना पड़े इसलिए हल्का cache
let _logoCfg = null, _logoCfgAt = 0;
async function logoConfig() {
  if (_logoCfg && Date.now() - _logoCfgAt < 60000) return _logoCfg;
  try {
    const rows = await LogoConfig.find({}).lean();
    _logoCfg = {};
    for (const r of rows) _logoCfg[r.brand] = r;
    _logoCfgAt = Date.now();
  } catch (_) { _logoCfg = _logoCfg || {}; }
  return _logoCfg;
}
function clearLogoCache() { _logoCfg = null; _logoCfgAt = 0; try { _headerCache.clear(); } catch (_) {} }

/**
 * किसी brand के लिए बाएँ/दाएँ कौन-सी file लगेगी।
 * क्रम:  1) App में चुनी गई setting
 *       2) BRANDS में लिखा default (सिर्फ़ वही जो सच में मौजूद है)
 *       3) कुछ नहीं — logo छोड़ दो (कभी कोई नया logo बनाया नहीं जाएगा)
 */
async function resolveLogos(brandId) {
  const b = BRANDS[brandId] || {};
  const cfg = (await logoConfig())[brandId] || {};
  const have = new Set(availableLogos());
  const pick = (...names) => names.find((n) => n && have.has(n)) || null;

  const owner = pick(cfg.ownerLogo, OWNER_LOGO_FILE, b.logo);
  // दाईं तरफ़ कंपनी का logo — चुना हुआ, वरना default, वरना कुछ नहीं
  let company = pick(cfg.companyLogo, b.companyLogo);
  // ⚠️ दोनों एक ही file हो तो दायाँ छोड़ दो, वरना एक ही logo दो बार छपेगा
  if (company && company === owner) company = null;
  return { owner, company };
}

// brand के हिसाब से AI/text में सही शब्द — "Honda dealer" सब brands पर नहीं लिखना
function brandDesc(b) {
  if (b.kind === "ev3w") return `इलेक्ट्रिक तिपहिया (E-रिक्शा/लोडर) डीलर "${b.name}"`;
  if (b.kind === "ev2w") return `इलेक्ट्रिक स्कूटर डीलर "${b.name}"`;
  return `अधिकृत Honda दोपहिया डीलर "${b.name}"`;
}
function brandEmoji(b) { return b.kind === "ev3w" ? "🛺" : b.kind === "ev2w" ? "🛵" : "🏍️"; }
const TYPES = ["suvichar", "vigyapan", "festival", "suchna", "gift"];
const TYPE_LABEL = { suvichar: "सुविचार", vigyapan: "विज्ञापन", promo: "विज्ञापन", festival: "त्यौहार शुभकामना", suchna: "आवश्यक सूचना", gift: "गिफ्ट प्रचार" };
// पुराने code/डेटा में कहीं-कहीं "promo" आता है — उसे vigyapan मान लो
const normType = (t) => (t === "promo" ? "vigyapan" : (TYPES.includes(t) ? t : "vigyapan"));

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
  customerName: String,                    // किस ग्राहक की पोस्ट है
  customerMobile: String,                  // उसे सीधे भेजने के लिए
  sentToCustomerAt: Date,                  // दो बार न जाए
  insights: mongoose.Schema.Types.Mixed,   // FB/IG से असली views/likes (PRD #33)
  insightsAt: Date,
  batchId: mongoose.Schema.Types.ObjectId, // किस batch से बना (PRD #29)
  triggeredBy: String,                     // किस trigger से बना (PRD #23)
  // ── Retry + Idempotency (PRD #18, #38) ──
  attempts: { type: Number, default: 0 },        // कितनी बार भेजने की कोशिश हुई
  lastAttemptAt: Date,
  nextRetryAt: Date,                             // इससे पहले दोबारा कोशिश नहीं
  publishLock: String,                           // एक ही समय दो जगह से न भेजा जाए
  publishedKey: String,                          // ⚠️ duplicate send रोकने की चाबी
}, { timestamps: true }));

const Delivery = model("Delivery", new mongoose.Schema({
  brand: { type: String, required: true }, customerName: String, bikeName: String, offer: String, photo: String, text: String,
  customerMobile: String,                       // ग्राहक को उसकी photo भेजने के लिए
  sentToCustomerAt: Date,                       // एक ही ग्राहक को दो बार न जाए
  images: { square: String, landscape: String }, video: String, music_used: String, post_type: { type: String, default: "video" },
  imageData: { square: String, story: String }, // base64 — restart-safe
  platforms: { fb: { type: Boolean, default: true }, ig: { type: Boolean, default: true }, yt: { type: Boolean, default: true }, wa: { type: Boolean, default: true } },
  status: { type: String, enum: ["pending", "rejected", "sent", "failed"], default: "pending" },
  channels: [String], results: mongoose.Schema.Types.Mixed, engagement_stats: mongoose.Schema.Types.Mixed, sentAt: Date,
  attempts: { type: Number, default: 0 }, lastAttemptAt: Date, nextRetryAt: Date,
  publishLock: String, publishedKey: String,
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
  autoRepliedAt: Date,                          // ग्राहक को अपने आप जवाब गया या नहीं
}, { timestamps: true }));

const Notification = model("Notification", new mongoose.Schema({
  type: String, message: String, brand: String, read: { type: Boolean, default: false },
}, { timestamps: true }));

// AI Command Center — scheduled commands (voice/text से बने)
const ScheduledCommand = model("ScheduledCommand", new mongoose.Schema({
  brand: String, type: String, text: String,
  vehicle: String, offerDetails: String,
  scheduleWhen: String,       // "tomorrow" | "specific_date"
  scheduleDate: String,       // "YYYY-MM-DD"
  scheduleTime: { type: String, default: "09:00" },
  recurring: String,          // "daily" | "weekly" | null
  status: { type: String, enum: ["scheduled", "processed", "failed", "cancelled"], default: "scheduled" },
  lastRunAt: Date,
  contentId: mongoose.Schema.Types.ObjectId,
}, { timestamps: true }));

// Vehicle Knowledge Base — AI इसी से price/EMI लेगा, खुद कभी नहीं बनाएगा
const Vehicle = model("Vehicle", new mongoose.Schema({
  brand: { type: String, required: true },        // vp_honda | yakuza | minimetro
  name: { type: String, required: true },          // "Shine 100"
  variant: String,                                  // "DLX", "Standard"
  category: String,                                 // "motorcycle" | "scooter" | "ev" | "auto"
  exShowroom: String,                               // "₹56,900"
  onRoad: String,                                   // "₹68,500"
  downPayment: String,                              // "₹4,999"
  emi: String,                                      // "₹1,999/माह"
  emiTenure: String,                                // "36 महीने"
  roi: String,                                      // "7.99%"
  cashback: String,                                 // "₹5,000"
  exchangeBonus: String,                            // "₹2,000"
  offerNote: String,                                // "दिवाली तक"
  colors: [String],
  features: [String],
  mileage: String,                                  // "65 kmpl" या EV: "120 km रेंज"
  engine: String,                                   // "100cc" / "2.2 kW"
  inStock: { type: Boolean, default: true },
  imageUrl: String,
  active: { type: Boolean, default: true },
}, { timestamps: true, strict: false }));

// Brand Memory — business info + पसंद, एक बार भरो हर बार AI use करे
const BrandProfile = model("BrandProfile", new mongoose.Schema({
  brand: { type: String, required: true, unique: true },
  // Business info
  displayName: String,          // poster पर दिखने वाला नाम
  tagline: String,              // "हमारा साथ आपका विश्वास"
  address: String,
  phone: String,
  whatsapp: String,
  website: String,
  fbHandle: String,
  igHandle: String,
  // Design preferences
  primaryColor: String,
  secondaryColor: String,
  preferredBgStyles: [String],  // ["yellow_red", "gold_dark"]
  // Content preferences
  tone: String,                 // "friendly" | "professional" | "energetic" | "devotional"
  textLength: String,           // "short" | "medium" | "long"
  emojiLevel: String,           // "few" | "normal" | "many"
  language: String,             // "hindi" | "hinglish"
  alwaysInclude: String,        // हर post में यह ज़रूर हो
  neverInclude: String,         // यह कभी मत लिखो
  disclaimer: String,           // "*नियम व शर्तें लागू"
  // Learning — approve/reject feedback
  likedNotes: [String],         // जो पसंद आया
  dislikedNotes: [String],      // जो पसंद नहीं आया
}, { timestamps: true, strict: false }));

// मालिक के WhatsApp पर approval — हर brand की अपनी सेटिंग
const OwnerWA = model("OwnerWA", new mongoose.Schema({
  brand: { type: String, unique: true },
  numbers: [String],                                  // मालिक/मैनेजर के नंबर (91XXXXXXXXXX)
  enabled: { type: Boolean, default: false },
  sendPosters: { type: Boolean, default: true },
  sendVideos: { type: Boolean, default: true },
  sendDeliveries: { type: Boolean, default: true },
  sendToCustomer: { type: Boolean, default: false },  // ⚠️ ग्राहक को सीधे भेजना — डिफ़ॉल्ट बंद
  leadAlert: { type: Boolean, default: true },        // नया lead आते ही आपको message
  leadAutoReply: { type: Boolean, default: false },   // ⚠️ ग्राहक को अपने आप जवाब — डिफ़ॉल्ट बंद
  voiceCommands: { type: Boolean, default: true },    // WhatsApp पर बोलकर command
  monthlyReport: { type: Boolean, default: true },    // हर महीने की 1 तारीख़ को हिसाब
  quietFrom: { type: String, default: "22:00" },      // इस समय के बाद मत भेजो
  quietTo: { type: String, default: "07:00" },
  lastSentAt: Date,
  sentCount: { type: Number, default: 0 },
}, { timestamps: true }));

// कौन-सा message किस post के बारे में था — जवाब आने पर पहचानने के लिए
const WAPending = model("WAPending", new mongoose.Schema({
  brand: String,
  kind: { type: String, default: "content" },         // content | delivery
  refId: mongoose.Schema.Types.ObjectId,
  toNumber: String,
  waMessageId: String,
  shortCode: String,                                  // जैसे "A7" — टाइप करके भी जवाब दे सकें
  status: { type: String, default: "waiting" },       // waiting | approved | rejected | expired
  answeredAt: Date,
  expiresAt: Date,
}, { timestamps: true }));

// कौन-सा logo कहाँ लगेगा — App से बदला जा सकता है, code में कुछ hardcode नहीं
const LogoConfig = model("LogoConfig", new mongoose.Schema({
  brand: { type: String, unique: true },
  ownerLogo: String,     // बाएँ लगने वाली file (public/logos/ में से)
  companyLogo: String,   // दाएँ लगने वाली file (public/logos/ में से)
}, { timestamps: true }));

// Batch job (PRD #29) — "10 creatives एक साथ बना दो"
const BatchJob = model("BatchJob", new mongoose.Schema({
  brand: String,
  kind: String,                       // "creatives" | "calendar"
  requested: Number,
  status: { type: String, enum: ["queued", "running", "done", "failed", "cancelled"], default: "queued" },
  done: { type: Number, default: 0 },
  failed: { type: Number, default: 0 },
  items: [mongoose.Schema.Types.Mixed],   // { contentId, type, text, error }
  brief: String,                      // user ने क्या कहा
  startedAt: Date, finishedAt: Date,
  error: String,
}, { timestamps: true }));

// Automation trigger rules (PRD #23) — सिर्फ़ समय नहीं, घटना पर भी
const TriggerRule = model("TriggerRule", new mongoose.Schema({
  brand: String,
  event: String,                      // new_delivery | new_vehicle | new_lead | festival_soon | low_content
  enabled: { type: Boolean, default: true },
  action: String,                     // make_post | make_video | notify_only
  contentType: { type: String, default: "vigyapan" },
  autoApprove: { type: Boolean, default: false },   // ⚠️ default में हमेशा false
  cooldownMins: { type: Number, default: 30 },      // बार-बार न चले
  lastFiredAt: Date,
  fireCount: { type: Number, default: 0 },
}, { timestamps: true }));

// AUDIT LOG (PRD #44) — हर पैसे/ग्राहक वाले काम का स्थायी record।
// ⚠️ ActivityLog से अलग है: ActivityLog debugging के लिए है और साफ़ हो सकता है,
//    AuditLog कभी अपने आप delete नहीं होता — यह "किसने क्या किया" का सबूत है।
const AuditLog = model("AuditLog", new mongoose.Schema({
  brand: String,
  action: String,          // publish | send | approve | reject | offer | price | delete | login-fail
  entity: String,          // content | delivery | vehicle | lead | news | voice
  entityId: String,
  actor: String,           // किस user ने (नाम + role), या "system/cron"
  actorRole: String,
  summary: String,         // हिंदी में एक लाइन
  before: mongoose.Schema.Types.Mixed,   // बदलने से पहले क्या था
  after: mongoose.Schema.Types.Mixed,    // बदलने के बाद क्या
  ip: String,
}, { timestamps: true }));

// Voice-over — बनी हुई आवाज़ों का record (PRD #14)
const VoiceClip = model("VoiceClip", new mongoose.Schema({
  brand: String,
  script: String,               // जो बोला गया
  gender: String,               // male | female
  style: String,                // professional | energetic | friendly | announcement | promotional
  file: String,                 // /generated/xxx.mp3
  durationSec: Number,
  provider: String,             // किस provider ने बनाया
  contentId: mongoose.Schema.Types.ObjectId,
}, { timestamps: true }));

// एक ही content के कई versions (PRD #28)
const VariantSet = model("VariantSet", new mongoose.Schema({
  brand: String,
  topic: String,                // किस चीज़ के variants
  kind: String,                 // "caption" | "poster" | "voice"
  variants: [mongoose.Schema.Types.Mixed],
  recommendedIndex: { type: Number, default: 0 },
  recommendReason: String,
  chosenIndex: Number,          // user ने कौन सा चुना (सीखने के लिए)
}, { timestamps: true }));

// News — बिना source के कोई खबर नहीं (PRD #25)
const NewsItem = model("NewsItem", new mongoose.Schema({
  brand: String,
  headline: String,
  summary: String,
  sourceName: String,
  sourceUrl: { type: String, required: true },   // ⚠️ URL के बिना save ही नहीं होगी
  publishedAt: String,
  verified: { type: Boolean, default: false },
  verifyNote: String,
  usedForContent: { type: Boolean, default: false },
}, { timestamps: true }));

// Activity Log — AI ने क्या किया, पूरा हिसाब (Phase 11)
const ActivityLog = model("ActivityLog", new mongoose.Schema({
  brand: String,
  action: String,        // "command" | "generate" | "poster" | "video" | "schedule" | "publish" | "quality" | "approve" | "reject" | "auto_marketing"
  status: String,        // "success" | "failed" | "info"
  message: String,       // Hindi में क्या हुआ
  detail: String,        // extra जानकारी
  contentId: mongoose.Schema.Types.ObjectId,
  by: String,            // "AI" | user email
  durationMs: Number,
}, { timestamps: true }));

async function activity(brand, action, status, message, opts = {}) {
  try {
    await ActivityLog.create({
      brand, action, status, message,
      detail: opts.detail || "", contentId: opts.contentId || undefined,
      by: opts.by || "AI", durationMs: opts.durationMs || undefined,
    });
  } catch (_) {}
}

// Automation Settings + Cost Control (Phase 12)
const AutomationSettings = model("AutomationSettings", new mongoose.Schema({
  dailyPosters: { type: Number, default: 3 },     // रोज़ कितने poster अपने आप बनें
  dailyVideo: { type: Boolean, default: true },   // रोज़ का promotional video बने या नहीं
  dailyEngineOn: { type: Boolean, default: true },// पूरा engine चालू है या नहीं
  brand: { type: String, required: true, unique: true },
  // Approval mode
  mode: { type: String, enum: ["safe", "semi", "full"], default: "safe" },
  // semi mode में कौन से types auto-publish हों
  autoTypes: [String],           // ["suvichar", "festival"]
  autoChannels: [String],        // ["fb", "ig"]
  // Cost limits
  dailyAiLimit: { type: Number, default: 50 },      // कितने AI calls प्रति दिन
  dailyVideoLimit: { type: Number, default: 5 },
  dailyImageLimit: { type: Number, default: 30 },
  warnBeforeExpensive: { type: Boolean, default: true },
  // Quality gate
  requireQualityCheck: { type: Boolean, default: false },
  minQualityScore: { type: Number, default: 60 },
}, { timestamps: true, strict: false }));

// रोज़ का usage — cost control के लिए
const UsageLog = model("UsageLog", new mongoose.Schema({
  date: { type: String, required: true },   // YYYY-MM-DD (IST)
  brand: String,
  aiCalls: { type: Number, default: 0 },
  images: { type: Number, default: 0 },
  videos: { type: Number, default: 0 },
}, { timestamps: true }));
UsageLog.collection.createIndex({ date: 1, brand: 1 }, { unique: true }).catch(() => {});

function istToday() { return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); }

async function getAutomationSettings(brand) {
  try {
    let s = await AutomationSettings.findOne({ brand }).lean();
    if (!s) s = { brand, mode: "safe", autoTypes: [], autoChannels: ["fb", "ig"], dailyAiLimit: 50, dailyVideoLimit: 5, dailyImageLimit: 30, warnBeforeExpensive: true, requireQualityCheck: false, minQualityScore: 60 };
    return s;
  } catch (_) { return { mode: "safe", autoTypes: [], autoChannels: ["fb", "ig"], dailyAiLimit: 50, dailyVideoLimit: 5, dailyImageLimit: 30 }; }
}

// usage बढ़ाओ और limit check करो — { ok, used, limit, message }
async function checkAndCountUsage(brand, kind) {
  try {
    const date = istToday();
    const s = await getAutomationSettings(brand);
    const limitMap = { aiCalls: s.dailyAiLimit, images: s.dailyImageLimit, videos: s.dailyVideoLimit };
    const limit = limitMap[kind] ?? 999;
    const cur = await UsageLog.findOne({ date, brand }).lean();
    const used = cur?.[kind] || 0;
    if (used >= limit) {
      return { ok: false, used, limit, message: `आज की ${kind === "videos" ? "video" : kind === "images" ? "image" : "AI"} limit (${limit}) पूरी हो गई` };
    }
    await UsageLog.findOneAndUpdate({ date, brand }, { $inc: { [kind]: 1 } }, { upsert: true });
    return { ok: true, used: used + 1, limit };
  } catch (e) { return { ok: true, used: 0, limit: 999 }; }
}

// Video job status track करने के लिए in-memory store (Phase 7)
const VIDEO_JOBS = {};

async function notify(type, message, brand) {
  try { await Notification.create({ type, message, brand }); log("INFO", "notify", { type, brand }); } catch (e) {}
}

// per-brand credentials: DB settings पहले, फिर .env
let SETTINGS_CACHE = {};
async function loadSettings() {
  SETTINGS_CACHE = {};
  const docs = await Setting.find().lean();
  docs.forEach((s) => (SETTINGS_CACHE[s.brand] = s.creds || {}));
  console.log("[loadSettings]", docs.map(d => d.brand + ":" + Object.keys(d.creds||{}).join(",")).join(" | ") || "NO DOCS");
}
async function ensureIndexes() {
  try {
    await mongoose.connection.collection("contents").createIndex({ brand: 1, status: 1, createdAt: -1 });
    await mongoose.connection.collection("deliveries").createIndex({ brand: 1, status: 1, createdAt: -1 });
    await mongoose.connection.collection("scheduledcommands").createIndex({ status: 1, scheduleDate: 1, scheduleTime: 1 });
    await mongoose.connection.collection("activitylogs").createIndex({ brand: 1, createdAt: -1 });
    await mongoose.connection.collection("contents").createIndex({ brand: 1, createdAt: -1 });
    await mongoose.connection.collection("voiceclips").createIndex({ brand: 1, createdAt: -1 });
    await mongoose.connection.collection("variantsets").createIndex({ brand: 1, kind: 1, createdAt: -1 });
    await mongoose.connection.collection("newsitems").createIndex({ sourceUrl: 1 }, { unique: true });
    await mongoose.connection.collection("newsitems").createIndex({ brand: 1, createdAt: -1 });
    await mongoose.connection.collection("auditlogs").createIndex({ brand: 1, createdAt: -1 });
    await mongoose.connection.collection("batchjobs").createIndex({ brand: 1, status: 1, createdAt: -1 });
    await mongoose.connection.collection("triggerrules").createIndex({ brand: 1, event: 1 }, { unique: true });
    await mongoose.connection.collection("wapendings").createIndex({ brand: 1, status: 1, createdAt: -1 });
    await mongoose.connection.collection("wapendings").createIndex({ shortCode: 1, toNumber: 1 });
    await mongoose.connection.collection("auditlogs").createIndex({ action: 1, createdAt: -1 });
    await mongoose.connection.collection("contents").createIndex({ status: 1, nextRetryAt: 1 });
    await mongoose.connection.collection("deliveries").createIndex({ status: 1, nextRetryAt: 1 });
    console.log("[indexes] created OK");
  } catch(e) { console.log("[indexes] error:", e.message); }
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
    waToken: db.waToken || process.env.WA_TOKEN || process.env[`${P}_WA_TOKEN`] || "",
    waRecipients: recipients,
  };
}



// ===========================================================================
//  PROVIDER-AGNOSTIC AI LAYER  (PRD #36)
//  ─────────────────────────────────────────────────────────────────────────
//  किसी भी AI provider को code में hard-code नहीं करना है। हर काम के लिए
//  providers की एक सूची है — पहला fail हो तो अपने-आप अगला try होता है।
//
//    AI.text()   → Text Provider     (gemini → openai → groq → ollama)
//    AI.json()   → वही, पर JSON में
//    AI.vision() → image + text
//    AI.image()  → Image Provider    (gemini → pollinations)
//    AI.tts()    → Text-to-Speech    (elevenlabs → google → free)
//    AI.stt()    → Speech-to-Text    (openai whisper → gemini)
//    AI.video()  → Video Provider    (ffmpeg local → future API)
//
//  नया provider जोड़ना हो तो बस नीचे की सूची में एक entry डालें —
//  बाक़ी पूरे app में कहीं कुछ नहीं बदलना पड़ेगा।
// ===========================================================================
const AI_KEYS = () => ({
  gemini: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "",
  openai: process.env.OPENAI_API_KEY || "",
  groq: process.env.GROQ_API_KEY || "",
  anthropic: process.env.ANTHROPIC_API_KEY || "",
  elevenlabs: process.env.ELEVENLABS_API_KEY || "",
  gcloudTts: process.env.GOOGLE_TTS_API_KEY || process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "",
  ollama: process.env.OLLAMA_URL || "",
});

// env से क्रम बदल सकते हैं: AI_TEXT_ORDER="openai,gemini"
const order = (envName, def) =>
  String(process.env[envName] || def).split(",").map((x) => x.trim()).filter(Boolean);

// ── हर provider एक ही shape लौटाता है: { ok, text?, buf?, mime?, error, via } ──

const TEXT_PROVIDERS = {
  async gemini({ parts, temperature, json, timeout, maxTokens }) {
    const key = AI_KEYS().gemini;
    if (!key) return { ok: false, error: "no-key" };
    const models = order("GEMINI_TEXT_MODELS", "gemini-2.5-flash,gemini-2.0-flash,gemini-1.5-flash");
    let last = "";
    for (const m of models) {
      try {
        // JSON माँग रहे हैं तो जगह ज़्यादा दो — अधूरा JSON बेकार जाता है
        const gc = { temperature, maxOutputTokens: maxTokens || (json ? 3000 : 1200) };
        if (json) gc.responseMimeType = "application/json";
        // ⚠️ 2.5 वाले models बिना बताए "सोचने" में सारे tokens खर्च कर देते हैं
        //    और जवाब अधूरा आता है। इसलिए सोचना बंद।
        if (/2\.5|thinking/i.test(m)) gc.thinkingConfig = { thinkingBudget: 0 };

        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${key}`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contents: [{ parts }], generationConfig: gc }),
          signal: AbortSignal.timeout(timeout),
        });
        if (!r.ok) {
          let why = String(r.status);
          try { why += ":" + String((await r.json())?.error?.message || "").slice(0, 60); } catch (_) {}
          last = `${m}:${why}`; continue;
        }
        const d = await r.json();
        const cand = d?.candidates?.[0];
        const t = cand?.content?.parts?.map((x) => x.text || "").join("").trim();

        // जवाब बीच में कट गया? तो अगला model आज़माओ, अधूरा JSON मत लौटाओ
        if (cand?.finishReason === "MAX_TOKENS") { last = `${m}:जवाब बीच में कट गया`; continue; }
        if (cand?.finishReason === "SAFETY") { last = `${m}:safety block`; continue; }
        if (!t) { last = `${m}:खाली जवाब (${cand?.finishReason || "?"})`; continue; }

        return { ok: true, text: t, via: `gemini/${m}` };
      } catch (e) { last = `${m}:${(e.message || "").slice(0, 40)}`; }
    }
    return { ok: false, error: last || "gemini fail" };
  },

  async openai({ parts, temperature, json, timeout, maxTokens }) {
    const key = AI_KEYS().openai;
    if (!key) return { ok: false, error: "no-key" };
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    try {
      const content = parts.map((p) =>
        p.inline_data
          ? { type: "image_url", image_url: { url: `data:${p.inline_data.mime_type};base64,${p.inline_data.data}` } }
          : { type: "text", text: p.text || "" });
      const body = {
        model, temperature, max_tokens: maxTokens || (json ? 3000 : 1200),
        messages: [{ role: "user", content }],
      };
      if (json) body.response_format = { type: "json_object" };
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(body), signal: AbortSignal.timeout(timeout),
      });
      if (!r.ok) return { ok: false, error: `openai ${r.status}` };
      const t = (await r.json())?.choices?.[0]?.message?.content?.trim();
      return t ? { ok: true, text: t, via: `openai/${model}` } : { ok: false, error: "empty" };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  async anthropic({ parts, temperature, timeout, maxTokens }) {
    const key = AI_KEYS().anthropic;
    if (!key) return { ok: false, error: "no-key" };
    const model = process.env.ANTHROPIC_MODEL || "claude-3-5-haiku-latest";
    try {
      const content = parts.map((p) =>
        p.inline_data
          ? { type: "image", source: { type: "base64", media_type: p.inline_data.mime_type, data: p.inline_data.data } }
          : { type: "text", text: p.text || "" });
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({ model, max_tokens: maxTokens || 1200, temperature, messages: [{ role: "user", content }] }),
        signal: AbortSignal.timeout(timeout),
      });
      if (!r.ok) return { ok: false, error: `anthropic ${r.status}` };
      const d = await r.json();
      const t = (d.content || []).map((b) => b.text || "").join("").trim();
      return t ? { ok: true, text: t, via: `anthropic/${model}` } : { ok: false, error: "empty" };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  async groq({ parts, temperature, json, timeout, maxTokens }) {
    const key = AI_KEYS().groq;
    if (!key) return { ok: false, error: "no-key" };
    // ⚠️ Groq के free models photo नहीं देख सकते। चुपचाप सिर्फ़ text पढ़कर
    //    photo के बारे में मनगढ़ंत जवाब देने से अच्छा है साफ़ मना कर देना —
    //    तब chain अगला provider (Gemini/OpenAI) आज़मा लेगी।
    if (parts.some((p) => p.inline_data)) return { ok: false, error: "यह model photo नहीं देख सकता" };
    // ⚠️ Groq ने जून 2026 में llama-3.3-70b को बंद कर दिया — अब यह चलता है
    const model = process.env.GROQ_MODEL || "openai/gpt-oss-120b";
    try {
      const body = {
        model, temperature, max_tokens: maxTokens || (json ? 3000 : 1200),
        messages: [{ role: "user", content: parts.map((p) => p.text || "").join("\n") }],
      };
      if (json) body.response_format = { type: "json_object" };
      const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify(body), signal: AbortSignal.timeout(timeout),
      });
      if (!r.ok) return { ok: false, error: `groq ${r.status}` };
      const t = (await r.json())?.choices?.[0]?.message?.content?.trim();
      return t ? { ok: true, text: t, via: `groq/${model}` } : { ok: false, error: "empty" };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  // अपने server पर चलने वाला free local model (कोई key नहीं चाहिए)
  async ollama({ parts, temperature, json, timeout }) {
    const url = AI_KEYS().ollama;
    if (!url) return { ok: false, error: "no-url" };
    if (parts.some((p) => p.inline_data)) return { ok: false, error: "यह model photo नहीं देख सकता" };
    const model = process.env.OLLAMA_MODEL || "llama3.1";
    try {
      const r = await fetch(`${url.replace(/\/$/, "")}/api/generate`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model, prompt: parts.map((p) => p.text || "").join("\n"),
          stream: false, format: json ? "json" : undefined, options: { temperature },
        }),
        signal: AbortSignal.timeout(timeout),
      });
      if (!r.ok) return { ok: false, error: `ollama ${r.status}` };
      const t = (await r.json())?.response?.trim();
      return t ? { ok: true, text: t, via: `ollama/${model}` } : { ok: false, error: "empty" };
    } catch (e) { return { ok: false, error: e.message }; }
  },
};

const IMAGE_PROVIDERS = {
  async gemini({ prompt, w, h }) {
    const g = await fetchGeminiImage(prompt, w, h);
    return g.buf ? { ok: true, buf: g.buf, mime: "image/png", via: "gemini/" + (g.model || "image") }
                 : { ok: false, error: g.error || "fail" };
  },
  async pollinations({ prompt, w, h }) {
    const buf = await fetchAIBackground("vp_honda", { aiPrompt: prompt }, w, h);
    return buf ? { ok: true, buf, mime: "image/png", via: "pollinations" } : { ok: false, error: "fail" };
  },
};

const TTS_PROVIDERS = {
  // सबसे अच्छी आवाज़ — key चाहिए
  async elevenlabs({ text, voiceId, timeout }) {
    const key = AI_KEYS().elevenlabs;
    if (!key) return { ok: false, error: "no-key" };
    const vid = voiceId || process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";
    try {
      const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${vid}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "xi-api-key": key, Accept: "audio/mpeg" },
        body: JSON.stringify({
          text, model_id: process.env.ELEVENLABS_MODEL || "eleven_multilingual_v2",
          voice_settings: { stability: 0.45, similarity_boost: 0.75, style: 0.35 },
        }),
        signal: AbortSignal.timeout(timeout),
      });
      if (!r.ok) return { ok: false, error: `elevenlabs ${r.status}` };
      return { ok: true, buf: Buffer.from(await r.arrayBuffer()), mime: "audio/mpeg", via: "elevenlabs" };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  // Google Cloud TTS — हिंदी की बढ़िया neural आवाज़ें
  async google({ text, gender, style, timeout }) {
    const key = AI_KEYS().gcloudTts;
    if (!key) return { ok: false, error: "no-key" };
    const name = gender === "male" ? "hi-IN-Neural2-B" : "hi-IN-Neural2-A";
    const rate = style === "energetic" ? 1.12 : style === "announcement" ? 0.95 : 1.0;
    const pitch = style === "energetic" ? 2.0 : style === "professional" ? -1.0 : 0;
    try {
      const r = await fetch(`https://texttospeech.googleapis.com/v1/text:synthesize?key=${key}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          input: { text },
          voice: { languageCode: "hi-IN", name, ssmlGender: gender === "male" ? "MALE" : "FEMALE" },
          audioConfig: { audioEncoding: "MP3", speakingRate: rate, pitch },
        }),
        signal: AbortSignal.timeout(timeout),
      });
      if (!r.ok) return { ok: false, error: `google-tts ${r.status}` };
      const d = await r.json();
      if (!d.audioContent) return { ok: false, error: "empty" };
      return { ok: true, buf: Buffer.from(d.audioContent, "base64"), mime: "audio/mpeg", via: "google-tts" };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  // बिना key वाला fallback — आवाज़ साधारण है पर काम चल जाता है
  async free({ text, timeout }) {
    try {
      const chunks = [];
      // यह endpoint एक बार में ~200 अक्षर लेता है — टुकड़ों में तोड़ो
      const parts = String(text).match(/[\s\S]{1,190}(?=\s|$)|[\s\S]{1,190}/g) || [];
      for (const c of parts.slice(0, 12)) {
        const u = `https://translate.google.com/translate_tts?ie=UTF-8&tl=hi&client=tw-ob&q=${encodeURIComponent(c)}`;
        const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(timeout) });
        if (!r.ok) return { ok: false, error: `free-tts ${r.status}` };
        chunks.push(Buffer.from(await r.arrayBuffer()));
      }
      if (!chunks.length) return { ok: false, error: "empty" };
      return { ok: true, buf: Buffer.concat(chunks), mime: "audio/mpeg", via: "free-tts" };
    } catch (e) { return { ok: false, error: e.message }; }
  },
};

const STT_PROVIDERS = {
  async openai({ buf, mime, timeout }) {
    const key = AI_KEYS().openai;
    if (!key) return { ok: false, error: "no-key" };
    try {
      const fd = new FormData();
      fd.append("file", new Blob([buf], { type: mime || "audio/webm" }), "audio.webm");
      fd.append("model", process.env.OPENAI_STT_MODEL || "whisper-1");
      fd.append("language", "hi");
      const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST", headers: { Authorization: `Bearer ${key}` }, body: fd,
        signal: AbortSignal.timeout(timeout),
      });
      if (!r.ok) return { ok: false, error: `whisper ${r.status}` };
      const t = (await r.json())?.text?.trim();
      return t ? { ok: true, text: t, via: "openai/whisper" } : { ok: false, error: "empty" };
    } catch (e) { return { ok: false, error: e.message }; }
  },
  async gemini({ buf, mime, timeout }) {
    const res = await TEXT_PROVIDERS.gemini({
      parts: [
        { text: "इस audio को हिंदी में जैसा बोला गया वैसा ही लिखो। सिर्फ़ लिखा हुआ text दो, कुछ और नहीं।" },
        { inline_data: { mime_type: mime || "audio/webm", data: buf.toString("base64") } },
      ],
      temperature: 0, json: false, timeout, maxTokens: 800,
    });
    return res.ok ? { ok: true, text: res.text, via: res.via } : res;
  },
};

/**
 * AI का जवाब JSON में बदलो — मॉडल अक्सर आस-पास कुछ और भी लिख देते हैं।
 * सीधा parse न हो तो पहले { से आख़िरी } तक का हिस्सा निकालकर कोशिश करते हैं।
 * न बने तो null — तब chain अगला provider आज़माएगा।
 */
function parseLooseJSON(raw) {
  if (!raw) return null;
  let t = String(raw).trim();

  // 1) सीधा
  try { return JSON.parse(t); } catch (_) {}

  // 2) ```json ... ``` हटाकर
  t = t.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
  try { return JSON.parse(t); } catch (_) {}

  // 3) पहले { या [ से आख़िरी } या ] तक
  const first = Math.min(...[t.indexOf("{"), t.indexOf("[")].filter((x) => x >= 0));
  const last = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  if (Number.isFinite(first) && last > first) {
    const slice = t.slice(first, last + 1);
    try { return JSON.parse(slice); } catch (_) {}
    // 4) आख़िर में लटका हुआ comma हटाकर
    try { return JSON.parse(slice.replace(/,\s*([}\]])/g, "$1")); } catch (_) {}
  }
  return null;
}

// ── मुख्य AI object — पूरा app सिर्फ़ इसी को call करता है ─────────────────
const AI = {
  async _chain(providers, table, args, kind, validate) {
    const errs = [];
    for (const name of providers) {
      const fn = table[name];
      if (!fn) { errs.push(`${name}:unknown`); continue; }
      try {
        const r = await fn(args);
        if (!r.ok) { errs.push(`${name}:${r.error}`); continue; }
        // ⚠️ जवाब आ गया पर सही shape में है या नहीं — यह भी यहीं जाँचो,
        //    वरना टूटा जवाब लेकर बाहर निकल जाते हैं और अगला provider बचा रह जाता है
        if (validate) {
          const v = validate(r);
          if (!v.ok) { errs.push(`${name}:${v.error}`); continue; }
          return { ...r, parsed: v.value };
        }
        return r;
      } catch (e) { errs.push(`${name}:${(e.message || "").slice(0, 40)}`); }
    }
    log("WARN", `[AI] सब ${kind} providers fail`, { errs: errs.join(" | ").slice(0, 400) });
    return { ok: false, error: errs.join(" | ") || "कोई provider उपलब्ध नहीं" };
  },

  text(prompt, o = {}) {
    const parts = Array.isArray(prompt) ? prompt : [{ text: String(prompt) }];
    return AI._chain(order("AI_TEXT_ORDER", "gemini,openai,anthropic,groq,ollama"), TEXT_PROVIDERS,
      { parts, temperature: o.temperature ?? 0.8, json: false, timeout: o.timeout || 15000, maxTokens: o.maxTokens },
      "text");
  },

  // JSON माँगो — parse भी यहीं हो जाता है, और टूटा हो तो अगला provider
  async json(prompt, o = {}) {
    const parts = Array.isArray(prompt) ? prompt : [{ text: String(prompt) }];
    const r = await AI._chain(
      order("AI_TEXT_ORDER", "gemini,openai,anthropic,groq,ollama"), TEXT_PROVIDERS,
      { parts, temperature: o.temperature ?? 0.4, json: true, timeout: o.timeout || 25000, maxTokens: o.maxTokens },
      "json",
      (res) => {                       // ⚠️ यही validate chain के अंदर चलता है
        const v = parseLooseJSON(res.text);
        return v === null
          ? { ok: false, error: "टूटा JSON: " + String(res.text).replace(/\s+/g, " ").slice(0, 70) }
          : { ok: true, value: v };
      });

    if (!r.ok) {
      log("WARN", "[AI] JSON नहीं मिला", { err: String(r.error).slice(0, 250) });
      return { error: "AI से सही जवाब नहीं मिला — थोड़ी देर बाद दोबारा कोशिश करें", detail: r.error };
    }
    const out = r.parsed;
    if (out && typeof out === "object") out.__via = r.via;
    return out;
  },

  // image + सवाल
  vision(promptText, imageDataUrl, o = {}) {
    const clean = String(imageDataUrl || "").replace(/^data:image\/\w+;base64,/, "");
    const mime = /^data:image\/(\w+);/.exec(imageDataUrl || "")?.[1] || "jpeg";
    return AI.json([{ text: promptText }, { inline_data: { mime_type: `image/${mime}`, data: clean } }], o);
  },

  image(prompt, w, h) {
    return AI._chain(order("AI_IMAGE_ORDER", "gemini,pollinations"), IMAGE_PROVIDERS, { prompt, w, h }, "image");
  },

  tts(text, o = {}) {
    return AI._chain(order("AI_TTS_ORDER", "elevenlabs,google,free"), TTS_PROVIDERS,
      { text, gender: o.gender || "female", style: o.style || "friendly", voiceId: o.voiceId, timeout: o.timeout || 45000 },
      "tts");
  },

  stt(buf, mime, o = {}) {
    return AI._chain(order("AI_STT_ORDER", "openai,gemini"), STT_PROVIDERS,
      { buf, mime, timeout: o.timeout || 40000 }, "stt");
  },

  // कौन-सा provider अभी उपलब्ध है (Settings में दिखाने के लिए)
  status() {
    const k = AI_KEYS();
    return {
      text: { order: order("AI_TEXT_ORDER", "gemini,openai,anthropic,groq,ollama"),
              ready: { gemini: !!k.gemini, openai: !!k.openai, anthropic: !!k.anthropic, groq: !!k.groq, ollama: !!k.ollama } },
      image: { order: order("AI_IMAGE_ORDER", "gemini,pollinations"),
               ready: { gemini: !!k.gemini, pollinations: true } },
      tts: { order: order("AI_TTS_ORDER", "elevenlabs,google,free"),
             ready: { elevenlabs: !!k.elevenlabs, google: !!k.gcloudTts, free: true } },
      stt: { order: order("AI_STT_ORDER", "openai,gemini"),
             ready: { openai: !!k.openai, gemini: !!k.gemini } },
      video: {
        order: ["ffmpeg-local", ...order("AI_VIDEO_ORDER", "replicate,luma")],
        ready: {
          "ffmpeg-local": ENABLE_VIDEO,
          replicate: !!(process.env.REPLICATE_API_TOKEN && process.env.REPLICATE_VIDEO_VERSION),
          luma: !!process.env.LUMA_API_KEY,
        },
      },
    };
  },
};

// पुराना code भी अब इसी layer से होकर जाता है
async function aiJSON(parts, o = {}) { return AI.json(parts, o); }

// ===========================================================================
// CONTENT + IMAGE GENERATION
// ===========================================================================
function templateContent(brandId, type, festivalName) {
  const b = BRANDS[brandId];
  const prod = b.products[Math.floor(Math.random() * b.products.length)];
  const EM = brandEmoji(b);
  const TAGS = (b.hashtags || []).join(" ");
  const bank = {
    suvichar: [
      `🌹🍃🥀 शुभप्रभात 🥀🍃🌹\n----------✍️----------\nखुशी के फूल उन्हें की...!\nझोली में गिरते हैं!\nजो अपनों से अपनों की\nतरह हर सुबह मिलते हैं!!\n🪷🙏 आपका अपना शो रूम 🙏🪷\n🌻🙏 ${b.name} 🙏🌻\nआपका दिन शुभ एवं मंगलमय हो!!\n🌷🪻 ${b.place} 🪻🌷`,

      `🌹🌹🌾 शुभप्रभात 🌾🌹🌹\n^^^^^^^^^✍️^^^^^^^^^\nजिंदगी कुछ बरसों के लिए\nलीज पर मिली है तो\nरजिस्ट्री के चक्कर में ना पड़े\nइसलिए मस्त रहें स्वस्थ रहें\nचिंता मुक्त रहना है तो....!\n"व्यस्त रहें!"\n🪷🙏 जय जय श्री राम 🙏🪷\n🌻🙏 जय जय शनिदेव 🙏\nआपका दिन शुभ एवं मंगलमय हो!!\n🍃🍃🌷 ${b.name} — ${b.place} 🌷🍃🍃`,

      `🌸🌸🌸 सुप्रभात 🌸🌸🌸\n!!~~~~✍️~~~~!!\nमिटाने से मिटते नहीं\n"ये भाग्य के लेख"\nकर्म अच्छे करता चल\n"फिर"\n"ईश्वर" की महिमा देख\n🪷🙏 आपका अपना शो रूम 🙏🪷\n🍃🙏 ${b.name} 🙏🍃\nआपका दिन शुभ एवं मंगलमय हो!\n🪻🌹🥀 ${b.place} 🥀🌹🪻`,

      `☘️☘️‼️ सुप्रभात ‼️☘️☘️\nना किस्सों में है!..✍️..?\nऔर ना किस्तों में है!!\nजिंदगी की खूबसूरती तो..\nचंद सच्चे रिश्तों में है!!\n🙏💐 जय माता दी 💐🙏\n🙏🚩 जय जय श्री राम 🚩🙏\nआपका दिन शुभ एवं मंगलमय हो\n🪂🪂⛲ ${b.name} ⛲🪂🪂\n📍 ${b.place}`,

      `🌅🌅 शुभ प्रभात 🌅🌅\n----------✍️----------\nइंसान के हाथ में सिर्फ़ कोशिश है,\nकामयाबी ईश्वर देता है। 🙏\n🪷🙏 आपका अपना शो रूम 🙏🪷\n🌻🙏 ${b.name} 🙏🌻\nआपका दिन शुभ एवं मंगलमय हो!\n🌹🌷 ${b.place} 🌷🌹`,

      `🌻🌻🌻 सुप्रभात 🌻🌻🌻\n!!~~~~✍️~~~~!!\nजो बीत गया उसे भूल जाइए,\nजो आने वाला है उसका स्वागत कीजिए।\nहर सुबह एक नई शुरुआत है!\n🙏🪷 जय जय हनुमान 🪷🙏\n🙏🚩 जय जय श्री राम 🚩🙏\nआपका दिन शुभ एवं मंगलमय हो!!\n🍃🌺 ${b.name} — ${b.place} 🌺🍃`,

      `🌷🌷💐 शुभ प्रभात 💐🌷🌷\n~~~~~~~~~✍️~~~~~~~~~\nसपने वो नहीं जो नींद में देखे जाएँ,\nसपने वो हैं जो नींद आने न दें।\nउठिए, जागिए, आगे बढ़िए! 💫\n🪷🙏 आपका अपना शो रूम 🙏🪷\n🌻🙏 ${b.name} 🙏🌻\nआपका दिन शुभ एवं मंगलमय हो!!\n🌹🍃 ${b.place} 🍃🌹`,

      `⭐⭐✨ शुभ प्रभात ✨⭐⭐\n----------✍️----------\nकोशिश करने वालों की कभी हार नहीं होती,\nलहरों से डरकर नौका पार नहीं होती।\nआज पूरे जोश के साथ काम करें! 💪\n🙏💐 जय माता दी 💐🙏\n🪷🙏 ${b.name} — ${b.place} 🙏🪷\nआपका दिन शुभ एवं मंगलमय हो!!`,

      `🌺🌺🌺 सुप्रभात 🌺🌺🌺\n^^^^^^^^^✍️^^^^^^^^^\nजहाँ चाह, वहाँ राह।\nईश्वर पर भरोसा रखें,\nमेहनत करते रहें,\nसफलता ज़रूर मिलेगी।\n🙏🚩 जय जय श्री राम 🚩🙏\n🌻🙏 ${b.name} 🙏🌻\nआपका दिन शुभ एवं मंगलमय हो!\n🍃🌷 ${b.place} 🌷🍃`,

      `💫💫🌟 शुभ प्रभात 🌟💫💫\n!!~~~~✍️~~~~!!\nजो अपने मन को जीत लेता है,\nवही दुनिया जीत लेता है।\nआज किसी को मुस्कुराने का कारण दीजिए,\nखुद भी मुस्कुराइए। 😊\n🙏💐 हरिओम 💐🙏\n🪷🙏 ${b.name} 🙏🪷\nआपका दिन शुभ एवं मंगलमय हो!!\n🌹🌹 ${b.place} 🌹🌹`,

      `🌸🌸🌸 सुप्रभात 🌸🌸🌸\n~~~~~~~~~✍️~~~~~~~~~\nछोटी-छोटी खुशियों में जीवन का\nसबसे बड़ा सुख छुपा होता है।\nआज के हर पल को जिएँ।\n🙏🚩 जय जय श्री कृष्ण 🚩🙏\n🪷🙏 आपका अपना शो रूम 🙏🪷\n🌻🙏 ${b.name} 🙏🌻\nआपका दिन शुभ एवं मंगलमय हो!\n🥀🌹 ${b.place} 🌹🥀`,

      `🌻🌻🌻 सुप्रभात 🌻🌻🌻\n----------✍️----------\nहर सुबह एक नई संभावना लेकर आती है।\nआज को अपना सबसे अच्छा दिन बनाएँ!\nसफलता उन्हें मिलती है\nजो हर दिन कोशिश करते हैं। 🌟\n🪷🙏 जय जय हनुमान 🙏🪷\n🌻🙏 ${b.name} — ${b.place} 🙏🌻\nआपका दिन शुभ एवं मंगलमय हो!!`,

      `🌹🌹💫 शुभ प्रभात 💫🌹🌹\n^^^^^^^^^✍️^^^^^^^^^\nअपनी मुस्कान बनाए रखें,\nयही आपकी सबसे बड़ी ताक़त है।\nहर नई सुबह एक तोहफ़ा है,\nइसे ख़ुशी और कृतज्ञता के साथ स्वीकार करें।\n🙏💐 जय माता दी 💐🙏\n🪷🙏 ${b.name} 🙏🪷\nआपका दिन शुभ एवं मंगलमय हो!!\n🍃🌷 ${b.place} 🌷🍃`,
    ],
    vigyapan: [
      `${EM} ${b.name} में ${prod} पर धमाकेदार ऑफर!\n💰 इंस्टेंट कैशबैक + आसान EMI\n📞 अभी कॉल करें: ${b.phone}\n📍 ${b.place}\n${TAGS}`,
      `✨ ${prod} — आपके सपनों की सवारी!\n🔥 सीमित समय का शानदार ऑफर\n💳 Low EMI | Low ROI | Exchange Bonus\n📞 ${b.phone} | 📍 ${b.place}\n${TAGS}`,
      `🎉 ${b.name} में आएं और पाएं:\n✅ आकर्षक छूट व फ्री गिफ्ट\n✅ जल्दी डिलीवरी\n✅ आसान फाइनेंस सुविधा\n📞 ${b.phone} — ${b.place}`,
      `🏆 ${b.name} — ${b.sub}\n${EM} ${prod} अब नई कीमत पर!\n💰 Cashback + Exchange Bonus\n📞 ${b.phone} | 📍 ${b.place}\n${TAGS}`,
    ],
    festival: [(() => { const fe = FEST_BY_NAME(festivalName); const tag = fe ? fe.greet : "आपका हर सफर सुरक्षित और खुशहाल हो।"; return `${festivalName || "त्यौहार"} की हार्दिक शुभकामनाएं!\n${tag}\n— ${b.name} परिवार`; })()],
    suchna: [`आवश्यक सूचना: इस रविवार ${b.place} खुला रहेगा।\nफ्री सर्विस कैंप — सुबह 10 से शाम 6। 📞 ${b.phone}`],
    gift: [`🎁 ${prod} पर आकर्षक गिफ्ट व छूट!\nसीमित समय का ऑफर — 📞 ${b.phone}\n📍 ${b.place}`],
  };
  const arr = bank[type] || bank.suvichar;
  return arr[Math.floor(Math.random() * arr.length)];
}
async function generateText(brandId, type, festivalName, extraCtx) {
  // सुविचार के लिए AI ज़रूरी नहीं — हमारे 20 rich templates काफी हैं, और हर बार अलग
  if (type === "suvichar" && !extraCtx) return templateContent(brandId, "suvichar", festivalName);
  const b = BRANDS[brandId];
  const extra = festivalName ? ` त्यौहार: ${festivalName}.` : "";
  const cmdExtra = extraCtx ? ` विशेष जानकारी: ${extraCtx}. इसे ज़रूर mention करो, खुद कोई price/offer मत बनाओ जो नहीं दी गई हो।` : "";
  const offerExtra = (type === "promo" || type === "vigyapan") && !extraCtx ? " ऑफर: कैशबैक ₹5000*, Low EMI ₹1999/-, ROI @7.99%*, Exchange Bonus ₹2000*, Free Gift, Scratch & Win।" : "";
  const styleV = ["धमाकेदार और exciting", "भावुक और personal", "professional और clean", "urgent और FOMO", "मजेदार और relatable"];
  const sty = styleV[Math.floor(Math.random()*styleV.length)];
  // WhatsApp style suvichar के लिए special prompt
  const suvicharPrompt = `तुम ${brandDesc(b)} (${b.place}) के WhatsApp admin हो।
एक पूरा WhatsApp शुभप्रभात message लिखो जिसमें हो:
1. पहले line में: 🌹🌸🌺 + "शुभप्रभात" + emojis
2. फिर: ----------✍️---------- (separator)
3. फिर: 4-5 lines की हिंदी कविता/सुविचार (पूरी, बीच में मत काटो)
4. फिर: 🪷🙏 आपका अपना शो रूम 🙏🪷
5. फिर: 🌻🙏 ${b.name} 🙏🌻
6. फिर: आपका दिन शुभ एवं मंगलमय हो!!
7. Last line: 🌹🌷 ${b.place} 🌷🌹
Rules: कविता पूरी होनी चाहिए, बीच में मत काटो। Emojis भरपूर use करो। Showroom mention ज़रूर करो।`;

  const promoPrompt = `तुम ${brandDesc(b)} (${b.place}, Phone: ${b.phone}) के WhatsApp marketer हो।
एक exciting promotional message लिखो (Hindi) जिसमें हो:
- 🔥${brandEmoji(b)} emojis के साथ catchy headline
- 2-3 bullet points: offers (EMI, cashback, exchange, gift)
- Dealer name, phone, address mention
- "अभी संपर्क करें" या "आज ही आएं" CTA
- Total 6-8 lines। Emojis भरपूर। पूरा message हो, अधूरा नहीं।`;

  const memCtx = await brandMemoryContext(brandId);
  const memBlock = memCtx ? `\n\n【मालिक की पसंद — इनका पालन करो】\n${memCtx}` : "";
  const prompt = type === "suvichar" || type === "festival" ? suvicharPrompt + cmdExtra + memBlock :
    `तुम ${brandDesc(b)} (${b.sub}, ${b.place}) के social media manager हो।\n` +
    `Products: ${b.products.join(", ")}. Phone: ${b.phone}.${extra}${offerExtra}${cmdExtra}\n` +
    `Style: ${sty}. Post: "${TYPE_LABEL[type]}". नियम: 2-4 Hindi lines, unique, 2-3 emojis, no hashtag, no intro — सिर्फ post text, max 160 chars।${memBlock}`;
  // ── अब सारा text provider-agnostic AI layer से आता है (gemini→openai→groq→ollama) ──
  try {
    const r = await AI.text(prompt, { temperature: 1.0, maxTokens: 400, timeout: 15000 });
    if (r.ok && r.text) return cleanAIText(r.text);
  } catch (e) { log("WARN", "AI.text fail → template", { msg: e.message }); }
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
// hex रंग हल्का करो (3D gradient के लिए)
function lighten(hex, amt) {
  try { const n = parseInt(String(hex).replace("#", ""), 16);
    const r = Math.min(255, (n >> 16) + amt), g = Math.min(255, ((n >> 8) & 255) + amt), b = Math.min(255, (n & 255) + amt);
    return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, "0")}`;
  } catch (_) { return hex; }
}
// आकर्षक address बटन — हर poster के नीचे (gold border pill + pin icon)
function addrBar(b, w, h) {
  const GOLD = b.gold || "#ffd400", DARK = "#141414", ACCENT = b.accent || "#E4002B";
  const uid = "ab" + Math.floor(Math.random() * 1e6);
  const barH = Math.round(h * 0.155), y = h - barH, pad = Math.round(barH * 0.14);
  const bx = Math.round(w * 0.03), bw = w - bx * 2;
  const btnY = y + pad, btnH = barH - pad * 2 - 8, splitX = bx + Math.round(bw * 0.6), rx = btnH / 2, lift = 8;
  const cx = bx + rx + 6, cy = btnY + btnH / 2 - 4, pr = btnH * 0.2;
  const pin = `<path d="M ${cx} ${cy + pr} C ${cx - pr} ${cy - pr * 0.2}, ${cx - pr} ${cy - pr * 1.1}, ${cx} ${cy - pr * 1.1} C ${cx + pr} ${cy - pr * 1.1}, ${cx + pr} ${cy - pr * 0.2}, ${cx} ${cy + pr} Z" fill="${GOLD}"/><circle cx="${cx}" cy="${cy - pr * 0.45}" r="${pr * 0.35}" fill="#fff"/>`;
  return `<rect x="0" y="${y}" width="${w}" height="${barH}" fill="${DARK}"/>`
    + `<defs><linearGradient id="${uid}l" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${lighten(ACCENT, 34)}"/><stop offset="100%" stop-color="${ACCENT}"/></linearGradient><linearGradient id="${uid}r" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#2b2b2b"/><stop offset="100%" stop-color="${DARK}"/></linearGradient></defs>`
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
// Additional festival backgrounds
const FESTIVAL_BG = {
  navratri: (W, H) => `<defs><radialGradient id="nbg" cx="50%" cy="40%" r="70%"><stop offset="0%" stop-color="#fff3e0"/><stop offset="60%" stop-color="#ff6f00"/><stop offset="100%" stop-color="#b71c1c"/></radialGradient></defs>
    <rect width="${W}" height="${H}" fill="url(#nbg)"/>
    <!-- decorative border -->
    <rect x="0" y="0" width="${W}" height="${H}" fill="none" stroke="#ffd400" stroke-width="18" opacity="0.7"/>
    <rect x="20" y="20" width="${W-40}" height="${H-40}" fill="none" stroke="#e65100" stroke-width="6" opacity="0.5"/>
    <!-- top garland -->
    ${Array.from({length:12}, (_,i) => {
      const x = W*0.04 + i*(W*0.92/11);
      return `<circle cx="${x}" cy="${H*0.04}" r="${W*0.022}" fill="${i%2?'#ff6f00':'#ffd400'}"/><line x1="${x}" y1="0" x2="${x}" y2="${H*0.04}" stroke="#e65100" stroke-width="3"/>`;
    }).join('')}`,
  diwali: (W, H) => `<defs><radialGradient id="dbg" cx="50%" cy="50%" r="70%"><stop offset="0%" stop-color="#1a0a00"/><stop offset="100%" stop-color="#4a1a00"/></radialGradient></defs>
    <rect width="${W}" height="${H}" fill="url(#dbg)"/>
    <rect x="0" y="0" width="${W}" height="${H}" fill="none" stroke="#ffd400" stroke-width="20" opacity="0.8"/>
    <!-- diyas -->
    ${Array.from({length:8}, (_,i) => {
      const x = W*0.06 + i*(W*0.88/7), y = H*0.88;
      return `<ellipse cx="${x}" cy="${y}" rx="${W*0.038}" ry="${W*0.016}" fill="#ff6f00" opacity="0.9"/><path d="M ${x} ${y-W*0.015} C ${x+W*0.01} ${y-W*0.07} ${x+W*0.005} ${y-W*0.09} ${x} ${y-W*0.08}" stroke="#ffd400" stroke-width="3" fill="none"/>`;
    }).join('')}`,
  independence: (W, H) => `<defs><linearGradient id="ibg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#ff9933"/><stop offset="33%" stop-color="#ff9933"/><stop offset="33%" stop-color="#ffffff"/><stop offset="66%" stop-color="#ffffff"/><stop offset="66%" stop-color="#138808"/><stop offset="100%" stop-color="#138808"/></linearGradient></defs>
    <rect width="${W}" height="${H}" fill="url(#ibg)" opacity="0.3"/>
    <rect width="${W}" height="${H}" fill="#000c24" opacity="0.75"/>
    <!-- Ashoka chakra hint -->
    <circle cx="${W*0.5}" cy="${H*0.35}" r="${W*0.15}" fill="none" stroke="#0033cc" stroke-width="${W*0.008}" opacity="0.4"/>`,
  raksha: (W, H) => `<defs><radialGradient id="rbg" cx="50%" cy="30%" r="70%"><stop offset="0%" stop-color="#fff0f3"/><stop offset="100%" stop-color="#fce4ec"/></radialGradient></defs>
    <rect width="${W}" height="${H}" fill="url(#rbg)"/>
    <!-- hearts -->
    ${Array.from({length:6}, (_,i) => {
      const x = W*0.1 + i*(W*0.8/5), y = i%2?H*0.08:H*0.06, r = W*0.025;
      return `<path d="M ${x} ${y+r} C ${x-r*1.3} ${y-r*0.4}, ${x-r*0.5} ${y-r*1.1}, ${x} ${y-r*0.3} C ${x+r*0.5} ${y-r*1.1}, ${x+r*1.3} ${y-r*0.4}, ${x} ${y+r} Z" fill="#e91e63" opacity="0.5"/>`;
    }).join('')}`,
};

function readyBgSvg(id, W, H) {
  if (READY_BG[id]) return READY_BG[id](W, H);
  if (FESTIVAL_BG[id]) return FESTIVAL_BG[id](W, H);
  return "";
}
// 3D दो-रंग बटन (label + value)
function btn3d(x, y, bw, bh, label, value, lFill, vFill, vText, lSize, vSize, gold) {
  const GOLD = gold || "#ffd400";
  const rx = bh / 2, split = x + bw * 0.54, lift = bh * 0.08;
  return `<rect x="${x}" y="${y + lift}" width="${bw}" height="${bh}" rx="${rx}" fill="#000" opacity="0.4"/>`
    + `<path d="M ${x + rx} ${y} H ${split} V ${y + bh} H ${x + rx} A ${rx} ${rx} 0 0 1 ${x + rx} ${y} Z" fill="${lFill}"/>`
    + `<path d="M ${split} ${y} H ${x + bw - rx} A ${rx} ${rx} 0 0 1 ${x + bw - rx} ${y + bh} H ${split} Z" fill="${vFill}"/>`
    + `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="${rx}" fill="none" stroke="${GOLD}" stroke-width="2.5"/>`
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
  { id: "goldcard",     label: "🥇 गोल्ड कार्ड" },
  { id: "quote",        label: "💬 सुविचार (कोट)" },
  { id: "sunburst",     label: "☀️ सनबर्स्ट किरणें" },
  { id: "modern",       label: "🔴 मॉडर्न पट्टियाँ" },
  { id: "mandala",      label: "🌸 मंडला आर्क" },
  { id: "temple",       label: "🛕 मंदिर-आर्क (त्यौहार)" },
  { id: "social",       label: "🎊 बधाई कार्ड (confetti)" },
  { id: "boldsplit",    label: "⚡ बोल्ड स्प्लिट (ऑफर)" },
  { id: "frame",        label: "🖼️ एलिगेंट फ्रेम" },
  { id: "megasale",     label: "🔥 महाबचत (Mega Sale)" },
  { id: "festivalfull", label: "🪔 फेस्टिवल ऑफर (Full)" },
  { id: "finance",      label: "💳 फाइनेंस ऑफर (EMI/ROI)" },
  { id: "booking",      label: "📋 बुकिंग महोत्सव" },
  { id: "amc",          label: "🔧 AMC / सर्विस ऑफर" },
  { id: "exchange",     label: "🔄 एक्सचेंज बोनस" },
  { id: "congratsbig",  label: "🎉 बधाई (बड़ा नाम)" },
  { id: "navratri",     label: "🌺 नवरात्रि स्पेशल" },
  { id: "independence", label: "🇮🇳 स्वतंत्रता दिवस" },
  { id: "raksha",       label: "💝 रक्षाबंधन" },
  { id: "newbike",      label: "🏍️ नई गाड़ी लॉन्च" },
];
const DESIGN_ID2IDX = Object.fromEntries(DESIGN_STYLES.map((d, i) => [d.id, i]));
// design चुनें: user value > type-आधारित अच्छा default > random
// ⚠️ ये designs बीच में बड़े डिब्बे/तीर बनाते हैं — लंबे text (सुविचार) पर उसके ऊपर
//    चढ़ जाते थे। इसलिए text-heavy poster पर अब ये अपने आप नहीं चुने जाते।
//    (user खुद चुने तो चलेंगे — तब text के पीछे scrim लग जाता है, नीचे देखें)
const CENTER_HEAVY_DESIGNS = new Set([7, 11, 12, 14, 19]);
const isTextHeavy = (type) => ["suvichar", "festival", "suchna"].includes(type);

function pickDesign(design, type, lineCount) {
  if (design && design !== "auto" && DESIGN_ID2IDX[design] != null) return DESIGN_ID2IDX[design];
  if (design && /^[0-8]$/.test(String(design))) return parseInt(design, 10);
  // auto — text ज़्यादा हो तो सिर्फ़ किनारे सजाने वाले designs में से चुनो
  const heavyText = isTextHeavy(type) || (lineCount || 0) >= 4;
  const pool = [];
  for (let i = 0; i < DESIGN_STYLES.length; i++) {
    if (heavyText && CENTER_HEAVY_DESIGNS.has(i)) continue;
    pool.push(i);
  }
  if (!pool.length) return 0;
  return pool[Math.floor(Math.random() * pool.length)];
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

  // ── नए 11 design styles ─────────────────────────────────────────
  } else if (vnt === 9) { // 🔥 महाबचत — तिरछी red पट्टी + lightning
    vDecor = `<polygon points="0,${h*0.18} ${w*0.7},${h*0.14} ${w*0.8},${h*0.26} ${w*0.1},${h*0.3}" fill="#E4002B" opacity="0.92"/>
      <polygon points="${w*0.2},${h*0.68} ${w},${h*0.62} ${w},${h*0.75} ${w*0.1},${h*0.79}" fill="${gold2}" opacity="0.9"/>
      <polygon points="${w*0.44},${h*0.14} ${w*0.48},${h*0.36} ${w*0.42},${h*0.36} ${w*0.50},${h*0.56} ${w*0.38},${h*0.36} ${w*0.44},${h*0.36} Z" fill="${gold2}" opacity="0.9"/>`;

  } else if (vnt === 10) { // 🪔 फेस्टिवल ऑफर — गेंदे की माला + दीये
    let maala = ""; for (let i=0;i<16;i++) { const x=w*0.04+i*(w*0.92/15); maala+=`<circle cx="${x}" cy="${h*0.07}" r="${w*0.02}" fill="${i%2?"#ff6f00":"#E4002B"}"/><line x1="${x}" y1="0" x2="${x}" y2="${h*0.07}" stroke="#8B4513" stroke-width="3"/>`; }
    let diyas = ""; for (let i=0;i<5;i++) { const x=w*0.1+i*(w*0.8/4); diyas+=`<ellipse cx="${x}" cy="${h*0.88}" rx="${w*0.04}" ry="${w*0.018}" fill="#ff6f00"/><path d="M ${x} ${h*0.88-w*0.018} C ${x+w*0.01} ${h*0.88-w*0.08} ${x+w*0.005} ${h*0.88-w*0.1} ${x} ${h*0.88-w*0.09}" stroke="${gold2}" stroke-width="4" fill="none"/>`; }
    vDecor = maala + diyas + `<rect x="0" y="0" width="${w}" height="${h}" fill="none" stroke="${gold2}" stroke-width="16" opacity="0.8"/>`;

  } else if (vnt === 11) { // 💳 फाइनेंस — 4 info boxes (EMI/ROI/Loan/Cashback style)
    const bx = (x,y,bw,bh,fill,stroke,r) => `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" rx="${r||10}" fill="${fill}" stroke="${stroke}" stroke-width="3"/>`;
    const half = w*0.44; const boxH = h*0.13; const gap = w*0.04;
    vDecor = bx(gap,h*0.22,half,boxH,"#E4002B","#fff",10) + bx(w-gap-half,h*0.22,half,boxH,"#141414",gold2,10)
           + bx(gap,h*0.22+boxH+gap,half,boxH,"#141414",gold2,10) + bx(w-gap-half,h*0.22+boxH+gap,half,boxH,"#1565c0","#fff",10)
           + `<rect x="0" y="${h*0.19}" width="${w}" height="${h*0.02}" fill="${gold2}" opacity="0.5"/>`;

  } else if (vnt === 12) { // 📋 बुकिंग महोत्सव — arch + benefits list style
    const ax=w*0.5, top=h*0.15, aw=w*0.82, ah=h*0.65;
    vDecor = `<path d="M ${ax-aw/2} ${top+ah} V ${top+ah*0.32} Q ${ax-aw/2} ${top} ${ax} ${top} Q ${ax+aw/2} ${top} ${ax+aw/2} ${top+ah*0.32} V ${top+ah}" fill="#E4002B" fill-opacity="0.08" stroke="${gold2}" stroke-width="6" opacity="0.9"/>
      <circle cx="${ax}" cy="${top}" r="${w*0.06}" fill="${gold2}" opacity="0.9"/>
      <text x="${ax}" y="${top+w*0.025}" text-anchor="middle" font-family="Arial" font-size="${w*0.05}" font-weight="900" fill="#141414">📋</text>`;

  } else if (vnt === 13) { // 🔧 AMC/Service — shield shape + checkmarks
    const sh = (x,y,r) => `<path d="M ${x} ${y-r} L ${x+r*0.7} ${y-r*0.5} L ${x+r*0.7} ${y+r*0.2} Q ${x} ${y+r} ${x-r*0.7} ${y+r*0.2} L ${x-r*0.7} ${y-r*0.5} Z" fill="#1565c0" stroke="${gold2}" stroke-width="3"/>`;
    vDecor = sh(w*0.15,h*0.3,w*0.1) + sh(w*0.85,h*0.3,w*0.1)
           + `<rect x="${w*0.1}" y="${h*0.78}" width="${w*0.8}" height="${h*0.06}" rx="8" fill="#E4002B" opacity="0.85"/>`;

  } else if (vnt === 14) { // 🔄 एक्सचेंज — old→new arrows + comparison boxes
    vDecor = `<rect x="${w*0.05}" y="${h*0.25}" width="${w*0.38}" height="${h*0.48}" rx="12" fill="#ff4444" fill-opacity="0.15" stroke="#ff4444" stroke-width="3"/>
      <rect x="${w*0.57}" y="${h*0.25}" width="${w*0.38}" height="${h*0.48}" rx="12" fill="#16a34a" fill-opacity="0.15" stroke="#16a34a" stroke-width="3"/>
      <polygon points="${w*0.44},${h*0.49} ${w*0.56},${h*0.49} ${w*0.56},${h*0.455} ${w*0.6},${h*0.495} ${w*0.56},${h*0.535} ${w*0.56},${h*0.51} ${w*0.44},${h*0.51}" fill="${gold2}"/>`;

  } else if (vnt === 15) { // 🎉 बधाई बड़ा नाम — Surana Honda congratulations style
    let conf=""; const cc=["#ff2d78","#ffd400","#16a34a","#1565c0","#9b51e0","#fff","#E4002B"];
    for(let i=0;i<30;i++){conf+=`<rect x="${(i*83)%w}" y="${(i*47)%(h*0.25)}" width="${w*0.015}" height="${w*0.015}" rx="2" fill="${cc[i%7]}" transform="rotate(${i*35} ${(i*83)%w} ${(i*47)%(h*0.25)})"/>`;}
    vDecor = conf + `<rect x="${w*0.06}" y="${h*0.32}" width="${w*0.88}" height="${h*0.12}" rx="10" fill="#E4002B" opacity="0.9"/>
      <rect x="${w*0.06}" y="${h*0.68}" width="${w*0.88}" height="${h*0.08}" rx="8" fill="${gold2}" opacity="0.9"/>`;

  } else if (vnt === 16) { // 🌺 नवरात्रि — bell garland + marigold colors
    let garland=""; for(let i=0;i<10;i++){const x=w*0.05+i*(w*0.9/9); garland+=`<line x1="${x}" y1="0" x2="${x}" y2="${h*0.08}" stroke="#8B4513" stroke-width="2"/><path d="M ${x-w*0.022} ${h*0.08} Q ${x} ${h*0.055} ${x+w*0.022} ${h*0.08} Q ${x+w*0.022} ${h*0.12} ${x} ${h*0.12} Q ${x-w*0.022} ${h*0.12} ${x-w*0.022} ${h*0.08}" fill="${gold2}"/><circle cx="${x}" cy="${h*0.13}" r="${w*0.012}" fill="${gold2}"/>`;}
    vDecor = garland + `<rect x="0" y="0" width="${w}" height="${h}" fill="none" stroke="#ff6f00" stroke-width="20" opacity="0.7"/>
      <rect x="16" y="16" width="${w-32}" height="${h-32}" fill="none" stroke="${gold2}" stroke-width="8" opacity="0.5"/>`;

  } else if (vnt === 17) { // 🇮🇳 स्वतंत्रता दिवस — tricolor strips
    vDecor = `<rect x="0" y="0" width="${w}" height="${h*0.08}" fill="#ff9933" opacity="0.9"/>
      <rect x="0" y="${h*0.08}" width="${w}" height="${h*0.08}" fill="#fff" opacity="0.9"/>
      <rect x="0" y="${h*0.16}" width="${w}" height="${h*0.08}" fill="#138808" opacity="0.9"/>
      <circle cx="${w*0.5}" cy="${h*0.12}" r="${w*0.04}" fill="#003399" opacity="0.7"/>
      <rect x="0" y="${h*0.92}" width="${w}" height="${h*0.08}" fill="#ff9933" opacity="0.9"/>`;

  } else if (vnt === 18) { // 💝 रक्षाबंधन — soft pink + hearts + rakhi
    let hearts=""; for(let i=0;i<8;i++){const x=w*0.05+i*(w*0.9/7),y=i%2?h*0.08:h*0.05,r=w*0.02; hearts+=`<path d="M ${x} ${y+r} C ${x-r*1.3} ${y-r*0.4}, ${x-r*0.5} ${y-r*1.1}, ${x} ${y-r*0.3} C ${x+r*0.5} ${y-r*1.1}, ${x+r*1.3} ${y-r*0.4}, ${x} ${y+r} Z" fill="#e91e63" opacity="0.6"/>`;}
    vDecor = hearts + `<rect x="${w*0.08}" y="${h*0.25}" width="${w*0.84}" height="${h*0.52}" rx="20" fill="none" stroke="#e91e63" stroke-width="4" opacity="0.5" stroke-dasharray="12 8"/>`;

  } else if (vnt === 19) { // 🏍️ नई गाड़ी लॉन्च — NEW badge + spotlight
    let spots=""; for(let i=0;i<4;i++){const a=(i*90+45)*Math.PI/180; spots+=`<line x1="${w*0.5}" y1="${h*0.5}" x2="${w*0.5+Math.cos(a)*w*0.8}" y2="${h*0.5+Math.sin(a)*h*0.8}" stroke="#ffd400" stroke-width="${w*0.025}" opacity="0.08"/>`;}
    // ⚠️ बैज नीचे-बाएँ किया — पहले यह ऊपर-दाएँ logo के ठीक नीचे चढ़ जाता था
    vDecor = spots + `<rect x="${w*0.04}" y="${h*0.80}" width="${w*0.26}" height="${h*0.11}" rx="8" fill="#E4002B"/>
      <text x="${w*0.17}" y="${h*0.845}" text-anchor="middle" font-family="Arial" font-size="${w*0.038}" font-weight="900" fill="#fff">NEW</text>
      <text x="${w*0.17}" y="${h*0.888}" text-anchor="middle" font-family="Arial" font-size="${w*0.024}" font-weight="700" fill="${gold2}">LAUNCH</text>`;
  }
  return vDecor;
}
function buildSVG(brandId, text, w, h, type, opts) {
  const b = BRANDS[brandId];
  const festive = type === "festival" || type === "gift";
  const gold = b.gold || "#ffd400";
  // ── SAFE ZONE ──────────────────────────────────────────────────
  //   ऊपर  : brand bar + logo पट्टी      (h*0.24 तक कुछ नहीं लिखना)
  //   नीचे  : address bar                (h*0.78 के नीचे कुछ नहीं लिखना)
  //   बाएँ/दाएँ : sticker rails            (text सिर्फ़ बीच के 68% में)
  const SAFE_TOP = h * 0.245, SAFE_BOT = h * 0.775;
  const SAFE_H = SAFE_BOT - SAFE_TOP;
  const TEXT_W = w * 0.68;

  const clean = stripEmoji(text);
  // font अपने आप छोटा करो जब तक पूरा text safe zone में न आ जाए
  let fontSize = Math.round(w / 16), lines = [], lineGap = 0;
  const MIN_FONT = Math.round(w / 30);
  for (let f = fontSize; f >= MIN_FONT; f -= 2) {
    const mc = Math.max(10, Math.floor(TEXT_W / (f * 0.58)));
    const ls = wrapLines(clean, mc);
    const gap = Math.round(f * 1.3);
    if (ls.length * gap <= SAFE_H || f === MIN_FONT) {
      fontSize = f; lines = ls; lineGap = gap; break;
    }
  }
  // इतना भी लंबा हो कि सबसे छोटे font में भी न समाए → आख़िर में … लगाकर काटो
  const maxLines = Math.max(3, Math.floor(SAFE_H / lineGap));
  if (lines.length > maxLines) {
    lines = lines.slice(0, maxLines);
    lines[maxLines - 1] = lines[maxLines - 1].replace(/[\s,;।]+$/, "") + " …";
    log("WARN", "[POSTER] text बहुत लंबा था, काटा गया", { lines: maxLines, brand: brandId });
  }
  // safe zone के बीचोंबीच रखो
  const blockH = lines.length * lineGap;
  const startY = SAFE_TOP + (SAFE_H - blockH) / 2 + fontSize * 0.8;
  const tspans = lines.map((l, i) => `<text x="50%" y="${startY + i * lineGap}" text-anchor="middle" font-family="Noto Sans Devanagari, Mukta, sans-serif" font-size="${fontSize}" font-weight="700" fill="#fff">${esc(l)}</text>`).join("");
  // festival/gift पर हल्के सजावटी गोले
  const decor = festive
    ? `<circle cx="${w * 0.12}" cy="${h * 0.3}" r="${w * 0.012}" fill="${gold}" fill-opacity="0.8"/>
       <circle cx="${w * 0.88}" cy="${h * 0.32}" r="${w * 0.016}" fill="${gold}" fill-opacity="0.7"/>
       <circle cx="${w * 0.2}" cy="${h * 0.7}" r="${w * 0.01}" fill="${gold}" fill-opacity="0.6"/>
       <circle cx="${w * 0.82}" cy="${h * 0.68}" r="${w * 0.013}" fill="${gold}" fill-opacity="0.7"/>` : "";
  const acc1 = (opts && opts.themeColor) || b.accent;
  const acc2 = (opts && opts.themeColor2) || b.accent2;
  const gold2 = b.gold || "#ffd400";
  // 9 named design styles. user opts.design दे तो वही; वरना पुराना random (अब 9 में से) — backward-compatible
  const vnt = pickDesign(opts && opts.design, type, lines.length);
  const vDecor = designDecor(vnt, w, h, gold2);
  // ⚠️ अगर text लंबा है या user ने बीच वाला design खुद चुना है तो text के पीछे
  //    हल्का पैनल लगाओ — इससे कोई भी सजावट पीछे रह जाती है और शब्द साफ़ पढ़े जाते हैं
  const needScrim = lines.length >= 4 || CENTER_HEAVY_DESIGNS.has(vnt);
  const textScrim = needScrim
    ? `<rect x="${w * 0.10}" y="${startY - fontSize * 1.35}" width="${w * 0.80}" height="${blockH + fontSize * 1.1}" rx="${w * 0.035}" fill="#000" fill-opacity="0.28"/>`
    : "";
  return Buffer.from(`<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    ${(opts && opts.bg && opts.bg !== "auto") ? readyBgSvg(opts.bg, w, h) : `<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="${acc1}"/><stop offset="100%" stop-color="${acc2}"/></linearGradient></defs><rect width="${w}" height="${h}" fill="url(#bg)"/>`}
    ${decor}
    ${vDecor}
    <!-- top brand bar -->
    <rect x="0" y="0" width="${w}" height="${h * 0.11}" fill="#000" fill-opacity="0.25"/>
    <text x="${w * 0.5}" y="${h * 0.078}" text-anchor="middle" font-family="Noto Sans Devanagari, Mukta, sans-serif" font-size="${Math.round(w / 26)}" font-weight="700" fill="#fff">${esc(b.name)}</text>
    <rect x="${w * 0.5 - w * 0.06}" y="${h * 0.16}" width="${w * 0.12}" height="6" rx="3" fill="${festive ? gold : "#fff"}"/>
    ${textScrim}
    ${tspans}
    <!-- आकर्षक address बटन (हर poster में सबसे नीचे) -->
    ${addrBar(b, w, h)}
    <text x="${w * 0.95}" y="${h * 0.86}" text-anchor="end" font-family="Mukta, sans-serif" font-size="${Math.round(w / 55)}" fill="#ffd54f" fill-opacity="0.9">AI Generated</text>
    <!-- ⚠️ stickers/decor सिर्फ़ किनारे की rails में — text के ऊपर कभी नहीं -->
    ${opts && opts.sticker ? stickersSVG(opts.sticker, opts.offer, {}, w, h, SAFE_RAILS, w * 0.072) : ""}
    ${opts && opts.decor ? decorSVG(opts.decor, w, h, w * 0.032, SAFE_DECOR_SLOTS) : ""}
    ${opts && opts.autoDecor ? autoDecorLayer(opts.autoSeed || text, {}, w, h) : ""}</svg>`);
}
// दाईं तरफ़ लगने वाला कंपनी (OEM) logo — file मालिक की अपनी, App से चुनी हुई
async function loadLogo(brandId, size) {
  const b = BRANDS[brandId];
  const { company } = await resolveLogos(brandId);
  if (!company) return null;          // कोई file नहीं → कुछ मत छापो
  const p = path.join(LOGO_DIR, company);
  if (!fs.existsSync(p)) return null;
  try {
    // logoCutout=false (Mini Metro) → सफ़ेद outline design का हिस्सा है, सिर्फ़ resize करो
    if (b.logoCutout === false) {
      const plain = await sharp(p).resize(size, size, { fit: "inside" }).png().toBuffer();
      return b.logoOnLight ? await logoChip(plain, size) : plain;
    }
    const cut = await removeWhiteBg(p, size, size); // सफ़ेद डिब्बा हटाकर साफ़ logo
    return b.logoOnLight ? await logoChip(cut, size) : cut;
  } catch (_) {
    try { return await sharp(p).resize(size, size, { fit: "inside" }).png().toBuffer(); } catch (e) { return null; }
  }
}
// बाईं तरफ़ मालिक का अपना logo
async function loadOwnerLogo(size, brandId) {
  if (!SHOW_OWNER_LOGO) return null;
  const { owner } = await resolveLogos(brandId || "vp_honda");
  if (!owner) return null;
  const p = path.join(LOGO_DIR, owner);
  if (!fs.existsSync(p)) return null;   // file न हो तो चुपचाप skip — कुछ टूटेगा नहीं
  try { return await sharp(p).resize(size, size, { fit: "inside" }).png().toBuffer(); }
  catch (e) { log("WARN", "owner logo load fail", { msg: e.message }); return null; }
}

// किसी भी तैयार image पर दोनों logo चिपकाओ:  बाएँ = मालिक का, दाएँ = brand/कंपनी का
async function composeLogos(baseBuf, brandId, w, h, sizeFrac = 0.16, topFrac = 0.022) {
  try {
    const size = Math.round(w * sizeFrac);
    const top = Math.round(h * topFrac);
    const pad = Math.round(w * 0.03);
    const parts = [];

    const owner = await loadOwnerLogo(size, brandId);
    if (owner) parts.push({ input: owner, top, left: pad });          // ← बाएँ

    const brandLogo = await loadLogo(brandId, size);
    if (brandLogo) {
      const m = await sharp(brandLogo).metadata();
      const bw = m.width || size;
      parts.push({ input: brandLogo, top, left: Math.max(0, w - pad - bw) }); // दाएँ →
    }
    if (!parts.length) return baseBuf;
    return await sharp(baseBuf).composite(parts).png().toBuffer();
  } catch (e) { log("WARN", "composeLogos fail", { msg: e.message }); return baseBuf; }
}

// ── हर video के लिए header पट्टी (PNG) बनाओ — बाएँ आपका logo, दाएँ कंपनी का ──
//    ⚠️ पहले सिर्फ़ photos पर logo लगता था, videos पर नहीं। अब दोनों पर लगता है।
const _headerCache = new Map();
async function videoHeaderPNG(brandId, w, h) {
  const key = `${brandId}:${w}x${h}`;
  if (_headerCache.has(key)) return _headerCache.get(key);
  try {
    const b = BRANDS[brandId];
    const barH = Math.round(h * 0.105);
    const size = Math.round(barH * 0.86);
    const pad = Math.round(w * 0.025);

    const bar = Buffer.from(
      `<svg width="${w}" height="${barH}" xmlns="http://www.w3.org/2000/svg">
        <defs><linearGradient id="hb" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#000" stop-opacity="0.72"/>
          <stop offset="100%" stop-color="#000" stop-opacity="0.34"/></linearGradient></defs>
        <rect width="${w}" height="${barH}" fill="url(#hb)"/>
        <rect x="0" y="${barH - 4}" width="${w}" height="4" fill="${b.accent}"/>
        <text x="${w / 2}" y="${barH * 0.62}" text-anchor="middle"
          font-family="Noto Sans Devanagari, Mukta, sans-serif" font-size="${Math.round(barH * 0.38)}"
          font-weight="700" fill="#fff">${esc(b.name)}</text>
       </svg>`);

    const parts = [];
    const owner = await loadOwnerLogo(size, brandId);
    if (owner) parts.push({ input: owner, top: Math.round((barH - size) / 2), left: pad });
    const brandLogo = await loadLogo(brandId, size);
    if (brandLogo) {
      const m = await sharp(brandLogo).metadata();
      parts.push({ input: brandLogo, top: Math.round((barH - (m.height || size)) / 2), left: Math.max(0, w - pad - (m.width || size)) });
    }
    const png = await sharp(bar).composite(parts).png().toBuffer();

    // पूरे frame जितनी transparent परत — ffmpeg सीधे overlay कर सके
    const full = await sharp({ create: { width: w, height: h, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: png, top: 0, left: 0 }]).png().toBuffer();

    const file = path.join(OUT_DIR, `_hdr_${brandId}_${w}x${h}.png`);
    fs.writeFileSync(file, full);
    _headerCache.set(key, file);
    return file;
  } catch (e) { log("WARN", "videoHeaderPNG fail", { msg: e.message }); return null; }
}

// किसी भी बनी हुई video पर header चिपकाओ
async function stampVideoHeader(videoPath, brandId, w, h) {
  const hdr = await videoHeaderPNG(brandId, w, h);
  if (!hdr) return videoPath;
  const out = videoPath.replace(/\.mp4$/, "_hdr.mp4");
  try {
    await new Promise((res, rej) => {
      execFile("ffmpeg", ["-y", "-i", videoPath, "-i", hdr,
        "-filter_complex", "[0:v][1:v]overlay=0:0[v]",
        "-map", "[v]", ...(fs.existsSync(videoPath) ? [] : []),
        "-map", "0:a?", "-c:a", "copy", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23", out],
        { maxBuffer: 1024 * 1024 * 20 },
        (e, _o, se) => (e ? rej(new Error(String(se || e.message).slice(0, 200))) : res()));
    });
    try { fs.unlinkSync(videoPath); } catch (_) {}
    fs.renameSync(out, videoPath);
    return videoPath;
  } catch (e) { log("WARN", "stampVideoHeader fail — बिना header ही रहने दिया", { msg: e.message }); return videoPath; }
}

// गहरे रंग का logo (Mini Metro नेवी) dark poster पर गायब हो जाता है — सफ़ेद गोल chip के ऊपर रखो
async function logoChip(logoBuf, size) {
  try {
    const m = await sharp(logoBuf).metadata();
    const lw = m.width || size, lh = m.height || size;
    const pad = Math.round(size * 0.10);
    const cw = lw + pad * 2, chh = lh + pad * 2, r = Math.round(Math.min(cw, chh) * 0.22);
    const plate = Buffer.from(`<svg width="${cw}" height="${chh}" xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="${cw}" height="${chh}" rx="${r}" fill="#ffffff" fill-opacity="0.94"/></svg>`);
    return await sharp(plate).composite([{ input: logoBuf, top: pad, left: pad }]).png().toBuffer();
  } catch (_) { return logoBuf; }
}
async function generateImages(brandId, id, text, type, opts) {
  const sizes = { square: [1080, 1080], story: [1080, 1920], landscape: [1200, 630] };
  const out = {}; const b64 = {};
  for (const [k, [w, h]] of Object.entries(sizes)) {
    const f = `${id}_${k}.png`;
    let base = await sharp(buildSVG(brandId, text, w, h, type, opts)).png().toBuffer();
    // बाएँ = मालिक का logo, दाएँ = brand का logo
    base = await composeLogos(base, brandId, w, h, 0.16, 0.022);
    const { buf: cBuf } = await compressImage(base);
    fs.writeFileSync(path.join(OUT_DIR, f), cBuf);
    out[k] = `/generated/${f}`;
    // compressed buffer से b64 — memory कम लगेगी
    if (k === "square" || k === "story") b64[k] = "data:image/png;base64," + cBuf.toString("base64");
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
  cashback:   { l1: "कैशबैक", amt: "cashback" },
  lowdp:      { l1: "कम डाउन", amt: "downPayment", l2def: "पेमेंट" },
  exchange:   { l1: "एक्सचेंज", l2def: "बोनस" },
  student:    { l1: "स्टूडेंट", l2def: "स्पेशल" },
  newyear:    { l1: "नया साल", l2def: "ऑफर" },
  festival:   { l1: "फेस्टिव", l2def: "ऑफर" },
  freegift:   { l1: "फ्री", l2def: "गिफ्ट" },
  // नए offers — Honda dealer style
  emi:        { l1: "Low EMI", l2def: "₹1999/-" },
  roi:        { l1: "Low ROI", l2def: "@7.99%*" },
  loan100:    { l1: "Loan up to", l2def: "100%*" },
  nagad:      { l1: "नगद छूट", l2def: "₹5000*" },
  smartwatch: { l1: "Free", l2def: "SmartWatch" },
  corporate:  { l1: "Corporate", l2def: "Discount" },
  scratchwin: { l1: "Scratch", l2def: "& Win" },
  amc:        { l1: "AMC Free", l2def: "1 साल" },
  service:    { l1: "Free", l2def: "Service" },
  insurance:  { l1: "Insurance", l2def: "Free" },
  booking:    { l1: "Booking", l2def: "Open" },
  megasale:   { l1: "महाबचत", l2def: "महीना" },
  warranty:   { l1: "Extended", l2def: "Warranty" },
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
  const banks = (o.banks || []).length ? (o.banks || []).slice(0, 5) : (b.financePartners || []).slice(0, 5);
  const OEM = b.oem || (b.name || "").toUpperCase();
  const cashbackPartner = o.cashbackPartner || "";
  let s = `<defs>
    <pattern id="diag" width="32" height="32" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="32" height="32" fill="#f7f7f7"/><line x1="0" y1="0" x2="0" y2="32" stroke="#e8e8e8" stroke-width="5"/></pattern>
    <filter id="sh"><feDropShadow dx="3" dy="5" stdDeviation="6" flood-color="#00000022"/></filter>
  </defs>
  <rect width="${W}" height="${H}" fill="url(#diag)"/>
  <rect x="0" y="0" width="${W}" height="${H * 0.006}" fill="${ACCENT}"/>`;
  // OEM badge top-right (brand अनुसार: HONDA / YAKUZA / MINI METRO)
  s += `<rect x="${W * 0.80}" y="${H * 0.022}" width="${W * 0.18}" height="${H * 0.058}" rx="8" fill="${ACCENT}"/><text x="${W * 0.89}" y="${H * 0.061}" text-anchor="middle" font-family="Arial Black,sans-serif" font-size="${W * (OEM.length > 8 ? 0.020 : 0.028)}" font-weight="900" fill="${WHITE}">${esc(OEM)}</text>`;
  // Model name italic
  s += `<text x="${W * 0.04}" y="${H * 0.135}" font-family="Arial,sans-serif" font-size="${W * 0.072}" font-weight="900" font-style="italic" fill="${DARK}" filter="url(#sh)">${model}</text>`;
  s += `<rect x="${W * 0.04}" y="${H * 0.148}" width="${W * 0.34}" height="${H * 0.007}" rx="3" fill="${ACCENT}"/>`;
  // Tagline — पेट्रोल पर "SOLID माइलेज़", EV पर "दमदार रेंज"
  const tagA = b.kind === "ice2w" ? "SOLID " : b.kind === "ev2w" ? "LONG " : "STRONG ";
  const tagB = b.kind === "ice2w" ? "माइलेज़" : b.kind === "ev2w" ? "रेंज" : "लोड क्षमता";
  s += `<text x="${W * 0.04}" y="${H * 0.208}"><tspan font-family="Arial Black,sans-serif" font-size="${W * 0.06}" font-weight="900" fill="${ACCENT}">${tagA}</tspan><tspan font-family="Noto Sans Devanagari,Arial,sans-serif" font-size="${W * 0.054}" font-weight="800" fill="${DARK}">${tagB}</tspan></text>`;
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
  // Cashback partner (right side) — सिर्फ़ तब दिखाओ जब सच में दिया गया हो (fake claim से बचाव)
  if (cashbackPartner) {
    s += `<rect x="${W * 0.62}" y="${finY}" width="${W * 0.38}" height="${H * 0.044}" fill="#e8e8e8"/>
      <text x="${W * 0.645}" y="${finY + H * 0.015}" font-family="Arial,sans-serif" font-size="${W * 0.018}" font-weight="600" fill="${DARK}">कैशबैक पार्टनर*</text>
      <rect x="${W * 0.72}" y="${finY + H * 0.018}" width="${W * 0.24}" height="${H * 0.024}" rx="4" fill="${ACCENT}"/>
      <text x="${W * 0.84}" y="${finY + H * 0.034}" text-anchor="middle" font-family="Arial Black,sans-serif" font-size="${W * 0.018}" font-weight="900" fill="${WHITE}">${esc(cashbackPartner)}</text>`;
  }
  // Dealer bar
  s += `<rect x="0" y="${H * 0.95}" width="${W}" height="${H * 0.05}" fill="${DARK}"/>
    <text x="${W * 0.5}" y="${H * 0.985}" text-anchor="middle" font-family="Noto Sans Devanagari,Arial,sans-serif" font-size="${W * 0.03}" font-weight="800" fill="${WHITE}">${esc(b.name)},  फ़ोन ${esc(b.phone)}  —  ${esc(b.place)}</text>`;
  return Buffer.from(`<svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">${s}</svg>`);
}
// safe corner slots — logo बाएँ-ऊपर (x:0.04-0.22, y:0.025-0.21) है, brand-name दाएँ-ऊपर है, address-bar नीचे है
// इसलिए: slot[0]=दाएँ-ऊपर (logo नहीं है वहाँ), slot[1]=बाएँ-नीचे, slot[2]=दाएँ-नीचे, slot[3]=बाएँ-बीच
// ⚠️ सारे sticker/decor की जगहें अब सिर्फ़ किनारों पर हैं।
//    text बीच के 68% में रहता है (x: 0.16–0.84), इसलिए ये उस पर कभी नहीं चढ़ते।
//    y भी 0.28–0.72 के बीच ही — ऊपर logo पट्टी और नीचे address bar बचा रहे।
const RAIL_L = 0.085, RAIL_R = 0.915;
const SAFE_RAILS = [[RAIL_L, 0.34], [RAIL_R, 0.34], [RAIL_R, 0.63]];
const SAFE_DECOR_SLOTS = [[RAIL_L, 0.50], [RAIL_R, 0.50], [RAIL_L, 0.68], [RAIL_R, 0.68]];
const AUTO_SLOTS = [[RAIL_R, 0.33], [RAIL_L, 0.33], [RAIL_R, 0.66], [RAIL_L, 0.66], [RAIL_R, 0.50], [RAIL_L, 0.50], [RAIL_L, 0.42]];
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
  const r1 = w * 0.072, r2 = w * 0.034;   // ⚠️ छोटा किया — rail में पूरा समाए, बाहर न निकले
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
  const bankLine = (o.banks && o.banks.length) ? o.banks.join("   •   ") : (b.financePartners || []).join("   •   ");
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
    const res = await fetch(url, { signal: AbortSignal.timeout(25000) });
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
    const svgBuf = o.layout === "official" || o.layout === "honda_official"
      ? buildHondaOfficialSVG(brandId, o, w, h) : buildPromoSVG(brandId, o, w, h);
    const overlay = await sharp(svgBuf).png().toBuffer();
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
    // बाएँ = मालिक का logo, दाएँ = brand का logo
    frame = await composeLogos(frame, brandId, w, h, 0.13, 0.02);
    const f = `${id}_${k}.png`;
    { const rawBuf2 = await sharp(frame).png().toBuffer(); const { buf: cBuf2 } = await compressImage(rawBuf2); fs.writeFileSync(path.join(OUT_DIR, f), cBuf2); }
    out[k] = `/generated/${f}`;
  }
  const fL = `${id}_landscape.png`;
  { const lBuf = await sharp(path.join(OUT_DIR, `${id}_square.png`)).resize(1200, 630, { fit: "contain", background: { r: 242, g: 242, b: 242 } }).png().toBuffer(); const { buf: lC } = await compressImage(lBuf); fs.writeFileSync(path.join(OUT_DIR, fL), lC); }
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
  const ownerBig = await loadOwnerLogo(360, brandId);
  let s1 = await sharp(delivSlideSVG(brandId, dtext(540, 1180, 84, "New Delivery 🎉"), bg)).png().toBuffer();
  // intro slide: दोनों logo साथ-साथ (बाएँ मालिक का, दाएँ कंपनी का)
  {
    const parts = [];
    if (ownerBig) parts.push({ input: await sharp(ownerBig).resize(300, 300, { fit: "inside" }).png().toBuffer(), top: 640, left: 110 });
    if (bigLogo) { const bl = await sharp(bigLogo).resize(300, 300, { fit: "inside" }).png().toBuffer(); const m = await sharp(bl).metadata(); parts.push({ input: bl, top: 640, left: 970 - (m.width || 300) }); }
    if (parts.length) s1 = await sharp(s1).composite(parts).png().toBuffer();
  }
  await sharp(s1).toFile(path.join(OUT_DIR, `${id}_s1.png`));
  // 2) main — customer photo + congrats
  const base = sharp(delivSlideSVG(brandId, dtext(540, 300, 64, "Congratulations") + dtext(540, 390, 76, d.customerName || "") + dtext(540, 1480, 56, d.bikeName || ""), bg));
  let photoBuf;
  try { photoBuf = await sharp(photoPath).resize(800, 800, { fit: "cover" }).png().toBuffer(); }
  catch (_) { photoBuf = await sharp({ create: { width: 800, height: 800, channels: 3, background: "#222" } }).png().toBuffer(); }
  const smallLogo = await loadLogo(brandId, 150);
  const ownerSmall = await loadOwnerLogo(150, brandId);
  const mainParts = [{ input: photoBuf, top: 520, left: 140 }];
  if (ownerSmall) mainParts.push({ input: ownerSmall, top: 40, left: 40 });          // ← बाएँ
  if (smallLogo) {
    const m = await sharp(smallLogo).metadata();
    mainParts.push({ input: smallLogo, top: 40, left: 1080 - 40 - (m.width || 150) }); // दाएँ →
  }
  await base.composite(mainParts).png().toFile(path.join(OUT_DIR, `${id}_s2.png`));
  await sharp(path.join(OUT_DIR, `${id}_s2.png`)).resize(1080, 1080, { fit: "cover", position: "top" }).png().toFile(path.join(OUT_DIR, `${id}_square.png`));
  await sharp(path.join(OUT_DIR, `${id}_s2.png`)).resize(1200, 630, { fit: "cover" }).png().toFile(path.join(OUT_DIR, `${id}_landscape.png`));
  // 3) offer
  await sharp(delivSlideSVG(brandId, dtext(540, 900, 80, d.offer || "विशेष ऑफर 🎁") + dtext(540, 1020, 60, "सीमित समय के लिए"), bg)).png().toFile(path.join(OUT_DIR, `${id}_s3.png`));
  // 4) outro — logo + call now
  let s4 = await sharp(delivSlideSVG(brandId, dtext(540, 1180, 68, "कॉल करें") + dtext(540, 1290, 88, b.phone), bg)).png().toBuffer();
  {
    const parts = [];
    if (ownerBig) parts.push({ input: await sharp(ownerBig).resize(300, 300, { fit: "inside" }).png().toBuffer(), top: 580, left: 110 });
    if (bigLogo) { const bl = await sharp(bigLogo).resize(300, 300, { fit: "inside" }).png().toBuffer(); const m = await sharp(bl).metadata(); parts.push({ input: bl, top: 580, left: 970 - (m.width || 300) }); }
    if (parts.length) s4 = await sharp(s4).composite(parts).png().toBuffer();
  }
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
//  PRD #44 — AUDIT LOG
//  हर वो काम जिसमें पैसा, offer, ग्राहक या publishing शामिल है — यहाँ लिखा जाए
// ===========================================================================
async function audit(req, { brand, action, entity, entityId, summary, before, after }) {
  try {
    const u = req?.user;
    await AuditLog.create({
      brand: brand || "-",
      action, entity, entityId: entityId ? String(entityId) : undefined,
      actor: u ? `${u.name || u.email || u.id}` : "system/cron",
      actorRole: u?.role || "system",
      summary: summary || "",
      before, after,
      ip: req?.headers?.["x-forwarded-for"]?.split(",")[0]?.trim() || req?.ip || "",
    });
  } catch (e) { log("WARN", "audit write fail", { msg: e.message }); }
}

// ===========================================================================
//  PRD #45 — RATE LIMITING (कोई नई dependency नहीं, memory-based)
//  Render का एक ही instance होता है, इसलिए memory काफ़ी है।
// ===========================================================================
const _buckets = new Map();
setInterval(() => {                       // पुरानी entries साफ़ करते रहो
  const now = Date.now();
  for (const [k, v] of _buckets) if (now - v.start > v.windowMs * 2) _buckets.delete(k);
}, 5 * 60 * 1000).unref?.();

function rateLimit({ windowMs = 60000, max = 30, key, message } = {}) {
  return (req, res, next) => {
    try {
      const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.ip || "unknown";
      const id = `${key || req.path}:${ip}`;
      const now = Date.now();
      let b = _buckets.get(id);
      if (!b || now - b.start > windowMs) { b = { start: now, count: 0, windowMs }; _buckets.set(id, b); }
      b.count++;
      const left = Math.max(0, max - b.count);
      res.set("X-RateLimit-Limit", String(max));
      res.set("X-RateLimit-Remaining", String(left));
      if (b.count > max) {
        const wait = Math.ceil((windowMs - (now - b.start)) / 1000);
        res.set("Retry-After", String(wait));
        log("WARN", "[RATE] blocked", { path: req.path, ip, count: b.count });
        return res.status(429).json({ error: message || `बहुत ज़्यादा requests — ${wait} सेकंड बाद कोशिश करें` });
      }
      next();
    } catch (_) { next(); }
  };
}

// ===========================================================================
//  PRD #39 — STORAGE CLEANUP
//  ⚠️ Render की disk छोटी है। पुरानी poster/video/mp3 files हटती नहीं थीं,
//     जिससे एक दिन disk भर जाती और सब कुछ fail होने लगता।
//     अब: जो file किसी ज़िंदा record से जुड़ी नहीं है और पुरानी है — हट जाती है।
// ===========================================================================
const KEEP_DAYS = parseInt(process.env.KEEP_FILE_DAYS || "14", 10);

async function cleanupStorage(dryRun) {
  const started = Date.now();
  const result = { scanned: 0, deleted: 0, freedMB: 0, kept: 0, errors: 0, dryRun: !!dryRun };
  try {
    // 1) DB में जो files अभी इस्तेमाल में हैं उनकी सूची बनाओ
    const inUse = new Set();
    const add = (v) => { if (v && typeof v === "string") inUse.add(path.basename(v)); };

    const [contents, delivs, voices] = await Promise.all([
      Content.find({}).select("images video").lean(),
      Delivery.find({}).select("images video photo").lean(),
      VoiceClip.find({}).select("file").lean(),
    ]);
    for (const c of contents) { add(c.images?.square); add(c.images?.story); add(c.images?.landscape); add(c.video); }
    for (const d of delivs) { add(d.images?.square); add(d.images?.landscape); add(d.video); add(d.photo); }
    for (const v of voices) add(v.file);

    // 2) generated folder scan करो
    const cutoff = Date.now() - KEEP_DAYS * 864e5;
    const files = fs.readdirSync(OUT_DIR);
    for (const f of files) {
      result.scanned++;
      const full = path.join(OUT_DIR, f);
      try {
        const st = fs.statSync(full);
        if (!st.isFile()) continue;

        // ⚠️ अभी इस्तेमाल हो रही file कभी मत हटाओ — चाहे कितनी भी पुरानी हो
        if (inUse.has(f)) { result.kept++; continue; }
        // नई file भी मत हटाओ (अभी बन ही रही हो सकती है)
        if (st.mtimeMs > cutoff) { result.kept++; continue; }

        result.freedMB += st.size / 1048576;
        if (!dryRun) fs.unlinkSync(full);
        result.deleted++;
      } catch (e) { result.errors++; }
    }

    // 3) पुराने base64 हटाओ — यही memory की सबसे बड़ी वजह थी
    if (!dryRun) {
      const t = await trimImageData();
      result.base64Trimmed = t.content + t.delivery;
    }

    // 4) बहुत पुरानी ActivityLog entries भी हटा दो (AuditLog को हाथ मत लगाओ)
    if (!dryRun) {
      const logCut = new Date(Date.now() - 60 * 864e5);
      const r = await ActivityLog.deleteMany({ createdAt: { $lt: logCut } });
      result.activityLogsDeleted = r.deletedCount || 0;
    }

    result.freedMB = Math.round(result.freedMB * 10) / 10;
    result.tookMs = Date.now() - started;
    log("INFO", "[CLEANUP] हुआ", result);
    return result;
  } catch (e) {
    log("ERROR", "[CLEANUP] fail", { msg: e.message });
    return { ...result, error: e.message };
  }
}

/**
 * पुराने base64 हटाओ — DB छोटा, memory हल्की।
 * ⚠️ जो पोस्ट अभी Review में है और 7 दिन से नई है, उसका base64 नहीं छूता
 *    (वही तो restart के बाद बचाने के लिए रखा है)।
 */
async function trimImageData() {
  const out = { content: 0, delivery: 0 };
  try {
    const weekAgo = new Date(Date.now() - 7 * 864e5);
    const cond = {
      imageData: { $ne: null },
      $or: [
        { status: { $in: ["sent", "rejected", "failed"] } },   // काम हो चुका
        { createdAt: { $lt: weekAgo } },                        // या पुरानी है
      ],
    };
    const r1 = await Content.updateMany(cond, { $unset: { imageData: "" } });
    const r2 = await Delivery.updateMany(cond, { $unset: { imageData: "" } });
    out.content = r1.modifiedCount || 0;
    out.delivery = r2.modifiedCount || 0;
    if (out.content || out.delivery) log("INFO", "[TRIM] पुराने base64 हटाए", out);
  } catch (e) { log("ERROR", "trimImageData", { msg: e.message }); }
  return out;
}

// memory पर नज़र — बढ़ने लगे तो पहले ही चेतावनी
let _memWarnedAt = 0;
function memoryWatch() {
  try {
    const m = process.memoryUsage();
    const rssMB = Math.round(m.rss / 1048576);
    const heapMB = Math.round(m.heapUsed / 1048576);
    // Render free tier ~512 MB — 400 पार होते ही चेताओ
    if (rssMB > 400 && Date.now() - _memWarnedAt > 10 * 60000) {
      _memWarnedAt = Date.now();
      log("WARN", "[MEMORY] ज़्यादा हो रही है", { rssMB, heapMB });
      if (global.gc) { global.gc(); log("INFO", "[MEMORY] सफ़ाई की", { after: Math.round(process.memoryUsage().rss / 1048576) }); }
    }
    return { rssMB, heapMB };
  } catch (_) { return null; }
}

// disk कितनी भरी है
function diskUsage() {
  try {
    let bytes = 0, count = 0;
    for (const f of fs.readdirSync(OUT_DIR)) {
      try { const st = fs.statSync(path.join(OUT_DIR, f)); if (st.isFile()) { bytes += st.size; count++; } } catch (_) {}
    }
    return { files: count, mb: Math.round(bytes / 1048576 * 10) / 10 };
  } catch (_) { return { files: 0, mb: 0 }; }
}

// ===========================================================================
//  PRD #18 + #38 — RETRY + IDEMPOTENCY
//  ⚠️ पहले: publish fail हुआ तो job वहीं ख़त्म, और दो जगह से एक साथ भेजने पर
//     एक ही post दो बार चला जाता था। अब दोनों बंद।
// ===========================================================================
const MAX_ATTEMPTS = parseInt(process.env.PUBLISH_MAX_ATTEMPTS || "3", 10);
const RETRY_BACKOFF_MIN = [2, 10, 30];   // मिनटों में — 2, फिर 10, फिर 30

// एक ही content एक ही channel-set पर दोबारा न जाए
function publishKey(doc) {
  const ch = Object.entries(doc.platforms || {}).filter(([, v]) => v).map(([k]) => k).sort().join(",");
  return `${doc._id}:${ch}`;
}

/**
 * publish() का सुरक्षित wrapper।
 *  - पहले ही भेजा जा चुका हो तो दोबारा नहीं भेजता (idempotency)
 *  - एक साथ दो request आएँ तो सिर्फ़ एक चलती है (lock)
 *  - fail होने पर attempts बढ़ाकर nextRetryAt सेट करता है
 */
async function safePublish(Model, docId, req) {
  // ⚠️ imageData (base64) publish में नहीं चाहिए — URL से भेजा जाता है
  const fresh = await Model.findById(docId).select("-imageData");
  if (!fresh) return { ok: false, error: "record नहीं मिला" };

  const key = publishKey(fresh);

  // ── पहले से भेजा जा चुका? ──
  if (fresh.status === "sent" && fresh.publishedKey === key) {
    log("INFO", "[IDEMPOTENT] पहले ही भेजा जा चुका, दोबारा नहीं भेजा", { id: String(docId) });
    return { ok: true, already: true, results: fresh.results || [], channels: fresh.channels || [] };
  }

  // ── किसी और request ने अभी-अभी lock लिया? ──
  const lockId = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const locked = await Model.findOneAndUpdate(
    { _id: docId, $or: [{ publishLock: null }, { publishLock: "" }, { lastAttemptAt: { $lt: new Date(Date.now() - 3 * 60000) } }] },
    { publishLock: lockId, lastAttemptAt: new Date(), $inc: { attempts: 1 } },
    { new: true }
  );
  if (!locked) {
    return { ok: false, error: "यह post अभी भेजा जा रहा है — थोड़ा रुकें" };
  }

  try {
    const results = await publish(locked);
    const ok = results.filter((r) => r.ok).map((r) => r.platform);
    const failed = results.filter((r) => !r.ok);

    if (ok.length) {
      // कम से कम एक channel पर गया → sent
      await Model.findByIdAndUpdate(docId, {
        status: "sent", channels: ok, results, sentAt: new Date(),
        publishedKey: key, publishLock: "", nextRetryAt: null,
        error: failed.length ? failed.map((f) => `${f.platform}: ${f.error}`).join(" | ") : undefined,
      });
      await audit(req, {
        brand: locked.brand, action: "publish", entity: Model.modelName.toLowerCase(), entityId: docId,
        summary: `${ok.join(", ")} पर भेजा गया${failed.length ? ` (${failed.length} fail)` : ""}`,
        after: { channels: ok, attempts: locked.attempts },
      });
      return { ok: true, results, channels: ok };
    }

    // ── सब fail — retry की तैयारी ──
    const att = locked.attempts || 1;
    const errMsg = results.map((r) => `${r.platform}: ${r.error}`).join(" | ") || "कोई channel नहीं चला";
    if (att < MAX_ATTEMPTS) {
      const mins = RETRY_BACKOFF_MIN[Math.min(att - 1, RETRY_BACKOFF_MIN.length - 1)];
      const next = new Date(Date.now() + mins * 60000);
      await Model.findByIdAndUpdate(docId, {
        status: "pending", results, error: errMsg, publishLock: "", nextRetryAt: next,
      });
      log("WARN", "[RETRY] शेड्यूल किया", { id: String(docId), attempt: att, inMins: mins });
      await activity(locked.brand, "publish", "warning", `भेजना fail — ${mins} मिनट बाद अपने आप दोबारा कोशिश होगी (${att}/${MAX_ATTEMPTS})`, { contentId: docId });
      return { ok: false, retrying: true, nextRetryAt: next, attempt: att, error: errMsg };
    }

    // ── कोशिशें ख़त्म ──
    await Model.findByIdAndUpdate(docId, { status: "failed", results, error: errMsg, publishLock: "", nextRetryAt: null });
    await audit(req, {
      brand: locked.brand, action: "publish", entity: Model.modelName.toLowerCase(), entityId: docId,
      summary: `${MAX_ATTEMPTS} कोशिशों के बाद भी नहीं भेजा जा सका`, after: { error: errMsg },
    });
    notify("error", `भेजना fail: ${errMsg.slice(0, 80)}`, locked.brand);
    return { ok: false, error: errMsg, results };
  } catch (e) {
    await Model.findByIdAndUpdate(docId, { publishLock: "", error: e.message });
    log("ERROR", "safePublish", { msg: e.message });
    return { ok: false, error: e.message };
  }
}

// जिनका retry समय आ गया है उन्हें दोबारा भेजो (cron से हर 5 मिनट)
async function runRetryQueue() {
  const now = new Date();
  for (const Model of [Content, Delivery]) {
    try {
      const due = await Model.find({
        status: "pending", nextRetryAt: { $ne: null, $lte: now },
        attempts: { $lt: MAX_ATTEMPTS },
      }).limit(5).select("_id brand");
      for (const d of due) {
        log("INFO", "[RETRY] दोबारा कोशिश", { id: String(d._id) });
        await safePublish(Model, d._id, null);
      }
    } catch (e) { log("ERROR", "runRetryQueue", { msg: e.message }); }
  }
}




// ===========================================================================
//  WHATSAPP APPROVAL — रोज़ का content सीधे मालिक के WhatsApp पर
//  वहीं से ✅ भेजो / ❌ रहने दो / 📥 खुद भेजूँगा
//  ⚠️ तीनों brands के लिए अलग-अलग नंबर और अलग सेटिंग रखी जा सकती है
// ===========================================================================

// अभी "चुप रहने का समय" तो नहीं? (रात में message न जाएँ)
function inQuietHours(cfg) {
  try {
    const now = new Date().toLocaleTimeString("en-GB", { timeZone: "Asia/Kolkata", hour12: false }).slice(0, 5);
    const from = cfg.quietFrom || "22:00", to = cfg.quietTo || "07:00";
    return from > to ? (now >= from || now < to) : (now >= from && now < to);
  } catch (_) { return false; }
}

// छोटा code — मालिक चाहें तो "A7 हाँ" टाइप करके भी जवाब दे सकें
function shortCode() {
  const L = "ABCDEFGHJKLMNPQRSTUVWXYZ";
  return L[Math.floor(Math.random() * L.length)] + Math.floor(Math.random() * 90 + 10);
}

async function waSend(brandId, to, payload) {
  const c = brandCreds(brandId);
  const token = c.waToken || process.env.WA_TOKEN || "";
  if (!c.waPhoneId || !token) throw new Error("इस brand की WhatsApp सेटिंग अधूरी है (Settings में waPhoneId व waToken डालें)");
  if (TEST_MODE) { log("INFO", "[WA] TEST_MODE — भेजा नहीं", { brandId, to }); return { id: "test" }; }

  const r = await fetch(`${GRAPH}/${c.waPhoneId}/messages`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ messaging_product: "whatsapp", to, ...payload }),
    signal: AbortSignal.timeout(20000),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`WA ${r.status}: ${String(d?.error?.message || "").slice(0, 120)}`);
  return { id: d?.messages?.[0]?.id };
}

/**
 * एक तैयार post मालिक के WhatsApp पर भेजो — नीचे 3 बटन के साथ।
 * ⚠️ यह ग्राहकों को नहीं जाता, सिर्फ़ मालिक/मैनेजर को approval के लिए।
 */
async function sendForApproval(brandId, doc, kind) {
  const cfg = await OwnerWA.findOne({ brand: brandId }).lean();
  if (!cfg || !cfg.enabled || !(cfg.numbers || []).length) return { skipped: "WhatsApp approval बंद है" };
  if (inQuietHours(cfg)) return { skipped: "अभी रात का समय है — सुबह भेजा जाएगा" };

  const isVideo = doc.post_type === "video" || !!doc.video;
  if (isVideo && cfg.sendVideos === false) return { skipped: "video भेजना बंद है" };
  if (!isVideo && cfg.sendPosters === false) return { skipped: "poster भेजना बंद है" };
  if (kind === "delivery" && cfg.sendDeliveries === false) return { skipped: "delivery भेजना बंद है" };

  const b = BRANDS[brandId];
  const code = shortCode();
  const media = isVideo ? doc.video : (doc.images?.square || doc.images?.landscape);
  if (!media) return { skipped: "कोई image/video नहीं" };
  const url = String(media).startsWith("http") ? media : `${PUBLIC_URL}${media}`;

  const caption =
    `*${b.name}* — ${kind === "delivery" ? "नई डिलीवरी पोस्ट" : TYPE_LABEL[doc.type] || "पोस्ट"}\n` +
    `कोड: *${code}*\n` +
    `────────────\n${String(doc.text || "").slice(0, 850)}`;

  const results = [];
  for (const num of cfg.numbers.slice(0, 5)) {
    try {
      // 1) media + caption
      await waSend(brandId, num, isVideo
        ? { type: "video", video: { link: url, caption } }
        : { type: "image", image: { link: url, caption } });

      // 2) तीन बटन
      const sent = await waSend(brandId, num, {
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: `कोड *${code}* — क्या करें?` },
          action: {
            buttons: [
              { type: "reply", reply: { id: `ok_${code}`, title: "✅ भेज दो" } },
              { type: "reply", reply: { id: `no_${code}`, title: "❌ रहने दो" } },
              { type: "reply", reply: { id: `me_${code}`, title: "📥 मैं भेजूँगा" } },
            ],
          },
        },
      });

      await WAPending.create({
        brand: brandId, kind: kind || "content", refId: doc._id, toNumber: num,
        waMessageId: sent.id, shortCode: code, status: "waiting",
        expiresAt: new Date(Date.now() + 48 * 3600 * 1000),
      });
      results.push({ num, ok: true });
    } catch (e) {
      log("WARN", "[WA-APPROVAL] भेजने में दिक्कत", { brandId, num, msg: e.message });
      results.push({ num, ok: false, error: e.message });
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  if (okCount) {
    await OwnerWA.findOneAndUpdate({ brand: brandId }, { lastSentAt: new Date(), $inc: { sentCount: 1 } });
    await activity(brandId, "publish", "success", `WhatsApp पर approval के लिए भेजा (कोड ${code})`, { contentId: doc._id });
  }
  return { sent: okCount, code, results };
}

// जिन posts का WhatsApp पर अभी नहीं भेजा गया, उन्हें भेजो
async function pushPendingToWhatsApp(brandId, limit) {
  const cfg = await OwnerWA.findOne({ brand: brandId }).lean();
  if (!cfg?.enabled) return { sent: 0, skipped: "बंद है" };

  const alreadyIds = (await WAPending.find({ brand: brandId }).select("refId").lean()).map((x) => String(x.refId));
  const docs = await Content.find({ brand: brandId, status: "pending", _id: { $nin: alreadyIds } })
    .select("-imageData").sort({ createdAt: -1 }).limit(Math.min(limit || 5, 10));

  let sent = 0;
  for (const d of docs) {
    const r = await sendForApproval(brandId, d, "content");
    if (r.sent) sent++;
    await new Promise((res) => setTimeout(res, 1200));   // Meta rate limit से बचाव
  }

  if (cfg.sendDeliveries !== false) {
    const dels = await Delivery.find({ brand: brandId, status: "pending", _id: { $nin: alreadyIds } })
      .select("-imageData").sort({ createdAt: -1 }).limit(3);
    for (const d of dels) {
      const r = await sendForApproval(brandId, d, "delivery");
      if (r.sent) sent++;
      await new Promise((res) => setTimeout(res, 1200));
    }
  }
  return { sent, considered: docs.length };
}

// WhatsApp से आए जवाब को समझो और वही करो
async function handleApprovalReply(brandId, from, raw) {
  const txt = String(raw || "").trim();
  // बटन का id (ok_A7) या टाइप किया हुआ ("A7 हाँ" / "हाँ")
  let action = null, code = null;
  const btn = /^(ok|no|me)_([A-Z]\d{2})$/.exec(txt);
  if (btn) { action = btn[1]; code = btn[2]; }
  else {
    const cm = /\b([A-Z]\d{2})\b/i.exec(txt);
    if (cm) code = cm[1].toUpperCase();
    if (/^(ok|haan|हाँ|हां|yes|भेज|भेजो|approve|✅)/i.test(txt)) action = "ok";
    else if (/^(no|nahi|नहीं|reject|रहने|❌)/i.test(txt)) action = "no";
    else if (/(मैं भेज|khud|खुद|📥)/i.test(txt)) action = "me";
  }
  if (!action) return null;

  // code न मिले तो इसी नंबर का सबसे नया pending
  const q = { brand: brandId, status: "waiting", toNumber: from };
  if (code) q.shortCode = code;
  const pend = await WAPending.findOne(q).sort({ createdAt: -1 });
  if (!pend) return "उस पोस्ट का पता नहीं चला 🤔 कृपया कोड के साथ लिखें, जैसे: *A7 हाँ*";

  const Model = pend.kind === "delivery" ? Delivery : Content;
  const doc = await Model.findById(pend.refId);
  if (!doc) { pend.status = "expired"; await pend.save(); return "यह पोस्ट अब मौजूद नहीं है।"; }

  if (action === "no") {
    await Model.findByIdAndUpdate(doc._id, { status: "rejected", nextRetryAt: null });
    pend.status = "rejected"; pend.answeredAt = new Date(); await pend.save();
    await audit(null, { brand: brandId, action: "reject", entity: pend.kind, entityId: doc._id,
      summary: `WhatsApp से reject (${pend.shortCode})` });
    return `❌ ठीक है, यह पोस्ट नहीं भेजी जाएगी। (कोड ${pend.shortCode})`;
  }

  if (action === "me") {
    pend.status = "approved"; pend.answeredAt = new Date(); await pend.save();
    const media = doc.video || doc.images?.square;
    const link = media ? (String(media).startsWith("http") ? media : `${PUBLIC_URL}${media}`) : "";
    return `📥 ठीक है, यह आपके पास ही रहेगी — Review में भी बनी रहेगी।\n` +
           (link ? `\nFile: ${link}\n` : "") +
           `\nCaption नीचे से copy कर लीजिए 👇\n────────────\n${String(doc.text || "").slice(0, 900)}`;
  }

  // action === "ok" → सच में भेजो
  const out = await safePublish(Model, doc._id, null);
  pend.status = "approved"; pend.answeredAt = new Date(); await pend.save();

  // ग्राहक का नंबर हो तो उसे भी उसकी photo भेज दो
  setImmediate(async () => {
    try {
      const fresh = await Model.findById(doc._id);
      if (!fresh?.customerMobile) return;
      const r = await sendDeliveryToCustomer(brandId, fresh);
      if (r.sent) await waSend(brandId, from, { type: "text", text: { body: `📲 ${fresh.customerName || "ग्राहक"} को भी भेज दिया` } });
    } catch (_) {}
  });

  if (out.already) return `यह पहले ही भेजी जा चुकी थी ✅`;
  if (out.ok) return `✅ भेज दिया — ${(out.channels || []).join(", ")}`;
  if (out.retrying) return `⏳ अभी नहीं गई, ${out.attempt}/${MAX_ATTEMPTS} कोशिश हुई। कुछ मिनट में अपने आप दोबारा जाएगी।`;
  return `⚠️ नहीं भेज पाए: ${String(out.error).slice(0, 140)}`;
}

// महीने की पहली तारीख़ — पिछले महीने का हिसाब WhatsApp पर
async function sendMonthlyReport(brandId) {
  const cfg = await OwnerWA.findOne({ brand: brandId }).lean();
  if (!cfg?.enabled || cfg.monthlyReport === false || !(cfg.numbers || []).length) return { skipped: true };

  const b = BRANDS[brandId];
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const end = new Date(now.getFullYear(), now.getMonth(), 1);
  const range = { $gte: start, $lt: end };

  const [sent, rejected, delivs, leads, videos, insDocs] = await Promise.all([
    Content.countDocuments({ brand: brandId, status: "sent", sentAt: range }),
    Content.countDocuments({ brand: brandId, status: "rejected", createdAt: range }),
    Delivery.countDocuments({ brand: brandId, status: "sent", sentAt: range }),
    Lead.countDocuments({ brand: brandId, createdAt: range }),
    Content.countDocuments({ brand: brandId, post_type: "video", createdAt: range }),
    Content.find({ brand: brandId, status: "sent", sentAt: range, insights: { $ne: null } }).select("insights text").lean(),
  ]);

  const views = insDocs.reduce((a, x) => a + (x.insights?.total || 0), 0);
  const eng = insDocs.reduce((a, x) => a + (x.insights?.engagement || 0), 0);
  const best = insDocs.sort((a, x) => (x.insights?.engagement || 0) - (a.insights?.engagement || 0))[0];
  const monthName = start.toLocaleDateString("hi-IN", { month: "long", year: "numeric", timeZone: "Asia/Kolkata" });

  const msg =
    `📊 *${b.name}* — ${monthName} का हिसाब\n` +
    `────────────\n` +
    `📤 भेजी गई पोस्ट: *${sent}*\n` +
    `🎬 वीडियो बने: *${videos}*\n` +
    `🎉 डिलीवरी पोस्ट: *${delivs}*\n` +
    `❌ रद्द की गईं: ${rejected}\n` +
    `👥 नए लीड: *${leads}*\n` +
    (views || eng ? `\n👁️ कुल views: *${views}*\n❤️ कुल engagement: *${eng}*\n` : "\n_(FB/IG के असली आँकड़े अभी नहीं आए)_\n") +
    (best ? `\n🏆 सबसे अच्छी पोस्ट:\n_${String(best.text || "").slice(0, 110)}…_\n` : "") +
    `\n📞 ${b.phone}`;

  let ok = 0;
  for (const num of cfg.numbers.slice(0, 5)) {
    try { await waSend(brandId, num, { type: "text", text: { body: msg } }); ok++; }
    catch (e) { log("WARN", "[WA-REPORT] fail", { brandId, num, msg: e.message }); }
  }
  if (ok) await activity(brandId, "analytics", "success", `${monthName} की रिपोर्ट WhatsApp पर भेजी`);
  return { sent: ok };
}


// ===========================================================================
//  ग्राहक को सीधे WhatsApp
//  ⚠️ बहुत ज़रूरी नियम (Meta का): अगर ग्राहक ने पिछले 24 घंटे में आपको
//     message नहीं किया है, तो सिर्फ़ *approved template* भेजा जा सकता है —
//     सादा photo/text नहीं जाएगा (Meta error 131047 देता है)।
//     इसलिए यहाँ पहले सीधा भेजने की कोशिश होती है; न जाए तो मालिक को
//     साफ़ बताया जाता है और भेजने लायक link+text दे दिया जाता है।
// ===========================================================================
function normalizeMobile(raw) {
  const d = String(raw || "").replace(/\D/g, "");
  if (!d) return null;
  if (d.length === 10) return "91" + d;
  if (d.length === 12 && d.startsWith("91")) return d;
  if (d.length === 11 && d.startsWith("0")) return "91" + d.slice(1);
  return d.length >= 11 && d.length <= 15 ? d : null;
}

/**
 * ग्राहक को उसकी photo/video भेजो।
 * ⚠️ यह Delivery और Content — दोनों पर चलता है, क्योंकि आप जो photo
 *    "Delivery" पेज (DeliveryEditor / AI Delivery) में बनाते हैं वो Content बनती है।
 */
async function sendDeliveryToCustomer(brandId, doc, opts = {}) {
  const cfg = await OwnerWA.findOne({ brand: brandId }).lean();
  if (!cfg?.enabled) return { skipped: "WhatsApp बंद है" };
  if (cfg.sendToCustomer === false && !opts.manual) return { skipped: "ग्राहक को भेजना बंद है" };

  const to = normalizeMobile(doc.customerMobile);
  if (!to) return { skipped: "ग्राहक का मोबाइल नंबर नहीं है" };
  if (doc.sentToCustomerAt && !opts.force) return { skipped: "पहले ही भेजा जा चुका है" };

  const b = BRANDS[brandId];
  // ⚠️ जो photo आपने खुद बनाई वही जाती है (images.square), वीडियो हो तो वीडियो
  const media = doc.video || doc.images?.square || doc.images?.landscape;
  if (!media) return { skipped: "कोई photo/video नहीं" };
  const url = String(media).startsWith("http") ? media : `${PUBLIC_URL}${media}`;
  const isVideo = !!doc.video;

  // model पहचानो — Content या Delivery
  // ⚠️ mongoose से सीधे पूछो कि यह Content है या Delivery — अंदाज़ा मत लगाओ
  const modelName = doc?.constructor?.modelName;
  const Model = modelName === "Content" ? Content : modelName === "Delivery" ? Delivery
    : (doc.type ? Content : Delivery);   // .lean() वाला object आ जाए तो fallback
  const vehicle = doc.bikeName || doc.promo?.model || b.vehicleWord;

  const caption = opts.caption || (
    `🎉 बधाई हो ${doc.customerName || ""}!\n\n` +
    `आपकी नई ${vehicle} की डिलीवरी पर ${b.name} परिवार की ओर से ` +
    `हार्दिक शुभकामनाएँ 🙏\n\n` +
    `सुरक्षित चलाएँ, हेलमेट ज़रूर पहनें 🪖\n\n` +
    `किसी भी सेवा/सर्विस के लिए 📞 ${b.phone}\n📍 ${b.place}`);

  try {
    await waSend(brandId, to, isVideo
      ? { type: "video", video: { link: url, caption } }
      : { type: "image", image: { link: url, caption } });

    await Model.findByIdAndUpdate(doc._id, { sentToCustomerAt: new Date() });
    await activity(brandId, "publish", "success", `ग्राहक ${doc.customerName || to} को उनकी photo भेजी`);
    await audit(null, { brand: brandId, action: "send", entity: Model.modelName.toLowerCase(), entityId: doc._id,
      summary: `ग्राहक को WhatsApp पर भेजा (${to})` });
    return { sent: true, to };
  } catch (e) {
    const msg = String(e.message || "");
    // 24-घंटे वाला नियम — मालिक को साफ़ बताओ, चुपचाप fail मत हो
    const isWindow = /131047|131026|re-?engagement|24 hour/i.test(msg);
    log("WARN", "[WA-CUSTOMER] नहीं गया", { brandId, to, msg: msg.slice(0, 120) });

    if (cfg.numbers?.length) {
      const help = isWindow
        ? `⚠️ ${doc.customerName || to} को सीधे नहीं भेज पाए।\n\n` +
          `वजह: उन्होंने पिछले 24 घंटे में आपको WhatsApp नहीं किया — WhatsApp के नियम के मुताबिक ` +
          `ऐसे में सिर्फ़ approved template ही जाता है।\n\n` +
          `नीचे से copy करके खुद भेज दीजिए 👇\n────────────\n${caption}\n\n${url}`
        : `⚠️ ${doc.customerName || to} को नहीं भेज पाए: ${msg.slice(0, 100)}\n\n${url}`;
      try { await waSend(brandId, cfg.numbers[0], { type: "text", text: { body: help } }); } catch (_) {}
    }
    return { sent: false, error: msg, needsManual: true };
  }
}

// नया lead — मालिक को तुरंत खबर, और ग्राहक को अपने आप जवाब
async function handleNewLead(brandId, lead) {
  const cfg = await OwnerWA.findOne({ brand: brandId }).lean();
  if (!cfg?.enabled) return;
  const b = BRANDS[brandId];

  // 1) मालिक को खबर
  if (cfg.leadAlert !== false && cfg.numbers?.length) {
    const msg =
      `🔔 *नया lead* — ${b.name}\n────────────\n` +
      `👤 ${lead.name || "नाम नहीं बताया"}\n` +
      `📞 ${lead.mobile}\n` +
      (lead.vehicleInterest ? `🏍️ रुचि: ${lead.vehicleInterest}\n` : "") +
      `\nअभी कॉल करें: wa.me/${normalizeMobile(lead.mobile) || lead.mobile}`;
    for (const num of cfg.numbers.slice(0, 3)) {
      try { await waSend(brandId, num, { type: "text", text: { body: msg } }); }
      catch (e) { log("WARN", "[LEAD-ALERT] fail", { msg: e.message }); }
    }
  }

  // 2) ग्राहक को अपने आप जवाब (⚠️ डिफ़ॉल्ट बंद — मालिक खुद चालू करे)
  if (cfg.leadAutoReply === true) {
    const to = normalizeMobile(lead.mobile);
    if (to) {
      const reply =
        `नमस्ते ${lead.name || ""} 🙏\n\n` +
        `${b.name} में आपकी रुचि के लिए धन्यवाद!\n` +
        (lead.vehicleInterest ? `\n${lead.vehicleInterest} के बारे में हमारी टीम जल्द आपसे संपर्क करेगी।\n` : "\nहमारी टीम जल्द आपसे संपर्क करेगी।\n") +
        `\nतुरंत बात करनी हो तो 📞 ${b.phone}\n📍 ${b.place}`;
      try {
        await waSend(brandId, to, { type: "text", text: { body: reply } });
        await Lead.findByIdAndUpdate(lead._id, { autoRepliedAt: new Date() });
      } catch (e) {
        log("WARN", "[LEAD-REPLY] नहीं गया (24 घंटे का नियम हो सकता है)", { msg: String(e.message).slice(0, 90) });
      }
    }
  }
}

// ===========================================================================
//  WHATSAPP पर बोलकर COMMAND
//  मालिक voice note भेजें → text में बदलो → intent समझो → content बनाओ
//  → तैयार होते ही उन्हीं को approval के लिए वापस भेज दो
// ===========================================================================
async function fetchWaMedia(brandId, mediaId) {
  const c = brandCreds(brandId);
  const token = c.waToken || process.env.WA_TOKEN || "";
  if (!token) throw new Error("WA token नहीं");
  const meta = await fetch(`${GRAPH}/${mediaId}`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
  });
  if (!meta.ok) throw new Error(`media info ${meta.status}`);
  const info = await meta.json();
  const bin = await fetch(info.url, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30000),
  });
  if (!bin.ok) throw new Error(`media download ${bin.status}`);
  return { buf: Buffer.from(await bin.arrayBuffer()), mime: info.mime_type || "audio/ogg" };
}

async function handleVoiceCommand(brandId, from, mediaId) {
  const cfg = await OwnerWA.findOne({ brand: brandId }).lean();
  if (cfg?.voiceCommands === false) return null;

  const say = async (t) => { try { await waSend(brandId, from, { type: "text", text: { body: t } }); } catch (_) {} };

  try {
    await say("🎧 सुन रहे हैं…");
    const { buf, mime } = await fetchWaMedia(brandId, mediaId);
    const st = await AI.stt(buf, mime);
    if (!st.ok) { await say(`समझ नहीं आया 🤔 — ${String(st.error).slice(0, 80)}\n\nदोबारा बोलकर या लिखकर बताइए।`); return true; }

    await say(`आपने कहा:\n_"${st.text}"_\n\n⏳ बना रहे हैं…`);

    const lim = await checkAndCountUsage(brandId, "aiCalls");
    if (!lim.ok) { await say(`⚠️ ${lim.message}`); return true; }

    const intent = await parseCommandIntent(st.text, brandId);
    if (intent.error) { await say(`समझ नहीं पाए: ${String(intent.error).slice(0, 90)}`); return true; }

    const useBrand = BRANDS[intent.brand] ? intent.brand : brandId;
    const ctx = [intent.summary_hindi, intent.vehicle && `गाड़ी: ${intent.vehicle}`,
                 intent.offer_details].filter(Boolean).join("\n");

    const doc = await genToPending(useBrand, intent.type || "vigyapan", intent.festival, ctx);
    if (!doc) { await say("पोस्ट नहीं बन पाई 😔 दोबारा कोशिश कीजिए।"); return true; }
    await Content.findByIdAndUpdate(doc._id, { triggeredBy: "wa_voice" });

    await activity(useBrand, "generate", "success", `WhatsApp पर बोलकर बनवाया: "${String(st.text).slice(0, 60)}"`, { contentId: doc._id });

    // तैयार पोस्ट approval बटन के साथ वापस भेजो
    const fresh = await Content.findById(doc._id);
    const r = await sendForApproval(useBrand, fresh, "content");
    if (!r.sent) await say("बन गई ✅ पर WhatsApp पर नहीं भेज पाए — App के Review में देख लीजिए।");
    return true;
  } catch (e) {
    log("ERROR", "handleVoiceCommand", { msg: e.message });
    await say(`कुछ गड़बड़ हुई: ${String(e.message).slice(0, 100)}`);
    return true;
  }
}

// ===========================================================================
//  DAILY AUTO CONTENT ENGINE (PRD #5, #32)
//  मक़सद: मालिक को कुछ न करना पड़े। हर रोज़ अपने आप —
//    • कई promotional posters
//    • promotional video (गाड़ियों की photos से)
//    • delivery video (जिन deliveries का अभी नहीं बना)
//  सब Review में आते हैं। भेजना तभी होगा जब Automation "full" mode में हो।
// ===========================================================================

// उस brand की गाड़ियों की photos ढूँढो (video बनाने के लिए)
function vehiclePhotosFor(brandId, max) {
  try {
    const d = path.join(VEHICLE_DIR, brandId);
    if (!fs.existsSync(d)) return [];
    return fs.readdirSync(d)
      .filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f))
      .sort(() => Math.random() - 0.5)
      .slice(0, max || 6)
      .map((f) => path.join(d, f));
  } catch (_) { return []; }
}

// रोज़ का promotional video — गाड़ियों की photos से अपने आप
async function autoPromoVideo(brandId) {
  if (!ENABLE_VIDEO) return null;
  const b = BRANDS[brandId];
  const photos = vehiclePhotosFor(brandId, 5);
  if (photos.length < 2) {
    log("INFO", "[AUTO-VIDEO] गाड़ियों की photos कम हैं, skip", { brand: brandId, found: photos.length });
    return null;
  }
  const lim = await checkAndCountUsage(brandId, "videos");
  if (!lim.ok) { log("INFO", "[AUTO-VIDEO] दैनिक सीमा पूरी", { brand: brandId }); return null; }

  const jobId = `auto_${brandId}_${Date.now()}`;
  try {
    // caption + headline AI से (database के अंदर की जानकारी पर ही)
    const vCtx = await vehicleContext(brandId, "");
    const text = await generateText(brandId, "vigyapan", undefined,
      [vCtx && `उपलब्ध गाड़ियाँ:\n${vCtx}`, "यह एक छोटी promotional video की caption है"].filter(Boolean).join("\n"));

    const url = await makeSlideshowVideo(jobId, photos, {
      perPhotoDur: 3,
      headline: `${b.name}`,
      subLine: b.kind === "ev3w" ? "इलेक्ट्रिक ऑटो" : b.kind === "ev2w" ? "इलेक्ट्रिक स्कूटर" : "आज ही टेस्ट राइड लें",
      brand: brandId,
    });

    const doc = await Content.create({
      brand: brandId, type: "vigyapan", post_type: "video",
      text: cleanAIText(text), video: url, status: "pending", triggeredBy: "daily_auto_video",
    });
    await activity(brandId, "video", "success", "रोज़ का promotional video अपने आप बना", { contentId: doc._id });
    log("INFO", "[AUTO-VIDEO] बना", { brand: brandId, id: String(doc._id) });
    return doc;
  } catch (e) {
    log("ERROR", "[AUTO-VIDEO] fail", { brand: brandId, msg: e.message });
    await activity(brandId, "video", "failed", `रोज़ का video नहीं बना: ${String(e.message).slice(0, 90)}`);
    return null;
  }
}

// जिन deliveries का video अभी नहीं बना, उनका अपने आप बना दो
async function autoDeliveryVideos(brandId) {
  if (!ENABLE_VIDEO) return 0;
  let made = 0;
  try {
    const since = new Date(Date.now() - 3 * 864e5);
    const pend = await Delivery.find({
      brand: brandId, status: "pending", createdAt: { $gte: since },
      $or: [{ video: null }, { video: "" }, { video: { $exists: false } }],
    }).select("-imageData").limit(2);

    for (const d of pend) {
      const lim = await checkAndCountUsage(brandId, "videos");
      if (!lim.ok) break;
      try {
        // slides (4 png) मौजूद न हों तो पहले बनाओ — restart के बाद disk साफ़ हो जाती है
        const s1 = path.join(OUT_DIR, `${d._id}_s1.png`);
        if (!fs.existsSync(s1)) {
          const ph = d.photo ? path.join(UPLOAD_DIR, path.basename(d.photo)) : null;
          await buildDeliverySlides(brandId, d._id, d, (ph && fs.existsSync(ph)) ? ph : null, "auto");
        }
        const url = await generateDeliveryVideo(d._id, null);
        if (url) {
          await stampVideoHeader(path.join(OUT_DIR, path.basename(url)), brandId, 1080, 1920);
          d.video = url; d.post_type = "video"; await d.save(); made++;
        }
      } catch (e) { log("WARN", "[AUTO-DELIV-VIDEO] fail", { id: String(d._id), msg: e.message }); }
    }
    if (made) await activity(brandId, "video", "success", `${made} delivery video अपने आप बने`);
  } catch (e) { log("ERROR", "autoDeliveryVideos", { msg: e.message }); }
  return made;
}

/**
 * पूरे दिन का content एक साथ — "मुझे कुछ न करना पड़े" वाला काम।
 * रोज़ सुबह अपने आप चलता है, और dashboard से हाथ से भी चलाया जा सकता है।
 */
async function runDailyEngine(brandId, opts = {}) {
  const started = Date.now();
  const b = BRANDS[brandId];
  const out = { brand: brandId, posters: 0, videos: 0, skipped: [], errors: [] };

  try {
    const settings = (await AutomationSettings.findOne({ brand: brandId })) || {};
    const wantPosters = Math.min(Math.max(parseInt(opts.posters ?? settings.dailyPosters ?? 3, 10), 0), 8);
    const wantVideo = opts.video !== undefined ? !!opts.video : (settings.dailyVideo !== false);

    // पहले से आज का content बना हो तो दोबारा मत बनाओ
    const todayStart = new Date(new Date().toLocaleDateString("en-US", { timeZone: "Asia/Kolkata" }));
    const already = await Content.countDocuments({ brand: brandId, createdAt: { $gte: todayStart } });
    if (already >= wantPosters + 1 && !opts.force) {
      out.skipped.push(`आज पहले ही ${already} content बन चुके हैं`);
      return out;
    }

    // ── 1) आज का plan (त्यौहार, पिछला content, inventory देखकर) ──
    const todayIST = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const fest = FESTIVALS.find((f) => f.date === todayIST);
    const recent = await Content.find({ brand: brandId }).sort({ createdAt: -1 }).limit(8)
      .select("type text -_id").lean();
    const vCtx = await vehicleContext(brandId, "");

    const plan = await AI.json(
      `तुम ${brandDesc(b)} के marketing planner हो। आज ${todayIST} है।
${fest ? `आज ${fest.name} है — एक post उसी का होना चाहिए।` : ""}
${vCtx ? `\nउपलब्ध गाड़ियाँ:\n${vCtx}\n` : ""}
पिछले posts (इनसे अलग बनाओ):
${recent.map((r) => `- [${r.type}] ${String(r.text).slice(0, 60)}`).join("\n") || "(कोई नहीं)"}

आज के लिए ${wantPosters} posts की सूची बनाओ।
सिर्फ़ valid JSON:
{ "posts": [ { "type": "suvichar|vigyapan|festival|suchna|gift", "topic_hindi": "एक लाइन", "vehicle": "गाड़ी या खाली" } ] }

⚠️ ठीक ${wantPosters} items। कोई नया price/EMI/offer मत बनाओ।`,
      { temperature: 0.95, timeout: 30000, maxTokens: 1500 });

    const posts = Array.isArray(plan.posts) ? plan.posts.slice(0, wantPosters) : [];
    if (!posts.length && wantPosters) out.errors.push(plan.error || "AI ने plan नहीं दिया");

    // ── 2) posters ──
    for (const item of posts) {
      const lim = await checkAndCountUsage(brandId, "aiCalls");
      if (!lim.ok) { out.skipped.push("दैनिक AI सीमा पूरी"); break; }
      try {
        const ctx = [item.topic_hindi, item.vehicle && `गाड़ी: ${item.vehicle}`].filter(Boolean).join("\n");
        const doc = await genToPending(brandId, item.type, fest ? fest.name : undefined, ctx);
        if (doc) { await Content.findByIdAndUpdate(doc._id, { triggeredBy: "daily_engine" }); out.posters++; }
      } catch (e) { out.errors.push(String(e.message).slice(0, 80)); }
    }

    // ── 3) videos ──
    if (wantVideo) {
      const v = await autoPromoVideo(brandId);
      if (v) out.videos++;
      out.videos += await autoDeliveryVideos(brandId);
    }

    // ── 4) तैयार content सीधे मालिक के WhatsApp पर (अगर चालू है) ──
    if (out.posters || out.videos) {
      try {
        const wa = await pushPendingToWhatsApp(brandId, 8);
        out.whatsappSent = wa.sent || 0;
      } catch (e) { out.errors.push("WhatsApp: " + String(e.message).slice(0, 60)); }
    }

    out.tookSec = Math.round((Date.now() - started) / 1000);
    await activity(brandId, "generate", out.errors.length ? "warning" : "success",
      `आज का content अपने आप तैयार — ${out.posters} poster, ${out.videos} video` +
      (out.whatsappSent ? `, ${out.whatsappSent} WhatsApp पर भेजे` : " (सब Review में)"));
    if (out.posters || out.videos) {
      notify("info", `${b.name}: ${out.posters} poster + ${out.videos} video तैयार — Review करें`, brandId);
    }
    log("INFO", "[DAILY-ENGINE] हुआ", out);
    return out;
  } catch (e) {
    log("ERROR", "[DAILY-ENGINE] fail", { brand: brandId, msg: e.message });
    out.errors.push(e.message);
    return out;
  }
}

// ===========================================================================
//  PRD #13B — AI CREATIVE VIDEO (provider-agnostic)
//  ⚠️ किसी एक provider पर hard-code नहीं। key डालो तो चलेगा, न डालो तो
//     अपने आप ffmpeg वाला photo-to-video ही चलता रहेगा — कुछ टूटेगा नहीं।
// ===========================================================================
const VIDEO_PROVIDERS = {
  // Replicate — कई models एक ही API से
  async replicate({ prompt, seconds, aspect, imageUrl, timeout }) {
    const key = process.env.REPLICATE_API_TOKEN;
    if (!key) return { ok: false, error: "no-key" };
    const version = process.env.REPLICATE_VIDEO_VERSION;
    if (!version) return { ok: false, error: "REPLICATE_VIDEO_VERSION set करें" };
    try {
      const start = await fetch("https://api.replicate.com/v1/predictions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}`, Prefer: "wait" },
        body: JSON.stringify({
          version,
          input: { prompt, num_frames: Math.min(Math.round((seconds || 10) * 8), 240), aspect_ratio: aspect || "9:16", ...(imageUrl ? { image: imageUrl } : {}) },
        }),
        signal: AbortSignal.timeout(timeout || 120000),
      });
      if (!start.ok) return { ok: false, error: `replicate ${start.status}` };
      let pred = await start.json();
      // Prefer:wait के बाद भी अधूरा हो तो poll करो
      for (let i = 0; i < 40 && ["starting", "processing"].includes(pred.status); i++) {
        await new Promise((r) => setTimeout(r, 5000));
        const pr = await fetch(pred.urls.get, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000) });
        pred = await pr.json();
      }
      if (pred.status !== "succeeded") return { ok: false, error: `replicate ${pred.status}: ${String(pred.error || "").slice(0, 80)}` };
      const url = Array.isArray(pred.output) ? pred.output[pred.output.length - 1] : pred.output;
      if (!url) return { ok: false, error: "कोई video URL नहीं मिला" };
      const vr = await fetch(url, { signal: AbortSignal.timeout(120000) });
      return { ok: true, buf: Buffer.from(await vr.arrayBuffer()), mime: "video/mp4", via: "replicate" };
    } catch (e) { return { ok: false, error: e.message }; }
  },

  // Luma Dream Machine
  async luma({ prompt, aspect, imageUrl, timeout }) {
    const key = process.env.LUMA_API_KEY;
    if (!key) return { ok: false, error: "no-key" };
    try {
      const r = await fetch("https://api.lumalabs.ai/dream-machine/v1/generations", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ prompt, aspect_ratio: aspect || "9:16", ...(imageUrl ? { keyframes: { frame0: { type: "image", url: imageUrl } } } : {}) }),
        signal: AbortSignal.timeout(30000),
      });
      if (!r.ok) return { ok: false, error: `luma ${r.status}` };
      let gen = await r.json();
      for (let i = 0; i < 40 && gen.state !== "completed" && gen.state !== "failed"; i++) {
        await new Promise((x) => setTimeout(x, 6000));
        const pr = await fetch(`https://api.lumalabs.ai/dream-machine/v1/generations/${gen.id}`, {
          headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(20000),
        });
        gen = await pr.json();
      }
      if (gen.state !== "completed") return { ok: false, error: `luma ${gen.state}` };
      const url = gen.assets?.video;
      if (!url) return { ok: false, error: "video URL नहीं मिला" };
      const vr = await fetch(url, { signal: AbortSignal.timeout(120000) });
      return { ok: true, buf: Buffer.from(await vr.arrayBuffer()), mime: "video/mp4", via: "luma" };
    } catch (e) { return { ok: false, error: e.message }; }
  },
};

// AI creative video — text/photo से promotional short
async function makeCreativeVideo(brandId, brief, opts = {}) {
  const b = BRANDS[brandId];
  // 1) AI से अच्छा video prompt बनवाओ (हिंदी brief → अंग्रेज़ी visual prompt)
  const spec = await AI.json(
    `तुम एक video prompt writer हो। ${brandDesc(b)} के लिए एक ${opts.seconds || 10} सेकंड का
promotional short बनाना है। User ने कहा: "${String(brief).slice(0, 400)}"

सिर्फ़ valid JSON:
{
  "video_prompt": "English cinematic prompt — camera movement, lighting, mood. कोई text/logo/number मत माँगो (वो बाद में लगेगा)।",
  "overlay_hindi": "video पर लिखने वाला छोटा हिंदी text (max 6 शब्द)",
  "caption_hindi": "post का caption (3-4 lines, emojis के साथ)"
}

⚠️ video_prompt में कोई कीमत, EMI या offer मत डालो — AI video में लिखे अक्षर बिगड़ जाते हैं।`,
    { temperature: 0.8, timeout: 20000, maxTokens: 700 });

  if (spec.error) return { error: spec.error };

  // 2) provider chain से video बनवाओ
  const chain = order("AI_VIDEO_ORDER", "replicate,luma");
  const r = await AI._chain(chain, VIDEO_PROVIDERS, {
    prompt: spec.video_prompt, seconds: opts.seconds || 10,
    aspect: opts.aspect || "9:16", imageUrl: opts.imageUrl, timeout: 150000,
  }, "video");

  if (!r.ok) {
    return {
      error: "AI video provider उपलब्ध नहीं — " + r.error,
      hint: "Render env में REPLICATE_API_TOKEN + REPLICATE_VIDEO_VERSION या LUMA_API_KEY डालें। " +
            "तब तक photos से slideshow video बना सकते हैं (AI Video tab)।",
      spec,
    };
  }

  const name = `creative_${Date.now()}.mp4`;
  const fp = path.join(OUT_DIR, name);
  fs.writeFileSync(fp, r.buf);
  // AI video पर भी header — हर video एक जैसा professional दिखे
  const dims = (opts.aspect || "9:16") === "16:9" ? [1920, 1080] : (opts.aspect === "1:1" ? [1080, 1080] : [1080, 1920]);
  await stampVideoHeader(fp, brandId, dims[0], dims[1]);
  return { ok: true, video: `/generated/${name}`, provider: r.via, ...spec };
}

// ===========================================================================
//  PRD #29 — BATCH GENERATION
//  "आज के लिए 10 creatives बना दो" / "30 दिन का calendar बना दो"
// ===========================================================================
const BATCH_MAX = parseInt(process.env.BATCH_MAX || "15", 10);

// एक batch background में चलाओ — request block नहीं होती (PRD #40)
async function runBatch(jobId) {
  const job = await BatchJob.findById(jobId);
  if (!job) return;
  await BatchJob.findByIdAndUpdate(jobId, { status: "running", startedAt: new Date() });

  const b = BRANDS[job.brand];
  // AI से तय करवाओ कि कौन-कौन से posts बनें (एक जैसे न हों)
  const plan = await AI.json(
    `तुम ${brandDesc(b)} के marketing planner हो।
${job.brief ? `मालिक ने कहा: "${String(job.brief).slice(0, 300)}"` : ""}
${job.requested} अलग-अलग posts की सूची बनाओ। सब एक जैसे न हों।

उपलब्ध types: suvichar, vigyapan, festival, suchna, gift
गाड़ियाँ: ${b.products.join(", ")}

सिर्फ़ valid JSON:
{ "posts": [ { "type": "vigyapan", "topic_hindi": "किस बारे में — एक लाइन", "vehicle": "गाड़ी का नाम या खाली" } ] }

⚠️ ठीक ${job.requested} items। कोई price/EMI मत बनाओ।`,
    { temperature: 0.95, timeout: 30000, maxTokens: 2000 });

  const posts = Array.isArray(plan.posts) ? plan.posts.slice(0, job.requested) : [];
  if (!posts.length) {
    await BatchJob.findByIdAndUpdate(jobId, { status: "failed", error: plan.error || "AI ने plan नहीं दिया", finishedAt: new Date() });
    return;
  }

  const items = [];
  let done = 0, failed = 0;

  for (const pItem of posts) {
    // हर post से पहले cost limit जाँचो — बजट पार तो रुक जाओ
    const lim = await checkAndCountUsage(job.brand, "aiCalls");
    if (!lim.ok) {
      items.push({ error: "दैनिक AI सीमा पूरी — बाक़ी posts नहीं बने" });
      break;
    }
    // बीच में cancel दबाया गया?
    const cur = await BatchJob.findById(jobId).select("status");
    if (cur?.status === "cancelled") break;

    try {
      const ctx = [pItem.topic_hindi, pItem.vehicle && `गाड़ी: ${pItem.vehicle}`].filter(Boolean).join("\n");
      const doc = await genToPending(job.brand, pItem.type, undefined, ctx);
      if (!doc) throw new Error("post नहीं बना");
      await Content.findByIdAndUpdate(doc._id, { batchId: jobId });
      items.push({ contentId: doc._id, type: doc.type, text: String(doc.text).slice(0, 100) });
      done++;
    } catch (e) {
      items.push({ type: pItem.type, error: e.message });
      failed++;
    }
    await BatchJob.findByIdAndUpdate(jobId, { done, failed, items });
  }

  await BatchJob.findByIdAndUpdate(jobId, { status: "done", done, failed, items, finishedAt: new Date() });
  await activity(job.brand, "generate", failed ? "warning" : "success",
    `Batch पूरा — ${done} posts बने${failed ? `, ${failed} fail` : ""} (सब Review में हैं)`);
  notify("info", `${done} नए posts तैयार — Review करें`, job.brand);
  log("INFO", "[BATCH] done", { jobId: String(jobId), done, failed });
}

// ===========================================================================
//  PRD #23 — AUTOMATION TRIGGERS (समय के अलावा घटनाओं पर भी)
// ===========================================================================
const TRIGGER_EVENTS = {
  new_delivery: "नई delivery जुड़ने पर",
  new_vehicle:  "नई गाड़ी catalog में आने पर",
  new_lead:     "नया lead आने पर",
  festival_soon:"त्यौहार 2 दिन दूर होने पर",
  low_content:  "Review में 2 से कम posts बचने पर",
};

/**
 * किसी घटना पर trigger चलाओ।
 * ⚠️ यह कभी request को block नहीं करता — background में चलता है।
 * ⚠️ autoApprove default में false है, यानी post सिर्फ़ Review में जाएगी, भेजी नहीं जाएगी।
 */
async function fireTrigger(event, brand, payload = {}) {
  try {
    const rules = await TriggerRule.find({ brand, event, enabled: true });
    for (const rule of rules) {
      // cooldown — एक ही trigger बार-बार न चले
      if (rule.lastFiredAt && Date.now() - rule.lastFiredAt.getTime() < (rule.cooldownMins || 30) * 60000) {
        log("INFO", "[TRIGGER] cooldown में, skip", { event, brand });
        continue;
      }
      const lim = await checkAndCountUsage(brand, "aiCalls");
      if (!lim.ok) { log("WARN", "[TRIGGER] सीमा पूरी, skip", { event }); continue; }

      await TriggerRule.findByIdAndUpdate(rule._id, { lastFiredAt: new Date(), $inc: { fireCount: 1 } });

      if (rule.action === "notify_only") {
        notify("info", `${TRIGGER_EVENTS[event]} — ${payload.summary || ""}`, brand);
        continue;
      }

      const ctx = [
        TRIGGER_EVENTS[event],
        payload.customerName && `ग्राहक: ${payload.customerName}`,
        payload.bikeName && `गाड़ी: ${payload.bikeName}`,
        payload.vehicle && `गाड़ी: ${payload.vehicle}`,
        payload.summary,
      ].filter(Boolean).join("\n");

      const doc = await genToPending(brand, rule.contentType || "vigyapan", undefined, ctx);
      if (!doc) continue;
      await Content.findByIdAndUpdate(doc._id, { triggeredBy: event });

      await activity(brand, "generate", "success",
        `Trigger चला (${TRIGGER_EVENTS[event]}) — नया post Review में आया`, { contentId: doc._id });

      // ⚠️ auto-approve तभी जब मालिक ने खुद चालू किया हो
      if (rule.autoApprove) {
        const autoS = await AutomationSettings.findOne({ brand });
        if (autoS?.mode === "full") {
          await safePublish(Content, doc._id, null);
          await audit(null, { brand, action: "publish", entity: "content", entityId: doc._id,
            summary: `Trigger से अपने आप भेजा (${TRIGGER_EVENTS[event]})` });
        } else {
          notify("info", "Trigger से post बना — Approve करके भेजें", brand);
        }
      } else {
        notify("info", `${TRIGGER_EVENTS[event]} — नया post Review में है`, brand);
      }
    }
  } catch (e) { log("ERROR", "fireTrigger", { event, msg: e.message }); }
}

// request को रोके बिना trigger चलाओ
function fireTriggerAsync(event, brand, payload) {
  setImmediate(() => { fireTrigger(event, brand, payload).catch(() => {}); });
}

// ===========================================================================
//  PRD #33 — FB / IG असली INSIGHTS
//  ⚠️ अभी तक analytics सिर्फ़ अपने database से बनती थी (कितने भेजे)।
//     अब जहाँ API उपलब्ध है वहाँ असली views/likes/comments भी आते हैं।
// ===========================================================================
async function fetchPostInsights(doc) {
  const c = brandCreds(doc.brand);
  const out = {};
  const results = Array.isArray(doc.results) ? doc.results : [];

  for (const r of results) {
    if (!r.ok || !r.id) continue;
    try {
      if (r.platform === "fb" && c.fbToken) {
        const m = "post_impressions,post_engaged_users,post_clicks,post_reactions_by_type_total";
        const resp = await fetch(`${GRAPH}/${r.id}/insights?metric=${m}&access_token=${c.fbToken}`, { signal: AbortSignal.timeout(15000) });
        if (resp.ok) {
          const d = await resp.json();
          const pick = (n) => d.data?.find((x) => x.name === n)?.values?.[0]?.value;
          out.fb = {
            views: pick("post_impressions") || 0,
            engaged: pick("post_engaged_users") || 0,
            clicks: pick("post_clicks") || 0,
            reactions: Object.values(pick("post_reactions_by_type_total") || {}).reduce((a, b) => a + (b || 0), 0),
          };
        } else { out.fb = { error: `fb ${resp.status}` }; }
      }

      if (r.platform === "ig" && c.igToken) {
        const resp = await fetch(`${GRAPH}/${r.id}?fields=like_count,comments_count&access_token=${c.igToken}`, { signal: AbortSignal.timeout(15000) });
        if (resp.ok) {
          const d = await resp.json();
          out.ig = { likes: d.like_count || 0, comments: d.comments_count || 0 };
          // reach अलग endpoint से (कभी-कभी उपलब्ध नहीं होता)
          try {
            const ir = await fetch(`${GRAPH}/${r.id}/insights?metric=reach&access_token=${c.igToken}`, { signal: AbortSignal.timeout(12000) });
            if (ir.ok) {
              const idata = await ir.json();
              out.ig.reach = idata.data?.find((x) => x.name === "reach")?.values?.[0]?.value || 0;
            }
          } catch (_) {}
        } else { out.ig = { error: `ig ${resp.status}` }; }
      }
    } catch (e) { out[r.platform] = { error: e.message }; }
  }

  out.total = (out.fb?.views || 0) + (out.ig?.reach || 0);
  out.engagement = (out.fb?.reactions || 0) + (out.fb?.clicks || 0) + (out.ig?.likes || 0) + (out.ig?.comments || 0);
  return out;
}

// भेजे हुए posts के insights refresh करो (रोज़ रात cron से)
async function refreshAllInsights(brand, days) {
  const since = new Date(Date.now() - (days || 30) * 864e5);
  const q = { status: "sent", sentAt: { $gte: since } };
  if (brand && BRANDS[brand]) q.brand = brand;

  const docs = await Content.find(q).select("brand results insightsAt").sort({ sentAt: -1 }).limit(60);
  let updated = 0;
  for (const d of docs) {
    // 6 घंटे से नया data है तो दोबारा मत माँगो (API quota बचाओ)
    if (d.insightsAt && Date.now() - d.insightsAt.getTime() < 6 * 3600 * 1000) continue;
    try {
      const ins = await fetchPostInsights(d);
      await Content.findByIdAndUpdate(d._id, { insights: ins, insightsAt: new Date() });
      updated++;
    } catch (_) {}
  }
  log("INFO", "[INSIGHTS] refresh", { brand: brand || "all", updated, scanned: docs.length });
  return { updated, scanned: docs.length };
}

// ===========================================================================
//  PRD #22 — MCP (Model Context Protocol)
//  बाहर के AI tools (जैसे Claude) इस app का डेटा सीधे पढ़ सकें।
//  ⚠️ सब कुछ READ-ONLY है — कोई बाहरी tool यहाँ से post नहीं भेज सकता।
// ===========================================================================
const MCP_TOOLS = [
  { name: "list_brands", description: "तीनों brands की जानकारी (नाम, पता, फ़ोन, गाड़ियाँ)", inputSchema: { type: "object", properties: {} } },
  { name: "list_vehicles", description: "किसी brand की गाड़ियाँ — कीमत, EMI, stock", inputSchema: { type: "object", properties: { brand: { type: "string" } }, required: ["brand"] } },
  { name: "pending_content", description: "Review में जो posts हैं", inputSchema: { type: "object", properties: { brand: { type: "string" } } } },
  { name: "recent_activity", description: "AI ने हाल में क्या किया", inputSchema: { type: "object", properties: { brand: { type: "string" }, limit: { type: "number" } } } },
  { name: "analytics_summary", description: "पिछले N दिन का हिसाब — कितने posts, कितनी engagement", inputSchema: { type: "object", properties: { brand: { type: "string" }, days: { type: "number" } } } },
  { name: "leads", description: "आए हुए leads", inputSchema: { type: "object", properties: { brand: { type: "string" } } } },
];

async function mcpCall(name, args = {}) {
  const brand = BRANDS[args.brand] ? args.brand : undefined;
  switch (name) {
    case "list_brands":
      return Object.entries(BRANDS).map(([id, b]) => ({
        id, name: b.name, sub: b.sub, kind: b.kind, place: b.place, phone: b.phone, products: b.products,
      }));

    case "list_vehicles": {
      if (!brand) throw new Error("brand चाहिए");
      return await Vehicle.find({ brand }).select("-__v").limit(80).lean();
    }

    case "pending_content": {
      const q = { status: "pending" }; if (brand) q.brand = brand;
      return await Content.find(q).select("brand type text createdAt").sort({ createdAt: -1 }).limit(30).lean();
    }

    case "recent_activity": {
      const q = {}; if (brand) q.brand = brand;
      return await ActivityLog.find(q).sort({ createdAt: -1 }).limit(Math.min(args.limit || 25, 60)).lean();
    }

    case "analytics_summary": {
      const days = Math.min(Math.max(parseInt(args.days) || 7, 1), 90);
      const since = new Date(Date.now() - days * 864e5);
      const q = { createdAt: { $gte: since } }; if (brand) q.brand = brand;
      const [sent, pending, delivs, leads, withIns] = await Promise.all([
        Content.countDocuments({ ...q, status: "sent" }),
        Content.countDocuments({ ...q, status: "pending" }),
        Delivery.countDocuments({ ...q, status: "sent" }),
        Lead.countDocuments(q),
        Content.find({ ...q, status: "sent", insights: { $ne: null } }).select("insights type").lean(),
      ]);
      const eng = withIns.reduce((a, x) => a + (x.insights?.engagement || 0), 0);
      const views = withIns.reduce((a, x) => a + (x.insights?.total || 0), 0);
      return { days, postsSent: sent, postsPending: pending, deliveriesSent: delivs, leads, totalViews: views, totalEngagement: eng };
    }

    case "leads": {
      const q = {}; if (brand) q.brand = brand;
      return await Lead.find(q).sort({ createdAt: -1 }).limit(40).lean();
    }

    default:
      throw new Error("अनजान tool: " + name);
  }
}

// ===========================================================================
//  PRD #14 — AI VOICE (Hindi/Hinglish voice-over)
// ===========================================================================
const VOICE_STYLES = {
  professional: "पेशेवर, शांत और भरोसेमंद",
  energetic:    "जोशीला, तेज़ और उत्साही",
  friendly:     "दोस्ताना, अपनापन भरा",
  announcement: "घोषणा जैसा, साफ़ और ठहरा हुआ",
  promotional:  "विज्ञापन जैसा, आकर्षक और खरीदने को प्रेरित करने वाला",
};

// AI से voice-over की script बनवाओ (poster/offer के text से)
async function makeVoiceScript(brandId, sourceText, style, seconds) {
  const b = BRANDS[brandId];
  const memCtx = await brandMemoryContext(brandId);
  // ~2.6 हिंदी शब्द प्रति सेकंड
  const words = Math.max(12, Math.round((seconds || 20) * 2.6));
  const sys = `तुम ${brandDesc(b)} के लिए voice-over script लिखते हो।
Showroom: ${b.place} | फ़ोन: ${b.phone}
अंदाज़: ${VOICE_STYLES[style] || VOICE_STYLES.friendly}
${memCtx ? `\n【मालिक की पसंद】\n${memCtx}\n` : ""}
यह content है जिसका voice-over बनाना है:
"""
${String(sourceText || "").slice(0, 900)}
"""

सिर्फ़ valid JSON लौटाओ:
{
  "script": "बोलने वाला हिंदी text — लगभग ${words} शब्द, कोई emoji नहीं, कोई hashtag नहीं, कोई bracket नहीं",
  "subtitles": [ { "t": 0, "text": "पहली लाइन" }, { "t": 4, "text": "दूसरी लाइन" } ],
  "note_hindi": "एक लाइन — यह script कैसी है"
}

सख़्त नियम:
- script में सिर्फ़ वही बोलो जो बोलकर सुनने में अच्छा लगे — emoji/hashtag/★ जैसे चिह्न बिल्कुल नहीं
- कोई नया price/EMI/offer मत बनाओ, सिर्फ़ ऊपर दिए content से लो
- आख़िर में showroom का नाम और फ़ोन नंबर ज़रूर बोलो
- subtitles में हर line 4-6 सेकंड की, t सेकंड में`;

  const out = await AI.json(sys, { temperature: 0.7, timeout: 20000, maxTokens: 900 });
  if (out.error) return out;
  // सुरक्षा: emoji निकल जाएँ तो आवाज़ में "डिब्बा" नहीं बोला जाएगा
  out.script = stripEmoji(String(out.script || "")).replace(/[#*_`~|]/g, " ").replace(/\s+/g, " ").trim();
  if (!Array.isArray(out.subtitles)) out.subtitles = [];
  return out;
}

// mp3 की लंबाई पता करो (ffprobe से, न मिले तो अंदाज़ा)
function audioDuration(file) {
  return new Promise((res) => {
    execFile("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", file],
      (e, out) => res(e ? null : Math.round(parseFloat(out) * 10) / 10));
  });
}

// SRT subtitle file बनाओ (PRD #12 — subtitles)
function buildSRT(subs) {
  const fmt = (t) => {
    const h = String(Math.floor(t / 3600)).padStart(2, "0");
    const m = String(Math.floor((t % 3600) / 60)).padStart(2, "0");
    const sec = String(Math.floor(t % 60)).padStart(2, "0");
    const ms = String(Math.round((t % 1) * 1000)).padStart(3, "0");
    return `${h}:${m}:${sec},${ms}`;
  };
  return (subs || []).map((sObj, i) => {
    const start = Number(sObj.t) || 0;
    const end = (subs[i + 1] && Number(subs[i + 1].t)) || start + 4;
    return `${i + 1}\n${fmt(start)} --> ${fmt(end)}\n${sObj.text}\n`;
  }).join("\n");
}

// video + voice mix (PRD #12 — optional voice-over)
function muxAudio(videoPath, audioPath, outPath, musicPath) {
  return new Promise((res, rej) => {
    const args = ["-y", "-i", videoPath, "-i", audioPath];
    if (musicPath && fs.existsSync(musicPath)) {
      // voice ऊपर, music हल्का पीछे
      args.push("-i", musicPath,
        "-filter_complex", "[2:a]volume=0.18[bg];[1:a]volume=1.0[vo];[vo][bg]amix=inputs=2:duration=first:dropout_transition=2[a]",
        "-map", "0:v", "-map", "[a]");
    } else {
      args.push("-map", "0:v", "-map", "1:a");
    }
    args.push("-c:v", "copy", "-c:a", "aac", "-b:a", "128k", "-shortest", outPath);
    execFile("ffmpeg", args, { maxBuffer: 1024 * 1024 * 20 },
      (e, _o, se) => (e ? rej(new Error("mux: " + (se || e.message).slice(0, 200))) : res()));
  });
}

// ===========================================================================
//  PRD #15 + #16 — AI CAPTION GENERATOR + PLATFORM ADAPTER
//  एक content → हर platform का अपना version
// ===========================================================================
const PLATFORM_RULES = {
  whatsapp:  "छोटा और सीधा। 3-5 lines. emojis भरपूर. आख़िर में फ़ोन नंबर. कोई hashtag नहीं.",
  instagram: "visual-first caption. 3-4 lines + line break + 8-12 relevant hashtags अलग लाइन में.",
  facebook:  "local business जैसा detailed post. 5-8 lines. पता व फ़ोन ज़रूर. 3-5 hashtags.",
  youtube:   "Shorts के लिए — title max 60 अक्षर + 2-3 line description + 5 hashtags.",
  status:    "बहुत छोटा — 1-2 lines, max 90 अक्षर, 2-3 emoji.",
};

async function adaptToPlatforms(brandId, sourceText, platforms, extra) {
  const b = BRANDS[brandId];
  const memCtx = await brandMemoryContext(brandId);
  const want = (platforms && platforms.length ? platforms : Object.keys(PLATFORM_RULES))
    .filter((x) => PLATFORM_RULES[x]);

  const sys = `तुम ${brandDesc(b)} के social media manager हो।
Showroom: ${b.place} | फ़ोन: ${b.phone} | WhatsApp: ${b.whatsapp}
Hashtags जो इस brand के हैं: ${(b.hashtags || []).join(" ")}
${memCtx ? `\n【मालिक की पसंद — इनका पालन करो】\n${memCtx}\n` : ""}
${extra ? `\nअतिरिक्त जानकारी: ${extra}\n` : ""}
यह मूल content है:
"""
${String(sourceText || "").slice(0, 1200)}
"""

इसी एक content को हर platform के हिसाब से अलग-अलग ढालो।
सिर्फ़ valid JSON लौटाओ:
{
${want.map((k) => `  "${k}": { "text": "...", "hashtags": ["#..."] }`).join(",\n")},
  "shortCaption": "एक लाइन (max 60 अक्षर)",
  "longCaption": "विस्तृत version (6-10 lines)",
  "cta": "एक छोटा call-to-action जैसे 'आज ही विज़िट करें'",
  "whatsappMessage": "सीधे forward करने लायक पूरा WhatsApp message"
}

हर platform के नियम:
${want.map((k) => `- ${k}: ${PLATFORM_RULES[k]}`).join("\n")}

सख़्त नियम:
- कोई भी price/EMI/offer जो मूल content में नहीं है — मत बनाओ
- सब Hindi/Hinglish में
- brand का नाम "${b.name}" ही लिखो, कुछ और नहीं`;

  return await AI.json(sys, { temperature: 0.75, timeout: 25000, maxTokens: 2000 });
}

// ===========================================================================
//  PRD #28 — CONTENT VARIATIONS (कई versions + AI की सिफ़ारिश)
// ===========================================================================
async function makeCaptionVariants(brandId, topic, count, extra) {
  const b = BRANDS[brandId];
  const memCtx = await brandMemoryContext(brandId);
  const n = Math.min(Math.max(parseInt(count) || 3, 2), 5);
  const sys = `तुम ${brandDesc(b)} (${b.place}, फ़ोन ${b.phone}) के copywriter हो।
${memCtx ? `\n【मालिक की पसंद】\n${memCtx}\n` : ""}
विषय: ${topic}
${extra ? `जानकारी: ${extra}` : ""}

इसी एक विषय के ${n} बिल्कुल अलग-अलग version बनाओ — हर एक का अंदाज़ अलग हो
(जैसे: भावुक / धमाकेदार / सीधा-साफ़ / मज़ेदार / urgent)।

सिर्फ़ valid JSON:
{
  "variants": [
    { "style_hindi": "अंदाज़ का नाम", "text": "पूरा post text (3-6 lines, emojis के साथ)", "hashtags": ["#..."] }
  ],
  "recommendedIndex": 0,
  "recommendReason_hindi": "यह version क्यों सबसे अच्छा है — एक लाइन"
}

नियम:
- ठीक ${n} variants
- कोई नया price/EMI/offer मत बनाओ
- हर variant सच में अलग लगे, सिर्फ़ शब्द इधर-उधर मत करो`;

  const out = await AI.json(sys, { temperature: 1.0, timeout: 25000, maxTokens: 2000 });
  if (out.error) return out;
  if (Array.isArray(out.variants)) out.variants = out.variants.slice(0, n);
  return out;
}

async function makePosterSpecVariants(brandId, command, vehicle, offerDetails, count) {
  const n = Math.min(Math.max(parseInt(count) || 3, 2), 4);
  const vCtx = await vehicleContext(brandId, vehicle);
  const merged = [vCtx && `Database से असली जानकारी:\n${vCtx}`, offerDetails].filter(Boolean).join("\n");
  const hints = ["बहुत कम text, बड़ा headline", "offer boxes पर ज़ोर, ज़्यादा जानकारी", "त्यौहार/उत्सव वाला रंगीन अंदाज़", "साफ़-सुथरा professional look"];
  const out = [];
  for (let i = 0; i < n; i++) {
    const spec = await generatePosterSpec(brandId, `${command}\n(Design हिंट: ${hints[i % hints.length]})`, vehicle, merged, "vigyapan");
    out.push(spec.error ? { error: spec.error, hint: hints[i % hints.length] } : { ...spec, hint_hindi: hints[i % hints.length] });
  }
  const good = out.map((x, i) => ({ i, ok: !x.error })).filter((x) => x.ok);
  return {
    variants: out,
    recommendedIndex: good.length ? good[0].i : 0,
    recommendReason_hindi: good.length ? "यह version सबसे साफ़ और पढ़ने में आसान है" : "कोई version नहीं बन पाया",
  };
}

// ===========================================================================
//  PRD #25 — NEWS / CURRENT INFORMATION
//  ⚠️ AI कोई खबर खुद नहीं बनाएगा। हर खबर के साथ source URL अनिवार्य है।
// ===========================================================================
// भरोसेमंद sources — इनके अलावा कहीं से खबर नहीं ली जाती
const TRUSTED_NEWS = [
  { name: "Autocar India",       feed: "https://www.autocarindia.com/rss/news" },
  { name: "Bike Dekho",          feed: "https://www.bikedekho.com/rss/news" },
  { name: "Team-BHP",            feed: "https://www.team-bhp.com/forum/external.php?type=RSS2" },
  { name: "Economic Times Auto", feed: "https://auto.economictimes.indiatimes.com/rss/topstories" },
  { name: "PIB India",           feed: "https://pib.gov.in/RssMain.aspx?ModId=6&Lang=1&Regid=3" },
];

// बहुत हल्का RSS parser (कोई नई dependency नहीं)
function parseRSS(xml, sourceName) {
  const items = [];
  const blocks = String(xml).split(/<item[\s>]/i).slice(1);
  for (const blk of blocks.slice(0, 12)) {
    const pick = (tag) => {
      const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i").exec(blk);
      if (!m) return "";
      return m[1]
        .replace(/<!\[CDATA\[|\]\]>/g, "")
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ").trim();
    };
    const title = pick("title"), link = pick("link");
    if (!title || !link) continue;    // ⚠️ URL नहीं तो खबर नहीं
    items.push({
      headline: title.slice(0, 220),
      rawSummary: pick("description").slice(0, 600),
      sourceUrl: link,
      sourceName,
      publishedAt: pick("pubDate") || pick("dc:date") || "",
    });
  }
  return items;
}

async function fetchTrustedNews(limitPerSource) {
  const out = [];
  for (const src of TRUSTED_NEWS) {
    try {
      const r = await fetch(src.feed, {
        headers: { "User-Agent": "Mozilla/5.0 AutoSuVichar" },
        signal: AbortSignal.timeout(12000),
      });
      if (!r.ok) { log("WARN", "[NEWS] feed fail", { src: src.name, status: r.status }); continue; }
      out.push(...parseRSS(await r.text(), src.name).slice(0, limitPerSource || 4));
    } catch (e) { log("WARN", "[NEWS] feed error", { src: src.name, msg: e.message }); }
  }
  return out;
}

// AI सिर्फ़ SUMMARISE करता है — नई बात जोड़ने की अनुमति नहीं
async function summariseNews(brandId, items) {
  if (!items.length) return { items: [] };
  const b = BRANDS[brandId];
  const sys = `तुम ${brandDesc(b)} के लिए auto-industry खबरों का सार बनाते हो।

नीचे असली खबरें दी गई हैं (हर एक का source URL भी है)।

${items.map((x, i) => `[${i}] स्रोत: ${x.sourceName}\nशीर्षक: ${x.headline}\nविवरण: ${x.rawSummary}`).join("\n\n")}

सिर्फ़ valid JSON लौटाओ:
{
  "items": [
    {
      "index": 0,
      "headline_hindi": "हिंदी में शीर्षक",
      "summary_hindi": "2-3 lines का सार — सिर्फ़ ऊपर दी गई जानकारी से",
      "relevant": true,
      "relevance_hindi": "यह हमारे showroom के ग्राहकों के लिए क्यों काम की है (या क्यों नहीं)",
      "verified": true,
      "verifyNote_hindi": "अगर ऊपर दिए विवरण में जानकारी अधूरी है तो verified=false और यहाँ कारण लिखो"
    }
  ]
}

⚠️ बहुत सख़्त नियम:
- ऊपर दी गई जानकारी के अलावा एक भी बात मत जोड़ो — कोई तारीख़, कोई कीमत, कोई आँकड़ा जो वहाँ नहीं है
- अगर विवरण बहुत कम है तो verified=false रखो और साफ़ लिखो कि जानकारी अधूरी है
- कोई अफ़वाह, अंदाज़ा या भविष्यवाणी नहीं
- index वही रखो जो ऊपर [ ] में दिया है`;

  return await AI.json(sys, { temperature: 0.2, timeout: 30000, maxTokens: 2500 });
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
  const waToken = c.waToken || process.env.WA_TOKEN || ""; if (!c.waPhoneId || !waToken) throw new Error("WA creds missing");
  if (!c.waRecipients.length) throw new Error("कोई WA recipient नहीं");
  const out = [];
  for (const to of c.waRecipients) {
    // ⚠️ पहले relative path (/generated/..) भेजा जा रहा था — Meta उसे fetch नहीं कर पाता
    const rawImg = item.imgUrl || item.images?.square || item.images?.landscape || "";
    const waImg = rawImg.startsWith("http") ? rawImg : `${PUBLIC_URL}${rawImg}`;
    if (!rawImg) throw new Error("WA: image URL नहीं मिला");
    const r = await fetch(`${GRAPH}/${c.waPhoneId}/messages`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${waToken}` }, body: JSON.stringify({ messaging_product: "whatsapp", to, type: "image", image: { link: waImg, caption: item.text } }) });
    out.push(await r.json());
  }
  return out;
}
async function publish(item) {
  await loadSettings();
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
// ⚠️ पहले default 100kb था — AI Delivery/Video के base64 photos 413 से fail होते थे
app.use(express.json({ limit: "30mb" }));
app.use(express.urlencoded({ extended: true, limit: "30mb" }));
app.use("/generated", express.static(OUT_DIR));
// ⚠️ बहुत बड़ा bug: /logos और /vehicles कभी serve ही नहीं हो रहे थे (सिर्फ़ /generated था)।
//    इसलिए हर editor में brand logo चुपचाप 404 हो जाता था और poster पर logo आता ही नहीं था।
//    (इसी वजह से PromoEditor/DeliveryEditor में VP Honda का logo base64 में हार्डकोड करना पड़ा था।)
const staticOpts = { maxAge: "1d", setHeaders: (res) => { res.set("Access-Control-Allow-Origin", "*"); res.set("Cross-Origin-Resource-Policy", "cross-origin"); } };
app.use("/logos", express.static(LOGO_DIR, staticOpts));
app.use("/vehicles", express.static(VEHICLE_DIR, staticOpts));
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
const PUBLIC = [/^\/generated\//, /^\/api\/health$/, /^\/api\/auth\/login$/, /^\/api\/festivals$/, /^\/api\/designs$/, /^\/api\/image\//, /^\/api\/lead$/, /^\/api\/whatsapp\/webhook$/, /^\/api\/oauth\/google\/callback$/];
app.use((req, res, next) => {
  if (req.method === "OPTIONS") return next();
  if (PUBLIC.some((rx) => rx.test(req.path)) || !req.path.startsWith("/api/")) return next();
  try { req.user = jwt.verify((req.headers.authorization || "").replace("Bearer ", ""), JWT_SECRET); next(); }
  catch (e) { res.status(401).json({ error: "unauthorized — login करें" }); }
});
const requireRole = (...roles) => (req, res, next) => roles.includes(req.user.role) ? next() : res.status(403).json({ error: "इस काम की अनुमति नहीं" });

app.get("/api/health", (req, res) => res.json({ ok: true, version: "v56-provider-tuning", testMode: TEST_MODE, video: ENABLE_VIDEO, cron: ENABLE_CRON ? CRON_SCHEDULE : false, brands: Object.keys(BRANDS), logos: availableLogos(), storage: diskUsage(), memory: memoryWatch(), features: ["voice", "adapter", "variants", "news", "provider-agnostic", "retry", "audit", "cleanup", "rate-limit", "batch", "triggers", "insights", "creative-video", "mcp", "daily-engine", "auto-video", "video-header", "wa-approval", "monthly-report", "customer-wa", "lead-alert", "voice-command"], ai: AI.status(), ownerLogo: fs.existsSync(path.join(LOGO_DIR, OWNER_LOGO_FILE)), aiImageKey: !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY), aiTextKey: !!process.env.OPENAI_API_KEY }));

// ---- Auth ----
// brute-force रोकने के लिए — एक IP से 15 मिनट में 10 login कोशिशें
app.post("/api/auth/login", rateLimit({ windowMs: 15 * 60000, max: 10, key: "login", message: "बहुत बार गलत कोशिश — 15 मिनट बाद try करें" }), async (req, res) => {
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
    ["fbPageId", "fbToken", "igUserId", "ytRefreshToken", "waPhoneId", "waToken", "waRecipients"].forEach((k) => {
      const v = req.body[k];
      if (v !== undefined && v !== "••••set" && v !== "" && v !== null) creds[k] = v;
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

// ── Manual / Vercel Cron Trigger ──────────────────────────────
// Vercel cron job इस endpoint को call करेगा — Render sleep bypass
app.post("/api/cron/trigger", async (req, res) => {
  const secret = req.headers["x-cron-secret"] || req.query.secret;
  if (secret !== (process.env.CRON_SECRET || "autosuvichar-cron-2024")) {
    return res.status(401).json({ error: "unauthorized" });
  }
  const { job } = req.body; // "suvichar" | "promo" | "delivery"
  log("INFO", `[TRIGGER] Manual cron: ${job}`);
  res.json({ ok: true, job, started: true }); // तुरंत respond करो — फिर async काम करो

  // Background में run करो
  setImmediate(async () => {
    try {
      if (job === "suvichar") {
        const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
        const fest = FESTIVALS.find((f) => f.date === today);
        for (const brand of Object.keys(BRANDS)) {
          try {
            const type = fest ? "festival" : "suvichar";
            const doc = await genToPending(brand, type, fest?.name || "");
            const results = await publish({ ...doc.toObject(), platforms: { fb: true, ig: true, wa: false, yt: false } });
            const ok = results.filter(r => r.ok).map(r => r.platform);
            await Content.findByIdAndUpdate(doc._id, { status: ok.length ? "sent" : "failed", channels: ok, sentAt: new Date(), results });
            if (!ok.length) await notify("post_failed", `⚠️ ${BRANDS[brand].name}: सुविचार auto-post fail
👉 App → दोबारा`, brand);
          } catch (e) { await notify("post_failed", `❌ ${BRANDS[brand]?.name||brand}: सुविचार error: ${e.message}`, brand); }
        }
      } else if (job === "promo") {
        for (const brand of Object.keys(BRANDS)) {
          try {
            const doc = await genToPending(brand, "vigyapan", "");
            const results = await publish({ ...doc.toObject(), platforms: { fb: true, ig: true, wa: false, yt: false } });
            const ok = results.filter(r => r.ok).map(r => r.platform);
            await Content.findByIdAndUpdate(doc._id, { status: ok.length ? "sent" : "failed", channels: ok, sentAt: new Date(), results });
            if (!ok.length) await notify("post_failed", `⚠️ ${BRANDS[brand].name}: विज्ञापन fail
👉 App → दोबारा`, brand);
          } catch (e) { await notify("post_failed", `❌ ${BRANDS[brand]?.name||brand}: विज्ञापन error: ${e.message}`, brand); }
        }
      } else if (job === "delivery") {
        const pending = await Delivery.find({ status: "pending" })
          .select("-imageData").sort({ createdAt: -1 }).limit(10).lean();
        for (const d of pending) {
          try {
            const results = await publish({ ...d, platforms: { fb: true, ig: true, wa: true, yt: false } });
            const ok = results.filter(r => r.ok).map(r => r.platform);
            await Delivery.findByIdAndUpdate(d._id, { status: ok.length ? "sent" : "failed", channels: ok, sentAt: new Date(), results });
            if (!ok.length) await notify("post_failed", `⚠️ ${BRANDS[d.brand]?.name||d.brand}: डिलीवरी fail
👉 Manual share करें`, d.brand);
          } catch (e) { await notify("post_failed", `❌ डिलीवरी error: ${e.message}`, d.brand || null); }
        }
      }
      log("INFO", `[TRIGGER] ${job} completed`);
    } catch (e) { log("ERROR", `[TRIGGER] ${job} error`, { msg: e.message }); }
  });
});

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
// ══════════════════════════════════════════════════════════════
// AI COMMAND CENTER — एक ही natural-language command से पूरा content बने
// User बोले/लिखे: "आज Honda Shine का ऑफर बनाओ" या "कल सुविचार schedule करो"
// AI खुद brand, type, festival, schedule time समझे
// ══════════════════════════════════════════════════════════════
async function parseCommandIntent(commandText, defaultBrand) {
  const brandList = Object.entries(BRANDS).map(([id, b]) => `${id} = "${b.name}" (${b.sub}, products: ${b.products.join(", ")})`).join("\n");
  const todayIST = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const nowIST = new Date().toLocaleString("en-GB", { timeZone: "Asia/Kolkata", hour12: false });

  const sys = `तुम "AutoSuVichar" app के लिए एक AI Command Parser हो। User Hindi/Hinglish में एक natural command देगा
(जैसे "आज Honda Shine का ऑफर बनाओ" या "कल सुबह 9 बजे सुविचार schedule करो")।
तुम्हें उसमें से नीचे दिया गया JSON structure निकालना है — सिर्फ़ valid JSON return करो, कोई extra text नहीं।

आज की तारीख (IST): ${todayIST}, अभी समय: ${nowIST}

Available brands:
${brandList}

Content types: suvichar (सुविचार/शुभप्रभात), vigyapan (विज्ञापन/ऑफर), festival (त्यौहार शुभकामना), suchna (सूचना), gift (गिफ्ट प्रचार)

JSON structure जो तुम्हें return करना है:
{
  "brand": "vp_honda" | "yakuza" | "minimetro" | null,   // अगर स्पष्ट न हो तो null
  "type": "suvichar" | "vigyapan" | "festival" | "suchna" | "gift",
  "vehicle": "जो specific product/vehicle mention हुआ, वरना null",
  "offer_details": "जो offer/price/EMI/down-payment की बात हुई वो string में, वरना null",
  "custom_text": "अगर user ने खुद पूरा text/message दिया है तो वो, वरना null",
  "schedule": {
    "when": "now" | "today" | "tomorrow" | "specific_date",
    "date": "YYYY-MM-DD या null अगर 'now'/'today'/'tomorrow' से पता चल जाए",
    "time": "HH:mm (24hr) या null अगर unspecified",
    "recurring": "daily" | "weekly" | null
  },
  "missing_info": ["कोई ज़रूरी चीज़ जो पता नहीं चली — सिर्फ़ बहुत ज़रूरी हो तभी"],
  "confidence": "high" | "medium" | "low",
  "summary_hindi": "एक लाइन में user को दिखाने के लिए — तुमने command से क्या समझा"
}

Rules:
- brand स्पष्ट न बताया गया हो तो null रखो, इंसान से मत पूछो अपने-आप मत चुनो
- अगर सिर्फ़ "आज कुछ अच्छा बना दो" जैसा vague command है तो type="suvichar", confidence="low"
- missing_info में सिर्फ़ वही डालो जो वाकई ज़रूरी है (जैसे brand पता नहीं तो ज़रूरी है)
- price/EMI कभी खुद मत बनाओ — सिर्फ़ जो user ने बताया वो offer_details में डालो`;

  try {
    const parsed = await AI.json(sys + "\n\nUser command: \"" + commandText + "\"", { temperature: 0.3, timeout: 15000, maxTokens: 900 });
    if (parsed.error) throw new Error(parsed.error);
    if (!parsed.brand && defaultBrand) parsed.brand = defaultBrand;
    return parsed;
  } catch (e) {
    log("ERROR", "parseCommandIntent", { msg: e.message });
    return { error: e.message, brand: defaultBrand, type: "suvichar", confidence: "low", summary_hindi: "AI समझ नहीं पाया — manual से try करें" };
  }
}

// Step 1: Command समझो, preview दो (अभी generate मत करो)
app.post("/api/command/understand", async (req, res) => {
  try {
    const { command, defaultBrand } = req.body;
    if (!command || !command.trim()) return res.status(400).json({ error: "command खाली है" });
    const intent = await parseCommandIntent(command.trim(), defaultBrand);
    res.json(intent);
  } catch (e) { log("ERROR", "/command/understand", { msg: e.message }); res.status(500).json({ error: e.message }); }
});

// Step 2: User confirm करे तो actual content generate करो (schedule हो तो pending में डालो, अभी हो तो generate करके दो)
// ══════════════════════════════════════════════════════════════
// PHASE 2 — AI POSTER GENERATOR
// Command से AI खुद पूरा poster design तय करे: headline, offer boxes,
// background, colors, layout — user को कुछ चुनना न पड़े
// ══════════════════════════════════════════════════════════════
async function generatePosterSpec(brandId, commandText, vehicle, offerDetails, type) {
  const b = BRANDS[brandId];
  const memCtx = await brandMemoryContext(brandId);
  const todayIST = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const upcomingFest = FESTIVALS.filter(f => f.date >= todayIST).sort((a, b2) => a.date.localeCompare(b2.date))[0];

  const sys = `तुम "${b.name}" (${b.sub}) के लिए एक expert poster designer AI हो।
Showroom: ${b.place}, Phone: ${b.phone}
Products: ${b.products.join(", ")}
Brand color: ${b.accent}
आज: ${todayIST}${upcomingFest ? `, आने वाला त्यौहार: ${upcomingFest.name} (${upcomingFest.date})` : ""}

${memCtx ? `【मालिक की पसंद — इनका पालन करो】\n${memCtx}\n` : ""}
User का command: "${commandText}"
${vehicle ? `Vehicle: ${vehicle}` : ""}
${offerDetails ? `Offer details जो user ने दिए: ${offerDetails}` : ""}

तुम्हें एक poster का पूरा design spec JSON में देना है। सिर्फ़ valid JSON, कोई extra text नहीं।

{
  "posterType": "mega_offer" | "booking" | "multibike" | "lucky_draw" | "simple",
  "headline": "बड़ा मुख्य टेक्स्ट (1-3 शब्द प्रति line, \\n से लाइन तोड़ें, max 3 lines)",
  "subHeadline": "छोटी सहायक लाइन (एक line, max 45 chars)",
  "bgStyle": "yellow_red" | "red_dark" | "blue_dark" | "orange_red" | "gold_dark" | "green_dark" | "purple_dark" | "white_clean",
  "bigOffer": "सबसे बड़ा offer जो highlight हो (\\n से 2 lines, वरना null)",
  "offerBoxes": [
    { "icon": "एक emoji", "text": "offer text (max 28 chars)" }
  ],
  "roiText": "जैसे 'सिर्फ 6.99%' — वरना null",
  "roiSub": "जैसे 'की ब्याज दर' — वरना null",
  "bottomBanner": "नीचे की पट्टी का text (max 45 chars) — वरना null",
  "locationCTA": "जैसे 'आज ही विज़िट करें\\nऑफर का लाभ उठाएं!' — वरना null",
  "caption": "social media caption — 2-4 lines Hindi + 3-4 hashtags, emojis के साथ",
  "reasoning_hindi": "एक लाइन में — तुमने ये design क्यों चुना"
}

सख़्त नियम:
- offerBoxes में max 3 items
- कोई भी price/EMI/cashback जो user ने नहीं बताया — वो मत बनाओ। अगर offerDetails खाली है तो offerBoxes में generic चीज़ें डालो जैसे "आसान EMI उपलब्ध", "Exchange सुविधा", "Free Test Ride" — कोई fake number नहीं
- अगर user ने specific numbers दिए हैं तो वही use करो
- bgStyle त्यौहार/mood के हिसाब से चुनो
- headline छोटा और punchy — poster पर बड़ा दिखेगा
- सब text Hindi/Hinglish में`;


  const spec = await AI.json(sys, { temperature: 0.7, timeout: 15000, maxTokens: 1400 });
  if (spec.error) return { error: spec.error };
  if (Array.isArray(spec.offerBoxes)) spec.offerBoxes = spec.offerBoxes.slice(0, 3);
  return spec;
}

// AI से poster spec बनवाओ (frontend इसे MegaOfferEditor जैसे canvas में render करेगा)
// ══════════════════════════════════════════════════════════════
// PHASE 4 — AUTO MARKETING ENGINE
// एक button से AI पूरे दिन/हफ्ते का content plan बनाए और सब तैयार करे
// ══════════════════════════════════════════════════════════════
async function generateMarketingPlan(brandIds, days, notes) {

  const todayIST = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
  const brandInfo = brandIds.map(id => {
    const b = BRANDS[id];
    return `${id} = "${b.name}" (${b.sub}), products: ${b.products.join(", ")}`;
  }).join("\n");

  // अगले N दिनों के त्यौहार
  const upcoming = FESTIVALS.filter(f => {
    const diff = (new Date(f.date) - new Date(todayIST)) / 86400000;
    return diff >= 0 && diff < days;
  }).map(f => `${f.date} = ${f.name}`).join(", ") || "कोई नहीं";

  // पिछले 10 posts — repetition रोकने के लिए
  let recent = "";
  try {
    const rc = await Content.find({ brand: { $in: brandIds } }).sort({ createdAt: -1 }).limit(10).select("type text").lean();
    recent = rc.map(r => `[${r.type}] ${String(r.text || "").slice(0, 60)}`).join("\n") || "कोई नहीं";
  } catch (_) { recent = "उपलब्ध नहीं"; }

  const sys = `तुम एक multi-brand दोपहिया/तिपहिया dealer group के marketing planner हो।

Brands:
${brandInfo}

आज: ${todayIST}
अगले ${days} दिन के त्यौहार: ${upcoming}
${notes ? `User का निर्देश: ${notes}` : ""}

पिछले posts (इनसे अलग content बनाओ, repeat मत करो):
${recent}

अगले ${days} दिन का content plan बनाओ। सिर्फ़ valid JSON return करो:

{
  "plan": [
    {
      "date": "YYYY-MM-DD",
      "time": "HH:mm",
      "brand": "brand id",
      "type": "suvichar" | "vigyapan" | "festival",
      "topic_hindi": "एक लाइन — किस बारे में post है",
      "reason_hindi": "क्यों यह post इस दिन"
    }
  ],
  "summary_hindi": "2-3 लाइन में पूरे plan का सार"
}

नियम:
- हर दिन हर brand के लिए 1-2 posts (ज़्यादा नहीं)
- सुबह 9-10 बजे सुविचार, दोपहर 12-1 या शाम 5-6 बजे विज्ञापन
- जिस दिन त्यौहार है उस दिन type="festival"
- रोज़ एक ही जैसा topic मत रखो — variety रखो
- कोई price/EMI मत लिखो, सिर्फ़ topic बताओ
- total posts ${days * brandIds.length * 2} से ज़्यादा नहीं`;

  const out = await AI.json(sys, { temperature: 0.8, timeout: 25000, maxTokens: 2500 });
  if (out.error) return { error: out.error };
  if (Array.isArray(out.plan)) out.plan = out.plan.slice(0, 40);
  return out;
}

// Step 1: Plan बनवाओ (अभी कुछ generate मत करो)
// ══════════════════════════════════════════════════════════════
// PHASE 5 — AI QUALITY CHECKER
// Publish से पहले AI हर post check करे: spelling, गलत नंबर,
// missing branding, duplicate content, अनुचित text
// ══════════════════════════════════════════════════════════════
async function qualityCheckContent(brandId, text, type, imageBase64) {
  const b = BRANDS[brandId];

  // Duplicate check — पिछले 20 posts से मिलान
  let dupWarn = null;
  try {
    const recent = await Content.find({ brand: brandId }).sort({ createdAt: -1 }).limit(20).select("text createdAt").lean();
    const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
    const cur = norm(text);
    for (const r of recent) {
      const old = norm(r.text);
      if (!old || !cur) continue;
      // simple similarity: shorter string का कितना हिस्सा दूसरे में है
      const shorter = cur.length < old.length ? cur : old;
      const longer = cur.length < old.length ? old : cur;
      if (shorter.length > 30 && longer.includes(shorter.slice(0, Math.floor(shorter.length * 0.7)))) {
        dupWarn = `पिछला मिलता-जुलता post ${new Date(r.createdAt).toLocaleDateString("hi-IN")} को गया था`;
        break;
      }
    }
  } catch (_) {}

  const sys = `तुम "${b.name}" (${b.sub}) के social media quality checker हो।
Showroom: ${b.place}
सही फ़ोन नंबर: ${b.phone}
Products: ${b.products.join(", ")}

नीचे दिया गया post publish होने वाला है। इसे ध्यान से check करो और JSON return करो (सिर्फ़ valid JSON):

Post text:
"""
${text}
"""

{
  "verdict": "pass" | "warn" | "fail",
  "score": 0-100,
  "issues": [
    { "severity": "high" | "medium" | "low", "issue_hindi": "क्या गलत है", "fix_hindi": "कैसे ठीक करें" }
  ],
  "fixedText": "अगर छोटी-मोटी गलतियाँ हैं तो सुधरा हुआ पूरा text, वरना null",
  "summary_hindi": "एक लाइन में — post कैसा है"
}

क्या check करना है:
- Hindi spelling और grammar
- फ़ोन नंबर सही है या नहीं (सही: ${b.phone})
- showroom/brand का नाम सही लिखा है या नहीं
- कोई ऐसा price/EMI/offer तो नहीं जो शक़ी लगे
- text अधूरा तो नहीं (बीच में कटा हुआ)
- कोई अनुचित/आपत्तिजनक शब्द
- emojis सही जगह हैं या बहुत ज़्यादा हैं
- क्या post पढ़ने में साफ़ है

severity="high" सिर्फ़ तब जब गलत नंबर, गलत brand नाम, अधूरा text, या अनुचित content हो।
अगर सब ठीक है तो issues खाली array रखो और verdict="pass"।`;

  const parts = [{ text: sys }];
  if (imageBase64) {
    const clean = String(imageBase64).replace(/^data:image\/\w+;base64,/, "");
    const mime = /^data:image\/(\w+);/.exec(imageBase64)?.[1] || "jpeg";
    parts.push({ text: "\nसाथ में यह poster image भी है — इसमें text पढ़ने लायक है या नहीं, logo/contact दिख रहा है या नहीं, यह भी check करो:" });
    parts.push({ inline_data: { mime_type: `image/${mime}`, data: clean } });
  }

  const out = await AI.json(parts, { temperature: 0.2, timeout: 25000, maxTokens: 1600 });
  if (out.error) return { error: out.error };
  if (!Array.isArray(out.issues)) out.issues = [];
  if (dupWarn) {
    out.issues.unshift({ severity: "medium", issue_hindi: `Duplicate जैसा लग रहा है — ${dupWarn}`, fix_hindi: "text थोड़ा बदल दें ताकि नया लगे" });
    if (out.verdict === "pass") out.verdict = "warn";
  }
  return out;
}

// किसी भी text/image को check करो
// ══════════════════════════════════════════════════════════════
// PHASE 8 — VEHICLE KNOWLEDGE BASE
// AI कभी price/EMI खुद नहीं बनाएगा — सब यहीं से आएगा
// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
// PHASE 9 — BRAND MEMORY
// एक बार भरो — AI हर post में खुद इस्तेमाल करे
// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
// PHASE 10 — DASHBOARD SUMMARY
// एक call में आज का पूरा हाल
// ══════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════
// PHASE 11 — CONTENT QUEUE + ACTIVITY LOG
// हर content की पूरी journey, और AI ने क्या-क्या किया
// ══════════════════════════════════════════════════════════════

// एक जगह पूरा queue — scheduled → pending → sent/failed
// ══════════════════════════════════════════════════════════════
// PHASE 12 — APPROVAL MODES + COST CONTROL
// ══════════════════════════════════════════════════════════════

app.get("/api/automation/:brand", async (req, res) => {
  try {
    const brand = req.params.brand;
    if (!BRANDS[brand]) return res.status(400).json({ error: "invalid brand" });
    const s = await getAutomationSettings(brand);
    const date = istToday();
    const usage = await UsageLog.findOne({ date, brand }).lean() || { aiCalls: 0, images: 0, videos: 0 };
    res.json({ settings: s, usage: { date, aiCalls: usage.aiCalls || 0, images: usage.images || 0, videos: usage.videos || 0 } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/automation/:brand", requireRole("super-admin", "admin"), async (req, res) => {
  try {
    const brand = req.params.brand;
    if (!BRANDS[brand]) return res.status(400).json({ error: "invalid brand" });
    const body = { ...req.body }; delete body._id; delete body.brand;
    const doc = await AutomationSettings.findOneAndUpdate({ brand }, { $set: body }, { new: true, upsert: true });
    log("INFO", "[AUTOMATION] settings saved", { brand, mode: doc.mode });
    await activity(brand, "schedule", "info", `Automation mode बदला: ${doc.mode}`, { by: req.user?.email || "admin" });
    res.json({ ok: true, doc });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// पिछले 7 दिन का usage — cost trend
app.get("/api/automation/:brand/usage-history", async (req, res) => {
  try {
    const brand = req.params.brand;
    const items = await UsageLog.find({ brand }).sort({ date: -1 }).limit(14).lean();
    res.json({ items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/queue", async (req, res) => {
  try {
    const brand = req.query.brand;
    const q = brand && BRANDS[brand] ? { brand } : {};
    const limit = Math.min(parseInt(req.query.limit) || 25, 60);

    const [scheduled, pending, recent, deliveries] = await Promise.all([
      ScheduledCommand.find({ ...q, status: "scheduled" })
        .sort({ scheduleDate: 1, scheduleTime: 1 }).limit(limit)
        .select("brand type text scheduleDate scheduleTime recurring status").lean(),
      Content.find({ ...q, status: "pending" })
        .select("-imageData").sort({ createdAt: -1 }).limit(limit).allowDiskUse(true).lean(),
      Content.find({ ...q, status: { $in: ["sent", "failed"] } })
        .select("-imageData").sort({ sentAt: -1, createdAt: -1 }).limit(limit).allowDiskUse(true).lean(),
      Delivery.find({ ...q, status: "pending" })
        .select("-imageData").sort({ createdAt: -1 }).limit(10).allowDiskUse(true).lean(),
    ]);

    [pending, recent].forEach(arr => arr.forEach(d => {
      if (d.images?.square) d.imgUrl = `/api/image/content/${d._id}/square`;
    }));
    deliveries.forEach(d => { if (d.images?.square) d.imgUrl = `/api/image/delivery/${d._id}/square`; });

    const counts = {
      scheduled: scheduled.length,
      pending: pending.length,
      sent: recent.filter(r => r.status === "sent").length,
      failed: recent.filter(r => r.status === "failed").length,
      deliveries: deliveries.length,
    };

    res.json({ scheduled, pending, recent, deliveries, counts });
  } catch (e) { log("ERROR", "/queue", { msg: e.message }); res.status(500).json({ error: e.message }); }
});

// Activity log — AI ने क्या किया
app.get("/api/activity", async (req, res) => {
  try {
    const q = {};
    if (req.query.brand && BRANDS[req.query.brand]) q.brand = req.query.brand;
    if (req.query.action) q.action = req.query.action;
    if (req.query.status) q.status = req.query.status;
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const items = await ActivityLog.find(q).sort({ createdAt: -1 }).limit(limit).lean();
    res.json({ items });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/activity", requireRole("super-admin", "admin"), async (req, res) => {
  try {
    const before = new Date(Date.now() - (parseInt(req.query.olderThanDays) || 30) * 864e5);
    const r = await ActivityLog.deleteMany({ createdAt: { $lt: before } });
    res.json({ ok: true, deleted: r.deletedCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/dashboard", async (req, res) => {
  try {
    const brand = req.query.brand;
    const q = brand && BRANDS[brand] ? { brand } : {};
    const todayIST = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const dayStart = new Date(`${todayIST}T00:00:00+05:30`);

    const [pending, sentToday, failedToday, delivPending, schedCount, notifUnread, vehCount, videoJobs] = await Promise.all([
      Content.countDocuments({ ...q, status: "pending" }),
      Content.countDocuments({ ...q, status: "sent", sentAt: { $gte: dayStart } }),
      Content.countDocuments({ ...q, status: "failed", createdAt: { $gte: dayStart } }),
      Delivery.countDocuments({ ...q, status: "pending" }),
      ScheduledCommand.countDocuments({ ...q, status: "scheduled" }),
      Notification.countDocuments({ read: false }),
      Vehicle.countDocuments({ ...q, active: true }),
      Promise.resolve(Object.values(VIDEO_JOBS).filter(j => j.status === "processing").length),
    ]);

    // आने वाले scheduled — अगले 3
    const nextScheduled = await ScheduledCommand.find({ ...q, status: "scheduled" })
      .sort({ scheduleDate: 1, scheduleTime: 1 }).limit(3)
      .select("brand type scheduleDate scheduleTime text").lean();

    // आज/आने वाला त्यौहार
    const upcomingFest = FESTIVALS.filter(f => f.date >= todayIST)
      .sort((a, b) => a.date.localeCompare(b.date))[0] || null;
    const daysToFest = upcomingFest
      ? Math.round((new Date(upcomingFest.date) - new Date(todayIST)) / 864e5) : null;

    // हाल के 3 pending posts preview
    const recentPending = await Content.find({ ...q, status: "pending" })
      .sort({ createdAt: -1 }).limit(3).select("brand type text images").lean();
    recentPending.forEach(d => {
      if (d.images?.square) d.imgUrl = `/api/image/content/${d._id}/square`;
    });

    // brand profile भरा है या नहीं
    let profileReady = false;
    if (brand && BRANDS[brand]) {
      const p = await BrandProfile.findOne({ brand }).lean();
      profileReady = !!(p && (p.tone || p.tagline));
    }

    res.json({
      today: todayIST,
      pending, sentToday, failedToday, delivPending, schedCount, notifUnread,
      vehCount, videoProcessing: videoJobs,
      nextScheduled, recentPending,
      festival: upcomingFest ? { name: upcomingFest.name, date: upcomingFest.date, daysAway: daysToFest } : null,
      profileReady,
    });
  } catch (e) { log("ERROR", "/dashboard", { msg: e.message }); res.status(500).json({ error: e.message }); }
});

app.get("/api/brand-profile/:brand", async (req, res) => {
  try {
    const brand = req.params.brand;
    if (!BRANDS[brand]) return res.status(400).json({ error: "invalid brand" });
    let doc = await BrandProfile.findOne({ brand }).lean();
    if (!doc) {
      // पहली बार — BRANDS से default भर दो
      const b = BRANDS[brand];
      doc = {
        brand, displayName: b.name, address: b.place, phone: b.phone,
        primaryColor: b.accent, tone: "friendly", textLength: "medium",
        emojiLevel: "normal", language: "hindi",
        preferredBgStyles: [], likedNotes: [], dislikedNotes: [],
      };
    }
    res.json(doc);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put("/api/brand-profile/:brand", requireRole("super-admin", "admin"), async (req, res) => {
  try {
    const brand = req.params.brand;
    if (!BRANDS[brand]) return res.status(400).json({ error: "invalid brand" });
    const body = { ...req.body }; delete body._id; delete body.brand;
    const doc = await BrandProfile.findOneAndUpdate({ brand }, { $set: body }, { new: true, upsert: true });
    log("INFO", "[BRAND-MEMORY] saved", { brand });
    res.json({ ok: true, doc });
  } catch (e) { log("ERROR", "/brand-profile PUT", { msg: e.message }); res.status(500).json({ error: e.message }); }
});

// Feedback — 👍/👎 से AI सीखे
app.post("/api/brand-profile/:brand/feedback", requireRole("super-admin", "admin", "manager"), async (req, res) => {
  try {
    const brand = req.params.brand;
    if (!BRANDS[brand]) return res.status(400).json({ error: "invalid brand" });
    const { liked, note } = req.body;
    if (!note || !note.trim()) return res.status(400).json({ error: "note चाहिए" });
    const field = liked ? "likedNotes" : "dislikedNotes";
    const doc = await BrandProfile.findOneAndUpdate(
      { brand },
      { $push: { [field]: { $each: [note.trim().slice(0, 200)], $slice: -12 } } },
      { new: true, upsert: true }
    );
    log("INFO", "[BRAND-MEMORY] feedback", { brand, liked });
    res.json({ ok: true, doc });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// AI prompts के लिए memory context बनाओ
async function brandMemoryContext(brandId) {
  try {
    const p = await BrandProfile.findOne({ brand: brandId }).lean();
    if (!p) return null;
    const parts = [];
    if (p.tagline) parts.push(`Tagline: "${p.tagline}"`);
    if (p.tone) {
      const toneMap = { friendly: "दोस्ताना और गर्मजोशी भरा", professional: "पेशेवर और साफ़-सुथरा", energetic: "जोशीला और धमाकेदार", devotional: "भक्तिभाव और श्रद्धा वाला" };
      parts.push(`Tone: ${toneMap[p.tone] || p.tone}`);
    }
    if (p.textLength) {
      const lenMap = { short: "बहुत छोटा (2-3 lines)", medium: "मध्यम (4-6 lines)", long: "विस्तृत (7-10 lines)" };
      parts.push(`लंबाई: ${lenMap[p.textLength] || p.textLength}`);
    }
    if (p.emojiLevel) {
      const emMap = { few: "कम emojis (1-2)", normal: "सामान्य emojis (3-4)", many: "भरपूर emojis (6+)" };
      parts.push(`Emojis: ${emMap[p.emojiLevel] || p.emojiLevel}`);
    }
    if (p.language === "hinglish") parts.push("भाषा: Hinglish (Hindi + English mix)");
    if (p.alwaysInclude) parts.push(`हर post में यह ज़रूर हो: ${p.alwaysInclude}`);
    if (p.neverInclude) parts.push(`यह कभी मत लिखो: ${p.neverInclude}`);
    if (p.disclaimer) parts.push(`अंत में disclaimer: ${p.disclaimer}`);
    if (p.likedNotes?.length) parts.push(`मालिक को यह पसंद आता है: ${p.likedNotes.slice(-5).join("; ")}`);
    if (p.dislikedNotes?.length) parts.push(`मालिक को यह पसंद नहीं: ${p.dislikedNotes.slice(-5).join("; ")}`);
    return parts.length ? parts.join("\n") : null;
  } catch (e) { log("WARN", "brandMemoryContext failed", { msg: e.message }); return null; }
}

app.get("/api/vehicles", async (req, res) => {
  try {
    const q = { active: true };
    if (req.query.brand) q.brand = req.query.brand;
    if (req.query.inStock === "1") q.inStock = true;
    const docs = await Vehicle.find(q).sort({ brand: 1, name: 1 }).lean();
    res.json(docs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/vehicles", requireRole("super-admin", "admin"), async (req, res) => {
  try {
    const { brand, name } = req.body;
    if (!BRANDS[brand]) return res.status(400).json({ error: "सही brand चुनें" });
    if (!name || !name.trim()) return res.status(400).json({ error: "गाड़ी का नाम चाहिए" });
    const doc = await Vehicle.create({ ...req.body, name: name.trim() });
    log("INFO", "[VEHICLE] added", { brand, name });
    // ⚠️ PRD #23 — नई गाड़ी आने पर trigger
    fireTriggerAsync("new_vehicle", brand, { vehicle: name.trim(), summary: `नई गाड़ी catalog में: ${name.trim()}` });
    await audit(req, { brand, action: "offer", entity: "vehicle", entityId: doc._id,
      summary: `नई गाड़ी जोड़ी: ${name.trim()}${req.body.price ? ` (₹${req.body.price})` : ""}`, after: { price: req.body.price, offer: req.body.offer } });
    res.json({ ok: true, doc });
  } catch (e) { log("ERROR", "/vehicles POST", { msg: e.message }); res.status(500).json({ error: e.message }); }
});

app.patch("/api/vehicles/:id", requireRole("super-admin", "admin"), async (req, res) => {
  try {
    const doc = await Vehicle.findByIdAndUpdate(req.params.id, req.body, { new: true });
    if (!doc) return res.status(404).json({ error: "not found" });
    res.json({ ok: true, doc });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/vehicles/:id", requireRole("super-admin", "admin"), async (req, res) => {
  try { await Vehicle.findByIdAndDelete(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// AI के लिए vehicle context बनाओ — यही prompt में जाएगा
async function vehicleContext(brandId, vehicleName) {
  try {
    const q = { brand: brandId, active: true };
    if (vehicleName) {
      const esc = String(vehicleName).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      q.name = new RegExp(esc, "i");
    }
    const docs = await Vehicle.find(q).limit(vehicleName ? 3 : 8).lean();
    if (!docs.length) return null;
    return docs.map(v => {
      const parts = [`${v.name}${v.variant ? " " + v.variant : ""}`];
      if (v.exShowroom) parts.push(`Ex-showroom ${v.exShowroom}`);
      if (v.onRoad) parts.push(`On-road ${v.onRoad}`);
      if (v.downPayment) parts.push(`डाउन पेमेंट ${v.downPayment}`);
      if (v.emi) parts.push(`EMI ${v.emi}${v.emiTenure ? ` (${v.emiTenure})` : ""}`);
      if (v.roi) parts.push(`ROI ${v.roi}`);
      if (v.cashback) parts.push(`कैशबैक ${v.cashback}`);
      if (v.exchangeBonus) parts.push(`एक्सचेंज बोनस ${v.exchangeBonus}`);
      if (v.mileage) parts.push(v.mileage);
      if (v.offerNote) parts.push(`(${v.offerNote})`);
      if (!v.inStock) parts.push("[अभी स्टॉक में नहीं]");
      return parts.join(", ");
    }).join("\n");
  } catch (e) { log("WARN", "vehicleContext failed", { msg: e.message }); return null; }
}

// AI से पूछो — किसी गाड़ी की जानकारी है या नहीं
app.post("/api/vehicles/ask", async (req, res) => {
  try {
    const { brand, vehicleName } = req.body;
    if (!BRANDS[brand]) return res.status(400).json({ error: "brand चाहिए" });
    const ctx = await vehicleContext(brand, vehicleName);
    if (!ctx) return res.json({ found: false, message: "इस गाड़ी की जानकारी database में नहीं है — पहले Vehicles में जोड़ें" });
    res.json({ found: true, context: ctx });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/quality/check", async (req, res) => {
  try {
    const { brand, text, type, imageData } = req.body;
    if (!BRANDS[brand]) return res.status(400).json({ error: "brand चाहिए" });
    if (!text || !text.trim()) return res.status(400).json({ error: "text चाहिए" });
    const out = await qualityCheckContent(brand, text, type, imageData);
    if (out.error) return res.status(500).json(out);
    res.json(out);
  } catch (e) { log("ERROR", "/quality/check", { msg: e.message }); res.status(500).json({ error: e.message }); }
});

// pending content को id से check करो
app.post("/api/quality/check/:id", async (req, res) => {
  try {
    const doc = await Content.findById(req.params.id).lean();
    if (!doc) return res.status(404).json({ error: "not found" });
    const out = await qualityCheckContent(doc.brand, doc.text, doc.type, doc.imageData?.square);
    if (out.error) return res.status(500).json(out);
    res.json({ ...out, contentId: doc._id });
  } catch (e) { log("ERROR", "/quality/check/:id", { msg: e.message }); res.status(500).json({ error: e.message }); }
});

// AI का सुधरा हुआ text apply करो
app.post("/api/quality/apply-fix/:id", requireRole("super-admin", "admin", "manager"), async (req, res) => {
  try {
    const { fixedText } = req.body;
    if (!fixedText || !fixedText.trim()) return res.status(400).json({ error: "fixedText चाहिए" });
    const doc = await Content.findById(req.params.id);
    if (!doc) return res.status(404).json({ error: "not found" });
    doc.text = cleanAIText(fixedText.trim());
    // image दोबारा बनाओ ताकि नया text दिखे
    try {
      const imgs = await generateImages(doc.brand, doc._id, doc.text, doc.type, {});
      const b64 = imgs._b64 || {}; delete imgs._b64;
      doc.images = imgs;
      if (b64.square) doc.imageData = { square: b64.square, story: b64.story };
    } catch (e) { log("WARN", "apply-fix image regen failed", { msg: e.message }); }
    await doc.save();
    log("INFO", "[QUALITY] fix applied", { id: doc._id });
    await activity(doc.brand, "quality", "success", "AI का सुधार लागू किया, poster दोबारा बना", { contentId: doc._id });
    res.json({ ok: true, doc });
  } catch (e) { log("ERROR", "/quality/apply-fix", { msg: e.message }); res.status(500).json({ error: e.message }); }
});

app.post("/api/auto-marketing/plan", async (req, res) => {
  try {
    const { brands, days, notes } = req.body;
    const bIds = (Array.isArray(brands) && brands.length ? brands : Object.keys(BRANDS)).filter(b => BRANDS[b]);
    if (!bIds.length) return res.status(400).json({ error: "brand चाहिए" });
    const nDays = Math.min(Math.max(parseInt(days) || 1, 1), 14);
    const out = await generateMarketingPlan(bIds, nDays, notes);
    if (out.error) return res.status(500).json(out);
    res.json(out);
  } catch (e) { log("ERROR", "/auto-marketing/plan", { msg: e.message }); res.status(500).json({ error: e.message }); }
});

// Step 2: Plan approve होने पर सब schedule कर दो
app.post("/api/auto-marketing/execute", async (req, res) => {
  try {
    const { plan } = req.body;
    if (!Array.isArray(plan) || !plan.length) return res.status(400).json({ error: "plan खाली है" });

    const todayIST = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const created = [];
    const failed = [];

    for (const item of plan.slice(0, 40)) {
      try {
        if (!BRANDS[item.brand]) { failed.push({ item, reason: "invalid brand" }); continue; }
        const type = TYPES.includes(item.type) ? item.type : "vigyapan";
        // topic को context बनाकर text generate करो
        const text = await generateText(item.brand, type, undefined, item.topic_hindi || undefined);

        const isToday = item.date === todayIST;
        const doc = await ScheduledCommand.create({
          brand: item.brand, type, text,
          vehicle: "", offerDetails: item.topic_hindi || "",
          scheduleWhen: isToday ? "today" : "specific_date",
          scheduleDate: item.date, scheduleTime: item.time || "09:00",
          recurring: null, status: "scheduled",
        });
        created.push({ id: doc._id, date: item.date, time: item.time, brand: item.brand, type });
      } catch (e) {
        failed.push({ item, reason: e.message });
      }
    }

    log("INFO", "[AUTO-MKT] scheduled", { created: created.length, failed: failed.length });
    if (created.length) {
      await notify("auto_marketing", `🚀 Auto Marketing: ${created.length} posts schedule हो गए`, created[0].brand);
      await activity(created[0].brand, "auto_marketing", "success", `Auto Marketing: ${created.length} posts schedule किए`, { detail: `${failed.length} fail` });
    }
    res.json({ ok: true, created, failed });
  } catch (e) { log("ERROR", "/auto-marketing/execute", { msg: e.message }); res.status(500).json({ error: e.message }); }
});

app.post("/api/command/poster-spec", async (req, res) => {
  try {
    const { brand, command, vehicle, offer_details, type } = req.body;
    if (!BRANDS[brand]) return res.status(400).json({ error: "brand चाहिए" });
    const vCtx = await vehicleContext(brand, vehicle);
    const mergedOffers = [vCtx && `Database से असली जानकारी:\n${vCtx}`, offer_details].filter(Boolean).join("\n");
    const spec = await generatePosterSpec(brand, command || "", vehicle, mergedOffers || offer_details, type);
    if (spec.error) return res.status(500).json(spec);
    res.json(spec);
  } catch (e) { log("ERROR", "/command/poster-spec", { msg: e.message }); res.status(500).json({ error: e.message }); }
});

app.post("/api/command/execute", async (req, res) => {
  try {
    const { brand, type, vehicle, offer_details, custom_text, schedule } = req.body;
    if (!BRANDS[brand]) return res.status(400).json({ error: "brand चुनना ज़रूरी है" });
    const aiLimit = await checkAndCountUsage(brand, "aiCalls");
    if (!aiLimit.ok) return res.status(429).json({ error: aiLimit.message });
    const finalType = TYPES.includes(type) ? type : "vigyapan";

    // Text तैयार करो
    let text;
    if (custom_text && custom_text.trim()) {
      text = cleanAIText(custom_text.trim());
    } else {
      // Vehicle KB से असली price/EMI लो — AI खुद कभी नहीं बनाएगा
      const vCtx = await vehicleContext(brand, vehicle);
      const extraCtx = [
        vehicle && `Vehicle: ${vehicle}`,
        vCtx && `Database से असली जानकारी (सिर्फ़ यही use करो, अपने-आप कोई number मत बनाओ):\n${vCtx}`,
        offer_details && `User ने बताया: ${offer_details}`,
      ].filter(Boolean).join("\n");
      text = await generateText(brand, finalType, undefined, extraCtx || undefined);
    }

    // अगर "now" या "today" है तो अभी generate करके pending में डाल दो
    const when = schedule?.when || "now";
    if (when === "now" || when === "today") {
      const doc = await Content.create({ brand, type: finalType, text, status: "pending" });
      const imgs = await generateImages(brand, doc._id, text, finalType, {});
      const b64 = imgs._b64 || {}; delete imgs._b64;
      doc.images = imgs;
      if (b64.square) doc.imageData = { square: b64.square, story: b64.story };
      await doc.save();
      log("INFO", "[COMMAND] generated now", { brand, type: finalType, id: String(doc._id) });
      await activity(brand, "command", "success", `Command से ${TYPE_LABEL[finalType] || finalType} बनाया`, { contentId: doc._id, detail: String(text).slice(0, 120) });
      return res.json({ ok: true, mode: "generated", doc });
    }

    // वरना scheduled job बनाओ
    const schedDoc = await ScheduledCommand.create({
      brand, type: finalType, text, vehicle: vehicle || "", offerDetails: offer_details || "",
      scheduleWhen: when, scheduleDate: schedule?.date || null, scheduleTime: schedule?.time || "09:00",
      recurring: schedule?.recurring || null, status: "scheduled",
    });
    log("INFO", "[COMMAND] scheduled", { brand, when, id: String(schedDoc._id) });
    await activity(brand, "schedule", "success", `${schedule?.date || when} ${schedule?.time || ""} के लिए schedule किया`, { detail: String(text).slice(0, 120) });
    res.json({ ok: true, mode: "scheduled", doc: schedDoc });
  } catch (e) { log("ERROR", "/command/execute", { msg: e.message }); res.status(500).json({ error: e.message }); }
});

app.get("/api/command/scheduled", async (req, res) => {
  try {
    const q = {}; if (req.query.brand) q.brand = req.query.brand;
    const docs = await ScheduledCommand.find(q).sort({ createdAt: -1 }).limit(30).lean();
    res.json(docs);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/command/scheduled/:id", requireRole("super-admin", "admin"), async (req, res) => {
  try { await ScheduledCommand.findByIdAndDelete(req.params.id); res.json({ ok: true }); } catch (e) { res.status(500).json({ error: e.message }); }
});




// ══════════════════════════════════════════════════════════════
//  ROUTES — WHATSAPP APPROVAL (तीनों brands के लिए अलग-अलग)
// ══════════════════════════════════════════════════════════════
app.get("/api/wa-approval", async (req, res) => {
  try {
    const out = {};
    for (const id of Object.keys(BRANDS)) {
      const cfg = (await OwnerWA.findOne({ brand: id }).lean()) || {};
      const c = brandCreds(id);
      const [waiting, answered] = await Promise.all([
        WAPending.countDocuments({ brand: id, status: "waiting" }),
        WAPending.countDocuments({ brand: id, status: { $in: ["approved", "rejected"] } }),
      ]);
      out[id] = {
        name: BRANDS[id].name,
        enabled: !!cfg.enabled,
        numbers: cfg.numbers || [],
        sendPosters: cfg.sendPosters !== false,
        sendVideos: cfg.sendVideos !== false,
        sendDeliveries: cfg.sendDeliveries !== false,
        monthlyReport: cfg.monthlyReport !== false,
        sendToCustomer: cfg.sendToCustomer === true,
        leadAlert: cfg.leadAlert !== false,
        leadAutoReply: cfg.leadAutoReply === true,
        voiceCommands: cfg.voiceCommands !== false,
        quietFrom: cfg.quietFrom || "22:00",
        quietTo: cfg.quietTo || "07:00",
        sentCount: cfg.sentCount || 0,
        lastSentAt: cfg.lastSentAt || null,
        waiting, answered,
        // WhatsApp सेटिंग पूरी है या नहीं
        ready: !!(c.waPhoneId && (c.waToken || process.env.WA_TOKEN)),
      };
    }
    res.json({ brands: out, webhookUrl: `${PUBLIC_URL}/api/whatsapp/webhook` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch("/api/wa-approval", requireRole("super-admin", "admin"), async (req, res) => {
  try {
    const { brand } = req.body;
    if (!BRANDS[brand]) return res.status(400).json({ error: "brand चाहिए" });
    const patch = {};

    if (req.body.numbers !== undefined) {
      const raw = Array.isArray(req.body.numbers) ? req.body.numbers : String(req.body.numbers).split(",");
      const nums = raw.map((n) => String(n).replace(/\D/g, "")).filter(Boolean)
        .map((n) => (n.length === 10 ? "91" + n : n))      // 10 अंक हों तो 91 अपने आप
        .filter((n) => n.length >= 11 && n.length <= 15);
      if (raw.filter(Boolean).length && !nums.length) {
        return res.status(400).json({ error: "नंबर सही नहीं लगा। 10 अंक का मोबाइल लिखें, जैसे 9713394738" });
      }
      patch.numbers = nums.slice(0, 5);
    }
    for (const k of ["enabled", "sendPosters", "sendVideos", "sendDeliveries", "monthlyReport",
                     "sendToCustomer", "leadAlert", "leadAutoReply", "voiceCommands"]) {
      if (req.body[k] !== undefined) patch[k] = !!req.body[k];
    }
    for (const k of ["quietFrom", "quietTo"]) {
      if (req.body[k] && /^\d{2}:\d{2}$/.test(req.body[k])) patch[k] = req.body[k];
    }

    // चालू करने से पहले जाँच लो कि WhatsApp सेटिंग है भी या नहीं
    if (patch.enabled) {
      const c = brandCreds(brand);
      if (!c.waPhoneId || !(c.waToken || process.env.WA_TOKEN)) {
        return res.status(400).json({ error: "पहले Settings में इस brand का WhatsApp (waPhoneId + waToken) भरें" });
      }
      const cur = await OwnerWA.findOne({ brand }).lean();
      if (!(patch.numbers || cur?.numbers || []).length) {
        return res.status(400).json({ error: "कम से कम एक WhatsApp नंबर डालें" });
      }
    }

    const doc = await OwnerWA.findOneAndUpdate({ brand }, patch, { upsert: true, new: true });
    await audit(req, { brand, action: "approve", entity: "content",
      summary: `WhatsApp approval ${doc.enabled ? "चालू" : "बंद"} (${(doc.numbers || []).length} नंबर)` });
    res.json({ ok: true, doc });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// test message — सब ठीक है या नहीं, एक बार में पता चल जाए
app.post("/api/wa-approval/test", rateLimit({ windowMs: 60000, max: 4, key: "watest" }),
  requireRole("super-admin", "admin"), async (req, res) => {
  try {
    const { brand } = req.body;
    if (!BRANDS[brand]) return res.status(400).json({ error: "brand चाहिए" });
    const cfg = await OwnerWA.findOne({ brand }).lean();
    if (!cfg?.numbers?.length) return res.status(400).json({ error: "पहले नंबर डालें" });

    const b = BRANDS[brand];
    const results = [];
    for (const num of cfg.numbers) {
      try {
        await waSend(brand, num, { type: "text", text: { body:
          `✅ ${b.name} — WhatsApp जुड़ गया!\n\n` +
          `अब रोज़ का तैयार content यहीं आएगा और आप बटन दबाकर भेज/रोक सकेंगे।\n\n` +
          `कभी भी लिखें:\n• *बाकी* — बची हुई पोस्ट\n• *हिसाब* — महीने का हिसाब\n• *मदद* — सारी बातें` } });
        results.push({ num, ok: true });
      } catch (e) { results.push({ num, ok: false, error: e.message }); }
    }
    const ok = results.filter((r) => r.ok).length;
    res.json({ ok: ok > 0, results, message: ok ? `${ok} नंबर पर भेज दिया — WhatsApp देखिए` : "कोई message नहीं गया" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// बची हुई पोस्ट अभी WhatsApp पर भेजो
app.post("/api/wa-approval/push", rateLimit({ windowMs: 5 * 60000, max: 5, key: "wapush" }),
  requireRole("super-admin", "admin", "manager"), async (req, res) => {
  try {
    const { brand } = req.body;
    if (!BRANDS[brand]) return res.status(400).json({ error: "brand चाहिए" });
    const r = await pushPendingToWhatsApp(brand, parseInt(req.body.limit) || 5);
    res.json({ ok: true, ...r, message: r.sent ? `${r.sent} पोस्ट WhatsApp पर भेजीं` : (r.skipped || "कोई नई पोस्ट नहीं") });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// किसी भी पोस्ट की photo ग्राहक को अभी भेजो (हाथ से) — Content व Delivery दोनों
async function sendCustomerHandler(Model, req, res) {
  try {
    const d = await Model.findById(req.params.id);
    if (!d) return res.status(404).json({ error: "not found" });

    // नंबर/नाम अभी दिया गया हो तो सहेज लो
    if (req.body.customerMobile) d.customerMobile = String(req.body.customerMobile).replace(/\D/g, "");
    if (req.body.customerName) d.customerName = req.body.customerName;
    if (req.body.force) d.sentToCustomerAt = null;
    if (req.body.customerMobile || req.body.customerName || req.body.force) await d.save();

    // हाथ से दबाया है, इसलिए switch बंद हो तब भी भेजो
    const r = await sendDeliveryToCustomer(d.brand, d, { manual: true, force: !!req.body.force });
    if (r.sent) return res.json({ ok: true, message: `${d.customerName || r.to} को भेज दिया` });
    return res.status(r.needsManual ? 502 : 400).json({
      error: r.skipped || r.error,
      needsManual: !!r.needsManual,
      hint: r.needsManual
        ? "ग्राहक ने पिछले 24 घंटे में आपको WhatsApp नहीं किया — WhatsApp का नियम इसे रोकता है। आपके WhatsApp पर copy करने लायक message भेज दिया है।"
        : undefined,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
}
const custLimit = rateLimit({ windowMs: 60000, max: 10, key: "wacust" });
app.post("/api/delivery/:id/send-customer", custLimit, requireRole("super-admin", "admin", "manager"),
  (req, res) => sendCustomerHandler(Delivery, req, res));
app.post("/api/content/:id/send-customer", custLimit, requireRole("super-admin", "admin", "manager"),
  (req, res) => sendCustomerHandler(Content, req, res));

// महीने का हिसाब अभी भेजो
app.post("/api/wa-approval/report", rateLimit({ windowMs: 10 * 60000, max: 3, key: "warep" }),
  requireRole("super-admin", "admin"), async (req, res) => {
  try {
    const { brand } = req.body;
    if (!BRANDS[brand]) return res.status(400).json({ error: "brand चाहिए" });
    const r = await sendMonthlyReport(brand);
    res.json({ ok: !!r.sent, ...r, message: r.sent ? "रिपोर्ट भेज दी" : "नहीं भेजी (सेटिंग जाँचें)" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  ROUTES — LOGO सेटिंग
//  ⚠️ सिर्फ़ आपकी अपनी files. Code कोई logo नहीं बनाता, न कोई नाम मानकर चलता है।
// ══════════════════════════════════════════════════════════════
app.get("/api/logos", async (req, res) => {
  try {
    const files = availableLogos();
    const cfg = await logoConfig();
    const brands = {};
    for (const id of Object.keys(BRANDS)) {
      const r = await resolveLogos(id);
      brands[id] = {
        name: BRANDS[id].name,
        ownerLogo: r.owner, companyLogo: r.company,
        savedOwner: cfg[id]?.ownerLogo || null,
        savedCompany: cfg[id]?.companyLogo || null,
      };
    }
    res.json({
      files, brands,
      folder: "public/logos/",
      note: "बाएँ = आपका अपना logo, दाएँ = कंपनी का logo. सिर्फ़ ऊपर दी गई files में से चुन सकते हैं.",
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch("/api/logos", requireRole("super-admin", "admin"), async (req, res) => {
  try {
    const { brand, ownerLogo, companyLogo } = req.body;
    if (!BRANDS[brand]) return res.status(400).json({ error: "brand चाहिए" });
    const have = availableLogos();
    for (const [k, v] of [["ownerLogo", ownerLogo], ["companyLogo", companyLogo]]) {
      if (v && v !== "" && !have.includes(v)) {
        return res.status(400).json({ error: `"${v}" public/logos/ में नहीं मिली`, files: have });
      }
    }
    const patch = {};
    if (ownerLogo !== undefined) patch.ownerLogo = ownerLogo || null;
    if (companyLogo !== undefined) patch.companyLogo = companyLogo || null;
    const doc = await LogoConfig.findOneAndUpdate({ brand }, patch, { upsert: true, new: true });
    clearLogoCache();   // तुरंत असर दिखे
    await audit(req, { brand, action: "offer", entity: "content",
      summary: `Logo बदला — बाएँ: ${doc.ownerLogo || "—"}, दाएँ: ${doc.companyLogo || "—"}` });
    res.json({ ok: true, doc, resolved: await resolveLogos(brand) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// नया logo सीधे App से upload
const logoUpload = multer({
  storage: multer.diskStorage({
    destination: (r, f, cb) => cb(null, LOGO_DIR),
    filename: (r, f, cb) => cb(null, (f.originalname || "logo.png").replace(/[^\w.\-]/g, "_")),
  }),
  limits: { fileSize: 4 * 1024 * 1024 },
  fileFilter: (r, f, cb) => cb(null, /image\/(png|jpe?g|webp|svg)/.test(f.mimetype)),
});
app.post("/api/logos/upload", requireRole("super-admin", "admin"), logoUpload.single("logo"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "image file चाहिए (png/jpg/webp)" });
    clearLogoCache();
    await audit(req, { action: "offer", entity: "content", summary: `नया logo upload: ${req.file.filename}` });
    res.json({ ok: true, file: req.file.filename, files: availableLogos() });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  ROUTES — DAILY AUTO ENGINE
//  "मुझे कुछ न करना पड़े" — एक बटन, पूरे दिन का content
// ══════════════════════════════════════════════════════════════
app.post("/api/daily-engine/run", rateLimit({ windowMs: 10 * 60000, max: 3, key: "daily" }),
  requireRole("super-admin", "admin", "manager"), async (req, res) => {
  try {
    const brand = BRANDS[req.body.brand] ? req.body.brand : null;
    if (!brand) return res.status(400).json({ error: "brand चाहिए" });
    // background में — request तुरंत लौट जाती है
    setImmediate(() => runDailyEngine(brand, { force: true, posters: req.body.posters, video: req.body.video })
      .catch((e) => log("ERROR", "daily-engine", { msg: e.message })));
    res.json({ ok: true, message: "आज का content बनना शुरू — 1-2 मिनट में Review में दिखेगा" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/daily-engine/status", async (req, res) => {
  try {
    const brand = BRANDS[req.query.brand] ? req.query.brand : "vp_honda";
    const todayStart = new Date(new Date().toLocaleDateString("en-US", { timeZone: "Asia/Kolkata" }));
    const [made, videos, settings] = await Promise.all([
      Content.countDocuments({ brand, createdAt: { $gte: todayStart } }),
      Content.countDocuments({ brand, post_type: "video", createdAt: { $gte: todayStart } }),
      AutomationSettings.findOne({ brand }).lean(),
    ]);
    res.json({
      brand, madeToday: made, videosToday: videos,
      dailyPosters: settings?.dailyPosters ?? 3,
      dailyVideo: settings?.dailyVideo !== false,
      dailyEngineOn: settings?.dailyEngineOn !== false,
      vehiclePhotos: vehiclePhotosFor(brand, 99).length,
      videoReady: ENABLE_VIDEO,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch("/api/daily-engine/settings", requireRole("super-admin", "admin"), async (req, res) => {
  try {
    const brand = BRANDS[req.body.brand] ? req.body.brand : null;
    if (!brand) return res.status(400).json({ error: "brand चाहिए" });
    const patch = {};
    if (req.body.dailyPosters !== undefined) patch.dailyPosters = Math.min(Math.max(parseInt(req.body.dailyPosters) || 0, 0), 8);
    if (req.body.dailyVideo !== undefined) patch.dailyVideo = !!req.body.dailyVideo;
    if (req.body.dailyEngineOn !== undefined) patch.dailyEngineOn = !!req.body.dailyEngineOn;
    const doc = await AutomationSettings.findOneAndUpdate({ brand }, patch, { upsert: true, new: true });
    res.json({ ok: true, doc });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// अपने आप बना हुआ promotional video (हाथ से भी चला सकते हैं)
app.post("/api/auto-video", rateLimit({ windowMs: 10 * 60000, max: 3, key: "avid" }),
  requireRole("super-admin", "admin", "manager"), async (req, res) => {
  try {
    const brand = BRANDS[req.body.brand] ? req.body.brand : null;
    if (!brand) return res.status(400).json({ error: "brand चाहिए" });
    const photos = vehiclePhotosFor(brand, 99).length;
    if (photos < 2) {
      return res.status(400).json({
        error: "इस brand की कम से कम 2 गाड़ी photos चाहिए",
        hint: "विज्ञापन tab → गाड़ी library में photos upload करें, फिर यह अपने आप हर रोज़ video बनाएगा",
      });
    }
    setImmediate(() => autoPromoVideo(brand).catch(() => {}));
    res.json({ ok: true, message: "Video बन रहा है — 1-2 मिनट में Review में दिखेगा" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  ROUTES — BATCH GENERATION (PRD #29)
// ══════════════════════════════════════════════════════════════
app.post("/api/batch", rateLimit({ windowMs: 10 * 60000, max: 3, key: "batch" }),
  requireRole("super-admin", "admin", "manager"), async (req, res) => {
  try {
    const { brand, count, brief } = req.body;
    if (!BRANDS[brand]) return res.status(400).json({ error: "brand चाहिए" });
    const n = Math.min(Math.max(parseInt(count) || 5, 1), BATCH_MAX);

    // पहले से कोई batch चल रहा हो तो दूसरा शुरू मत करो
    const running = await BatchJob.findOne({ brand, status: { $in: ["queued", "running"] } });
    if (running) return res.status(409).json({ error: "एक batch पहले से चल रहा है", jobId: running._id });

    const job = await BatchJob.create({ brand, kind: "creatives", requested: n, brief: brief || "", status: "queued" });
    await audit(req, { brand, action: "approve", entity: "content", entityId: job._id,
      summary: `${n} creatives का batch शुरू किया` });

    // ⚠️ background में — request यहीं लौट जाती है (PRD #40)
    setImmediate(() => runBatch(job._id).catch((e) => {
      log("ERROR", "runBatch", { msg: e.message });
      BatchJob.findByIdAndUpdate(job._id, { status: "failed", error: e.message, finishedAt: new Date() }).catch(() => {});
    }));

    res.json({ ok: true, jobId: job._id, requested: n,
      message: `${n} posts बनने लगे — नीचे progress दिखेगी। सब Review में जाएँगे, अपने आप नहीं भेजे जाएँगे।` });
  } catch (e) { log("ERROR", "/batch", { msg: e.message }); res.status(500).json({ error: e.message }); }
});

app.get("/api/batch/:id", async (req, res) => {
  try {
    const job = await BatchJob.findById(req.params.id).lean();
    if (!job) return res.status(404).json({ error: "not found" });
    res.json(job);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/batch", async (req, res) => {
  try {
    const q = {}; if (req.query.brand && BRANDS[req.query.brand]) q.brand = req.query.brand;
    res.json(await BatchJob.find(q).sort({ createdAt: -1 }).limit(10).lean());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/batch/:id/cancel", requireRole("super-admin", "admin", "manager"), async (req, res) => {
  try {
    const job = await BatchJob.findByIdAndUpdate(req.params.id, { status: "cancelled", finishedAt: new Date() }, { new: true });
    if (!job) return res.status(404).json({ error: "not found" });
    res.json({ ok: true, message: "रोक दिया — जो बन चुके वो Review में हैं" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  ROUTES — AUTOMATION TRIGGERS (PRD #23)
// ══════════════════════════════════════════════════════════════
app.get("/api/triggers/events", (req, res) =>
  res.json({ events: Object.entries(TRIGGER_EVENTS).map(([id, label]) => ({ id, label })) }));

app.get("/api/triggers", async (req, res) => {
  try {
    const q = {}; if (req.query.brand && BRANDS[req.query.brand]) q.brand = req.query.brand;
    res.json(await TriggerRule.find(q).sort({ createdAt: -1 }).lean());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/triggers", requireRole("super-admin", "admin"), async (req, res) => {
  try {
    const { brand, event, action, contentType, autoApprove, cooldownMins } = req.body;
    if (!BRANDS[brand]) return res.status(400).json({ error: "brand चाहिए" });
    if (!TRIGGER_EVENTS[event]) return res.status(400).json({ error: "यह घटना नहीं मिली" });

    const doc = await TriggerRule.findOneAndUpdate(
      { brand, event },
      { brand, event, action: action || "make_post", contentType: contentType || "vigyapan",
        autoApprove: !!autoApprove, cooldownMins: Math.max(parseInt(cooldownMins) || 30, 5), enabled: true },
      { upsert: true, new: true }
    );
    await audit(req, { brand, action: "approve", entity: "content", entityId: doc._id,
      summary: `Trigger सेट किया: ${TRIGGER_EVENTS[event]}${autoApprove ? " (अपने आप भेजेगा)" : " (सिर्फ़ Review में डालेगा)"}` });
    res.json({ ok: true, doc });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch("/api/triggers/:id", requireRole("super-admin", "admin"), async (req, res) => {
  try {
    const allow = {};
    for (const k of ["enabled", "autoApprove", "action", "contentType", "cooldownMins"]) {
      if (req.body[k] !== undefined) allow[k] = req.body[k];
    }
    const doc = await TriggerRule.findByIdAndUpdate(req.params.id, allow, { new: true });
    if (!doc) return res.status(404).json({ error: "not found" });
    res.json({ ok: true, doc });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/triggers/:id", requireRole("super-admin", "admin"), async (req, res) => {
  try { await TriggerRule.findByIdAndDelete(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// हाथ से चलाकर देखें कि trigger क्या बनाता है
app.post("/api/triggers/:id/test", requireRole("super-admin", "admin"), async (req, res) => {
  try {
    const rule = await TriggerRule.findById(req.params.id);
    if (!rule) return res.status(404).json({ error: "not found" });
    await TriggerRule.findByIdAndUpdate(rule._id, { lastFiredAt: null });  // cooldown हटाओ
    await fireTrigger(rule.event, rule.brand, { summary: "test से चलाया गया" });
    res.json({ ok: true, message: "चला दिया — Review में देखें" });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  ROUTES — INSIGHTS (PRD #33)
// ══════════════════════════════════════════════════════════════
app.post("/api/insights/refresh", rateLimit({ windowMs: 5 * 60000, max: 3, key: "insights" }),
  requireRole("super-admin", "admin", "manager"), async (req, res) => {
  try {
    const brand = BRANDS[req.body.brand] ? req.body.brand : undefined;
    const r = await refreshAllInsights(brand, parseInt(req.body.days) || 30);
    res.json({ ok: true, ...r, note: "FB/IG से असली आँकड़े लिए गए। जहाँ token नहीं है वहाँ खाली रहेगा।" });
  } catch (e) { log("ERROR", "/insights/refresh", { msg: e.message }); res.status(500).json({ error: e.message }); }
});

app.get("/api/insights/top", async (req, res) => {
  try {
    const days = Math.min(Math.max(parseInt(req.query.days) || 30, 1), 90);
    const q = { status: "sent", sentAt: { $gte: new Date(Date.now() - days * 864e5) }, insights: { $ne: null } };
    if (req.query.brand && BRANDS[req.query.brand]) q.brand = req.query.brand;

    const docs = await Content.find(q).select("brand type text insights sentAt images").lean();
    const scored = docs
      .map((d) => ({
        _id: d._id, brand: d.brand, type: d.type,
        text: String(d.text || "").slice(0, 110),
        img: d.images?.square, sentAt: d.sentAt,
        views: d.insights?.total || 0, engagement: d.insights?.engagement || 0,
        fb: d.insights?.fb, ig: d.insights?.ig,
      }))
      .sort((a, b) => (b.engagement - a.engagement) || (b.views - a.views));

    const withData = scored.filter((x) => x.views || x.engagement);
    res.json({
      days, counted: docs.length, withRealData: withData.length,
      top: scored.slice(0, 10), weak: withData.slice(-5).reverse(),
      totals: {
        views: scored.reduce((a, x) => a + x.views, 0),
        engagement: scored.reduce((a, x) => a + x.engagement, 0),
      },
      note: withData.length ? "" : "अभी असली आँकड़े नहीं आए — पहले 'refresh' दबाएँ, और Settings में FB/IG token जाँचें",
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  ROUTES — AI CREATIVE VIDEO (PRD #13B)
// ══════════════════════════════════════════════════════════════
app.post("/api/video/creative", rateLimit({ windowMs: 10 * 60000, max: 3, key: "cvideo" }),
  requireRole("super-admin", "admin", "manager"), async (req, res) => {
  try {
    const { brand, brief, seconds, aspect } = req.body;
    if (!BRANDS[brand]) return res.status(400).json({ error: "brand चाहिए" });
    if (!brief || !String(brief).trim()) return res.status(400).json({ error: "बताएं कैसा video चाहिए" });

    const lim = await checkAndCountUsage(brand, "videos");
    if (!lim.ok) return res.status(429).json({ error: lim.message });

    const out = await makeCreativeVideo(brand, brief, {
      seconds: Math.min(Math.max(parseInt(seconds) || 10, 5), 30),
      aspect: aspect || "9:16",
    });
    if (out.error) return res.status(502).json(out);

    const doc = await Content.create({
      brand, type: "vigyapan", post_type: "video",
      text: cleanAIText(out.caption_hindi || brief), video: out.video, status: "pending",
    });
    await activity(brand, "video", "success", `AI creative video बना (${out.provider})`, { contentId: doc._id });
    res.json({ ok: true, doc, provider: out.provider, overlay: out.overlay_hindi });
  } catch (e) { log("ERROR", "/video/creative", { msg: e.message }); res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  ROUTES — MCP (PRD #22)  ⚠️ सब READ-ONLY
// ══════════════════════════════════════════════════════════════
app.get("/api/mcp/tools", (req, res) =>
  res.json({ tools: MCP_TOOLS, readOnly: true, note: "बाहरी tools सिर्फ़ पढ़ सकते हैं — भेज या बदल नहीं सकते" }));

app.post("/api/mcp/call", rateLimit({ windowMs: 60000, max: 30, key: "mcp" }), async (req, res) => {
  try {
    const { name, arguments: args } = req.body;
    if (!MCP_TOOLS.find((t) => t.name === name)) return res.status(400).json({ error: "यह tool उपलब्ध नहीं" });
    const out = await mcpCall(name, args || {});
    res.json({ ok: true, tool: name, result: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// JSON-RPC शैली — असली MCP clients के लिए
app.post("/api/mcp", rateLimit({ windowMs: 60000, max: 30, key: "mcp" }), async (req, res) => {
  const { id, method, params } = req.body || {};
  const reply = (result) => res.json({ jsonrpc: "2.0", id, result });
  const fail = (code, message) => res.json({ jsonrpc: "2.0", id, error: { code, message } });
  try {
    if (method === "initialize") {
      return reply({ protocolVersion: "2024-11-05", capabilities: { tools: {} },
        serverInfo: { name: "autosuvichar", version: "v46" } });
    }
    if (method === "tools/list") return reply({ tools: MCP_TOOLS });
    if (method === "tools/call") {
      const out = await mcpCall(params?.name, params?.arguments || {});
      return reply({ content: [{ type: "text", text: JSON.stringify(out, null, 2) }] });
    }
    return fail(-32601, "method नहीं मिला: " + method);
  } catch (e) { return fail(-32603, e.message); }
});

// ══════════════════════════════════════════════════════════════
//  ROUTES — AUDIT LOG (PRD #44)
// ══════════════════════════════════════════════════════════════
app.get("/api/audit", requireRole("super-admin", "admin"), async (req, res) => {
  try {
    const q = {};
    if (req.query.brand && BRANDS[req.query.brand]) q.brand = req.query.brand;
    if (req.query.action) q.action = req.query.action;
    if (req.query.entity) q.entity = req.query.entity;
    const limit = Math.min(parseInt(req.query.limit) || 60, 200);
    res.json(await AuditLog.find(q).sort({ createdAt: -1 }).limit(limit).lean());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  ROUTES — STORAGE (PRD #39)
// ══════════════════════════════════════════════════════════════
app.get("/api/storage", requireRole("super-admin", "admin"), async (req, res) => {
  try {
    const usage = diskUsage();
    const preview = await cleanupStorage(true);   // सिर्फ़ बताओ, हटाओ मत
    res.json({
      ...usage, keepDays: KEEP_DAYS,
      wouldDelete: preview.deleted, wouldFreeMB: preview.freedMB, inUse: preview.kept,
      note: `${KEEP_DAYS} दिन से पुरानी और किसी post से न जुड़ी files हटाई जाती हैं`,
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// सिर्फ़ base64 हटाओ (जल्दी चलता है, memory तुरंत हल्की)
app.post("/api/storage/trim", requireRole("super-admin", "admin"), async (req, res) => {
  try {
    const before = memoryWatch();
    const t = await trimImageData();
    await audit(req, { action: "delete", entity: "storage",
      summary: `${t.content + t.delivery} पुराने base64 हटाए` });
    res.json({ ok: true, ...t, before, after: memoryWatch(),
      message: `${t.content + t.delivery} पुरानी images DB से हटाईं` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/storage/cleanup", requireRole("super-admin", "admin"), async (req, res) => {
  try {
    const r = await cleanupStorage(false);
    await audit(req, { action: "delete", entity: "storage",
      summary: `${r.deleted} पुरानी files हटाईं (${r.freedMB} MB खाली)` });
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  ROUTES — RETRY QUEUE देखना / हाथ से चलाना (PRD #18, #38)
// ══════════════════════════════════════════════════════════════
app.get("/api/retry-queue", async (req, res) => {
  try {
    const q = { status: "pending", nextRetryAt: { $ne: null } };
    if (req.query.brand && BRANDS[req.query.brand]) q.brand = req.query.brand;
    const [c, d] = await Promise.all([
      Content.find(q).select("brand type text attempts nextRetryAt error").sort({ nextRetryAt: 1 }).limit(20).lean(),
      Delivery.find(q).select("brand customerName attempts nextRetryAt").sort({ nextRetryAt: 1 }).limit(20).lean(),
    ]);
    res.json({ maxAttempts: MAX_ATTEMPTS, content: c, deliveries: d });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post("/api/retry-queue/run", requireRole("super-admin", "admin"), async (req, res) => {
  try { await runRetryQueue(); res.json({ ok: true, message: "retry चला दिया" }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  ROUTES — AI Providers status (PRD #36)
// ══════════════════════════════════════════════════════════════
app.get("/api/ai/providers", (req, res) => res.json(AI.status()));

// Google से पूछो कि आपकी key पर अभी कौन-से models चल रहे हैं
// (Google model के नाम बदलता रहता है — अंदाज़ा लगाने से अच्छा है पूछ लेना)
app.get("/api/ai/gemini-models", requireRole("super-admin", "admin"), async (req, res) => {
  try {
    const key = AI_KEYS().gemini;
    if (!key) return res.status(400).json({ error: "GEMINI_API_KEY नहीं डली" });
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}&pageSize=200`,
      { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return res.status(502).json({ error: `Google ने मना किया (${r.status})` });
    const d = await r.json();
    const usable = (d.models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
      .map((m) => String(m.name).replace("models/", ""))
      .filter((n) => /flash|pro/i.test(n) && !/embedding|tts|image|veo|live/i.test(n));
    res.json({
      total: usable.length,
      models: usable,
      abhiChalRahe: order("GEMINI_TEXT_MODELS", "gemini-2.5-flash,gemini-2.0-flash,gemini-1.5-flash"),
      note: "बदलना हो तो Render env में GEMINI_TEXT_MODELS डालें, comma से अलग करके",
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// हर provider को सच में चलाकर देखो — कौन काम कर रहा है, कौन नहीं
app.post("/api/ai/test", rateLimit({ windowMs: 60000, max: 5, key: "aitest" }),
  requireRole("super-admin", "admin"), async (req, res) => {
  const results = [];
  const prompt = 'सिर्फ़ यह JSON लौटाओ, और कुछ नहीं: {"ok": true, "hindi": "नमस्ते"}';

  for (const name of Object.keys(TEXT_PROVIDERS)) {
    const t0 = Date.now();
    try {
      const r = await TEXT_PROVIDERS[name]({
        parts: [{ text: prompt }], temperature: 0, json: true, timeout: 20000, maxTokens: 500,
      });
      const ms = Date.now() - t0;
      if (!r.ok) {
        results.push({ provider: name, ok: false, ms,
          status: r.error === "no-key" ? "key नहीं डाली" : "चला नहीं", detail: r.error });
        continue;
      }
      const parsed = parseLooseJSON(r.text);
      results.push({
        provider: name, ok: !!parsed, ms, via: r.via,
        status: parsed ? "✅ ठीक चल रहा है" : "जवाब आया पर JSON टूटा हुआ",
        detail: parsed ? undefined : String(r.text).slice(0, 90),
      });
    } catch (e) {
      results.push({ provider: name, ok: false, ms: Date.now() - t0, status: "गड़बड़", detail: e.message });
    }
  }

  const working = results.filter((r) => r.ok);
  res.json({
    results,
    visionNote: "⚠️ Delivery photo पढ़ने के लिए Gemini, OpenAI या Claude चाहिए — Groq के मुफ़्त models photo नहीं देख सकते",
    workingCount: working.length,
    order: order("AI_TEXT_ORDER", "gemini,openai,anthropic,groq,ollama"),
    message: working.length
      ? `${working.length} AI चालू हैं — सबसे तेज़: ${working.sort((a, b) => a.ms - b.ms)[0].provider}`
      : "⚠️ कोई AI नहीं चल रहा — Render env में कम से कम एक key डालें",
  });
});

// ══════════════════════════════════════════════════════════════
//  ROUTES — AI VOICE (PRD #14)
// ══════════════════════════════════════════════════════════════
app.get("/api/voice/styles", (req, res) => res.json({
  styles: Object.entries(VOICE_STYLES).map(([id, label]) => ({ id, label })),
  genders: [{ id: "female", label: "महिला आवाज़" }, { id: "male", label: "पुरुष आवाज़" }],
}));

// Step 1 — सिर्फ़ script बनवाओ (सस्ता, आवाज़ अभी नहीं बनती)
app.post("/api/voice/script", rateLimit({ windowMs: 60000, max: 12, key: "ai" }), async (req, res) => {
  try {
    const { brand, text, style, seconds } = req.body;
    if (!BRANDS[brand]) return res.status(400).json({ error: "brand चाहिए" });
    if (!text || !String(text).trim()) return res.status(400).json({ error: "text चाहिए" });
    const out = await makeVoiceScript(brand, text, style, parseInt(seconds) || 20);
    if (out.error) return res.status(500).json(out);
    res.json(out);
  } catch (e) { log("ERROR", "/voice/script", { msg: e.message }); res.status(500).json({ error: e.message }); }
});

// Step 2 — script से असली आवाज़ बनाओ
app.post("/api/voice/generate", requireRole("super-admin", "admin", "manager"), async (req, res) => {
  try {
    const { brand, script, gender, style, contentId } = req.body;
    if (!BRANDS[brand]) return res.status(400).json({ error: "brand चाहिए" });
    const txt = stripEmoji(String(script || "")).trim();
    if (!txt) return res.status(400).json({ error: "script खाली है" });
    if (txt.length > 1800) return res.status(400).json({ error: "script बहुत लंबी है (max 1800 अक्षर)" });

    const lim = await checkAndCountUsage(brand, "aiCalls");
    if (!lim.ok) return res.status(429).json({ error: lim.message });

    const r = await AI.tts(txt, { gender, style });
    if (!r.ok) return res.status(502).json({ error: "आवाज़ नहीं बनी — " + r.error });

    const name = `voice_${Date.now()}.mp3`;
    fs.writeFileSync(path.join(OUT_DIR, name), r.buf);
    const dur = await audioDuration(path.join(OUT_DIR, name));

    const doc = await VoiceClip.create({
      brand, script: txt, gender: gender || "female", style: style || "friendly",
      file: `/generated/${name}`, durationSec: dur, provider: r.via,
      contentId: contentId || undefined,
    });
    await activity(brand, "voice", "success", `Voice-over बना (${r.via}${dur ? `, ${dur}s` : ""})`, { contentId });
    res.json({ ok: true, doc, url: `/generated/${name}`, provider: r.via, durationSec: dur });
  } catch (e) { log("ERROR", "/voice/generate", { msg: e.message }); res.status(500).json({ error: e.message }); }
});

app.get("/api/voice", async (req, res) => {
  try {
    const q = {}; if (req.query.brand && BRANDS[req.query.brand]) q.brand = req.query.brand;
    res.json(await VoiceClip.find(q).sort({ createdAt: -1 }).limit(30).lean());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/voice/:id", requireRole("super-admin", "admin"), async (req, res) => {
  try {
    const d = await VoiceClip.findByIdAndDelete(req.params.id);
    if (d?.file) { try { fs.unlinkSync(path.join(OUT_DIR, path.basename(d.file))); } catch (_) {} }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// किसी बनी हुई video पर voice-over चढ़ाओ (+ subtitles) — PRD #12
app.post("/api/voice/attach", requireRole("super-admin", "admin", "manager"), async (req, res) => {
  try {
    const { contentId, voiceId, music } = req.body;
    const doc = await Content.findById(contentId);
    if (!doc) return res.status(404).json({ error: "content नहीं मिला" });
    if (!doc.video) return res.status(400).json({ error: "इस post में कोई video नहीं है" });
    const vc = await VoiceClip.findById(voiceId);
    if (!vc) return res.status(404).json({ error: "voice नहीं मिली" });

    const vidPath = path.join(OUT_DIR, path.basename(doc.video));
    const audPath = path.join(OUT_DIR, path.basename(vc.file));
    if (!fs.existsSync(vidPath)) return res.status(400).json({ error: "video file नहीं मिली (server restart हुआ हो सकता है)" });
    if (!fs.existsSync(audPath)) return res.status(400).json({ error: "voice file नहीं मिली" });

    const outName = `${doc._id}_voiced.mp4`;
    const musicPath = music ? path.join(MUSIC_DIR, path.basename(music)) : null;
    await muxAudio(vidPath, audPath, path.join(OUT_DIR, outName), musicPath);

    doc.video = `/generated/${outName}`;
    doc.post_type = "video";
    await doc.save();
    await activity(doc.brand, "video", "success", "Video पर voice-over लगाया", { contentId: doc._id });
    res.json({ ok: true, video: doc.video });
  } catch (e) { log("ERROR", "/voice/attach", { msg: e.message }); res.status(500).json({ error: e.message }); }
});

// subtitles (.srt) download
app.post("/api/voice/subtitles", async (req, res) => {
  try {
    const { subtitles } = req.body;
    if (!Array.isArray(subtitles) || !subtitles.length) return res.status(400).json({ error: "subtitles चाहिए" });
    const name = `sub_${Date.now()}.srt`;
    fs.writeFileSync(path.join(OUT_DIR, name), buildSRT(subtitles), "utf-8");
    res.json({ ok: true, url: `/generated/${name}` });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Speech-to-Text — mobile से बोलकर command देने के लिए (PRD #3)
const audioUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 12 * 1024 * 1024 } });
app.post("/api/voice/transcribe", rateLimit({ windowMs: 60000, max: 20, key: "stt" }), audioUpload.single("audio"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "audio file चाहिए" });
    const r = await AI.stt(req.file.buffer, req.file.mimetype);
    if (!r.ok) return res.status(502).json({ error: "समझ नहीं आया — " + r.error });
    res.json({ ok: true, text: r.text, provider: r.via });
  } catch (e) { log("ERROR", "/voice/transcribe", { msg: e.message }); res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  ROUTES — PLATFORM ADAPTER (PRD #15, #16)
// ══════════════════════════════════════════════════════════════
app.get("/api/platforms", (req, res) => res.json({
  platforms: Object.entries(PLATFORM_RULES).map(([id, rule]) => ({
    id,
    label: { whatsapp: "WhatsApp", instagram: "Instagram", facebook: "Facebook", youtube: "YouTube Shorts", status: "Status" }[id] || id,
    rule_hindi: rule,
  })),
}));

app.post("/api/adapt", rateLimit({ windowMs: 60000, max: 12, key: "ai" }), async (req, res) => {
  try {
    const { brand, text, platforms, extra } = req.body;
    if (!BRANDS[brand]) return res.status(400).json({ error: "brand चाहिए" });
    if (!text || !String(text).trim()) return res.status(400).json({ error: "text चाहिए" });
    const lim = await checkAndCountUsage(brand, "aiCalls");
    if (!lim.ok) return res.status(429).json({ error: lim.message });
    const out = await adaptToPlatforms(brand, text, platforms, extra);
    if (out.error) return res.status(500).json(out);
    await activity(brand, "caption", "success", "एक content के platform-wise versions बनाए");
    res.json(out);
  } catch (e) { log("ERROR", "/adapt", { msg: e.message }); res.status(500).json({ error: e.message }); }
});

// किसी pending post को सीधे adapt करो
app.post("/api/content/:id/adapt", async (req, res) => {
  try {
    const doc = await Content.findById(req.params.id).select("-imageData").lean();
    if (!doc) return res.status(404).json({ error: "not found" });
    const out = await adaptToPlatforms(doc.brand, doc.text, req.body.platforms, req.body.extra);
    if (out.error) return res.status(500).json(out);
    res.json({ ...out, contentId: doc._id });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// चुना हुआ version post पर लागू करो
app.post("/api/content/:id/apply-caption", requireRole("super-admin", "admin", "manager"), async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || !String(text).trim()) return res.status(400).json({ error: "text चाहिए" });
    const doc = await Content.findByIdAndUpdate(req.params.id, { text: cleanAIText(String(text).trim()) }, { new: true }).select("-imageData");
    if (!doc) return res.status(404).json({ error: "not found" });
    res.json({ ok: true, doc });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  ROUTES — CONTENT VARIATIONS (PRD #28)
// ══════════════════════════════════════════════════════════════
app.post("/api/variants/caption", rateLimit({ windowMs: 60000, max: 12, key: "ai" }), async (req, res) => {
  try {
    const { brand, topic, count, extra } = req.body;
    if (!BRANDS[brand]) return res.status(400).json({ error: "brand चाहिए" });
    if (!topic || !String(topic).trim()) return res.status(400).json({ error: "विषय बताएं" });
    const lim = await checkAndCountUsage(brand, "aiCalls");
    if (!lim.ok) return res.status(429).json({ error: lim.message });

    const out = await makeCaptionVariants(brand, topic, count, extra);
    if (out.error) return res.status(500).json(out);
    const set = await VariantSet.create({
      brand, topic, kind: "caption", variants: out.variants || [],
      recommendedIndex: out.recommendedIndex || 0, recommendReason: out.recommendReason_hindi || "",
    });
    await activity(brand, "generate", "success", `${(out.variants || []).length} caption versions बनाए`);
    res.json({ ...out, setId: set._id });
  } catch (e) { log("ERROR", "/variants/caption", { msg: e.message }); res.status(500).json({ error: e.message }); }
});

app.post("/api/variants/poster", rateLimit({ windowMs: 60000, max: 12, key: "ai" }), async (req, res) => {
  try {
    const { brand, command, vehicle, offer_details, count } = req.body;
    if (!BRANDS[brand]) return res.status(400).json({ error: "brand चाहिए" });
    const lim = await checkAndCountUsage(brand, "aiCalls");
    if (!lim.ok) return res.status(429).json({ error: lim.message });

    const out = await makePosterSpecVariants(brand, command || "", vehicle, offer_details, count);
    const set = await VariantSet.create({
      brand, topic: command || vehicle || "poster", kind: "poster", variants: out.variants || [],
      recommendedIndex: out.recommendedIndex || 0, recommendReason: out.recommendReason_hindi || "",
    });
    res.json({ ...out, setId: set._id });
  } catch (e) { log("ERROR", "/variants/poster", { msg: e.message }); res.status(500).json({ error: e.message }); }
});

// एक ही script की 2 अलग आवाज़ें
app.post("/api/variants/voice", requireRole("super-admin", "admin", "manager"), async (req, res) => {
  try {
    const { brand, script, options } = req.body;
    if (!BRANDS[brand]) return res.status(400).json({ error: "brand चाहिए" });
    const txt = stripEmoji(String(script || "")).trim();
    if (!txt) return res.status(400).json({ error: "script चाहिए" });

    const opts = (Array.isArray(options) && options.length ? options : [
      { gender: "female", style: "friendly" }, { gender: "male", style: "energetic" },
    ]).slice(0, 3);

    const made = [];
    for (const o of opts) {
      const lim = await checkAndCountUsage(brand, "aiCalls");
      if (!lim.ok) break;
      const r = await AI.tts(txt, o);
      if (!r.ok) { made.push({ ...o, error: r.error }); continue; }
      const name = `voice_${Date.now()}_${o.gender}.mp3`;
      fs.writeFileSync(path.join(OUT_DIR, name), r.buf);
      const dur = await audioDuration(path.join(OUT_DIR, name));
      const doc = await VoiceClip.create({ brand, script: txt, gender: o.gender, style: o.style, file: `/generated/${name}`, durationSec: dur, provider: r.via });
      made.push({ ...o, id: doc._id, url: `/generated/${name}`, durationSec: dur, provider: r.via });
    }
    res.json({ ok: true, variants: made });
  } catch (e) { log("ERROR", "/variants/voice", { msg: e.message }); res.status(500).json({ error: e.message }); }
});

// user ने कौन सा चुना — AI इसी से सीखता है (PRD #27)
app.post("/api/variants/:id/choose", async (req, res) => {
  try {
    const idx = parseInt(req.body.index);
    const set = await VariantSet.findByIdAndUpdate(req.params.id, { chosenIndex: idx }, { new: true });
    if (!set) return res.status(404).json({ error: "not found" });
    // AI की सिफ़ारिश से अलग चुना तो Brand Memory में note हो जाए
    if (idx !== set.recommendedIndex && set.variants?.[idx]?.style_hindi) {
      await BrandProfile.findOneAndUpdate({ brand: set.brand },
        { $push: { likedNotes: { $each: [`"${set.variants[idx].style_hindi}" अंदाज़ ज़्यादा पसंद आया`], $slice: -12 } } },
        { upsert: true });
    }
    res.json({ ok: true, set });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get("/api/variants", async (req, res) => {
  try {
    const q = {}; if (req.query.brand && BRANDS[req.query.brand]) q.brand = req.query.brand;
    if (req.query.kind) q.kind = req.query.kind;
    res.json(await VariantSet.find(q).sort({ createdAt: -1 }).limit(20).lean());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
//  ROUTES — NEWS (PRD #25)
//  ⚠️ हर खबर के साथ source URL अनिवार्य — AI खुद खबर नहीं बनाता
// ══════════════════════════════════════════════════════════════
app.get("/api/news/sources", (req, res) =>
  res.json({ sources: TRUSTED_NEWS.map((x) => ({ name: x.name })), note: "इनके अलावा किसी source से खबर नहीं ली जाती" }));

app.post("/api/news/fetch", rateLimit({ windowMs: 5 * 60000, max: 4, key: "news" }), requireRole("super-admin", "admin", "manager"), async (req, res) => {
  try {
    const brand = BRANDS[req.body.brand] ? req.body.brand : "vp_honda";
    const raw = await fetchTrustedNews(4);
    if (!raw.length) return res.status(502).json({ error: "अभी कोई खबर नहीं मिली — बाद में कोशिश करें" });

    // पहले से मौजूद खबरें दोबारा मत डालो
    const urls = raw.map((x) => x.sourceUrl);
    const existing = await NewsItem.find({ sourceUrl: { $in: urls } }).select("sourceUrl").lean();
    const seen = new Set(existing.map((x) => x.sourceUrl));
    const fresh = raw.filter((x) => !seen.has(x.sourceUrl)).slice(0, 12);
    if (!fresh.length) return res.json({ ok: true, added: 0, message: "कोई नई खबर नहीं — सब पहले से हैं" });

    const sum = await summariseNews(brand, fresh);
    const byIdx = {};
    (sum.items || []).forEach((x) => { byIdx[x.index] = x; });

    const docs = [];
    for (let i = 0; i < fresh.length; i++) {
      const f = fresh[i], a = byIdx[i] || {};
      if (a.relevant === false) continue;        // हमारे काम की नहीं
      docs.push(await NewsItem.create({
        brand,
        headline: a.headline_hindi || f.headline,
        summary: a.summary_hindi || f.rawSummary.slice(0, 300),
        sourceName: f.sourceName,
        sourceUrl: f.sourceUrl,                  // ⚠️ अनिवार्य
        publishedAt: f.publishedAt,
        verified: a.verified === true,
        verifyNote: a.verifyNote_hindi || (a.verified === true ? "" : "AI ने पूरी पुष्टि नहीं की — source खोलकर देखें"),
      }));
    }
    await activity(brand, "news", "success", `${docs.length} खबरें आईं (${TRUSTED_NEWS.length} भरोसेमंद sources से)`);
    res.json({ ok: true, added: docs.length, items: docs });
  } catch (e) { log("ERROR", "/news/fetch", { msg: e.message }); res.status(500).json({ error: e.message }); }
});

app.get("/api/news", async (req, res) => {
  try {
    const q = {}; if (req.query.brand && BRANDS[req.query.brand]) q.brand = req.query.brand;
    if (req.query.verified === "1") q.verified = true;
    res.json(await NewsItem.find(q).sort({ createdAt: -1 }).limit(40).lean());
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete("/api/news/:id", requireRole("super-admin", "admin", "manager"), async (req, res) => {
  try { await NewsItem.findByIdAndDelete(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// खबर से post बनाओ — source link caption में अपने आप जुड़ता है
app.post("/api/news/:id/to-post", requireRole("super-admin", "admin", "manager"), async (req, res) => {
  try {
    const nItem = await NewsItem.findById(req.params.id);
    if (!nItem) return res.status(404).json({ error: "खबर नहीं मिली" });
    if (!nItem.verified) return res.status(400).json({ error: "यह खबर verified नहीं है — पहले source खोलकर जाँच लें, फिर 'verified' करें" });

    const brand = BRANDS[req.body.brand] ? req.body.brand : nItem.brand;
    const b = BRANDS[brand];
    const ctx = `खबर: ${nItem.headline}\nसार: ${nItem.summary}\nस्रोत: ${nItem.sourceName}\n` +
      `⚠️ सिर्फ़ इसी जानकारी से post लिखो, कुछ नया मत जोड़ो। कोई price/offer मत बनाओ।`;
    const text = await generateText(brand, "suchna", undefined, ctx);
    const finalText = `${text}\n\n📰 स्रोत: ${nItem.sourceName}\n${nItem.sourceUrl}`;

    const doc = await Content.create({ brand, type: "suchna", text: finalText, status: "pending" });
    const imgs = await generateImages(brand, doc._id, text, "suchna", {});
    const b64 = imgs._b64 || {}; delete imgs._b64;
    doc.images = imgs;
    if (b64.square) doc.imageData = { square: b64.square, story: b64.story };
    await doc.save();

    nItem.usedForContent = true; await nItem.save();
    await activity(brand, "generate", "success", "खबर से post बनाया (source link के साथ)", { contentId: doc._id });
    res.json({ ok: true, doc });
  } catch (e) { log("ERROR", "/news/to-post", { msg: e.message }); res.status(500).json({ error: e.message }); }
});

// इंसान की पुष्टि — तभी post बन सकती है
app.patch("/api/news/:id/verify", requireRole("super-admin", "admin", "manager"), async (req, res) => {
  try {
    const doc = await NewsItem.findByIdAndUpdate(req.params.id,
      { verified: req.body.verified !== false, verifyNote: req.body.note || "इंसान ने source खोलकर जाँच की" },
      { new: true });
    if (!doc) return res.status(404).json({ error: "not found" });
    res.json({ ok: true, doc });
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
  try { const q = {}; if (req.query.brand) q.brand = req.query.brand;
    if (req.query.status) { const s = req.query.status.split(",").map(x=>x.trim()).filter(Boolean); q.status = s.length===1 ? s[0] : {$in:s}; }
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
    if (typeof req.body.text === "string") {
      const imgs = await generateImages(doc.brand, doc._id, doc.text, doc.type, {});
      const b64 = imgs._b64 || {}; delete imgs._b64;   // ⚠️ पहले _b64 भी images में save हो जाता था
      doc.images = imgs;
      if (b64.square) doc.imageData = { square: b64.square, story: b64.story };
    }
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
    // ⚠️ अब safePublish से जाता है — दोबारा भेजना अपने आप होगा और duplicate नहीं जाएगा
    const out = await safePublish(Content, doc._id, req);
    const updated = await Content.findById(doc._id).select("-imageData");
    if (out.already) return res.json({ ...updated.toObject(), alreadySent: true, message: "यह पहले ही भेजा जा चुका है" });
    if (!out.ok && out.retrying) {
      return res.status(202).json({ ...updated.toObject(), retrying: true,
        message: `अभी नहीं गया — ${out.attempt}/${MAX_ATTEMPTS} कोशिश। कुछ मिनट में अपने आप दोबारा जाएगा।` });
    }
    await activity(doc.brand, "publish", out.ok ? "success" : "failed",
      out.ok ? `भेजा गया: ${(out.channels || []).join(", ")}` : `भेजने में fail: ${String(out.error).slice(0, 150)}`,
      { contentId: doc._id, by: req.user?.email || "AI" });
    // ⚠️ नया: अगर इस पोस्ट पर ग्राहक का नंबर है तो उसे भी उसकी photo भेज दो
    if (updated?.customerMobile) {
      setImmediate(() => sendDeliveryToCustomer(doc.brand, updated)
        .catch((e) => log("WARN", "sendToCustomer(content)", { msg: e.message })));
    }
    res.json(updated);
  } catch (e) { log("ERROR", "/approve", { msg: e.message }); res.status(500).json({ error: e.message }); }
});
// सहेजा हुआ poster दोबारा भेजें (वही image फिर से publish)
app.post("/api/content/:id/resend", requireRole("super-admin", "admin", "manager"), async (req, res) => {
  try {
    const doc = await Content.findById(req.params.id); if (!doc) return res.status(404).json({ error: "not found" });
    // "दोबारा भेजें" जानबूझकर दबाया गया है — इसलिए idempotency key हटाकर फिर से भेजो
    await Content.findByIdAndUpdate(doc._id, { publishedKey: "", publishLock: "", attempts: 0, nextRetryAt: null });
    await audit(req, { brand: doc.brand, action: "send", entity: "content", entityId: doc._id,
      summary: "user ने जानबूझकर दोबारा भेजा" });
    const out = await safePublish(Content, doc._id, req);
    const updated = await Content.findById(doc._id).select("-imageData");
    await activity(doc.brand, "publish", out.ok ? "success" : "failed",
      out.ok ? `दोबारा भेजा गया: ${(out.channels || []).join(", ")}` : `दोबारा भेजना fail: ${String(out.error).slice(0, 150)}`,
      { contentId: doc._id, by: req.user?.email || "AI" });
    res.json({ ...updated.toObject(), results: out.results });
  } catch (e) { log("ERROR", "/resend", { msg: e.message }); res.status(500).json({ error: e.message }); }
});
app.post("/api/content/:id/reject", async (req, res) => {
  try {
    const doc = await Content.findByIdAndUpdate(req.params.id, { status: "rejected", nextRetryAt: null }, { new: true }).select("-imageData");
    if (!doc) return res.status(404).json({ error: "not found" });
    await audit(req, { brand: doc.brand, action: "reject", entity: "content", entityId: doc._id,
      summary: `post reject किया${req.body?.reason ? ` — ${req.body.reason}` : ""}` });
    res.json(doc);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Music ----
app.get("/api/music", (req, res) => res.json(fs.readdirSync(MUSIC_DIR).filter((f) => /\.(mp3|m4a|wav)$/i.test(f))));
const musicUpload = multer({ storage: multer.diskStorage({ destination: MUSIC_DIR, filename: (req, f, cb) => cb(null, f.originalname) }), limits: { fileSize: 15 * 1024 * 1024 } });
app.post("/api/music/upload", musicUpload.single("file"), (req, res) => req.file ? res.json({ ok: true, file: req.file.originalname }) : res.status(400).json({ error: "no file" }));

// ---- Delivery ----
const photoUpload = multer({ storage: multer.diskStorage({ destination: UPLOAD_DIR, filename: (req, f, cb) => cb(null, Date.now() + "_" + f.originalname.replace(/\s+/g, "_")) }), limits: { fileSize: 12 * 1024 * 1024 } });
// ══════════════════════════════════════════════════════════════
// PHASE 3 — DELIVERY AI
// Photo upload करते ही AI खुद analyze करे: कितने लोग, कौन सी गाड़ी,
// quality कैसी है — और पूरा delivery caption + design suggest करे
// ══════════════════════════════════════════════════════════════
async function analyzeDeliveryPhoto(brandId, imageBase64, customerName, bikeName) {
  const b = BRANDS[brandId];

  // data URI से सिर्फ़ base64 part निकालो
  const clean = String(imageBase64 || "").replace(/^data:image\/\w+;base64,/, "");
  const mime = /^data:image\/(\w+);/.exec(imageBase64 || "")?.[1] || "jpeg";

  const sys = `तुम "${b.name}" (${b.sub}, ${b.place}) के delivery post designer हो।
यह एक vehicle delivery की photo है — customer अपनी नई गाड़ी लेकर showroom पर खड़ा है।
${customerName ? `Customer का नाम: ${customerName}` : ""}
${bikeName ? `गाड़ी: ${bikeName}` : ""}

Photo देखकर एक JSON return करो (सिर्फ़ valid JSON, कोई extra text नहीं):

{
  "photoQuality": "good" | "ok" | "poor",
  "qualityNote_hindi": "एक लाइन — photo कैसी है, कोई सुझाव हो तो (जैसे 'गाड़ी थोड़ी कटी है' या 'photo अच्छी है')",
  "detectedVehicle": "अगर photo में गाड़ी का model पहचान आए तो नाम, वरना null",
  "peopleCount": संख्या (कितने लोग दिख रहे हैं),
  "suggestedFrame": "surana" | "congrats" | "welcome_family" | "powerhonda" | "raghuveer" | "gold_ceremony" | "minimal",
  "suggestedBg": "showroom" | "redshow" | "whiteclean" | "golden" | "blue" | "diwali" | "navratri",
  "headline": "बड़ा टेक्स्ट जैसे 'बधाई हो!' या 'CONGRATULATIONS'",
  "subLine": "छोटी लाइन जैसे 'नई गाड़ी की शुभकामनाएं'",
  "caption": "WhatsApp/Instagram caption — 3-5 lines Hindi, emojis के साथ, customer को बधाई + showroom mention + 3-4 hashtags",
  "reasoning_hindi": "एक लाइन — तुमने ये design क्यों चुना"
}

नियम:
- कोई price/offer मत लिखो delivery post में
- caption में customer का नाम हो अगर दिया गया है
- headline छोटा और खुशी वाला
- suggestedFrame photo में लोगों की संख्या के हिसाब से चुनो (ज़्यादा लोग = welcome_family, एक-दो = surana/congrats)`;

  return await AI.json(
    [{ text: sys }, { inline_data: { mime_type: `image/${mime}`, data: clean } }],
    { temperature: 0.6, timeout: 25000, maxTokens: 1200 });
}

// Photo analyze करके design + caption suggest करो
app.post("/api/delivery/ai-analyze", async (req, res) => {
  try {
    const { brand, imageData, customerName, bikeName } = req.body;
    if (!BRANDS[brand]) return res.status(400).json({ error: "brand चाहिए" });
    if (!imageData) return res.status(400).json({ error: "photo चाहिए" });
    const out = await analyzeDeliveryPhoto(brand, imageData, customerName, bikeName);
    if (out.error) return res.status(500).json(out);
    res.json(out);
  } catch (e) { log("ERROR", "/delivery/ai-analyze", { msg: e.message }); res.status(500).json({ error: e.message }); }
});

// कई photos में से best चुनो
app.post("/api/delivery/ai-pick-best", async (req, res) => {
  try {
    const { brand, images } = req.body;  // images: [{ id, dataUrl }]
    if (!BRANDS[brand]) return res.status(400).json({ error: "brand चाहिए" });
    if (!Array.isArray(images) || !images.length) return res.status(400).json({ error: "photos चाहिए" });

    const results = [];
    for (const img of images.slice(0, 6)) {
      const a = await analyzeDeliveryPhoto(brand, img.dataUrl, "", "");
      results.push({
        id: img.id,
        quality: a.photoQuality || "ok",
        note: a.qualityNote_hindi || "",
        peopleCount: a.peopleCount ?? 0,
        error: a.error || null,
      });
    }
    const rank = { good: 3, ok: 2, poor: 1 };
    const best = [...results].filter(r => !r.error).sort((a, b2) => (rank[b2.quality] || 0) - (rank[a.quality] || 0))[0];
    res.json({ results, bestId: best?.id || null });
  } catch (e) { log("ERROR", "/delivery/ai-pick-best", { msg: e.message }); res.status(500).json({ error: e.message }); }
});

app.post("/api/delivery", photoUpload.single("photo"), async (req, res) => {
  try {
    const { brand, customerName, bikeName, offer, music, bg, customerMobile } = req.body;
    if (!BRANDS[brand]) return res.status(400).json({ error: "invalid brand" });
    const doc = await Delivery.create({
      brand, customerName, bikeName, offer, photo: req.file?.filename, status: "pending",
      customerMobile: customerMobile ? String(customerMobile).replace(/\D/g, "") : undefined,
    });
    // ⚠️ PRD #23 — नई delivery पर trigger (background में, request नहीं रुकती)
    fireTriggerAsync("new_delivery", brand, { customerName, bikeName, summary: `${customerName || "ग्राहक"} को ${bikeName || "गाड़ी"} की डिलीवरी` });
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
        // ⚠️ नया: delivery video पर भी header (बाएँ आपका logo, दाएँ कंपनी का)
        try { await stampVideoHeader(path.join(OUT_DIR, path.basename(doc.video)), brand, 1080, 1920); } catch (_) {}
        await doc.save();
        notify("delivery", `${BRANDS[brand].name}: ${customerName || "ग्राहक"} की delivery video तैयार — review करें`, brand);
        // ⚠️ नया: poster + video + caption तैयार होते ही सीधे WhatsApp पर
        try {
          const fresh = await Delivery.findById(doc._id);
          const r = await sendForApproval(brand, fresh, "delivery");
          if (r.sent) log("INFO", "[WA] delivery approval भेजा", { id: String(doc._id), code: r.code });
        } catch (e) { log("WARN", "[WA] delivery approval fail", { msg: e.message }); }
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
    o.layout = layout; // generatePromoImages अब इसे पढ़कर सही SVG builder चुनता है
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
    const doc = await Content.create({
      brand, type: "vigyapan", post_type: "photo", text, status: "pending",
      // ⚠️ DeliveryEditor से ग्राहक की जानकारी — इसी से बाद में उसे भेजा जाता है
      customerName: req.body.customerName || undefined,
      customerMobile: req.body.customerMobile ? String(req.body.customerMobile).replace(/\D/g, "") : undefined,
    });
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
// ══════════════════════════════════════════════════════════════
// ⚠️ MISSING ROUTE FIX — यह route backend में था ही नहीं!
//    Frontend के 7 editors (MegaOffer, Booking, Multibike, Hiring,
//    LuckyDraw, AIDelivery, AIPosterCanvas) सब "/api/mega-offer/submit"
//    पर POST करते हैं — इसलिए "Review में भेजें" हर जगह 404 दे रहा था।
//    अब canvas का base64 यहाँ आकर सीधे Review Queue (Content) में जाता है।
// ══════════════════════════════════════════════════════════════
async function saveEditorImage(req, res) {
  try {
    const { brand, text, imageData, type, customerName, customerMobile } = req.body;
    if (!BRANDS[brand]) return res.status(400).json({ error: "सही brand चुनें" });
    if (!imageData || !String(imageData).startsWith("data:image")) {
      return res.status(400).json({ error: "image (base64) नहीं मिली" });
    }
    const b = BRANDS[brand];
    const finalType = normType(type);
    const caption = (text && String(text).trim())
      ? cleanAIText(String(text).trim())
      : `${b.name}\n📞 ${b.phone} • 📍 ${b.place}`;

    const doc = await Content.create({
      brand, type: finalType, post_type: "photo", text: caption, status: "pending",
      customerName: customerName || undefined,
      customerMobile: customerMobile ? String(customerMobile).replace(/\D/g, "") : undefined,
    });

    // base64 → disk file (FB/IG को public URL चाहिए)
    const raw = String(imageData).split(",")[1] || "";
    const ext = /^data:image\/png/.test(imageData) ? "png" : "jpg";
    const fname = `${doc._id}_square.${ext}`;
    let stored = imageData;
    try {
      const buf = Buffer.from(raw, "base64");
      const { buf: cBuf, mime } = await compressImage(buf);
      fs.writeFileSync(path.join(OUT_DIR, `${doc._id}_square.${ext}`), cBuf);
      stored = `data:${mime};base64,` + cBuf.toString("base64");
    } catch (e) {
      log("WARN", "editor image compress failed → original", { msg: e.message });
      try { fs.writeFileSync(path.join(OUT_DIR, fname), Buffer.from(raw, "base64")); } catch (_) {}
    }
    doc.images = { square: `/generated/${fname}` };
    doc.imageData = { square: stored };   // restart-safe
    await doc.save();

    await activity(brand, "poster", "success", "Editor से बना poster Review Queue में आया", { contentId: doc._id });
    log("INFO", "[EDITOR] submitted to review", { brand, id: String(doc._id) });
    res.json({ ok: true, doc });
  } catch (e) {
    log("ERROR", "/mega-offer/submit", { msg: e.message });
    res.status(500).json({ error: e.message });
  }
}
app.post("/api/mega-offer/submit", saveEditorImage);
app.post("/api/editor/submit", saveEditorImage);   // भविष्य के लिए साफ़ नाम (दोनों चलते हैं)

// गाड़ी library: एक बार upload, फिर dropdown से select
const vehUpload = multer({ storage: multer.diskStorage({
  destination: (req, f, cb) => { const d = path.join(VEHICLE_DIR, req.body.brand || "vp_honda"); fs.mkdirSync(d, { recursive: true }); cb(null, d); },
  filename: (req, f, cb) => cb(null, f.originalname.replace(/\s+/g, "_")),
}), limits: { fileSize: 12 * 1024 * 1024 } });
// ⚠️ पहले यह भी "/api/vehicles" था — ऊपर वाले Vehicle-KB route ने इसे ढँक दिया था
//    इसलिए PromoEditor की "गाड़ी library" dropdown खाली/टूटी हुई आती थी। अब अलग path.
app.get("/api/vehicle-photos", (req, res) => {
  const brand = BRANDS[req.query.brand] ? req.query.brand : "vp_honda";
  const d = path.join(VEHICLE_DIR, brand);
  try { res.json(fs.readdirSync(d).filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f))); }
  catch (_) { res.json([]); }
});
app.post("/api/vehicle-photos/upload", vehUpload.single("photo"), (req, res) => {
  if (!req.file) return res.status(400).json({ error: "no file" });
  res.json({ ok: true, file: req.file.originalname.replace(/\s+/g, "_") });
});
app.get("/api/deliveries", async (req, res) => {
  try { const q = {}; if (req.query.brand) q.brand = req.query.brand;
    if (req.query.status) { const s = req.query.status.split(",").map(x=>x.trim()).filter(Boolean); q.status = s.length===1 ? s[0] : {$in:s}; }
    res.json(await Delivery.find(q).select("-imageData").sort({ createdAt: -1 }).limit(20).allowDiskUse(true).lean()); } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/delivery/:id/approve", requireRole("super-admin", "admin", "manager"), async (req, res) => {
  try {
    const doc = await Delivery.findById(req.params.id); if (!doc) return res.status(404).json({ error: "not found" });
    if (doc.status !== "pending") return res.status(400).json({ error: `already ${doc.status}` });
    // ⚠️ safePublish से — retry अपने आप, और duplicate delivery post नहीं जाएगी
    const out = await safePublish(Delivery, doc._id, req);
    const updated = await Delivery.findById(doc._id).select("-imageData");
    if (out.already) return res.json({ ...updated.toObject(), alreadySent: true, message: "यह delivery पहले ही भेजी जा चुकी है" });
    if (!out.ok && out.retrying) {
      return res.status(202).json({ ...updated.toObject(), retrying: true,
        message: `अभी नहीं गई — ${out.attempt}/${MAX_ATTEMPTS} कोशिश। कुछ मिनट में अपने आप दोबारा जाएगी।` });
    }
    await activity(doc.brand, "publish", out.ok ? "success" : "failed",
      out.ok ? `भेजा गया: ${(out.channels || []).join(", ")}` : `भेजने में fail: ${String(out.error).slice(0, 150)}`,
      { contentId: doc._id, by: req.user?.email || "AI" });
    // ⚠️ नया: approve होते ही ग्राहक को भी उसकी photo/video (अगर चालू है)
    setImmediate(() => sendDeliveryToCustomer(doc.brand, updated)
      .catch((e) => log("WARN", "sendDeliveryToCustomer", { msg: e.message })));
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/delivery/:id/resend", requireRole("super-admin", "admin", "manager"), async (req, res) => {
  try {
    const doc = await Delivery.findById(req.params.id); if (!doc) return res.status(404).json({ error: "not found" });
    await Delivery.findByIdAndUpdate(doc._id, { publishedKey: "", publishLock: "", attempts: 0, nextRetryAt: null });
    await audit(req, { brand: doc.brand, action: "send", entity: "delivery", entityId: doc._id, summary: "user ने जानबूझकर दोबारा भेजा" });
    const out = await safePublish(Delivery, doc._id, req);
    const updated = await Delivery.findById(doc._id).select("-imageData");
    await activity(doc.brand, "publish", out.ok ? "success" : "failed",
      out.ok ? `दोबारा भेजा गया: ${(out.channels || []).join(", ")}` : `दोबारा भेजना fail: ${String(out.error).slice(0, 150)}`,
      { contentId: doc._id, by: req.user?.email || "AI" });
    res.json({ ...updated.toObject(), results: out.results });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post("/api/delivery/:id/reject", async (req, res) => {
  try {
    const doc = await Delivery.findByIdAndUpdate(req.params.id, { status: "rejected", nextRetryAt: null }, { new: true }).select("-imageData");
    if (!doc) return res.status(404).json({ error: "not found" });
    await audit(req, { brand: doc.brand, action: "reject", entity: "delivery", entityId: doc._id, summary: "delivery post reject किया" });
    res.json(doc);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---- Leads / CRM ----
// ⚠️ यह route PUBLIC है — बिना limit के कोई भी हज़ारों fake leads भर सकता था
app.post("/api/lead", rateLimit({ windowMs: 60000, max: 5, key: "lead", message: "बहुत तेज़ — एक मिनट रुककर दोबारा भेजें" }), async (req, res) => { // PUBLIC
  try {
    const { brand, name, mobile, vehicleInterest, source } = req.body;
    if (!mobile) return res.status(400).json({ error: "mobile चाहिए" });
    const lead = await Lead.create({ brand, name, mobile, vehicleInterest, source: source || "post" });
    notify("lead", `नया lead: ${name || mobile} (${vehicleInterest || "—"})`, brand);
    if (BRANDS[brand]) {
      fireTriggerAsync("new_lead", brand, { summary: `${name || mobile} को ${vehicleInterest || "गाड़ी"} में रुचि` });
      // ⚠️ नया: मालिक को तुरंत WhatsApp + (चालू हो तो) ग्राहक को अपने आप जवाब
      setImmediate(() => handleNewLead(brand, lead).catch((e) => log("WARN", "handleNewLead", { msg: e.message })));
    }
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

// ══════════════════════════════════════════════════════════════
// PHASE 6 — ANALYTICS + AI REPORT
// पिछले हफ्ते/महीने का पूरा हिसाब + AI की सलाह
// ══════════════════════════════════════════════════════════════

// विस्तृत stats — किस type का content कितना गया, कौन fail हुआ
app.get("/api/analytics/detailed", async (req, res) => {
  try {
    const brand = req.query.brand;
    const days = Math.min(Math.max(parseInt(req.query.days) || 7, 1), 90);
    const since = new Date(Date.now() - days * 864e5);
    const q = brand ? { brand } : {};
    const qs = { ...q, createdAt: { $gte: since } };

    const [byType, byStatus, byBrand, byChannel, deliveries, failedList] = await Promise.all([
      Content.aggregate([{ $match: qs }, { $group: { _id: "$type", n: { $sum: 1 }, sent: { $sum: { $cond: [{ $eq: ["$status", "sent"] }, 1, 0] } } } }, { $sort: { n: -1 } }]),
      Content.aggregate([{ $match: qs }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
      Content.aggregate([{ $match: { createdAt: { $gte: since } } }, { $group: { _id: "$brand", n: { $sum: 1 }, sent: { $sum: { $cond: [{ $eq: ["$status", "sent"] }, 1, 0] } } } }]),
      Content.aggregate([{ $match: { ...qs, status: "sent" } }, { $unwind: { path: "$channels", preserveNullAndEmptyArrays: false } }, { $group: { _id: "$channels", n: { $sum: 1 } } }, { $sort: { n: -1 } }]),
      Delivery.countDocuments({ ...q, createdAt: { $gte: since } }),
      Content.find({ ...qs, status: "failed" }).sort({ createdAt: -1 }).limit(8).select("type text results createdAt").lean(),
    ]);

    const dailyTrend = await Content.aggregate([
      { $match: qs },
      { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, total: { $sum: 1 }, sent: { $sum: { $cond: [{ $eq: ["$status", "sent"] }, 1, 0] } }, failed: { $sum: { $cond: [{ $eq: ["$status", "failed"] }, 1, 0] } } } },
      { $sort: { _id: 1 } },
    ]);

    const totals = byStatus.reduce((a, s) => { a[s._id] = s.n; return a; }, {});
    const totalAll = Object.values(totals).reduce((a, b2) => a + b2, 0);
    const successRate = totalAll ? Math.round(((totals.sent || 0) / totalAll) * 100) : 0;

    res.json({ days, byType, byStatus, byBrand, byChannel, deliveries, failedList, dailyTrend, totals, totalAll, successRate });
  } catch (e) { log("ERROR", "/analytics/detailed", { msg: e.message }); res.status(500).json({ error: e.message }); }
});

// AI से हफ्ते/महीने की report + आगे की सलाह
app.post("/api/analytics/ai-report", async (req, res) => {
  try {
    const { brand, days } = req.body;
    const nDays = Math.min(Math.max(parseInt(days) || 7, 1), 90);
    const since = new Date(Date.now() - nDays * 864e5);
    const q = brand && BRANDS[brand] ? { brand } : {};
    const qs = { ...q, createdAt: { $gte: since } };

    const [byType, byStatus, byChannel, recentSent, failedList, delivCount] = await Promise.all([
      Content.aggregate([{ $match: qs }, { $group: { _id: "$type", n: { $sum: 1 }, sent: { $sum: { $cond: [{ $eq: ["$status", "sent"] }, 1, 0] } } } }]),
      Content.aggregate([{ $match: qs }, { $group: { _id: "$status", n: { $sum: 1 } } }]),
      Content.aggregate([{ $match: { ...qs, status: "sent" } }, { $unwind: { path: "$channels", preserveNullAndEmptyArrays: false } }, { $group: { _id: "$channels", n: { $sum: 1 } } }]),
      Content.find({ ...qs, status: "sent" }).sort({ createdAt: -1 }).limit(12).select("type text").lean(),
      Content.find({ ...qs, status: "failed" }).sort({ createdAt: -1 }).limit(6).select("type results").lean(),
      Delivery.countDocuments({ ...q, createdAt: { $gte: since } }),
    ]);

    const totals = byStatus.reduce((a, s) => { a[s._id] = s.n; return a; }, {});
    const brandName = brand && BRANDS[brand] ? BRANDS[brand].name : "सभी brands";
    const todayIST = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const upcoming = FESTIVALS.filter(f => { const d = (new Date(f.date) - new Date(todayIST)) / 864e5; return d >= 0 && d <= 20; })
      .map(f => `${f.name} (${f.date})`).join(", ") || "कोई नहीं";

    const failReasons = failedList.map(f => {
      const rs = Array.isArray(f.results) ? f.results.filter(r => !r.ok).map(r => `${r.platform}: ${r.error}`).join("; ") : "";
      return `[${f.type}] ${rs}`;
    }).join("\n") || "कोई नहीं";

    const sys = `तुम "${brandName}" के marketing analyst हो। पिछले ${nDays} दिन का डेटा नीचे है।

Content by type: ${byType.map(t => `${t._id}: कुल ${t.n}, भेजे ${t.sent}`).join(" | ") || "कोई नहीं"}
Status: भेजे=${totals.sent || 0}, pending=${totals.pending || 0}, fail=${totals.failed || 0}
Channels: ${byChannel.map(c => `${c._id}: ${c.n}`).join(", ") || "कोई नहीं"}
Deliveries: ${delivCount}
आने वाले त्यौहार (20 दिन): ${upcoming}

हाल में भेजे गए posts:
${recentSent.map(r => `[${r.type}] ${String(r.text || "").slice(0, 70)}`).join("\n") || "कोई नहीं"}

Fail हुए posts की वजह:
${failReasons}

एक JSON return करो (सिर्फ़ valid JSON):
{
  "headline_hindi": "एक लाइन में — यह हफ्ता/महीना कैसा रहा",
  "highlights": ["3-4 अच्छी बातें, हर एक एक लाइन"],
  "concerns": ["2-3 चिंता की बातें (fail, कम posts, repetition वगैरह)"],
  "topPerformer_hindi": "किस type का content सबसे ज़्यादा गया और क्यों अच्छा रहा",
  "recommendations": [
    { "action_hindi": "क्या करें", "why_hindi": "क्यों" }
  ],
  "nextWeekPlan_hindi": "अगले हफ्ते क्या focus करना चाहिए — 2-3 लाइन"
}

नियम:
- सब Hindi में, सरल भाषा
- कोई fake number मत बनाओ — सिर्फ़ ऊपर दिए डेटा से
- recommendations में 3-4 items
- अगर डेटा बहुत कम है तो साफ़ कहो कि "अभी डेटा कम है"`;

    const out = await AI.json(sys, { temperature: 0.5, timeout: 25000, maxTokens: 1800 });
    if (out.error) return res.status(500).json({ error: out.error });
    return res.json({ ...out, stats: { days: nDays, totals, byType, byChannel, deliveries: delivCount } });
  } catch (e) { log("ERROR", "/analytics/ai-report", { msg: e.message }); res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════
// PHASE 7 — DELIVERY VIDEO AI
// कई photos से automatic slideshow video — transitions + text overlay
// ══════════════════════════════════════════════════════════════

// एक photo से clip बनाओ — Ken Burns zoom effect + optional text
function clipFromPhoto(imgPath, dur, outPath, opts = {}) {
  const { zoom = true, text = "", subText = "", fontFile } = opts;
  const fps = 25, frames = Math.round(dur * fps);
  const fadeOut = Math.max(0, frames - 12);

  // scale + pad to 1080x1920 (9:16), फिर zoom
  let vf = `scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920`;
  if (zoom) {
    vf += `,zoompan=z='min(zoom+0.0012,1.15)':d=${frames}:s=1080x1920:fps=${fps}`;
  }
  vf += `,fade=in:0:12,fade=out:${fadeOut}:12`;

  // Text overlay
  if (text) {
    const esc = (s) => String(s).replace(/[\\':]/g, m => "\\" + m).replace(/%/g, "\\%");
    const ff = fontFile ? `fontfile='${fontFile}':` : "";
    vf += `,drawbox=x=0:y=h-420:w=iw:h=420:color=black@0.55:t=fill`;
    vf += `,drawtext=${ff}text='${esc(text)}':fontcolor=#FFD600:fontsize=72:x=(w-text_w)/2:y=h-330:shadowcolor=black:shadowx=3:shadowy=3`;
    if (subText) {
      vf += `,drawtext=${ff}text='${esc(subText)}':fontcolor=white:fontsize=46:x=(w-text_w)/2:y=h-230:shadowcolor=black:shadowx=2:shadowy=2`;
    }
  }

  return new Promise((res, rej) => execFile("ffmpeg", [
    "-y", "-loop", "1", "-i", imgPath, "-t", String(dur), "-r", String(fps),
    "-vf", vf, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", outPath,
  ], { maxBuffer: 1024 * 1024 * 20 }, (e, _o, se) => (e ? rej(new Error("clip: " + (se || e.message).slice(0, 200))) : res())));
}

// कई photos → एक slideshow video
async function makeSlideshowVideo(jobId, photoPaths, opts = {}) {
  if (!ENABLE_VIDEO) throw new Error("video disabled");
  if (!(await ffmpegOk())) throw new Error("ffmpeg installed नहीं है");
  if (!photoPaths.length) throw new Error("कोई photo नहीं");

  const { perPhotoDur = 3, headline = "", subLine = "", musicFile = null, fontFile } = opts;
  const clips = [];

  for (let i = 0; i < photoPaths.length; i++) {
    const out = path.join(OUT_DIR, `${jobId}_sc${i}.mp4`);
    // पहली clip पर headline, बाकी पर कुछ नहीं
    const textOpts = i === 0 ? { text: headline, subText: subLine, fontFile } : { fontFile };
    await clipFromPhoto(photoPaths[i], perPhotoDur, out, { zoom: true, ...textOpts });
    clips.push(out);
  }

  const listFile = path.join(OUT_DIR, `${jobId}_sclist.txt`);
  fs.writeFileSync(listFile, clips.map(c => `file '${c}'`).join("\n"));
  const out = path.join(OUT_DIR, `${jobId}_slideshow.mp4`);

  const args = ["-y", "-f", "concat", "-safe", "0", "-i", listFile];
  if (musicFile && fs.existsSync(musicFile)) args.push("-i", musicFile);
  args.push("-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "veryfast", "-movflags", "+faststart");
  if (musicFile && fs.existsSync(musicFile)) args.push("-c:a", "aac", "-b:a", "128k", "-shortest");
  args.push(out);

  await new Promise((res, rej) => execFile("ffmpeg", args, { maxBuffer: 1024 * 1024 * 20 },
    (e, _o, se) => (e ? rej(new Error("concat: " + (se || e.message).slice(0, 200))) : res())));

  clips.forEach(c => { try { fs.unlinkSync(c); } catch (_) {} });
  try { fs.unlinkSync(listFile); } catch (_) {}
  // ⚠️ नया: slideshow पर भी header (आपका logo बाएँ, कंपनी का दाएँ)
  if (opts.brand && BRANDS[opts.brand]) await stampVideoHeader(out, opts.brand, 1080, 1920);
  return `/generated/${jobId}_slideshow.mp4`;
}

// base64 photos को disk पर लिखो
function saveBase64Photos(jobId, images) {
  const paths = [];
  images.forEach((dataUrl, i) => {
    const clean = String(dataUrl).replace(/^data:image\/\w+;base64,/, "");
    const p = path.join(OUT_DIR, `${jobId}_ph${i}.jpg`);
    fs.writeFileSync(p, Buffer.from(clean, "base64"));
    paths.push(p);
  });
  return paths;
}

app.post("/api/video/slideshow", requireRole("super-admin", "admin", "manager"), async (req, res) => {
  try {
    const { brand, images, headline, subLine, perPhotoDur, caption } = req.body;
    if (!BRANDS[brand]) return res.status(400).json({ error: "brand चाहिए" });
    if (!Array.isArray(images) || images.length < 2) return res.status(400).json({ error: "कम से कम 2 photos चाहिए" });
    if (images.length > 8) return res.status(400).json({ error: "ज़्यादा से ज़्यादा 8 photos" });

    // Cost control — daily video limit
    const vLimit = await checkAndCountUsage(brand, "videos");
    if (!vLimit.ok) return res.status(429).json({ error: vLimit.message });

    const jobId = "vid" + Date.now();
    VIDEO_JOBS[jobId] = { status: "processing", startedAt: new Date(), brand };
    res.json({ ok: true, jobId, status: "processing" });   // तुरंत respond करो

    // Background में बनाओ
    setImmediate(async () => {
      let photoPaths = [];
      try {
        photoPaths = saveBase64Photos(jobId, images.slice(0, 8));
        const url = await makeSlideshowVideo(jobId, photoPaths, {
          perPhotoDur: Math.min(Math.max(parseFloat(perPhotoDur) || 3, 1.5), 6),
          headline: headline || "बधाई हो!",
          subLine: subLine || "",
          brand,                      // ⚠️ header लगाने के लिए ज़रूरी
        });

        // Content doc बनाओ ताकि Review में दिखे
        const doc = await Content.create({
          brand, type: "vigyapan", post_type: "video",
          text: caption || `🎉 ${headline || "बधाई हो!"}`,
          status: "pending", video: url,
        });

        VIDEO_JOBS[jobId] = { status: "done", url, contentId: doc._id, finishedAt: new Date() };
        await notify("video_ready", `🎬 ${BRANDS[brand].name}: Video तैयार है — Review में देखें`, brand);
        await activity(brand, "video", "success", `${images.length} photos से video बनाया`, { contentId: doc._id });
        log("INFO", "[VIDEO] slideshow done", { jobId, url });
      } catch (e) {
        VIDEO_JOBS[jobId] = { status: "failed", error: e.message, finishedAt: new Date() };
        log("ERROR", "[VIDEO] slideshow failed", { jobId, msg: e.message });
        await activity(brand, "video", "failed", `Video नहीं बना: ${e.message}`, {});
        await notify("video_failed", `❌ Video बनाने में दिक्कत: ${e.message}`, brand);
      } finally {
        photoPaths.forEach(p => { try { fs.unlinkSync(p); } catch (_) {} });
      }
    });
  } catch (e) { log("ERROR", "/video/slideshow", { msg: e.message }); res.status(500).json({ error: e.message }); }
});

app.get("/api/video/status/:jobId", (req, res) => {
  const job = VIDEO_JOBS[req.params.jobId];
  if (!job) return res.status(404).json({ error: "job नहीं मिला" });
  res.json(job);
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

    // बटन दबाया गया हो तो उसका id, वरना लिखा हुआ text
    const body = msg.interactive?.button_reply?.id
      || msg.button?.payload
      || msg.text?.body
      || "";

    // ── 1) क्या यह मालिक का approval जवाब है? ──
    const cfg = await OwnerWA.findOne({ brand: brandId }).lean();
    const isOwner = cfg?.enabled && (cfg.numbers || []).some((n) => String(n).replace(/\D/g, "").endsWith(String(msg.from).replace(/\D/g, "").slice(-10)));

    if (isOwner) {
      // ── बोलकर command (voice note) ──
      const audioId = msg.audio?.id || msg.voice?.id;
      if (audioId) {
        await handleVoiceCommand(brandId, msg.from, audioId);
        return;
      }

      const reply = await handleApprovalReply(brandId, msg.from, body);
      if (reply) {
        log("INFO", "[WA-APPROVAL] मालिक का जवाब", { brandId, from: msg.from, body: String(body).slice(0, 40) });
        try { await waSend(brandId, msg.from, { type: "text", text: { body: reply } }); } catch (_) {}
        return;
      }
      // मालिक ने कुछ और लिखा — मदद वाला message
      if (/^(help|मदद|\?)/i.test(String(body).trim())) {
        try {
          await waSend(brandId, msg.from, { type: "text", text: { body:
            `नमस्ते 🙏 यहाँ से आप ये कर सकते हैं:\n\n` +
            `• बटन दबाइए — ✅ भेज दो / ❌ रहने दो / 📥 मैं भेजूँगा\n` +
            `• या लिखिए: *A7 हाँ* (कोड के साथ)\n` +
            `• *बाकी* — जो पोस्ट बची हैं वो भेजूँ\n` +
            `• *हिसाब* — इस महीने का हिसाब` } });
        } catch (_) {}
        return;
      }
      if (/^(बाकी|baki|pending|बचे)/i.test(String(body).trim())) {
        const r = await pushPendingToWhatsApp(brandId, 5);
        try { await waSend(brandId, msg.from, { type: "text", text: { body: r.sent ? `${r.sent} पोस्ट भेज दीं 👆` : "अभी कोई नई पोस्ट नहीं है ✅" } }); } catch (_) {}
        return;
      }
      if (/^(हिसाब|hisab|report|रिपोर्ट)/i.test(String(body).trim())) {
        await sendMonthlyReport(brandId);
        return;
      }
    }

    // ── 2) वरना ग्राहक का सवाल — पुराना bot ──
    const reply = botReply(brandId, msg.text?.body);
    log("INFO", "WA bot reply", { brandId, from: msg.from });
    const waToken = brandCreds(brandId).waToken || process.env.WA_TOKEN || "";
    if (TEST_MODE || !waToken) return;
    await fetch(`${GRAPH}/${phoneId}/messages`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${waToken}` }, body: JSON.stringify({ messaging_product: "whatsapp", to: msg.from, type: "text", text: { body: reply } }) });
  } catch (e) { log("ERROR", "WA webhook", { msg: e.message }); }
});

// ===========================================================================
// CRON — रोज़ generate→pending + festival auto-mode (auto-post नहीं!)
// ===========================================================================
async function genToPending(brand, rawType, festivalName, extraCtx) {
  const type = normType(rawType);
  // extraCtx = batch/trigger से आया हुआ विषय — इससे हर post अलग बनता है
  const text = await generateText(brand, type, festivalName, extraCtx);
  const doc = await Content.create({ brand, type, text, status: "pending" });
  const imgs = await generateImages(brand, doc._id, text, type, {});
  doc.images = { square: imgs.square, story: imgs.story, landscape: imgs.landscape };
  // imageData DB में save करो — Review Queue में image दिखे
  if (imgs._b64 && imgs._b64.square) {
    const sz = Buffer.byteLength(imgs._b64.square, "utf8");
    if (sz < 2 * 1024 * 1024) doc.imageData = { square: imgs._b64.square, story: imgs._b64.story };
  }
  await doc.save();
  log("INFO", "cron → pending", { brand, type, id: String(doc._id) });
  return doc;
}
if (ENABLE_CRON) {

  // ────────────────────────────────────────────────────────────────
  // CRON 0 — हर 5 मिनट: AI Command Center से scheduled commands check करो
  //  • ScheduledCommand collection में जो due हैं उन्हें process करो
  //  • generate करके pending में डाल दो (auto-publish नहीं — review में जाएगा)
  //  • recurring:"daily" वाले अगले दिन के लिए फिर schedule हो जाते हैं
  // ────────────────────────────────────────────────────────────────
  cron.schedule("*/5 * * * *", async () => {
    try {
      const nowIST = new Date().toLocaleString("en-CA", { timeZone: "Asia/Kolkata", hour12: false }).replace(",", "");
      const [nowDate, nowTime] = nowIST.split(" ");
      const nowHM = (nowTime || "00:00").slice(0, 5);

      const due = await ScheduledCommand.find({ status: "scheduled" }).lean();
      for (const cmd of due) {
        let targetDate = cmd.scheduleDate;
        if (cmd.scheduleWhen === "tomorrow" && !targetDate) {
          const t = new Date(); t.setDate(t.getDate() + 1);
          targetDate = t.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
        }
        if (cmd.scheduleWhen === "today" && !targetDate) targetDate = nowDate;
        const targetTime = cmd.scheduleTime || "09:00";

        const isDue = targetDate === nowDate && targetTime <= nowHM;
        if (!isDue) continue;

        try {
          const doc = await Content.create({ brand: cmd.brand, type: cmd.type, text: cmd.text, status: "pending" });
          const imgs = await generateImages(cmd.brand, doc._id, cmd.text, cmd.type, {});
          const b64 = imgs._b64 || {}; delete imgs._b64;
          doc.images = imgs;
          if (b64.square) doc.imageData = { square: b64.square, story: b64.story };
          await doc.save();

          await activity(cmd.brand, "generate", "success", `Scheduled content तैयार हुआ (${targetTime})`, { contentId: doc._id });

          // Approval mode देखो — full/semi में auto-publish
          const autoS = await getAutomationSettings(cmd.brand);
          const shouldAuto = autoS.mode === "full" ||
            (autoS.mode === "semi" && (autoS.autoTypes || []).includes(cmd.type));

          if (shouldAuto) {
            try {
              const chans = (autoS.autoChannels || ["fb", "ig"]).reduce((a, c) => { a[c] = true; return a; }, {});
              const results = await publish({ ...doc.toObject(), platforms: chans });
              const ok = results.filter(r => r.ok).map(r => r.platform);
              await Content.findByIdAndUpdate(doc._id, { status: ok.length ? "sent" : "failed", channels: ok, sentAt: new Date(), results });
              await activity(cmd.brand, "publish", ok.length ? "success" : "failed",
                ok.length ? `Auto-publish (${autoS.mode} mode): ${ok.join(", ")}` : `Auto-publish fail`, { contentId: doc._id });
              await notify(ok.length ? "auto_published" : "post_failed",
                ok.length ? `🚀 ${BRANDS[cmd.brand]?.name}: अपने-आप भेज दिया (${ok.join(", ")})` : `❌ ${BRANDS[cmd.brand]?.name}: auto-post fail — Review में देखें`,
                cmd.brand);
            } catch (pe) {
              await notify("post_failed", `❌ ${BRANDS[cmd.brand]?.name}: auto-publish error — ${pe.message}`, cmd.brand);
            }
          } else {
            await notify("scheduled_ready", `⏰ ${BRANDS[cmd.brand]?.name || cmd.brand}: आपका scheduled content तैयार है — Review में देखें`, cmd.brand);
          }

          if (cmd.recurring === "daily" || cmd.recurring === "weekly") {
            // ⚠️ पहले scheduleDate वही रहता था → उसी दिन हर 5 मिनट पर दोबारा generate होता रहता था
            const step = cmd.recurring === "weekly" ? 7 : 1;
            const nxt = new Date(`${targetDate}T00:00:00+05:30`);
            nxt.setDate(nxt.getDate() + step);
            await ScheduledCommand.findByIdAndUpdate(cmd._id, {
              lastRunAt: new Date(), contentId: doc._id, status: "scheduled",
              scheduleWhen: "specific_date",
              scheduleDate: nxt.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }),
            });
          } else {
            await ScheduledCommand.findByIdAndUpdate(cmd._id, { status: "processed", lastRunAt: new Date(), contentId: doc._id });
          }
          log("INFO", "[CMD-CRON] executed", { id: cmd._id, brand: cmd.brand, type: cmd.type });
        } catch (e) {
          await ScheduledCommand.findByIdAndUpdate(cmd._id, { status: "failed" });
          log("ERROR", "[CMD-CRON] failed", { id: cmd._id, msg: e.message });
          await notify("scheduled_failed", `❌ ${BRANDS[cmd.brand]?.name || cmd.brand}: scheduled command fail — ${e.message}`, cmd.brand);
        }
      }
    } catch (e) { log("ERROR", "[CMD-CRON] fatal", { msg: e.message }); }
  }, { timezone: "Asia/Kolkata" });

  // ────────────────────────────────────────────────────────────────
  // CRON 1 — सुबह 10:00 बजे: सुविचार / त्यौहार
  // शर्तें:
  //  • हर दिन तीनों brands (VP Honda, Yakuza EV, Mini Metro) के लिए
  //  • अगर आज कोई त्यौहार है → festival type post
  //  • नहीं तो → सुविचार/शुभप्रभात post
  //  • AI से text generate होगा, image बनेगी
  //  • FB + IG पर auto-post होगा
  //  • अगर fail → notification आएगा, post "failed" status में रहेगा
  //  • Manual re-send app से "भेजे गए" section में दोबारा button से
  // ────────────────────────────────────────────────────────────────
  // ⚠️ नया: हर 6 घंटे पुराने base64 हटाओ — Render की memory बचाने के लिए
cron.schedule("15 */6 * * *", async () => {
  try { await trimImageData(); } catch (e) { log("ERROR", "[CRON] trim", { msg: e.message }); }
}, { timezone: "Asia/Kolkata" });

// हर 10 मिनट memory देखो
setInterval(memoryWatch, 10 * 60000).unref?.();

// ⚠️ नया: हर महीने की 1 तारीख़ सुबह 9 बजे — पिछले महीने का हिसाब WhatsApp पर
cron.schedule("0 9 1 * *", async () => {
  for (const brand of Object.keys(BRANDS)) {
    try { await sendMonthlyReport(brand); }
    catch (e) { log("ERROR", "[CRON] monthly report", { brand, msg: e.message }); }
  }
}, { timezone: "Asia/Kolkata" });

// ⚠️ नया: 48 घंटे से पुराने बिना-जवाब वाले WhatsApp message साफ़ करो
cron.schedule("30 3 * * *", async () => {
  try {
    const r = await WAPending.updateMany(
      { status: "waiting", expiresAt: { $lt: new Date() } },
      { status: "expired" });
    if (r.modifiedCount) log("INFO", "[WA] पुराने pending expire किए", { count: r.modifiedCount });
  } catch (e) { log("ERROR", "[CRON] wa cleanup", { msg: e.message }); }
}, { timezone: "Asia/Kolkata" });

// ⚠️ नया: रोज़ सुबह 7 बजे — तीनों brands का पूरा दिन का content अपने आप
//    (posters + promotional video + delivery videos). सब Review में जाते हैं।
cron.schedule("0 7 * * *", async () => {
  for (const brand of Object.keys(BRANDS)) {
    try {
      const st = await AutomationSettings.findOne({ brand }).lean();
      if (st?.dailyEngineOn === false) { log("INFO", "[DAILY-ENGINE] बंद है, skip", { brand }); continue; }
      await runDailyEngine(brand);
    } catch (e) { log("ERROR", "[CRON] daily engine", { brand, msg: e.message }); }
  }
}, { timezone: "Asia/Kolkata" });

// ⚠️ नया: रोज़ रात 1 बजे FB/IG से असली आँकड़े लाओ (PRD #33)
cron.schedule("0 1 * * *", async () => {
  try {
    for (const brand of Object.keys(BRANDS)) await refreshAllInsights(brand, 30);
  } catch (e) { log("ERROR", "[CRON] insights", { msg: e.message }); }
}, { timezone: "Asia/Kolkata" });

// ⚠️ नया: रोज़ सुबह 8 बजे — त्यौहार पास है? Review खाली है? (PRD #23)
cron.schedule("0 8 * * *", async () => {
  try {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const in2 = new Date(Date.now() + 2 * 864e5).toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const fest = FESTIVALS.find((f) => f.date > today && f.date <= in2);

    for (const brand of Object.keys(BRANDS)) {
      if (fest) fireTriggerAsync("festival_soon", brand, { summary: `${fest.name} 2 दिन में है` });
      const left = await Content.countDocuments({ brand, status: "pending" });
      if (left < 2) fireTriggerAsync("low_content", brand, { summary: `Review में सिर्फ़ ${left} post बचे हैं` });
    }
  } catch (e) { log("ERROR", "[CRON] event triggers", { msg: e.message }); }
}, { timezone: "Asia/Kolkata" });

// ⚠️ नया: fail हुए posts की दोबारा कोशिश (PRD #18, #38)
cron.schedule("*/5 * * * *", async () => {
  try { await runRetryQueue(); } catch (e) { log("ERROR", "[CRON] retry", { msg: e.message }); }
}, { timezone: "Asia/Kolkata" });

// ⚠️ नया: रोज़ रात 3 बजे पुरानी files हटाओ — वरना Render की disk भर जाती है (PRD #39)
cron.schedule("0 3 * * *", async () => {
  try {
    const before = diskUsage();
    const r = await cleanupStorage(false);
    log("INFO", "[CRON] cleanup हुआ", { before: before.mb + "MB", deleted: r.deleted, freed: r.freedMB + "MB" });
    if (r.freedMB > 50) notify("info", `${r.freedMB} MB जगह खाली की गई (${r.deleted} पुरानी files)`, "vp_honda");
  } catch (e) { log("ERROR", "[CRON] cleanup", { msg: e.message }); }
}, { timezone: "Asia/Kolkata" });

cron.schedule("0 10 * * *", async () => {
    const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
    const fest = FESTIVALS.find((f) => f.date === today);
    log("INFO", "[CRON-10AM] शुरू", { today, festival: fest?.name || "none" });
    for (const brand of Object.keys(BRANDS)) {
      try {
        const type = fest ? "festival" : "suvichar";
        const doc = await genToPending(brand, type, fest?.name || "");
        if (!doc) throw new Error("genToPending ने doc return नहीं किया");
        const results = await publish({ ...doc.toObject(), platforms: { fb: true, ig: true, wa: false, yt: false } });
        const ok = results.filter(r => r.ok).map(r => r.platform);
        const failed = results.filter(r => !r.ok);
        await Content.findByIdAndUpdate(doc._id, {
          status: ok.length ? "sent" : "failed",
          channels: ok, sentAt: new Date(), results
        });
        if (ok.length) {
          log("INFO", `[CRON-10AM] ✅ ${BRANDS[brand].name} → ${type} sent: ${ok.join(", ")}`);
        } else {
          const errMsg = failed.map(r => `${r.platform}: ${r.error}`).join(" | ");
          log("ERROR", `[CRON-10AM] ❌ ${brand} fail`, { errMsg });
          await notify("post_failed",
            `⚠️ ${BRANDS[brand].name}: सुबह 10 बजे ${type} post fail
${errMsg}
👉 App खोलें → भेजे गए → दोबारा`, brand);
        }
      } catch (e) {
        log("ERROR", "[CRON-10AM] error", { brand, msg: e.message });
        await notify("post_failed",
          `❌ ${BRANDS[brand]?.name||brand}: 10AM auto-post error
${e.message}
👉 Manual post करें`, brand);
      }
    }
    log("INFO", "[CRON-10AM] पूरा हुआ");
  }, { timezone: "Asia/Kolkata" });

  // ────────────────────────────────────────────────────────────────
  // CRON 2 — सुबह 11:00 बजे: विज्ञापन / Promo
  // शर्तें:
  //  • हर दिन तीनों brands के लिए
  //  • AI से promotional text + image बनेगी
  //  • FB + IG पर auto-post होगा
  //  • अगर fail → notification, manual re-send option
  //  • WA और YT पर नहीं जाएगा (सिर्फ social media)
  // ────────────────────────────────────────────────────────────────
  cron.schedule("0 11 * * *", async () => {
    log("INFO", "[CRON-11AM] विज्ञापन शुरू");
    for (const brand of Object.keys(BRANDS)) {
      try {
        const doc = await genToPending(brand, "vigyapan", "");
        if (!doc) throw new Error("genToPending ने doc return नहीं किया");
        const results = await publish({ ...doc.toObject(), platforms: { fb: true, ig: true, wa: false, yt: false } });
        const ok = results.filter(r => r.ok).map(r => r.platform);
        const failed = results.filter(r => !r.ok);
        await Content.findByIdAndUpdate(doc._id, {
          status: ok.length ? "sent" : "failed",
          channels: ok, sentAt: new Date(), results
        });
        if (ok.length) {
          log("INFO", `[CRON-11AM] ✅ ${BRANDS[brand].name} विज्ञापन sent: ${ok.join(", ")}`);
        } else {
          const errMsg = failed.map(r => `${r.platform}: ${r.error}`).join(" | ");
          log("ERROR", `[CRON-11AM] ❌ ${brand} fail`, { errMsg });
          await notify("post_failed",
            `⚠️ ${BRANDS[brand].name}: 11AM विज्ञापन post fail
${errMsg}
👉 App → भेजे गए → दोबारा`, brand);
        }
      } catch (e) {
        log("ERROR", "[CRON-11AM] error", { brand, msg: e.message });
        await notify("post_failed",
          `❌ ${BRANDS[brand]?.name||brand}: 11AM विज्ञापन error
${e.message}
👉 Manual post करें`, brand);
      }
    }
    log("INFO", "[CRON-11AM] पूरा हुआ");
  }, { timezone: "Asia/Kolkata" });

  // ────────────────────────────────────────────────────────────────
  // CRON 3 — शाम 8:00 बजे: Delivery Photos auto-share
  // शर्तें:
  //  • उस दिन जितनी भी pending delivery photos हों सब भेजेगा
  //  • तीनों brands की deliveries
  //  • FB + IG + WhatsApp पर जाएगा
  //  • अगर आपने दोपहर में photo upload किया → शाम 8 बजे auto-share
  //  • अगर fail → notification: "Manual share करें"
  //  • Manual share: App → Delivery → भेजे गए → दोबारा button
  //  • अगर उस दिन कोई delivery नहीं → कुछ नहीं होगा
  // ────────────────────────────────────────────────────────────────
  cron.schedule("0 20 * * *", async () => {
    log("INFO", "[CRON-8PM] Delivery auto-share शुरू");
    try {
      // ⚠️ पहले यह सारी pending deliveries base64 समेत RAM में उठा लेता था
      const pendingDeliveries = await Delivery.find({ status: "pending" })
        .select("-imageData").sort({ createdAt: -1 }).limit(10).lean();
      if (!pendingDeliveries.length) {
        log("INFO", "[CRON-8PM] आज कोई pending delivery नहीं");
        return;
      }
      log("INFO", `[CRON-8PM] ${pendingDeliveries.length} deliveries मिलीं`);
      for (const d of pendingDeliveries) {
        try {
          const results = await publish({ ...d, platforms: { fb: true, ig: true, wa: true, yt: false } });
          const ok = results.filter(r => r.ok).map(r => r.platform);
          const failed = results.filter(r => !r.ok);
          await Delivery.findByIdAndUpdate(d._id, {
            status: ok.length ? "sent" : "failed",
            channels: ok, sentAt: new Date(), results
          });
          if (ok.length) {
            log("INFO", `[CRON-8PM] ✅ Delivery ${d._id} (${BRANDS[d.brand]?.name||d.brand}) → ${ok.join(", ")}`);
          } else {
            const errMsg = failed.map(r => `${r.platform}: ${r.error}`).join(" | ");
            log("ERROR", `[CRON-8PM] ❌ Delivery fail`, { id: d._id, errMsg });
            await notify("post_failed",
              `⚠️ ${BRANDS[d.brand]?.name||d.brand}: डिलीवरी photo share fail
${errMsg}
👉 App → Delivery → भेजे गए → दोबारा`, d.brand);
          }
        } catch (e) {
          log("ERROR", "[CRON-8PM] delivery error", { id: d._id, msg: e.message });
          await notify("post_failed",
            `❌ डिलीवरी photo error: ${e.message}
👉 Manual share करें`, d.brand || null);
        }
      }
      log("INFO", "[CRON-8PM] पूरा हुआ");
    } catch (e) {
      log("ERROR", "[CRON-8PM] fatal error", { msg: e.message });
    }
  }, { timezone: "Asia/Kolkata" });

  log("INFO", "✅ CRON jobs active: 10AM सुविचार/त्यौहार | 11AM विज्ञापन | 8PM Delivery");
}

// ===========================================================================
// Boot — admin seed + settings load
// ===========================================================================
(async () => {
  try {
    // ⚠️ छोटे instance पर connection pool भी छोटा रखो — हर connection RAM लेता है
    await mongoose.connect(MONGO_URI, {
      maxPoolSize: 5,
      minPoolSize: 1,
      serverSelectionTimeoutMS: 15000,
      socketTimeoutMS: 45000,
    });
    log("INFO", "MongoDB connected");
  }
  catch (e) { log("ERROR", "MongoDB failed", { msg: e.message }); process.exit(1); }
  await loadSettings();
  await ensureIndexes();
  // ⚠️ शुरू होते ही पुराने base64 हटा दो — पहले से भरा हुआ DB memory खा जाता है
  setTimeout(() => { trimImageData().catch(() => {}); }, 20000);
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
  require("./growth-engine")(app, {
  mongoose, Content, Delivery, Lead, Setting, Notification, ActivityLog,
  brandCreds, loadSettings, log, requireRole, publish,
  BRANDS, GRAPH, PUBLIC_URL, TEST_MODE, OUT_DIR,
});
  app.listen(PORT, () => log("INFO", `AutoSuVichar backend on ${PUBLIC_URL} (TEST_MODE=${TEST_MODE})`));
})();
