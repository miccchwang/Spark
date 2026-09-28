/* Spark — slash commands for the discussion area.

   A message typed into a thread is either plain text or a command. This module only
   *parses* — it decides what was meant and pulls the arguments apart. Executing a command
   needs the network and the local store, so that lives in app.js; keeping the grammar
   separate means it can be tested on its own and can never touch the backend by accident.

   Everything here is deterministic: the same line always parses to the same object, and
   nothing is sent anywhere until the caller decides to act on the result. */

window.Commands = (function () {
  /* ---------------- relative dates ----------------
     A /todo can carry a due date in the same words people already use out loud. The
     parser resolves it against the device clock at parse time and returns a plain
     YYYY-MM-DD, so the stored value never depends on when it is read back. */

  const WEEKDAYS = { 日: 0, 天: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6 };
  const DAY = 86400000;

  const ymd = (d) =>
    d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' +
    String(d.getDate()).padStart(2, '0');

  const atMidnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());

  /**
   * Pull a due date off the front of a string.
   * Returns { due, label, rest } where due is '' when nothing was recognised.
   */
  function due(text, now) {
    const base = atMidnight(now ? new Date(now) : new Date());
    const raw = String(text || '');
    const lead = raw.replace(/^[\s,，、:：]+/, '');

    const take = (m, date, label) => ({
      due: ymd(date),
      label: label,
      rest: lead.slice(m[0].length).replace(/^[\s,，、:：]+/, ''),
    });

    let m;

    // 2026-03-18 / 2026/3/18
    m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(lead);
    if (m) {
      const d = new Date(+m[1], +m[2] - 1, +m[3]);
      if (!isNaN(d)) return take(m, d, (+m[2]) + '月' + (+m[3]) + '日');
    }

    // 3月18日 / 3月18号 / 3-18
    m = /^(\d{1,2})\s*[月/-]\s*(\d{1,2})\s*[日号]?/.exec(lead);
    if (m && +m[1] >= 1 && +m[1] <= 12 && +m[2] >= 1 && +m[2] <= 31) {
      let d = new Date(base.getFullYear(), +m[1] - 1, +m[2]);
      // A bare date already behind us almost certainly means next year.
      if (d < base) d = new Date(base.getFullYear() + 1, +m[1] - 1, +m[2]);
      return take(m, d, (+m[1]) + '月' + (+m[2]) + '日');
    }

    // N 天后 / N 周后 / N 个月后
    m = /^(\d+)\s*(天|日|周|个?星期|个月|月)\s*(?:之?后|内)/.exec(lead);
    if (m) {
      const n = +m[1];
      const d = new Date(base);
      if (/天|日/.test(m[2])) d.setDate(d.getDate() + n);
      else if (/周|星期/.test(m[2])) d.setDate(d.getDate() + n * 7);
      else d.setMonth(d.getMonth() + n);
      return take(m, d, m[0].replace(/\s+/g, ''));
    }

    // 今天 / 明天 / 后天 / 大后天 / 今晚 / 明早
    m = /^(大后天|后天|明天|明日|今天|今日|今晚|明早|今早|本周|这周)/.exec(lead);
    if (m) {
      const d = new Date(base);
      const w = m[1];
      if (/大后天/.test(w)) d.setDate(d.getDate() + 3);
      else if (/后天/.test(w)) d.setDate(d.getDate() + 2);
      else if (/明天|明日|明早/.test(w)) d.setDate(d.getDate() + 1);
      return take(m, d, w);
    }

    // 下周三 / 下星期日 / 本周五 / 周三 / 星期五
    m = /^(下+)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天])/.exec(lead);
    if (m) {
      const want = WEEKDAYS[m[2]];
      const weeks = m[1] ? m[1].length : 0;
      const d = new Date(base);
      // Days until the next occurrence of that weekday (today counts as next week).
      let delta = (want - d.getDay() + 7) % 7;
      if (delta === 0) delta = 7;
      d.setDate(d.getDate() + delta + weeks * 7);
      return take(m, d, m[0].replace(/\s+/g, ''));
    }

    // 下个月 / 月底
    m = /^(下个月|下月|月底|月末)/.exec(lead);
    if (m) {
      const d = new Date(base);
      if (/下/.test(m[1])) d.setMonth(d.getMonth() + 1, 1);
      else d.setMonth(d.getMonth() + 1, 0);
      return take(m, d, m[1]);
    }

    // latin: today / tomorrow / next monday / in 3 days
    m = /^(today|tomorrow|tmr)\b/i.exec(lead);
    if (m) {
      const d = new Date(base);
      if (!/today/i.test(m[1])) d.setDate(d.getDate() + 1);
      return take(m, d, /today/i.test(m[1]) ? '今天' : '明天');
    }
    m = /^in\s+(\d+)\s*(day|week|month)s?\b/i.exec(lead);
    if (m) {
      const n = +m[1];
      const d = new Date(base);
      if (/day/i.test(m[2])) d.setDate(d.getDate() + n);
      else if (/week/i.test(m[2])) d.setDate(d.getDate() + n * 7);
      else d.setMonth(d.getMonth() + n);
      return take(m, d, m[0]);
    }
    m = /^next\s+(mon|tue|wed|thu|fri|sat|sun)day\b/i.exec(lead);
    if (m) {
      const idx = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
        .indexOf(m[1].toLowerCase().slice(0, 3));
      const d = new Date(base);
      let delta = (idx - d.getDay() + 7) % 7;
      if (delta === 0) delta = 7;
      d.setDate(d.getDate() + delta + 7);
      return take(m, d, m[0]);
    }

    return { due: '', label: '', rest: lead };
  }

  /** Human label for a stored due date, relative to today. */
  function describeDue(value, now) {
    if (!value) return '';
    const base = atMidnight(now ? new Date(now) : new Date());
    const d = new Date(value + 'T00:00:00');
    if (isNaN(d)) return value;
    const days = Math.round((d - base) / DAY);
    if (days === 0) return '今天';
    if (days === 1) return '明天';
    if (days === 2) return '后天';
    if (days === -1) return '昨天';
    if (days > 2 && days < 7) return '周' + '日一二三四五六'[d.getDay()];
    if (days < 0) return '已过期 ' + Math.abs(days) + ' 天';
    return (d.getMonth() + 1) + '月' + d.getDate() + '日';
  }

  /* ---------------- command table ---------------- */

  const SPECS = [
    {
      name: 'todo',
      usage: '/todo [时间] 内容',
      hint: '把一句话变成群里的待办，例如 /todo 明天 换掉登录页的按钮色',
      args: 'text',
    },
    {
      name: 'done',
      usage: '/done 序号或文字',
      hint: '勾掉一条待办，序号来自上面的清单，例如 /done 2',
      args: 'ref',
    },
    {
      name: 'assign',
      usage: '/assign @邮箱 [时间] 内容',
      hint: '指派给群里的人，例如 /assign @li@team.com 周五 出配色稿',
      args: 'assign',
    },
    {
      name: 'tag',
      usage: '/tag 词1 词2',
      hint: '给这条灵感打标签，用空格或顿号分开',
      args: 'tags',
    },
    {
      name: 'pin',
      usage: '/pin 内容',
      hint: '钉一条结论在讨论最上面',
      args: 'text',
    },
    {
      name: 'summary',
      usage: '/summary [条数]',
      hint: '在本机把灵感正文和整条讨论算成摘要，不联网、不改写原话',
      args: 'count',
    },
    {
      name: 'keywords',
      usage: '/keywords [个数]',
      hint: '列出这段讨论里最突出的词，纯词频统计',
      args: 'count',
    },
    {
      name: 'help',
      usage: '/help',
      hint: '列出所有命令',
      args: 'none',
    },
  ];

  const BY_NAME = {};
  SPECS.forEach((s) => { BY_NAME[s.name] = s; });

  /* ---------------- argument parsing ---------------- */

  function parseTags(rest) {
    return String(rest || '')
      .split(/[\s,，、;；#]+/)
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 12);
  }

  function parseCount(rest, fallback, max) {
    const m = /^\s*(\d{1,3})/.exec(String(rest || ''));
    if (!m) return fallback;
    return Math.min(max, Math.max(1, +m[1]));
  }

  /* "@a@b.com 明天 内容" — the handle runs to the first whitespace, because an email
     address contains an @ of its own. A bare name works too: "@li 出稿". */
  function parseAssign(rest, now) {
    const m = /^\s*@([^\s]+)\s*([\s\S]*)$/.exec(String(rest || ''));
    if (!m) return { who: '', text: String(rest || '').trim(), due: '', label: '' };
    const after = due(m[2], now);
    return { who: m[1], text: after.rest, due: after.due, label: after.label };
  }

  /**
   * Turn one typed line into a message descriptor.
   *
   *   { kind: 'text',    body }                          plain discussion
   *   { kind: 'command', command, args, rest, spec }      recognised command
   *   { kind: 'unknown', command, rest }                  slash but no such command
   *
   * A line that merely starts with a slash but is not a bare word — a path like
   * "/var/log" or an emoticon — stays plain text rather than turning into an error.
   */
  function parse(input, opts) {
    const raw = String(input == null ? '' : input).trim();
    if (!raw) return { kind: 'text', body: '' };
    if (raw[0] !== '/') return { kind: 'text', body: raw };

    const m = /^\/([A-Za-z\u4e00-\u9fa5]+)(?:\s+([\s\S]*))?$/.exec(raw);
    if (!m) return { kind: 'text', body: raw };

    const name = m[1].toLowerCase();
    const rest = (m[2] || '').trim();
    const spec = BY_NAME[name];
    if (!spec) return { kind: 'unknown', command: name, rest: rest };

    const now = (opts && opts.now) || undefined;
    let args = {};

    switch (spec.args) {
      case 'text': {
        const d = due(rest, now);
        args = { text: d.rest, due: d.due, label: d.label };
        break;
      }
      case 'ref':
        args = { ref: rest };
        break;
      case 'assign':
        args = parseAssign(rest, now);
        break;
      case 'tags':
        args = { tags: parseTags(rest) };
        break;
      case 'count':
        args = { limit: parseCount(rest, spec.name === 'summary' ? 3 : 10, 20) };
        break;
      default:
        args = {};
    }

    return { kind: 'command', command: name, rest: rest, args: args, spec: spec };
  }

  /** True when a command carries everything it needs to run. */
  function isComplete(p) {
    if (!p || p.kind !== 'command') return false;
    switch (p.command) {
      case 'todo': return !!p.args.text;
      case 'done': return !!p.args.ref;
      case 'assign': return !!p.args.who && !!p.args.text;
      case 'tag': return p.args.tags.length > 0;
      case 'pin': return !!p.args.text;
      default: return true;
    }
  }

  /** One-line explanation of what a parsed command will do, for the confirm strip. */
  function preview(p) {
    if (!p) return '';
    if (p.kind === 'unknown') return '没有 /' + p.command + ' 这个命令';
    if (p.kind !== 'command') return '';
    const a = p.args;
    switch (p.command) {
      case 'todo':
        return '新建待办：' + a.text + (a.label ? ' · 截止 ' + a.label : '');
      case 'done':
        return '勾掉待办：' + a.ref;
      case 'assign':
        return '指派给 ' + a.who + '：' + a.text + (a.label ? ' · 截止 ' + a.label : '');
      case 'tag':
        return '打标签：' + a.tags.join(' · ');
      case 'pin':
        return '钉住：' + a.text;
      case 'summary':
        return '本机摘要 · 取 ' + a.limit + ' 句';
      case 'keywords':
        return '本机关键词 · 取 ' + a.limit + ' 个';
      case 'help':
        return '列出全部命令';
      default:
        return '';
    }
  }

  const names = () => SPECS.map((s) => '/' + s.name);

  /** Command names that start with what has been typed, for the palette. */
  function suggest(fragment) {
    const f = String(fragment || '').replace(/^\//, '').toLowerCase();
    if (!f) return SPECS.slice();
    return SPECS.filter((s) => s.name.indexOf(f) === 0);
  }

  return {
    parse,
    isComplete,
    preview,
    due,
    describeDue,
    names,
    suggest,
    specs: () => SPECS.slice(),
  };
})();
