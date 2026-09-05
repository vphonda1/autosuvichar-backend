// ============================================================================
//  growth-engine.js  —  AutoSuVichar "Reach + Growth" module   (v1.0)
//  ---------------------------------------------------------------------------
//  यह एक drop-in module है। server.js की एक भी पुरानी line नहीं बदलती।
//
//  server.js के सबसे नीचे (app.listen से ठीक पहले) सिर्फ़ यह जोड़ें:
//
//      require("./growth-engine")(app, {
//        mongoose, Content, Delivery, Lead, Setting, Notification, ActivityLog,
//        brandCreds, loadSettings, log, requireRole, publish,
//        BRANDS, GRAPH, PUBLIC_URL, TEST_MODE, OUT_DIR,
//      });
//
//  ---------------------------------------------------------------------------
//  यह क्या-क्या जोड़ता है (और क्यों):
//
//  1. INSTAGRAM v2  — Reels / Carousel / Story
//     ⚠️ पुराने code में container बनाकर तुरन्त publish हो रहा था। Meta कहता है
//        पहले status_code = FINISHED का इंतज़ार करो। इसीलिए भारी image और हर
//        video fail होती थी। अब सही polling है।
//     ⚠️ media_type "VIDEO" अब single post के लिए बन्द है — "REELS" चाहिए।
//        Reels ही आज Instagram पर सबसे ज़्यादा नए (non-follower) लोगों तक
//        पहुँचती है — showroom के लिए यही सबसे बड़ा reach lever है।
//
//  2. GOOGLE BUSINESS PROFILE — "bike showroom near me" वाला ग्राहक
//     Bhopal में जो आदमी Google पर "Honda showroom भोपाल" खोजता है वो
//     Instagram पर नहीं है। GBP post सीधे Google Search + Maps में दिखता है।
//     यह अकेला feature walk-in बढ़ाने में Instagram से ज़्यादा असरदार है।
//
//  3. असली SCHEDULING — "कल सुबह 10:15 बजे यह post जाए"
//     अभी सिर्फ़ approve → तुरन्त भेजो था। अब हर post की अपनी तारीख़-समय।
//
//  4. LINK TRACKING + LEAD ATTRIBUTION
//     हर post में छोटा link (जैसे /r/a7k). कौन-सी post से कितने लोग आए और
//     उनमें से कितने lead बने — अब यह असली आँकड़ा मिलेगा, अंदाज़ा नहीं।
//
//  5. BEST TIME — आपके अपने पुराने आँकड़ों से "किस दिन, किस घंटे भेजें"
//
//  6. EVERGREEN — जो post 60 दिन पहले सबसे ज़्यादा चली, उसे फिर से भेजो
// ============================================================================

"use strict";

const cron = require("node-cron");

