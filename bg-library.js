// ============================================================================
//  bg-library.js — पृष्ठभूमियों की लाइब्रेरी   (v1.0)
//  ---------------------------------------------------------------------------
//  server.js के नीचे, app.listen से पहले:
//
//      try {
//        require("./bg-library.js")(app, {
//          log, BRANDS, OUT_DIR, PUBLIC_URL, requireRole, mongoose, sharp,
//        });
//      } catch (e) {
//        log("ERROR", "bg-library चालू नहीं हुआ", { msg: e.message });
//      }
//
//  ---------------------------------------------------------------------------
//  ⚠️ यह क्यों चाहिए
//
//  AI से तस्वीर बनाने पर हर बार पैसे कटते हैं — लगभग ₹4। पसंद न आए और
//  दोबारा दबाएँ तो दोबारा कटते हैं। रोज़ 3 poster × 2 बार = महीने का ₹720।
//
//  पर सच यह है कि शोरूम की पृष्ठभूमि रोज़ बदलने की ज़रूरत ही नहीं। एक
//  अच्छी बन जाए तो वही दस posters पर चल जाती है।
//
//  ✅ अब: जो पृष्ठभूमि पसंद आए, उसे सेव कर लीजिए। अगली बार बनाने की जगह
//     चुन लीजिए — ₹0। 10 अच्छी बनाकर रख लें तो ₹40 एक बार, फिर मुफ़्त।
//
//  ⚠️ database में रखते हैं, disk पर नहीं — Render की free disk service के
//     सोते ही मिट जाती है (गाड़ियों की photo के साथ यही हुआ था)।
//     10 पृष्ठभूमि = 2.4 MB, Atlas की 512 MB में आराम से।
// ============================================================================

"use strict";

