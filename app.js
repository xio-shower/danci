(() => {
  "use strict";

  const DEFAULT_SHEET_ID = "1Ho3WWDmm6kod9JoKVz87UOcsje7fBaWclRo2QbGO9-c";
  const DEFAULT_GID = "0";

  const STORAGE_KEYS = {
    CONFIG: "danci_sheet_config_v1",
    CACHE: "danci_vocab_cache_v1",
    PROGRESS: "danci_learning_progress_v2",
    PREFS: "danci_user_prefs_v2",
    TTS_CONFIG: "danci_tts_config_v1",
    DAILY_SESSION: "danci_daily_session_v1",
  };

  // --- SVG Icons ---
  const ICONS = {
    speaker: `<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z"/></svg>`,
    mic: `<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M12 18.75a6 6 0 006-6v-1.5m-6 7.5a6 6 0 01-6-6v-1.5m6 7.5v3.75m-3.75 0h7.5M12 15.75a3 3 0 01-3-3V4.5a3 3 0 116 0v8.25a3 3 0 01-3 3z"/></svg>`,
    checkCircle: `<svg fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>`,
    eyeOff: `<path stroke-linecap="round" stroke-linejoin="round" d="M3.98 8.223A10.477 10.477 0 001.934 12C3.226 16.338 7.244 19.5 12 19.5c.993 0 1.953-.138 2.863-.395M6.228 6.228A10.45 10.45 0 0112 4.5c4.756 0 8.773 3.162 10.065 7.498a10.523 10.523 0 01-4.293 5.774M6.228 6.228L3 3m3.228 3.228l3.65 3.65m7.894 7.894L21 21m-3.228-3.228l-3.65-3.65m0 0a3 3 0 10-4.243-4.243m4.242 4.242L9.88 9.88"/>`,
    eyeOn: `<path stroke-linecap="round" stroke-linejoin="round" d="M2.036 12.322a1.012 1.012 0 010-.639C3.423 7.51 7.36 4.5 12 4.5c4.638 0 8.573 3.007 9.963 7.178.07.207.07.431 0 .639C20.577 16.49 16.64 19.5 12 19.5c-4.638 0-8.573-3.007-9.963-7.178z"/><path stroke-linecap="round" stroke-linejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>`,
  };

  // --- State ---
  const state = {
    config: loadJSON(STORAGE_KEYS.CONFIG, {
      sheetId: DEFAULT_SHEET_ID,
      gid: DEFAULT_GID,
      url: `https://docs.google.com/spreadsheets/d/${DEFAULT_SHEET_ID}/edit?gid=${DEFAULT_GID}#gid=${DEFAULT_GID}`,
    }),
    ttsConfig: loadJSON(STORAGE_KEYS.TTS_CONFIG, {
      engine: "online", // 'online' | 'openai' | 'browser'
      openaiBaseUrl: "https://api.openai.com/v1",
      openaiApiKey: "",
      openaiModel: "gpt-4o-mini-tts",
      openaiVoice: "nova",
    }),
    title: window.FALLBACK_SHEET_TITLE || "《Business Thinking for Designers》错题词汇与搭配记忆本",
    words: [],
    progress: loadJSON(STORAGE_KEYS.PROGRESS, {
      items: {}, // { [key]: { mastered, review, wrongCount, correctCount, lastResult } }
      testedCount: 0,
      correctCount: 0,
    }),
    prefs: loadJSON(STORAGE_KEYS.PREFS, {
      viewMode: "card", // 'card' | 'list'
      globalHideTranslation: true,
      accent: "en-US", // 'en-US' | 'en-GB'
      rate: 1.0, // 1.0 | 0.7
      filter: "all",
    }),
    searchQuery: "",
    orderMode: "default", // 'default' | 'shuffle' | 'weighted'
    shuffledOrder: null, // array of keys when orderMode is 'shuffle' or 'weighted'
    currentIndex: 0,
    currentKey: null,
    sessionDate: "",
    newWordKeys: new Set(),
    lastSyncAt: null,
    lastSyncSummary: "",
    // Daily remembered UI states (persisted for today, auto-reset next day)
    itemRevealOverrides: {}, // { [key]: boolean }
    itemInputs: {}, // { [key]: string }
    itemCheckResults: {}, // { [key]: { isCorrect, userInput, overridden } }
    itemExpandedListContext: {}, // { [key]: boolean }
    shadowResults: {}, // { [key]: { status, message, passed } }
  };

  // --- TTS Session State ---
  const ttsSession = {
    isSpeaking: false,
    activeToken: 0,
    activeKey: null,
    activeTriggerEl: null,
    activeAudio: null,
    watchdogTimer: null,
    resumeKeepAliveTimer: null,
  };

  const openaiAudioCache = new Map();
  let availableVoices = [];
  let activeRecognition = null;
  let toastTimer = null;
  let lastAutoCheckTs = 0;

  // --- DOM Elements ---
  const els = {
    title: document.getElementById("notebook-title"),
    statTested: document.getElementById("stat-tested"),
    statAccuracy: document.getElementById("stat-accuracy"),
    statMastered: document.getElementById("stat-mastered"),
    statTotal: document.getElementById("stat-total"),
    syncPill: document.getElementById("sync-status-pill"),
    syncText: document.getElementById("sync-status-text"),
    linkSourceSheet: document.getElementById("link-source-sheet"),
    btnOpenSettings: document.getElementById("btn-open-settings"),
    btnModeCard: document.getElementById("btn-mode-card"),
    btnModeList: document.getElementById("btn-mode-list"),
    btnGlobalTrans: document.getElementById("btn-global-trans"),
    iconGlobalEye: document.getElementById("icon-global-eye"),
    textGlobalTrans: document.getElementById("text-global-trans"),
    btnAccentUS: document.getElementById("btn-accent-us"),
    btnAccentUK: document.getElementById("btn-accent-uk"),
    btnRateNormal: document.getElementById("btn-rate-normal"),
    btnRateSlow: document.getElementById("btn-rate-slow"),
    filterSelect: document.getElementById("filter-select"),
    btnOrderWeighted: document.getElementById("btn-order-weighted"),
    btnOrderShuffle: document.getElementById("btn-order-shuffle"),
    btnOrderDefault: document.getElementById("btn-order-default"),
    searchInput: document.getElementById("search-input"),
    updateBanner: document.getElementById("update-banner"),
    updateBannerMsg: document.getElementById("update-banner-message"),
    btnViewNewWords: document.getElementById("btn-view-new-words"),
    btnDismissBanner: document.getElementById("btn-dismiss-banner"),
    cardModeSection: document.getElementById("card-mode-section"),
    cardCounter: document.getElementById("card-counter"),
    cardProgressFill: document.getElementById("card-progress-fill"),
    cardModeSlot: document.getElementById("card-mode-slot"),
    cardBottomNav: document.getElementById("card-bottom-nav"),
    btnPrevCard: document.getElementById("btn-prev-card"),
    btnSpeakCurrent: document.getElementById("btn-speak-current"),
    btnNextCard: document.getElementById("btn-next-card"),
    listModeSection: document.getElementById("list-mode-section"),
    footerTotalText: document.getElementById("footer-total-text"),
    ttsStatusBadge: document.getElementById("tts-status-badge"),
    ttsStatusText: document.getElementById("tts-status-text"),
    btnResetFooter: document.getElementById("btn-reset-footer"),
    settingsModal: document.getElementById("settings-modal"),
    settingsForm: document.getElementById("settings-form"),
    selectTtsEngine: document.getElementById("select-tts-engine"),
    ttsEngineDesc: document.getElementById("tts-engine-desc"),
    openaiConfigBox: document.getElementById("openai-config-box"),
    inputOpenaiBase: document.getElementById("input-openai-base"),
    inputOpenaiKey: document.getElementById("input-openai-key"),
    selectOpenaiModel: document.getElementById("select-openai-model"),
    selectOpenaiVoice: document.getElementById("select-openai-voice"),
    btnTestVoice: document.getElementById("btn-test-voice"),
    inputSheetUrl: document.getElementById("input-sheet-url"),
    settingsSyncMeta: document.getElementById("settings-sync-meta"),
    btnCloseSettings: document.getElementById("btn-close-settings"),
    btnCancelSettings: document.getElementById("btn-cancel-settings"),
    toast: document.getElementById("toast"),
  };

  // --- Utilities ---
  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function saveJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // ignore storage quota errors
    }
  }

  function wordKey(word) {
    return String(word || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, " ");
  }

  function escapeHTML(str) {
    return String(str || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function escapeRegex(str) {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function showToast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toast.classList.remove("show");
    }, 2400);
  }

  function formatTime(ts) {
    if (!ts) return "尚未同步";
    const d = new Date(ts);
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  // --- Highlight term in sentence / IELTS example ---
  function highlightTerm(text, term) {
    if (!text) return "";
    const safe = escapeHTML(text);
    if (!term) return safe;

    const cleaned = term.replace(/\[[^\]]+\]/g, "___WILD___").trim();
    const parts = cleaned
      .split("___WILD___")
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length === 0) return safe;

    try {
      const pattern =
        parts.length === 1
          ? escapeRegex(escapeHTML(parts[0]))
          : parts.map((p) => escapeRegex(escapeHTML(p))).join("\\s+(?:\\S+\\s+){0,4}?");
      const re = new RegExp(`(${pattern})`, "gi");
      if (re.test(safe)) {
        return safe.replace(re, '<mark class="term-mark">$1</mark>');
      }
    } catch {
      // fallback
    }
    return safe;
  }

  function parseIeltsTip(tip) {
    if (!tip) return { tag: "", body: "", speakable: "" };
    const m = tip.match(/^(【[^】]+】)\s*(.*)$/);
    const tag = m ? m[1] : "雅思写作 / 口语复用提示";
    const body = m ? m[2] : tip;

    let speakable = body;
    const exMatch = speakable.match(/例[：:]\s*(.+)$/);
    if (exMatch) speakable = exMatch[1];
    speakable = speakable.replace(/[（(]注[：:][^）)]*[）)]/g, "").trim();
    const enCount = (speakable.match(/[A-Za-z]/g) || []).length;
    return { tag, body, speakable: enCount >= 12 ? speakable : "" };
  }

  // --- Smart Chinese Translation Matcher ---
  function normalizeZh(str) {
    return String(str || "")
      .toLowerCase()
      .replace(/[\s\u3000]/g, "")
      .replace(/[。，、；：！？“”‘’'".,;:!?…\-—~·()（）【】\[\]]/g, "")
      .replace(/[的地得]/g, "");
  }

  function diceCoefficient(a, b) {
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return a.includes(b) || b.includes(a) ? 1 : 0;
    const mapA = new Map();
    for (let i = 0; i < a.length - 1; i++) {
      const bg = a.slice(i, i + 2);
      mapA.set(bg, (mapA.get(bg) || 0) + 1);
    }
    let inter = 0;
    for (let i = 0; i < b.length - 1; i++) {
      const bg = b.slice(i, i + 2);
      const c = mapA.get(bg) || 0;
      if (c > 0) {
        inter++;
        mapA.set(bg, c - 1);
      }
    }
    return (2 * inter) / (a.length - 1 + (b.length - 1));
  }

  function charRecall(u, ref) {
    if (!u || !ref) return 0;
    const set = new Set(ref.split(""));
    let hit = 0;
    for (const ch of u) if (set.has(ch)) hit++;
    return hit / u.length;
  }

  function checkTranslation(userInput, standardTranslation) {
    const rawUser = String(userInput || "").trim();
    if (!rawUser) return false;
    const userNorm = normalizeZh(rawUser);
    if (!userNorm) return false;

    const coreOnly = String(standardTranslation || "")
      .replace(/（[^）]*）/g, "")
      .replace(/\([^)]*\)/g, "")
      .trim();

    const expanded = String(standardTranslation || "")
      .replace(/[（()）]/g, "")
      .trim();

    const segments = coreOnly
      .split(/[；;、/，,]+/)
      .map((s) => normalizeZh(s))
      .filter(Boolean);

    const userSegments = rawUser
      .split(/[；;、/，,\s]+/)
      .map((s) => normalizeZh(s))
      .filter(Boolean);

    const candidates = [userNorm, ...userSegments];

    for (const u of candidates) {
      if (!u) continue;
      for (const seg of segments) {
        if (u === seg) return true;
        if (u.length >= 2 && seg.includes(u)) return true;
        if (seg.length >= 2 && u.includes(seg)) return true;
        if (diceCoefficient(u, seg) >= 0.6) return true;
        if (u.length >= 2 && seg.length >= 2) {
          if (charRecall(u, seg) >= 0.75 && charRecall(seg, u) >= 0.5) return true;
        }
      }
      const expNorm = normalizeZh(expanded);
      if (u.length >= 2 && expNorm.includes(u)) {
        const negMatches = [...String(standardTranslation || "").matchAll(/非[“"'「]?([^”"'」)）]+)/g)];
        const isNegativeTrap = negMatches.some(
          (m) => normalizeZh(m[1]).includes(u) || u.includes(normalizeZh(m[1]))
        );
        if (!isNegativeTrap) return true;
      }
    }
    return false;
  }

  // --- Robust Chunked TTS Engine ---
  function loadVoices() {
    if ("speechSynthesis" in window) {
      availableVoices = window.speechSynthesis.getVoices() || [];
    }
  }

  function updateTtsStatus(text, status = "ready") {
    els.ttsStatusText.textContent = text;
    els.ttsStatusBadge.dataset.state = status;
  }

  function clearTtsTimers() {
    if (ttsSession.watchdogTimer) {
      clearTimeout(ttsSession.watchdogTimer);
      ttsSession.watchdogTimer = null;
    }
    if (ttsSession.resumeKeepAliveTimer) {
      clearInterval(ttsSession.resumeKeepAliveTimer);
      ttsSession.resumeKeepAliveTimer = null;
    }
  }

  function getReadyTtsLabel() {
    const eng = (state.ttsConfig && state.ttsConfig.engine) || "online";
    if (eng === "openai") return `OpenAI AI 真人语音 (${state.ttsConfig.openaiVoice || "nova"})`;
    if (eng === "browser") return "浏览器内置语音就绪";
    return "在线自然语音就绪";
  }

  function stopSpeaking(resetBadge = true) {
    ttsSession.activeToken++;
    clearTtsTimers();
    ttsSession.isSpeaking = false;
    ttsSession.activeKey = null;
    if (ttsSession.activeAudio) {
      try {
        ttsSession.activeAudio.onended = null;
        ttsSession.activeAudio.onerror = null;
        ttsSession.activeAudio.pause();
        ttsSession.activeAudio.src = "";
      } catch {
        // ignore
      }
      ttsSession.activeAudio = null;
    }
    if (ttsSession.activeTriggerEl) {
      ttsSession.activeTriggerEl.classList.remove("speaking-active");
      ttsSession.activeTriggerEl = null;
    }
    if ("speechSynthesis" in window) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        // ignore
      }
    }
    if (resetBadge) updateTtsStatus(getReadyTtsLabel(), "ready");
  }

  function normalizeSpeechText(raw) {
    return String(raw || "")
      .replace(/\[sth\]/gi, "something")
      .replace(/\[sb\]/gi, "somebody")
      .replace(/\[doing sth\]/gi, "doing something")
      .replace(/\[[^\]]+\]/g, "")
      .replace(/[\u201C\u201D\u201E\u201F\u00AB\u00BB]/g, '"')
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      .replace(/[\u2013\u2014\u2015]/g, ", ")
      .replace(/\u2026/g, "... ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function splitTextIntoChunks(text, maxLen = 150) {
    if (!text) return [];
    if (text.length <= maxLen) return [text];
    const parts = text.match(/[^.!?:;]+[.!?:;]+(?=\s|$)|[^.!?:;]+$/g) || [text];
    const chunks = [];
    for (const p of parts) {
      const part = p.trim();
      if (!part) continue;
      if (part.length <= maxLen) {
        chunks.push(part);
        continue;
      }
      const clauses = part.match(/[^,]+,?(?=\s|$)|[^,]+$/g) || [part];
      let cur = "";
      for (const c of clauses) {
        const cl = c.trim();
        if (!cl) continue;
        if (!cur) cur = cl;
        else if ((cur + " " + cl).length <= maxLen) cur += " " + cl;
        else {
          chunks.push(cur);
          cur = cl;
        }
      }
      if (cur) chunks.push(cur);
    }
    return chunks.length ? chunks : [text];
  }

  function pickVoiceForAccent(targetLang) {
    if (!availableVoices.length) loadVoices();
    if (!availableVoices.length) return null;
    const langLower = (targetLang || "en-US").toLowerCase();
    const exact = availableVoices.filter((v) => (v.lang || "").toLowerCase() === langLower);
    const region = availableVoices.filter((v) =>
      (v.lang || "").toLowerCase().replace("_", "-").startsWith(langLower)
    );
    const anyEn = availableVoices.filter((v) => (v.lang || "").toLowerCase().startsWith("en"));

    const score = (v) => {
      let s = 0;
      const n = (v.name || "").toLowerCase();
      if (/natural|online|neural/.test(n)) s += 30;
      if (/google|samantha|daniel|aria|jenny|libby|guy/.test(n)) s += 20;
      if (v.localService) s += 10;
      return s;
    };
    const pool = exact.length ? exact : region.length ? region : anyEn.length ? anyEn : availableVoices;
    return [...pool].sort((a, b) => score(b) - score(a))[0] || null;
  }

  function finishTtsSession(token, hadError = false) {
    if (token !== ttsSession.activeToken) return;
    clearTtsTimers();
    ttsSession.isSpeaking = false;
    ttsSession.activeKey = null;
    ttsSession.activeAudio = null;
    if (ttsSession.activeTriggerEl) {
      ttsSession.activeTriggerEl.classList.remove("speaking-active");
      ttsSession.activeTriggerEl = null;
    }
    updateTtsStatus(hadError ? "朗读受阻，请重试" : getReadyTtsLabel(), hadError ? "error" : "ready");
  }

  function playAudioUrlQueue(urls, token, rate, onDone, onError) {
    const playIdx = (idx) => {
      if (token !== ttsSession.activeToken) return;
      if (idx >= urls.length) {
        onDone();
        return;
      }

      const audio = new Audio();
      audio.preload = "auto";
      audio.playbackRate = rate;
      audio.src = urls[idx];
      ttsSession.activeAudio = audio;

      let settled = false;
      const doneOne = () => {
        if (settled || token !== ttsSession.activeToken) return;
        settled = true;
        playIdx(idx + 1);
      };
      const failOne = (err) => {
        if (settled || token !== ttsSession.activeToken) return;
        settled = true;
        onError(err);
      };

      audio.onended = doneOne;
      audio.onerror = () => failOne(new Error("音频加载失败"));

      const p = audio.play();
      if (p && typeof p.catch === "function") {
        p.catch(failOne);
      }
    };

    playIdx(0);
  }

  function speakViaBrowserTTS(cleaned, token, targetLang, targetRate, label) {
    if (!("speechSynthesis" in window) || typeof SpeechSynthesisUtterance === "undefined") {
      finishTtsSession(token, true);
      showToast("当前浏览器不支持语音朗读");
      return;
    }

    const chunks = splitTextIntoChunks(cleaned, 115);
    const voice = pickVoiceForAccent(targetLang);
    updateTtsStatus(`${label}（本地语音）· ${targetLang}`, "speaking");

    ttsSession.resumeKeepAliveTimer = setInterval(() => {
      if (token !== ttsSession.activeToken || !ttsSession.isSpeaking) {
        clearInterval(ttsSession.resumeKeepAliveTimer);
        return;
      }
      try {
        if (window.speechSynthesis.paused) window.speechSynthesis.resume();
      } catch {
        // ignore
      }
    }, 4000);

    const speakChunk = (idx) => {
      if (token !== ttsSession.activeToken) return;
      if (idx >= chunks.length) {
        finishTtsSession(token, false);
        return;
      }

      let settled = false;
      const next = (err = false) => {
        if (settled || token !== ttsSession.activeToken) return;
        settled = true;
        if (ttsSession.watchdogTimer) {
          clearTimeout(ttsSession.watchdogTimer);
          ttsSession.watchdogTimer = null;
        }
        if (err && idx === chunks.length - 1) {
          finishTtsSession(token, true);
        } else {
          setTimeout(() => speakChunk(idx + 1), 35);
        }
      };

      try {
        const utter = new SpeechSynthesisUtterance(chunks[idx]);
        utter.lang = targetLang;
        utter.rate = targetRate;
        if (voice) utter.voice = voice;
        utter.onend = () => next(false);
        utter.onerror = (ev) => {
          const code = ev && ev.error;
          if (code === "interrupted" || code === "canceled") return;
          next(true);
        };
        ttsSession.watchdogTimer = setTimeout(() => next(false), Math.max(7000, chunks[idx].length * 140));
        window.speechSynthesis.speak(utter);
      } catch {
        next(true);
      }
    };

    speakChunk(0);
  }

  function speakViaOnlineNatural(cleaned, token, targetLang, targetRate, label) {
    const isShortPhrase =
      cleaned.length <= 36 && !/[.!?:;,]/.test(cleaned) && cleaned.split(/\s+/).length <= 4;

    const googleUrls = splitTextIntoChunks(cleaned, 160).map(
      (chunk) =>
        `https://translate.google.com/translate_tts?ie=UTF-8&client=tw-ob&tl=${encodeURIComponent(
          targetLang
        )}&q=${encodeURIComponent(chunk)}`
    );

    if (isShortPhrase) {
      const youdaoType = targetLang === "en-GB" ? 1 : 2;
      const youdaoUrl = `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(
        cleaned
      )}&type=${youdaoType}`;
      updateTtsStatus(`${label}（真人词典音）· ${targetLang}`, "speaking");
      playAudioUrlQueue(
        [youdaoUrl],
        token,
        targetRate,
        () => finishTtsSession(token, false),
        () => {
          if (token !== ttsSession.activeToken) return;
          updateTtsStatus(`${label}（在线自然音）· ${targetLang}`, "speaking");
          playAudioUrlQueue(
            googleUrls,
            token,
            targetRate,
            () => finishTtsSession(token, false),
            () => speakViaBrowserTTS(cleaned, token, targetLang, targetRate, label)
          );
        }
      );
    } else {
      updateTtsStatus(`${label}（在线自然音）· ${targetLang}`, "speaking");
      playAudioUrlQueue(
        googleUrls,
        token,
        targetRate,
        () => finishTtsSession(token, false),
        () => speakViaBrowserTTS(cleaned, token, targetLang, targetRate, label)
      );
    }
  }

  async function speakViaOpenAI(cleaned, token, targetLang, targetRate, label, cfg) {
    const apiKey = (cfg.openaiApiKey || "").trim();
    const baseUrl = (cfg.openaiBaseUrl || "https://api.openai.com/v1").trim().replace(/\/+$/, "");
    const model = cfg.openaiModel || "gpt-4o-mini-tts";
    const voice = cfg.openaiVoice || "nova";

    if (!apiKey) {
      showToast("尚未填写 OpenAI API Key，已自动切回在线自然语音");
      speakViaOnlineNatural(cleaned, token, targetLang, targetRate, label);
      return;
    }

    const cacheKey = `${baseUrl}|${model}|${voice}|${cleaned}`;
    if (openaiAudioCache.has(cacheKey)) {
      updateTtsStatus(`${label}（AI 真人 · ${voice}）`, "speaking");
      playAudioUrlQueue(
        [openaiAudioCache.get(cacheKey)],
        token,
        targetRate,
        () => finishTtsSession(token, false),
        () => speakViaOnlineNatural(cleaned, token, targetLang, targetRate, label)
      );
      return;
    }

    updateTtsStatus(`AI 语音生成中 (${voice})…`, "speaking");
    try {
      const res = await fetch(`${baseUrl}/audio/speech`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          voice,
          input: cleaned,
          response_format: "mp3",
        }),
      });
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const blob = await res.blob();
      if (token !== ttsSession.activeToken) return;
      const blobUrl = URL.createObjectURL(blob);
      openaiAudioCache.set(cacheKey, blobUrl);

      updateTtsStatus(`${label}（AI 真人 · ${voice}）`, "speaking");
      playAudioUrlQueue(
        [blobUrl],
        token,
        targetRate,
        () => finishTtsSession(token, false),
        () => speakViaOnlineNatural(cleaned, token, targetLang, targetRate, label)
      );
    } catch (err) {
      if (token !== ttsSession.activeToken) return;
      console.error("OpenAI TTS failed:", err);
      showToast(`AI 接口请求失败（${err.message}），已自动回退在线语音`);
      speakViaOnlineNatural(cleaned, token, targetLang, targetRate, label);
    }
  }

  function speakText(rawText, triggerEl = null, label = "正在朗读", overrideTtsCfg = null) {
    const cleaned = normalizeSpeechText(rawText);
    if (!cleaned) {
      showToast("没有可朗读的英文内容");
      return;
    }

    const cfg = overrideTtsCfg || state.ttsConfig || { engine: "online" };
    const targetLang = state.prefs.accent || "en-US";
    const targetRate = state.prefs.rate || 1.0;
    const sessionKey = `${cfg.engine}|${cfg.openaiVoice || ""}|${targetLang}|${targetRate}|${cleaned}`;

    // Click again to stop
    if (ttsSession.isSpeaking && ttsSession.activeKey === sessionKey) {
      stopSpeaking(true);
      return;
    }

    stopSpeaking(false);
    const token = ttsSession.activeToken;
    ttsSession.isSpeaking = true;
    ttsSession.activeKey = sessionKey;
    ttsSession.activeTriggerEl = triggerEl;
    if (triggerEl) triggerEl.classList.add("speaking-active");

    if (cfg.engine === "openai") {
      speakViaOpenAI(cleaned, token, targetLang, targetRate, label, cfg);
    } else if (cfg.engine === "browser") {
      speakViaBrowserTTS(cleaned, token, targetLang, targetRate, label);
    } else {
      speakViaOnlineNatural(cleaned, token, targetLang, targetRate, label);
    }
  }

  // --- Speech Recognition (Voice Shadowing / 跟读检测) ---
  function normalizeEn(str) {
    return String(str || "")
      .toLowerCase()
      .replace(/\[sth\]/g, "something")
      .replace(/\[sb\]/g, "somebody")
      .replace(/[^a-z0-9\s']/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  function compareSpeech(spoken, target) {
    const s = normalizeEn(spoken);
    const t = normalizeEn(target);
    if (!s || !t) return false;
    if (s === t || s.includes(t) || t.includes(s)) return true;
    const sWords = new Set(s.split(" "));
    const tWords = t.split(" ").filter(Boolean);
    let hits = 0;
    for (const tw of tWords) if (sWords.has(tw)) hits++;
    return hits / tWords.length >= 0.65;
  }

  function startShadowing(wordObj) {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) {
      showToast("当前浏览器不支持语音识别，已为你朗读供跟读");
      speakText(wordObj.word, null, "跟读发音");
      return;
    }

    if (activeRecognition) {
      try {
        activeRecognition.stop();
      } catch {
        // ignore
      }
      activeRecognition = null;
    }
    stopSpeaking(true);

    const rec = new SpeechRec();
    rec.lang = state.prefs.accent || "en-US";
    rec.interimResults = false;
    rec.maxAlternatives = 3;
    activeRecognition = rec;

    state.shadowResults[wordObj.key] = {
      status: "listening",
      message: "正在聆听，请清晰跟读该单词/短语…",
    };
    renderCurrentView();

    rec.onresult = (ev) => {
      const alts = [];
      for (let i = 0; i < ev.results[0].length; i++) alts.push(ev.results[0][i].transcript);
      const best = alts[0] || "";
      const passed = alts.some((tr) => compareSpeech(tr, wordObj.word));
      state.shadowResults[wordObj.key] = {
        status: "done",
        passed,
        message: passed
          ? `跟读识别：“${best}” — 发音很棒！`
          : `跟读识别：“${best}” — 可以再听一遍跟读`,
      };
      activeRecognition = null;
      renderCurrentView();
    };

    rec.onerror = (ev) => {
      const msg =
        ev.error === "not-allowed"
          ? "未获得麦克风权限，请在浏览器地址栏允许麦克风访问"
          : ev.error === "no-speech"
          ? "没有听到声音，请靠近麦克风再试"
          : `跟读识别中断（${ev.error}）`;
      state.shadowResults[wordObj.key] = { status: "error", message: msg };
      activeRecognition = null;
      renderCurrentView();
    };

    rec.onend = () => {
      if (activeRecognition === rec) activeRecognition = null;
    };

    try {
      rec.start();
    } catch {
      showToast("无法启动麦克风，请重试");
    }
  }

  // --- RFC-4180 CSV Parser & Google Sheets Auto-Sync ---
  function parseCSV(text) {
    const rows = [];
    let row = [];
    let field = "";
    let inQuotes = false;
    const clean = text.replace(/^\uFEFF/, "");

    for (let i = 0; i < clean.length; i++) {
      const ch = clean[i];
      if (inQuotes) {
        if (ch === '"') {
          if (clean[i + 1] === '"') {
            field += '"';
            i++;
          } else {
            inQuotes = false;
          }
        } else {
          field += ch;
        }
      } else {
        if (ch === '"') inQuotes = true;
        else if (ch === ",") {
          row.push(field);
          field = "";
        } else if (ch === "\r") {
          if (clean[i + 1] === "\n") i++;
          row.push(field);
          rows.push(row);
          row = [];
          field = "";
        } else if (ch === "\n") {
          row.push(field);
          rows.push(row);
          row = [];
          field = "";
        } else {
          field += ch;
        }
      }
    }
    if (field.length > 0 || row.length > 0) {
      row.push(field);
      rows.push(row);
    }
    return rows;
  }

  function extractVocabFromRows(rows) {
    let sheetTitle = "";
    const words = [];
    const seen = new Set();

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i].map((c) => String(c || "").trim());
      if (!r.some(Boolean)) continue;

      if (i === 0 && r[0] && !r[1]) {
        sheetTitle = r[0];
        continue;
      }

      if (
        /^(单词|词汇|word|term|phrase)/i.test(r[0]) &&
        r[1] &&
        /^(翻译|释义|中文|meaning|translation)/i.test(r[1])
      ) {
        continue;
      }

      const word = r[0] || "";
      const translation = r[1] || "";
      const sentence = r[2] || "";
      const tip = r[3] || "";

      if (word && translation) {
        const key = wordKey(word);
        if (!seen.has(key)) {
          seen.add(key);
          words.push({
            id: words.length + 1,
            key,
            word,
            translation,
            sentence,
            tip,
          });
        }
      }
    }
    return { sheetTitle, words };
  }

  function parseSheetUrl(url) {
    const idMatch = String(url || "").match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (!idMatch) return null;
    const gidMatch = String(url || "").match(/[?#&]gid=(\d+)/);
    return { sheetId: idMatch[1], gid: gidMatch ? gidMatch[1] : "0" };
  }

  async function fetchSheetViaCSV(sheetId, gid) {
    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&gid=${gid}&_t=${Date.now()}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    if (/^\s*<!doctype html|^\s*<html/i.test(text)) {
      throw new Error("表格未开启公开可读权限（需设为「知道链接的任何人可查看」）");
    }
    return extractVocabFromRows(parseCSV(text));
  }

  function fetchSheetViaJSONP(sheetId, gid) {
    return new Promise((resolve, reject) => {
      const cbName = `__danciGviz_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
      const script = document.createElement("script");
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error("JSONP 请求超时"));
      }, 10000);

      function cleanup() {
        clearTimeout(timer);
        delete window[cbName];
        if (script.parentNode) script.parentNode.removeChild(script);
      }

      window[cbName] = (resp) => {
        cleanup();
        try {
          if (!resp || resp.status === "error" || !resp.table) {
            reject(new Error("Google 表格返回异常"));
            return;
          }
          const rows = [];
          const colLabels = (resp.table.cols || []).map((c) => (c && c.label ? String(c.label).trim() : ""));
          if (colLabels.some(Boolean)) rows.push(colLabels);
          for (const tr of resp.table.rows || []) {
            rows.push(
              (tr.c || []).map((cell) => {
                if (!cell || cell.v == null) return "";
                return String(cell.f != null ? cell.f : cell.v);
              })
            );
          }
          resolve(extractVocabFromRows(rows));
        } catch (err) {
          reject(err);
        }
      };

      script.onerror = () => {
        cleanup();
        reject(new Error("无法连接 Google 表格"));
      };

      script.src = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:json;responseHandler:${cbName}&gid=${gid}&_t=${Date.now()}`;
      document.head.appendChild(script);
    });
  }

  function setSyncUI(status, text) {
    els.syncPill.dataset.state = status;
    els.syncText.textContent = text;
  }

  async function syncFromGoogleSheet(isManual = false) {
    setSyncUI("syncing", "检查更新中…");
    els.syncPill.disabled = true;
    lastAutoCheckTs = Date.now();

    try {
      let data;
      try {
        data = await fetchSheetViaCSV(state.config.sheetId, state.config.gid);
      } catch {
        data = await fetchSheetViaJSONP(state.config.sheetId, state.config.gid);
      }

      if (!data.words || data.words.length === 0) {
        throw new Error("未解析到有效词汇行");
      }

      const oldMap = new Map(state.words.map((w) => [w.key, w]));
      const newMap = new Map(data.words.map((w) => [w.key, w]));

      const added = [];
      let updatedCount = 0;
      let removedCount = 0;

      for (const w of data.words) {
        const prev = oldMap.get(w.key);
        if (!prev) added.push(w.key);
        else if (
          prev.translation !== w.translation ||
          prev.sentence !== w.sentence ||
          prev.tip !== w.tip ||
          prev.word !== w.word
        ) {
          updatedCount++;
        }
      }
      for (const k of oldMap.keys()) {
        if (!newMap.has(k)) removedCount++;
      }

      const hadExistingCache = Boolean(loadJSON(STORAGE_KEYS.CACHE, null));
      state.words = data.words;
      if (data.sheetTitle) state.title = data.sheetTitle;
      state.lastSyncAt = Date.now();

      saveJSON(STORAGE_KEYS.CACHE, {
        sheetId: state.config.sheetId,
        gid: state.config.gid,
        title: state.title,
        words: state.words,
        syncedAt: state.lastSyncAt,
      });

      const hasChanges = added.length > 0 || updatedCount > 0 || removedCount > 0;
      if (hasChanges && hadExistingCache) {
        state.newWordKeys = new Set(added);
        const parts = [];
        if (added.length) parts.push(`新增 ${added.length} 词`);
        if (updatedCount) parts.push(`更新 ${updatedCount} 词`);
        if (removedCount) parts.push(`移除 ${removedCount} 词`);
        const summary = parts.join("，");
        state.lastSyncSummary = summary;
        setSyncUI("updated", `已更新：${summary}`);
        els.updateBannerMsg.textContent = `检测到 Google 表格词库变动，已自动同步：${summary}。`;
        els.btnViewNewWords.hidden = added.length === 0;
        els.updateBanner.hidden = false;
        if (isManual) showToast(`同步完成：${summary}`);
      } else {
        state.lastSyncSummary = `共 ${state.words.length} 词，已是最新`;
        setSyncUI("ok", `已同步 · ${state.words.length} 词`);
        if (isManual) showToast(`已是最新词库（共 ${state.words.length} 词）`);
      }

      restorePositionFromKey();
      renderAll();
    } catch (err) {
      console.error("Sync failed:", err);
      setSyncUI("error", "同步失败 · 点此重试");
      if (isManual) showToast(`同步失败：${err.message}`);
    } finally {
      els.syncPill.disabled = false;
    }
  }

  // --- Daily Session Memory (auto-resets every day) & Adaptive Weights ---
  function getTodayStr() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  function getItemProgress(key) {
    const raw = state.progress.items[key] || {};
    return {
      mastered: Boolean(raw.mastered),
      review: Boolean(raw.review),
      wrongCount: Number(raw.wrongCount || 0),
      correctCount: Number(raw.correctCount || 0),
      lastResult: raw.lastResult || null,
    };
  }

  function getWordWeight(key) {
    const p = getItemProgress(key);
    let weight = 10;
    if (p.wrongCount > 0) {
      weight *= Math.pow(1.9, Math.min(p.wrongCount, 5));
    }
    if (p.lastResult === "wrong" || p.review) {
      weight *= 1.5;
    }
    if (p.correctCount > 0) {
      weight *= Math.pow(0.62, Math.min(p.correctCount, 6));
    }
    if (p.mastered) {
      weight *= 0.25;
    }
    return Math.max(0.4, Math.min(200, weight));
  }

  function generateWeightedOrder() {
    // Efraimidis-Spirakis weighted random permutation:
    // higher weight (more mistakes) => much higher chance to appear early;
    // lower weight (answered correctly / mastered) => much lower frequency early on.
    return [...state.words]
      .map((w) => {
        const weight = getWordWeight(w.key);
        const u = Math.max(1e-9, Math.random());
        return { key: w.key, score: Math.pow(u, 1 / weight) };
      })
      .sort((a, b) => b.score - a.score)
      .map((item) => item.key);
  }

  function saveDailySession() {
    const today = getTodayStr();
    state.sessionDate = today;
    saveJSON(STORAGE_KEYS.DAILY_SESSION, {
      date: today,
      currentIndex: state.currentIndex,
      currentKey: state.currentKey,
      orderMode: state.orderMode,
      shuffledOrder: state.shuffledOrder,
      itemInputs: state.itemInputs,
      itemCheckResults: state.itemCheckResults,
      itemRevealOverrides: state.itemRevealOverrides,
    });
  }

  function restorePositionFromKey() {
    if (!state.currentKey) return;
    const words = getFilteredWords();
    const idx = words.findIndex((w) => w.key === state.currentKey);
    if (idx !== -1) {
      state.currentIndex = idx;
    }
  }

  function loadOrResetDailySession(showResetNotice = false) {
    const today = getTodayStr();
    const saved = loadJSON(STORAGE_KEYS.DAILY_SESSION, null);

    if (saved && saved.date === today) {
      state.sessionDate = today;
      state.currentIndex = Number.isInteger(saved.currentIndex) ? saved.currentIndex : 0;
      state.currentKey = saved.currentKey || null;
      state.orderMode = saved.orderMode || "default";
      state.shuffledOrder = Array.isArray(saved.shuffledOrder) ? saved.shuffledOrder : null;
      state.itemInputs = saved.itemInputs && typeof saved.itemInputs === "object" ? saved.itemInputs : {};
      state.itemCheckResults =
        saved.itemCheckResults && typeof saved.itemCheckResults === "object" ? saved.itemCheckResults : {};
      state.itemRevealOverrides =
        saved.itemRevealOverrides && typeof saved.itemRevealOverrides === "object"
          ? saved.itemRevealOverrides
          : {};
      restorePositionFromKey();
      return false;
    }

    // New day (or first visit): reset today's inputs, checks, reveals, and card position
    const hadPreviousDay = Boolean(saved && saved.date && saved.date !== today);
    const prevMode = (saved && saved.orderMode) || state.orderMode || "default";
    state.sessionDate = today;
    state.currentIndex = 0;
    state.currentKey = null;
    state.itemInputs = {};
    state.itemCheckResults = {};
    state.itemRevealOverrides = {};
    state.orderMode = prevMode;

    if (prevMode === "weighted" && state.words.length > 0) {
      state.shuffledOrder = generateWeightedOrder();
    } else if (prevMode === "shuffle" && state.words.length > 0) {
      const keys = state.words.map((w) => w.key);
      for (let i = keys.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [keys[i], keys[j]] = [keys[j], keys[i]];
      }
      state.shuffledOrder = keys;
    } else {
      state.shuffledOrder = null;
    }

    saveDailySession();
    if (showResetNotice && hadPreviousDay) {
      showToast("新的一天开始啦，已自动重置今日默写与位置记录");
    }
    return hadPreviousDay;
  }

  function saveProgress() {
    saveJSON(STORAGE_KEYS.PROGRESS, state.progress);
  }

  function toggleMastered(key) {
    const cur = getItemProgress(key);
    state.progress.items[key] = {
      ...cur,
      mastered: !cur.mastered,
      review: !cur.mastered ? false : cur.review,
    };
    saveProgress();
    updateHeaderStats();
    renderCurrentView();
  }

  function isTranslationVisible(key) {
    if (key in state.itemRevealOverrides) {
      return Boolean(state.itemRevealOverrides[key]);
    }
    return !state.prefs.globalHideTranslation;
  }

  // --- Filtering & Ordering ---
  function getFilteredWords() {
    let list = [...state.words];

    if (state.orderMode !== "default" && state.shuffledOrder && state.shuffledOrder.length > 0) {
      const idxMap = new Map(state.shuffledOrder.map((k, i) => [k, i]));
      list.sort((a, b) => (idxMap.get(a.key) ?? 999999) - (idxMap.get(b.key) ?? 999999));
    }

    const f = state.prefs.filter;
    if (f === "unmastered") {
      list = list.filter((w) => !getItemProgress(w.key).mastered);
    } else if (f === "review") {
      list = list.filter((w) => getItemProgress(w.key).review);
    } else if (f === "mastered") {
      list = list.filter((w) => getItemProgress(w.key).mastered);
    } else if (f === "new") {
      list = list.filter((w) => state.newWordKeys.has(w.key));
    }

    const q = state.searchQuery.trim().toLowerCase();
    if (q) {
      list = list.filter(
        (w) =>
          w.word.toLowerCase().includes(q) ||
          w.translation.toLowerCase().includes(q) ||
          w.sentence.toLowerCase().includes(q) ||
          w.tip.toLowerCase().includes(q)
      );
    }
    return list;
  }

  function updateHeaderStats() {
    const total = state.words.length;
    let mastered = 0;
    let review = 0;
    for (const w of state.words) {
      const p = getItemProgress(w.key);
      if (p.mastered) mastered++;
      if (p.review) review++;
    }
    const unmastered = total - mastered;

    els.statTotal.textContent = total;
    els.statMastered.textContent = mastered;
    els.statTested.textContent = state.progress.testedCount || 0;
    els.statAccuracy.textContent =
      state.progress.testedCount > 0
        ? `${Math.round((state.progress.correctCount / state.progress.testedCount) * 100)}%`
        : "--";

    els.footerTotalText.textContent = `共收录 ${total} 条《Business Thinking for Designers》核心错题词汇与搭配（自动同步 Google 表格）`;

    // Update filter dropdown options
    const curVal = state.prefs.filter;
    const opts = [
      { value: "all", label: `全部词汇 (${total})` },
      { value: "unmastered", label: `未掌握 (${unmastered})` },
      { value: "review", label: `错题需复习 (${review})` },
      { value: "mastered", label: `已掌握 (${mastered})` },
    ];
    if (state.newWordKeys.size > 0) {
      opts.push({ value: "new", label: `本次新增 (${state.newWordKeys.size})` });
    }
    els.filterSelect.innerHTML = opts
      .map((o) => `<option value="${o.value}">${escapeHTML(o.label)}</option>`)
      .join("");
    els.filterSelect.value = opts.some((o) => o.value === curVal) ? curVal : "all";
  }

  // --- Shared Card HTML Builder ---
  function buildVocabCardHTML(w, isCardMode) {
    const prog = getItemProgress(w.key);
    const showTrans = isTranslationVisible(w.key);
    const userVal = state.itemInputs[w.key] || "";
    const checkRes = state.itemCheckResults[w.key];
    const shadowRes = state.shadowResults[w.key];
    const isNew = state.newWordKeys.has(w.key);
    const ielts = parseIeltsTip(w.tip);
    const showContext = isCardMode || Boolean(state.itemExpandedListContext[w.key]);

    const feedbackHTML = checkRes
      ? `
        <div class="check-feedback ${checkRes.isCorrect || checkRes.overridden ? "is-correct" : "is-wrong"}">
          <span>${
            checkRes.isCorrect
              ? "✓ 回答正确！释义准确。"
              : checkRes.overridden
              ? "✓ 已手动判定为答对"
              : `✕ 略有偏差（你填写了：${escapeHTML(checkRes.userInput)}），请对照下方参考释义`
          }</span>
          ${
            !checkRes.isCorrect && !checkRes.overridden
              ? `<button type="button" class="btn-override" data-action="override-check">意思相近，算我答对</button>`
              : ""
          }
        </div>
      `
      : "";

    const shadowHTML = shadowRes
      ? `
        <div class="shadow-feedback ${
          shadowRes.status === "done" ? (shadowRes.passed ? "pass" : "retry") : ""
        }">
          <span>${escapeHTML(shadowRes.message)}</span>
          <button type="button" class="btn-secondary btn-sm" data-action="clear-shadow">关闭</button>
        </div>
      `
      : "";

    const translationBlockHTML = showTrans
      ? `
        <div class="translation-revealed-box">
          <div>
            <span class="translation-label">参考释义与易错点</span>
            <p class="translation-value">${escapeHTML(w.translation)}</p>
          </div>
          <button type="button" class="btn-secondary btn-sm" data-action="toggle-trans">隐藏</button>
        </div>
      `
      : `
        <button type="button" class="translation-hidden-bar" data-action="toggle-trans">
          <span>参考中文释义已隐藏（先默写测试，或点击此处偷看答案）</span>
          <span class="reveal-link">揭晓</span>
        </button>
      `;

    const contextHTML =
      w.sentence || w.tip
        ? `
        ${
          !isCardMode
            ? `<button type="button" class="list-context-toggle" data-action="toggle-list-context">${
                showContext ? "▾ 收起原句与雅思例句" : "▸ 展开原句与雅思例句"
              }</button>`
            : ""
        }
        ${
          showContext
            ? `
          <div class="context-section">
            ${
              w.sentence
                ? `
              <div class="context-box context-box-source">
                <div class="context-box-head">
                  <span class="context-label-source">原书语境例句</span>
                  <button type="button" class="btn-speak-mini" data-action="speak-sentence" title="朗读整句跟读（再点一次可停止）">
                    ${ICONS.speaker}
                    <span>朗读原句</span>
                  </button>
                </div>
                <p class="context-text">${highlightTerm(w.sentence, w.word)}</p>
              </div>
            `
                : ""
            }
            ${
              w.tip
                ? `
              <div class="context-box context-box-ielts">
                <div class="context-box-head">
                  <span class="context-label-ielts">${escapeHTML(ielts.tag)}</span>
                  ${
                    ielts.speakable
                      ? `
                    <button type="button" class="btn-speak-mini btn-speak-mini-indigo" data-action="speak-ielts" title="朗读雅思仿写例句（再点一次可停止）">
                      ${ICONS.speaker}
                      <span>朗读例句</span>
                    </button>
                  `
                      : ""
                  }
                </div>
                <p class="context-text">${highlightTerm(ielts.body, w.word)}</p>
              </div>
            `
                : ""
            }
          </div>
        `
            : ""
        }
      `
        : "";

    let freqBadgeHTML = "";
    if (state.orderMode === "weighted") {
      const wScore = getWordWeight(w.key);
      if (prog.wrongCount > 0 && wScore >= 14) {
        freqBadgeHTML = `<span class="badge-freq-high" title="历史答错 ${prog.wrongCount} 次，抽查出现几率已提高">高频抽查 · 错${prog.wrongCount}次</span>`;
      } else if (prog.mastered || (prog.correctCount >= 2 && wScore <= 5)) {
        freqBadgeHTML = `<span class="badge-freq-low" title="已答对 ${prog.correctCount} 次，抽查出现频率已降低">低频 · 对${prog.correctCount}次</span>`;
      }
    }

    return `
      <article class="vocab-card" data-key="${escapeHTML(w.key)}">
        <div class="vocab-card-header">
          <div class="vocab-head-left">
            <span class="index-badge">#${String(w.id).padStart(2, "0")}</span>
            <button type="button" class="term-speak-btn" data-action="speak-word" title="点击发声（再点一次可停止）">
              <span>${escapeHTML(w.word)}</span>
              ${ICONS.speaker}
            </button>
            ${isNew ? `<span class="badge-new">新增</span>` : ""}
            ${freqBadgeHTML}
          </div>
          <div class="vocab-head-right">
            <button type="button" class="btn-mic ${
              shadowRes && shadowRes.status === "listening" ? "is-recording" : ""
            }" data-action="shadow-word" title="点击语音跟读检测">
              ${ICONS.mic}
              <span>${shadowRes && shadowRes.status === "listening" ? "聆听中" : "跟读"}</span>
            </button>
            <button type="button" class="btn-master ${prog.mastered ? "is-mastered" : ""}" data-action="toggle-master">
              ${ICONS.checkCircle}
              <span>${prog.mastered ? "已掌握" : "标记掌握"}</span>
            </button>
          </div>
        </div>

        ${shadowHTML}

        <form class="test-form-row" data-action="check-form">
          <input
            type="text"
            class="test-input"
            name="answer"
            value="${escapeHTML(userVal)}"
            placeholder="输入该词在书中的中文释义，按回车或点击检查..."
            autocomplete="off"
          />
          <button type="submit" class="btn-primary">检查</button>
          <button type="button" class="btn-secondary" data-action="toggle-trans">
            ${showTrans ? "隐藏译文" : "显示译文"}
          </button>
        </form>

        ${feedbackHTML}

        <div class="translation-box-wrap">
          ${translationBlockHTML}
        </div>

        ${contextHTML}
      </article>
    `;
  }

  // --- Render Views ---
  function renderCardMode() {
    const words = getFilteredWords();
    if (words.length === 0) {
      els.cardCounter.textContent = "第 0 / 0 题";
      els.cardProgressFill.style.width = "0%";
      els.cardModeSlot.innerHTML = `
        <div class="empty-state">
          <p>当前筛选或搜索条件下没有匹配的词汇。</p>
          <button type="button" class="btn-secondary btn-sm" id="btn-clear-card-empty">显示全部词汇</button>
        </div>
      `;
      els.cardBottomNav.style.display = "none";
      const btn = document.getElementById("btn-clear-card-empty");
      if (btn) btn.addEventListener("click", clearFilters);
      return;
    }

    if (state.currentIndex >= words.length) state.currentIndex = words.length - 1;
    if (state.currentIndex < 0) state.currentIndex = 0;

    const current = words[state.currentIndex];
    state.currentKey = current.key;
    saveDailySession();

    els.cardCounter.textContent = `第 ${state.currentIndex + 1} / ${words.length} 题`;
    els.cardProgressFill.style.width = `${Math.round(((state.currentIndex + 1) / words.length) * 100)}%`;
    els.cardModeSlot.innerHTML = buildVocabCardHTML(current, true);

    els.cardBottomNav.style.display = "flex";
    els.btnPrevCard.disabled = state.currentIndex === 0;
    els.btnNextCard.disabled = state.currentIndex >= words.length - 1;
  }

  function renderListMode() {
    const words = getFilteredWords();
    if (words.length === 0) {
      els.listModeSection.innerHTML = `
        <div class="empty-state">
          <p>当前筛选或搜索条件下没有匹配的词汇。</p>
          <button type="button" class="btn-secondary btn-sm" id="btn-clear-list-empty">显示全部词汇</button>
        </div>
      `;
      const btn = document.getElementById("btn-clear-list-empty");
      if (btn) btn.addEventListener("click", clearFilters);
      return;
    }

    els.listModeSection.innerHTML = words.map((w) => buildVocabCardHTML(w, false)).join("");
  }

  function clearFilters() {
    state.prefs.filter = "all";
    state.searchQuery = "";
    els.searchInput.value = "";
    state.currentIndex = 0;
    state.currentKey = null;
    saveJSON(STORAGE_KEYS.PREFS, state.prefs);
    saveDailySession();
    renderAll();
  }

  function renderCurrentView() {
    if (state.prefs.viewMode === "card") {
      els.cardModeSection.hidden = false;
      els.listModeSection.hidden = true;
      renderCardMode();
    } else {
      els.cardModeSection.hidden = true;
      els.listModeSection.hidden = false;
      renderListMode();
    }
  }

  function updateToolbarControls() {
    // View mode buttons
    const isCard = state.prefs.viewMode === "card";
    els.btnModeCard.classList.toggle("active", isCard);
    els.btnModeCard.setAttribute("aria-selected", String(isCard));
    els.btnModeList.classList.toggle("active", !isCard);
    els.btnModeList.setAttribute("aria-selected", String(!isCard));

    // Global translation toggle
    const hidden = state.prefs.globalHideTranslation;
    els.btnGlobalTrans.classList.toggle("is-shown", !hidden);
    els.iconGlobalEye.innerHTML = hidden ? ICONS.eyeOff : ICONS.eyeOn;
    els.textGlobalTrans.textContent = hidden
      ? "翻译已隐藏 (点击显示全部)"
      : "翻译已显示 (点击全部隐藏)";

    // Accent & rate
    els.btnAccentUS.classList.toggle("active", state.prefs.accent === "en-US");
    els.btnAccentUK.classList.toggle("active", state.prefs.accent === "en-GB");
    els.btnRateNormal.classList.toggle("active", state.prefs.rate >= 1.0);
    els.btnRateSlow.classList.toggle("active", state.prefs.rate < 1.0);

    // Order
    els.btnOrderWeighted.classList.toggle("active", state.orderMode === "weighted");
    els.btnOrderShuffle.classList.toggle("active", state.orderMode === "shuffle");
    els.btnOrderDefault.classList.toggle("active", state.orderMode === "default");
  }

  function renderAll() {
    els.title.textContent = state.title;
    document.title = state.title;
    els.linkSourceSheet.href = state.config.url;
    updateHeaderStats();
    updateToolbarControls();
    renderCurrentView();
  }

  // --- Shared Card Action Handler ---
  function handleCardClick(e) {
    const actionEl = e.target.closest("[data-action]");
    if (!actionEl) return;
    const card = actionEl.closest(".vocab-card");
    if (!card) return;
    const key = card.dataset.key;
    const w = state.words.find((item) => item.key === key);
    if (!w) return;

    const action = actionEl.dataset.action;
    if (action === "speak-word") {
      speakText(w.word, actionEl, "朗读词汇");
    } else if (action === "speak-sentence") {
      speakText(w.sentence, actionEl, "朗读原句");
    } else if (action === "speak-ielts") {
      const ielts = parseIeltsTip(w.tip);
      speakText(ielts.speakable, actionEl, "朗读例句");
    } else if (action === "shadow-word") {
      startShadowing(w);
    } else if (action === "toggle-master") {
      toggleMastered(key);
    } else if (action === "toggle-trans") {
      state.itemRevealOverrides[key] = !isTranslationVisible(key);
      saveDailySession();
      renderCurrentView();
    } else if (action === "override-check") {
      const res = state.itemCheckResults[key];
      if (res && !res.isCorrect && !res.overridden) {
        res.overridden = true;
        state.progress.correctCount = (state.progress.correctCount || 0) + 1;
        const cur = getItemProgress(key);
        state.progress.items[key] = {
          ...cur,
          review: false,
          wrongCount: Math.max(0, cur.wrongCount - 1),
          correctCount: cur.correctCount + 1,
          lastResult: "correct",
        };
        saveProgress();
        saveDailySession();
        updateHeaderStats();
        renderCurrentView();
      }
    } else if (action === "toggle-list-context") {
      state.itemExpandedListContext[key] = !state.itemExpandedListContext[key];
      renderCurrentView();
    } else if (action === "clear-shadow") {
      delete state.shadowResults[key];
      renderCurrentView();
    }
  }

  function handleCardInput(e) {
    if (!e.target.classList.contains("test-input")) return;
    const card = e.target.closest(".vocab-card");
    if (!card) return;
    state.itemInputs[card.dataset.key] = e.target.value;
    saveDailySession();
  }

  function handleCardSubmit(e) {
    const form = e.target.closest('[data-action="check-form"]');
    if (!form) return;
    e.preventDefault();
    const card = form.closest(".vocab-card");
    if (!card) return;
    const key = card.dataset.key;
    const w = state.words.find((item) => item.key === key);
    if (!w) return;

    const input = form.querySelector('input[name="answer"]');
    const userInput = (input ? input.value : "").trim();
    if (!userInput) {
      showToast("请先输入你的中文释义");
      if (input) input.focus();
      return;
    }

    state.itemInputs[key] = userInput;
    const isCorrect = checkTranslation(userInput, w.translation);
    state.itemCheckResults[key] = { isCorrect, userInput, overridden: false };
    // Auto-reveal translation after checking so user can compare immediately
    state.itemRevealOverrides[key] = true;

    const cur = getItemProgress(key);
    state.progress.testedCount = (state.progress.testedCount || 0) + 1;
    if (isCorrect) {
      state.progress.correctCount = (state.progress.correctCount || 0) + 1;
      state.progress.items[key] = {
        ...cur,
        review: false,
        correctCount: cur.correctCount + 1,
        lastResult: "correct",
      };
    } else {
      state.progress.items[key] = {
        ...cur,
        review: true,
        wrongCount: cur.wrongCount + 1,
        lastResult: "wrong",
      };
    }
    saveProgress();
    saveDailySession();
    updateHeaderStats();
    renderCurrentView();
  }

  // --- Event Binding ---
  function bindEvents() {
    els.syncPill.addEventListener("click", () => syncFromGoogleSheet(true));

    els.btnDismissBanner.addEventListener("click", () => {
      els.updateBanner.hidden = true;
    });
    els.btnViewNewWords.addEventListener("click", () => {
      state.prefs.filter = "new";
      state.currentIndex = 0;
      state.currentKey = null;
      els.updateBanner.hidden = true;
      saveJSON(STORAGE_KEYS.PREFS, state.prefs);
      saveDailySession();
      renderAll();
    });

    // View mode
    els.btnModeCard.addEventListener("click", () => {
      state.prefs.viewMode = "card";
      saveJSON(STORAGE_KEYS.PREFS, state.prefs);
      renderAll();
    });
    els.btnModeList.addEventListener("click", () => {
      state.prefs.viewMode = "list";
      saveJSON(STORAGE_KEYS.PREFS, state.prefs);
      renderAll();
    });

    // Global translation toggle
    els.btnGlobalTrans.addEventListener("click", () => {
      state.prefs.globalHideTranslation = !state.prefs.globalHideTranslation;
      state.itemRevealOverrides = {};
      saveJSON(STORAGE_KEYS.PREFS, state.prefs);
      saveDailySession();
      updateToolbarControls();
      renderCurrentView();
    });

    // Accent
    els.btnAccentUS.addEventListener("click", () => {
      state.prefs.accent = "en-US";
      saveJSON(STORAGE_KEYS.PREFS, state.prefs);
      updateToolbarControls();
      showToast("已切换为美式发音 (US)");
    });
    els.btnAccentUK.addEventListener("click", () => {
      state.prefs.accent = "en-GB";
      saveJSON(STORAGE_KEYS.PREFS, state.prefs);
      updateToolbarControls();
      showToast("已切换为英式发音 (UK)");
    });

    // Speed
    els.btnRateNormal.addEventListener("click", () => {
      state.prefs.rate = 1.0;
      saveJSON(STORAGE_KEYS.PREFS, state.prefs);
      updateToolbarControls();
      showToast("语速已设为正常 1.0x");
    });
    els.btnRateSlow.addEventListener("click", () => {
      state.prefs.rate = 0.7;
      saveJSON(STORAGE_KEYS.PREFS, state.prefs);
      updateToolbarControls();
      showToast("语速已设为慢速 0.7x（适合跟读）");
    });

    // Filter select
    els.filterSelect.addEventListener("change", (e) => {
      state.prefs.filter = e.target.value;
      state.currentIndex = 0;
      state.currentKey = null;
      saveJSON(STORAGE_KEYS.PREFS, state.prefs);
      saveDailySession();
      renderCurrentView();
    });

    // Order buttons
    els.btnOrderWeighted.addEventListener("click", () => {
      state.orderMode = "weighted";
      state.shuffledOrder = generateWeightedOrder();
      state.currentIndex = 0;
      state.currentKey = null;
      saveDailySession();
      updateToolbarControls();
      renderCurrentView();
      showToast("已生成智能抽查顺序（答错词高频优先，答对词降频）");
    });
    els.btnOrderShuffle.addEventListener("click", () => {
      const keys = state.words.map((w) => w.key);
      for (let i = keys.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [keys[i], keys[j]] = [keys[j], keys[i]];
      }
      state.orderMode = "shuffle";
      state.shuffledOrder = keys;
      state.currentIndex = 0;
      state.currentKey = null;
      saveDailySession();
      updateToolbarControls();
      renderCurrentView();
      showToast("已随机打乱词汇顺序");
    });
    els.btnOrderDefault.addEventListener("click", () => {
      state.orderMode = "default";
      state.shuffledOrder = null;
      state.currentIndex = 0;
      state.currentKey = null;
      saveDailySession();
      updateToolbarControls();
      renderCurrentView();
      showToast("已恢复表格原序");
    });

    // Search
    els.searchInput.addEventListener("input", (e) => {
      state.searchQuery = e.target.value;
      state.currentIndex = 0;
      renderCurrentView();
    });

    // Card mode bottom nav
    els.btnPrevCard.addEventListener("click", () => {
      if (state.currentIndex > 0) {
        stopSpeaking(true);
        state.currentIndex--;
        renderCardMode();
      }
    });
    els.btnNextCard.addEventListener("click", () => {
      const words = getFilteredWords();
      if (state.currentIndex < words.length - 1) {
        stopSpeaking(true);
        state.currentIndex++;
        renderCardMode();
      }
    });
    els.btnSpeakCurrent.addEventListener("click", () => {
      const words = getFilteredWords();
      const w = words[state.currentIndex];
      if (w) speakText(w.word, els.btnSpeakCurrent, "跟读发音");
    });

    // Delegate card actions in both Card Mode & List Mode
    [els.cardModeSlot, els.listModeSection].forEach((container) => {
      container.addEventListener("click", handleCardClick);
      container.addEventListener("input", handleCardInput);
      container.addEventListener("submit", handleCardSubmit);
    });

    // Keyboard shortcuts in Card Mode
    document.addEventListener("keydown", (e) => {
      if (state.prefs.viewMode !== "card") return;
      if (!els.settingsModal.hidden) return;
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;

      const words = getFilteredWords();
      if (words.length === 0) return;
      const w = words[state.currentIndex];

      if (e.code === "Space") {
        e.preventDefault();
        if (w) speakText(w.word, null, "朗读词汇");
      } else if (e.key === "s" || e.key === "S") {
        e.preventDefault();
        if (w && w.sentence) speakText(w.sentence, null, "朗读原句");
      } else if (e.key === "ArrowLeft") {
        if (state.currentIndex > 0) {
          stopSpeaking(true);
          state.currentIndex--;
          renderCardMode();
        }
      } else if (e.key === "ArrowRight") {
        if (state.currentIndex < words.length - 1) {
          stopSpeaking(true);
          state.currentIndex++;
          renderCardMode();
        }
      }
    });

    // Footer reset progress
    els.btnResetFooter.addEventListener("click", () => {
      if (!window.confirm("确定要清空所有本地「已掌握 / 错题 / 自测统计 / 今日填写」记录吗？单词库不会被删除。")) {
        return;
      }
      state.progress = { items: {}, testedCount: 0, correctCount: 0 };
      state.itemCheckResults = {};
      state.itemInputs = {};
      state.itemRevealOverrides = {};
      state.currentIndex = 0;
      state.currentKey = null;
      saveProgress();
      saveDailySession();
      renderAll();
      showToast("本地学习与测试记录已清空");
    });

    // Settings Modal
    const updateTtsEngineFields = () => {
      const eng = els.selectTtsEngine.value;
      els.openaiConfigBox.hidden = eng !== "openai";
      if (eng === "openai") {
        els.ttsEngineDesc.textContent =
          "调用 OpenAI TTS 接口生成播音级真人发音（支持官方或兼容中转接口），音频自动缓存。";
      } else if (eng === "browser") {
        els.ttsEngineDesc.textContent =
          "使用浏览器内置语音。强烈建议用 Microsoft Edge 浏览器打开，免费自带微软 Azure AI 神经语音（Aria / Guy / Sonia）。";
      } else {
        els.ttsEngineDesc.textContent =
          "单词使用真人词典音，长句使用在线自然语音；若网络受限则自动回退本地语音。";
      }
    };

    const openSettingsModal = () => {
      els.selectTtsEngine.value = state.ttsConfig.engine || "online";
      els.inputOpenaiBase.value = state.ttsConfig.openaiBaseUrl || "https://api.openai.com/v1";
      els.inputOpenaiKey.value = state.ttsConfig.openaiApiKey || "";
      els.selectOpenaiModel.value = state.ttsConfig.openaiModel || "gpt-4o-mini-tts";
      els.selectOpenaiVoice.value = state.ttsConfig.openaiVoice || "nova";
      updateTtsEngineFields();

      els.inputSheetUrl.value = state.config.url;
      els.settingsSyncMeta.textContent = state.lastSyncAt
        ? `上次同步：${formatTime(state.lastSyncAt)}（${state.lastSyncSummary || `共 ${state.words.length} 词`}）`
        : "尚未完成同步";
      els.settingsModal.hidden = false;
    };

    els.btnOpenSettings.addEventListener("click", openSettingsModal);
    els.ttsStatusBadge.addEventListener("click", openSettingsModal);
    els.selectTtsEngine.addEventListener("change", updateTtsEngineFields);

    els.btnTestVoice.addEventListener("click", () => {
      const previewCfg = {
        engine: els.selectTtsEngine.value,
        openaiBaseUrl: els.inputOpenaiBase.value.trim() || "https://api.openai.com/v1",
        openaiApiKey: els.inputOpenaiKey.value.trim(),
        openaiModel: els.selectOpenaiModel.value,
        openaiVoice: els.selectOpenaiVoice.value,
      };
      speakText(
        "Governments should adopt international best practices to optimize public healthcare systems.",
        els.btnTestVoice,
        "试听例句",
        previewCfg
      );
    });

    const closeSettings = () => {
      els.settingsModal.hidden = true;
    };
    els.btnCloseSettings.addEventListener("click", closeSettings);
    els.btnCancelSettings.addEventListener("click", closeSettings);
    els.settingsModal.addEventListener("click", (e) => {
      if (e.target === els.settingsModal) closeSettings();
    });

    els.settingsForm.addEventListener("submit", (e) => {
      e.preventDefault();
      const rawUrl = els.inputSheetUrl.value.trim();
      const parsed = parseSheetUrl(rawUrl);
      if (!parsed) {
        showToast("请输入有效的 Google 表格链接");
        return;
      }

      const sheetChanged =
        parsed.sheetId !== state.config.sheetId || parsed.gid !== state.config.gid;

      state.ttsConfig = {
        engine: els.selectTtsEngine.value,
        openaiBaseUrl: els.inputOpenaiBase.value.trim() || "https://api.openai.com/v1",
        openaiApiKey: els.inputOpenaiKey.value.trim(),
        openaiModel: els.selectOpenaiModel.value,
        openaiVoice: els.selectOpenaiVoice.value,
      };
      saveJSON(STORAGE_KEYS.TTS_CONFIG, state.ttsConfig);
      updateTtsStatus(getReadyTtsLabel(), "ready");

      state.config = { sheetId: parsed.sheetId, gid: parsed.gid, url: rawUrl };
      saveJSON(STORAGE_KEYS.CONFIG, state.config);
      closeSettings();

      if (sheetChanged) {
        syncFromGoogleSheet(true);
      } else {
        showToast("语音与同步设置已保存");
      }
    });

    // Check daily reset & re-check Google Sheet when switching back to tab
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState !== "visible") return;
      if (state.sessionDate && getTodayStr() !== state.sessionDate) {
        loadOrResetDailySession(true);
        renderAll();
      }
      if (Date.now() - lastAutoCheckTs > 90_000) {
        syncFromGoogleSheet(false);
      }
    });
  }

  // --- Bootstrap ---
  function init() {
    const cached = loadJSON(STORAGE_KEYS.CACHE, null);
    if (
      cached &&
      cached.sheetId === state.config.sheetId &&
      Array.isArray(cached.words) &&
      cached.words.length > 0
    ) {
      state.words = cached.words;
      if (cached.title) state.title = cached.title;
      state.lastSyncAt = cached.syncedAt || null;
    } else if (Array.isArray(window.FALLBACK_WORDS) && window.FALLBACK_WORDS.length > 0) {
      state.words = window.FALLBACK_WORDS.map((w, idx) => ({
        id: idx + 1,
        key: wordKey(w.word),
        word: w.word,
        translation: w.translation,
        sentence: w.sentence || "",
        tip: w.tip || "",
      }));
    }

    // Restore today's position & filled inputs (or auto-reset if a new day has started)
    loadOrResetDailySession(true);

    loadVoices();
    if ("speechSynthesis" in window) {
      window.speechSynthesis.onvoiceschanged = loadVoices;
    }

    updateTtsStatus(getReadyTtsLabel(), "ready");
    bindEvents();
    renderAll();

    // Automatically detect Google Sheet updates on every page open
    syncFromGoogleSheet(false);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
