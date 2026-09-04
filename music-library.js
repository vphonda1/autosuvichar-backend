// ============================================================================
//  music-library.js — अपने गाने, हमेशा के लिए   (v1.0)
//  ---------------------------------------------------------------------------
//  server.js के नीचे, app.listen से पहले:
//
//      try {
//        require("./music-library.js")(app, {
//          log, BRANDS, OUT_DIR, MUSIC_DIR, PUBLIC_URL, requireRole, mongoose,
//        });
//      } catch (e) {
//        log("ERROR", "music-library चालू नहीं हुआ", { msg: e.message });
//      }
//
//  ---------------------------------------------------------------------------
//  ⚠️ गाने disk पर क्यों नहीं रखे — यही सबसे ज़रूरी बात है
//
//  Render की free service का filesystem "ephemeral" है। service सोते ही,
//  restart होते ही या deploy होते ही disk पर चढ़ाई गई files मिट जाती हैं।
//  ठीक यही गाड़ियों की photo के साथ हुआ था — "सेव है" दिखता था पर तस्वीर
//  ग़ायब। गाने भी disk पर रखते तो हर 15 मिनट बाद चले जाते।
//
//  इसलिए गाने database में रखे जाते हैं। database कभी नहीं मिटता।
//
//  ⚠️ जगह का हिसाब (नापकर)
//     3 मिनट का 192kbps गाना = 4.2 MB — बहुत भारी।
//     पर video में music लूप होता है, इसलिए 60 सेकंड ही काफ़ी है।
//     60s + mono + 96kbps = 700 KB → database में 940 KB।
//
//         10 गाने →  9 MB    20 गाने → 18 MB    40 गाने → 37 MB
//
//     Atlas free 512 MB में आराम से आ जाते हैं।
//
//  ⚠️ short video clips यहाँ नहीं रखे जा सकते
//     10 सेकंड का clip = 5 MB, database में 6.7 MB। MongoDB एक record
//     16 MB से बड़ा नहीं रख सकता, और 20 clips = 134 MB — Atlas तंग पड़
//     जाएगा। उनके लिए Cloudinary चाहिए (जो आपके MD Automobile में पहले से है)।
// ============================================================================

"use strict";

const fs = require("fs");
const path = require("path");
const multer = require("multer");
const { spawn } = require("child_process");

