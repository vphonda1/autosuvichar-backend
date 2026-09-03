/* ============================================================================
 *  orchestrator.js — AutoSuVichar 2.0 का दिमाग़
 *  --------------------------------------------------------------------------
 *  अब तक हर काम अलग endpoint था — poster अलग, video अलग, caption अलग,
 *  quality check अलग। User को 5 पन्ने घूमने पड़ते थे और फिर भी पता नहीं
 *  चलता था कि कौन-सी चीज़ किस offer की है।
 *
 *  यह file वही सब एक क़तार में जोड़ देती है:
 *
 *      बोलो/लिखो → AI समझे → सच्चाई जाँचे → text बनाए → सच्चाई मिलाए
 *      → poster बनाए → quality check → हर platform का caption
 *      → voice script → Review में डाले (या mode के हिसाब से भेज दे)
 *
 *  एक offer = एक Campaign। उसके सारे टुकड़े (poster, caption, voice, video)
 *  एक ही Campaign से जुड़े रहते हैं, इसलिए नतीजा भी एक साथ दिखता है।
 *
 *  ⚠️ सबसे ज़रूरी हिस्सा — TRUTH VALIDATION
 *     अब तक AI से ही पूछा जाता था "कोई price शक़ी तो नहीं?" — यह अन्दाज़ा था।
 *     अब poster के text से हर ₹ वाला अंक निकालकर Vehicle database से
 *     मिलाया जाता है। जो अंक database में नहीं है, वह post बाहर नहीं जाएगी।
 *     यह AI का काम नहीं, गणित का काम है — इसलिए यह कभी धोखा नहीं देगा।
 *
 *  मौजूदा कोई भी route, model या function यह file बदलती नहीं — सिर्फ़ जोड़ती है।
 * ========================================================================== */

"use strict";

const mongoose = require("mongoose");

// ══════════════════════════════════════════════════════════════════════════
//  CAMPAIGN MODEL — एक offer की पूरी कहानी एक जगह
// ══════════════════════════════════════════════════════════════════════════
const CampaignSchema = new mongoose.Schema(
  {
    brand: { type: String, required: true, index: true },

    // User ने क्या कहा (आवाज़ या लिखकर)
    command: String,
    source: { type: String, default: "text" }, // text | voice | auto | schedule

    // AI ने क्या समझा
    intent: mongoose.Schema.Types.Mixed,
    type: { type: String, default: "vigyapan" },
    vehicle: String,
    offerDetails: String,

    // हालत
    status: {
      type: String,
      enum: ["running", "review", "scheduled", "published", "failed", "blocked"],
      default: "running",
      index: true,
    },
    mode: { type: String, default: "safe" }, // safe | semi | full
    stopReason: String, // क्यों रुका — हिंदी में, user को दिखाने लायक़

    // हर क़दम का हिसाब — user को live दिखता है
    steps: [
      {
        key: String,
        label: String, // हिंदी में
        status: { type: String, default: "wait" }, // wait | run | ok | warn | fail | skip
        detail: String,
        at: Date,
      },
    ],

    // जो बना
    contentId: mongoose.Schema.Types.ObjectId,
    assets: {
      text: String,
      poster: String,
      story: String,
      landscape: String,
      video: String,
      voiceScript: String,
      captions: mongoose.Schema.Types.Mixed, // { whatsapp, instagram, facebook, youtube, status }
    },

    // जाँच के नतीजे
    truth: mongoose.Schema.Types.Mixed, // { verdict, checked[], unknown[], hint }
    quality: mongoose.Schema.Types.Mixed, // { verdict, score, issues[] }

    scheduledFor: Date,
    createdBy: String,
    finishedAt: Date,
  },
  { timestamps: true }
);

CampaignSchema.index({ brand: 1, createdAt: -1 });

const Campaign = mongoose.models.Campaign || mongoose.model("Campaign", CampaignSchema);

// ══════════════════════════════════════════════════════════════════════════
//  TRUTH VALIDATION — यहाँ AI का कोई दख़ल नहीं, सिर्फ़ गणित
// ══════════════════════════════════════════════════════════════════════════

// "₹56,900" → 56900 | "₹1.2 लाख" → 120000 | "₹5 हज़ार" → 5000
const MULT = { "लाख": 100000, "लाख़": 100000, "हज़ार": 1000, "हजार": 1000, "k": 1000, "K": 1000 };

/** किसी string से पैसे वाले सारे अंक निकालो */
function extractAmounts(str) {
  const out = [];
  if (!str) return out;
  const s = String(str);

  // ₹ / Rs / रु के बाद अंक — या अंक के बाद रुपये / ₹
  const re =
    /(?:₹|Rs\.?|रु\.?|रूपये|रुपये|रुपए)\s*([\d][\d,]*(?:\.\d+)?)\s*(लाख|लाख़|हज़ार|हजार|k|K)?|([\d][\d,]*(?:\.\d+)?)\s*(लाख|लाख़|हज़ार|हजार)?\s*(?:₹|रुपये|रुपए|रूपये|रु\.?)/g;

  let m;
  while ((m = re.exec(s)) !== null) {
    const raw = m[1] || m[3];
    const suffix = m[2] || m[4];
    if (!raw) continue;
    let n = parseFloat(String(raw).replace(/,/g, ""));
    if (!isFinite(n)) continue;
    if (suffix && MULT[suffix]) n = Math.round(n * MULT[suffix]);
    out.push(Math.round(n));
  }
  return out;
}

