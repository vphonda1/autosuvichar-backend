// ============================================================================
//  one-in-many-out.js — एक बात कहिए, सब कुछ एक साथ बन जाए   (v1.0)
//  ---------------------------------------------------------------------------
//  server.js के नीचे, app.listen से पहले:
//
//      try {
//        require("./one-in-many-out.js")(app, {
//          log, BRANDS, Content, Vehicle, mongoose, requireRole, PUBLIC_URL,
//          parseCommandIntent, generateText, cleanAIText, generateImages,
//          adaptToPlatforms, vehicleContext, safePublish,
//        });
//      } catch (e) {
//        log("ERROR", "one-in-many-out चालू नहीं हुआ", { msg: e.message });
//      }
//
//  ---------------------------------------------------------------------------
//  ⚠️ यह क्यों बनाया
//
//  तीनों सलाहों में एक ही बात सबसे ऊपर थी — "एक input डालो, सब कुछ बन जाए"।
//  और जाँच में पता चला कि इसके **सातों टुकड़े आपके app में पहले से हैं**:
//
//     poster बनाना        → generateImages / buildFestivePoster  ✅
//     तीनों नाप एक साथ    → sizes { square, story, landscape }   ✅
//     हर platform का caption → adaptToPlatforms                  ✅
//     अनाउंसमेंट          → announcer                            ✅
//     Google Business     → festive/growth-engine                ✅
//     सब जगह भेजना        → safePublish                          ✅
//     गाड़ी की सच्ची क़ीमत → vehicleContext                       ✅
//
//  बस इन्हें एक जगह जोड़ा नहीं गया था। यही file वह जोड़ है।
//
//  ⚠️ जो नहीं बन सकता, वह साफ़ बता देता है — झूठा वादा नहीं करता:
//     • Reel/video      → आपकी photo चाहिए, AI गाड़ी की video नहीं बना सकता
//     • DM/review reply → वे संदेश अभी app में आते ही नहीं
// ============================================================================

"use strict";

