// ==UserScript==
// @name         推理罪 · 启动签到（静默后台版）
// @namespace    https://www.tuiliz.com/
// @version      1.0.0
// @description  ScriptCat 启动时后台签到；当天已签静默跳过，跨日和网络恢复后自动再检查。
// @author       Roxy
// @license      MIT
// @background
// @connect      www.tuiliz.com
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_log
// @grant        GM_registerMenuCommand
// ==/UserScript==

return (async function () {
  'use strict';
  const ORIGIN = 'https://www.tuiliz.com';
  const PAGE = ORIGIN + '/plugin.php?id=zqlj_sign';
  const INTERVAL = 15 * 60 * 1000, LIMIT = 2 * 1024 * 1024;
  let inFlight = null, completedDay = '', lastLog = '';
  const chinaDay = () => new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
  function decode(text) {
    return text.replace(/&(?:amp|quot|apos|lt|gt|nbsp|#\d+|#x[\da-f]+);/gi, entity => {
      const name = entity.slice(1, -1).toLowerCase();
      const named = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ' };
      if (Object.hasOwn(named, name)) return named[name];
      const code = name.startsWith('#x') ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
    });
  }
  function attribute(source, name) {
    const pattern = /(?:^|\s)([\w:-]+)\s*=\s*(?:"([^"<]*)"|'([^'<]*)'|([^\s"'=<>`]+))/g;
    for (const match of source.matchAll(pattern)) if (match[1].toLowerCase() === name) return decode(match[2] ?? match[3] ?? match[4]);
    return '';
  }
  function safeURL(value, action = false) {
    let url;
    try { url = new URL(value, PAGE); } catch { throw Error('签到地址格式发生变化。'); }
    if (url.origin !== ORIGIN || url.username || url.password || url.hash) throw Error('已停止：签到地址超出推理罪网站。');
    if (action && (url.pathname !== '/plugin.php' || !['zqlj_sign', 'zqlj_sign:sign'].includes(url.searchParams.get('id')))) throw Error('签到接口发生变化，请更新脚本。');
    return url.href;
  }
  function parsePage(html) {
    // Parse just the site's own sign control. Ranking entries and inline scripts
    // may also contain "已签到"; they never prove the current account is signed in.
    const markup = html.replace(/<!--[\s\S]*?-->|<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '');
    const anchors = [...markup.matchAll(/<a\b([^>]{0,4096})>([\s\S]*?)<\/a\s*>/gi)];
    const profile = anchors.find(match => attribute(match[1], 'id') === 'myuser');
    const uid = profile ? /(?:[?&])uid=(\d+)(?:&|$)/.exec(attribute(profile[1], 'href'))?.[1] ?? '' : '';
    const title = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(markup)?.[1] ?? '';
    const dateMatch = /(20\d{2})年\s*(\d{1,2})月\s*(\d{1,2})日/.exec(title);
    const date = dateMatch ? `${dateMatch[1]}-${dateMatch[2].padStart(2, '0')}-${dateMatch[3].padStart(2, '0')}` : '';
    for (const [, attributes, inner] of anchors) {
      const id = attribute(attributes, 'id'), classes = attribute(attributes, 'class').split(/\s+/);
      const text = decode(inner.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
      if (classes.includes('guest') && /登录后签到/.test(text)) return { kind: 'login' };
      const href = attribute(attributes, 'href'), modern = id === 'signBtn';
      const legacy = !modern && /^(?:\.\/)?plugin\.php\?id=zqlj_sign(?:&|$)/.test(href) && /(?:[?&])sign=/.test(href);
      if (!modern && !legacy) continue;
      if (!uid || !date || !/^20\d{2}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/.test(date)) throw Error('签到页的账号或日期无法确认，请检查登录状态。');
      if (classes.includes('done') || /^(?:今日)?已(?:签到|打卡)(?:[！!。.]|\s|$)/.test(text)) return { kind: 'done', date, uid };
      if (classes.includes('loading')) throw Error('网站签到正在处理中，稍后再检查。');
      const value = modern ? attribute(attributes, 'data-url') : href;
      if (!value || !/(?:点击|立即|马上)?(?:打卡|签到)/.test(text)) throw Error('签到按钮发生变化，请更新脚本。');
      return { kind: 'pending', date, uid, url: safeURL(value, true) };
    }
    if (!uid && /登录|请先登录/.test(markup.replace(/<[^>]*>/g, ''))) return { kind: 'login' };
    throw Error('未识别到签到状态；可能遇到验证页面或网站改版。');
  }
  function request(url) {
    safeURL(url);
    return new Promise((resolve, reject) => {
      let handle, settled = false;
      const fail = text => { if (!settled) { settled = true; reject(Error(text)); } };
      try { handle = GM_xmlhttpRequest({
        method: 'GET', url, anonymous: false, nocache: true, redirect: 'error',
        timeout: 15000, responseType: 'text',
        headers: { Accept: 'text/html, application/json', 'Cache-Control': 'no-cache' },
        onprogress: progress => {
          if ((progress.loaded ?? 0) > LIMIT || (progress.totalSize ?? 0) > LIMIT) { fail('网站响应过大，已停止本次检查。'); handle?.abort(); }
        },
        onload: response => {
          if (settled) return;
          try {
            if (response.status !== 200) throw Error(`网站请求失败（HTTP ${Number(response.status) || 0}），稍后重试。`);
            if (response.finalUrl) safeURL(response.finalUrl);
            if (typeof response.responseText !== 'string' || response.responseText.length > LIMIT) throw Error('网站响应无效或过大。');
            settled = true; resolve(response.responseText);
          } catch (error) { fail(error.message); }
        },
        onerror: () => fail('网络请求失败，稍后重试。'),
        ontimeout: () => fail('网络请求超时，稍后重试。'),
        onabort: () => fail('本次请求已取消。')
      }); } catch { fail('后台网络接口不可用，请检查 ScriptCat 的网站访问权限。'); }
    });
  }
  async function record(message, page) {
    const old = await GM_getValue('tuilizStatus', {});
    const next = { ...old, checkedAt: Date.now(), message };
    if (page?.kind === 'done') {
      next.lastSuccess = { date: page.date, uid: page.uid };
      // A midnight rollover or stale server date must not suppress today's check.
      completedDay = page.date === chinaDay() ? page.date : '';
    }
    await GM_setValue('tuilizStatus', next);
    if (lastLog !== message) { GM_log(message); lastLog = message; }
  }
  async function check(force = false) {
    if (inFlight) return inFlight;
    if (!force && completedDay === chinaDay()) return;
    inFlight = (async () => {
      try {
        const before = parsePage(await request(PAGE));
        if (before.kind === 'login') { await record('登录已失效，请先打开推理罪网站登录；后台会继续检查。'); return; }
        if (before.kind === 'done') { await record('今日已签到，静默跳过。', before); return; }
        await request(before.url);
        // HTTP 200 (or any message in the reply) alone cannot establish success.
        const after = parsePage(await request(PAGE));
        if (after.kind !== 'done' || after.uid !== before.uid) throw Error('服务器尚未确认签到完成，稍后重新检查。');
        await record('签到已完成，已由服务器页面确认。', after);
      } catch (error) {
        // Exceptions emitted here are our own bounded messages. Never log HTML,
        // session cookies or token-bearing URLs from the server.
        const known = error instanceof Error ? error.message : '本次检查未完成，稍后重试。';
        await record(known);
      }
    })();
    try { await inFlight; } finally { inFlight = null; }
  }
  GM_registerMenuCommand('立即检查签到（静默）', () => check(true));
  // Keep the Promise alive so ScriptCat retains this background sandbox and GM
  // access. Enabling the script or starting the browser begins the first check.
  while (true) {
    await check();
    await new Promise(resolve => setTimeout(resolve, INTERVAL));
  }
})();