module.exports = function mountBgLibrary(app, deps) {
  const { BRANDS = {}, PUBLIC_URL = "", requireRole, mongoose, sharp } = deps;
  const log = deps.log || ((l, m, x) => console.log(`[${l}] ${m}`, x || ""));
  const L = (m, x) => log("INFO", "[bg] " + m, x);
  const bad = (res, e, c = 500) => res.status(c).json({ error: e.message || String(e) });

  // ══════════════════════════════════════════════════════════════════════════
  //  रिकॉर्ड
  // ══════════════════════════════════════════════════════════════════════════
  const Bg = mongoose.models.PosterBg || mongoose.model("PosterBg",
    new mongoose.Schema({
      name: { type: String, default: "पृष्ठभूमि" },
      brand: { type: String, index: true },      // ख़ाली = तीनों brands के लिए
      data: String,                              // base64 jpeg
      sizeKB: Number,
      source: String,                            // gemini / pollinations / upload
      usedCount: { type: Number, default: 0 },
      lastUsedAt: Date,
      pinned: { type: Boolean, default: false }, // पसंदीदा — सबसे ऊपर दिखे
      addedBy: String,
    }, { timestamps: true }));

  const MAX = 40;   // इससे ज़्यादा न रखें — database भर जाएगा

  // ══════════════════════════════════════════════════════════════════════════
  //  ROUTES
  // ══════════════════════════════════════════════════════════════════════════

  /** सेव कर लो — जो अभी बनी है */
  app.post("/api/bg/save", requireRole("super-admin", "admin", "manager"), async (req, res) => {
    try {
      const { dataUrl, name, brand, source } = req.body || {};
      if (!dataUrl || !/^data:image\//.test(dataUrl)) {
        return bad(res, new Error("तस्वीर नहीं मिली"), 400);
      }

      const raw = Buffer.from(String(dataUrl).split(",")[1] || "", "base64");
      if (!raw.length) return bad(res, new Error("तस्वीर ख़ाली है"), 400);

      // ⚠️ छोटी कर दो — पृष्ठभूमि के लिए 1080 काफ़ी है और jpeg बहुत हल्का
      let buf = raw;
      try {
        buf = await sharp(raw)
          .resize(1080, 1080, { fit: "cover", withoutEnlargement: true })
          .jpeg({ quality: 82 }).toBuffer();
      } catch (e) {
        log("WARN", "[bg] छोटी नहीं हुई, जैसी है वैसी रखी", { msg: e.message });
      }

      const kb = Math.round(buf.length / 1024);
      if (buf.length > 1.5 * 1024 * 1024) {
        return bad(res, new Error(`तस्वीर भारी है (${kb}KB)`), 400);
      }

      // गिनती की हद — सबसे पुरानी और कम इस्तेमाल हुई हटा दो
      const total = await Bg.countDocuments();
      if (total >= MAX) {
        const drop = await Bg.find({ pinned: false })
          .sort({ usedCount: 1, createdAt: 1 }).limit(total - MAX + 1).select("_id").lean();
        if (drop.length) await Bg.deleteMany({ _id: { $in: drop.map((d) => d._id) } });
      }

      const doc = await Bg.create({
        name: String(name || "").slice(0, 40) || `पृष्ठभूमि ${total + 1}`,
        brand: BRANDS[brand] ? brand : "",
        data: buf.toString("base64"),
        sizeKB: kb, source: source || "ai",
        addedBy: req.user?.email,
      });

      L("सेव हुई", { name: doc.name, kb });
      res.json({
        ok: true,
        bg: { _id: doc._id, name: doc.name, sizeKB: kb, url: `${PUBLIC_URL}/poster-bg/${doc._id}` },
        note: `${kb}KB — अब जब चाहें दोबारा लगा सकते हैं, पैसे नहीं लगेंगे`,
      });
    } catch (e) { bad(res, e); }
  });

  /** सारी सेव की हुई */
  app.get("/api/bg", async (req, res) => {
    try {
      const q = BRANDS[req.query.brand]
        ? { $or: [{ brand: req.query.brand }, { brand: "" }, { brand: null }] } : {};
      const rows = await Bg.find(q).select("-data")
        .sort({ pinned: -1, usedCount: -1, createdAt: -1 }).limit(MAX).lean();
      const kb = rows.reduce((a, r) => a + (r.sizeKB || 0), 0);
      res.json({
        count: rows.length, max: MAX,
        usedMB: Math.round(kb / 1024 * 10) / 10,
        rows: rows.map((r) => ({ ...r, url: `${PUBLIC_URL}/poster-bg/${r._id}` })),
        note: rows.length
          ? "पसंद की पृष्ठभूमि चुन लीजिए — दोबारा बनाने के पैसे नहीं लगेंगे"
          : "अभी कोई सेव नहीं — AI से बनवाकर 💾 दबाइए",
      });
    } catch (e) { bad(res, e); }
  });

  /** ⚠️ "/api/" से बाहर — <img> login का token नहीं भेज सकता */
  app.get("/poster-bg/:id", async (req, res) => {
    try {
      const b = await Bg.findById(req.params.id).select("data").lean();
      if (!b?.data) return res.status(404).send("नहीं मिली");
      const buf = Buffer.from(b.data, "base64");
      res.set({
        "Content-Type": "image/jpeg", "Content-Length": buf.length,
        "Cache-Control": "public, max-age=31536000, immutable",
        "Access-Control-Allow-Origin": "*",
        "Cross-Origin-Resource-Policy": "cross-origin",
      });
      res.end(buf);
    } catch (e) { res.status(500).send("error"); }
  });

  /** इस्तेमाल हुई — गिनती बढ़ाओ ताकि पसंदीदा ऊपर रहें */
  app.post("/api/bg/:id/used", async (req, res) => {
    try {
      await Bg.updateOne({ _id: req.params.id }, { $inc: { usedCount: 1 }, lastUsedAt: new Date() });
      res.json({ ok: true });
    } catch (e) { bad(res, e); }
  });

  app.patch("/api/bg/:id", requireRole("super-admin", "admin"), async (req, res) => {
    try {
      const patch = {};
      if (req.body.name) patch.name = String(req.body.name).slice(0, 40);
      if (req.body.pinned !== undefined) patch.pinned = !!req.body.pinned;
      const b = await Bg.findByIdAndUpdate(req.params.id, patch, { new: true }).select("-data");
      if (!b) return bad(res, new Error("नहीं मिली"), 404);
      res.json({ ok: true, bg: b });
    } catch (e) { bad(res, e); }
  });

  app.delete("/api/bg/:id", requireRole("super-admin", "admin"), async (req, res) => {
    try { await Bg.findByIdAndDelete(req.params.id); res.json({ ok: true }); }
    catch (e) { bad(res, e); }
  });

  L("पृष्ठभूमियों की लाइब्रेरी चालू");
  return { Bg };
};
