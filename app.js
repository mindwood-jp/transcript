(() => {
  "use strict";

  // 修正提案の投稿先リポジトリ
  const ISSUE_REPO = "mindwood-jp/transcript";

  const CAP = 800;                 // DOMに描画する最大ヒット件数（数え上げは全件）
  const el = (id) => document.getElementById(id);
  const qInput = el("q"), clearBtn = el("clear"), statusEl = el("status"),
        resultsEl = el("results"), corpusMeta = el("corpusMeta");

  let flat = [];                   // {vi, start, disp, search}
  let videos = [];                 // {id, title}
  const rowByKey = new Map();      // 描画中のヒット: key -> flat配列のインデックス(i)

  // overlay と共通の正規キー: "<video_id>@" + round(start*1000)
  const segKey = (vid, start) => vid + "@" + Math.round(start * 1000);

  const norm = (s) => s.normalize("NFKC");
  const escapeHTML = (s) => s.replace(/[&<>"']/g, (c) =>
    ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));

  const fmtTime = (sec) => {
    sec = Math.floor(sec);
    const h = (sec / 3600) | 0, m = ((sec % 3600) / 60) | 0, s = sec % 60;
    const p = (n) => String(n).padStart(2, "0");
    return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
  };

  // disp と、その小文字版 search、正規化済みクエリ q から強調HTMLを作る
  const highlight = (disp, search, q) => {
    if (!q) return escapeHTML(disp);
    let out = "", i = 0;
    for (;;) {
      const idx = search.indexOf(q, i);
      if (idx === -1) { out += escapeHTML(disp.slice(i)); break; }
      out += escapeHTML(disp.slice(i, idx));
      out += "<mark>" + escapeHTML(disp.slice(idx, idx + q.length)) + "</mark>";
      i = idx + q.length;
    }
    return out;
  };

  async function boot() {
    let index;
    try {
      const res = await fetch("index.json", { cache: "no-cache" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      index = await res.json();
    } catch (e) {
      const onFile = location.protocol === "file:";
      resultsEl.innerHTML =
        `<div class="note note--error"><b>index.json を読み込めませんでした。</b><br>` +
        (onFile
          ? `ファイルを直接開く（file://）と読み込みがブロックされます。<br>` +
            `このフォルダで <code>python -m http.server 8000</code> を実行し、` +
            `<code>http://localhost:8000/</code> を開いてください。`
          : `index.html と同じ場所に index.json があるか確認してください。（${escapeHTML(String(e.message || e))}）`) +
        `</div>`;
      return;
    }

    videos = index.videos.map((v) => ({ id: v.id, title: v.title || v.id }));

    // 任意: 承認済み訂正のオーバーレイ。あればマージ、無ければ無視。
    let overlay = null;
    try {
      const r = await fetch("overlay.json", { cache: "no-cache" });
      if (r.ok) overlay = await r.json();
    } catch (_) { /* 未配置でOK */ }

    let applied = 0;
    flat = [];
    index.videos.forEach((v, vi) => {
      for (const [start, text] of v.segments) {
        let t = text;
        if (overlay) {
          const c = overlay[segKey(v.id, start)];
          if (typeof c === "string" && c.length) { t = c; applied++; }
        }
        const disp = norm(t);
        flat.push({ i: flat.length, vi, start, disp, search: disp.toLowerCase() });
      }
    });

    corpusMeta.textContent =
      `${index.video_count.toLocaleString()} 本 / ${index.segment_count.toLocaleString()} セグメント`;

    let gen = "";
    if (index.generated_at) {
      const d = new Date(index.generated_at);
      if (!isNaN(d.getTime())) {
        const parts = {};
        for (const p of new Intl.DateTimeFormat("ja-JP", {
          timeZone: "Asia/Tokyo",
          year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
        }).formatToParts(d)) parts[p.type] = p.value;
        gen = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} JST`;
      } else {
        gen = index.generated_at; // パースできなければ原文のまま
      }
    }
    el("footerMeta").innerHTML =
      `インデックス生成: ${escapeHTML(gen)}` +
      (applied ? ` ・ <span class="applied">訂正 ${applied.toLocaleString()} 件を適用</span>` : "");

    qInput.disabled = false;

    // ?q= / #q= で初期クエリを復元
    const initial = new URLSearchParams(location.search).get("q")
      || decodeURIComponent(location.hash.replace(/^#/, ""));
    if (initial) qInput.value = initial;
    run();
    qInput.focus();
  }

  function run() {
    const raw = qInput.value.trim();
    rowByKey.clear();
    clearBtn.classList.toggle("is-on", raw.length > 0);
    history.replaceState(null, "", raw ? "#" + encodeURIComponent(raw) : location.pathname + location.search);

    if (!raw) {
      statusEl.textContent = "";
      resultsEl.innerHTML =
        `<div class="note">キーワードを入力すると、全動画の発言から一致箇所を探します。<br>` +
        `タイムスタンプを押すと YouTube の該当時刻が開きます。</div>`;
      return;
    }

    const q = norm(raw).toLowerCase();
    const groups = [];
    let cur = null, rendered = 0, total = 0;
    const vids = new Set();

    for (const it of flat) {
      if (!it.search.includes(q)) continue;
      total++; vids.add(it.vi);
      if (rendered >= CAP) continue;
      if (!cur || cur.vi !== it.vi) { cur = { vi: it.vi, rows: [] }; groups.push(cur); }
      cur.rows.push(it); rendered++;
    }

    statusEl.innerHTML = total
      ? `「${escapeHTML(raw)}」 — <b>${total.toLocaleString()}</b> 件 ・ <b>${vids.size.toLocaleString()}</b> 本の動画`
        + (total > rendered ? `（上位 ${rendered.toLocaleString()} 件を表示）` : "")
      : `「${escapeHTML(raw)}」 — 一致なし`;

    if (!total) {
      resultsEl.innerHTML =
        `<div class="note"><b>一致する発言は見つかりませんでした。</b><br>` +
        `別の言い回しや短いキーワードで試してみてください。<br>「ひらがな」と「カタカナ」は区別されます。</div>`;
      return;
    }

    const parts = [];
    for (const g of groups) {
      const v = videos[g.vi];
      const vurl = "https://youtu.be/" + encodeURIComponent(v.id);
      parts.push(`<section class="group"><h2 class="group__title">` +
        `<a href="${vurl}" target="_blank" rel="noopener">${escapeHTML(v.title)}</a></h2><ul class="hits">`);
      for (const it of g.rows) {
        const t = Math.floor(it.start);
        const url = `${vurl}?t=${t}`;
        const key = segKey(v.id, it.start);
        rowByKey.set(key, it.i);
        parts.push(
          `<li class="hit">` +
          `<div class="hit__meta">` +
            `<a class="ts" href="${url}" target="_blank" rel="noopener">${fmtTime(it.start)}</a>` +
            `<button class="propose" type="button" data-key="${escapeHTML(key)}" aria-label="この箇所の修正を提案">修正提案</button>` +
          `</div>` +
          `<span class="snippet">${highlight(it.disp, it.search, q)}</span></li>`
        );
      }
      parts.push(`</ul></section>`);
    }
    if (total > rendered) {
      parts.push(`<p class="more">ほか ${(total - rendered).toLocaleString()} 件 — キーワードを絞り込むと表示されます</p>`);
    }
    resultsEl.innerHTML = parts.join("");
  }

  // ---- 修正提案モーダル ----
  const modal = el("proposeModal");
  const propOriginal = el("proposeOriginal");
  const propText = el("proposeText");
  const prevBtn = el("proposePrev");
  const nextBtn = el("proposeNext");
  let propState = null;            // {i, key, vid, start, text}

  // 動画の端では各方向のボタンを無効化（同一動画内のみ移動）
  function updateNavButtons() {
    if (!propState) { prevBtn.disabled = nextBtn.disabled = true; return; }
    const i = propState.i, vi = flat[i].vi;
    prevBtn.disabled = !(i - 1 >= 0 && flat[i - 1].vi === vi);
    nextBtn.disabled = !(i + 1 < flat.length && flat[i + 1].vi === vi);
  }

  // flat配列のインデックス i のセグメントをモーダルに読み込む
  function setProposeTo(i) {
    const it = flat[i];
    const vid = videos[it.vi].id;
    propState = { i, key: segKey(vid, it.start), vid, start: it.start, text: it.disp };
    propOriginal.textContent = it.disp;
    propText.value = it.disp;
    updateNavButtons();
  }

  // 同一動画内で前(-1)／次(+1)の時間のセグメントへ移動
  function navPropose(dir) {
    if (!propState) return;
    const i = propState.i, vi = flat[i].vi, j = i + dir;
    if (j < 0 || j >= flat.length || flat[j].vi !== vi) return;
    setProposeTo(j);
  }

  function openPropose(key) {
    const i = rowByKey.get(key);
    if (i == null) return;
    setProposeTo(i);
    modal.hidden = false;
    propText.focus();
  }

  function closePropose() {
    modal.hidden = true;
    propState = null;
  }

  function submitPropose() {
    if (!propState) return;
    if (ISSUE_REPO.includes("OWNER/REPO")) {
      alert("投稿先リポジトリが未設定です。app.js の ISSUE_REPO を設定してください。");
      return;
    }
    const proposed = propText.value.trim();
    if (!proposed) { alert("修正後のテキストを入力してください。"); return; }
    if (proposed === propState.text.trim()) {
      alert("本文が変更されていません。修正してから提案してください。");
      return;
    }
    const title = `[修正提案] ${propState.key}`;
    const body =
      `key:      ${propState.key}\n` +
      `video_id: ${propState.vid}\n` +
      `start:    ${propState.start}\n` +
      `--- original ---\n${propState.text}\n` +
      `--- proposed ---\n${proposed}\n`;
    const url = `https://github.com/${ISSUE_REPO}/issues/new`
      + `?title=${encodeURIComponent(title)}`
      + `&body=${encodeURIComponent(body)}`
      + `&labels=correction`;
    window.open(url, "_blank", "noopener");
    closePropose();
  }

  resultsEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".propose");
    if (btn) openPropose(btn.dataset.key);
  });
  modal.addEventListener("click", (e) => {
    if (e.target.hasAttribute("data-close")) closePropose();
  });
  el("proposeSubmit").addEventListener("click", submitPropose);
  prevBtn.addEventListener("click", () => navPropose(-1));
  nextBtn.addEventListener("click", () => navPropose(1));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !modal.hidden) closePropose();
  });

  // 入力（デバウンス）
  let timer = 0;
  qInput.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(run, 120); });
  qInput.addEventListener("keydown", (e) => { if (e.key === "Escape") { qInput.value = ""; run(); } });
  clearBtn.addEventListener("click", () => { qInput.value = ""; run(); qInput.focus(); });

  qInput.disabled = true;
  boot();
})();
