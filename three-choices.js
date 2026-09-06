// ============================================================================
//  three-choices.js — एक बात, तीन अलग poster, आप चुनिए   (v1.0)
//  ---------------------------------------------------------------------------
//  server.js के नीचे, one-in-many-out से पहले:
//
//      try {
//        require("./three-choices.js")(app, {
//          log, BRANDS, Content, mongoose, requireRole, PUBLIC_URL, OUT_DIR,
//          generateText, cleanAIText, generateImages, parseCommandIntent,
//        });
//      } catch (e) {
//        log("ERROR", "three-choices चालू नहीं हुआ", { msg: e.message });
//      }
//
//  ---------------------------------------------------------------------------
//  ⚠️ यह क्यों
//
//  अभी एक ही poster बनता है। पसंद न आए तो दोबारा बनवाइए — फिर इंतज़ार,
//  फिर शायद वही बात। और AI तस्वीर वाले हिस्से में हर बार पैसे भी लगते हैं।
//
//  ✅ अब तीनों एक साथ बनते हैं, तीन अलग लहजों में:
//        1. धमाकेदार    — ऑफ़र और सेल के लिए
//        2. भरोसे वाला  — शांत, professional
//        3. अपनापन      — त्यौहार, बधाई, delivery
//
//     आप एक चुनिए → बाक़ी दो अपने आप हट जाएँगे (disk और database दोनों से)
//     → चुना हुआ Review में चला जाएगा।
//
//  ⚠️ लहजे server.js में पहले से थे (styleV), पर हर बार एक ही अपने आप चुना
//     जाता था। यहाँ तीनों जान-बूझकर अलग-अलग चुने जाते हैं।
// ============================================================================

"use strict";

const fs = require("fs");
const path = require("path");

