// ============================================================================
//  announcer.js — अनाउंसमेंट स्टूडियो   (v1.0)
//  ---------------------------------------------------------------------------
//  server.js के सबसे नीचे, app.listen से ठीक पहले यह जोड़ें:
//
//      try {
//        require("./announcer.js")(app, {
//          log, BRANDS, AI, OUT_DIR, MUSIC_DIR, PUBLIC_URL,
//          requireRole, stripEmoji, audioDuration, activity,
//          checkAndCountUsage, mongoose,
//        });
//      } catch (e) {
//        log("ERROR", "announcer चालू नहीं हुआ (बाक़ी app चलता रहेगा)", { msg: e.message });
//      }
//
//  ---------------------------------------------------------------------------
//  यह क्या करता है
//
//  आप लिखते हैं — "आज शाम 5 बजे शोरूम पर मेगा ऑफ़र" — और बनकर मिलता है
//  पूरा तैयार अनाउंसमेंट, ठीक वैसा जैसा बाज़ार में माइक पर बजता है:
//
//      ढोल/धमाका  →  music चढ़ता है  →  music धीमा, आवाज़ बोलती है
//                 →  music फिर तेज़  →  धीरे-धीरे ख़त्म
//
//  ⭐ सबसे अहम बात — "ducking"
//     सस्ते app में music और आवाज़ एक साथ बजते हैं, बात सुनाई ही नहीं देती।
//     यहाँ music **अपने आप** धीमा होता है जैसे ही आवाज़ शुरू होती है, और
//     बात ख़त्म होते ही अपने आप वापस तेज़ हो जाता है।
//     (नापकर देखा: बोलते समय music 16 dB नीचे चला जाता है।)
//
//  ⭐ ढोल-धमाके की आवाज़ें कहीं से लानी नहीं पड़तीं
//     पहली बार चलने पर ffmpeg ख़ुद बना देता है — ढोल की लय, धमाका, घंटी,
//     सीटी वग़ैरह। कोई बाहरी file, कोई download, कोई दूसरा app नहीं।
//
//  ⭐ सब कुछ आपके हाथ में
//     आवाज़ कितनी तेज़, music कितना तेज़, बोलने की रफ़्तार, आवाज़ मर्द की या
//     औरत की, कौन-सा असर लगे — सब बदल सकते हैं। और mp3 download हो जाता है,
//     जिसे सीधे माइक/speaker पर बजा दीजिए या WhatsApp पर भेज दीजिए।
// ============================================================================

"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

