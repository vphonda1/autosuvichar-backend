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
    // ⚠️ नए — बिना इनके caption किसी और गाड़ी की बात करता, poster किसी और की
    pickVehicleForAd, stripRs, toWhatsAppMarkdown, detectFestivalName, stripBrandFromPoem,
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
      vehicleHintCtx: String,                // असली क़ीमत/नाम — caption इसी से बने
      offerHint: String,                     // आपने कमांड में जो राशि/ऑफ़र बताई — poster में डेटाबेस-कमी पूरी करने के लिए
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

    // ── 1. गाड़ी पहले, फिर उसी के बारे में caption ────────────
    //  ⚠️ पहले caption आज़ाद तरीक़े से बनता था (camp.command से), और poster
    //     के लिए बाद में अलग से कोई गाड़ी चुनी जाती (generateImages के अंदर,
    //     सिर्फ़ caption के पहले शब्द से अंदाज़ा लगाकर — बहुत कमज़ोर तरीक़ा)।
    //     नतीजा: caption किसी और गाड़ी की बात करता, poster पर कोई और गाड़ी।
    //
    //     ऊपर से, route handler पहले ही vCtx (असली क़ीमत/downPayment) database
    //     से निकाल चुका था — पर वो कहीं इस्तेमाल हुए बिना फेंक दी जाती थी।
    //
    //     अब क्रम वही है जो genToPending (रोज़ की cron post) में है: पहले
    //     असली गाड़ी चुनो, फिर उसी की सही जानकारी AI को caption के लिए दो,
    //     फिर वही गाड़ी poster पर भी लगाओ — तीनों जगह एक ही गाड़ी।
    const isAd = (camp.type || "vigyapan") === "vigyapan";
    let vehDoc = null;
    if (isAd && pickVehicleForAd) {
      try { vehDoc = await pickVehicleForAd(brand, camp.vehicle); }
      catch (e) { log("WARN", "[campaign] गाड़ी नहीं चुनी जा सकी", { msg: e.message }); }
    }

    // ⚠️ "गणेश चतुर्थी की बधाई" कहने पर पहले कोई त्यौहार पहचाना ही नहीं
    //    जाता था — festive-poster.js को हमेशा ख़ाली festival नाम मिलता,
    //    इसलिए वो "general" (सादी) theme चुन लेता, कभी "ganesh" नहीं। और
    //    caption भी generic बनता ("सूरज की पहली किरण" जैसा), असली त्यौहार
    //    का ज़िक्र किए बिना।
    const isFestival = (camp.type || "") === "festival";
    const festivalName = isFestival && detectFestivalName ? detectFestivalName(camp.command) : "";

    let text = camp.text;
    if (!text) {
      // असली गाड़ी मिली और route handler का पुराना vCtx भी है, तो नया और
      // पक्का context बनाओ — camp.command से नहीं, database से
      let vehCtx = camp.command;
      if (isAd && vehDoc && stripRs) {
        const model = [vehDoc.name, vehDoc.variant].filter(Boolean).join(" ");
        const bits = [
          vehDoc.exShowroom && `एक्स-शोरूम ${stripRs(vehDoc.exShowroom)}`,
          vehDoc.downPayment && `डाउन पेमेंट ${stripRs(vehDoc.downPayment)}`,
          vehDoc.cashback && `कैशबैक ${stripRs(vehDoc.cashback)}`,
        ].filter(Boolean).join(", ");
        vehCtx = `${model}${bits ? " — " + bits : ""}. मूल बात: ${camp.command}`;
      } else if (camp.vehicleHintCtx) {
        vehCtx = `${camp.command}. ${camp.vehicleHintCtx}`;
      }

      try {
        text = cleanAIText
          ? cleanAIText(await generateText(brand, camp.type || "vigyapan", festivalName || null, vehCtx))
          : await generateText(brand, camp.type || "vigyapan", festivalName || null, vehCtx);
        // ⚠️ सुविचार में AI कभी-कभी prompt की मनाही के बावजूद brand का
        //    नाम सुविचार के भीतर ही घुसा देता है — यहीं काट देते हैं
        if ((camp.type || "") === "suvichar" && stripBrandFromPoem) text = stripBrandFromPoem(text, brand);
      } catch (e) {
        text = camp.command;
        log("WARN", "[campaign] AI लिखाई नहीं बनी, आपका ही text लिया", { msg: e.message });
      }
      camp.text = text;
      await camp.save();
    }

    // ── 2. तीनों नाप के poster — एक साथ ──────────────────────
    //    generateImages पहले से तीनों बनाता है, बस अलग-अलग नाम दे देते हैं
    //    ⚠️ vehicleDoc यहीं दे दो — वरना generateImages अपने-आप कोई और
    //       गाड़ी चुन लेगा और caption से मेल नहीं खाएगी। festival नाम भी
    //       दो — वरना सजावट "general" theme में बनेगी, सही देवी-देवता के
    //       बिना।
    try {
      const imgs = await generateImages(brand, camp._id, text, camp.type || "vigyapan", {
        ...(vehDoc ? { vehicleDoc: vehDoc } : {}),
        offerHint: camp.offerHint || camp.command,
        festival: festivalName,
      });
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
    //  ⚠️ बहुत बड़ी गड़बड़ी यहीं थी — adaptToPlatforms(brandId, sourceText,
    //     platforms, extra) चाहता है, पर यहाँ (text, brand) दिया जा रहा था
    //     — यानी असली caption की जगह सिर्फ़ brand id ("vp_honda") को content
    //     मानकर AI को भेजा जाता, और caption की जगह brand id "brandId" बन
    //     जाता (BRANDS["...पूरा caption..."] हमेशा undefined)। AI को असली
    //     content मिलता ही नहीं था, इसलिए वो अपने-आप कोई और गाड़ी
    //     ("Activa 6G") गढ़ लेता था — जैसा screenshot में दिखा।
    try {
      const vehNote = isAd && vehDoc ? `गाड़ी का नाम बिल्कुल यही रहे: ${[vehDoc.name, vehDoc.variant].filter(Boolean).join(" ")}` : "";
      const v = await adaptToPlatforms(brand, text, undefined, vehNote);
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
      const p = out("poster"), s = out("story"), wa = out("caption_wa");
      const doc = await Content.create({
        brand, type: camp.type || "vigyapan", text,
        // ⚠️ caption_wa पहले से WhatsApp के नियमों (छोटा, emoji भरपूर, कोई
        //    hashtag नहीं) के हिसाब से बना है — उसी पर bold/italic लगाई,
        //    ताकि "अभी ख़ुद भेजें" पर सजा हुआ WhatsApp message जाए।
        whatsappText: toWhatsAppMarkdown(wa?.text || text, brand),
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

      // ⚠️ नया — जब उपयोगकर्ता ख़ुद dropdown से प्रकार चुन ले (जैसे "विज्ञापन"),
      //    तो AI से अंदाज़ा मत लगवाओ, पक्का वही प्रकार बने। सिर्फ़ 5 auto-type
      //    (suvichar/vigyapan/festival/suchna/gift) यहाँ मान्य हैं — बाक़ी
      //    (हायरिंग वग़ैरह) frontend में ही अलग रास्ते पर भेज दिए जाते हैं।
      const AUTO_TYPES = ["suvichar", "vigyapan", "festival", "suchna", "gift"];
      const forceType = AUTO_TYPES.includes(req.body?.forceType) ? req.body.forceType : "";

      let intent = {};
      try { intent = (await parseCommandIntent(command, req.body.brand)) || {}; } catch (_) {}

      // ⚠️ "हायरिंग का विज्ञापन बनाओ" जैसी बात यहाँ नहीं बनती — भर्ती,
      //    बुकिंग, तुलना वग़ैरह अपने ख़ास पन्ने में बनते हैं। पहले यहाँ ऐसा
      //    कहने पर मोटरसाइकिल का ऑफ़र-poster बन जाता था — ग़लत गाड़ी के साथ।
      //    अगर उपयोगकर्ता ने ख़ुद प्रकार चुना है (forceType), तो यह जाँच
      //    छोड़ दो — उसकी अपनी पक्की पसंद है, AI की अटकल नहीं।
      if (!forceType && intent.notAutoType) {
        return bad(res, new Error(
          "यह \"" + (intent.suggestedLabel || intent.suggestedCapability || "") + "\" वाला है — यहाँ नहीं बनेगा। " +
          "बनाओ → सीधे उस कार्ड पर जाकर बनाइए।"
        ), 400);
      }

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
        type: forceType || intent.type || "vigyapan",
        vehicle: intent.vehicle || "",
        vehicleHintCtx: vCtx,   // ⚠️ पहले यह बनकर भी फेंक दी जाती थी, इस्तेमाल नहीं होती थी
        offerHint: intent.offer_details || "",   // ⚠️ आपने कमांड में जो राशि बताई — पहले यह भी कहीं इस्तेमाल नहीं होती थी
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
      if (doc.status === "sent") return res.json({ ok: true, already: true, message: "यह पहले ही भेजा जा चुका है" });

      // ⚠️ safePublish का रूप है (Model, docId, req) — object नहीं लेता।
      //    पहले मैंने object भेज दिया था, वह चलते ही टूटता।
      //
      // ⚠️ Content के platforms में सिर्फ़ fb/ig/yt/wa हैं, gbp नहीं — और
      //    schema strict है, इसलिए gbp लिखने पर चुपचाप गिर जाता।
      //    Google Business growth-engine से अलग भेजा जाता है (नीचे)।
      doc.platforms = {
        fb: !!want.fb, ig: !!want.ig, wa: !!want.wa, yt: !!want.yt,
      };
      // disk की file न मिले तो database से तस्वीर जाए
      if (doc.images && (doc.images.square || doc.images.landscape)) {
        doc.imgUrl = `/api/image/content/${doc._id}/square`;
        doc.imgUrlLandscape = `/api/image/content/${doc._id}/landscape`;
      }
      await doc.save();

      const out = await safePublish(Content, doc._id, req);
      const updated = await Content.findById(doc._id).select("-imageData");

      if (out.already) return res.json({ ok: true, already: true, message: "यह पहले ही भेजा जा चुका है" });
      if (!out.ok && out.retrying) {
        return res.status(202).json({
          ok: false, retrying: true,
          message: `अभी नहीं गया — ${out.attempt} कोशिश। कुछ मिनट में अपने आप दोबारा जाएगा।`,
        });
      }

      const results = updated?.results || out.results || [];
      let okAny = updated?.status === "sent" || !!out.ok;

      // ── Google Business अलग से ─────────────────────────────
      if (want.gbp) {
        const GE = global.__GROWTH;
        const gtext = (c.outputs || []).find((o) => o.kind === "gbp")?.text || c.text;
        if (GE?.gbpPost) {
          try {
            await GE.gbpPost(c.brand, {
              summary: String(gtext).slice(0, 1400),
              imageUrl: (c.outputs || []).find((o) => o.kind === "poster")?.url || "",
              ctaType: "CALL",
            });
            results.push({ platform: "gbp", ok: true });
            okAny = true;
          } catch (e) {
            results.push({ platform: "gbp", ok: false, error: e.message });
          }
        } else {
          results.push({ platform: "gbp", ok: false, error: "Google Business जुड़ा नहीं — सेटिंग में जोड़ें" });
        }
      }

      c.status = okAny ? "published" : c.status;
      (c.outputs || []).forEach((o) => {
        const plat = o.kind.startsWith("caption_") ? o.kind.split("_")[1] : (o.kind === "gbp" ? "gbp" : null);
        if (plat && want[plat]) o.published = okAny;
      });
      c.markModified("outputs");
      await c.save();

      res.json({ ok: okAny, results, channels: updated?.channels || [] });
    } catch (e) { bad(res, e); }
  });

  L("एक-में-सब चालू");
  return { Camp, KINDS, NOT_POSSIBLE, build };
};