/** प्रतिशत निकालो — ROI के लिए */
function extractPercents(str) {
  const out = [];
  if (!str) return out;
  const re = /([\d]+(?:\.\d+)?)\s*%/g;
  let m;
  while ((m = re.exec(String(str))) !== null) {
    const n = parseFloat(m[1]);
    if (isFinite(n)) out.push(n);
  }
  return out;
}

/**
 * post का text database की सच्चाई से मिलाओ।
 *
 * नियम:
 *   • text का हर ₹ वाला अंक Vehicle record में होना चाहिए,
 *     या user ने ख़ुद अपने command में बताया हो।
 *   • जो अंक कहीं नहीं मिला — वह AI ने अपने-आप बना लिया है। रोक दो।
 *   • फ़ोन नंबर, साल, cc, kmpl — ये पैसे नहीं, इसलिए regex इन्हें छूता ही नहीं
 *     (क्योंकि उनके साथ ₹ नहीं लगता)।
 */
/**
 * ⚠️ "VP Honda", "Honda Two Wheeler", "Yakuza EV" — ये दुकान/brand के नाम हैं,
 *    किसी गाड़ी का नाम नहीं। AI कभी-कभी इन्हें गाड़ी समझकर लौटा देता था, और
 *    फिर Vehicles की सूची में न मिलने पर पूरी post रुक जाती थी — चाहे उसमें
 *    कोई क़ीमत हो ही न (जैसे त्यौहार की बधाई)।
 */
function isBrandNameNotVehicle(deps, brandId, name) {
  const raw = String(name || "").trim();
  if (!raw) return false;
  const t = raw.toLowerCase();

  const b = (deps.BRANDS || {})[brandId] || {};
  const words = [
    b.name, b.sub, b.shortName, b.displayName,
    "vp honda", "honda two wheeler", "two wheeler", "twowheeler",
    "yakuza", "yakuza ev", "mini metro", "minimetro",
    "md automobile", "honda", "showroom", "शोरूम",
    "दोपहिया", "गाड़ी", "गाडी", "बाइक", "bike", "scooter", "स्कूटर",
    "vehicle", "ev", "electric",
  ].filter(Boolean).map((x) => String(x).toLowerCase().trim());

  // पूरा नाम brand का नाम है, या brand-नाम + सामान्य शब्द ही बचता है
  if (words.includes(t)) return true;
  let left = t;
  for (const w of words) if (w.length > 2) left = left.split(w).join(" ");
  // कुछ ठोस बचा ही नहीं (सिर्फ़ खाली जगह/चिह्न) → यह model नाम नहीं है
  return !/[a-z\u0900-\u097F0-9]/.test(left) || !/\d/.test(t) && left.trim().length < 3;
}

async function verifyAgainstTruth(deps, brandId, text, vehicleName, userSaid) {
  const { Vehicle, BRANDS } = deps;
  const found = extractAmounts(text);
  const foundPct = extractPercents(text);

  // कोई पैसा लिखा ही नहीं (जैसे सुविचार) → जाँचने को कुछ नहीं
  if (!found.length && !foundPct.length) {
    return { verdict: "pass", checked: [], unknown: [], allowed: [], hint: "इस post में कोई क़ीमत नहीं है" };
  }

  // database से इस brand की सारी सच्चाई इकट्ठी करो
  const q = { brand: brandId, active: true };
  let docs = [];
  try {
    docs = await Vehicle.find(q).lean();
  } catch (_) {
    docs = [];
  }

  // अगर किसी ख़ास गाड़ी की बात है तो पहले उसी को देखो, फिर बाक़ी brand को
  let scoped = docs;
  if (vehicleName) {
    const needle = String(vehicleName).toLowerCase();
    const hit = docs.filter((v) => String(v.name || "").toLowerCase().includes(needle) || needle.includes(String(v.name || "").toLowerCase()));
    if (hit.length) scoped = hit;
  }

  const allowed = new Set();
  const allowedPct = new Set();
  const MONEY_FIELDS = ["exShowroom", "onRoad", "downPayment", "emi", "cashback", "exchangeBonus"];

  for (const v of scoped) {
    for (const f of MONEY_FIELDS) extractAmounts(v[f]).forEach((n) => allowed.add(n));
    extractPercents(v.roi).forEach((n) => allowedPct.add(n));
    // offerNote में भी कभी-कभी रक़म होती है
    extractAmounts(v.offerNote).forEach((n) => allowed.add(n));
  }

  // user ने ख़ुद जो बताया वह भी सच्चाई है — मालिक अपनी दुकान का ऑफ़र जानता है
  extractAmounts(userSaid).forEach((n) => allowed.add(n));
  extractPercents(userSaid).forEach((n) => allowedPct.add(n));

  // brand का फ़ोन नंबर कभी-कभी ₹ के पास आ जाता है — उसे छोड़ दो
  const phone = String((BRANDS[brandId] || {}).phone || "").replace(/\D/g, "");
  if (phone) allowed.add(parseInt(phone.slice(-10), 10));

  const unknown = [];
  const checked = [];

  for (const n of found) {
    if (allowed.has(n)) checked.push({ amount: n, ok: true });
    else {
      checked.push({ amount: n, ok: false });
      unknown.push(`₹${n.toLocaleString("en-IN")}`);
    }
  }
  for (const p of foundPct) {
    if (allowedPct.has(p)) checked.push({ percent: p, ok: true });
    else {
      checked.push({ percent: p, ok: false });
      unknown.push(`${p}%`);
    }
  }

  if (!scoped.length && (found.length || foundPct.length)) {
    return {
      verdict: "fail",
      checked,
      unknown,
      allowed: [],
      hint: `${vehicleName ? `"${vehicleName}" की` : "इस brand की"} जानकारी Vehicles में नहीं है — पहले क़ीमत/EMI भरें, तभी सही poster बनेगा`,
    };
  }

  if (unknown.length) {
    return {
      verdict: "fail",
      checked,
      unknown,
      allowed: [...allowed],
      hint: `यह अंक database में नहीं मिले: ${unknown.join(", ")} — या तो Vehicles में सुधारें, या command में ख़ुद बताएँ`,
    };
  }

  return { verdict: "pass", checked, unknown: [], allowed: [...allowed], hint: "सारी क़ीमतें database से मिलीं" };
}