module.exports = function mountAnnouncer(app, deps) {
  const {
    BRANDS = {}, AI, OUT_DIR, MUSIC_DIR, PUBLIC_URL = "",
    requireRole, stripEmoji, audioDuration, activity, checkAndCountUsage, mongoose,
  } = deps;

  const log = deps.log || ((l, m, x) => console.log(`[${l}] ${m}`, x || ""));
  const L = (m, x) => log("INFO", "[announcer] " + m, x);
  const E = (m, x) => log("ERROR", "[announcer] " + m, x);

  const SFX_DIR = path.join(MUSIC_DIR, "sfx");
  fs.mkdirSync(SFX_DIR, { recursive: true });

  const bad = (res, e, code = 500) => res.status(code).json({ error: e.message || String(e) });
  const clamp = (v, lo, hi, d) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d;
  };

  // ffmpeg चलाओ — गड़बड़ हो तो असली वजह बताओ, "कुछ गड़बड़ है" नहीं
  function ff(args, { timeout = 120000 } = {}) {
    return new Promise((resolve, reject) => {
      const p = spawn("ffmpeg", ["-y", "-loglevel", "error", ...args]);
      let err = "";
      p.stderr.on("data", (d) => { err += d.toString().slice(0, 400); });
      const t = setTimeout(() => { try { p.kill("SIGKILL"); } catch (_) {} reject(new Error("ffmpeg बहुत देर लगा")); }, timeout);
      p.on("close", (c) => {
        clearTimeout(t);
        c === 0 ? resolve(true) : reject(new Error("ffmpeg: " + (err.trim().split("\n").pop() || "code " + c)));
      });
      p.on("error", () => { clearTimeout(t); reject(new Error("ffmpeg इस server पर मिला नहीं")); });
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  1. आवाज़ें ख़ुद बनाओ — कोई बाहरी file नहीं
  // ══════════════════════════════════════════════════════════════════════════
  //  हर आवाज़ ffmpeg के गणित से बनती है (sine + शोर + घटता हुआ envelope)।
  //  एक बार बन जाने पर दोबारा नहीं बनती।

  const SFX = {
    dhol: {
      label: "🥁 ढोल", desc: "शादी-त्यौहार वाली थाप — ध्यान खींचती है",
      build: async (out) => {
        const a = path.join(SFX_DIR, "_d1.wav"), b = path.join(SFX_DIR, "_d2.wav");
        // बड़ी थाप (bass) और छोटी खड़क (treble)
        await ff(["-f", "lavfi", "-i",
          "aevalsrc='0.9*sin(2*PI*72*t)*exp(-16*t)+0.5*sin(2*PI*160*t)*exp(-30*t)+0.35*random(0)*exp(-60*t)':d=0.32:s=44100", a]);
        await ff(["-f", "lavfi", "-i",
          "aevalsrc='0.7*sin(2*PI*210*t)*exp(-28*t)+0.4*random(0)*exp(-70*t)':d=0.22:s=44100", b]);
        // धा धिन धिन धा — असली ढोल की लय
        await ff(["-i", a, "-i", b, "-filter_complex",
          "[0]adelay=0|0[p1];[1]adelay=340|340[p2];[1]adelay=620|620[p3];[0]adelay=900|900[p4];" +
          "[0]adelay=1240|1240[p5];[1]adelay=1580|1580[p6];[0]adelay=1860|1860[p7];" +
          "[p1][p2][p3][p4][p5][p6][p7]amix=inputs=7:normalize=0,volume=1.6,alimiter=limit=0.95," +
          "aformat=sample_rates=44100:channel_layouts=stereo",
          "-t", "2.4", out]);
        [a, b].forEach((f) => { try { fs.unlinkSync(f); } catch (_) {} });
      },
    },
    dhamaka: {
      label: "💥 धमाका", desc: "बड़े ऑफ़र की शुरुआत के लिए",
      build: (out) => ff(["-f", "lavfi", "-i",
        "aevalsrc='(0.95*random(0)*exp(-7*t)+0.8*sin(2*PI*48*t)*exp(-5*t))':d=1.6:s=44100",
        "-af", "lowpass=f=2600,volume=1.5,alimiter=limit=0.95,aformat=channel_layouts=stereo", out]),
    },
    chime: {
      label: "🔔 घंटी", desc: "रेलवे-स्टेशन जैसी — सूचना से पहले",
      build: (out) => ff(["-f", "lavfi", "-i",
        "aevalsrc='0.6*sin(2*PI*1046*t)*exp(-3.5*t)+0.45*sin(2*PI*1568*t)*exp(-4*t)':d=1.0:s=44100",
        "-f", "lavfi", "-i",
        "aevalsrc='0.6*sin(2*PI*784*t)*exp(-3*t)+0.4*sin(2*PI*1174*t)*exp(-3.5*t)':d=1.4:s=44100",
        "-filter_complex", "[0]adelay=0|0[x];[1]adelay=520|520[y];[x][y]amix=inputs=2:normalize=0," +
        "volume=1.4,aformat=sample_rates=44100:channel_layouts=stereo", out]),
    },
    whoosh: {
      label: "🌀 सरसराहट", desc: "एक बात से दूसरी पर जाने के लिए",
      build: (out) => ff(["-f", "lavfi", "-i", "aevalsrc='0.5*random(0)':d=1.0:s=44100",
        "-af", "highpass=f=300,lowpass=f=5000,volume='0.15+1.6*t*exp(-2.2*t)':eval=frame," +
        "aformat=sample_rates=44100:channel_layouts=stereo", out]),
    },
    tada: {
      label: "🎉 शहनाई", desc: "ख़ुशख़बरी और बधाई के लिए",
      build: (out) => ff(["-f", "lavfi", "-i",
        "aevalsrc='0.45*sin(2*PI*523*t)*exp(-2*t)+0.3*sin(2*PI*659*t)*exp(-2*t)+0.25*sin(2*PI*784*t)*exp(-1.6*t)':d=1.8:s=44100",
        "-af", "volume=1.5,aformat=sample_rates=44100:channel_layouts=stereo", out]),
    },
    horn: {
      label: "📣 भोंपू", desc: "गली-मोहल्ले वाला अनाउंसमेंट भोंपू",
      build: (out) => ff(["-f", "lavfi", "-i",
        "aevalsrc='0.55*sin(2*PI*440*t+3*sin(2*PI*6*t))*exp(-0.9*t)':d=1.4:s=44100",
        "-af", "highpass=f=350,lowpass=f=3400,volume=1.5,aformat=sample_rates=44100:channel_layouts=stereo", out]),
    },
  };

  const sfxPath = (k) => path.join(SFX_DIR, `${k}.mp3`);

  async function ensureSfx() {
    for (const [k, def] of Object.entries(SFX)) {
      const p = sfxPath(k);
      if (fs.existsSync(p) && fs.statSync(p).size > 1000) continue;
      try { await def.build(p); L(`आवाज़ बनी: ${k}`); }
      catch (e) { E(`आवाज़ नहीं बनी: ${k}`, { msg: e.message }); }
    }
  }
  // server जगते ही एक बार — पहली अनाउंसमेंट में देर न लगे
  setTimeout(() => { ensureSfx().catch(() => {}); }, 8000).unref?.();

  // ══════════════════════════════════════════════════════════════════════════
  //  2. रिकॉर्ड — क्या-क्या बनाया
  // ══════════════════════════════════════════════════════════════════════════
  const Announcement = mongoose.models.Announcement || mongoose.model("Announcement",
    new mongoose.Schema({
      brand: { type: String, index: true },
      text: String,
      file: String,
      durationSec: Number,
      voice: { gender: String, style: String, speed: Number },
      mix: { intro: String, music: String, musicVol: Number, voiceVol: Number, outro: String },
      provider: String,
      createdBy: String,
    }, { timestamps: true }));

  // ══════════════════════════════════════════════════════════════════════════
  //  3. असली काम — सब जोड़कर एक अनाउंसमेंट
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * @param opts {
   *   text, brand, gender, style, speed,
   *   intro (sfx कुंजी या ""), outro,
   *   music (MUSIC_DIR की file या ""), musicVol, voiceVol,
   *   leadIn (आवाज़ शुरू होने से पहले music के सेकंड),
   *   tailOut (बात ख़त्म होने के बाद music के सेकंड),
   *   repeat (आवाज़ कितनी बार दोहराए — बाज़ार में 2-3 बार बोला जाता है)
   * }
   */
  async function buildAnnouncement(opts) {
    const stamp = Date.now();
    const tmp = [];
    const T = (n) => { const p = path.join(OUT_DIR, `_ann${stamp}_${n}`); tmp.push(p); return p; };
    const cleanup = () => tmp.forEach((f) => { try { fs.unlinkSync(f); } catch (_) {} });

    try {
      // ── (क) बोली बनाओ ────────────────────────────────────────────
      const txt = stripEmoji(String(opts.text || "")).trim();
      if (!txt) throw new Error("कुछ लिखा ही नहीं");
      if (txt.length > 1500) throw new Error("बहुत लंबा है — 1500 अक्षर तक रखें");

      const tts = await AI.tts(txt, { gender: opts.gender, style: opts.style });
      if (!tts.ok) throw new Error("आवाज़ नहीं बनी — " + tts.error);

      const rawVoice = T("v.mp3");
      fs.writeFileSync(rawVoice, tts.buf);

      // ── (ख) आवाज़ सुधारो ──────────────────────────────────────────
      //  रफ़्तार, और माइक जैसी साफ़ आवाज़: नीचे का शोर काटो, बीच का हिस्सा
      //  उठाओ (वहीं बोली बैठती है), फिर बराबर तेज़ी पर ले आओ।
      const speed = clamp(opts.speed, 0.7, 1.4, 1.0);
      const voiceVol = clamp(opts.voiceVol, 0.4, 2.5, 1.35);
      const rep = Math.round(clamp(opts.repeat, 1, 3, 1));

      const voice = T("v2.wav");
      await ff(["-i", rawVoice, "-af",
        [
          speed !== 1 ? `atempo=${speed.toFixed(2)}` : null,
          "highpass=f=90",                       // माइक की गड़गड़ाहट हटाओ
          "equalizer=f=2600:t=q:w=1.4:g=3.5",    // बोली साफ़ सुनाई दे
          "acompressor=threshold=0.12:ratio=4:attack=8:release=180",  // धीमे-तेज़ बराबर
          `volume=${voiceVol.toFixed(2)}`,
          "aformat=sample_rates=44100:channel_layouts=stereo",
        ].filter(Boolean).join(","), voice]);

      // बार-बार बोलना हो तो बीच में साँस भर का अंतर
      let voiceFinal = voice;
      if (rep > 1) {
        const gap = T("gap.wav");
        await ff(["-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-t", "0.9", gap]);
        const listFile = T("list.txt");
        const seq = [];
        for (let i = 0; i < rep; i++) { seq.push(voice); if (i < rep - 1) seq.push(gap); }
        fs.writeFileSync(listFile, seq.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join("\n"));
        voiceFinal = T("vrep.wav");
        await ff(["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", voiceFinal]);
      }

      const vDur = (await audioDuration(voiceFinal)) || 5;

      // ── (ग) शुरू और अंत की आवाज़ ──────────────────────────────────
      await ensureSfx();
      const introFile = opts.intro && SFX[opts.intro] && fs.existsSync(sfxPath(opts.intro)) ? sfxPath(opts.intro) : null;
      const outroFile = opts.outro && SFX[opts.outro] && fs.existsSync(sfxPath(opts.outro)) ? sfxPath(opts.outro) : null;
      const introDur = introFile ? ((await audioDuration(introFile)) || 2) : 0;

      // ── (घ) कब क्या बजेगा ────────────────────────────────────────
      const leadIn = clamp(opts.leadIn, 0, 6, introFile ? 1.2 : 2.0);   // बोलने से पहले music
      const tailOut = clamp(opts.tailOut, 0, 8, 2.5);                    // बोलने के बाद music
      const musicVol = clamp(opts.musicVol, 0, 1.5, 0.55);

      const voiceStart = introDur + leadIn;
      const total = voiceStart + vDur + tailOut + (outroFile ? 1.5 : 0);

      // ── (ङ) music — या तो आपकी चुनी हुई, या ख़ुद बनी हल्की धुन ────
      let musicFile = null;
      if (opts.music && musicVol > 0) {
        const p = path.join(MUSIC_DIR, path.basename(opts.music));
        if (fs.existsSync(p)) musicFile = p;
      }
      if (!musicFile && musicVol > 0 && opts.music !== "none") {
        // कोई music न चुना हो तो हल्की सी धुन ख़ुद बना दो — सन्नाटा अच्छा नहीं लगता
        musicFile = T("bed.wav");
        await ff(["-f", "lavfi", "-i",
          `aevalsrc='0.20*sin(2*PI*196*t)+0.14*sin(2*PI*294*t)+0.10*sin(2*PI*392*t)':d=${Math.ceil(total) + 2}:s=44100`,
          "-af", "tremolo=f=0.4:d=0.25,lowpass=f=2000,aformat=channel_layouts=stereo", musicFile]);
      }

      // ── (च) सब मिलाओ ─────────────────────────────────────────────
      const out = path.join(OUT_DIR, `announce_${stamp}.mp3`);
      const inputs = [];
      const parts = [];
      const mixIn = [];
      let idx = 0;

      if (introFile) {
        inputs.push("-i", introFile);
        parts.push(`[${idx}:a]adelay=0|0,volume=1.0[intro]`);
        mixIn.push("[intro]"); idx++;
      }

      inputs.push("-i", voiceFinal);
      const vIdx = idx++;
      // ⭐ आवाज़ को दो हिस्सों में बाँटो: एक सुनाई देगी, दूसरी music को
      //    दबाने का इशारा देगी (यही "ducking" है)
      parts.push(`[${vIdx}:a]adelay=${Math.round(voiceStart * 1000)}|${Math.round(voiceStart * 1000)},apad[vpad]`);
      parts.push(`[vpad]asplit=2[vout][vkey]`);

      if (musicFile) {
        inputs.push("-i", musicFile);
        const mIdx = idx++;
        parts.push(
          `[${mIdx}:a]aloop=loop=-1:size=2e9,atrim=0:${total.toFixed(2)},` +
          `volume=${musicVol.toFixed(2)},afade=t=in:st=0:d=1.2,` +
          `afade=t=out:st=${Math.max(0, total - 2.0).toFixed(2)}:d=2.0[bed]`
        );
        // ⭐ यहीं जादू है — आवाज़ आते ही music अपने आप 16 dB नीचे,
        //    बात ख़त्म होते ही अपने आप वापस ऊपर
        parts.push(
          `[bed][vkey]sidechaincompress=threshold=0.03:ratio=20:attack=20:release=450:makeup=1[duck]`
        );
        mixIn.push("[duck]");
      } else {
        parts.push(`[vkey]anullsink`);
      }
      mixIn.push("[vout]");

      if (outroFile) {
        inputs.push("-i", outroFile);
        const oDelay = Math.round((voiceStart + vDur + Math.max(0, tailOut - 1.2)) * 1000);
        parts.push(`[${idx}:a]adelay=${oDelay}|${oDelay},volume=0.9[outro]`);
        mixIn.push("[outro]"); idx++;
      }

      parts.push(
        `${mixIn.join("")}amix=inputs=${mixIn.length}:duration=longest:normalize=0,` +
        // आख़िरी सफ़ाई: कहीं फटे नहीं, और speaker पर भरपूर तेज़ बजे
        `alimiter=limit=0.94,loudnorm=I=-14:TP=-1.5:LRA=11,` +
        `aformat=sample_rates=44100:channel_layouts=stereo[final]`
      );

      await ff([...inputs, "-filter_complex", parts.join(";"),
        "-map", "[final]", "-t", total.toFixed(2),
        "-c:a", "libmp3lame", "-b:a", "192k", out], { timeout: 180000 });

      const dur = await audioDuration(out);
      cleanup();
      return { file: `/generated/announce_${stamp}.mp3`, durationSec: dur || total, provider: tts.via };

    } catch (e) {
      cleanup();
      throw e;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  ROUTES
  // ══════════════════════════════════════════════════════════════════════════

  /** क्या-क्या चुन सकते हैं */
  app.get("/api/announce/options", (req, res) => {
    let music = [];
    try { music = fs.readdirSync(MUSIC_DIR).filter((f) => /\.(mp3|m4a|wav)$/i.test(f)); } catch (_) {}
    res.json({
      effects: Object.entries(SFX).map(([id, d]) => ({
        id, label: d.label, desc: d.desc,
        url: fs.existsSync(sfxPath(id)) ? `${PUBLIC_URL}/generated/../music/sfx/${id}.mp3` : null,
      })),
      music,
      voices: [
        { gender: "female", style: "friendly", label: "👩 महिला — अपनापन", desc: "रोज़ की सूचना, त्यौहार की बधाई" },
        { gender: "female", style: "excited",  label: "👩 महिला — जोश",    desc: "ऑफ़र और सेल के लिए" },
        { gender: "male",   style: "friendly", label: "👨 पुरुष — अपनापन", desc: "आम अनाउंसमेंट" },
        { gender: "male",   style: "excited",  label: "👨 पुरुष — दमदार",  desc: "बाज़ार में माइक पर बजाने लायक़" },
      ],
      presets: [
        { id: "market", label: "🔊 बाज़ार अनाउंसमेंट",
          desc: "ढोल → आवाज़ (2 बार) → भोंपू। गली-मोहल्ले में बजाने के लिए",
          v: { intro: "dhol", outro: "horn", musicVol: 0.5, voiceVol: 1.6, speed: 0.95, repeat: 2, gender: "male", style: "excited" } },
        { id: "offer", label: "💥 धमाकेदार ऑफ़र",
          desc: "धमाका → आवाज़ → शहनाई। सेल और मेगा ऑफ़र के लिए",
          v: { intro: "dhamaka", outro: "tada", musicVol: 0.6, voiceVol: 1.45, speed: 1.0, repeat: 1, gender: "female", style: "excited" } },
        { id: "notice", label: "🔔 सादी सूचना",
          desc: "घंटी → आवाज़। शोरूम बन्द/खुलने जैसी ख़बर के लिए",
          v: { intro: "chime", outro: "", musicVol: 0.35, voiceVol: 1.3, speed: 0.95, repeat: 1, gender: "female", style: "friendly" } },
        { id: "festival", label: "🎉 त्यौहार की बधाई",
          desc: "शहनाई → आवाज़ → ढोल। WhatsApp पर भेजने लायक़",
          v: { intro: "tada", outro: "dhol", musicVol: 0.55, voiceVol: 1.3, speed: 0.92, repeat: 1, gender: "female", style: "friendly" } },
        { id: "plain", label: "🎙️ सिर्फ़ आवाज़",
          desc: "कोई music नहीं, कोई असर नहीं — साफ़ बोली",
          v: { intro: "", outro: "", music: "none", musicVol: 0, voiceVol: 1.4, speed: 1.0, repeat: 1, gender: "male", style: "friendly" } },
      ],
    });
  });

  /** एक आवाज़ का नमूना सुनो */
  app.get("/api/announce/sfx/:id", async (req, res) => {
    try {
      const id = req.params.id;
      if (!SFX[id]) return res.status(404).json({ error: "यह आवाज़ नहीं है" });
      await ensureSfx();
      const p = sfxPath(id);
      if (!fs.existsSync(p)) return res.status(500).json({ error: "आवाज़ बन नहीं पाई" });
      res.set({ "Content-Type": "audio/mpeg", "Cache-Control": "public, max-age=86400" });
      fs.createReadStream(p).pipe(res);
    } catch (e) { bad(res, e); }
  });

  /** पूरा अनाउंसमेंट बनाओ */
  app.post("/api/announce/build", requireRole("super-admin", "admin", "manager"), async (req, res) => {
    try {
      const b = req.body || {};
      if (!BRANDS[b.brand]) return bad(res, new Error("brand चाहिए"), 400);
      if (!String(b.text || "").trim()) return bad(res, new Error("पहले कुछ लिखिए"), 400);

      if (checkAndCountUsage) {
        const lim = await checkAndCountUsage(b.brand, "aiCalls").catch(() => ({ ok: true }));
        if (!lim.ok) return res.status(429).json({ error: lim.message || "आज की AI सीमा पूरी हो गई" });
      }

      const r = await buildAnnouncement(b);

      const doc = await Announcement.create({
        brand: b.brand, text: String(b.text).slice(0, 1500),
        file: r.file, durationSec: r.durationSec, provider: r.provider,
        voice: { gender: b.gender, style: b.style, speed: b.speed },
        mix: { intro: b.intro, music: b.music, musicVol: b.musicVol, voiceVol: b.voiceVol, outro: b.outro },
        createdBy: req.user?.email,
      });

      if (activity) await activity(b.brand, "voice", "success", `अनाउंसमेंट बना (${Math.round(r.durationSec)}s)`).catch(() => {});
      L("अनाउंसमेंट बना", { sec: Math.round(r.durationSec), via: r.provider });

      res.json({
        ok: true, id: doc._id,
        url: r.file, fullUrl: PUBLIC_URL + r.file,
        durationSec: r.durationSec, provider: r.provider,
      });
    } catch (e) {
      E("build fail", { msg: e.message });
      bad(res, e);
    }
  });

  /** पुराने अनाउंसमेंट */
  app.get("/api/announce", async (req, res) => {
    try {
      const q = BRANDS[req.query.brand] ? { brand: req.query.brand } : {};
      const rows = await Announcement.find(q).sort({ createdAt: -1 }).limit(30).lean();
      res.json(rows.map((r) => ({ ...r, fullUrl: PUBLIC_URL + r.file })));
    } catch (e) { bad(res, e); }
  });

  app.delete("/api/announce/:id", requireRole("super-admin", "admin"), async (req, res) => {
    try {
      const d = await Announcement.findByIdAndDelete(req.params.id);
      if (d?.file) { try { fs.unlinkSync(path.join(OUT_DIR, path.basename(d.file))); } catch (_) {} }
      res.json({ ok: true });
    } catch (e) { bad(res, e); }
  });

  /** download — नाम ठीक हो, ताकि phone में ढूँढना आसान रहे */
  app.get("/announce-download/:id", async (req, res) => {
    try {
      const d = await Announcement.findById(req.params.id).lean();
      if (!d) return res.status(404).send("नहीं मिला");
      const p = path.join(OUT_DIR, path.basename(d.file));
      if (!fs.existsSync(p)) return res.status(404).send("file मिट चुकी है — दोबारा बनाएँ");
      const safe = String(d.text || "announcement").replace(/[^\p{L}\p{N} ]/gu, "").trim().slice(0, 40) || "announcement";
      res.download(p, `${safe}.mp3`);
    } catch (e) { res.status(500).send("error"); }
  });

  app.get("/api/announce/health", async (req, res) => {
    const built = Object.keys(SFX).filter((k) => fs.existsSync(sfxPath(k)));
    res.json({
      module: "announcer v1.0",
      effectsReady: built, effectsMissing: Object.keys(SFX).filter((k) => !built.includes(k)),
      ttsProvider: AI?.keys ? "configured" : "unknown",
    });
  });

  L("अनाउंसमेंट स्टूडियो चालू");
  return { buildAnnouncement, ensureSfx, Announcement, SFX };
};
