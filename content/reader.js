var ZRA = {
  Zotero: null,
  papers: [],          // [{ item, title, meta, cleanText, rawText }]
  combinedText: "",
  piperRoot: null, piperExe: null, piperVoicesDir: null,
  piperVoiceList: [],
  piperChunks: [], piperPlayIdx: 0,
  piperStopFlag: false,

  async init() {
    try {
      if (window.arguments && window.arguments[0]) this.Zotero = window.arguments[0];
      else if (typeof Zotero !== "undefined") this.Zotero = Zotero;
      else {
        const Services = globalThis.Services;
        const w = Services.wm.getMostRecentWindow("navigator:browser") || Services.wm.getMostRecentWindow("zotero:main") || Services.wm.getMostRecentWindow(null);
        if (w && w.Zotero) this.Zotero = w.Zotero;
      }
    } catch (e) {}
    if (!this.Zotero) { this.setStatus("Could not access Zotero."); return; }

    document.getElementById("zra-play").addEventListener("click", () => this.play());
    document.getElementById("zra-pause").addEventListener("click", () => this.pause());
    document.getElementById("zra-stop").addEventListener("click", () => this.stop());
    document.getElementById("zra-reload").addEventListener("click", () => this.loadSelection());
    document.getElementById("zra-back15").addEventListener("click", () => this.skipSeconds(-15));
    document.getElementById("zra-fwd15").addEventListener("click", () => this.skipSeconds(15));
    document.getElementById("zra-section-prev").addEventListener("click", () => this.gotoSection(-1));
    document.getElementById("zra-section-next").addEventListener("click", () => this.gotoSection(1));
    document.getElementById("zra-skip-paper").addEventListener("click", () => this.skipToNextPaper());
    document.getElementById("zra-open-pdf").addEventListener("click", () => this.openCurrentPaperPDF());
    document.getElementById("zra-mark").addEventListener("click", () => this.markCurrentPaper());
    document.getElementById("zra-add-voice").addEventListener("click", () => this.addVoice());

    document.addEventListener("keydown", (e) => {
      if (e.target.matches && e.target.matches("input, textarea, select")) return;
      const k = (e.key || "").toLowerCase();
      if (k === "m") { e.preventDefault(); this.markCurrentPaper(); }
      else if (k === " ") { e.preventDefault(); const a = document.getElementById("zra-audio"); a.paused ? this.play() : this.pause(); }
    });

    const rate = document.getElementById("zra-rate");
    const rateDisp = document.getElementById("zra-rate-display");
    rate.addEventListener("input", () => { rateDisp.textContent = parseFloat(rate.value).toFixed(2) + "×"; });

    document.querySelectorAll("input[type=checkbox]").forEach((cb) => {
      cb.addEventListener("change", () => this.applyFiltersAll());
    });

    const Z = this.Zotero;
    const savedRate = parseFloat(Z.Prefs.get("extensions.zra.rate", true));
    if (savedRate) { rate.value = String(savedRate); rateDisp.textContent = savedRate.toFixed(2) + "×"; }
    this._savedVoice = Z.Prefs.get("extensions.zra.voice", true) || "";

    const audio = document.getElementById("zra-audio");
    const progress = document.getElementById("zra-progress");
    audio.addEventListener("timeupdate", () => { if (audio.duration) progress.value = audio.currentTime / audio.duration; });
    audio.addEventListener("loadedmetadata", () => {
      if (!audio.duration || isNaN(audio.duration)) return;
      this._chunkDur = this._chunkDur || {};
      this._chunkDur[this.piperPlayIdx] = audio.duration;
      this.updateTimeRemaining();
    });
    audio.addEventListener("error", () => this.setStatus("Audio playback error.", "warn"));

    window.addEventListener("unload", () => {
      try { audio.pause(); audio.src = ""; } catch (e) {}
      this.piperStopFlag = true;
    });

    await this.setupPiper();
    await this.loadSelection();
  },

  setStatus(s, cls) {
    const el = document.getElementById("zra-status");
    el.textContent = s;
    el.className = "hint" + (cls ? " " + cls : "");
  },

  async setupPiper() {
    const Z = this.Zotero;
    const root = PathUtils.join(Z.DataDirectory.dir, "piper-tts");
    this.piperRoot = root;
    this.piperExe = PathUtils.join(root, "piper", "piper.exe");
    this.piperVoicesDir = PathUtils.join(root, "voices");

    if (!(await IOUtils.exists(this.piperExe))) {
      const ok = window.confirm("Piper TTS is not installed.\n\nDownload and install now?\n• Piper binary: ~30 MB\n• Default voice (Lessac, US English, high quality): ~110 MB\n\nFiles go to: " + root);
      if (!ok) { this.setStatus("Piper not installed.", "warn"); return; }
      try { await this.installPiper(); }
      catch (e) { this.setStatus("Install failed: " + (e.message || e), "warn"); return; }
    }
    await this.loadPiperVoices();
  },

  async runPS(args) {
    const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
    const candidates = [
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "C:\\Windows\\Sysnative\\WindowsPowerShell\\v1.0\\powershell.exe",
      "C:\\Program Files\\PowerShell\\7\\pwsh.exe"
    ];
    let cmd = null;
    for (const p of candidates) { try { if (await IOUtils.exists(p)) { cmd = p; break; } } catch (e) {} }
    if (!cmd) { try { cmd = await Subprocess.pathSearch("powershell.exe"); } catch (e) {} }
    if (!cmd) throw new Error("powershell.exe not found");
    const proc = await Subprocess.call({ command: cmd, arguments: args, stdout: "pipe", stderr: "pipe" });
    let stdout = "", stderr = "";
    const r1 = (async () => { let s; while ((s = await proc.stdout.readString()) !== "") stdout += s; })();
    const r2 = (async () => { let s; while ((s = await proc.stderr.readString()) !== "") stderr += s; })();
    const { exitCode } = await proc.wait();
    await Promise.all([r1, r2]);
    return { exitCode, stdout, stderr };
  },

  async installPiper() {
    await IOUtils.makeDirectory(this.piperRoot, { ignoreExisting: true });
    await IOUtils.makeDirectory(this.piperVoicesDir, { ignoreExisting: true });

    this.setStatus("Downloading Piper binary (~30 MB)…");
    const zipPath = PathUtils.join(this.piperRoot, "piper.zip");
    const piperUrl = "https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip";
    const r1 = await fetch(piperUrl);
    if (!r1.ok) throw new Error("Piper download HTTP " + r1.status);
    await IOUtils.write(zipPath, new Uint8Array(await r1.arrayBuffer()));

    this.setStatus("Extracting Piper…");
    const ex = await this.runPS([
      "-NoProfile", "-Command",
      "Expand-Archive -Path '" + zipPath + "' -DestinationPath '" + this.piperRoot + "' -Force"
    ]);
    if (ex.exitCode !== 0) throw new Error("Extract: " + (ex.stderr || ("exit " + ex.exitCode)));
    try { await IOUtils.remove(zipPath); } catch (e) {}
    if (!(await IOUtils.exists(this.piperExe))) throw new Error("piper.exe missing after extract");

    this.setStatus("Downloading default voice (Lessac high, ~110 MB)…");
    const base = "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/high";
    const onnxResp = await fetch(base + "/en_US-lessac-high.onnx");
    if (!onnxResp.ok) throw new Error("Voice .onnx HTTP " + onnxResp.status);
    await IOUtils.write(PathUtils.join(this.piperVoicesDir, "en_US-lessac-high.onnx"), new Uint8Array(await onnxResp.arrayBuffer()));
    const jsonResp = await fetch(base + "/en_US-lessac-high.onnx.json");
    if (!jsonResp.ok) throw new Error("Voice .json HTTP " + jsonResp.status);
    await IOUtils.writeUTF8(PathUtils.join(this.piperVoicesDir, "en_US-lessac-high.onnx.json"), await jsonResp.text());

    this.setStatus("Piper installed.");
  },

  async ensurePdftotext() {
    if (this._pdftotextPath) return this._pdftotextPath;
    const Z = this.Zotero;
    const dir = PathUtils.join(Z.DataDirectory.dir, "pdftools");
    await IOUtils.makeDirectory(dir, { ignoreExisting: true });
    const exePath = PathUtils.join(dir, "pdftotext.exe");
    if (await IOUtils.exists(exePath)) { this._pdftotextPath = exePath; return exePath; }

    this.setStatus("Downloading pdftotext (xpdf-tools, ~10 MB, one-time)…");
    const zipPath = PathUtils.join(dir, "xpdf-tools.zip");
    const url = "https://dl.xpdfreader.com/xpdf-tools-win-4.06.zip";
    const r = await fetch(url);
    if (!r.ok) throw new Error("xpdf download HTTP " + r.status);
    await IOUtils.write(zipPath, new Uint8Array(await r.arrayBuffer()));

    this.setStatus("Extracting xpdf-tools…");
    const ex = await this.runPS([
      "-NoProfile", "-Command",
      "Expand-Archive -Path '" + zipPath + "' -DestinationPath '" + dir + "' -Force"
    ]);
    if (ex.exitCode !== 0) throw new Error("Extract: " + (ex.stderr || ("exit " + ex.exitCode)));

    const found = await this.findFileRecursive(dir, "pdftotext.exe");
    if (!found) throw new Error("pdftotext.exe not found in archive");
    if (found !== exePath) {
      await IOUtils.copy(found, exePath);
    }
    try { await IOUtils.remove(zipPath); } catch (e) {}
    this._pdftotextPath = exePath;
    return exePath;
  },

  async findFileRecursive(dir, name) {
    const queue = [dir];
    const target = name.toLowerCase();
    while (queue.length) {
      const cur = queue.shift();
      let children;
      try { children = await IOUtils.getChildren(cur); } catch (e) { continue; }
      for (const c of children) {
        let stat;
        try { stat = await IOUtils.stat(c); } catch (e) { continue; }
        if (stat && stat.type === "directory") queue.push(c);
        else if (PathUtils.filename(c).toLowerCase() === target) return c;
      }
    }
    return null;
  },

  async extractPdfText(pdfPath) {
    const exe = await this.ensurePdftotext();
    const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
    const proc = await Subprocess.call({
      command: exe,
      arguments: ["-q", pdfPath, "-"],
      stdout: "pipe", stderr: "pipe"
    });
    let stdout = "", stderr = "";
    const r1 = (async () => { let s; while ((s = await proc.stdout.readString()) !== "") stdout += s; })();
    const r2 = (async () => { let s; while ((s = await proc.stderr.readString()) !== "") stderr += s; })();
    const { exitCode } = await proc.wait();
    await Promise.all([r1, r2]);
    if (exitCode !== 0) throw new Error("pdftotext exit " + exitCode + ": " + stderr.slice(0, 200));
    return stdout;
  },

  async loadPiperVoices() {
    if (!(await IOUtils.exists(this.piperVoicesDir))) {
      await IOUtils.makeDirectory(this.piperVoicesDir, { ignoreExisting: true });
    }
    const all = await IOUtils.getChildren(this.piperVoicesDir);
    const onnx = all.filter((p) => p.endsWith(".onnx"));
    this.piperVoiceList = onnx.map((p) => ({ name: PathUtils.filename(p).replace(/\.onnx$/, ""), path: p }));
    const sel = document.getElementById("zra-voice");
    sel.innerHTML = "";
    this.piperVoiceList.forEach((v) => {
      const opt = document.createElement("option");
      opt.value = v.name;
      opt.textContent = v.name;
      sel.appendChild(opt);
    });
    if (!this.piperVoiceList.length) {
      this.setStatus("No Piper voices found.", "warn");
    } else {
      const saved = this._savedVoice;
      if (saved && [...sel.options].some((o) => o.value === saved)) sel.value = saved;
      else sel.selectedIndex = 0;
    }
  },

  async loadSelection() {
    const Z = this.Zotero;
    this.stop();

    const win = Z.getMainWindow();
    const pane = win && win.ZoteroPane;
    if (!pane) { this.setStatus("Zotero pane not available.", "warn"); return; }
    const items = pane.getSelectedItems();
    if (!items || !items.length) { this.setStatus("Select one or more items in Zotero, then click Reload selection."); return; }

    const papers = [];
    for (let raw of items) {
      let item = raw;
      if (!item.isTopLevelItem()) {
        const pid = item.parentItemID;
        if (pid) item = Z.Items.get(pid);
      }
      if (!item || !item.isRegularItem()) continue;

      const attIDs = item.getAttachments();
      let text = "";
      for (const aid of attIDs) {
        const att = await Z.Items.getAsync(aid);
        if (!(att.attachmentContentType || "").includes("pdf")) continue;
        const fp = att.getFilePath();
        if (!fp) continue;
        const cachePath = PathUtils.join(PathUtils.parent(fp), ".zotero-ft-cache");
        if (await IOUtils.exists(cachePath)) {
          const t = await IOUtils.readUTF8(cachePath);
          if (t && t.length > 100) { text = t; break; }
        }
        // Direct extraction via bundled pdftotext (bypasses Zotero indexer queue)
        try {
          this.setStatus("Extracting PDF directly: " + (item.getField("title") || "").slice(0, 60) + "…");
          const t3 = await this.extractPdfText(fp);
          if (t3 && t3.length > 100) { text = t3; break; }
        } catch (e) { Z.debug("[ZRA] direct extract failed for " + aid + ": " + e); }
      }
      if (!text) continue;

      const creators = item.getCreators().map((c) => c.lastName || c.name).filter(Boolean);
      const year = (item.getField("date") || "").slice(0, 4);
      const title = item.getField("title") || "(untitled)";
      const metaStr = creators.slice(0, 3).join(", ") + (creators.length > 3 ? " et al." : "") + (year ? " — " + year : "");
      papers.push({ item, title, meta: metaStr, rawText: text, cleanText: "", skim: false });
    }

    if (document.getElementById("zra-unlistened-only").checked) {
      const before = papers.length;
      const filtered = papers.filter((p) => { try { return !p.item.hasTag("zss-listened"); } catch (e) { return true; } });
      if (filtered.length < before) this.setStatus("Filtered " + (before - filtered.length) + " already-listened paper(s).");
      papers.splice(0, papers.length, ...filtered);
    }

    if (!papers.length) {
      this.setStatus("No PDFs with cached full-text in selection.", "warn");
      this.papers = []; this.combinedText = ""; this.renderQueue(); this.updateHeader();
      document.getElementById("zra-text").textContent = "";
      return;
    }
    this.papers = papers;
    this.applyFiltersAll();
    this.updateHeader();
    this.renderQueue(-1);

    // Resume offer
    const resume = this.loadResumeState();
    if (resume && resume.key === this.selectionKey() && resume.chunkIdx > 0) {
      const ageMin = Math.round((Date.now() - (resume.ts || 0)) / 60000);
      if (window.confirm("Resume from where you left off (chunk " + (resume.chunkIdx + 1) + ", saved " + (ageMin < 1 ? "just now" : ageMin + " min ago") + ")?")) {
        this._resumeChunkIdx = resume.chunkIdx;
        this._resumeTime = resume.time;
      } else {
        this.clearResumeState();
      }
    }

    this.setStatus("Loaded " + papers.length + " paper" + (papers.length === 1 ? "" : "s") + ". Press Play.");
  },

  updateHeader() {
    if (!this.papers.length) {
      document.getElementById("zra-title").textContent = "No item loaded";
      document.getElementById("zra-meta").textContent = "";
      return;
    }
    if (this.papers.length === 1) {
      document.getElementById("zra-title").textContent = this.papers[0].title;
      document.getElementById("zra-meta").textContent = this.papers[0].meta;
    } else {
      document.getElementById("zra-title").textContent = this.papers.length + " papers queued";
      document.getElementById("zra-meta").textContent = "First: " + this.papers[0].title;
    }
  },

  renderQueue(currentPaperIdx) {
    const q = document.getElementById("zra-queue");
    if (!this.papers.length) { q.classList.add("hidden"); q.innerHTML = ""; return; }
    q.classList.remove("hidden");
    q.innerHTML = "";

    if (this.papers.length > 1) {
      const head = document.createElement("div");
      head.className = "queue-header";
      const allFull = document.createElement("button"); allFull.className = "mini"; allFull.textContent = "All full 📖";
      const allSkim = document.createElement("button"); allSkim.className = "mini"; allSkim.textContent = "All skim ⚡";
      allFull.addEventListener("click", () => { this.papers.forEach((p) => p.skim = false); this.applyFiltersAll(); this.renderQueue(currentPaperIdx); });
      allSkim.addEventListener("click", () => { this.papers.forEach((p) => p.skim = true); this.applyFiltersAll(); this.renderQueue(currentPaperIdx); });
      head.appendChild(allFull); head.appendChild(allSkim);
      q.appendChild(head);
    }

    this.papers.forEach((p, i) => {
      const row = document.createElement("div");
      row.className = "queue-item" + (i === currentPaperIdx ? " current" : "") + (currentPaperIdx > i ? " done" : "");
      const num = document.createElement("span"); num.className = "num"; num.textContent = (i + 1) + ".";
      const ttl = document.createElement("span"); ttl.className = "qtitle"; ttl.textContent = p.title;
      const tog = document.createElement("button");
      tog.className = "qtoggle" + (p.skim ? " skim" : "");
      tog.textContent = p.skim ? "⚡ Skim" : "📖 Full";
      tog.title = p.skim ? "Skim only — click to read full" : "Full text — click to skim";
      tog.addEventListener("click", () => { p.skim = !p.skim; this.applyFiltersAll(); this.renderQueue(currentPaperIdx); });
      row.appendChild(num); row.appendChild(ttl); row.appendChild(tog);
      q.appendChild(row);
    });
  },

  applyFiltersAll() {
    if (!this.papers.length) return;
    let totalRaw = 0, totalClean = 0;
    for (const p of this.papers) {
      p.cleanText = this.filterText(p.rawText);
      // Invalidate any cached summary since text changed
      if (p._summarySource !== p.cleanText) { p.summary = undefined; p._summarySource = p.cleanText; }
      totalRaw += p.rawText.length;
      totalClean += p.cleanText.length;
    }
    this.rebuildCombined();
    const pct = Math.round(100 * (1 - totalClean / Math.max(1, totalRaw)));
    this.setStatus("Cleaned " + this.papers.length + " paper" + (this.papers.length === 1 ? "" : "s") + ": " + totalRaw + " → " + totalClean + " chars (" + pct + "% trimmed). Press Play.");
  },

  rebuildCombined() {
    const useSum = document.getElementById("zra-ai-summary").checked;
    const useLab = document.getElementById("zra-lab-brief").checked;
    const blocks = this.papers.map((p, i) => {
      const isLast = (i === this.papers.length - 1);
      const intro = (this.papers.length > 1 ? ("Paper " + (i + 1) + " of " + this.papers.length + ": " + p.title + (p.meta ? ", " + p.meta : "") + ".\n\n") : "");
      const labLine = (useLab && p.labBrief) ? ("About the lab. " + p.labBrief + "\n\n") : "";
      let body;
      if (p.skim && p.summary) {
        body = "Summary. " + p.summary;
      } else {
        body = p.cleanText;
        if (useSum && p.summary) body += "\n\nSummary. " + p.summary;
      }
      const transition = isLast ? "\n\nReading complete." : "\n\nMoving on to the next paper.";
      return intro + labLine + body + transition;
    });
    this.combinedText = blocks.join("\n\n");
    document.getElementById("zra-text").textContent = this.combinedText;
  },

  async generateLabBriefsIfRequested() {
    if (!document.getElementById("zra-lab-brief").checked) return;
    const Z = this.Zotero;
    const key = Z.Prefs.get("extensions.zra.apiKey", true) || Z.Prefs.get("extensions.zss.apiKey", true);
    if (!key) {
      this.setStatus("Lab brief on but no Anthropic key found.", "warn");
      return;
    }
    for (let i = 0; i < this.papers.length; i++) {
      if (this.piperStopFlag) return;
      const p = this.papers[i];
      if (p.labBrief) continue;
      this.setStatus("Researching lab " + (i + 1) + "/" + this.papers.length + " (Haiku)…");
      try {
        const prompt = "Identify the corresponding author of this scientific paper (usually the last-listed or starred author) and write 2-3 sentences about their lab: research focus, career stage (early-career / established / leading), and notable contributions or impact. Be concrete and mention specific work if you know it. If you don't have reliable information, say so honestly rather than guessing. Output only the synopsis, no preamble.\n\nTitle: " + p.title + "\nAuthors: " + p.meta + "\n\nExcerpt:\n" + (p.cleanText || "").slice(0, 4000);
        const resp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 400, messages: [{ role: "user", content: prompt }] })
        });
        if (!resp.ok) { p.labBrief = ""; continue; }
        const data = await resp.json();
        const text = (data.content && data.content[0] && data.content[0].text) || "";
        p.labBrief = text.trim();
      } catch (e) {
        p.labBrief = "";
      }
    }
    this.rebuildCombined();
  },

  async generateSummariesIfRequested() {
    const wantSum = document.getElementById("zra-ai-summary").checked;
    const anySkim = this.papers.some((p) => p.skim);
    if (!wantSum && !anySkim) return;
    const Z = this.Zotero;
    const key = Z.Prefs.get("extensions.zra.apiKey", true) || Z.Prefs.get("extensions.zss.apiKey", true);
    if (!key) {
      this.setStatus("AI summary on but no Anthropic key found (set one in Semantic Search settings).", "warn");
      return;
    }
    const wantSum2 = document.getElementById("zra-ai-summary").checked;
    for (let i = 0; i < this.papers.length; i++) {
      if (this.piperStopFlag) return;
      const p = this.papers[i];
      if (p.summary) continue;
      if (!wantSum2 && !p.skim) continue;
      this.setStatus("Summarizing paper " + (i + 1) + "/" + this.papers.length + " (Haiku)…");
      try {
        const prompt = "Summarize this scientific paper in 2-3 sentences focused on what was done and what the key result is. Be concrete; mention specific compounds, methods, or numbers if relevant. Output only the summary, no preamble.\n\nTitle: " + p.title + "\n\n" + (p.cleanText || "").slice(0, 8000);
        const resp = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
          body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 400, messages: [{ role: "user", content: prompt }] })
        });
        if (!resp.ok) { p.summary = ""; continue; }
        const data = await resp.json();
        const text = (data.content && data.content[0] && data.content[0].text) || "";
        p.summary = text.trim();
      } catch (e) {
        p.summary = "";
      }
    }
    this.rebuildCombined();
  },

  renderPreviewWithChunks() {
    const pane = document.getElementById("zra-text");
    pane.innerHTML = "";
    this.piperChunks.forEach((c, i) => {
      const span = document.createElement("span");
      span.className = "chunk";
      span.dataset.idx = String(i);
      const txt = (c.text || "") + " ";
      // Style summary/transition chunks distinctly
      if (/^Summary\.\s/.test(c.text)) span.classList.add("summary");
      else if (/^(Moving on to the next paper|Reading complete)\.?\s*$/.test((c.text || "").trim())) span.classList.add("transition");
      span.textContent = txt;
      pane.appendChild(span);
    });
  },

  highlightChunk(idx) {
    const pane = document.getElementById("zra-text");
    if (!pane) return;
    pane.querySelectorAll(".chunk.current").forEach((e) => e.classList.remove("current"));
    const cur = pane.querySelector('.chunk[data-idx="' + idx + '"]');
    if (cur) {
      cur.classList.add("current");
      try { cur.scrollIntoView({ behavior: "smooth", block: "center" }); } catch (e) {}
    }
  },

  selectionKey() { return this.papers.map((p) => p.item.key).join(","); },

  saveResumeState() {
    if (!this.papers.length || !this.piperChunks.length) return;
    const audio = document.getElementById("zra-audio");
    const state = { key: this.selectionKey(), chunkIdx: this.piperPlayIdx, time: audio.currentTime || 0, ts: Date.now() };
    this.Zotero.Prefs.set("extensions.zra.resume", JSON.stringify(state), true);
  },

  loadResumeState() {
    const raw = this.Zotero.Prefs.get("extensions.zra.resume", true);
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return null; }
  },

  clearResumeState() { this.Zotero.Prefs.set("extensions.zra.resume", "", true); },

  filterText(rawText) {
    let t = rawText.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    if (document.getElementById("zra-skip-refs").checked) {
      // Truncate at the earliest "post-body" section header (references, acknowledgments, author info, funding, etc.)
      const headers = [
        "REFERENCES", "References",
        "Bibliography", "BIBLIOGRAPHY",
        "Literature Cited", "LITERATURE CITED",
        "Works Cited", "WORKS CITED",
        "Notes and references",
        "ASSOCIATED CONTENT", "Associated Content",
        "AUTHOR INFORMATION", "Author Information",
        "ACKNOWLEDGMENTS", "ACKNOWLEDGEMENTS",
        "Acknowledgments", "Acknowledgements",
        "Author Contributions", "AUTHOR CONTRIBUTIONS",
        "Funding Sources", "Funding sources", "FUNDING",
        "Conflict of Interest", "Conflicts of Interest",
        "DECLARATION OF COMPETING INTEREST", "Declaration of Competing Interest",
        "Competing Interests", "COMPETING INTERESTS",
        "Data Availability", "DATA AVAILABILITY",
        "Accession Codes", "ACCESSION CODES",
        "Author Information", "AUTHOR INFORMATION"
      ];
      let earliest = -1;
      for (const h of headers) {
        const esc = h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        const re = new RegExp("\\n[\\s■▪●▌○▶•(]*\\b" + esc + "\\b[\\s■▪●▌○▶•):]*\\n");
        const m = t.match(re);
        if (m && (earliest === -1 || m.index < earliest)) earliest = m.index;
      }
      if (earliest > 200) t = t.slice(0, earliest);
    }
    {
      const lines = t.split("\n");
      const counts = {};
      for (const ln of lines) { const k = ln.trim(); if (k.length >= 6 && k.length <= 240) counts[k] = (counts[k] || 0) + 1; }
      const repeated = new Set(Object.keys(counts).filter((k) => counts[k] >= 3));
      if (repeated.size) t = lines.filter((ln) => !repeated.has(ln.trim())).join("\n");
    }
    if (document.getElementById("zra-skip-authors").checked) {
      t = t.replace(/^[A-Z][A-Za-z\.\-\s']{2,80}\s[−–-]\s[A-Z][^\n]+(?:,[^\n]+){1,}\n/gm, "");
      t = t.replace(/orcid\.org\/[\d\-X]+/gi, "");
      t = t.split("\n").filter((ln) => {
        const m = ln.match(/[A-Z]\.\s*[A-Z]\.?\s*[A-Z][a-z]+|[A-Z]\.\s+[A-Z][a-z]+/g);
        if (!m) return true;
        const commas = (ln.match(/,/g) || []).length;
        return !(m.length >= 3 && commas >= 2);
      }).join("\n");
    }
    if (document.getElementById("zra-skip-captions").checked) {
      t = t.replace(/^(Fig(ure)?\.?|Table|Scheme|Chart|Eq(uation)?\.?)\s*\d+[A-Za-z]?[.:][^\n]*(?:\n(?!\n)[^\n]*)*/gm, "");
    }
    if (document.getElementById("zra-skip-figrefs") && document.getElementById("zra-skip-figrefs").checked) {
      // Parenthetical figure / table / scheme references: "(Figure 3a)" "(Fig. 4, 5)" "(Table 1)" "(Scheme 2)"
      t = t.replace(/\(\s*(?:Figure|Fig\.?|Table|Scheme|Chart|Eq\.?|Equation)s?\s+[\d\w][\w\d\s,\-–+]*\)/gi, "");
      // Inline prepositional phrases: "as shown in Figure 4", "see Figure 3", "in Table 1"
      t = t.replace(/\b(?:see|as\s+shown\s+in|shown\s+in|as\s+(?:in|illustrated\s+in)|illustrated\s+in|in|cf\.?)\s+(?:Figure|Fig\.?|Table|Scheme|Chart|Eq\.?|Equation)s?\s+\d+[a-zA-Z]?(?:[\s\-–,]+\d+[a-zA-Z]?)*/gi, "");
      // Bare references: "Figure 3" / "Fig. 4a" / "Table 2" / "Scheme 1"
      t = t.replace(/\b(?:Figure|Fig\.?|Table|Scheme|Chart|Eq\.?|Equation)s?\s+\d+[a-zA-Z]?(?:[\s\-–,]+\d+[a-zA-Z]?)*/gi, "");
      // Cleanup orphaned commas/spaces
      t = t.replace(/\s+,/g, ",").replace(/\(\s*\)/g, "").replace(/,\s*,/g, ",").replace(/\(\s*[,;]\s*\)/g, "").replace(/,\s*\)/g, ")");
    }

    if (document.getElementById("zra-skip-meta").checked) {
      t = t.replace(/https?:\/\/\S+/g, "");
      t = t.replace(/\bdoi\s*:\s*\S+/gi, "");
      t = t.replace(/\b10\.\d{4,}\/[^\s)\]]+/g, "");
      t = t.replace(/\b[a-z]{2,}\.[a-z]{2,}\.[a-z]{2,3}\/\S+/g, "");
      t = t.replace(/[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g, "");
      t = t.replace(/^\s*\d{1,4}\s*$/gm, "");
      t = t.replace(/\b(Received|Revised|Accepted|Submitted|Published(\s+online)?|Available\s+online)\s*:?\s*[A-Z][a-z]+\.?\s+\d+,?\s+\d{4}/g, "");
      t = t.replace(/©\s*(\d{4}|XXXX)[^\n]*/g, "");
      t = t.replace(/This article is licensed under[^\n.]*\.?/g, "");
      t = t.replace(/Downloaded via [\d.]+ on [^\n]*\(UTC\)\.?/g, "");
      t = t.replace(/See\s+for [^.\n]*share[^.\n]*\.?/g, "");
      t = t.replace(/Published by [A-Z][^\n.]*Society[^\n.]*\.?/g, "");
      t = t.replace(/\bAll rights reserved\.?/gi, "");
      t = t.replace(/[A-Z]\.\s*[A-Z][a-z]+\.\s*[A-Z][a-z]+\.\s*[A-Z][a-z]+\.\s*(XXXX|\d{4})[^\n]*/g, "");
      t = t.replace(/Cite This:[^\n]*/g, "");
      t = t.replace(/\b(ACCESS|Metrics & More|Article Recommendations|Read Online|Supporting Information)\b[^\n]*/g, "");
      t = t.replace(/Deposition Number\s+\d+[^\n]*/g, "");
      t = t.replace(/^\s*Keywords?\s*:[^\n]*/gmi, "");
      t = t.replace(/\b(Corresponding Author|Author Contributions|Competing Interests|Author Information|AUTHOR INFORMATION|ACKNOWLEDGMENTS?|Notes)\b[^\n]*/g, "");
    }
    t = t.replace(/(\w+)-\n(\w+)/g, "$1$2");
    t = t.replace(/([^\n])\n([^\n])/g, "$1 $2");
    t = t.replace(/\n{3,}/g, "\n\n").replace(/[ \t]{2,}/g, " ").trim();

    // Strip superscript-style citation numbers glued to words ("reactions1−4", "Smith et al.5")
    if (document.getElementById("zra-skip-cites") && document.getElementById("zra-skip-cites").checked) {
      // word ending lowercase + glued digits with optional comma/dash groups
      t = t.replace(/([a-z\)\]])(\d{1,3}(?:[,−–\-]\d{1,3}){0,5})(?=[\s.,;:!?\)\]]|$)/g, "$1");
      // Also strip standalone " 1,2,3 " or " 1−4 " (rare but possible)
      t = t.replace(/\s\d{1,3}(?:[,−–\-]\d{1,3}){1,5}(?=[\s.,;:!?\)\]])/g, " ");
    }

    // Chemistry pronunciation pass (last so previous filters don't fight it)
    if (document.getElementById("zra-chem-aware") && document.getElementById("zra-chem-aware").checked) {
      t = this.chemPreprocess(t);
    }
    return t;
  },

  chemPreprocess(t) {
    const subs = [
      [/\bd\.r\.?(?=\s|$)/gi, "d r"],
      [/\be\.e\.?(?=\s|$)/gi, "e e"],
      [/\be\.r\.?(?=\s|$)/gi, "e r"],
      [/\bIC50\b/g, "I C fifty"],
      [/\bEC50\b/g, "E C fifty"],
      [/\bLD50\b/g, "L D fifty"],
      [/\bGI50\b/g, "G I fifty"],
      [/\bpKa\b/g, "p K a"],
      [/\bpKi\b/g, "p K i"],
      [/\bKM\b/g, "K M"],
      [/\bKm\b/g, "K m"],
      [/\bKi\b/g, "K i"],
      [/\bkcat\b/gi, "k cat"],
      [/\bVmax\b/gi, "V max"],
      [/\bmol\s*%/g, "mole percent"],
      [/\bv\/v\b/gi, "volume per volume"],
      [/\bw\/w\b/gi, "weight per weight"],
      [/\bw\/v\b/gi, "weight per volume"],
      [/\bN\.M\.R\.?\b/gi, "N M R"],
      [/\bNMR\b/g, "N M R"],
      [/\bHPLC\b/g, "H P L C"],
      [/\bUPLC\b/g, "U P L C"],
      [/\bLC[\/\-]?MS\b/gi, "L C M S"],
      [/\bGC[\/\-]?MS\b/gi, "G C M S"],
      [/\bMALDI\b/g, "MAL-dee"],
      [/\bDFT\b/g, "D F T"],
      [/\bSAR\b/g, "S A R"],
      [/\bSMILES\b/gi, "smiles"],
      [/\bDOI\b/g, "D O I"],
      [/\bPDB\b/g, "P D B"],
      [/\bRDKit\b/gi, "R D Kit"],
      [/\bSFC\b/g, "S F C"],
      [/\bPAINS\b/g, "pains"],
      [/\bADMET\b/gi, "AD-met"],
      [/\bee\b(?=\s|$)/g, "e e"],
      [/\bdr\b(?=\s|$)/g, "d r"],
      [/\bt1\/2\b/gi, "t one half"]
    ];
    for (const [re, rep] of subs) t = t.replace(re, rep);

    // Chemical formulas: NiCl3 → Ni Cl 3, H2SO4 → H 2 S O 4
    // Token must look like ([A-Z][a-z]?\d*){2+} and contain at least one digit
    t = t.replace(/\b([A-Z][a-z]?\d*){2,}\b/g, (match) => {
      if (!/\d/.test(match)) return match;
      // Avoid mangling typical acronyms like "ATP", "GTP", "PEG" (no digits already filtered)
      // Insert space around each element symbol and each digit run
      return match.replace(/([A-Z][a-z]?)/g, " $1").replace(/(\d+)/g, " $1").replace(/\s+/g, " ").trim();
    });

    return t;
  },

  chunkForStreaming(text) {
    const maxLen = 1500;
    const paragraphs = text.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
    const chunks = [];
    for (const p of paragraphs) {
      if (p.length <= maxLen) { chunks.push(p); continue; }
      const sentences = p.match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) || [p];
      let buf = "";
      for (const s of sentences) {
        if (buf && (buf + s).length > maxLen) { chunks.push(buf.trim()); buf = ""; }
        buf += s + " ";
      }
      if (buf.trim()) chunks.push(buf.trim());
    }
    return chunks;
  },

  async play() {
    if (!this.combinedText) { this.setStatus("Nothing loaded.", "warn"); return; }
    if (!this.piperVoiceList || !this.piperVoiceList.length) { this.setStatus("No Piper voices.", "warn"); return; }
    const Z = this.Zotero;
    const voiceName = document.getElementById("zra-voice").value;
    const rate = parseFloat(document.getElementById("zra-rate").value) || 1.0;
    Z.Prefs.set("extensions.zra.voice", voiceName, true);
    Z.Prefs.set("extensions.zra.rate", rate, true);

    const audio = document.getElementById("zra-audio");

    if (audio.src && audio.paused && audio.currentTime > 0 &&
        this._piperKey === this.combinedText.length + ":" + voiceName + ":" + rate &&
        this.piperChunks && this.piperChunks.length) {
      audio.play(); this.setStatus("Resumed.", "playing"); return;
    }

    audio.pause();
    this.piperStopFlag = true;
    await new Promise((r) => setTimeout(r, 30));
    this.piperStopFlag = false;

    // Generate AI summaries / lab briefs before chunking if requested
    await this.generateLabBriefsIfRequested();
    if (this.piperStopFlag) return;
    await this.generateSummariesIfRequested();
    if (this.piperStopFlag) return;

    this._piperKey = this.combinedText.length + ":" + voiceName + ":" + rate;

    const chunks = this.chunkForStreaming(this.combinedText);
    this.piperChunks = chunks.map((text, i) => ({
      text, wavPath: PathUtils.join(this.piperRoot, "chunk-" + i + ".wav"), status: "pending"
    }));
    this.piperPlayIdx = 0;
    if (this._resumeChunkIdx) { this.piperPlayIdx = Math.min(this._resumeChunkIdx, this.piperChunks.length - 1); }

    this.renderPreviewWithChunks();

    try {
      const all = await IOUtils.getChildren(this.piperRoot);
      for (const p of all) { if (/\bchunk-\d+\.wav$/.test(p)) { try { await IOUtils.remove(p); } catch (e) {} } }
    } catch (e) {}

    const voice = this.piperVoiceList.find((v) => v.name === voiceName);
    if (!voice) { this.setStatus("Voice not found.", "warn"); return; }

    this.setStatus("Generating chunk " + (this.piperPlayIdx + 1) + "/" + chunks.length + "…");
    this.generatePiperChunks(voice, rate, this.piperPlayIdx);
    await this.waitForChunk(this.piperPlayIdx);
    if (this.piperStopFlag) return;
    this.setupPlaybackHandler();
    this.playCurrentChunk();
  },

  async generatePiperChunks(voice, rate, startIdx) {
    const lengthScale = String(Math.max(0.3, Math.min(2.5, 1.0 / Math.max(0.1, rate))));
    const { Subprocess } = ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs");
    for (let i = startIdx || 0; i < this.piperChunks.length; i++) {
      if (this.piperStopFlag) return;
      const chunk = this.piperChunks[i];
      chunk.status = "generating";
      try {
        const proc = await Subprocess.call({
          command: this.piperExe,
          arguments: ["--model", voice.path, "--output_file", chunk.wavPath, "--length_scale", lengthScale],
          stdin: "pipe", stdout: "pipe", stderr: "pipe"
        });
        await proc.stdin.write(chunk.text);
        await proc.stdin.close();
        let stderr = "";
        const drain = (async () => { let s; while ((s = await proc.stderr.readString()) !== "") stderr += s; })();
        const { exitCode } = await proc.wait();
        await drain;
        if (exitCode === 0 && await IOUtils.exists(chunk.wavPath)) chunk.status = "ready";
        else { chunk.status = "error"; chunk.err = stderr.slice(0, 200); }
      } catch (e) {
        chunk.status = "error"; chunk.err = String(e.message || e);
      }
    }
  },

  waitForChunk(idx) {
    return new Promise((resolve) => {
      const tick = () => {
        if (this.piperStopFlag) return resolve();
        if (idx >= this.piperChunks.length) return resolve();
        const c = this.piperChunks[idx];
        if (c.status === "ready" || c.status === "error") return resolve();
        setTimeout(tick, 150);
      };
      tick();
    });
  },

  setupPlaybackHandler() {
    const audio = document.getElementById("zra-audio");
    audio.onended = async () => {
      const justFinished = this.piperPlayIdx;
      this.piperPlayIdx++;
      this.maybeMarkListenedAt(justFinished);
      if (this.piperStopFlag || this.piperPlayIdx >= this.piperChunks.length) {
        this.setStatus("Done.", "playing"); return;
      }
      this.setStatus("Buffering chunk " + (this.piperPlayIdx + 1) + "/" + this.piperChunks.length + "…");
      await this.waitForChunk(this.piperPlayIdx);
      if (this.piperStopFlag) return;
      this.playCurrentChunk();
    };
  },

  maybeMarkListenedAt(finishedChunkIdx) {
    const starts = this.findPaperChunkStarts();
    for (let i = 0; i < this.papers.length; i++) {
      const lastChunk = (i + 1 < starts.length) ? starts[i + 1] - 1 : this.piperChunks.length - 1;
      if (finishedChunkIdx === lastChunk && !this.papers[i]._listenedMarked) {
        this.papers[i]._listenedMarked = true;
        this.markPaperAsListened(this.papers[i]);
      }
    }
  },

  async markPaperAsListened(paper) {
    try {
      paper.item.addTag("zss-listened", 0);
      await paper.item.saveTx();
    } catch (e) { this.Zotero.debug("[ZRA] tag failed: " + e); }
  },

  playCurrentChunk() {
    const audio = document.getElementById("zra-audio");
    const chunk = this.piperChunks[this.piperPlayIdx];
    if (!chunk) { this.setStatus("Done.", "playing"); return; }
    if (chunk.status === "error") {
      this.setStatus("Chunk " + (this.piperPlayIdx + 1) + " failed; skipping.", "warn");
      this.piperPlayIdx++;
      if (this.piperPlayIdx < this.piperChunks.length) this.waitForChunk(this.piperPlayIdx).then(() => this.playCurrentChunk());
      return;
    }
    const file = Components.classes["@mozilla.org/file/local;1"].createInstance(Components.interfaces.nsIFile);
    file.initWithPath(chunk.wavPath);
    audio.src = Services.io.newFileURI(file).spec;
    const seekTime = this._resumeTime || 0;
    this._resumeTime = null;
    audio.play().then(() => {
      if (seekTime > 0) try { audio.currentTime = seekTime; } catch (e) {}
    }).catch((e) => this.setStatus("Audio play error: " + e.message, "warn"));
    this.highlightChunk(this.piperPlayIdx);
    const ready = this.piperChunks.filter((c) => c.status === "ready").length;
    const total = this.piperChunks.length;
    const paperIdx = this.estimateCurrentPaper();
    if (this.papers.length > 1 && paperIdx >= 0) {
      this.renderQueue(paperIdx);
      this.setStatus("Paper " + (paperIdx + 1) + "/" + this.papers.length + " — chunk " + (this.piperPlayIdx + 1) + "/" + total + " (buffered " + ready + ")", "playing");
    } else {
      this.setStatus("Playing " + (this.piperPlayIdx + 1) + "/" + total + " (buffered " + ready + ")", "playing");
    }
  },

  skipSeconds(delta) {
    const audio = document.getElementById("zra-audio");
    if (!audio.duration || isNaN(audio.duration)) { this.setStatus("No audio loaded.", "warn"); return; }
    const t = Math.max(0, Math.min(audio.duration - 0.2, audio.currentTime + delta));
    audio.currentTime = t;
    this.setStatus((delta < 0 ? "−" : "+") + Math.abs(delta) + "s.");
  },

  findSectionChunks() {
    const out = [];
    this.piperChunks.forEach((c, i) => {
      const t = (c.text || "").trim();
      if (/^Paper\s+\d+\s+of\s+\d+:/.test(t)) { out.push({ idx: i, name: t.slice(0, 80) }); return; }
      if (/^(?:■\s*)?(ABSTRACT|Abstract|INTRODUCTION|Introduction|BACKGROUND|Background|METHODS?|Methods?|Materials\s+and\s+Methods|EXPERIMENTAL(?:\s+SECTION)?|Experimental(?:\s+Section)?|RESULTS?|Results?|Results\s+and\s+Discussion|DISCUSSION|Discussion|CONCLUSIONS?|Conclusions?|SUMMARY|Summary|REACTION\s+DESIGN|Reaction\s+Design|REACTION\s+SCOPE|Scope)\b/.test(t)) {
        out.push({ idx: i, name: t.slice(0, 80) });
      }
    });
    return out.sort((a, b) => a.idx - b.idx);
  },

  gotoSection(direction) {
    if (!this.piperChunks.length) { this.setStatus("Press Play first.", "warn"); return; }
    const secs = this.findSectionChunks();
    if (!secs.length) { this.setStatus("No sections detected.", "warn"); return; }
    let target;
    if (direction > 0) target = secs.find((s) => s.idx > this.piperPlayIdx);
    else target = [...secs].reverse().find((s) => s.idx < this.piperPlayIdx);
    if (!target) { this.setStatus(direction > 0 ? "No next section." : "No previous section.", "warn"); return; }
    this.setStatus("→ " + target.name);
    this.seekToChunk(target.idx);
  },

  findPaperChunkStarts() {
    const starts = [0];
    for (let i = 1; i < this.piperChunks.length; i++) {
      if (/^Paper\s+\d+\s+of\s+\d+:/.test(this.piperChunks[i].text || "")) starts.push(i);
    }
    return starts;
  },

  skipToNextPaper() {
    if (!this.piperChunks.length) { this.setStatus("Press Play first.", "warn"); return; }
    const starts = this.findPaperChunkStarts();
    const next = starts.find((s) => s > this.piperPlayIdx);
    if (next === undefined) { this.setStatus("No more papers in queue.", "warn"); return; }
    this.seekToChunk(next);
  },

  seekToChunk(idx) {
    if (idx < 0 || idx >= this.piperChunks.length) return;
    this.piperPlayIdx = idx;
    const audio = document.getElementById("zra-audio");
    audio.pause();
    this.setStatus("Buffering chunk " + (idx + 1) + "/" + this.piperChunks.length + "…");
    this.waitForChunk(idx).then(() => {
      if (this.piperStopFlag) return;
      this.playCurrentChunk();
    });
  },

  async openCurrentPaperPDF() {
    const Z = this.Zotero;
    const idx = this.estimateCurrentPaper();
    if (idx < 0 || !this.papers[idx]) { this.setStatus("No current paper.", "warn"); return; }
    const item = this.papers[idx].item;
    const attIDs = item.getAttachments();
    for (const aid of attIDs) {
      const att = await Z.Items.getAsync(aid);
      if ((att.attachmentContentType || "").includes("pdf")) {
        try {
          if (Z.Reader && Z.Reader.open) await Z.Reader.open(aid);
          else { const win = Z.getMainWindow(); if (win && win.ZoteroPane) win.ZoteroPane.viewAttachment([aid]); }
          const win = Z.getMainWindow(); if (win) win.focus();
          this.setStatus("Opened PDF: " + this.papers[idx].title.slice(0, 60));
        } catch (e) {
          this.setStatus("PDF open error: " + (e.message || e), "warn");
        }
        return;
      }
    }
    this.setStatus("No PDF attachment on this item.", "warn");
  },

  async markCurrentPaper() {
    const Z = this.Zotero;
    const idx = this.estimateCurrentPaper();
    if (idx < 0 || !this.papers[idx]) { this.setStatus("No current paper.", "warn"); return; }
    const paper = this.papers[idx];
    const chunk = this.piperChunks[this.piperPlayIdx];
    const ts = new Date().toLocaleString();
    const safe = (s) => String(s || "").replace(/[<>&]/g, (m) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;" }[m]));
    const html = "<p><strong>Smart Read Aloud — marked " + ts + "</strong></p>"
      + "<p><em>" + safe((chunk && chunk.text || "").slice(0, 400)) + "</em></p>";
    try {
      const note = new Z.Item("note");
      note.parentID = paper.item.id;
      note.setNote(html);
      await note.saveTx();
      this.setStatus("✓ Note added to: " + paper.title.slice(0, 50));
    } catch (e) {
      this.setStatus("Mark failed: " + (e.message || e), "warn");
    }
  },

  updateTimeRemaining() {
    const el = document.getElementById("zra-time-left");
    if (!el || !this._chunkDur || !this.piperChunks.length) return;
    const known = Object.values(this._chunkDur);
    if (!known.length) { el.textContent = "—"; return; }
    const avg = known.reduce((a, b) => a + b, 0) / known.length;
    const remaining = Math.max(0, (this.piperChunks.length - this.piperPlayIdx - 1) * avg);
    const mins = Math.round(remaining / 60);
    const audio = document.getElementById("zra-audio");
    const curRemain = (audio.duration && !isNaN(audio.duration)) ? Math.max(0, audio.duration - audio.currentTime) : 0;
    const total = remaining + curRemain;
    if (total < 60) el.textContent = "~" + Math.round(total) + " s left";
    else if (total < 3600) el.textContent = "~" + Math.round(total / 60) + " min left";
    else el.textContent = "~" + (total / 3600).toFixed(1) + " hr left";
  },

  async addVoice() {
    const id = window.prompt(
      "Voice ID to download (format: lang_REGION-name-quality)\n\n"
      + "Examples:\n"
      + "  en_US-ryan-high   (US male)\n"
      + "  en_US-amy-medium  (US female)\n"
      + "  en_US-joe-medium  (US male)\n"
      + "  en_GB-alan-medium (UK male)\n"
      + "  en_GB-jenny_dioco-medium (UK female)\n\n"
      + "Browse all: huggingface.co/rhasspy/piper-voices"
    );
    if (!id) return;
    const m = id.trim().match(/^([a-z]{2})_([A-Z]{2})-([a-z_]+)-(low|medium|high|x_low)$/);
    if (!m) { this.setStatus("Invalid voice ID. Format: lang_REGION-name-quality.", "warn"); return; }
    const lang = m[1], region = m[2].toUpperCase(), name = m[3], qual = m[4];
    const base = "https://huggingface.co/rhasspy/piper-voices/resolve/main/" + lang + "/" + lang + "_" + region + "/" + name + "/" + qual;
    this.setStatus("Downloading " + id + "…");
    try {
      const r1 = await fetch(base + "/" + id + ".onnx");
      if (!r1.ok) throw new Error(".onnx HTTP " + r1.status);
      await IOUtils.write(PathUtils.join(this.piperVoicesDir, id + ".onnx"), new Uint8Array(await r1.arrayBuffer()));
      const r2 = await fetch(base + "/" + id + ".onnx.json");
      if (!r2.ok) throw new Error(".onnx.json HTTP " + r2.status);
      await IOUtils.writeUTF8(PathUtils.join(this.piperVoicesDir, id + ".onnx.json"), await r2.text());
      await this.loadPiperVoices();
      this.setStatus("Added voice: " + id);
    } catch (e) {
      this.setStatus("Voice download failed: " + (e.message || e), "warn");
    }
  },

  estimateCurrentPaper() {
    if (this.papers.length <= 1) return 0;
    // Walk through chunks and figure out which paper's text region we're in, by accumulating chunk text lengths
    let consumed = 0;
    for (let i = 0; i <= this.piperPlayIdx && i < this.piperChunks.length; i++) {
      consumed += (this.piperChunks[i].text || "").length;
    }
    let acc = 0;
    for (let i = 0; i < this.papers.length; i++) {
      acc += (this.papers[i].cleanText || "").length;
      if (consumed <= acc + 50 * (i + 1)) return i;
    }
    return this.papers.length - 1;
  },

  pause() {
    const audio = document.getElementById("zra-audio");
    if (!audio.paused) {
      audio.pause();
      this.saveResumeState();
      this.setStatus("Paused (resume position saved).");
    }
  },

  stop() {
    this.saveResumeState();
    const audio = document.getElementById("zra-audio");
    try { audio.pause(); audio.currentTime = 0; audio.onended = null; } catch (e) {}
    document.getElementById("zra-progress").value = 0;
    this.piperStopFlag = true;
    this.piperPlayIdx = 0;
    this.piperChunks = [];
    this.renderQueue(-1);
    this.setStatus("Stopped (resume position saved).");
  }
};
