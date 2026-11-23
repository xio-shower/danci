(() => {
  "use strict";

  const DEFAULT_SHEET_ID = "1Ho3WWDmm6kod9JoKVz87UOcsje7fBaWclRo2QbGO9-c";
  const DEFAULT_GID = "0";

  const STORAGE_KEYS = {
    CONFIG: "danci_sheet_config_v1",
    CACHE: "danci_vocab_cache_v1",
    PROGRESS: "danci_learning_progress_v1",
    PREFS: "danci_user_prefs_v1",
  };

  // --- State ---
  const state = {
    config: loadJSON(STORAGE_KEYS.CONFIG, {
      sheetId: DEFAULT_SHEET_ID,
      gid: DEFAULT_GID,
      url: `https://docs.google.com/spreadsheets/d/${DEFAULT_SHEET_ID}/edit?gid=${DEFAULT_GID}#gid=${DEFAULT_GID}`,
    }),
    title: window.FALLBACK_SHEET_TITLE || "单词记忆本",
    words: [],
    progress: loadJSON(STORAGE_KEYS.PROGRESS, {}), // { [key]: { status: 'mastered'|'review'|'none', correct: 0, wrong: 0 } }
    prefs: loadJSON(STORAGE_KEYS.PREFS, {
      mode: "list", // 'list' | 'quiz'
      hideTranslation: false,
      accent: "en-US", // 'en-US' | 'en-GB'
      rate: 1.0, // 1.0 | 0.75
      filter: "all",
    }),
    searchQuery: "",
    orderSeed: null, // array of keys when shuffled
    newWordKeys: new Set(),
    updatedWordKeys: new Set(),
    lastSyncAt: null,
    lastSyncSummary: "",
    // Per-card transient UI state (not persisted)
    revealedKeys: new Set(),
    inlineTestResults: {}, // { [key]: { userInput, isCorrect, overridden } }
    shadowResults: {}, // { [key]: { transcript, passed, status: 'listening'|'done'|'error', message } }
    // Quiz state
    quizIndex: 0,
    quizShowHint: false,
    quizAnswerState: null, // null | { userInput, isCorrect, skipped, overridden }
    quizSessionStats: { right: 0, total: 0 },
  };

  let activeRecognition = null;
  let activeSpeakingEl = null;
  let toastTimer = null;
  let lastAutoCheckTs = 0;

  // --- DOM Elements ---
  const els = {
    title: document.getElementById("notebook-title"),
    syncPill: document.getElementById("sync-status-pill"),
    syncText: document.getElementById("sync-status-text"),
    btnSyncNow: document.getElementById("btn-sync-now"),
    linkSourceSheet: document.getElementById("link-source-sheet"),
    btnOpenSettings: document.getElementById("btn-open-settings"),
    updateBanner: document.getElementById("update-banner"),
    updateBannerMsg: document.getElementById("update-banner-message"),
    btnViewNewWords: document.getElementById("btn-view-new-words"),
    btnDismissBanner: document.getElementById("btn-dismiss-banner"),
    tabList: document.getElementById("tab-list"),
    tabQuiz: document.getElementById("tab-quiz"),
    hideTransLabel: document.getElementById("hide-trans-label"),
    toggleHideTrans: document.getElementById("toggle-hide-translation"),
    btnAccentUS: document.getElementById("btn-accent-us"),
    btnAccentUK: document.getElementById("btn-accent-uk"),
    btnSpeedToggle: document.getElementById("btn-speed-toggle"),
    filterPills: document.getElementById("filter-pills"),
    pillFilterNew: document.getElementById("pill-filter-new"),
    countAll: document.getElementById("count-all"),
    countUnmastered: document.getElementById("count-unmastered"),
    countReview: document.getElementById("count-review"),
    countMastered: document.getElementById("count-mastered"),
    countNew: document.getElementById("count-new"),
    searchInput: document.getElementById("search-input"),
    btnShuffle: document.getElementById("btn-shuffle"),
    progressLabel: document.getElementById("progress-label"),
    progressBarFill: document.getElementById("progress-bar-fill"),
    progressPercent: document.getElementById("progress-percent"),
    listView: document.getElementById("list-view"),
    quizView: document.getElementById("quiz-view"),
    settingsModal: document.getElementById("settings-modal"),
    settingsForm: document.getElementById("settings-form"),
    inputSheetUrl: document.getElementById("input-sheet-url"),
    settingsSyncMeta: document.getElementById("settings-sync-meta"),
    btnCloseSettings: document.getElementById("btn-close-settings"),
    btnCancelSettings: document.getElementById("btn-cancel-settings"),
    btnResetProgress: document.getElementById("btn-reset-progress"),
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
      // Ignore quota errors
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
    }, 2600);
  }

  function formatTime(ts) {
    if (!ts) return "从未";
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    const ss = String(d.getSeconds()).padStart(2, "0");
    return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}:${ss}`;
  }

  // --- Highlight term in sentence ---
  function highlightSentence(sentence, term) {
    if (!sentence) return "";
    const safeSentence = escapeHTML(sentence);
    if (!term) return safeSentence;

    // Handle patterns like "put [sth] right to work"
    const cleaned = term.replace(/\[[^\]]+\]/g, "___WILDCARD___").trim();
    const parts = cleaned
      .split("___WILDCARD___")
      .map((p) => p.trim())
      .filter(Boolean);

    if (parts.length === 0) return safeSentence;

    try {
      let pattern;
      if (parts.length === 1) {
        pattern = escapeRegex(escapeHTML(parts[0]));
      } else {
        pattern = parts
          .map((p) => escapeRegex(escapeHTML(p)))
          .join("\\s+(?:\\S+\\s+){0,4}?");
      }
      const re = new RegExp(`(${pattern})`, "gi");
      if (re.test(safeSentence)) {
        return safeSentence.replace(re, '<mark class="term-mark">$1</mark>');
      }
    } catch {
      // Fallback safely
    }
    return safeSentence;
  }

  // --- Format IELTS tip ---
  function formatTipHTML(tip) {
    if (!tip) return "";
    const match = tip.match(/^(【[^】]+】)\s*(.*)$/);
    if (match) {
      return `<span class="tip-tag">${escapeHTML(match[1])}</span><span>${escapeHTML(match[2])}</span>`;
    }
    return `<span>${escapeHTML(tip)}</span>`;
  }

  function extractEnglishFromTip(tip) {
    if (!tip) return "";
    // Remove leading 【...】 tag and trailing Chinese parenthetical note
    let text = tip.replace(/^【[^】]+】\s*/, "");
    const exMatch = text.match(/例[：:]\s*(.+)$/);
    if (exMatch) {
      text = exMatch[1];
    }
    text = text.replace(/[（(]注[：:][^）)]*[）)]/g, "").trim();
    // Only return if it has substantial English words
    const englishLetters = (text.match(/[A-Za-z]/g) || []).length;
    return englishLetters >= 12 ? text : "";
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
    if (a.length < 2 || b.length < 2) {
      return a.includes(b) || b.includes(a) ? 1 : 0;
    }
    const bigramsA = new Map();
    for (let i = 0; i < a.length - 1; i++) {
      const bg = a.slice(i, i + 2);
      bigramsA.set(bg, (bigramsA.get(bg) || 0) + 1);
    }
    let intersection = 0;
    for (let i = 0; i < b.length - 1; i++) {
      const bg = b.slice(i, i + 2);
      const count = bigramsA.get(bg) || 0;
      if (count > 0) {
        intersection++;
        bigramsA.set(bg, count - 1);
      }
    }
    return (2 * intersection) / (a.length - 1 + (b.length - 1));
  }

  function charRecall(userNorm, refNorm) {
    if (!userNorm || !refNorm) return 0;
    const refChars = new Set(refNorm.split(""));
    let hit = 0;
    for (const ch of userNorm) {
      if (refChars.has(ch)) hit++;
    }
    return hit / userNorm.length;
  }

  function checkTranslation(userInput, standardTranslation) {
    const rawUser = String(userInput || "").trim();
    if (!rawUser) return false;

    const userNorm = normalizeZh(rawUser);
    if (!userNorm) return false;

    // Strip parenthetical explanations like （非“报道”） or （注意区分...）
    const coreOnly = String(standardTranslation || "")
      .replace(/（[^）]*）/g, "")
      .replace(/\([^)]*\)/g, "")
      .trim();

    // Also keep full text without parentheses symbols for lenient match (e.g. "行业报告")
    const expanded = String(standardTranslation || "")
      .replace(/[（()）]/g, "")
      .trim();

    const segments = coreOnly
      .split(/[；;、/，,]+/)
      .map((s) => normalizeZh(s))
      .filter(Boolean);

    // Also split user input if they entered multiple meanings
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
          const r1 = charRecall(u, seg);
          const r2 = charRecall(seg, u);
          if (r1 >= 0.75 && r2 >= 0.5) return true;
        }
      }
      // Check against expanded text (without parentheses) for cases like "（行业）报告"
      const expNorm = normalizeZh(expanded);
      if (u.length >= 2 && expNorm.includes(u)) {
        // Make sure user didn't type the "非..." negative example!
        const negMatches = [...String(standardTranslation || "").matchAll(/非[“"'「]?([^”"'」)）]+)/g)];
        const isNegativeTrap = negMatches.some((m) => normalizeZh(m[1]).includes(u) || u.includes(normalizeZh(m[1])));
        if (!isNegativeTrap) return true;
      }
    }

    return false;
  }

  // --- RFC-4180 CSV Parser ---
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
        if (ch === '"') {
          inQuotes = true;
        } else if (ch === ",") {
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

      // Detect single-cell title row
      if (i === 0 && r[0] && (!r[1] || r[1] === "")) {
        sheetTitle = r[0];
        continue;
      }

      // Skip header row
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
          words.push({ key, word, translation, sentence, tip });
        }
      }
    }

    return { sheetTitle, words };
  }

  // --- Google Sheets Fetch (CSV + JSONP fallback) ---
  function parseSheetUrl(url) {
    const idMatch = String(url || "").match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    if (!idMatch) return null;
    const gidMatch = String(url || "").match(/[?#&]gid=(\d+)/);
    return {
      sheetId: idMatch[1],
      gid: gidMatch ? gidMatch[1] : "0",
    };
  }

  async function fetchSheetViaCSV(sheetId, gid) {
    const url = `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&gid=${gid}&_t=${Date.now()}`;
    const res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    // Guard against HTML login redirect
    if (/^\s*<!doctype html|^\s*<html/i.test(text)) {
      throw new Error("表格未开启公开可读权限（需要设置为「知道链接的任何人可查看」）");
    }
    const rows = parseCSV(text);
    return extractVocabFromRows(rows);
  }

  function fetchSheetViaJSONP(sheetId, gid) {
    return new Promise((resolve, reject) => {
      const cbName = `__danciGvizCb_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
      const script = document.createElement("script");
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("JSONP 请求超时"));
      }, 10000);

      function cleanup() {
        clearTimeout(timeout);
        delete window[cbName];
        if (script.parentNode) script.parentNode.removeChild(script);
      }

      window[cbName] = (response) => {
        cleanup();
        try {
          if (!response || response.status === "error" || !response.table) {
            reject(new Error("Google 表格返回异常"));
            return;
          }
          const rows = [];
          const cols = response.table.cols || [];
          const colLabels = cols.map((c) => (c && c.label ? String(c.label).trim() : ""));
          if (colLabels.some(Boolean)) {
            rows.push(colLabels);
          }
          for (const tr of response.table.rows || []) {
            const cells = (tr.c || []).map((cell) => {
              if (!cell || cell.v == null) return "";
              return String(cell.f != null ? cell.f : cell.v);
            });
            rows.push(cells);
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

  async function syncFromGoogleSheet(isManual = false) {
    setSyncUI("syncing", "正在探测表格更新…");
    els.btnSyncNow.disabled = true;
    lastAutoCheckTs = Date.now();

    try {
      let data;
      try {
        data = await fetchSheetViaCSV(state.config.sheetId, state.config.gid);
      } catch (csvErr) {
        // Fallback to JSONP (especially helpful if opened via file://)
        data = await fetchSheetViaJSONP(state.config.sheetId, state.config.gid);
      }

      if (!data.words || data.words.length === 0) {
        throw new Error("未解析到有效单词行，请检查表格前两列是否为「单词」与「翻译」");
      }

      // Compute diff against current local words
      const oldMap = new Map(state.words.map((w) => [w.key, w]));
      const newMap = new Map(data.words.map((w) => [w.key, w]));

      const added = [];
      const updated = [];
      let removedCount = 0;

      for (const w of data.words) {
        const prev = oldMap.get(w.key);
        if (!prev) {
          added.push(w.key);
        } else if (
          prev.translation !== w.translation ||
          prev.sentence !== w.sentence ||
          prev.tip !== w.tip ||
          prev.word !== w.word
        ) {
          updated.push(w.key);
        }
      }

      for (const prevKey of oldMap.keys()) {
        if (!newMap.has(prevKey)) removedCount++;
      }

      const hadExistingCache = state.words.length > 0 && Boolean(loadJSON(STORAGE_KEYS.CACHE, null));
      state.words = data.words;
      if (data.sheetTitle) {
        state.title = data.sheetTitle;
      }
      state.lastSyncAt = Date.now();

      // Persist updated vocab cache
      saveJSON(STORAGE_KEYS.CACHE, {
        sheetId: state.config.sheetId,
        gid: state.config.gid,
        title: state.title,
        words: state.words,
        syncedAt: state.lastSyncAt,
      });

      const hasChanges = added.length > 0 || updated.length > 0 || removedCount > 0;

      if (hasChanges && hadExistingCache) {
        state.newWordKeys = new Set(added);
        state.updatedWordKeys = new Set(updated);
        const parts = [];
        if (added.length) parts.push(`新增 ${added.length} 词`);
        if (updated.length) parts.push(`更新 ${updated.length} 词`);
        if (removedCount) parts.push(`移除 ${removedCount} 词`);
        const summary = parts.join("，");
        state.lastSyncSummary = summary;

        setSyncUI("updated", `已更新：${summary}`);
        showUpdateBanner(`检测到 Google 表格有变动，已自动同步到词库：${summary}。`, added.length > 0);
        if (isManual) showToast(`同步完成：${summary}`);
      } else {
        state.lastSyncSummary = `共 ${state.words.length} 词，已是最新`;
        setSyncUI("ok", `已自动同步 · ${state.words.length} 词`);
        if (isManual) showToast(`已是最新词库（共 ${state.words.length} 词）`);
      }

      renderAll();
    } catch (err) {
      console.error("Sync failed:", err);
      setSyncUI("error", "同步失败，当前使用本地缓存");
      if (isManual) {
        showToast(`同步失败：${err.message}`);
      }
    } finally {
      els.btnSyncNow.disabled = false;
    }
  }

  function setSyncUI(status, text) {
    els.syncPill.dataset.state = status;
    els.syncText.textContent = text;
  }

  function showUpdateBanner(message, hasNewWords) {
    els.updateBannerMsg.textContent = message;
    els.btnViewNewWords.hidden = !hasNewWords;
    els.updateBanner.hidden = false;
  }

  // --- Speech Synthesis (TTS) ---
  function cleanForSpeech(text) {
    return String(text || "")
      .replace(/\[sth\]/gi, "something")
      .replace(/\[sb\]/gi, "somebody")
      .replace(/\[[^\]]+\]/g, "")
      .trim();
  }

  function pickVoice(lang) {
    if (!("speechSynthesis" in window)) return null;
    const voices = window.speechSynthesis.getVoices();
    if (!voices || voices.length === 0) return null;

    const exact = voices.filter((v) => v.lang.toLowerCase() === lang.toLowerCase());
    const preferred =
      exact.find((v) => /google|natural|samantha|daniel|aria|jenny|libby/i.test(v.name)) ||
      exact[0] ||
      voices.find((v) => v.lang.toLowerCase().startsWith(lang.slice(0, 2).toLowerCase()));
    return preferred || null;
  }

  function speakText(text, triggerEl = null, customRate = null) {
    if (!("speechSynthesis" in window)) {
      showToast("当前浏览器不支持语音朗读");
      return;
    }
    const content = cleanForSpeech(text);
    if (!content) return;

    window.speechSynthesis.cancel();
    if (activeSpeakingEl) {
      activeSpeakingEl.classList.remove("speaking", "is-active");
      activeSpeakingEl = null;
    }

    const utter = new SpeechSynthesisUtterance(content);
    utter.lang = state.prefs.accent;
    utter.rate = customRate || state.prefs.rate;
    const voice = pickVoice(state.prefs.accent);
    if (voice) utter.voice = voice;

    if (triggerEl) {
      activeSpeakingEl = triggerEl;
      triggerEl.classList.add(triggerEl.classList.contains("audio-btn") ? "is-active" : "speaking");
    }

    utter.onend = () => {
      if (triggerEl) triggerEl.classList.remove("speaking", "is-active");
      if (activeSpeakingEl === triggerEl) activeSpeakingEl = null;
    };
    utter.onerror = () => {
      if (triggerEl) triggerEl.classList.remove("speaking", "is-active");
      if (activeSpeakingEl === triggerEl) activeSpeakingEl = null;
    };

    window.speechSynthesis.speak(utter);
  }

  // --- Speech Recognition (Shadowing / 跟读) ---
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
    for (const tw of tWords) {
      if (sWords.has(tw)) hits++;
    }
    return hits / tWords.length >= 0.65;
  }

  function startShadowing(wordObj, triggerEl) {
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) {
      // Graceful fallback: play slow audio for manual shadowing
      showToast("当前浏览器不支持语音识别跟读，已为你慢速朗读供跟读");
      speakText(wordObj.word, triggerEl, 0.75);
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

    window.speechSynthesis && window.speechSynthesis.cancel();

    const rec = new SpeechRec();
    rec.lang = state.prefs.accent;
    rec.interimResults = false;
    rec.maxAlternatives = 3;
    activeRecognition = rec;

    state.shadowResults[wordObj.key] = {
      status: "listening",
      message: "正在聆听，请清晰朗读该单词/短语…",
    };
    renderCurrentView();

    rec.onresult = (event) => {
      const results = event.results[0];
      const transcripts = [];
      for (let i = 0; i < results.length; i++) {
        transcripts.push(results[i].transcript);
      }
      const best = transcripts[0] || "";
      const passed = transcripts.some((tr) => compareSpeech(tr, wordObj.word));
      state.shadowResults[wordObj.key] = {
        status: "done",
        transcript: best,
        passed,
        message: passed
          ? `跟读识别：“${best}” — 发音很棒！`
          : `跟读识别：“${best}” — 可以再听一次试试`,
      };
      activeRecognition = null;
      renderCurrentView();
    };

    rec.onerror = (event) => {
      const msg =
        event.error === "not-allowed"
          ? "未获得麦克风权限，请在浏览器地址栏允许麦克风访问"
          : event.error === "no-speech"
          ? "没有听到声音，请靠近麦克风再试一次"
          : `语音识别中断（${event.error}）`;
      state.shadowResults[wordObj.key] = {
        status: "error",
        message: msg,
      };
      activeRecognition = null;
      renderCurrentView();
    };

    rec.onend = () => {
      if (activeRecognition === rec) {
        activeRecognition = null;
      }
    };

    try {
      rec.start();
    } catch {
      showToast("无法启动麦克风，请重试");
    }
  }

  // --- Progress Management ---
  function getProgress(key) {
    return state.progress[key] || { status: "none", correct: 0, wrong: 0 };
  }

  function setWordStatus(key, status) {
    const prev = getProgress(key);
    state.progress[key] = { ...prev, status };
    saveJSON(STORAGE_KEYS.PROGRESS, state.progress);
    updateCountsAndProgress();
  }

  function recordTestAttempt(key, isCorrect) {
    const prev = getProgress(key);
    const nextStatus = isCorrect
      ? prev.status === "review"
        ? "none"
        : prev.status
      : "review";
    state.progress[key] = {
      status: nextStatus,
      correct: (prev.correct || 0) + (isCorrect ? 1 : 0),
      wrong: (prev.wrong || 0) + (isCorrect ? 0 : 1),
    };
    saveJSON(STORAGE_KEYS.PROGRESS, state.progress);
    updateCountsAndProgress();
  }

  // --- Filtering & Ordering ---
  function getFilteredWords() {
    let list = [...state.words];

    // Apply custom shuffle order if set
    if (state.orderSeed && state.orderSeed.length > 0) {
      const indexMap = new Map(state.orderSeed.map((k, idx) => [k, idx]));
      list.sort((a, b) => {
        const ia = indexMap.has(a.key) ? indexMap.get(a.key) : 999999;
        const ib = indexMap.has(b.key) ? indexMap.get(b.key) : 999999;
        return ia - ib;
      });
    }

    // Filter by status
    if (state.prefs.filter === "unmastered") {
      list = list.filter((w) => getProgress(w.key).status !== "mastered");
    } else if (state.prefs.filter === "review") {
      list = list.filter((w) => getProgress(w.key).status === "review");
    } else if (state.prefs.filter === "mastered") {
      list = list.filter((w) => getProgress(w.key).status === "mastered");
    } else if (state.prefs.filter === "new") {
      list = list.filter((w) => state.newWordKeys.has(w.key));
    }

    // Search filter
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

  function updateCountsAndProgress() {
    const total = state.words.length;
    let mastered = 0;
    let review = 0;

    for (const w of state.words) {
      const st = getProgress(w.key).status;
      if (st === "mastered") mastered++;
      else if (st === "review") review++;
    }

    const unmastered = total - mastered;
    const newCount = state.newWordKeys.size;

    els.countAll.textContent = total;
    els.countUnmastered.textContent = unmastered;
    els.countReview.textContent = review;
    els.countMastered.textContent = mastered;
    els.countNew.textContent = newCount;
    els.pillFilterNew.hidden = newCount === 0;

    const pct = total > 0 ? Math.round((mastered / total) * 100) : 0;
    els.progressLabel.textContent = `已掌握 ${mastered} / ${total}`;
    els.progressBarFill.style.width = `${pct}%`;
    els.progressPercent.textContent = `${pct}%`;
  }

  // --- Rendering: List View ---
  function renderListView() {
    const words = getFilteredWords();
    if (words.length === 0) {
      els.listView.innerHTML = `
        <div class="empty-state">
          <p>当前筛选条件下没有匹配的单词。</p>
          <button type="button" class="btn btn-sm" id="btn-clear-filters">查看全部单词</button>
        </div>
      `;
      const btn = document.getElementById("btn-clear-filters");
      if (btn) {
        btn.addEventListener("click", () => {
          state.prefs.filter = "all";
          state.searchQuery = "";
          els.searchInput.value = "";
          saveJSON(STORAGE_KEYS.PREFS, state.prefs);
          renderAll();
        });
      }
      return;
    }

    const fragment = document.createDocumentFragment();

    words.forEach((w, idx) => {
      const prog = getProgress(w.key);
      const isMastered = prog.status === "mastered";
      const isReview = prog.status === "review";
      const isNew = state.newWordKeys.has(w.key);
      const isRevealed = !state.prefs.hideTranslation || state.revealedKeys.has(w.key);
      const testRes = state.inlineTestResults[w.key];
      const shadowRes = state.shadowResults[w.key];
      const tipEnglish = extractEnglishFromTip(w.tip);

      const card = document.createElement("article");
      card.className = `word-card${isMastered ? " is-mastered" : ""}`;
      card.dataset.key = w.key;

      let translationHTML = "";
      if (isRevealed) {
        translationHTML = `
          <div class="translation-text">
            <span>${escapeHTML(w.translation)}</span>
            ${
              state.prefs.hideTranslation
                ? `<button type="button" class="btn btn-ghost btn-sm" data-action="hide-one">重新隐藏</button>`
                : ""
            }
          </div>
        `;
      } else {
        const resultHTML = testRes
          ? `
            <div class="test-result ${testRes.isCorrect || testRes.overridden ? "correct" : "wrong"}">
              <div class="test-result-head">
                <span>${
                  testRes.isCorrect
                    ? "✓ 回答正确"
                    : testRes.overridden
                    ? "✓ 已标记为答对"
                    : `✕ 有偏差（你输入：${escapeHTML(testRes.userInput)}）`
                }</span>
                <div class="controls-group">
                  ${
                    !testRes.isCorrect && !testRes.overridden
                      ? `<button type="button" class="btn btn-sm" data-action="override-inline">意思相近，算我答对</button>`
                      : ""
                  }
                  <button type="button" class="btn btn-ghost btn-sm" data-action="retry-inline">再测一次</button>
                </div>
              </div>
              <div class="test-result-answer">参考翻译：${escapeHTML(w.translation)}</div>
            </div>
          `
          : "";

        translationHTML = `
          <div class="translation-hidden-box">
            <form class="inline-test-row" data-action="inline-test-form">
              <input
                type="text"
                class="test-input"
                name="answer"
                placeholder="输入中文翻译自测（回车核对）…"
                value="${testRes ? escapeHTML(testRes.userInput) : ""}"
                autocomplete="off"
              />
              <button type="submit" class="btn btn-primary btn-sm">核对</button>
              <button type="button" class="btn btn-sm" data-action="peek">偷看答案</button>
            </form>
            ${resultHTML}
          </div>
        `;
      }

      const shadowHTML = shadowRes
        ? `
          <div class="shadow-feedback ${
            shadowRes.status === "done" ? (shadowRes.passed ? "pass" : "retry") : ""
          }">
            <span>${escapeHTML(shadowRes.message)}</span>
            <button type="button" class="btn btn-ghost btn-sm" data-action="clear-shadow">关闭</button>
          </div>
        `
        : "";

      card.innerHTML = `
        <div class="word-card-header">
          <div class="word-head-left">
            <span class="word-index">${String(idx + 1).padStart(2, "0")}</span>
            <button type="button" class="word-term-btn" data-action="speak-word" title="点击发声">
              <span>${escapeHTML(w.word)}</span>
            </button>
            ${isNew ? `<span class="badge-new">新增</span>` : ""}
          </div>
          <div class="word-head-actions">
            <button type="button" class="audio-btn" data-action="speak-word" title="朗读单词">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
                <path d="M19.07 4.93a10 10 0 0 1 0 14.14"/>
              </svg>
              <span>发音</span>
            </button>
            <button type="button" class="audio-btn ${
              shadowRes && shadowRes.status === "listening" ? "is-recording" : ""
            }" data-action="shadow-word" title="点击跟读并检测发音">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
                <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                <line x1="12" y1="19" x2="12" y2="22"/>
              </svg>
              <span>${shadowRes && shadowRes.status === "listening" ? "聆听中…" : "跟读"}</span>
            </button>
            <button type="button" class="status-btn ${isMastered ? "mastered" : isReview ? "review" : ""}" data-action="toggle-mastery" title="切换掌握状态">
              ${isMastered ? "✓ 已掌握" : isReview ? "需复习" : "标记掌握"}
            </button>
          </div>
        </div>

        ${shadowHTML}

        <div class="translation-section">
          ${translationHTML}
        </div>

        ${
          w.sentence || w.tip
            ? `
          <div class="context-block">
            ${
              w.sentence
                ? `
              <div class="sentence-line">
                <div><span class="sentence-label">原句</span>${highlightSentence(w.sentence, w.word)}</div>
                <button type="button" class="btn btn-ghost btn-sm" data-action="speak-sentence" title="朗读原句">读原句</button>
              </div>
            `
                : ""
            }
            ${
              w.tip
                ? `
              <div class="tip-line">
                <div>${formatTipHTML(w.tip)}</div>
                ${
                  tipEnglish
                    ? `<button type="button" class="btn btn-ghost btn-sm" data-action="speak-tip" title="朗读例句">读例句</button>`
                    : ""
                }
              </div>
            `
                : ""
            }
          </div>
        `
            : ""
        }
      `;

      fragment.appendChild(card);
    });

    els.listView.innerHTML = "";
    els.listView.appendChild(fragment);
  }

  // --- Rendering: Quiz View ---
  function renderQuizView() {
    const words = getFilteredWords();
    if (words.length === 0) {
      els.quizView.innerHTML = `
        <div class="empty-state">
          <p>当前筛选条件下没有可测试的单词。</p>
          <button type="button" class="btn btn-sm" id="btn-quiz-clear-filters">查看全部单词</button>
        </div>
      `;
      const btn = document.getElementById("btn-quiz-clear-filters");
      if (btn) {
        btn.addEventListener("click", () => {
          state.prefs.filter = "all";
          state.searchQuery = "";
          els.searchInput.value = "";
          saveJSON(STORAGE_KEYS.PREFS, state.prefs);
          renderAll();
        });
      }
      return;
    }

    if (state.quizIndex >= words.length) state.quizIndex = 0;
    if (state.quizIndex < 0) state.quizIndex = words.length - 1;

    const w = words[state.quizIndex];
    const prog = getProgress(w.key);
    const ans = state.quizAnswerState;
    const shadowRes = state.shadowResults[w.key];
    const tipEnglish = extractEnglishFromTip(w.tip);

    const shadowHTML = shadowRes
      ? `
        <div class="shadow-feedback ${
          shadowRes.status === "done" ? (shadowRes.passed ? "pass" : "retry") : ""
        }" style="margin-top: 14px; text-align: left;">
          <span>${escapeHTML(shadowRes.message)}</span>
          <button type="button" class="btn btn-ghost btn-sm" data-quiz-action="clear-shadow">关闭</button>
        </div>
      `
      : "";

    let answerSectionHTML = "";
    if (!ans) {
      answerSectionHTML = `
        <form class="quiz-input-form" id="quiz-answer-form">
          <input
            type="text"
            id="quiz-answer-input"
            class="quiz-input"
            placeholder="输入中文翻译，按 Enter 核对…"
            autocomplete="off"
          />
          <div class="quiz-actions">
            <button type="button" class="btn btn-ghost btn-sm" data-quiz-action="skip">不会 / 直接看答案</button>
            <button type="submit" class="btn btn-primary">核对答案 <span class="kbd-hint" style="background: rgba(255,255,255,0.2); border-color: transparent; color: #fff;">Enter</span></button>
          </div>
        </form>
      `;
    } else {
      const isOk = ans.isCorrect || ans.overridden;
      answerSectionHTML = `
        <div class="test-result ${isOk ? "correct" : "wrong"}" style="margin-top: 18px;">
          <div class="test-result-head">
            <span>${
              ans.skipped
                ? "已显示参考翻译（已加入需复习）"
                : ans.isCorrect
                ? "✓ 回答正确！"
                : ans.overridden
                ? "✓ 已手动判定为答对"
                : `✕ 有偏差（你输入：${escapeHTML(ans.userInput)}）`
            }</span>
            ${
              !isOk && !ans.skipped
                ? `<button type="button" class="btn btn-sm" data-quiz-action="override">意思相近，算我答对</button>`
                : ""
            }
          </div>
          <div class="test-result-answer">参考翻译：${escapeHTML(w.translation)}</div>
        </div>

        ${
          w.sentence || w.tip
            ? `
          <div class="context-block" style="margin-top: 16px;">
            ${
              w.sentence
                ? `
              <div class="sentence-line">
                <div><span class="sentence-label">原句</span>${highlightSentence(w.sentence, w.word)}</div>
                <button type="button" class="btn btn-ghost btn-sm" data-quiz-action="speak-sentence">读原句</button>
              </div>
            `
                : ""
            }
            ${
              w.tip
                ? `
              <div class="tip-line">
                <div>${formatTipHTML(w.tip)}</div>
                ${
                  tipEnglish
                    ? `<button type="button" class="btn btn-ghost btn-sm" data-quiz-action="speak-tip">读例句</button>`
                    : ""
                }
              </div>
            `
                : ""
            }
          </div>
        `
            : ""
        }

        <div class="quiz-actions" style="margin-top: 18px;">
          <button type="button" class="status-btn ${
            prog.status === "mastered" ? "mastered" : ""
          }" data-quiz-action="toggle-mastery">
            ${prog.status === "mastered" ? "✓ 已掌握" : "标记为已掌握"}
          </button>
          <button type="button" class="btn btn-primary" id="btn-quiz-next-main" data-quiz-action="next">
            下一个词 <span class="kbd-hint" style="background: rgba(255,255,255,0.2); border-color: transparent; color: #fff;">Enter</span>
          </button>
        </div>
      `;
    }

    els.quizView.innerHTML = `
      <div class="quiz-card">
        <div class="quiz-meta">
          <span>第 <strong>${state.quizIndex + 1}</strong> / ${words.length} 词${
            state.newWordKeys.has(w.key) ? ' <span class="badge-new">新增</span>' : ""
          }</span>
          <span>本次自测正确：${state.quizSessionStats.right} / ${state.quizSessionStats.total}</span>
        </div>

        <div class="quiz-word-area">
          <button type="button" class="quiz-word-btn" data-quiz-action="speak-word" title="点击发声">
            ${escapeHTML(w.word)}
          </button>
          <div class="quiz-audio-bar">
            <button type="button" class="audio-btn" data-quiz-action="speak-word">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/>
                <path d="M15.54 8.46a5 5 0 0 1 0 7.07"/>
              </svg>
              <span>听发音</span>
            </button>
            <button type="button" class="audio-btn ${
              shadowRes && shadowRes.status === "listening" ? "is-recording" : ""
            }" data-quiz-action="shadow-word">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/>
                <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
                <line x1="12" y1="19" x2="12" y2="22"/>
              </svg>
              <span>${shadowRes && shadowRes.status === "listening" ? "聆听中…" : "跟读检测"}</span>
            </button>
            ${
              w.sentence && !ans
                ? `<button type="button" class="audio-btn" data-quiz-action="toggle-hint">${
                    state.quizShowHint ? "隐藏原句提示" : "看原句提示"
                  }</button>`
                : ""
            }
          </div>
          ${shadowHTML}
          ${
            w.sentence && state.quizShowHint && !ans
              ? `<div class="quiz-hint-sentence">${highlightSentence(w.sentence, w.word)}</div>`
              : ""
          }
        </div>

        ${answerSectionHTML}

        <div class="quiz-nav">
          <button type="button" class="btn btn-sm" data-quiz-action="prev">← 上一个</button>
          <span style="font-size: 0.78rem; color: var(--ink-muted);">点击英文可重复发音</span>
          <button type="button" class="btn btn-sm" data-quiz-action="next">下一个 →</button>
        </div>
      </div>
    `;

    // Autofocus input when awaiting answer
    const input = document.getElementById("quiz-answer-input");
    if (input) {
      input.focus();
    }
  }

  function renderCurrentView() {
    if (state.prefs.mode === "list") {
      els.listView.hidden = false;
      els.quizView.hidden = true;
      els.hideTransLabel.style.display = "inline-flex";
      renderListView();
    } else {
      els.listView.hidden = true;
      els.quizView.hidden = false;
      els.hideTransLabel.style.display = "none";
      renderQuizView();
    }
  }

  function renderAll() {
    els.title.textContent = state.title || "单词记忆本";
    document.title = `${state.title || "单词记忆本"} · 记忆网页`;
    els.linkSourceSheet.href = state.config.url;

    // Mode tabs
    els.tabList.classList.toggle("active", state.prefs.mode === "list");
    els.tabList.setAttribute("aria-selected", String(state.prefs.mode === "list"));
    els.tabQuiz.classList.toggle("active", state.prefs.mode === "quiz");
    els.tabQuiz.setAttribute("aria-selected", String(state.prefs.mode === "quiz"));

    // Controls
    els.toggleHideTrans.checked = state.prefs.hideTranslation;
    els.btnAccentUS.classList.toggle("active", state.prefs.accent === "en-US");
    els.btnAccentUK.classList.toggle("active", state.prefs.accent === "en-GB");
    els.btnSpeedToggle.textContent = state.prefs.rate < 1 ? "慢速 0.75x" : "语速 1.0x";

    // Filter pills
    els.filterPills.querySelectorAll(".filter-pill").forEach((pill) => {
      pill.classList.toggle("active", pill.dataset.filter === state.prefs.filter);
    });

    updateCountsAndProgress();
    renderCurrentView();
  }

  // --- Event Listeners ---
  function bindEvents() {
    // Sync now
    els.btnSyncNow.addEventListener("click", () => syncFromGoogleSheet(true));

    // Update banner buttons
    els.btnDismissBanner.addEventListener("click", () => {
      els.updateBanner.hidden = true;
    });
    els.btnViewNewWords.addEventListener("click", () => {
      state.prefs.filter = "new";
      saveJSON(STORAGE_KEYS.PREFS, state.prefs);
      els.updateBanner.hidden = true;
      state.quizIndex = 0;
      state.quizAnswerState = null;
      renderAll();
    });

    // Mode switcher
    els.tabList.addEventListener("click", () => {
      state.prefs.mode = "list";
      saveJSON(STORAGE_KEYS.PREFS, state.prefs);
      renderAll();
    });
    els.tabQuiz.addEventListener("click", () => {
      state.prefs.mode = "quiz";
      state.quizAnswerState = null;
      state.quizShowHint = false;
      saveJSON(STORAGE_KEYS.PREFS, state.prefs);
      renderAll();
    });

    // Hide translation toggle
    els.toggleHideTrans.addEventListener("change", (e) => {
      state.prefs.hideTranslation = e.target.checked;
      state.revealedKeys.clear();
      saveJSON(STORAGE_KEYS.PREFS, state.prefs);
      renderCurrentView();
    });

    // Accent toggle
    els.btnAccentUS.addEventListener("click", () => {
      state.prefs.accent = "en-US";
      saveJSON(STORAGE_KEYS.PREFS, state.prefs);
      renderAll();
      showToast("已切换为美式发音 (US)");
    });
    els.btnAccentUK.addEventListener("click", () => {
      state.prefs.accent = "en-GB";
      saveJSON(STORAGE_KEYS.PREFS, state.prefs);
      renderAll();
      showToast("已切换为英式发音 (UK)");
    });

    // Speed toggle
    els.btnSpeedToggle.addEventListener("click", () => {
      state.prefs.rate = state.prefs.rate < 1 ? 1.0 : 0.75;
      saveJSON(STORAGE_KEYS.PREFS, state.prefs);
      renderAll();
      showToast(state.prefs.rate < 1 ? "已切换慢速 0.75x（适合跟读）" : "已切换正常语速 1.0x");
    });

    // Filter pills
    els.filterPills.addEventListener("click", (e) => {
      const pill = e.target.closest(".filter-pill");
      if (!pill) return;
      state.prefs.filter = pill.dataset.filter;
      state.quizIndex = 0;
      state.quizAnswerState = null;
      state.quizShowHint = false;
      saveJSON(STORAGE_KEYS.PREFS, state.prefs);
      renderAll();
    });

    // Search
    els.searchInput.addEventListener("input", (e) => {
      state.searchQuery = e.target.value;
      state.quizIndex = 0;
      state.quizAnswerState = null;
      renderCurrentView();
    });

    // Shuffle
    els.btnShuffle.addEventListener("click", () => {
      const keys = state.words.map((w) => w.key);
      for (let i = keys.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [keys[i], keys[j]] = [keys[j], keys[i]];
      }
      state.orderSeed = keys;
      state.quizIndex = 0;
      state.quizAnswerState = null;
      state.quizShowHint = false;
      renderCurrentView();
      showToast("已随机打乱单词顺序");
    });

    // List View Delegation
    els.listView.addEventListener("click", (e) => {
      const actionEl = e.target.closest("[data-action]");
      if (!actionEl) return;
      const card = actionEl.closest(".word-card");
      if (!card) return;
      const key = card.dataset.key;
      const wordObj = state.words.find((w) => w.key === key);
      if (!wordObj) return;

      const action = actionEl.dataset.action;
      if (action === "speak-word") {
        speakText(wordObj.word, actionEl);
      } else if (action === "speak-sentence") {
        speakText(wordObj.sentence, actionEl);
      } else if (action === "speak-tip") {
        speakText(extractEnglishFromTip(wordObj.tip), actionEl);
      } else if (action === "shadow-word") {
        startShadowing(wordObj, actionEl);
      } else if (action === "toggle-mastery") {
        const cur = getProgress(key).status;
        setWordStatus(key, cur === "mastered" ? "none" : "mastered");
        renderCurrentView();
      } else if (action === "peek") {
        state.revealedKeys.add(key);
        renderCurrentView();
      } else if (action === "hide-one") {
        state.revealedKeys.delete(key);
        renderCurrentView();
      } else if (action === "override-inline") {
        if (state.inlineTestResults[key]) {
          state.inlineTestResults[key].overridden = true;
          setWordStatus(key, "none");
          renderCurrentView();
        }
      } else if (action === "retry-inline") {
        delete state.inlineTestResults[key];
        renderCurrentView();
      } else if (action === "clear-shadow") {
        delete state.shadowResults[key];
        renderCurrentView();
      }
    });

    els.listView.addEventListener("submit", (e) => {
      const form = e.target.closest('[data-action="inline-test-form"]');
      if (!form) return;
      e.preventDefault();
      const card = form.closest(".word-card");
      const key = card && card.dataset.key;
      const wordObj = state.words.find((w) => w.key === key);
      if (!wordObj) return;

      const input = form.querySelector('input[name="answer"]');
      const userInput = (input ? input.value : "").trim();
      if (!userInput) {
        showToast("请先输入你的中文翻译");
        if (input) input.focus();
        return;
      }

      const isCorrect = checkTranslation(userInput, wordObj.translation);
      state.inlineTestResults[key] = { userInput, isCorrect, overridden: false };
      recordTestAttempt(key, isCorrect);
      renderCurrentView();
    });

    // Quiz View Delegation
    els.quizView.addEventListener("click", (e) => {
      const actionEl = e.target.closest("[data-quiz-action]");
      if (!actionEl) return;
      const words = getFilteredWords();
      if (words.length === 0) return;
      const w = words[state.quizIndex] || words[0];
      const action = actionEl.dataset.quizAction;

      if (action === "speak-word") {
        speakText(w.word, actionEl);
      } else if (action === "speak-sentence") {
        speakText(w.sentence, actionEl);
      } else if (action === "speak-tip") {
        speakText(extractEnglishFromTip(w.tip), actionEl);
      } else if (action === "shadow-word") {
        startShadowing(w, actionEl);
      } else if (action === "toggle-hint") {
        state.quizShowHint = !state.quizShowHint;
        renderQuizView();
      } else if (action === "skip") {
        state.quizAnswerState = { userInput: "", isCorrect: false, skipped: true, overridden: false };
        state.quizSessionStats.total++;
        recordTestAttempt(w.key, false);
        renderQuizView();
      } else if (action === "override") {
        if (state.quizAnswerState && !state.quizAnswerState.overridden) {
          state.quizAnswerState.overridden = true;
          state.quizSessionStats.right++;
          setWordStatus(w.key, "none");
          renderQuizView();
        }
      } else if (action === "toggle-mastery") {
        const cur = getProgress(w.key).status;
        setWordStatus(w.key, cur === "mastered" ? "none" : "mastered");
        renderQuizView();
      } else if (action === "next") {
        state.quizIndex = (state.quizIndex + 1) % words.length;
        state.quizAnswerState = null;
        state.quizShowHint = false;
        renderQuizView();
      } else if (action === "prev") {
        state.quizIndex = (state.quizIndex - 1 + words.length) % words.length;
        state.quizAnswerState = null;
        state.quizShowHint = false;
        renderQuizView();
      } else if (action === "clear-shadow") {
        delete state.shadowResults[w.key];
        renderQuizView();
      }
    });

    els.quizView.addEventListener("submit", (e) => {
      if (e.target.id !== "quiz-answer-form") return;
      e.preventDefault();
      const words = getFilteredWords();
      if (words.length === 0) return;
      const w = words[state.quizIndex] || words[0];
      const input = document.getElementById("quiz-answer-input");
      const userInput = (input ? input.value : "").trim();
      if (!userInput) {
        showToast("请输入中文翻译，或点击「不会 / 直接看答案」");
        if (input) input.focus();
        return;
      }

      const isCorrect = checkTranslation(userInput, w.translation);
      state.quizAnswerState = { userInput, isCorrect, skipped: false, overridden: false };
      state.quizSessionStats.total++;
      if (isCorrect) state.quizSessionStats.right++;
      recordTestAttempt(w.key, isCorrect);
      renderQuizView();
    });

    // Enter key to advance to next card in Quiz Mode after answering
    document.addEventListener("keydown", (e) => {
      if (state.prefs.mode !== "quiz") return;
      if (!els.settingsModal.hidden) return;
      if (e.key === "Enter" && state.quizAnswerState) {
        const activeTag = document.activeElement && document.activeElement.tagName;
        if (activeTag === "INPUT" || activeTag === "TEXTAREA") return;
        e.preventDefault();
        const words = getFilteredWords();
        if (words.length > 0) {
          state.quizIndex = (state.quizIndex + 1) % words.length;
          state.quizAnswerState = null;
          state.quizShowHint = false;
          renderQuizView();
        }
      }
    });

    // Settings modal
    els.btnOpenSettings.addEventListener("click", () => {
      els.inputSheetUrl.value = state.config.url;
      els.settingsSyncMeta.textContent = state.lastSyncAt
        ? `上次同步：${formatTime(state.lastSyncAt)}（${state.lastSyncSummary || `共 ${state.words.length} 词`}）`
        : "尚未完成同步";
      els.settingsModal.hidden = false;
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
      state.config = {
        sheetId: parsed.sheetId,
        gid: parsed.gid,
        url: rawUrl,
      };
      saveJSON(STORAGE_KEYS.CONFIG, state.config);
      closeSettings();
      syncFromGoogleSheet(true);
    });

    els.btnResetProgress.addEventListener("click", () => {
      if (!window.confirm("确定要清空所有「已掌握 / 需复习」学习记录吗？单词库本身不会被删除。")) {
        return;
      }
      state.progress = {};
      state.inlineTestResults = {};
      state.quizSessionStats = { right: 0, total: 0 };
      saveJSON(STORAGE_KEYS.PROGRESS, state.progress);
      closeSettings();
      renderAll();
      showToast("学习记录已重置");
    });

    // Auto-check for updates when user returns to this tab after > 90 seconds
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible" && Date.now() - lastAutoCheckTs > 90_000) {
        syncFromGoogleSheet(false);
      }
    });
  }

  // --- Bootstrap ---
  function init() {
    // 1. Load cached words (or built-in fallback snapshot) for instant first paint
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
      state.words = window.FALLBACK_WORDS.map((w) => ({
        key: wordKey(w.word),
        word: w.word,
        translation: w.translation,
        sentence: w.sentence || "",
        tip: w.tip || "",
      }));
    }

    // Preload speech synthesis voices
    if ("speechSynthesis" in window) {
      window.speechSynthesis.getVoices();
    }

    bindEvents();
    renderAll();

    // 2. Automatically detect updates from Google Sheet on every page open
    syncFromGoogleSheet(false);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
