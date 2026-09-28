/* Spark — deterministic text distillation.

   Nothing here is a model. Every result is arithmetic over word counts, so the output is
   reproducible and auditable: the same text always yields the same keywords, the same
   digest, the same action list. No network, no inference, no interpretation.

   Two pieces of prior art do the heavy lifting:
     - Intl.Segmenter gives ICU's dictionary-based CJK word segmentation for free, on
       device. It is good but incomplete — it has no entry for 动效 or 缓动 and splits them
       into single characters. So every CJK word is also indexed as character bigrams,
       which can never miss a term. Bigrams are noisy on their own, but the noise is
       exactly what IDF suppresses, because junk like 页的 / 的动 appears everywhere.
     - TF-IDF scored against the user's *own* corpus of ideas, not a generic corpus. A term
       that is rare for this user ranks high, which is what makes the keywords feel
       specific rather than generic.

   Sentence selection uses TextRank (PageRank over a sentence-similarity graph) so the
   digest picks central sentences rather than merely early ones. Action items are matched
   against an explicit marker list — a rule, not a judgement. */
window.Summarize = (function () {
  /* ---------------- vocabulary ---------------- */

  /* Function words. Chinese has no spaces, so the stopword list matters more than it does
     for English: without it 的/了/是 dominate every frequency count, and adverbs like
     现在/已经/必须 would outrank the actual subject of a spoken note. */
  const STOP = new Set([
    '的', '了', '是', '在', '和', '与', '及', '或', '也', '都', '就', '而', '但', '还',
    '把', '被', '让', '给', '对', '从', '到', '向', '于', '为', '以', '之', '其', '此',
    '这', '那', '有', '没', '不', '很', '太', '更', '最', '会', '能', '可', '想',
    '个', '些', '点', '上', '下', '里', '中', '后', '前', '时', '吧', '呢', '啊', '吗',
    '我', '你', '他', '她', '它', '我们', '你们', '他们', '自己', '什么', '怎么', '这样',
    '一样', '一个', '一下', '一些', '然后', '所以', '因为', '如果', '可以', '应该',
    // adverbs, connectives and light verbs that carry no topic on their own
    '现在', '已经', '正在', '必须', '不能', '不要', '之后', '之前', '以前', '以后',
    '还要', '还有', '而且', '并且', '但是', '不过', '另外', '其他', '别的', '一起',
    '有点', '比较', '非常', '特别', '真的', '确实', '其实', '当然', '可能', '大概',
    '出现', '出来', '起来', '下去', '开始', '继续', '觉得', '认为', '知道', '发现',
    '关于', '对于', '通过', '根据', '按照', '比如', '例如', '总之', '反正', '至少',
    '第一', '第二', '第三', '最后', '同时', '目前', '当时', '总是', '经常', '偶尔',
    'the', 'a', 'an', 'and', 'or', 'but', 'of', 'to', 'in', 'on', 'at', 'for', 'is',
    'are', 'was', 'were', 'be', 'been', 'it', 'this', 'that', 'with', 'as', 'by',
    'i', 'we', 'you', 'they', 'he', 'she', 'my', 'our', 'so', 'if', 'then', 'than',
    'do', 'does', 'did', 'not', 'no', 'yes', 'can', 'will', 'would', 'should',
    'now', 'also', 'just', 'very', 'really', 'then', 'there', 'here', 'about',
  ]);

  /* Single-character function words, used to reject bigrams that straddle a word boundary
     when there is no segmenter to tell us where the boundary is. */
  const SINGLE_STOP = new Set();
  STOP.forEach((w) => { if (w.length === 1) SINGLE_STOP.add(w); });

  /* Rule-based action detection. These are markers, not a classifier: a sentence counts as
     a to-do when it carries one of these plus either a time reference or a second marker. */
  const ACTION_HINT = [
    '需要', '记得', '别忘', '安排', '确认', '联系', '跟进', '对接', '同步', '完成',
    '实现', '修复', '加上', '补上', '改成', '换成', '处理', '回复', '发给', '检查',
    '测试', '上线', '发布', '整理', '准备', '讨论', '申请', '提交', '要跟', '要对',
    '要把', '要去', '要做', '要先', '还得', '想要', '要', 'todo', 'fix', 'add',
    'check', 'send', 'review', 'ship', 'follow',
  ];
  /* 要 on its own means "need to", but it is also a component of 需要/重要/主要/只要,
     which are not commitments. Rather than drop it, exclude it when it follows one of
     these — the check is on the preceding character only, so 我要去 still counts. */
  const YAO_EXCLUDE = new Set(['需', '重', '主', '只', '将', '快', '不', '还', '想', '必', '次', '首']);
  const ACTION_EXCLUDE = { '要': YAO_EXCLUDE };
  const TIME_HINT = [
    '今天', '明天', '后天', '昨天', '本周', '下周', '上周', '周内', '月底', '年内',
    '尽快', '上午', '下午', '晚上', '早上', '之前', '以前', '截止', 'deadline',
    '周一', '周二', '周三', '周四', '周五', '周六', '周日',
  ];

  const CJK = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
  const CJK_RUN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]+/g;
  const LATIN_RUN = /[a-z0-9][a-z0-9'_-]*/g;

  const SEG = (typeof Intl !== 'undefined' && Intl.Segmenter)
    ? new Intl.Segmenter('zh-Hans', { granularity: 'word' })
    : null;

  /* ---------------- tokenising ---------------- */

  /** ICU knows where words end, so its output is a term in its own right. */
  function pushWord(out, run) {
    if (run.length >= 2) out.push(run);
    for (let i = 0; i + 2 <= run.length; i++) out.push(run.slice(i, i + 2));
  }

  /* Without ICU there are no word boundaries, so only bigrams are trustworthy: a whole run
     like 登录页的动效现在太生硬了 is not a word and must never be indexed as one. Bigrams
     that straddle a function word (的动, 页的) are dropped here — with ICU they cannot
     arise, because bigrams only ever come from inside a real word. */
  function pushBigrams(out, run) {
    for (let i = 0; i + 2 <= run.length; i++) {
      const g = run.slice(i, i + 2);
      if (SINGLE_STOP.has(g[0]) || SINGLE_STOP.has(g[1])) continue;
      out.push(g);
    }
  }

  function pushLatin(out, run) {
    if (run.length > 1 || /^[0-9]$/.test(run)) out.push(run);
  }

  /** Index terms for a piece of text: ICU words unioned with CJK bigrams. */
  function terms(text) {
    const src = String(text == null ? '' : text).toLowerCase();
    if (!src) return [];
    const out = [];

    if (SEG) {
      for (const piece of SEG.segment(src)) {
        if (!piece.isWordLike) continue;
        const t = piece.segment.trim();
        if (!t) continue;
        if (CJK.test(t)) pushWord(out, t.replace(/[^\u4e00-\u9fff]/g, ''));
        else pushLatin(out, t);
      }
    } else {
      // No ICU (very old WebView): fall back to bigrams over CJK runs.
      let m;
      CJK_RUN.lastIndex = 0;
      while ((m = CJK_RUN.exec(src))) pushBigrams(out, m[0]);
      LATIN_RUN.lastIndex = 0;
      while ((m = LATIN_RUN.exec(src))) pushLatin(out, m[0]);
    }

    const kept = [];
    for (const t of out) {
      if (t.length < 2 && !/^[0-9]$/.test(t)) continue;
      if (STOP.has(t)) continue;
      kept.push(t);
    }
    return kept;
  }

  /* ---------------- corpus statistics ---------------- */

  /**
   * Inverse document frequency over the user's own ideas. With a single idea every term
   * scores 1, so this degrades gracefully to plain frequency.
   */
  function buildIdf(texts) {
    const docs = (texts || []).map((t) => new Set(terms(t)));
    const n = docs.length || 1;
    const df = new Map();
    docs.forEach((set) => set.forEach((w) => df.set(w, (df.get(w) || 0) + 1)));
    return (w) => Math.log((n + 1) / ((df.get(w) || 0) + 1)) + 1;
  }

  const FLAT_IDF = () => 1;

  /* ---------------- keywords ---------------- */

  /**
   * Rank terms by tf * idf, with a mild length prior so 登录页 outranks 登录.
   * A term that merely spells out part of a stronger term is dropped, which is what keeps
   * the bigram index from flooding the result with fragments.
   */
  function keywords(text, opts) {
    const o = opts || {};
    const idf = o.idf || FLAT_IDF;
    const limit = o.limit || 8;
    const boost = o.boost || null;

    const all = terms(text);
    if (!all.length) return [];

    const tf = new Map();
    const first = new Map();
    all.forEach((t, i) => {
      tf.set(t, (tf.get(t) || 0) + 1);
      if (!first.has(t)) first.set(t, i);
    });
    const total = all.length;

    const scored = [];
    tf.forEach((count, term) => {
      const rel = count / total;
      // Spoken notes front-load their subject, so an early term is more likely to be the
      // topic. Without this every term occurring exactly once in the corpus scores
      // identically and the ranking collapses to insertion order.
      const lead = 1 - first.get(term) / total;
      let s = rel * idf(term) * Math.pow(term.length, 0.35) * (1 + 0.6 * lead);
      if (boost && boost.has(term)) s *= 1.8;
      scored.push({ term, score: s });
    });
    scored.sort((a, b) =>
      b.score - a.score || b.term.length - a.term.length || (a.term < b.term ? -1 : 1));

    const kept = [];
    for (const c of scored) {
      if (kept.length >= limit) break;
      if (kept.some((k) => k.term.includes(c.term) || c.term.includes(k.term))) continue;
      kept.push(c);
    }
    const top = kept.length ? kept[0].score : 1;
    return kept.map((k) => ({ term: k.term, score: top ? k.score / top : 0 }));
  }

  /* ---------------- sentences ---------------- */

  const BREAK = /[。！？!?；;\n]+/;

  function splitSentences(text) {
    return String(text == null ? '' : text)
      .split(BREAK)
      .map((s) => s.replace(/^[\s，,、.]+|[\s，,、.]+$/g, ''))
      .filter((s) => s.length > 1);
  }

  function sentenceVector(sentence, idf) {
    const ts = terms(sentence);
    const v = new Map();
    if (!ts.length) return v;
    ts.forEach((t) => v.set(t, (v.get(t) || 0) + 1));
    let norm = 0;
    v.forEach((count, t) => {
      const w = (count / ts.length) * idf(t);
      v.set(t, w);
      norm += w * w;
    });
    norm = Math.sqrt(norm) || 1;
    v.forEach((w, t) => v.set(t, w / norm));
    return v;
  }

  function cosine(a, b) {
    let dot = 0;
    const [small, big] = a.size <= b.size ? [a, b] : [b, a];
    small.forEach((w, t) => {
      const other = big.get(t);
      if (other) dot += w * other;
    });
    return dot;
  }

  /** PageRank over the sentence similarity graph. */
  function textrank(sim) {
    const n = sim.length;
    const out = sim.map((row) => row.reduce((s, x) => s + x, 0));
    const d = 0.85;
    let score = new Array(n).fill(1 / n);
    for (let it = 0; it < 30; it++) {
      const next = new Array(n).fill((1 - d) / n);
      for (let j = 0; j < n; j++) {
        if (!out[j]) continue;
        const share = (d * score[j]) / out[j];
        for (let i = 0; i < n; i++) {
          if (i !== j && sim[j][i]) next[i] += share * sim[j][i];
        }
      }
      score = next;
    }
    return score;
  }

  /** Shorter than this and it is a label rather than a sentence worth quoting back. */
  const MIN_SENTENCE = 8;

  /**
   * Extractive digest: the highest-scoring sentences, put back in the order they were
   * spoken so the result still reads as a narrative.
   */
  function digest(text, opts) {
    const o = opts || {};
    const idf = o.idf || FLAT_IDF;
    const sents = splitSentences(text);
    if (sents.length <= 1) return sents;

    let pool = sents.map((s, i) => i).filter((i) => sents[i].length >= MIN_SENTENCE);
    if (!pool.length) pool = sents.map((s, i) => i);

    const want = Math.max(1, Math.min(o.limit || 3, Math.round(pool.length * 0.4)));
    if (want >= pool.length) return pool.map((i) => sents[i]);

    const vecs = pool.map((i) => sentenceVector(sents[i], idf));
    const sim = vecs.map((a) => vecs.map((b) => cosine(a, b)));

    const ranked = textrank(sim).map((score, k) => ({ i: pool[k], score }));
    ranked.sort((a, b) => b.score - a.score);
    return ranked.slice(0, want).map((x) => x.i).sort((a, b) => a - b).map((i) => sents[i]);
  }

  /* ---------------- actions ---------------- */

  /**
   * Count marker occurrences without double-counting overlaps. 需要 contains 要, and
   * scoring both would turn a plain description into a commitment, so a marker that sits
   * entirely inside another match is discarded.
   */
  function hits(sentence, list, excludeBefore) {
    const low = sentence.toLowerCase();
    const spans = [];
    for (const w of list) {
      const blocked = excludeBefore && excludeBefore[w];
      let from = 0;
      for (;;) {
        const at = low.indexOf(w, from);
        if (at < 0) break;
        if (!blocked || !blocked.has(low[at - 1])) spans.push({ at, end: at + w.length, w });
        from = at + 1;
      }
    }
    spans.sort((a, b) => a.at - b.at || (b.end - b.at) - (a.end - a.at));
    const kept = [];
    for (const s of spans) {
      if (kept.some((k) => s.at >= k.at && s.end <= k.end)) continue;
      kept.push(s);
    }
    return { n: kept.length, found: kept.map((k) => k.w) };
  }

  /**
   * Pull out the sentences that read like commitments. Deliberately conservative: a marker
   * alone is not enough, because 需要 also appears in plain description.
   */
  function actions(text, opts) {
    const o = opts || {};
    const sents = o.sentences || splitSentences(text);
    const found = [];
    sents.forEach((s) => {
      const a = hits(s, ACTION_HINT, ACTION_EXCLUDE);
      const t = hits(s, TIME_HINT);
      if (!a.n) return;
      if (!t.n && a.n < 2) return;
      found.push({
        text: s,
        due: t.found.length ? t.found[0] : '',
        score: a.n + t.n * 1.5,
      });
    });
    found.sort((x, y) => y.score - x.score);
    return found.slice(0, o.limit || 5);
  }

  /* ---------------- public API ---------------- */

  /**
   * Everything the UI needs for one piece of text.
   * opts.idf comes from buildIdf() over the whole idea corpus; without it the ranking is
   * frequency-only, which is still usable for a single note. opts.boost is a Set of terms
   * taken from the idea's own title, which are the strongest signal of what it is about.
   */
  function summarize(text, opts) {
    const o = opts || {};
    const idf = o.idf || FLAT_IDF;
    const sents = splitSentences(text);
    return {
      keywords: keywords(text, { idf, limit: o.keywordLimit || 8, boost: o.boost }),
      digest: digest(text, { idf, limit: o.digestLimit || 3 }),
      actions: actions(text, { sentences: sents, limit: o.actionLimit || 5 }),
      sentences: sents,
    };
  }

  /** A one-line label, used for list rows and card previews. */
  function headline(text, opts) {
    return keywords(text, opts).slice(0, 3).map((x) => x.term).join(' · ');
  }

  /**
   * Roll several ideas into one view — the project-level digest.
   * Terms appearing in any title are boosted, and actions are deduplicated by opening
   * words so the same commitment recorded twice counts once.
   */
  function rollup(ideas, opts) {
    const o = opts || {};
    const list = (ideas || []).filter((i) => i && (i.note || i.title));
    const texts = list.map((i) => [i.title, i.note].filter(Boolean).join('。'));
    const idf = buildIdf(texts);

    const boost = new Set();
    list.forEach((i) => terms(i.title || '').forEach((t) => boost.add(t)));

    const out = summarize(texts.join('。'), {
      idf,
      boost,
      keywordLimit: o.keywordLimit || 12,
      digestLimit: o.digestLimit || 5,
      actionLimit: o.actionLimit || 8,
    });

    const seen = new Set();
    out.actions = out.actions.filter((a) => {
      const key = a.text.slice(0, 12);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    out.count = list.length;
    return out;
  }

  return {
    terms,
    buildIdf,
    keywords,
    digest,
    actions,
    summarize,
    headline,
    rollup,
    splitSentences,
    hasSegmenter: () => !!SEG,
  };
})();
