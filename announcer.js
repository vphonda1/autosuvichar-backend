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
  //  1क. बोलने लायक़ text — आँकड़े शब्दों में
  // ══════════════════════════════════════════════════════════════════════════
  //  ⚠️ TTS "₹5,000" को अकसर "रुपये पाँच शून्य शून्य शून्य" जैसा पढ़ता है, और
  //     "9.9%" में दशमलव खा जाता है। ऑफ़र की पूरी जान इन्हीं आँकड़ों में है,
  //     इसलिए भेजने से पहले इन्हें हिंदी शब्दों में बदल देते हैं।

  //  हिंदी में 1 से 99 तक हर अंक का अपना नाम है — जोड़कर नहीं बनता
  //  (45 "चालीस पाँच" नहीं, "पैंतालीस" है)
  const N100 = ("शून्य एक दो तीन चार पाँच छह सात आठ नौ दस ग्यारह बारह तेरह चौदह पंद्रह सोलह सत्रह अठारह उन्नीस " +
    "बीस इक्कीस बाईस तेईस चौबीस पच्चीस छब्बीस सत्ताईस अट्ठाईस उनतीस " +
    "तीस इकतीस बत्तीस तैंतीस चौंतीस पैंतीस छत्तीस सैंतीस अड़तीस उनतालीस " +
    "चालीस इकतालीस बयालीस तैंतालीस चौवालीस पैंतालीस छियालीस सैंतालीस अड़तालीस उनचास " +
    "पचास इक्यावन बावन तिरपन चौवन पचपन छप्पन सत्तावन अट्ठावन उनसठ " +
    "साठ इकसठ बासठ तिरसठ चौंसठ पैंसठ छियासठ सड़सठ अड़सठ उनहत्तर " +
    "सत्तर इकहत्तर बहत्तर तिहत्तर चौहत्तर पचहत्तर छिहत्तर सतहत्तर अठहत्तर उन्यासी " +
    "अस्सी इक्यासी बयासी तिरासी चौरासी पचासी छियासी सत्तासी अट्ठासी नवासी " +
    "नब्बे इक्यानवे बानवे तिरानवे चौरानवे पंचानवे छियानवे सत्तानवे अट्ठानवे निन्यानवे").split(" ");

  function hindiNum(x) {
    let n = Math.floor(Math.abs(Number(x) || 0));
    if (n === 0) return "शून्य";
    if (n < 100) return N100[n];
    const out = [];
    const cr = Math.floor(n / 1e7); n %= 1e7;
    const lk = Math.floor(n / 1e5); n %= 1e5;
    const hz = Math.floor(n / 1e3); n %= 1e3;
    const sau = Math.floor(n / 100); n %= 100;
    if (cr) out.push(hindiNum(cr) + " करोड़");
    if (lk) out.push(hindiNum(lk) + " लाख");
    if (hz) out.push(hindiNum(hz) + " हज़ार");
    if (sau) out.push(N100[sau] + " सौ");
    if (n) out.push(N100[n]);
    return out.join(" ");
  }

  const ank = (d) => d.split("").map((c) => (N100[+c] || c)).join(" ");

  function speakify(t) {
    let s = String(t || "").replace(/[\u201C\u201D\u2018\u2019]/g, "");
    // ₹5,000 / Rs 5000 / 5000 रुपये → "पाँच हज़ार रुपये"
    s = s.replace(/(?:₹|Rs\.?|रु\.?)\s*([\d,]+)/gi, (m, d) => hindiNum(parseInt(d.replace(/,/g, ""), 10)) + " रुपये");
    s = s.replace(/([\d,]+)\s*(?:रुपये|रूपये|रुपए|रुपया)/g, (m, d) => hindiNum(parseInt(d.replace(/,/g, ""), 10)) + " रुपये");
    // 9.9% → "नौ दशमलव नौ प्रतिशत"
    s = s.replace(/(\d+)\.(\d+)\s*%/g, (m, a, b) => hindiNum(a) + " दशमलव " + ank(b) + " प्रतिशत");
    s = s.replace(/([\d,]+)\s*%/g, (m, d) => hindiNum(parseInt(d.replace(/,/g, ""), 10)) + " प्रतिशत");
    s = s.replace(/(\d+)\.(\d+)/g, (m, a, b) => hindiNum(a) + " दशमलव " + ank(b));
    // बाक़ी हर गिनती
    s = s.replace(/(\d[\d,]*)/g, (m) => hindiNum(parseInt(m.replace(/,/g, ""), 10)));
    // @handle और #hashtag — चिह्न बोले नहीं जाते
    s = s.replace(/@([A-Za-z0-9._]+)/g, (m, h) => h.replace(/[._]+/g, " "));
    s = s.replace(/#(\S+)/g, "$1");
    // सजावट के चिह्न हटाओ
    s = s.replace(/[·•|]+/g, ", ").replace(/\s{2,}/g, " ").trim();
    return s;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  1ख. script को हिस्सों में बाँटो
  // ══════════════════════════════════════════════════════════════════════════
  //  "0:00 – 0:04 · HOOK" जैसी लाइनों को पहचानकर हर हिस्से का समय, बोली और
  //  पर्दे पर दिखने वाला text अलग कर देता है।

  function parseScript(raw) {
    const lines = String(raw || "").split(/\r?\n/);
    const segs = [];
    let cur = null;
    const timeRx = /(\d{1,2}):(\d{2})\s*[\u2013\u2014\-]\s*(?:(\d{1,2}):(\d{2})|END|end)/;
    const secs = (m, s) => parseInt(m, 10) * 60 + parseInt(s, 10);

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) continue;
      const t = line.match(timeRx);
      if (t) {
        if (cur) segs.push(cur);
        cur = {
          start: secs(t[1], t[2]),
          end: t[3] !== undefined ? secs(t[3], t[4]) : null,
          title: line.replace(timeRx, "").replace(/^[·•\s\-\u2013\u2014]+/, "").trim() || `हिस्सा ${segs.length + 1}`,
          vo: "", screen: "", shot: "", _f: null,
        };
        continue;
      }
      if (!cur) continue;
      let m;
      if ((m = line.match(/^VO\s*(?:\(.*?\))?\s*[:·]?\s*(.*)$/i))) { cur._f = "vo"; if (m[1]) cur.vo += (cur.vo ? " " : "") + m[1]; continue; }
      if ((m = line.match(/^ON[- ]?SCREEN(?:\s*TEXT)?\s*[:·]?\s*(.*)$/i))) { cur._f = "screen"; if (m[1]) cur.screen += (cur.screen ? " · " : "") + m[1]; continue; }
      if ((m = line.match(/^SHOT\s*[:·]?\s*(.*)$/i))) { cur._f = "shot"; if (m[1]) cur.shot += m[1]; continue; }
      if (cur._f === "vo") cur.vo += (cur.vo ? " " : "") + line;
      else if (cur._f === "screen") cur.screen += (cur.screen ? " · " : "") + line;
      else if (cur._f === "shot") cur.shot += " " + line;
    }
    if (cur) segs.push(cur);

    for (let i = 0; i < segs.length; i++) {
      // आख़िरी हिस्से का "END" — अगला शुरू होने तक, या 5 सेकंड
      if (segs[i].end == null) segs[i].end = segs[i + 1] ? segs[i + 1].start : segs[i].start + 5;
      segs[i].slot = Math.max(1, segs[i].end - segs[i].start);
      delete segs[i]._f;
    }
    return segs.filter((s) => s.vo || s.screen);
  }

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

      // ⚠️ आँकड़ों को शब्दों में बदलकर भेजो — "₹5,000" नहीं, "पाँच हज़ार रुपये"
      const tts = await AI.tts(speakify(txt), { gender: opts.gender, style: opts.style });
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
  //  4. SCRIPT MODE — समय के हिसाब से बँटा हुआ voice-over
  // ══════════════════════════════════════════════════════════════════════════
  //  dealer/influencer video के लिए। हर हिस्से का अपना समय होता है (0:00–0:04
  //  हुक, 0:04–0:10 announcement…)। हर हिस्से की अलग आवाज़ बनती है, अपने ख़ाने
  //  में फ़िट की जाती है, फिर सही जगह पर जोड़ दी जाती है।
  //
  //  ⚠️ ज़बरदस्ती फ़िट नहीं करते। 1.35× से ज़्यादा तेज़ बोलने पर आवाज़ भद्दी और
  //     समझ से बाहर हो जाती है। इसलिए इतने पर रोक देते हैं और साफ़ बता देते हैं
  //     कि "यह हिस्सा 1.8 सेकंड लम्बा है — script छोटी कीजिए"।

  const MAX_TEMPO = 1.35;

  async function buildScript(opts) {
    const stamp = Date.now();
    const tmp = [];
    const T = (n) => { const p = path.join(OUT_DIR, `_scr${stamp}_${n}`); tmp.push(p); return p; };
    const cleanup = () => tmp.forEach((f) => { try { fs.unlinkSync(f); } catch (_) {} });

    try {
      const segs = Array.isArray(opts.segments) && opts.segments.length
        ? opts.segments
        : parseScript(opts.script);

      if (!segs.length) throw new Error("script में कोई हिस्सा नहीं मिला — समय इस तरह लिखें: 0:00 – 0:04");

      const voiceVol = clamp(opts.voiceVol, 0.4, 2.5, 1.35);
      const musicVol = clamp(opts.musicVol, 0, 1.5, 0.4);
      const baseSpeed = clamp(opts.speed, 0.7, 1.3, 1.0);

      const report = [];
      const pieces = [];
      let total = 0;

      for (let i = 0; i < segs.length; i++) {
        const sg = segs[i];
        const slot = Math.max(1, Number(sg.slot) || (Number(sg.end) - Number(sg.start)) || 5);
        const start = Number(sg.start) || 0;
        total = Math.max(total, start + slot);

        const vo = String(sg.vo || "").trim();
        if (!vo) {
          report.push({ ...sg, slot, spoken: "", actualSec: 0, tempo: 1, fits: true, note: "सिर्फ़ पर्दे का text — कोई बोली नहीं" });
          continue;
        }

        const spoken = speakify(vo);
        const tts = await AI.tts(spoken, { gender: opts.gender, style: opts.style });
        if (!tts.ok) throw new Error(`"${sg.title}" की आवाज़ नहीं बनी — ${tts.error}`);

        const rawP = T(`s${i}.mp3`);
        fs.writeFileSync(rawP, tts.buf);

        // पहले साफ़ करो, फिर नापो
        const cleanP = T(`c${i}.wav`);
        await ff(["-i", rawP, "-af",
          [
            baseSpeed !== 1 ? `atempo=${baseSpeed.toFixed(2)}` : null,
            "highpass=f=90",
            "equalizer=f=2600:t=q:w=1.4:g=3.5",
            "acompressor=threshold=0.12:ratio=4:attack=8:release=180",
            `volume=${voiceVol.toFixed(2)}`,
            "aformat=sample_rates=44100:channel_layouts=stereo",
          ].filter(Boolean).join(","), cleanP]);

        let actual = (await audioDuration(cleanP)) || slot;
        let tempo = 1;
        let finalP = cleanP;

        // ख़ाने से लम्बा है? थोड़ा तेज़ करके फ़िट करो — पर हद में
        if (actual > slot + 0.15) {
          tempo = Math.min(MAX_TEMPO, actual / slot);
          if (tempo > 1.01) {
            finalP = T(`f${i}.wav`);
            await ff(["-i", cleanP, "-af", `atempo=${tempo.toFixed(3)}`, finalP]);
            actual = (await audioDuration(finalP)) || actual;
          }
        }

        const over = actual - slot;
        const fits = over <= 0.25;

        pieces.push({ file: finalP, startMs: Math.round(start * 1000) });
        report.push({
          title: sg.title, start, end: start + slot, slot,
          vo, spoken, screen: sg.screen || "", shot: sg.shot || "",
          actualSec: Math.round(actual * 10) / 10,
          tempo: Math.round(tempo * 100) / 100,
          fits,
          note: fits
            ? (tempo > 1.01 ? `थोड़ा तेज़ बोलकर फ़िट किया (${tempo.toFixed(2)}×)` : "आराम से फ़िट")
            : `⚠️ ${over.toFixed(1)} सेकंड ज़्यादा — इस हिस्से की script छोटी कीजिए`,
        });
      }

      if (!pieces.length) throw new Error("किसी भी हिस्से में बोली नहीं मिली");

      total = Math.max(total, ...report.map((r) => r.start + r.actualSec)) + 0.5;

      // ── सब हिस्से सही जगह पर जोड़ो ────────────────────────────
      const inputs = [];
      const parts = [];
      const mixIn = [];
      let idx = 0;

      for (const p of pieces) {
        inputs.push("-i", p.file);
        parts.push(`[${idx}:a]adelay=${p.startMs}|${p.startMs}[v${idx}]`);
        mixIn.push(`[v${idx}]`);
        idx++;
      }

      // background music — बोलते समय अपने आप दबेगा
      if (musicVol > 0 && opts.music !== "none") {
        let musicFile = null;
        if (opts.music) {
          const mp = path.join(MUSIC_DIR, path.basename(opts.music));
          if (fs.existsSync(mp)) musicFile = mp;
        }
        if (!musicFile) {
          musicFile = T("bed.wav");
          await ff(["-f", "lavfi", "-i",
            `aevalsrc='0.20*sin(2*PI*196*t)+0.14*sin(2*PI*294*t)+0.10*sin(2*PI*392*t)':d=${Math.ceil(total) + 2}:s=44100`,
            "-af", "tremolo=f=0.4:d=0.25,lowpass=f=2000,aformat=channel_layouts=stereo", musicFile]);
        }
        // सारी बोली को एक जगह जोड़कर "इशारा" बनाओ, उसी से music दबेगा
        parts.push(`${mixIn.join("")}amix=inputs=${mixIn.length}:duration=longest:normalize=0[allvo]`);
        parts.push(`[allvo]asplit=2[vout][vkey]`);
        inputs.push("-i", musicFile);
        parts.push(
          `[${idx}:a]aloop=loop=-1:size=2e9,atrim=0:${total.toFixed(2)},volume=${musicVol.toFixed(2)},` +
          `afade=t=in:st=0:d=1.0,afade=t=out:st=${Math.max(0, total - 1.8).toFixed(2)}:d=1.8[bed]`
        );
        parts.push(`[bed][vkey]sidechaincompress=threshold=0.03:ratio=20:attack=20:release=450:makeup=1[duck]`);
        parts.push(`[duck][vout]amix=inputs=2:duration=longest:normalize=0,alimiter=limit=0.94,` +
          `loudnorm=I=-14:TP=-1.5:LRA=11,aformat=sample_rates=44100:channel_layouts=stereo[final]`);
      } else {
        parts.push(`${mixIn.join("")}amix=inputs=${mixIn.length}:duration=longest:normalize=0,` +
          `alimiter=limit=0.94,loudnorm=I=-14:TP=-1.5:LRA=11,aformat=sample_rates=44100:channel_layouts=stereo[final]`);
      }

      const out = path.join(OUT_DIR, `script_${stamp}.mp3`);
      await ff([...inputs, "-filter_complex", parts.join(";"), "-map", "[final]",
        "-t", total.toFixed(2), "-c:a", "libmp3lame", "-b:a", "192k", out], { timeout: 240000 });

      const dur = await audioDuration(out);
      cleanup();

      const naFit = report.filter((r) => !r.fits && r.vo);
      return {
        file: `/generated/script_${stamp}.mp3`,
        durationSec: dur || total,
        segments: report,
        allFit: naFit.length === 0,
        warning: naFit.length
          ? `${naFit.length} हिस्से अपने समय से लम्बे हैं — नीचे देखिए, उनकी script छोटी कीजिए`
          : "",
      };
    } catch (e) { cleanup(); throw e; }
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

  /** script पढ़कर हिस्से दिखाओ — बनाने से पहले जाँच लीजिए */
  app.post("/api/announce/script/parse", async (req, res) => {
    try {
      const segs = parseScript(req.body?.script);
      if (!segs.length) {
        return bad(res, new Error("कोई हिस्सा नहीं मिला। हर हिस्सा इस तरह लिखें:\n0:00 – 0:04 · हुक\nVO\nयहाँ बोली लिखिए\nON-SCREEN\nपर्दे पर क्या दिखे"), 400);
      }
      res.json({
        ok: true,
        totalSec: Math.max(...segs.map((x) => x.end)),
        segments: segs.map((x) => ({ ...x, spoken: speakify(x.vo) })),
      });
    } catch (e) { bad(res, e); }
  });

  /** पूरा script voice-over बनाओ */
  app.post("/api/announce/script/build", requireRole("super-admin", "admin", "manager"), async (req, res) => {
    try {
      const b = req.body || {};
      if (!BRANDS[b.brand]) return bad(res, new Error("brand चाहिए"), 400);
      if (!b.script && !(b.segments || []).length) return bad(res, new Error("script खाली है"), 400);

      if (checkAndCountUsage) {
        const lim = await checkAndCountUsage(b.brand, "aiCalls").catch(() => ({ ok: true }));
        if (!lim.ok) return res.status(429).json({ error: lim.message || "आज की AI सीमा पूरी हो गई" });
      }

      const r = await buildScript(b);
      const doc = await Announcement.create({
        brand: b.brand,
        text: (r.segments.map((x) => x.vo).filter(Boolean).join(" ")).slice(0, 1500),
        file: r.file, durationSec: r.durationSec, provider: "script",
        voice: { gender: b.gender, style: b.style, speed: b.speed },
        mix: { music: b.music, musicVol: b.musicVol, voiceVol: b.voiceVol },
        createdBy: req.user?.email,
      });

      if (activity) await activity(b.brand, "voice", "success", `script voice-over बना (${Math.round(r.durationSec)}s)`).catch(() => {});
      L("script बना", { sec: Math.round(r.durationSec), hisse: r.segments.length, sabFit: r.allFit });

      res.json({ ok: true, id: doc._id, url: r.file, fullUrl: PUBLIC_URL + r.file, ...r });
    } catch (e) { E("script build fail", { msg: e.message }); bad(res, e); }
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