module.exports = function mountGrowthEngine(app, deps) {
  const {
    mongoose, Content, Delivery, Lead, Notification, ActivityLog,
    brandCreds, loadSettings, requireRole, publish,
    BRANDS = {}, GRAPH = "https://graph.facebook.com/v21.0",
    PUBLIC_URL = "http://localhost:5000",
    TEST_MODE = false,
  } = deps;

  const log = deps.log || ((lvl, msg, x) => console.log(`[${lvl}] ${msg}`, x || ""));
  const L = (msg, x) => log("INFO", "[growth] " + msg, x);
  const E = (msg, x) => log("ERROR", "[growth] " + msg, x);

  const model = (n, s) => mongoose.models[n] || mongoose.model(n, s);
  const oid = mongoose.Schema.Types.ObjectId;
  const ok = (res, d) => res.json(d);
  const bad = (res, e, code = 500) => res.status(code).json({ error: e.message || String(e) });

  // ══════════════════════════════════════════════════════════════════════════
  //  MODELS
  // ══════════════════════════════════════════════════════════════════════════

  // एक post कब जाए — Content/Delivery से अलग रखा है ताकि पुराना schema न छेड़ना पड़े
  const ScheduledPost = model("ScheduledPost", new mongoose.Schema({
    brand: { type: String, required: true, index: true },
    kind: { type: String, enum: ["content", "delivery"], default: "content" },
    refId: { type: oid, required: true, index: true },
    runAt: { type: Date, required: true, index: true },
    status: { type: String, enum: ["waiting", "running", "done", "failed", "cancelled"], default: "waiting", index: true },
    // कौन-कौन से platform — खाली छोड़ें तो post की अपनी setting चलेगी
    platforms: { fb: Boolean, ig: Boolean, yt: Boolean, wa: Boolean, gbp: Boolean },
    igFormat: { type: String, enum: ["auto", "feed", "reel", "carousel", "story"], default: "auto" },
    note: String,
    attempts: { type: Number, default: 0 },
    lastError: String,
    ranAt: Date,
    createdBy: String,
    lockedAt: Date,          // दो worker एक साथ न उठाएँ
  }, { timestamps: true }));

  // छोटा link — /r/a7k → आपकी असली website/WhatsApp, बीच में गिनती
  const ShortLink = model("ShortLink", new mongoose.Schema({
    code: { type: String, unique: true, required: true },
    brand: { type: String, index: true },
    target: { type: String, required: true },
    label: String,
    contentId: { type: oid, index: true },
    clicks: { type: Number, default: 0 },
    uniqueClicks: { type: Number, default: 0 },
    lastClickAt: Date,
    seenIps: [String],       // सिर्फ़ hash — पूरा IP नहीं रखते
    leadsFromThis: { type: Number, default: 0 },
    active: { type: Boolean, default: true },
  }, { timestamps: true }));

  // Google Business Profile की जोड़ी — किस brand का कौन-सा location
  const GbpConfig = model("GbpConfig", new mongoose.Schema({
    brand: { type: String, unique: true, required: true },
    accountId: String,       // accounts/1234567890
    locationId: String,      // locations/9876543210
    locationName: String,
    refreshToken: String,
    defaultCta: { type: String, default: "CALL" },
    defaultCtaUrl: String,
    lastPostAt: Date,
    lastError: String,
  }, { timestamps: true }));

  // Brand के तैयार hashtag सेट — caption साफ़ रहे, tags पहले comment में जाएँ
  const HashtagSet = model("HashtagSet", new mongoose.Schema({
    brand: { type: String, index: true },
    name: { type: String, default: "default" },
    tags: [String],
    useAsFirstComment: { type: Boolean, default: true },
  }, { timestamps: true }));

  // ══════════════════════════════════════════════════════════════════════════
  //  छोटे helpers
  // ══════════════════════════════════════════════════════════════════════════

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const abs = (u) => (!u ? "" : /^https?:\/\//i.test(u) ? u : PUBLIC_URL.replace(/\/$/, "") + (u.startsWith("/") ? u : "/" + u));
  const isBrand = (b) => !!BRANDS[b];
  const nowIST = () => new Date(Date.now() + (5.5 * 60 - new Date().getTimezoneOffset()) * 60000);

  function hashIp(ip) {
    // पूरा IP कभी save नहीं करते — सिर्फ़ छोटा fingerprint, unique गिनने भर को
    let h = 0; const s = String(ip || "") + "|asv";
    for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) | 0; }
    return "h" + Math.abs(h).toString(36);
  }

  async function activity(brand, action, detail) {
    try { if (ActivityLog) await ActivityLog.create({ brand, action, detail: String(detail || "").slice(0, 300) }); }
    catch (_) {}
  }
  async function notify(brand, type, message) {
    try { if (Notification) await Notification.create({ brand, type, message: String(message).slice(0, 300) }); }
    catch (_) {}
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  1. INSTAGRAM v2  — Feed / Reel / Carousel / Story
  // ══════════════════════════════════════════════════════════════════════════
  //  Meta का तरीक़ा हमेशा तीन क़दम का है:
  //    (क) container बनाओ  →  (ख) FINISHED होने तक रुको  →  (ग) publish करो
  //  पुराने code में (ख) था ही नहीं। इसीलिए बड़ी image और हर video अटकती थी।

  async function graph(path, params, method = "POST") {
    const url = `${GRAPH}/${path}`;
    const body = new URLSearchParams(
      Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ""))
    );
    const r = method === "GET"
      ? await fetch(url + "?" + body.toString())
      : await fetch(url, { method: "POST", body });
    const d = await r.json().catch(() => ({}));
    if (d.error) {
      const m = d.error.error_user_msg || d.error.message || "Meta error";
      const err = new Error(m);
      err.code = d.error.code; err.subcode = d.error.error_subcode;
      throw err;
    }
    return d;
  }

  // container तैयार है या नहीं — FINISHED आने तक रुको (Reels में 30–60s लग सकते हैं)
  async function igWaitReady(containerId, token, { tries = 30, gapMs = 4000 } = {}) {
    for (let i = 0; i < tries; i++) {
      const d = await graph(containerId, { fields: "status_code,status", access_token: token }, "GET");
      if (d.status_code === "FINISHED") return true;
      if (d.status_code === "ERROR" || d.status_code === "EXPIRED") {
        throw new Error(`IG ने media reject किया (${d.status_code}) — ${d.status || "video/image spec देखें"}`);
      }
      await sleep(gapMs);
    }
    throw new Error("IG media अब तक तैयार नहीं — बाद में दोबारा कोशिश करें");
  }

  /**
   * एक ही जगह से चारों तरह की IG post.
   * @param {object} c      brandCreds(brand)
   * @param {object} spec   { format, caption, imageUrl, imageUrls[], videoUrl, coverUrl, firstComment }
   */
  async function igPostSmart(c, spec) {
    if (!c.igUserId || !c.fbToken) throw new Error("IG creds missing — Settings में IG User ID व FB Token भरें");
    const token = c.fbToken;
    const igId = c.igUserId;
    const caption = String(spec.caption || "").slice(0, 2200);

    let format = spec.format || "auto";
    if (format === "auto") {
      if (spec.videoUrl) format = "reel";
      else if (Array.isArray(spec.imageUrls) && spec.imageUrls.length > 1) format = "carousel";
      else format = "feed";
    }

    let creationId;

    if (format === "reel") {
      if (!spec.videoUrl) throw new Error("Reel के लिए video चाहिए");
      // Reels = आज सबसे ज़्यादा reach. share_to_feed से feed में भी दिखेगी।
      const ct = await graph(`${igId}/media`, {
        media_type: "REELS",
        video_url: abs(spec.videoUrl),
        cover_url: spec.coverUrl ? abs(spec.coverUrl) : undefined,
        caption,
        share_to_feed: "true",
        access_token: token,
      });
      await igWaitReady(ct.id, token, { tries: 45, gapMs: 4000 });
      creationId = ct.id;

    } else if (format === "story") {
      // ⚠️ Story में caption नहीं जाता — Meta उसे अनदेखा करता है
      const isVid = !!spec.videoUrl;
      const ct = await graph(`${igId}/media`, {
        media_type: "STORIES",
        ...(isVid ? { video_url: abs(spec.videoUrl) } : { image_url: abs(spec.imageUrl) }),
        access_token: token,
      });
      await igWaitReady(ct.id, token, { tries: isVid ? 30 : 12 });
      creationId = ct.id;

    } else if (format === "carousel") {
      const urls = (spec.imageUrls || []).filter(Boolean).slice(0, 10);
      if (urls.length < 2) throw new Error("Carousel के लिए कम से कम 2 photo चाहिए");
      // हर photo का अपना container — caption इन पर नहीं, सिर्फ़ parent पर
      const childIds = [];
      for (const u of urls) {
        const ch = await graph(`${igId}/media`, {
          image_url: abs(u), is_carousel_item: "true", access_token: token,
        });
        childIds.push(ch.id);
      }
      for (const id of childIds) await igWaitReady(id, token, { tries: 12, gapMs: 2500 });
      const parent = await graph(`${igId}/media`, {
        media_type: "CAROUSEL",
        children: childIds.join(","),   // comma string — JSON array नहीं
        caption, access_token: token,
      });
      await igWaitReady(parent.id, token, { tries: 20 });
      creationId = parent.id;

    } else {
      if (!spec.imageUrl) throw new Error("IG feed post के लिए image चाहिए");
      const ct = await graph(`${igId}/media`, { image_url: abs(spec.imageUrl), caption, access_token: token });
      await igWaitReady(ct.id, token, { tries: 12, gapMs: 2500 });
      creationId = ct.id;
    }

    const pub = await graph(`${igId}/media_publish`, { creation_id: creationId, access_token: token });

    // Hashtags caption में भरने से post गन्दी दिखती है — पहले comment में डालो
    if (spec.firstComment && pub.id && format !== "story") {
      try { await graph(`${pub.id}/comments`, { message: String(spec.firstComment).slice(0, 2200), access_token: token }); }
      catch (e) { L("first comment नहीं गया: " + e.message); }
    }
    return { id: pub.id, format };
  }

  // Facebook Page पर video (Reel जैसा) — अभी सिर्फ़ photo जाता था
  async function fbPostVideo(c, spec) {
    if (!c.fbPageId || !c.fbToken) throw new Error("FB creds missing");
    const d = await graph(`${c.fbPageId}/videos`, {
      file_url: abs(spec.videoUrl),
      description: spec.caption || "",
      access_token: c.fbToken,
    });
    return d.id;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  2. GOOGLE BUSINESS PROFILE — Search + Maps में सीधा दिखना
  // ══════════════════════════════════════════════════════════════════════════
  //  ⚠️ इसके लिए Google से API access मंज़ूर करानी पड़ती है (कुछ दिन लगते हैं):
  //     https://developers.google.com/my-business/content/prereqs
  //     scope चाहिए: https://www.googleapis.com/auth/business.manage
  //     मंज़ूरी मिलने तक यह हिस्सा चुपचाप बन्द रहेगा, बाक़ी app चलता रहेगा।

  const GBP_BASE = "https://mybusiness.googleapis.com/v4";

  async function gbpAccessToken(refreshToken) {
    const r = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.GOOGLE_CLIENT_ID || "",
        client_secret: process.env.GOOGLE_CLIENT_SECRET || "",
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
    });
    const d = await r.json();
    if (!d.access_token) throw new Error("GBP token नहीं मिला — दोबारा connect करें");
    return d.access_token;
  }

  /**
   * Google पर local post.
   * @param {string} brand
   * @param {object} spec { summary, imageUrl, ctaType, ctaUrl, topicType, event, offer }
   */
  async function gbpPost(brand, spec) {
    const cfg = await GbpConfig.findOne({ brand });
    if (!cfg || !cfg.refreshToken || !cfg.accountId || !cfg.locationId) {
      throw new Error("Google Business जुड़ा नहीं — Settings → Google Business में connect करें");
    }
    const at = await gbpAccessToken(cfg.refreshToken);
    const b = BRANDS[brand] || {};

    const topicType = spec.topicType || "STANDARD";
    const body = {
      languageCode: "hi",
      summary: String(spec.summary || "").slice(0, 1500),
      topicType,
    };
    if (spec.imageUrl) body.media = [{ mediaFormat: "PHOTO", sourceUrl: abs(spec.imageUrl) }];

    const ctaType = spec.ctaType || cfg.defaultCta || "CALL";
    if (ctaType && ctaType !== "NONE") {
      body.callToAction = { actionType: ctaType };
      // CALL में url नहीं जाता — बाक़ी सब में ज़रूरी है
      if (ctaType !== "CALL") {
        body.callToAction.url = spec.ctaUrl || cfg.defaultCtaUrl
          || (b.whatsapp ? `https://wa.me/91${b.whatsapp}` : PUBLIC_URL);
      }
    }
    if (topicType === "OFFER" && spec.offer) {
      body.offer = {
        couponCode: spec.offer.couponCode || undefined,
        redeemOnlineUrl: spec.offer.url || undefined,
        termsConditions: spec.offer.terms || "शर्तें लागू। शोरूम पर सम्पर्क करें।",
      };
    }
    if (topicType === "EVENT" && spec.event) body.event = spec.event;

    const r = await fetch(`${GBP_BASE}/${cfg.accountId}/${cfg.locationId}/localPosts`, {
      method: "POST",
      headers: { Authorization: "Bearer " + at, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok || d.error) {
      const msg = d.error?.message || `GBP HTTP ${r.status}`;
      await GbpConfig.updateOne({ brand }, { lastError: msg });
      throw new Error("Google Business: " + msg);
    }
    await GbpConfig.updateOne({ brand }, { lastPostAt: new Date(), lastError: "" });
    return d.name || "posted";
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  3. एक post → सब जगह  (पुराने publish() के ऊपर, उसे बदले बिना)
  // ══════════════════════════════════════════════════════════════════════════

  function pickMedia(item) {
    const img = item.imgUrl || item.images?.square || item.images?.landscape || "";
    return {
      imageUrl: img,
      storyUrl: item.images?.story || img,
      videoUrl: item.video || "",
      imageUrls: [item.images?.square, item.images?.landscape].filter(Boolean),
    };
  }

  async function publishSmart(item, opts = {}) {
    await loadSettings();
    const c = brandCreds(item.brand);
    const m = pickMedia(item);
    const want = { ...(item.platforms || {}), ...(opts.platforms || {}) };
    const results = [];

    const hs = await HashtagSet.findOne({ brand: item.brand }).lean();
    const firstComment = hs?.useAsFirstComment && hs.tags?.length ? hs.tags.join(" ") : "";

    // caption में tracking link — कौन-सी post से कौन आया, यह इसी से पता चलेगा
    let caption = item.text || "";
    if (opts.trackLink) caption += `\n\n👉 ${opts.trackLink}`;

    const run = async (name, fn) => {
      try {
        if (TEST_MODE) { results.push({ platform: name, ok: true, test: true }); return; }
        const id = await fn();
        results.push({ platform: name, ok: true, id });
      } catch (e) {
        E(`${name} fail`, { msg: e.message });
        results.push({ platform: name, ok: false, error: e.message });
      }
    };

    if (want.ig) {
      const fmt = opts.igFormat && opts.igFormat !== "auto"
        ? opts.igFormat
        : (m.videoUrl ? "reel" : "feed");
      await run("ig", async () => {
        const r = await igPostSmart(c, {
          format: fmt, caption, firstComment,
          imageUrl: fmt === "story" ? m.storyUrl : m.imageUrl,
          imageUrls: m.imageUrls, videoUrl: m.videoUrl,
          coverUrl: m.imageUrl,
        });
        return r.id;
      });
      // Feed post गया तो Story भी डाल दो — मुफ़्त में दुगनी नज़र
      if (opts.alsoStory && fmt !== "story") {
        await run("ig_story", () =>
          igPostSmart(c, { format: "story", imageUrl: m.storyUrl, videoUrl: "" }).then((r) => r.id));
      }
    }

    if (want.fb && m.videoUrl) await run("fb_video", () => fbPostVideo(c, { videoUrl: m.videoUrl, caption }));

    if (want.gbp) {
      await run("gbp", () => gbpPost(item.brand, {
        summary: (item.text || "").slice(0, 1400),
        imageUrl: m.imageUrl,
        ctaType: opts.gbpCta || "CALL",
        ctaUrl: opts.trackLink,
        topicType: opts.gbpTopic || "STANDARD",
        offer: opts.gbpOffer,
      }));
    }

    // FB photo, YouTube, WhatsApp — पुराना भरोसेमन्द रास्ता ही चलता रहे
    const legacy = { fb: !!want.fb && !m.videoUrl, ig: false, yt: !!want.yt, wa: !!want.wa };
    if (legacy.fb || legacy.yt || legacy.wa) {
      try {
        const r = await publish({ ...item, text: caption, platforms: legacy });
        results.push(...r);
      } catch (e) { results.push({ platform: "legacy", ok: false, error: e.message }); }
    }
    return results;
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  4. SCHEDULER — हर मिनट देखो, जिसका समय आ गया उसे भेजो
  // ══════════════════════════════════════════════════════════════════════════

  async function runDueSchedules() {
    const now = new Date();
    // 10 मिनट से अटका हुआ lock छोड़ दो (server restart की सूरत में)
    await ScheduledPost.updateMany(
      { status: "running", lockedAt: { $lt: new Date(Date.now() - 10 * 60000) } },
      { status: "waiting", lockedAt: null }
    );

    const due = await ScheduledPost.find({ status: "waiting", runAt: { $lte: now } })
      .sort({ runAt: 1 }).limit(5);

    for (const s of due) {
      // एक ही समय दो जगह से न उठे
      const claim = await ScheduledPost.findOneAndUpdate(
        { _id: s._id, status: "waiting" },
        { status: "running", lockedAt: new Date(), $inc: { attempts: 1 } },
        { new: true }
      );
      if (!claim) continue;

      try {
        const Coll = claim.kind === "delivery" ? Delivery : Content;
        const item = await Coll.findById(claim.refId);
        if (!item) throw new Error("post मिला ही नहीं — शायद delete हो गया");
        if (item.status === "sent") throw new Error("यह पहले ही भेजा जा चुका है");

        const link = await ShortLink.findOne({ contentId: claim.refId, active: true }).lean();
        const platforms = Object.fromEntries(
          Object.entries(claim.platforms || {}).filter(([, v]) => v !== undefined && v !== null)
        );

        const results = await publishSmart(item, {
          platforms: Object.keys(platforms).length ? platforms : undefined,
          igFormat: claim.igFormat,
          trackLink: link ? `${PUBLIC_URL}/r/${link.code}` : "",
          alsoStory: true,
        });

        const anyOk = results.some((r) => r.ok);
        item.status = anyOk ? "sent" : "failed";
        item.sentAt = new Date();
        item.channels = results.filter((r) => r.ok).map((r) => r.platform);
        item.results = results;
        if (!anyOk) item.error = results.map((r) => r.error).filter(Boolean).join(" | ");
        await item.save();

        claim.status = anyOk ? "done" : "failed";
        claim.ranAt = new Date();
        claim.lastError = anyOk ? "" : item.error;
        claim.lockedAt = null;
        await claim.save();

        await activity(claim.brand, "publish", `समय पर भेजा — ${item.channels.join(", ") || "कहीं नहीं"}`);
        if (!anyOk) await notify(claim.brand, "schedule_failed", `⏰ तय समय पर post नहीं गई: ${claim.lastError}`);
        L(`scheduled post ${anyOk ? "गई" : "fail"} — ${claim.refId}`);

      } catch (e) {
        claim.status = claim.attempts >= 3 ? "failed" : "waiting";
        claim.runAt = claim.attempts >= 3 ? claim.runAt : new Date(Date.now() + 5 * 60000);
        claim.lastError = e.message;
        claim.lockedAt = null;
        await claim.save();
        E("schedule error", { id: String(claim._id), msg: e.message });
        if (claim.status === "failed") await notify(claim.brand, "schedule_failed", `⏰ post नहीं गई: ${e.message}`);
      }
    }
  }

  cron.schedule("* * * * *", () => { runDueSchedules().catch((e) => E("scheduler crash", { msg: e.message })); });

  // ══════════════════════════════════════════════════════════════════════════
  //  5. BEST TIME — अंदाज़ा नहीं, आपके अपने आँकड़े
  // ══════════════════════════════════════════════════════════════════════════

  const DAY_HI = ["रविवार", "सोमवार", "मंगलवार", "बुधवार", "गुरुवार", "शुक्रवार", "शनिवार"];

  async function bestTimes(brand, days = 90) {
    const q = { status: "sent", sentAt: { $gte: new Date(Date.now() - days * 864e5) } };
    if (isBrand(brand)) q.brand = brand;
    const docs = await Content.find(q).select("sentAt insights").lean();

    const cells = {};   // "day-hour" → { n, score }
    for (const d of docs) {
      if (!d.sentAt) continue;
      // IST में देखो — server UTC पर चलता है
      const ist = new Date(new Date(d.sentAt).getTime() + 5.5 * 3600000);
      const key = `${ist.getUTCDay()}-${ist.getUTCHours()}`;
      const score = (d.insights?.engagement || 0) * 3 + (d.insights?.total || 0);
      cells[key] = cells[key] || { n: 0, score: 0 };
      cells[key].n++; cells[key].score += score;
    }

    const ranked = Object.entries(cells)
      .map(([k, v]) => {
        const [day, hour] = k.split("-").map(Number);
        return { day, hour, posts: v.n, avg: Math.round(v.score / v.n) };
      })
      .filter((x) => x.posts >= 2)
      .sort((a, b) => b.avg - a.avg);

    // आँकड़े कम हों तो दोपहिया-ग्राहक की आम आदत से सुझाव
    const fallback = [
      { day: 0, hour: 11, why: "रविवार सुबह — परिवार साथ में showroom आता है" },
      { day: 6, hour: 19, why: "शनिवार शाम — हफ़्ते की ख़रीदारी का समय" },
      { day: 5, hour: 20, why: "शुक्रवार रात — weekend की योजना बनती है" },
      { day: 2, hour: 13, why: "दोपहर का खाली समय — फ़ोन सबसे ज़्यादा चलता है" },
    ];

    const enough = ranked.length >= 4;
    const top = (enough ? ranked.slice(0, 4) : fallback).map((x) => ({
      day: x.day, hour: x.hour,
      label: `${DAY_HI[x.day]} ${String(x.hour).padStart(2, "0")}:00`,
      posts: x.posts || 0, avg: x.avg || 0,
      why: x.why || `पिछली ${x.posts} posts का औसत सबसे ऊँचा`,
    }));

    return {
      basedOnRealData: enough,
      sampleSize: docs.length,
      top,
      worst: enough ? ranked.slice(-2).map((x) => `${DAY_HI[x.day]} ${x.hour}:00`) : [],
      note: enough ? "" : "अभी आपके अपने आँकड़े कम हैं — 20–30 posts के बाद यह सुझाव आपके ग्राहकों के हिसाब से बदल जाएगा",
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  //  ROUTES
  // ══════════════════════════════════════════════════════════════════════════

  // ── PUBLIC: छोटा link → असली जगह (login के बाहर, /api/ से बाहर) ──────────
  app.get("/r/:code", async (req, res) => {
    try {
      const sl = await ShortLink.findOne({ code: req.params.code, active: true });
      if (!sl) return res.redirect(302, PUBLIC_URL);

      const fp = hashIp(req.headers["x-forwarded-for"] || req.ip);
      const isNew = !sl.seenIps.includes(fp);
      const inc = { clicks: 1, ...(isNew ? { uniqueClicks: 1 } : {}) };
      const upd = { $inc: inc, lastClickAt: new Date() };
      if (isNew) upd.$push = { seenIps: { $each: [fp], $slice: -500 } };
      await ShortLink.updateOne({ _id: sl._id }, upd);

      // UTM जोड़ो ताकि आपकी website के Google Analytics में भी दिखे
      const u = new URL(sl.target);
      if (!u.searchParams.has("utm_source")) {
        u.searchParams.set("utm_source", "autosuvichar");
        u.searchParams.set("utm_medium", "social");
        u.searchParams.set("utm_campaign", sl.label || sl.brand || "post");
        u.searchParams.set("utm_content", sl.code);
      }
      res.redirect(302, u.toString());
    } catch (e) { res.redirect(302, PUBLIC_URL); }
  });

  // ── SCHEDULING ────────────────────────────────────────────────────────────
  app.post("/api/schedule", requireRole("super-admin", "admin", "manager"), async (req, res) => {
    try {
      const { brand, refId, kind = "content", runAt, platforms, igFormat, note } = req.body;
      if (!isBrand(brand)) return bad(res, new Error("brand ग़लत है"), 400);
      if (!refId || !runAt) return bad(res, new Error("post और समय दोनों चाहिए"), 400);
      const when = new Date(runAt);
      if (isNaN(when)) return bad(res, new Error("समय समझ नहीं आया"), 400);
      if (when < new Date(Date.now() - 60000)) return bad(res, new Error("बीता हुआ समय नहीं चुन सकते"), 400);

      const s = await ScheduledPost.create({
        brand, kind, refId, runAt: when, platforms, igFormat: igFormat || "auto",
        note, createdBy: req.user?.email,
      });
      await activity(brand, "schedule", `${when.toLocaleString("hi-IN")} के लिए तय हुआ`);
      ok(res, s);
    } catch (e) { bad(res, e); }
  });

  app.get("/api/schedule", async (req, res) => {
    try {
      const q = {};
      if (isBrand(req.query.brand)) q.brand = req.query.brand;
      if (req.query.status) q.status = { $in: String(req.query.status).split(",") };
      ok(res, await ScheduledPost.find(q).sort({ runAt: 1 }).limit(200).lean());
    } catch (e) { bad(res, e); }
  });

  app.patch("/api/schedule/:id", requireRole("super-admin", "admin", "manager"), async (req, res) => {
    try {
      const patch = {};
      if (req.body.runAt) patch.runAt = new Date(req.body.runAt);
      if (req.body.platforms) patch.platforms = req.body.platforms;
      if (req.body.igFormat) patch.igFormat = req.body.igFormat;
      if (req.body.status === "cancelled") patch.status = "cancelled";
      const s = await ScheduledPost.findByIdAndUpdate(req.params.id, patch, { new: true });
      if (!s) return bad(res, new Error("नहीं मिला"), 404);
      ok(res, s);
    } catch (e) { bad(res, e); }
  });

  app.delete("/api/schedule/:id", requireRole("super-admin", "admin"), async (req, res) => {
    try { await ScheduledPost.findByIdAndDelete(req.params.id); ok(res, { ok: true }); }
    catch (e) { bad(res, e); }
  });

  // अभी चला दो — इंतज़ार मत करो
  app.post("/api/schedule/run-now", requireRole("super-admin", "admin"), async (req, res) => {
    try { await runDueSchedules(); ok(res, { ok: true }); } catch (e) { bad(res, e); }
  });

  // ── CALENDAR — एक महीना, एक नज़र ─────────────────────────────────────────
  app.get("/api/calendar", async (req, res) => {
    try {
      const from = req.query.from ? new Date(req.query.from) : new Date(Date.now() - 7 * 864e5);
      const to = req.query.to ? new Date(req.query.to) : new Date(Date.now() + 30 * 864e5);
      const brand = isBrand(req.query.brand) ? req.query.brand : null;

      const bq = brand ? { brand } : {};
      const [scheduled, posted, waiting] = await Promise.all([
        ScheduledPost.find({ ...bq, status: { $in: ["waiting", "running"] }, runAt: { $gte: from, $lte: to } }).lean(),
        Content.find({ ...bq, status: { $in: ["sent", "failed"] }, sentAt: { $gte: from, $lte: to } })
          .select("brand type text images sentAt status channels insights").sort({ sentAt: -1 }).limit(300).lean(),
        Content.find({ ...bq, status: "pending" }).select("brand type text images createdAt").limit(100).lean(),
      ]);

      const refIds = scheduled.map((s) => s.refId);
      const refs = await Content.find({ _id: { $in: refIds } })
        .select("text images type brand").lean();
      const refMap = Object.fromEntries(refs.map((r) => [String(r._id), r]));

      const events = [
        ...scheduled.map((s) => ({
          id: String(s._id), kind: "scheduled", at: s.runAt, brand: s.brand,
          text: refMap[String(s.refId)]?.text || s.note || "तय की गई post",
          img: refMap[String(s.refId)]?.images?.square || null,
          type: refMap[String(s.refId)]?.type, refId: String(s.refId),
          igFormat: s.igFormat, platforms: s.platforms,
        })),
        ...posted.map((p) => ({
          id: String(p._id), kind: p.status === "sent" ? "sent" : "failed", at: p.sentAt,
          brand: p.brand, text: p.text, img: p.images?.square || null, type: p.type,
          channels: p.channels || [],
          views: p.insights?.total || 0, engagement: p.insights?.engagement || 0,
        })),
      ].sort((a, b) => new Date(a.at) - new Date(b.at));

      // किस दिन कुछ भी तय नहीं — वही असली मौक़ा है
      const busy = new Set(events.filter((e) => e.kind !== "failed").map((e) => new Date(e.at).toISOString().slice(0, 10)));
      const gaps = [];
      for (let d = new Date(); d <= to; d = new Date(d.getTime() + 864e5)) {
        const k = d.toISOString().slice(0, 10);
        if (!busy.has(k)) gaps.push(k);
      }

      ok(res, {
        from, to, events,
        pendingCount: waiting.length,
        pending: waiting.slice(0, 20).map((p) => ({
          id: String(p._id), text: p.text, img: p.images?.square || null, type: p.type, brand: p.brand,
        })),
        emptyDays: gaps.slice(0, 14),
        bestTimes: await bestTimes(brand, 90),
      });
    } catch (e) { bad(res, e); }
  });

  app.get("/api/best-times", async (req, res) => {
    try { ok(res, await bestTimes(isBrand(req.query.brand) ? req.query.brand : null, Number(req.query.days) || 90)); }
    catch (e) { bad(res, e); }
  });

  // ── SHORT LINKS + ATTRIBUTION ─────────────────────────────────────────────
  function newCode() {
    const a = "abcdefghjkmnpqrstuvwxyz23456789";
    return Array.from({ length: 5 }, () => a[Math.floor(Math.random() * a.length)]).join("");
  }

  app.post("/api/links", requireRole("super-admin", "admin", "manager"), async (req, res) => {
    try {
      const { brand, target, label, contentId } = req.body;
      const b = BRANDS[brand] || {};
      const dest = target || (b.whatsapp
        ? `https://wa.me/91${b.whatsapp}?text=${encodeURIComponent(`नमस्ते, मुझे ${b.name || "आपकी"} गाड़ी की जानकारी चाहिए`)}`
        : PUBLIC_URL);
      let code, tries = 0;
      do { code = newCode(); tries++; } while (await ShortLink.exists({ code }) && tries < 8);
      const sl = await ShortLink.create({ code, brand, target: dest, label, contentId: contentId || undefined });
      ok(res, { ...sl.toObject(), url: `${PUBLIC_URL}/r/${code}` });
    } catch (e) { bad(res, e); }
  });

  app.get("/api/links", async (req, res) => {
    try {
      const q = isBrand(req.query.brand) ? { brand: req.query.brand } : {};
      const rows = await ShortLink.find(q).sort({ createdAt: -1 }).limit(100)
        .select("-seenIps").lean();
      ok(res, rows.map((r) => ({ ...r, url: `${PUBLIC_URL}/r/${r.code}` })));
    } catch (e) { bad(res, e); }
  });

  // कौन-सी post से असल में ग्राहक आया — यही सबसे ज़रूरी सवाल है
  app.get("/api/attribution", async (req, res) => {
    try {
      const brand = isBrand(req.query.brand) ? req.query.brand : null;
      const days = Math.min(Number(req.query.days) || 30, 180);
      const since = new Date(Date.now() - days * 864e5);

      const links = await ShortLink.find({ ...(brand ? { brand } : {}), createdAt: { $gte: since } })
        .select("-seenIps").lean();
      const cIds = links.map((l) => l.contentId).filter(Boolean);
      const contents = await Content.find({ _id: { $in: cIds } })
        .select("text type images sentAt insights").lean();
      const cMap = Object.fromEntries(contents.map((c) => [String(c._id), c]));

      const rows = links.map((l) => {
        const c = l.contentId ? cMap[String(l.contentId)] : null;
        const views = c?.insights?.total || 0;
        return {
          code: l.code, url: `${PUBLIC_URL}/r/${l.code}`, label: l.label,
          post: c ? String(c.text || "").slice(0, 90) : (l.label || "—"),
          img: c?.images?.square || null,
          sentAt: c?.sentAt || l.createdAt,
          views, clicks: l.clicks, uniqueClicks: l.uniqueClicks,
          leads: l.leadsFromThis,
          ctr: views ? +((l.clicks / views) * 100).toFixed(1) : null,
        };
      }).sort((a, b) => (b.leads - a.leads) || (b.clicks - a.clicks));

      const totalLeads = await Lead.countDocuments({ ...(brand ? { brand } : {}), createdAt: { $gte: since } });
      const tracked = rows.reduce((a, r) => a + r.leads, 0);

      ok(res, {
        days, rows: rows.slice(0, 40),
        totals: {
          clicks: rows.reduce((a, r) => a + r.clicks, 0),
          uniqueClicks: rows.reduce((a, r) => a + r.uniqueClicks, 0),
          leadsTracked: tracked, leadsAll: totalLeads,
          untracked: Math.max(0, totalLeads - tracked),
        },
        best: rows[0] || null,
        note: rows.length ? "" : "अभी कोई tracking link नहीं बना — post भेजते समय link जोड़ें, तभी यह हिसाब बनेगा",
      });
    } catch (e) { bad(res, e); }
  });

  // ── GOOGLE BUSINESS PROFILE ───────────────────────────────────────────────
  app.get("/api/gbp/:brand", requireRole("super-admin", "admin"), async (req, res) => {
    try {
      const c = await GbpConfig.findOne({ brand: req.params.brand }).lean();
      ok(res, c
        ? { ...c, refreshToken: c.refreshToken ? "••••set" : "" }
        : { brand: req.params.brand, connected: false });
    } catch (e) { bad(res, e); }
  });

  app.put("/api/gbp/:brand", requireRole("super-admin", "admin"), async (req, res) => {
    try {
      const { accountId, locationId, locationName, refreshToken, defaultCta, defaultCtaUrl } = req.body;
      const patch = { accountId, locationId, locationName, defaultCta, defaultCtaUrl };
      if (refreshToken && refreshToken !== "••••set") patch.refreshToken = refreshToken;
      Object.keys(patch).forEach((k) => patch[k] === undefined && delete patch[k]);
      const c = await GbpConfig.findOneAndUpdate({ brand: req.params.brand }, patch, { new: true, upsert: true });
      ok(res, { ...c.toObject(), refreshToken: c.refreshToken ? "••••set" : "" });
    } catch (e) { bad(res, e); }
  });

  // Google से location की सूची — भरने में ग़लती न हो
  app.get("/api/gbp/:brand/locations", requireRole("super-admin", "admin"), async (req, res) => {
    try {
      const cfg = await GbpConfig.findOne({ brand: req.params.brand });
      if (!cfg?.refreshToken) return bad(res, new Error("पहले Google से connect करें"), 400);
      const at = await gbpAccessToken(cfg.refreshToken);
      const ar = await (await fetch("https://mybusinessaccountmanagement.googleapis.com/v1/accounts", {
        headers: { Authorization: "Bearer " + at },
      })).json();
      const accounts = ar.accounts || [];
      const out = [];
      for (const a of accounts.slice(0, 5)) {
        const lr = await (await fetch(
          `https://mybusinessbusinessinformation.googleapis.com/v1/${a.name}/locations?readMask=name,title,storefrontAddress`,
          { headers: { Authorization: "Bearer " + at } }
        )).json();
        for (const l of lr.locations || []) {
          out.push({ accountId: a.name, locationId: l.name, title: l.title });
        }
      }
      ok(res, { accounts: accounts.length, locations: out });
    } catch (e) { bad(res, e); }
  });

  app.post("/api/gbp/:brand/post", requireRole("super-admin", "admin", "manager"), async (req, res) => {
    try {
      const name = await gbpPost(req.params.brand, req.body);
      await activity(req.params.brand, "publish", "Google Business पर post गई");
      ok(res, { ok: true, name });
    } catch (e) { bad(res, e); }
  });

  // ── HASHTAG SETS ──────────────────────────────────────────────────────────
  app.get("/api/hashtag-sets", async (req, res) => {
    try {
      const q = isBrand(req.query.brand) ? { brand: req.query.brand } : {};
      ok(res, await HashtagSet.find(q).lean());
    } catch (e) { bad(res, e); }
  });

  app.put("/api/hashtag-sets/:brand", requireRole("super-admin", "admin"), async (req, res) => {
    try {
      const tags = (req.body.tags || []).map((t) => (t.startsWith("#") ? t : "#" + t)).slice(0, 30);
      const s = await HashtagSet.findOneAndUpdate(
        { brand: req.params.brand, name: req.body.name || "default" },
        { tags, useAsFirstComment: req.body.useAsFirstComment !== false },
        { new: true, upsert: true }
      );
      ok(res, s);
    } catch (e) { bad(res, e); }
  });

  // ── EVERGREEN — जो चला था उसे दोबारा चलाओ ────────────────────────────────
  app.get("/api/evergreen", async (req, res) => {
    try {
      const brand = isBrand(req.query.brand) ? req.query.brand : null;
      const minAge = Number(req.query.minAgeDays) || 45;
      const q = {
        status: "sent",
        sentAt: { $lte: new Date(Date.now() - minAge * 864e5) },
        insights: { $ne: null },
        ...(brand ? { brand } : {}),
      };
      const docs = await Content.find(q).select("brand type text images sentAt insights").lean();
      const rows = docs
        .map((d) => ({
          id: String(d._id), brand: d.brand, type: d.type,
          text: String(d.text || "").slice(0, 110),
          img: d.images?.square || null, sentAt: d.sentAt,
          score: (d.insights?.engagement || 0) * 3 + (d.insights?.total || 0),
          ageDays: Math.round((Date.now() - new Date(d.sentAt)) / 864e5),
        }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 15);
      ok(res, {
        rows,
        note: rows.length
          ? "ये posts पहले सबसे अच्छी चली थीं — नई तारीख़ के साथ दोबारा भेज सकते हैं"
          : "अभी दोहराने लायक़ पुरानी post नहीं मिली — पहले Analytics में 'refresh' दबाकर असली आँकड़े लाएँ",
      });
    } catch (e) { bad(res, e); }
  });

  // पुरानी अच्छी post की नक़ल बनाकर नई तारीख़ पर तय कर दो
  app.post("/api/evergreen/:id/reschedule", requireRole("super-admin", "admin", "manager"), async (req, res) => {
    try {
      const src = await Content.findById(req.params.id).lean();
      if (!src) return bad(res, new Error("पुरानी post नहीं मिली"), 404);
      const { _id, createdAt, updatedAt, sentAt, insights, insightsAt, results, channels,
        publishedKey, publishLock, attempts, error, ...rest } = src;
      const copy = await Content.create({ ...rest, status: "pending", triggeredBy: "evergreen" });
      const runAt = req.body.runAt ? new Date(req.body.runAt) : new Date(Date.now() + 864e5);
      const s = await ScheduledPost.create({
        brand: src.brand, kind: "content", refId: copy._id, runAt,
        igFormat: "auto", note: "पुरानी hit post दोबारा", createdBy: req.user?.email,
      });
      ok(res, { contentId: copy._id, schedule: s });
    } catch (e) { bad(res, e); }
  });

  // ── एक post → हर platform का सही रूप (manual trigger) ────────────────────
  app.post("/api/publish-smart/:kind/:id", requireRole("super-admin", "admin", "manager"), async (req, res) => {
    try {
      const Coll = req.params.kind === "delivery" ? Delivery : Content;
      const item = await Coll.findById(req.params.id);
      if (!item) return bad(res, new Error("post नहीं मिली"), 404);

      let trackLink = "";
      if (req.body.withLink !== false) {
        let sl = await ShortLink.findOne({ contentId: item._id, active: true });
        if (!sl) {
          const b = BRANDS[item.brand] || {};
          let code, t = 0;
          do { code = newCode(); t++; } while (await ShortLink.exists({ code }) && t < 8);
          sl = await ShortLink.create({
            code, brand: item.brand, contentId: item._id,
            label: (item.text || "").slice(0, 40),
            target: b.whatsapp
              ? `https://wa.me/91${b.whatsapp}?text=${encodeURIComponent("नमस्ते, मुझे जानकारी चाहिए")}`
              : PUBLIC_URL,
          });
        }
        trackLink = `${PUBLIC_URL}/r/${sl.code}`;
      }

      const results = await publishSmart(item, {
        platforms: req.body.platforms,
        igFormat: req.body.igFormat || "auto",
        alsoStory: req.body.alsoStory !== false,
        gbpCta: req.body.gbpCta,
        gbpTopic: req.body.gbpTopic,
        trackLink,
      });

      const anyOk = results.some((r) => r.ok);
      item.status = anyOk ? "sent" : "failed";
      item.sentAt = new Date();
      item.channels = results.filter((r) => r.ok).map((r) => r.platform);
      item.results = results;
      await item.save();
      ok(res, { results, trackLink, status: item.status });
    } catch (e) { bad(res, e); }
  });

  // ── इस module की सेहत ─────────────────────────────────────────────────────
  app.get("/api/growth/health", async (req, res) => {
    try {
      const [waiting, links, gbp] = await Promise.all([
        ScheduledPost.countDocuments({ status: "waiting" }),
        ShortLink.countDocuments({ active: true }),
        GbpConfig.countDocuments({ refreshToken: { $ne: null } }),
      ]);
      ok(res, {
        module: "growth-engine v1.0",
        features: ["ig-reels", "ig-carousel", "ig-story", "ig-container-polling",
                   "google-business", "real-scheduling", "link-attribution",
                   "best-times", "evergreen", "hashtag-first-comment"],
        scheduledWaiting: waiting, activeLinks: links, gbpConnected: gbp,
        googleOAuthReady: !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET),
      });
    } catch (e) { bad(res, e); }
  });

  L("Growth engine चालू — scheduler हर मिनट देखेगा");

  // दूसरी जगहों (जैसे lead आने पर attribution) के लिए बाहर दे दो
  return { ScheduledPost, ShortLink, GbpConfig, HashtagSet, publishSmart, igPostSmart, gbpPost, bestTimes, runDueSchedules };
};