module.exports = function mountThreeChoices(app, deps) {
  const {
    BRANDS = {}, Content, mongoose, requireRole, PUBLIC_URL = "", OUT_DIR,
    generateText, cleanAIText, generateImages, parseCommandIntent,
  } = deps;

  const log = deps.log || ((l, m, x) => console.log(`[${l}] ${m}`, x || ""));
  const L = (m, x) => log("INFO", "[3choice] " + m, x);
  const bad = (res, e, c = 500) => res.status(c).json({ error: e.message || String(e) });

  // ══════════════════════════════════════════════════════════════════════════
  //  तीन लहजे — जान-बूझकर अलग-अलग
  // ══════════════════════════════════════════════════════════════════════════
  const TONES = [
    {
      id: "dhamaka", label: "🔥 धमाकेदार", desc: "ऑफ़र और सेल के लिए",
      hint: "धमाकेदार और exciting लहजे में लिखो। जोश भरा, थोड़ी जल्दबाज़ी का एहसास, " +
            "छोटे-छोटे वाक्य। ऐसे जैसे बाज़ार में आवाज़ लगाई जा रही हो।",
    },
    {
      id: "bharosa", label: "🛡️ भरोसे वाला", desc: "शांत और professional",
      hint: "शांत, भरोसेमंद और professional लहजे में लिखो। बड़बोलापन नहीं, " +
            "साफ़ जानकारी। ऐसे जैसे कोई पुराना दुकानदार समझा रहा हो।",
    },
    {
      id: "apnapan", label: "❤️ अपनापन", desc: "त्यौहार, बधाई, delivery",
      hint: "गर्मजोशी और अपनेपन के लहजे में लिखो। परिवार जैसा, भावुक, " +
            "शुभकामना वाला। ऐसे जैसे अपने किसी के लिए लिख रहे हों।",
    },
  ];

  // ══════════════════════════════════════════════════════════════════════════
  //  रिकॉर्ड
  // ══════════════════════════════════════════════════════════════════════════
  const Choice = mongoose.models.ThreeChoice || mongoose.model("ThreeChoice",
    new mongoose.Schema({
      brand: { type: String, index: true },
      command: String,
      type: String,
      vehicle: String,
      options: [{
        tone: String,
        label: String,
        text: String,
        images: { square: String, story: String, landscape: String },
        status: { type: String, default: "building" },  // building|ready|failed
        note: String,
      }],
      chosen: String,                    // कौन-सा चुना
      contentId: { type: mongoose.Schema.Types.ObjectId },
      status: { type: String, default: "building" },
      createdBy: String,
    }, { timestamps: true }));

  // disk से file हटाओ — बाक़ी दो के poster बेकार जगह न घेरें
  function mitao(urls) {
    for (const u of urls) {
      if (!u || !u.startsWith("/generated/")) continue;
      try { fs.unlinkSync(path.join(OUT_DIR, path.basename(u))); } catch (_) {}
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  तीनों बनाओ
  // ══════════════════════════════════════════════════════════════════════════
  async function build(ch) {
    for (let i = 0; i < TONES.length; i++) {
      const t = TONES[i];
      const opt = ch.options[i];
      try {
        // ⚠️ हर version का अपना लहजा — यही असली फ़र्क़ है
        let text = await generateText(
          ch.brand, ch.type || "vigyapan", null,
          `${ch.command}\n\n【लहजा】 ${t.hint}`
        );
        if (cleanAIText) text = cleanAIText(text);

        const imgs = await generateImages(ch.brand, `${ch._id}_${t.id}`, text, ch.type || "vigyapan", {
          autoSeed: `${ch._id}-${t.id}`,   // हर version का design भी अलग
        });

        opt.text = text;
        opt.images = { square: imgs.square, story: imgs.story, landscape: imgs.landscape };
        opt.status = "ready";
      } catch (e) {
        opt.status = "failed";
        opt.note = e.message;
        log("WARN", "[3choice] एक version नहीं बना", { tone: t.id, msg: e.message });
      }
      ch.markModified("options");
      await ch.save();     // एक-एक करके सेव — पर्दे पर आते जाएँ
    }

    ch.status = ch.options.some((o) => o.status === "ready") ? "ready" : "failed";
    await ch.save();
    return ch;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  ROUTES
  // ══════════════════════════════════════════════════════════════════════════

  /** तीन बनाओ */
  app.post("/api/three/make", requireRole("super-admin", "admin", "manager"), async (req, res) => {
    try {
      const command = String(req.body?.command || "").trim();
      if (!command) return bad(res, new Error("कुछ कहा ही नहीं"), 400);

      let intent = {};
      try { intent = (await parseCommandIntent(command, req.body.brand)) || {}; } catch (_) {}
      const brand = BRANDS[intent.brand] ? intent.brand
        : (BRANDS[req.body.brand] ? req.body.brand : Object.keys(BRANDS)[0]);

      const ch = await Choice.create({
        brand, command,
        type: intent.type || "vigyapan",
        vehicle: intent.vehicle || "",
        options: TONES.map((t) => ({ tone: t.id, label: t.label, status: "building" })),
        createdBy: req.user?.email,
      });

      // पहले जवाब, बनाना पीछे चलता रहे
      res.json({
        ok: true, id: ch._id, brand, type: ch.type,
        tones: TONES.map((t) => ({ id: t.id, label: t.label, desc: t.desc })),
        message: "तीनों बन रहे हैं… 40–60 सेकंड। एक-एक करके नीचे आते जाएँगे।",
      });

      build(ch).catch((e) => {
        log("ERROR", "[3choice] build fail", { msg: e.message });
        Choice.updateOne({ _id: ch._id }, { status: "failed" }).catch(() => {});
      });
    } catch (e) { bad(res, e); }
  });

  /** कहाँ तक पहुँचा */
  app.get("/api/three/:id", async (req, res) => {
    try {
      const c = await Choice.findById(req.params.id).lean();
      if (!c) return bad(res, new Error("नहीं मिला"), 404);
      res.json({
        ...c,
        options: (c.options || []).map((o) => ({
          ...o,
          fullUrl: o.images?.square ? PUBLIC_URL + o.images.square : "",
          desc: (TONES.find((t) => t.id === o.tone) || {}).desc || "",
        })),
      });
    } catch (e) { bad(res, e); }
  });

  /** एक चुनिए — बाक़ी दो अपने आप हट जाएँगे */
  app.post("/api/three/:id/pick", requireRole("super-admin", "admin", "manager"), async (req, res) => {
    try {
      const tone = String(req.body?.tone || "");
      const c = await Choice.findById(req.params.id);
      if (!c) return bad(res, new Error("नहीं मिला"), 404);
      if (c.chosen) return bad(res, new Error("इसमें पहले ही चुन लिया गया है"), 400);

      const pick = (c.options || []).find((o) => o.tone === tone);
      if (!pick) return bad(res, new Error("यह version नहीं मिला"), 400);
      if (pick.status !== "ready") return bad(res, new Error("यह version अभी तैयार नहीं"), 400);

      // ── चुने हुए से Content बनाओ, Review में जाए ──
      const doc = await Content.create({
        brand: c.brand, type: c.type || "vigyapan",
        text: pick.text,
        imgUrl: pick.images?.square || "",
        images: {
          square: pick.images?.square || "",
          story: pick.images?.story || "",
          landscape: pick.images?.landscape || "",
        },
        status: "pending", triggeredBy: "three-choice",
      });

      // ── बाक़ी दो हटाओ — disk से भी, database से भी ──
      const bache = (c.options || []).filter((o) => o.tone !== tone);
      const files = [];
      for (const o of bache) {
        if (o.images) files.push(o.images.square, o.images.story, o.images.landscape);
      }
      mitao(files);

      c.chosen = tone;
      c.contentId = doc._id;
      c.options = (c.options || []).filter((o) => o.tone === tone);
      c.markModified("options");
      c.status = "picked";
      await c.save();

      L("चुना गया", { tone, hataye: bache.length, files: files.filter(Boolean).length });

      res.json({
        ok: true,
        contentId: doc._id,
        removed: bache.length,
        message: `✅ चुन लिया — बाक़ी ${bache.length} हटा दिए। अब 🏠 आज में जाकर भेज दीजिए।`,
      });
    } catch (e) { bad(res, e); }
  });

  /** तीनों रद्द — कोई पसंद नहीं आया */
  app.delete("/api/three/:id", requireRole("super-admin", "admin", "manager"), async (req, res) => {
    try {
      const c = await Choice.findById(req.params.id);
      if (!c) return res.json({ ok: true });
      const files = [];
      for (const o of c.options || []) {
        if (o.images) files.push(o.images.square, o.images.story, o.images.landscape);
      }
      mitao(files);
      await c.deleteOne();
      res.json({ ok: true, message: "तीनों हटा दिए" });
    } catch (e) { bad(res, e); }
  });

  L("तीन विकल्प चालू");
  return { Choice, TONES };
};
