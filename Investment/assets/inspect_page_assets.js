/* =====================================================================
   inspect_page_assets.js  —  deep page inspector
   ---------------------------------------------------------------------
   Run this on a single page BEFORE writing an extractor for a new site,
   or when the extractor returns nothing for a page that clearly has
   content on screen.

   It reports every link, image, CSS background image, hard-coded asset
   URL and canvas element on the page, and tells you whether each canvas
   can be captured or is blocked by cross-origin tainting. That is how
   you find content that is drawn rather than written — a scanned image,
   a chart, a PDF rendered into a canvas — which no text or table parser
   will ever see.

   Paste into the console on the target page, while logged in.
   ===================================================================== */

// Deep inspection: find EVERY possible asset URL on the LAPL page,
// not just ones matching "screenshots"
(async function() {
  const url = 'https://www.ipomatrix.com/ipo/lapl-automotive-ipo/2300?tab=boa';
  const win = window.open(url, 'deepInspect', 'width=1200,height=900');
  if (!win) { console.error('Popup blocked!'); return; }
  console.log('Loading page...');
  await new Promise(r => setTimeout(r, 5000));
  console.log('=== ALL <a href> ===');
  Array.from(win.document.querySelectorAll('a[href]')).forEach(a => {
    console.log(JSON.stringify(a.textContent.trim().slice(0,30)), '->', a.href);
  });
  console.log('=== ALL <img src> ===');
  Array.from(win.document.querySelectorAll('img[src]')).forEach(img => {
    console.log(JSON.stringify(img.alt || ''), '->', img.src);
  });
  console.log('=== Elements with CSS background-image ===');
  Array.from(win.document.querySelectorAll('*')).forEach(el => {
    const bg = win.getComputedStyle(el).backgroundImage;
    if (bg && bg !== 'none') {
      console.log(el.tagName, el.className, '->', bg);
    }
  });
  console.log('=== Any element containing "chittorgarh.net" anywhere in outerHTML ===');
  const bodyHtml = win.document.body.outerHTML;
  const matches = bodyHtml.match(/https?:\/\/[^\s"'<>]*chittorgarh\.net[^\s"'<>]*/g);
  console.log(matches || 'none found');
  console.log('=== Any <canvas> elements (could be a PDF/image drawn via JS, invisible to text or <img> search) ===');
  const canvases = Array.from(win.document.querySelectorAll('canvas'));
  console.log(`Found ${canvases.length} canvas element(s).`);
  canvases.forEach((c, i) => {
    console.log(`Canvas #${i}: ${c.width}x${c.height}`);
    try {
      const dataUrl = c.toDataURL('image/png');
      console.log(`  toDataURL() succeeded, length: ${dataUrl.length} chars (this means we COULD capture it as an image)`);
      window[`__canvasCapture${i}`] = dataUrl;
    } catch (e) {
      console.log(`  toDataURL() FAILED: ${e.message} (likely a cross-origin/"tainted canvas" restriction)`);
    }
  });
  console.log('=== Full outerHTML of the "AVAILABLE" section area ===');
  const availEl = Array.from(win.document.querySelectorAll('*')).find(el => el.textContent.trim() === 'AVAILABLE');
  if (availEl) {
    console.log(availEl.closest('div')?.outerHTML?.slice(0, 1500) || 'no parent div found');
  } else {
    console.log('AVAILABLE element not found');
  }
  console.log('=== Done ===');
})();