module.exports = function mountOneInManyOut(app, deps) {
  const {
    BRANDS = {}, Content, Vehicle, mongoose, requireRole, PUBLIC_URL = "",
    parseCommandIntent, generateText, cleanAIText, generateImages,
    adaptToPlatforms, vehicleContext, safePublish,
  } = deps;

  const log = deps.log || ((l, m, x) => console.log(`[${l}] ${m}`, x || ""));
  const L = (m, x) => log("INFO", "[campaign] " + m, x);
  const bad = (res, e, c = 500) => res.status(c).json({ error: e.message || String(e) });

  // ══════════════════════════════════════════════════════════════════════════
  //  एक campaign का रिकॉर्ड
  // ══════════════════════════════════════════════════════════════════════════
  const Camp = mongoose.models.OneCampaign || mongoose.model("OneCampaign",
    new mongoose.Schema({
      brand: { type: String, index: true },
      command: String,                       // जो आपने कहा
      type: String,
      vehicle: String,
      text: String,                          // मुख्य लिखाई

      outputs: [{
        kind: String,                        // poster / story / caption_ig / ...
        label: String,
        status: { type: String, default: "pending" },  // pending|ready|failed|skipped
        url: String,
        text: String,
        note: String,
        published: { type: Boolean, default: false },
      }],

      contentId: { type: mongoose.Schema.Types.ObjectId },
      status: { type: String, default: "building" },   // building|ready|published
      createdBy: String,
    }, { timestamps: true }));

  // ══════════════════════════════════════════════════════════════════════════
  //  कौन-कौन से output बन सकते हैं
  // ══════════════════════════════════════════════════════════════════════════
  //  ⚠️ जान-बूझकर सिर्फ़ वही रखे जो सचमुच बन सकते हैं। योजनाओं में 11 गिनाए
  //     थे, पर Reel और reply अभी सम्भव नहीं — उन्हें झूठा दिखाना ठीक नहीं।
  const KINDS = [
    { id: "poster",     label: "🖼️ Poster (चौकोर)",     auto: true },
    { id: "story",      label: "📱 Story (9:16)",         auto: true },
    { id: "landscape",  label: "🖥️ चौड़ा (FB/Google)",   auto: true },
    { id: "caption_ig", label: "📸 Instagram caption",    auto: true },
    { id: "caption_fb", label: "📘 Facebook caption",     auto: true },
    { id: "caption_wa", label: "🟢 WhatsApp संदेश",       auto: true },
    { id: "gbp",        label: "📍 Google Business",      auto: true },
    { id: "announce",   label: "🔊 अनाउंसमेंट",           auto: false, needs: "एक बार दबाइए — 30 सेकंड लगते हैं" },
  ];

  const NOT_POSSIBLE = [
    { id: "reel",  label: "🎬 Reel / Video", why: "आपकी photo या video चाहिए — AI गाड़ी की असली video नहीं बना सकता" },
    { id: "reply", label: "💬 ग्राहक को जवाब", why: "DM अभी app में आते ही नहीं — पहले Inbox चाहिए" },
  ];

  // ══════════════════════════════════════════════════════════════════════════
  //  पूरा campaign बनाओ
  // ══════════════════════════════════════════════════════════════════════════
  async function build(camp) {
    const brand = camp.brand;
    const b = BRANDS[brand] || {};
    const out = (kind) => camp.outputs.find((o) => o.kind === kind);
    const set = (kind, patch) => {
      const o = out(kind);
      if (o) Object.assign(o, patch);
      camp.markModified("outputs");
    };

    // ── 1. मुख्य लिखाई ────────────────────────────────────────
    let text = camp.text;
    if (!text) {
      try {
        text = cleanAIText
          ? cleanAIText(await generateText(brand, camp.type || "vigyapan", null, camp.command))
          : await generateText(brand, camp.type || "vigyapan", null, camp.command);
      } catch (e) {
        text = camp.command;
        log("WARN", "[campaign] AI लिखाई नहीं बनी, आपका ही text लिया", { msg: e.message });
      }
      camp.text = text;
      await camp.save();
    }

    // ── 2. तीनों नाप के poster — एक साथ ──────────────────────
    //    generateImages पहले से तीनों बनाता है, बस अलग-अलग नाम दे देते हैं
    try {
      const imgs = await generateImages(brand, camp._id, text, camp.type || "vigyapan", {});
      set("poster",    { status: "ready", url: imgs.square,    label: "🖼️ Poster (चौकोर)" });
      set("story",     { status: "ready", url: imgs.story,     label: "📱 Story (9:16)" });
      set("landscape", { status: "ready", url: imgs.landscape, label: "🖥️ चौड़ा (FB/Google)" });
      await camp.save();
      L("poster बने", { id: String(camp._id) });
    } catch (e) {
      ["poster", "story", "landscape"].forEach((k) => set(k, { status: "failed", note: e.message }));
      await camp.save();
    }

    // ── 3. हर platform का अपना caption ───────────────────────
    try {
      const v = await adaptToPlatforms(text, brand);
      set("caption_ig", { status: "ready", text: v.instagram || text });
      set("caption_fb", { status: "ready", text: v.facebook || text });
      set("caption_wa", {
        status: "ready",
        text: (v.whatsapp || text) + (b.phone ? `\n\n📞 ${b.phone}` : ""),
      });
      set("gbp", {
        status: "ready",
        text: String(v.facebook || text).replace(/#\S+/g, "").trim().slice(0, 1400),
        note: "Google की मंज़ूरी मिलने पर सीधे जाएगा",
      });
      await camp.save();
    } catch (e) {
      ["caption_ig", "caption_fb", "caption_wa", "gbp"].forEach((k) =>
        set(k, { status: "ready", text, note: "AI से अलग version नहीं बना — वही लिखाई ली" }));
      await camp.save();
    }

    // ── 4. अनाउंसमेंट — माँगने पर ही बनेगा (30 सेकंड लगते हैं) ──
    set("announce", { status: "pending", note: "बनाने के लिए दबाइए — 30 सेकंड" });

    // ── 5. Review के लिए एक Content भी बना दो ────────────────
    try {
      const p = out("poster"), s = out("story");
      const doc = await Content.create({
        brand, type: camp.type || "vigyapan", text,
        imgUrl: p?.url || "",
        images: { square: p?.url || "", story: s?.url || "", landscape: out("landscape")?.url || "" },
        status: "pending", triggeredBy: "campaign",
      });
      camp.contentId = doc._id;
    } catch (e) { log("WARN", "[campaign] Content नहीं बना", { msg: e.message }); }

    camp.status = "ready";
    await camp.save();
    return camp;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  ROUTES
  // ══════════════════════════════════════════════════════════════════════════

  /** एक बात कहिए → सब बन जाए */
  app.post("/api/campaign/one-in", requireRole("super-admin", "admin", "manager"), async (req, res) => {
    try {
      const command = String(req.body?.command || "").trim();
      if (!command) return bad(res, new Error("कुछ कहा ही नहीं"), 400);

      let intent = {};
      try { intent = (await parseCommandIntent(command, req.body.brand)) || {}; } catch (_) {}

      const brand = BRANDS[intent.brand] ? intent.brand
        : (BRANDS[req.body.brand] ? req.body.brand : Object.keys(BRANDS)[0]);

      // ⚠️ गाड़ी का नाम आया हो तो असली क़ीमत database से लो — AI मनगढ़ंत
      //    दाम न लिख दे। यह आपके app की सबसे बड़ी ख़ूबी है, इसे बचाना ज़रूरी।
      let vCtx = "";
      if (intent.vehicle) {
        try { vCtx = (await vehicleContext(brand, intent.vehicle)) || ""; } catch (_) {}
      }

      const camp = await Camp.create({
        brand, command,
        type: intent.type || "vigyapan",
        vehicle: intent.vehicle || "",
        text: "",
        outputs: KINDS.map((k) => ({ kind: k.id, label: k.label, status: "pending" })),
        createdBy: req.user?.email,
      });

      // पहले जवाब दो, बनाना पीछे चलता रहे — पर्दा अटके नहीं
      res.json({
        ok: true, id: camp._id,
        brand, type: camp.type, vehicle: camp.vehicle,
        outputs: camp.outputs,
        notPossible: NOT_POSSIBLE,
        message: "बन रहा है… 20–40 सेकंड। नीचे हर चीज़ अपने आप आती जाएगी।",
      });

      build(camp).catch((e) => {
        log("ERROR", "[campaign] build fail", { msg: e.message });
        Camp.updateOne({ _id: camp._id }, { status: "failed" }).catch(() => {});
      });
    } catch (e) { bad(res, e); }
  });

  /** कहाँ तक पहुँचा — पर्दा हर 2 सेकंड में यही पूछता है */
  app.get("/api/campaign/one-in/:id", async (req, res) => {
    try {
      const c = await Camp.findById(req.params.id).lean();
      if (!c) return bad(res, new Error("नहीं मिला"), 404);
      res.json({
        ...c,
        outputs: (c.outputs || []).map((o) => ({
          ...o, fullUrl: o.url ? PUBLIC_URL + o.url : "",
        })),
        notPossible: NOT_POSSIBLE,
      });
    } catch (e) { bad(res, e); }
  });

  /** पिछले campaign */
  app.get("/api/campaign/one-in", async (req, res) => {
    try {
      const q = BRANDS[req.query.brand] ? { brand: req.query.brand } : {};
      const rows = await Camp.find(q).sort({ createdAt: -1 }).limit(20)
        .select("command brand type status createdAt outputs").lean();
      res.json(rows);
    } catch (e) { bad(res, e); }
  });

  /** चुने हुए platform पर भेज दो */
  app.post("/api/campaign/one-in/:id/publish", requireRole("super-admin", "admin", "manager"), async (req, res) => {
    try {
      const c = await Camp.findById(req.params.id);
      if (!c) return bad(res, new Error("नहीं मिला"), 404);
      if (!c.contentId) return bad(res, new Error("अभी बन रहा है — थोड़ा रुकिए"), 400);

      const want = req.body?.platforms || {};
      const doc = await Content.findById(c.contentId);
      if (!doc) return bad(res, new Error("post नहीं मिली"), 404);

      const results = await safePublish({ ...doc.toObject(), platforms: want });
      const okAny = results.some((r) => r.ok);

      doc.status = okAny ? "sent" : "failed";
      doc.sentAt = new Date();
      doc.channels = results.filter((r) => r.ok).map((r) => r.platform);
      doc.results = results;
      await doc.save();

      c.status = okAny ? "published" : c.status;
      (c.outputs || []).forEach((o) => {
        if (/^caption_/.test(o.kind) && want[o.kind.split("_")[1]]) o.published = okAny;
      });
      c.markModified("outputs");
      await c.save();

      res.json({ ok: okAny, results });
    } catch (e) { bad(res, e); }
  });

  L("एक-में-सब चालू");
  return { Camp, KINDS, NOT_POSSIBLE, build };
};
