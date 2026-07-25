(() => {
  "use strict";

  // 修正提案の投稿先リポジトリ
  const ISSUE_REPO = "mindwood-jp/transcript";

  const CAP = 800;                 // DOMに描画する最大ヒット件数（数え上げは全件）
  const el = (id) => document.getElementById(id);
  const qInput = el("q"), clearBtn = el("clear"), statusEl = el("status"),
        resultsEl = el("results"), corpusMeta = el("corpusMeta"),
        tagsEl = el("tags"), tagListEl = el("tagList");

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
    // merge.json（訂正焼き込み済みの結合コーパス）を1本読むだけ。必須。
    let corpus = null;
    try {
      const res = await fetch("merge.json", { cache: "no-cache" });
      if (!res.ok) throw new Error("HTTP " + res.status);
      corpus = await res.json();
    } catch (e) {
      const onFile = location.protocol === "file:";
      resultsEl.innerHTML =
        `<div class="note note--error"><b>merge.json を読み込めませんでした。</b><br>` +
        (onFile
          ? `ファイルを直接開く（file://）と読み込みがブロックされます。<br>` +
            `このフォルダで <code>python -m http.server 8000</code> を実行し、` +
            `<code>http://localhost:8000/</code> を開いてください。`
          : `index.html と同じ場所に merge.json があるか確認してください。（${escapeHTML(String(e.message || e))}）`) +
        `</div>`;
      return;
    }

    videos = corpus.videos.map((v) => ({ id: v.id, title: v.title || v.id }));

    flat = [];
    corpus.videos.forEach((v, vi) => {
      for (const [start, text] of v.segments) {
        const disp = norm(text);
        flat.push({ i: flat.length, vi, start, disp, search: disp.toLowerCase() });
      }
    });

    corpusMeta.textContent =
      `${corpus.video_count.toLocaleString()} 本 / ${corpus.segment_count.toLocaleString()} セグメント`;

    let gen = "";
    if (corpus.generated_at) {
      const d = new Date(corpus.generated_at);
      if (!isNaN(d.getTime())) {
        const parts = {};
        for (const p of new Intl.DateTimeFormat("ja-JP", {
          timeZone: "Asia/Tokyo",
          year: "numeric", month: "2-digit", day: "2-digit",
          hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
        }).formatToParts(d)) parts[p.type] = p.value;
        gen = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} JST`;
      } else {
        gen = corpus.generated_at; // パースできなければ原文のまま
      }
    }
    el("footerMeta").innerHTML = `インデックス生成: ${escapeHTML(gen)}`;

    qInput.disabled = false;

    // ?q= / #q= で初期クエリを復元
    const initial = new URLSearchParams(location.search).get("q")
      || decodeURIComponent(location.hash.replace(/^#/, ""));
    if (initial) qInput.value = initial;
    run();
    qInput.focus();

    // タグクラウドは任意。読み込みを待たずに検索を使えるようにする。
    loadTags();
  }

  // ---- タグクラウド ----
  // tags.csv（build_tags.py の出力を手で選別したもの／列は 語,件数,動画数）を読んで、
  // 中央から渦巻き状に敷き詰めるワードクラウドとして描画する。
  // 任意ファイル: 無くても・壊れていても、パネルを出さないだけで検索は動く。
  let tagsReady = false;
  let tagItems = [];               // {word, hits, vids, size, weight, w, h}
  let laidOutWidth = 0;            // 直近にレイアウトしたときの幅（リサイズ判定用）

  // 文字色。大きい語ほど濃く、小さい語は控えめに。
  // 語ごとに固定（ハッシュ）なので、リサイズしても色は変わらない。
  const TAG_COLORS = ["#510778", "#0F766E", "#1B3666", "#7A2E6E", "#8A5A2B",
                      "#1D6FA3", "#B4531C", "#3F6F1E"];
  const TAG_COLOR_FAINT = "#7E8791";
  const TAG_COLOR_TOP = "#DC143C";      // 最上位（件数が特に多い語）だけの色

  const measureCtx = document.createElement("canvas").getContext("2d");

  function hashCode(str) {
    let h = 0;
    for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) | 0;
    return Math.abs(h);
  }

  async function loadTags() {
    let text;
    try {
      const r = await fetch("tags.csv", { cache: "no-cache" });
      if (!r.ok) return;
      text = await r.text();
    } catch (_) { return; }        // 未配置でOK

    const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
    const items = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const cols = line.split(",");
      const word = (cols[0] || "").trim();
      const hits = parseInt(cols[1], 10);
      const vids = parseInt(cols[2], 10);
      if (!word || word === "語" || !isFinite(hits)) continue;   // ヘッダ行と壊れた行を飛ばす
      items.push({ word, hits, vids: isFinite(vids) ? vids : 0 });
    }
    if (!items.length) return;

    // 大きい語から先に置く（中央に来るようにするため）
    items.sort((a, b) => b.hits - a.hits || a.word.localeCompare(b.word, "ja"));
    tagItems = items;
    tagsReady = true;

    // Webフォント(Noto Sans JP)が確定してから測る。
    // 読み込み前に測るとフォールバック書体の幅で配置され、文字が重なる。
    try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (_) {}

    updateTagsVisibility();
    layoutTags();
  }

  // 中央から渦巻き状に、既に置いた語と重ならない場所を探して配置する。
  function layoutTags() {
    if (!tagItems.length || tagsEl.hidden) return;
    const W = tagListEl.clientWidth;
    if (!W) return;                // 非表示中などで幅が取れないときは後で
    laidOutWidth = W;

    const family = getComputedStyle(tagListEl).fontFamily;

    // 文字の大きさ: 件数の対数を [MIN, MAX] px に写す。
    // 件数の幅が狭い（例 33〜239）ので線形では差が出ない。
    const lg = (n) => Math.log(n + 1);
    let lo = Infinity, hi = -Infinity;
    for (const it of tagItems) { lo = Math.min(lo, it.hits); hi = Math.max(hi, it.hits); }
    const span = lg(hi) - lg(lo);
    const MAX = Math.max(24, Math.min(46, W / 16));
    const MIN = Math.max(11, Math.min(15, W / 46));

    for (const it of tagItems) {
      const r = span > 0 ? (lg(it.hits) - lg(lo)) / span : 1;
      const base = Math.round(MIN + (MAX - MIN) * Math.pow(r, 0.9));
      // 大きさは4段階。最上位だけ一回り大きくして色を変える
      if (r >= 0.80)      { it.tier = 3; it.size = Math.round(base * 1.15); it.weight = 700; }
      else if (r >= 0.55) { it.tier = 2; it.size = base; it.weight = 700; }
      else if (r >= 0.25) { it.tier = 1; it.size = base; it.weight = 600; }
      else                { it.tier = 0; it.size = base; it.weight = 500; }
      measureCtx.font = it.weight + " " + it.size + "px " + family;
      it.w = Math.ceil(measureCtx.measureText(it.word).width) + 1;
      it.h = Math.ceil(it.size * 1.05);     // .tag の line-height と合わせる
    }

    // 渦巻き探索。横長の楕円にして、幅のある領域を先に埋める。
    const placed = [];
    const ASPECT = 1.9;
    const hit = (x, y, w, h) => {
      for (let i = 0; i < placed.length; i++) {
        const p = placed[i];
        if (x < p.x + p.w && x + w > p.x && y < p.y + p.h && y + h > p.y) return true;
      }
      return false;
    };

    for (const it of tagItems) {
      if (it.w > W) { it.x = null; continue; }     // 幅に収まらない語は諦める
      let t = 0, ok = false;
      for (let step = 0; step < 10000; step++) {
        const rad = 1.7 * t;
        const x = Math.round(-it.w / 2 + rad * Math.cos(t) * ASPECT);
        const y = Math.round(-it.h / 2 + rad * Math.sin(t));
        t += 0.14;
        // 横は必ずコンテナ内に収める（縦は伸ばして高さを後から決める）
        const left = x + W / 2;
        if (left < 0 || left + it.w > W) continue;
        if (hit(left, y, it.w, it.h)) continue;
        it.x = left; it.y = y;
        placed.push({ x: left, y, w: it.w, h: it.h });
        ok = true;
        break;
      }
      if (!ok) it.x = null;
    }

    // 上端を 0 に揃えて全体の高さを確定する
    let top = Infinity, bottom = -Infinity;
    for (const p of placed) { top = Math.min(top, p.y); bottom = Math.max(bottom, p.y + p.h); }
    if (!isFinite(top)) { renderTagsFlow(); return; }   // 1つも置けなければ従来の並びに退避

    // 近傍に同じ色が並ばないように選ぶ。ハッシュを起点にして、
    // 近くの配置済みタグと色がぶつかったら次の色へずらす。
    // tagItems は件数の降順なので、大きい語が先に色を確保する。
    const NEAR_X = 48, NEAR_Y = 28;      // この距離まで近ければ「隣」とみなす(px)
    const colored = [];
    const isNear = (a, b) => {
      const dx = Math.max(0, Math.max(a.x - (b.x + b.w), b.x - (a.x + a.w)));
      const dy = Math.max(0, Math.max(a.y - (b.y + b.h), b.y - (a.y + a.h)));
      return dx <= NEAR_X && dy <= NEAR_Y;
    };
    const pickColor = (it) => {
      if (it.tier === 3) return TAG_COLOR_TOP;
      if (it.tier === 0) return TAG_COLOR_FAINT;
      const start = hashCode(it.word) % TAG_COLORS.length;
      const box = { x: it.x, y: it.y, w: it.w, h: it.h };
      for (let k = 0; k < TAG_COLORS.length; k++) {
        const c = TAG_COLORS[(start + k) % TAG_COLORS.length];
        let ng = false;
        for (let i = 0; i < colored.length; i++) {
          if (colored[i].color === c && isNear(box, colored[i])) { ng = true; break; }
        }
        if (!ng) return c;
      }
      return TAG_COLORS[start];          // 8色すべてぶつかったらハッシュ色に戻す
    };

    const parts = [];
    for (const it of tagItems) {
      if (it.x == null) continue;
      const color = pickColor(it);
      colored.push({ x: it.x, y: it.y, w: it.w, h: it.h, color });
      const title = it.vids
        ? it.hits.toLocaleString() + " 件 ・ " + it.vids.toLocaleString() + " 本の動画"
        : it.hits.toLocaleString() + " 件";
      parts.push(
        `<button type="button" class="tag" style="left:${it.x}px;top:${it.y - top}px;` +
        `font-size:${it.size}px;font-weight:${it.weight};color:${color}"` +
        ` data-q="${escapeHTML(it.word)}" title="${escapeHTML(title)}">` +
        `${escapeHTML(it.word)}</button>`
      );
    }
    tagListEl.classList.remove("is-flow");
    tagListEl.style.height = (bottom - top) + "px";
    tagListEl.innerHTML = parts.join("");
  }

  // 退避表示: 渦巻き配置ができない環境では、単純に折り返して並べる
  function renderTagsFlow() {
    const parts = [];
    for (const it of tagItems) {
      parts.push(
        `<button type="button" class="tag" style="font-size:${it.size || 14}px"` +
        ` data-q="${escapeHTML(it.word)}">${escapeHTML(it.word)}</button>`
      );
    }
    tagListEl.classList.add("is-flow");
    tagListEl.style.height = "";
    tagListEl.innerHTML = parts.join("");
  }

  // 検索窓が空のときだけ出す（結果を押し下げないため）
  function updateTagsVisibility() {
    const show = tagsReady && qInput.value.trim() === "";
    const wasHidden = tagsEl.hidden;
    tagsEl.hidden = !show;
    // 非表示のあいだは幅が 0 で測れないので、表示に切り替わった時点で組み直す
    if (show && wasHidden && tagListEl.clientWidth !== laidOutWidth) layoutTags();
  }

  tagListEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".tag");
    if (!btn) return;
    qInput.value = btn.dataset.q;
    run();
    window.scrollTo({ top: 0, behavior: "smooth" });
  });

  // 画面幅が変わったら組み直す（縦スクロールバーの出入り程度では動かさない）
  let tagResizeTimer = 0;
  window.addEventListener("resize", () => {
    if (!tagsReady || tagsEl.hidden) return;
    clearTimeout(tagResizeTimer);
    tagResizeTimer = setTimeout(() => {
      if (Math.abs(tagListEl.clientWidth - laidOutWidth) > 12) layoutTags();
    }, 200);
  });

  function run() {
    const raw = qInput.value.trim();
    rowByKey.clear();
    clearBtn.classList.toggle("is-on", raw.length > 0);
    updateTagsVisibility();
    history.replaceState(null, "", raw ? "#" + encodeURIComponent(raw) : location.pathname + location.search);

    if (!raw) {
      statusEl.textContent = "";
      resultsEl.innerHTML =
        `<div class="note">キーワードを入力すると、全動画の発言から一致箇所を探します。<br>` +
        `タイムスタンプを押すと YouTube の該当時刻が開きます。` +
        (tagsReady ? `<br>上の言葉を押してもすぐ検索できます。` : ``) + `</div>`;
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
      const thumb = `https://i.ytimg.com/vi/${encodeURIComponent(v.id)}/mqdefault.jpg`;
      parts.push(`<section class="group">` +
        `<a class="group__head" href="${vurl}" target="_blank" rel="noopener">` +
          `<img class="group__thumb" src="${thumb}" alt="" width="160" height="90" loading="lazy" decoding="async">` +
          `<h2 class="group__title">${escapeHTML(v.title)}</h2>` +
        `</a><ul class="hits">`);
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
  // サムネ読み込み失敗（削除・非公開動画など）は画像を隠す
  // 画像のerrorはバブルしないため、capture段階で拾う
  resultsEl.addEventListener("error", (e) => {
    const img = e.target;
    if (img && img.classList && img.classList.contains("group__thumb")) {
      const head = img.closest(".group__head");
      if (head) head.classList.add("is-nothumb");
    }
  }, true);
  modal.addEventListener("click", (e) => {
    if (e.target.hasAttribute("data-close")) closePropose();
  });
  el("proposeSubmit").addEventListener("click", submitPropose);
  prevBtn.addEventListener("click", () => navPropose(-1));
  nextBtn.addEventListener("click", () => navPropose(1));

  // ---- 本サイトについて モーダル ----
  const aboutModal = el("aboutModal");
  const aboutBody  = el("aboutBody");

  function openAbout() {
    aboutModal.hidden = false;
    aboutBody.scrollTop = 0;          // 常に冒頭から
    aboutBody.focus();
  }
  function closeAbout() { aboutModal.hidden = true; }

  el("aboutOpen").addEventListener("click", openAbout);
  aboutModal.addEventListener("click", (e) => {
    if (e.target.hasAttribute("data-close")) closeAbout();
  });

  // Escapeキー: 開いている方のモーダルを閉じる（同時に開くことはない）
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!modal.hidden) closePropose();
    else if (!aboutModal.hidden) closeAbout();
  });

  // 入力（デバウンス）
  let timer = 0;
  qInput.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(run, 120); });
  qInput.addEventListener("keydown", (e) => { if (e.key === "Escape") { qInput.value = ""; run(); } });
  clearBtn.addEventListener("click", () => { qInput.value = ""; run(); qInput.focus(); });

  qInput.disabled = true;
  boot();
})();