module.exports = function mountMusicLibrary(app, deps) {
  const {
    BRANDS = {}, OUT_DIR, MUSIC_DIR, PUBLIC_URL = "", requireRole, mongoose,
  } = deps;
  const log = deps.log || ((l, m, x) => console.log(`[${l}] ${m}`, x || ""));
  const L = (m, x) => log("INFO", "[music] " + m, x);

  const bad = (res, e, code = 500) => res.status(code).json({ error: e.message || String(e) });

  function ff(args, { timeout = 90000 } = {}) {
    return new Promise((resolve, reject) => {
      const p = spawn("ffmpeg", ["-y", "-loglevel", "error", ...args]);
      let err = "";
      p.stderr.on("data", (d) => { err += d.toString().slice(0, 300); });
      const t = setTimeout(() => { try { p.kill("SIGKILL"); } catch (_) {} reject(new Error("ffmpeg बहुत देर लगा")); }, timeout);
      p.on("close", (c) => { clearTimeout(t); c === 0 ? resolve(true) : reject(new Error("ffmpeg: " + (err.trim().split("\n").pop() || c))); });
      p.on("error", () => { clearTimeout(t); reject(new Error("ffmpeg इस server पर नहीं मिला")); });
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  गाने का रिकॉर्ड
  // ══════════════════════════════════════════════════════════════════════════
  const Track = mongoose.models.MusicTrack || mongoose.model("MusicTrack",
    new mongoose.Schema({
      name: { type: String, required: true },
      // किस काम के लिए — अपने-आप चुनने में यही देखा जाता है
      mood: {
        type: String,
        enum: ["josh", "khushi", "shant", "tyohar", "dhamaka"],
        default: "khushi", index: true,
      },
      brand: { type: String, index: true },     // ख़ाली = तीनों brands के लिए
      data: String,                             // base64 mp3
      sizeKB: Number,
      durationSec: Number,
      usedCount: { type: Number, default: 0 },
      lastUsedAt: Date,
      active: { type: Boolean, default: true },
      addedBy: String,
    }, { timestamps: true }));

  const MOODS = [
    { id: "josh",    label: "🔥 जोश",      desc: "ऑफ़र, सेल, नई गाड़ी" },
    { id: "khushi",  label: "😊 ख़ुशी",     desc: "delivery, बधाई" },
    { id: "shant",   label: "🕊️ शांत",     desc: "सुविचार, सूचना" },
    { id: "tyohar",  label: "🎉 त्यौहार",  desc: "दिवाली, होली, गणेश" },
    { id: "dhamaka", label: "💥 धमाका",    desc: "मेगा ऑफ़र, lucky draw" },
  ];

  // किस तरह की post पर कौन-सा mood — अपने-आप चुनने का नियम
  const TYPE_MOOD = {
    delivery: "khushi", festival: "tyohar", gift: "tyohar",
    vigyapan: "josh", suvichar: "shant", suchna: "shant",
    megaoffer: "dhamaka", luckydraw: "dhamaka",
  };

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 25 * 1024 * 1024 },
    fileFilter: (req, f, cb) => cb(null, /^(audio\/|video\/)/.test(f.mimetype) || /\.(mp3|m4a|wav|aac|ogg)$/i.test(f.originalname)),
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  ROUTES
  // ══════════════════════════════════════════════════════════════════════════

  /** गाना चढ़ाओ */
  app.post("/api/music/upload", requireRole("super-admin", "admin"), upload.single("music"), async (req, res) => {
    try {
      if (!req.file) return bad(res, new Error("गाना नहीं मिला (mp3/m4a/wav, 25MB तक)"), 400);

      const tmpIn = path.join(OUT_DIR, `_min${Date.now()}`);
      const tmpOut = path.join(OUT_DIR, `_mout${Date.now()}.mp3`);
      fs.writeFileSync(tmpIn, req.file.buffer);

      try {
        // ⚠️ यही सबसे ज़रूरी क़दम है — 4 MB का गाना 700 KB का हो जाता है।
        //    video में music लूप होता है इसलिए 60 सेकंड काफ़ी है, और
        //    background music में stereo की ज़रूरत नहीं।
        const secs = Math.max(15, Math.min(parseInt(req.body.seconds, 10) || 60, 90));
        const from = Math.max(0, parseFloat(req.body.startAt) || 0);
        await ff(["-ss", String(from), "-i", tmpIn, "-t", String(secs),
          "-ac", "1", "-b:a", "96k", "-ar", "44100",
          "-af", `afade=t=in:st=0:d=1,afade=t=out:st=${Math.max(0, secs - 3)}:d=3`,
          tmpOut]);

        const buf = fs.readFileSync(tmpOut);
        const kb = Math.round(buf.length / 1024);
        if (buf.length > 3 * 1024 * 1024) {
          return bad(res, new Error(`छोटा करने पर भी ${kb}KB रहा — कम सेकंड चुनें`), 400);
        }

        const doc = await Track.create({
          name: (req.body.name || req.file.originalname || "गाना").replace(/\.[^.]+$/, "").slice(0, 60),
          mood: MOODS.some((m) => m.id === req.body.mood) ? req.body.mood : "khushi",
          brand: BRANDS[req.body.brand] ? req.body.brand : "",
          data: buf.toString("base64"),
          sizeKB: kb, durationSec: secs,
          addedBy: req.user?.email,
        });

        L("गाना जुड़ा", { name: doc.name, kb });
        res.json({
          ok: true,
          track: { ...doc.toObject(), data: undefined, url: `${PUBLIC_URL}/music-track/${doc._id}` },
          note: `${Math.round(req.file.size / 1024)}KB → ${kb}KB छोटा किया`,
        });
      } finally {
        [tmpIn, tmpOut].forEach((f) => { try { fs.unlinkSync(f); } catch (_) {} });
      }
    } catch (e) { bad(res, e); }
  });

  /** सारे गाने */
  app.get("/api/music/tracks", async (req, res) => {
    try {
      const q = { active: true };
      if (req.query.mood) q.mood = req.query.mood;
      if (BRANDS[req.query.brand]) q.$or = [{ brand: req.query.brand }, { brand: "" }, { brand: null }];

      const rows = await Track.find(q).select("-data").sort({ mood: 1, name: 1 }).limit(100).lean();
      const totalKB = rows.reduce((a, r) => a + (r.sizeKB || 0), 0);

      res.json({
        moods: MOODS,
        tracks: rows.map((r) => ({ ...r, url: `${PUBLIC_URL}/music-track/${r._id}` })),
        totalKB, totalMB: Math.round(totalKB / 1024 * 10) / 10,
        note: rows.length ? "" : "अभी कोई गाना नहीं — अपने पसंद के गाने चढ़ाइए",
      });
    } catch (e) { bad(res, e); }
  });

  /** गाना सुनो — /api/ से बाहर, ताकि <audio> बिना token चला सके */
  app.get("/music-track/:id", async (req, res) => {
    try {
      const t = await Track.findById(req.params.id).select("data").lean();
      if (!t || !t.data) return res.status(404).send("गाना नहीं मिला");
      const buf = Buffer.from(t.data, "base64");
      res.set({
        "Content-Type": "audio/mpeg", "Content-Length": buf.length,
        "Cache-Control": "public, max-age=31536000, immutable",
        "Access-Control-Allow-Origin": "*",
      });
      res.end(buf);
    } catch (e) { res.status(500).send("error"); }
  });

  app.patch("/api/music/tracks/:id", requireRole("super-admin", "admin"), async (req, res) => {
    try {
      const patch = {};
      if (req.body.name) patch.name = String(req.body.name).slice(0, 60);
      if (MOODS.some((m) => m.id === req.body.mood)) patch.mood = req.body.mood;
      if (req.body.brand !== undefined) patch.brand = BRANDS[req.body.brand] ? req.body.brand : "";
      if (req.body.active !== undefined) patch.active = !!req.body.active;
      const t = await Track.findByIdAndUpdate(req.params.id, patch, { new: true }).select("-data");
      if (!t) return bad(res, new Error("नहीं मिला"), 404);
      res.json({ ok: true, track: t });
    } catch (e) { bad(res, e); }
  });

  app.delete("/api/music/tracks/:id", requireRole("super-admin", "admin"), async (req, res) => {
    try { await Track.findByIdAndDelete(req.params.id); res.json({ ok: true }); }
    catch (e) { bad(res, e); }
  });

  // ══════════════════════════════════════════════════════════════════════════
  //  अपने-आप गाना चुनना — बाक़ी हिस्से यही बुलाते हैं
  // ══════════════════════════════════════════════════════════════════════════
  /**
   * @param opts { trackId } — ख़ुद चुना हो तो वही
   *              { type }   — post की तरह से mood तय होगा
   *              { mood }   — सीधे mood
   * @returns disk पर लिखी अस्थायी file का पता, या null
   */
  async function pickMusicFile(opts = {}) {
    try {
      let t = null;

      if (opts.trackId) {
        t = await Track.findById(opts.trackId).lean();                 // आपका चुना हुआ
      }
      if (!t) {
        const mood = opts.mood || TYPE_MOOD[opts.type] || "khushi";
        const q = { active: true, mood };
        if (BRANDS[opts.brand]) q.$or = [{ brand: opts.brand }, { brand: "" }, { brand: null }];
        // सबसे कम इस्तेमाल हुआ पहले — हर video में वही गाना न बजे
        t = await Track.findOne(q).sort({ usedCount: 1, createdAt: 1 }).lean();
        // उस mood में कुछ न हो तो कोई भी
        if (!t) t = await Track.findOne({ active: true }).sort({ usedCount: 1 }).lean();
      }
      if (!t || !t.data) return null;

      const f = path.join(OUT_DIR, `_bgm${t._id}_${Date.now()}.mp3`);
      fs.writeFileSync(f, Buffer.from(t.data, "base64"));
      Track.updateOne({ _id: t._id }, { $inc: { usedCount: 1 }, lastUsedAt: new Date() }).catch(() => {});
      return { file: f, name: t.name, id: String(t._id), temp: true };
    } catch (e) {
      log("WARN", "[music] गाना नहीं चुना जा सका", { msg: e.message });
      return null;
    }
  }

  /** कितनी जगह घिरी है */
  app.get("/api/music/storage", async (req, res) => {
    try {
      const rows = await Track.find({}).select("sizeKB").lean();
      const kb = rows.reduce((a, r) => a + (r.sizeKB || 0), 0);
      res.json({
        tracks: rows.length,
        usedMB: Math.round(kb / 1024 * 10) / 10,
        limitMB: 512,
        note: "Atlas free 512MB — 40 गाने भी सिर्फ़ 37MB लेते हैं",
      });
    } catch (e) { bad(res, e); }
  });

  L("गानों की लाइब्रेरी चालू");
  return { Track, pickMusicFile, MOODS, TYPE_MOOD };
};
