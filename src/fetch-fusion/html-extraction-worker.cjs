const { parentPort } = require('node:worker_threads');
const { Readability } = require('@mozilla/readability');
const { JSDOM, VirtualConsole } = require('jsdom');

function cleanLegacy(content) {
  return content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
    .filter((line) => !/^(首页导航|登录|注册)$/i.test(line))
    .filter((line) => !/^(首页导航|登录|注册)\b/i.test(line))
    .filter((line) => !/(上一篇|下一篇|热门解读|相关推荐)/i.test(line)).join('\n');
}

function cleanGeneric(content) {
  return content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).join('\n');
}

function extract(html, url, generic = false) {
  const virtualConsole = new VirtualConsole();
  const warnings = [];
  virtualConsole.on('jsdomError', (error) => {
    if (/stylesheet|css/i.test(error?.message || '')) warnings.push(`css_parse_warning: ${error.message}`);
  });
  let dom;
  try {
    dom = new JSDOM(html, { url, virtualConsole });
    const document = dom.window.document;
    const documentTitle = document.title?.trim() || '';
    const officialUrls = generic ? [] : Array.from(document.querySelectorAll('a[href]')).map((anchor) => anchor.getAttribute('href') || '')
      .map((href) => { try { return new URL(href, url).toString(); } catch { return ''; } })
      .filter((href) => /\.gov\.cn(?=\/|$)/i.test(href));
    const rawText = document.body?.textContent || '';
    const article = new Readability(document).parse();
    let articleText = '';
    if (article?.content) {
      const container = document.createElement('div');
      container.innerHTML = article.content;
      articleText = container.textContent || '';
    }
    return {
      title: article?.title?.trim() || documentTitle,
      content: generic ? cleanGeneric(articleText || rawText) : cleanLegacy(articleText || rawText),
      officialUrls: Array.from(new Set(officialUrls)),
      warnings,
    };
  } finally {
    dom?.window.close();
  }
}

if (!parentPort) throw new Error('HTML extraction worker requires a parent port.');

parentPort.on('message', (message) => {
  try {
    parentPort.postMessage({ id: message.id, result: extract(message.html, message.url, message.generic) });
  } catch (error) {
    parentPort.postMessage({
      id: message.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});