// ══════════════════════════════════════════════════════════════════════════
//  माउंट
// ══════════════════════════════════════════════════════════════════════════
module.exports = function mountOrchestrator(app, deps) {
  const {
    log,
    BRANDS,
    TYPES,
    TYPE_LABEL,
    Content,
    Vehicle,
    parseCommandIntent,
    vehicleContext,
    generateText,
    generateImages,
    cleanAIText,
    adaptToPlatforms,
    qualityCheckContent,
    makeVoiceScript,
    getAutomationSettings,
    checkAndCountUsage,
    activity,
    notify,
    safePublish,
    Delivery,
    Lead,
    Notification,
    ScheduledCommand,
    FESTIVALS,
  } = deps;

  const L = (lvl, m, x) => {
    try {
      log(lvl, m, x);
    } catch (_) {}
  };

  // ── क़दमों की सूची ───────────────────────────────────────────────────
  const STEP_PLAN = [
    { key: "understand", label: "आपकी बात समझी" },
    { key: "truthload", label: "गाड़ी की असली जानकारी उठाई" },
    { key: "write", label: "post का text लिखा" },
    { key: "verify", label: "क़ीमत database से मिलाई" },
    { key: "poster", label: "poster बनाया" },
    { key: "quality", label: "ग़लती की जाँच" },
    { key: "captions", label: "हर platform का caption" },
    { key: "voice", label: "voice script" },
    { key: "finish", label: "Review में भेजा" },
  ];
  function freshSteps() {
    return STEP_PLAN.map((s) => ({ key: s.key, label: s.label, status: "wait", detail: "", at: null }));
  }

  async function mark(camp, key, status, detail) {
    try {
      const st = camp.steps.find((s) => s.key === key);
      if (st) {
        st.status = status;
        if (detail !== undefined) st.detail = String(detail || "").slice(0, 300);
        st.at = new Date();
      }
      camp.markModified("steps");
      await camp.save();
    } catch (e) {
      L("WARN", "[CAMPAIGN] step save fail", { msg: e.message });
    }
  }

  async function stop(camp, reason, status = "blocked") {
    camp.status = status;
    camp.stopReason = reason;
    camp.finishedAt = new Date();
    for (const s of camp.steps) if (s.status === "wait") s.status = "skip";
    camp.markModified("steps");
    await camp.save();
    L("WARN", "[CAMPAIGN] रुका", { id: String(camp._id), reason });
    return camp;
  }

  // ══════════════════════════════════════════════════════════════════════
  //  मुख्य पाइपलाइन
  // ══════════════════════════════════════════════════════════════════════
  async function runPipeline(campId, req) {
    const camp = await Campaign.findById(campId);
    if (!camp) return;

    try {
      const brandId = camp.brand;
      const auto = await getAutomationSettings(brandId).catch(() => ({ mode: "safe" }));
      camp.mode = auto.mode || "safe";
      await camp.save();

      // ── 1. समझो ────────────────────────────────────────────────────
      await mark(camp, "understand", "run");
      let intent = camp.intent;
      if (!intent && camp.command) {
        intent = await parseCommandIntent(camp.command, brandId);
        camp.intent = intent;
      }
      intent = intent || {};
      if (intent.error) return await stop(camp, "AI आपकी बात समझ नहीं पाया — थोड़ा और साफ़ लिखकर देखें");

      camp.type = TYPES.includes(intent.type) ? intent.type : camp.type || "vigyapan";
      camp.vehicle = intent.vehicle || camp.vehicle || "";
      camp.offerDetails = intent.offer_details || camp.offerDetails || "";
      await camp.save();
      await mark(camp, "understand", "ok", intent.summary_hindi || `${TYPE_LABEL[camp.type] || camp.type} बनाना है`);

      // ── 2. सच्चाई उठाओ ─────────────────────────────────────────────
      await mark(camp, "truthload", "run");
      // ⚠️ AI कभी-कभी "Honda Two Wheeler" जैसा दुकान का नाम गाड़ी समझकर लौटा
      //    देता है। वह Vehicles की सूची में कभी नहीं मिलेगा, इसलिए ऐसे नाम को
      //    यहीं हटा दो — वरना बधाई वाली post भी रुक जाती है।
      if (camp.vehicle && isBrandNameNotVehicle(deps, brandId, camp.vehicle)) {
        log("INFO", "[TRUTH] दुकान का नाम गाड़ी समझा गया था, हटाया", { था: camp.vehicle });
        camp.vehicle = "";
        await camp.save();
      }

      // ⚠️ पहले नियम यह था: विज्ञापन/गिफ़्ट हो, या कोई गाड़ी का नाम आ जाए, तो
      //    क़ीमत ज़रूरी। इसी वजह से गणेश चतुर्थी की बधाई भी रुक गई — उसमें
      //    क़ीमत थी ही नहीं, बस AI ने एक "गाड़ी का नाम" निकाल दिया था।
      //
      //    अब क़ीमत सिर्फ़ वहीं ज़रूरी है जहाँ post का काम ही क़ीमत बताना है —
      //    यानी विज्ञापन और गिफ़्ट। त्यौहार, सुविचार, सूचना में नहीं।
      const needsMoney = camp.type === "vigyapan" || camp.type === "gift";
      let vCtx = null;
      if (needsMoney || camp.vehicle) {
        vCtx = await vehicleContext(brandId, camp.vehicle || undefined);
        if (!vCtx && needsMoney) {
          // सिर्फ़ विज्ञापन/गिफ़्ट में ही रोको — यहाँ क़ीमत के बिना post बेमानी है
          await mark(camp, "truthload", "fail", "Vehicles में जानकारी नहीं मिली");
          return await stop(
            camp,
            camp.vehicle
              ? `"${camp.vehicle}" की क़ीमत/EMI database में नहीं है। सेटिंग → गाड़ियाँ में पहले जोड़ें — तभी सही poster बनेगा।`
              : "इस brand की किसी गाड़ी की जानकारी नहीं है। सेटिंग → गाड़ियाँ में क़ीमत/EMI भरें।"
          );
        }
        if (vCtx) await mark(camp, "truthload", "ok", vCtx.split("\n")[0]);
        else await mark(camp, "truthload", "skip", "इस post में क़ीमत नहीं लगती — बिना दाम के बनेगी");
      } else {
        await mark(camp, "truthload", "skip", "इस तरह की post में क़ीमत नहीं लगती");
      }

      // ── 3. text लिखो ───────────────────────────────────────────────
      await mark(camp, "write", "run");
      const lim = await checkAndCountUsage(brandId, "aiCalls").catch(() => ({ ok: true }));
      if (!lim.ok) return await stop(camp, lim.message || "आज की AI सीमा पूरी हो गई");

      let text;
      if (intent.custom_text && String(intent.custom_text).trim()) {
        text = cleanAIText(String(intent.custom_text).trim());
      } else {
        const extraCtx = [
          camp.vehicle && `Vehicle: ${camp.vehicle}`,
          vCtx && `Database से असली जानकारी (सिर्फ़ यही use करो, अपने-आप कोई number मत बनाओ):\n${vCtx}`,
          camp.offerDetails && `User ने बताया: ${camp.offerDetails}`,
        ]
          .filter(Boolean)
          .join("\n");
        text = await generateText(brandId, camp.type, undefined, extraCtx || undefined);
      }
      if (!text || !String(text).trim()) return await stop(camp, "text नहीं बन पाया — दोबारा कोशिश करें");
      camp.assets = camp.assets || {};
      camp.assets.text = text;
      camp.markModified("assets");
      await camp.save();
      await mark(camp, "write", "ok", String(text).slice(0, 90));

      // ── 4. सच्चाई मिलाओ (एक बार सुधार का मौक़ा) ──────────────────────
      await mark(camp, "verify", "run");
      const userSaid = [camp.command, camp.offerDetails].filter(Boolean).join(" ");
      let truth = await verifyAgainstTruth(deps, brandId, text, camp.vehicle, userSaid);

      if (truth.verdict === "fail" && !intent.custom_text) {
        // AI ने कोई अंक ख़ुद बना लिया — एक बार सख़्ती से दोबारा लिखवाओ
        L("WARN", "[TRUTH] पहली बार fail, दोबारा लिखवा रहे हैं", { id: String(camp._id), unknown: truth.unknown });
        const strict = [
          camp.vehicle && `Vehicle: ${camp.vehicle}`,
          vCtx && `⚠️ सिर्फ़ और सिर्फ़ नीचे दिए गए अंक इस्तेमाल करो। इनके अलावा कोई भी रक़म, EMI, डाउन पेमेंट या प्रतिशत मत लिखो:\n${vCtx}`,
          camp.offerDetails && `User ने बताया: ${camp.offerDetails}`,
          `पिछली बार तुमने ये अंक ख़ुद बना लिए थे — ये बिल्कुल मत लिखना: ${truth.unknown.join(", ")}`,
        ]
          .filter(Boolean)
          .join("\n");
        try {
          const retry = await generateText(brandId, camp.type, undefined, strict);
          if (retry && String(retry).trim()) {
            const t2 = await verifyAgainstTruth(deps, brandId, retry, camp.vehicle, userSaid);
            if (t2.verdict === "pass") {
              text = retry;
              truth = t2;
              camp.assets.text = text;
              camp.markModified("assets");
              await camp.save();
            }
          }
        } catch (_) {}
      }

      camp.truth = truth;
      camp.markModified("truth");
      await camp.save();

      if (truth.verdict === "fail") {
        await mark(camp, "verify", "fail", truth.hint);
        return await stop(
          camp,
          `ग़लत क़ीमत रोक दी गई — ${truth.hint}। यह post बाहर नहीं गई।`
        );
      }
      await mark(camp, "verify", "ok", truth.hint);

      // ── 4b. समय तय हुआ है? तो अभी मत बनाओ — रख लो ─────────────────
      //  ⚠️ text और क़ीमत अभी जाँच ली गई है, इसलिए तय समय पर जो बनेगा वह
      //     पक्का सही होगा. server का हर 5 मिनट वाला cron उसे उठा लेगा.
      const sch = intent.schedule || {};
      const when = sch.when || "now";
      const isLater = when !== "now" && !(when === "today" && !sch.time);

      if (isLater && ScheduledCommand) {
        let dateStr = sch.date || null;
        if (when === "tomorrow" && !dateStr) {
          const t = new Date();
          t.setDate(t.getDate() + 1);
          dateStr = t.toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
        }
        if (when === "today" && !dateStr) {
          dateStr = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
        }
        const timeStr = sch.time || "09:00";

        const sc = await ScheduledCommand.create({
          brand: brandId,
          type: camp.type,
          text,
          vehicle: camp.vehicle || "",
          offerDetails: camp.offerDetails || "",
          scheduleWhen: dateStr ? "specific_date" : when,
          scheduleDate: dateStr,
          scheduleTime: timeStr,
          recurring: sch.recurring || null,
          status: "scheduled",
        });

        camp.status = "scheduled";
        camp.scheduledFor = dateStr ? new Date(`${dateStr}T${timeStr}:00+05:30`) : null;
        camp.finishedAt = new Date();

        const kab = sch.recurring === "daily" ? `हर दिन ${timeStr} बजे`
          : sch.recurring === "weekly" ? `हर हफ़्ते ${timeStr} बजे`
          : `${dateStr || "तय दिन"} को ${timeStr} बजे`;

        for (const k of ["poster", "quality", "captions", "voice"]) await mark(camp, k, "skip", "तय समय पर बनेगा");
        await mark(camp, "finish", "ok", `${kab} अपने आप बनकर Review में आ जाएगा`);
        camp.stopReason = "";
        await camp.save();

        try {
          await activity(brandId, "schedule", "success", `${kab} के लिए तय किया`, { detail: String(text).slice(0, 120) });
        } catch (_) {}

        L("INFO", "[CAMPAIGN] scheduled", { id: String(camp._id), scId: String(sc._id), kab });
        return camp;
      }

      // ── 5. poster बनाओ ─────────────────────────────────────────────
      await mark(camp, "poster", "run");
      const doc = await Content.create({
        brand: brandId,
        type: camp.type,
        text,
        status: "pending",
      });
      camp.contentId = doc._id;
      await camp.save();

      try {
        const imgs = await generateImages(brandId, doc._id, text, camp.type, {});
        const b64 = imgs._b64 || {};
        delete imgs._b64;
        doc.images = imgs;
        if (b64.square) doc.imageData = { square: b64.square, story: b64.story };
        await doc.save();
        camp.assets.poster = imgs.square || "";
        camp.assets.story = imgs.story || "";
        camp.assets.landscape = imgs.landscape || "";
        camp.markModified("assets");
        await camp.save();
        await mark(camp, "poster", "ok", "poster तैयार");
      } catch (e) {
        await mark(camp, "poster", "warn", "poster नहीं बना — text तैयार है");
        L("ERROR", "[CAMPAIGN] poster fail", { msg: e.message });
      }

      // ── 6. quality check ──────────────────────────────────────────
      await mark(camp, "quality", "run");
      try {
        const q = await qualityCheckContent(brandId, text, camp.type, doc.imageData?.square);
        if (q && !q.error) {
          // AI ने सुधरा हुआ text दिया हो तो उसे भी सच्चाई से मिलाओ — बिना जाँचे मत लो
          if (q.fixedText && String(q.fixedText).trim() && q.verdict !== "pass") {
            const tf = await verifyAgainstTruth(deps, brandId, q.fixedText, camp.vehicle, userSaid);
            if (tf.verdict === "pass") {
              doc.text = cleanAIText(String(q.fixedText).trim());
              await doc.save();
              camp.assets.text = doc.text;
              camp.truth = tf;
              camp.markModified("assets");
              camp.markModified("truth");
              await camp.save();
            }
          }
          camp.quality = { verdict: q.verdict, score: q.score, issues: q.issues || [], summary: q.summary_hindi };
          camp.markModified("quality");
          await camp.save();

          const high = (q.issues || []).filter((i) => i.severity === "high");
          if (q.verdict === "fail" || high.length) {
            await mark(camp, "quality", "fail", (high[0] && high[0].issue_hindi) || q.summary_hindi);
            return await stop(camp, `जाँच में गड़बड़ मिली — ${(high[0] && high[0].issue_hindi) || q.summary_hindi || "post ठीक नहीं है"}। Review में सुधार लें।`, "review");
          }
          await mark(camp, "quality", q.verdict === "warn" ? "warn" : "ok", q.summary_hindi || `स्कोर ${q.score}`);
        } else {
          await mark(camp, "quality", "skip", "जाँच नहीं हो पाई");
        }
      } catch (e) {
        await mark(camp, "quality", "skip", "जाँच नहीं हो पाई");
        L("WARN", "[CAMPAIGN] quality skip", { msg: e.message });
      }

      // ── 7. हर platform का caption ─────────────────────────────────
      await mark(camp, "captions", "run");
      try {
        const ad = await adaptToPlatforms(brandId, doc.text, ["whatsapp", "instagram", "facebook", "youtube", "status"], camp.offerDetails);
        if (ad && !ad.error) {
          camp.assets.captions = ad;
          camp.markModified("assets");
          await camp.save();
          await mark(camp, "captions", "ok", "WhatsApp, Instagram, Facebook, YouTube — सबके अलग caption");
        } else {
          await mark(camp, "captions", "skip", "caption नहीं बने — मूल text हर जगह चलेगा");
        }
      } catch (e) {
        await mark(camp, "captions", "skip", "caption नहीं बने");
      }

      // ── 8. voice script ───────────────────────────────────────────
      await mark(camp, "voice", "run");
      try {
        const vs = await makeVoiceScript(brandId, doc.text, "friendly", 20);
        const script = typeof vs === "string" ? vs : vs && (vs.script || vs.text);
        if (script) {
          camp.assets.voiceScript = String(script).slice(0, 1500);
          camp.markModified("assets");
          await camp.save();
          await mark(camp, "voice", "ok", "बोलने लायक़ script तैयार");
        } else {
          await mark(camp, "voice", "skip", "");
        }
      } catch (_) {
        await mark(camp, "voice", "skip", "");
      }

      // ── 9. mode के हिसाब से आगे ───────────────────────────────────
      await mark(camp, "finish", "run");

      const qOk = !camp.quality || camp.quality.verdict === "pass";
      const canAuto = camp.mode === "full" || (camp.mode === "semi" && qOk);

      if (canAuto && typeof safePublish === "function") {
        try {
          await safePublish(Content, doc._id, req);
          camp.status = "published";
          await mark(camp, "finish", "ok", "अपने आप भेज दी गई");
        } catch (e) {
          camp.status = "review";
          await mark(camp, "finish", "warn", "भेजी नहीं जा सकी — Review में है");
        }
      } else {
        camp.status = "review";
        await mark(camp, "finish", "ok", "आपकी हाँ का इंतज़ार — Review में है");
      }

      camp.finishedAt = new Date();
      await camp.save();

      try {
        await activity(brandId, "campaign", "success", `Campaign पूरा: ${TYPE_LABEL[camp.type] || camp.type}${camp.vehicle ? " — " + camp.vehicle : ""}`, {
          contentId: doc._id,
          detail: String(doc.text).slice(0, 120),
        });
      } catch (_) {}

      try {
        if (camp.status === "review") await notify("content_ready", `नया ${TYPE_LABEL[camp.type] || "content"} तैयार — देख लीजिए`, brandId);
      } catch (_) {}

      return camp;
    } catch (e) {
      L("ERROR", "[CAMPAIGN] crash", { id: String(campId), msg: e.message });
      try {
        const c = await Campaign.findById(campId);
        if (c) await stop(c, "कुछ गड़बड़ हुई: " + e.message, "failed");
      } catch (_) {}
    }
  }

  // ══════════════════════════════════════════════════════════════════════
  //  ROUTES
  // ══════════════════════════════════════════════════════════════════════

  /** एक command → पूरा campaign. तुरन्त campaign id लौटाता है, काम पीछे चलता है। */
  app.post("/api/campaign/run", async (req, res) => {
    try {
      const { brand, command, type, vehicle, offerDetails, source } = req.body || {};
      if (!BRANDS[brand]) return res.status(400).json({ error: "brand चुनना ज़रूरी है" });
      if (!command && !type) return res.status(400).json({ error: "क्या बनाना है — बोलिए या लिखिए" });

      const camp = await Campaign.create({
        brand,
        command: command || "",
        source: source || "text",
        type: TYPES.includes(type) ? type : "vigyapan",
        vehicle: vehicle || "",
        offerDetails: offerDetails || "",
        status: "running",
        steps: freshSteps(),
        createdBy: (req.user && (req.user.name || req.user.id)) || "",
      });

      // पीछे चलने दो — user को इंतज़ार न कराओ
      setImmediate(() => runPipeline(camp._id, req).catch(() => {}));

      res.json({ ok: true, campaignId: camp._id, message: "काम शुरू — नीचे हर क़दम दिखता रहेगा" });
    } catch (e) {
      L("ERROR", "/campaign/run", { msg: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  /** एक campaign की हालत — frontend इसी को poll करता है */
  app.get("/api/campaign/:id", async (req, res) => {
    try {
      const c = await Campaign.findById(req.params.id).lean();
      if (!c) return res.status(404).json({ error: "campaign नहीं मिला" });
      let content = null;
      if (c.contentId) {
        content = await Content.findById(c.contentId).select("-imageData").lean();
      }
      res.json({ ...c, content });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /** पिछले campaigns */
  app.get("/api/campaign", async (req, res) => {
    try {
      const q = {};
      if (req.query.brand) q.brand = req.query.brand;
      if (req.query.status) q.status = req.query.status;
      const docs = await Campaign.find(q).sort({ createdAt: -1 }).limit(Math.min(parseInt(req.query.limit) || 20, 50)).select("-intent -truth").lean();
      res.json(docs);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /** campaign रद्द करो — उसका content भी reject */
  app.post("/api/campaign/:id/cancel", async (req, res) => {
    try {
      const c = await Campaign.findById(req.params.id);
      if (!c) return res.status(404).json({ error: "campaign नहीं मिला" });
      if (c.contentId) await Content.findByIdAndUpdate(c.contentId, { status: "rejected" }).catch(() => {});
      c.status = "failed";
      c.stopReason = "आपने रद्द किया";
      c.finishedAt = new Date();
      await c.save();
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * ⚠️ अटकी हुई सारी posts एक साथ साफ़ करो।
   *    पुराने नियम की वजह से बधाई/सूचना वाली posts भी "रोक दी गई" में फँस
   *    गई थीं — दर्जनों। उन्हें एक-एक करके हटाना बेकार की मेहनत है।
   *    यह उन्हीं को हटाता है जो अब नए नियम से रुकती ही नहीं।
   *    असली ग़लत क़ीमत वाली posts जहाँ हैं वहीं रहेंगी।
   */
  app.post("/api/campaign/clear-blocked", async (req, res) => {
    try {
      const q = { status: "blocked" };
      if (BRANDS[req.body?.brand]) q.brand = req.body.brand;

      const list = await Campaign.find(q).limit(500);
      let hataye = 0, rakhe = 0;

      for (const c of list) {
        const daamWali = c.type === "vigyapan" || c.type === "gift";
        // दुकान का नाम गाड़ी समझा गया था? तो यह ग़लत रुकी थी
        const naamKiGalti = c.vehicle && isBrandNameNotVehicle(deps, c.brand, c.vehicle);

        if (!daamWali || naamKiGalti) {
          if (c.contentId) await Content.findByIdAndUpdate(c.contentId, { status: "rejected" }).catch(() => {});
          await c.deleteOne();
          hataye++;
        } else {
          rakhe++;   // सचमुच क़ीमत की गड़बड़ी — यह रहने दो
        }
      }

      L("INFO", "[CAMPAIGN] अटकी posts साफ़ कीं", { hataye, rakhe });
      res.json({
        ok: true, hataye, rakhe,
        message: hataye
          ? `${hataye} posts हटा दीं जो पुराने नियम की वजह से ग़लत रुकी थीं।` +
            (rakhe ? ` ${rakhe} अब भी रुकी हैं — उनमें सचमुच क़ीमत की गड़बड़ी है।` : "")
          : "हटाने लायक़ कोई नहीं मिली।",
      });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /** सिर्फ़ सच्चाई जाँचो — किसी भी text पर, बिना कुछ बनाए */
  app.post("/api/truth/verify", async (req, res) => {
    try {
      const { brand, text, vehicle, userSaid } = req.body || {};
      if (!BRANDS[brand]) return res.status(400).json({ error: "brand चाहिए" });
      if (!text) return res.status(400).json({ error: "text चाहिए" });
      const out = await verifyAgainstTruth(deps, brand, text, vehicle, userSaid);
      res.json(out);
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  /**
   * ⭐ एक ही request में आज का पूरा हाल।
   *
   * पहले Today.jsx 5 request भेजता था और App.jsx 2 और — कुल 7, जिनमें 2
   * दोहरी थीं। अब एक। Render का समय भी बचेगा और app भी तेज़ खुलेगा।
   */
  app.get("/api/today", async (req, res) => {
    try {
      const brand = req.query.brand;
      if (!BRANDS[brand]) return res.status(400).json({ error: "brand चाहिए" });

      const since = new Date(Date.now() - 3 * 86400000);
      const todayIST = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
      const dayStart = new Date(`${todayIST}T00:00:00+05:30`);

      const [pendingContent, pendingDeliv, newLeads, notifs, liveCamps, recentCamps, sentToday, failedToday, schedCount] =
        await Promise.all([
          Content.find({ brand, status: "pending" }).select("-imageData").sort({ createdAt: -1 }).limit(30).lean().catch(() => []),
          Delivery ? Delivery.find({ brand, status: "pending" }).select("-imageData").sort({ createdAt: -1 }).limit(20).lean().catch(() => []) : [],
          Lead ? Lead.find({ brand, status: "new" }).sort({ createdAt: -1 }).limit(20).lean().catch(() => []) : [],
          Notification ? Notification.find({}).sort({ createdAt: -1 }).limit(20).lean().catch(() => []) : [],
          Campaign.find({ brand, status: "running" }).sort({ createdAt: -1 }).limit(5).select("-intent -truth").lean().catch(() => []),
          Campaign.find({ brand, createdAt: { $gte: since } }).sort({ createdAt: -1 }).limit(10).select("-intent -assets").lean().catch(() => []),
          Content.countDocuments({ brand, status: "sent", sentAt: { $gte: dayStart } }).catch(() => 0),
          Content.countDocuments({ brand, status: "failed", createdAt: { $gte: dayStart } }).catch(() => 0),
          ScheduledCommand ? ScheduledCommand.countDocuments({ brand, status: "scheduled" }).catch(() => 0) : 0,
        ]);

      const blocked = recentCamps.filter((c) => c.status === "blocked");
      const unread = (notifs || []).filter((n) => !n.read).length;

      // ── आने वाला त्यौहार ──────────────────────────────────────
      let festival = null;
      try {
        const list = FESTIVALS || [];
        const up = list.filter((f) => f.date >= todayIST).sort((a, b) => a.date.localeCompare(b.date))[0];
        if (up) {
          festival = {
            name: up.name,
            date: up.date,
            daysAway: Math.round((new Date(up.date) - new Date(todayIST)) / 864e5),
          };
        }
      } catch (_) {}

      // ── अगले 14 दिन में कौन-सा दिन ख़ाली है ────────────────────
      let emptyDays = [];
      try {
        const SP = mongoose.models.ScheduledPost;
        const to = new Date(Date.now() + 14 * 864e5);
        const busy = new Set();
        if (SP) {
          const rows = await SP.find({ brand, status: { $in: ["waiting", "running"] }, runAt: { $gte: new Date(), $lte: to } })
            .select("runAt")
            .lean();
          rows.forEach((r) => busy.add(new Date(r.runAt).toISOString().slice(0, 10)));
        }
        for (let d = new Date(); d <= to; d = new Date(d.getTime() + 864e5)) {
          const k = d.toISOString().slice(0, 10);
          if (!busy.has(k)) emptyDays.push(k);
        }
        emptyDays = emptyDays.slice(0, 14);
      } catch (_) {}

      res.json({
        brand,
        today: todayIST,
        counts: {
          pending: pendingContent.length,
          deliveries: pendingDeliv.length,
          leads: newLeads.length,
          unread,
          running: liveCamps.length,
          sentToday,
          failedToday,
          scheduled: schedCount,
          blocked: blocked.length,
        },
        pending: pendingContent,
        deliveries: pendingDeliv,
        leads: newLeads,
        notifications: notifs || [],
        running: liveCamps,
        campaigns: recentCamps,
        festival,
        emptyDays,
        // कोई post ग़लत क़ीमत की वजह से रुकी हो तो सबसे ऊपर दिखे
        blocked: blocked.map((c) => ({
          _id: c._id,
          reason: c.stopReason,
          vehicle: c.vehicle,
          command: c.command,
          unknown: (c.truth && c.truth.unknown) || [],
          at: c.createdAt,
        })),
      });
    } catch (e) {
      L("ERROR", "/api/today", { msg: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  L("INFO", "[ORCHESTRATOR] campaign + truth + today routes चालू");

  return { Campaign, verifyAgainstTruth, runPipeline };
};

// जाँच के लिए बाहर भी उपलब्ध
module.exports.Campaign = Campaign;
module.exports.extractAmounts = extractAmounts;
module.exports.verifyAgainstTruth = verifyAgainstTruth;
