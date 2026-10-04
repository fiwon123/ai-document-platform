import { chromium } from 'playwright';

const results = [];
for (const [label, url, viewport, scheme] of [
  ['light-1280', 'http://localhost:5173/terms', {width:1280,height:1000}, 'light'],
  ['dark-1280', 'http://localhost:5173/terms', {width:1280,height:1000}, 'dark'],
  ['light-390', 'http://localhost:5173/terms', {width:390,height:844}, 'light'],
]) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport, colorScheme: scheme });
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type()==='error') errors.push(m.text()); });
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  const data = await page.evaluate(() => {
    const out = { overflowX: document.documentElement.scrollWidth - window.innerWidth, lists: [], samples: [], h2s: [], ps: [] };
    const article = document.querySelector('main') || document.body;
    for (const list of article.querySelectorAll('ul, ol')) {
      const r = list.getBoundingClientRect();
      const items = [...list.children].map(li => {
        const lr = li.getBoundingClientRect();
        const style = getComputedStyle(li);
        // find the text node start x via Range
        const range = document.createRange();
        range.selectNodeContents(li);
        const rects = [...range.getClientRects()];
        return {
          text: li.textContent.trim().slice(0, 50),
          liLeft: Math.round(lr.left*10)/10,
          liRight: Math.round(lr.right*10)/10,
          lines: rects.length,
          firstLineLeft: rects[0] ? Math.round(rects[0].left*10)/10 : null,
          lineHeightLefts: rects.map(x => Math.round(x.left*10)/10),
          lastLineRight: rects.length ? Math.round(rects[rects.length-1].right*10)/10 : null,
          marker: style.listStyleType,
          ml: style.marginLeft, pl: style.paddingLeft,
        };
      });
      out.lists.push({
        tag: list.tagName,
        width: Math.round(r.width*10)/10,
        left: Math.round(r.left*10)/10,
        right: Math.round(r.right*10)/10,
        items,
      });
    }
    // sample: h2 and following p left edges
    for (const h2 of article.querySelectorAll('h2')) {
      const r = h2.getBoundingClientRect();
      out.h2s.push({ t: h2.textContent.trim().slice(0,40), left: Math.round(r.left*10)/10, width: Math.round(r.width*10)/10 });
    }
    for (const p of article.querySelectorAll('p')) {
      const r = p.getBoundingClientRect();
      out.ps.push({ t: p.textContent.trim().slice(0,30), left: Math.round(r.left*10)/10, width: Math.round(r.width*10)/10 });
    }
    // find any element wider than viewport
    out.wide = [...document.querySelectorAll('*')].filter(el => el.getBoundingClientRect().right > window.innerWidth + 1).map(el => el.tagName + '.' + el.className).slice(0,10);
    return out;
  });
  results.push({ label, errors, ...data });
  await browser.close();
}
console.log(JSON.stringify(results, null, 2));
