/* =====================================================================
   extract_details_batch.js  —  configurable page extractor
   ---------------------------------------------------------------------
   Reads a list of target URLs, opens each one inside your own logged-in
   browser session, parses every table on the page into structured JSON,
   and downloads the result in batches with checkpointing.

   HOW TO USE
     1. Fill column A of "Scrape-links.xlsx" with your target URLs.
     2. Log in to the target site in this browser.
     3. Open a page on that site, press F12, go to Console.
        Type "allow pasting" if the browser asks.
     4. Copy column A from the spreadsheet and paste it between the
        backticks in URL_LIST below.
     5. Paste this whole script into the console and press Enter.

   WHY LOGIN-GATED PAGES WORK
     The script runs inside the tab you are already authenticated in, so
     it inherits your session cookies. It never sees or stores a password
     and does not authenticate on your behalf — it reads exactly the
     pages you could open yourself by clicking.

   IMPORTANT
     Paste this on the SAME DOMAIN you are scraping. Browsers block a page
     on one origin from reading the contents of another, so running it
     from a different site will return empty documents.
   ===================================================================== */

(async function () {

  /* ---------------- paste your URLs between the backticks -------------- */
  const URL_LIST = `
https://www.example.com/page/1/
https://www.example.com/page/2/
`;

  /* ---------------- settings ------------------------------------------ */
  const CHECKPOINT_EVERY = 10;    // download a checkpoint every N pages
  const RESUME_FROM      = 0;     // restart here after a failed run
  const RENDER_WAIT_MS   = 3500;  // time given to each page to render
  const SETTLE_TRIES     = 8;     // re-checks while the table count grows
  const PAUSE_BETWEEN_MS = 800;   // politeness gap between pages
  const MIN_TABLES_OK    = 3;     // fewer than this is flagged as thin

  /* ---------------- prepare the queue --------------------------------- */
  const urls = URL_LIST.split(/[\r\n]+/)
    .map(u => u.trim())
    .filter(u => /^https?:\/\//i.test(u));

  if (!urls.length) {
    console.error('No URLs found. Paste them between the backticks in URL_LIST.');
    return;
  }

  const win = window.open('about:blank', 'extractor', 'width=1280,height=900');
  if (!win) { console.error('Popup blocked. Allow popups for this site and run again.'); return; }

  const results = [];
  let thin = 0, failed = 0;

  console.log(`Queued ${urls.length} URLs. Starting at index ${RESUME_FROM}.`);

  /* ---------------- helpers ------------------------------------------- */

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  // Wait until the document is ready AND the table count stops growing,
  // so pages that build their tables with scripts are not read too early.
  async function waitForRender(w) {
    await sleep(RENDER_WAIT_MS);
    let last = -1;
    for (let i = 0; i < SETTLE_TRIES; i++) {
      let now = 0;
      try { now = w.document.querySelectorAll('table').length; } catch (e) { return 0; }
      if (now > 0 && now === last) return now;
      last = now;
      await sleep(600);
    }
    return last;
  }

  const clean = s => (s || '').replace(/\s+/g, ' ').trim();

  // The heading a table sits under: walk backwards through previous
  // siblings, then up through ancestors, until a heading is found.
  function titleFor(table) {
    let node = table;
    for (let hop = 0; hop < 6 && node; hop++) {
      let sib = node.previousElementSibling;
      while (sib) {
        if (/^H[1-6]$/.test(sib.tagName)) return clean(sib.textContent);
        const h = sib.querySelector && sib.querySelector('h1,h2,h3,h4,h5,h6');
        if (h) return clean(h.textContent);
        sib = sib.previousElementSibling;
      }
      node = node.parentElement;
    }
    return '';
  }

  function readTable(table) {
    return Array.from(table.rows).map(r =>
      Array.from(r.cells).map(c => clean(c.innerText))
    ).filter(row => row.some(cell => cell.length));
  }

  // Label/value pairs anywhere on the page, used for fields that are not
  // in a table on every layout.
  function findLabelled(doc, labelRe) {
    const rows = Array.from(doc.querySelectorAll('tr,li,div'));
    for (const el of rows) {
      const t = clean(el.innerText);
      const m = t.match(labelRe);
      if (m && m[1] && m[1].length < 200) return clean(m[1]);
    }
    return null;
  }

  function download(obj, filename) {
    const blob = new Blob([JSON.stringify(obj, null, 1)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }

  /* ---------------- parse one rendered page --------------------------- */
  function parsePage(doc, url) {
    const h1 = doc.querySelector('h1');
    const rawTitle = clean(h1 ? h1.innerText : doc.title);

    const tables = Array.from(doc.querySelectorAll('table'));
    const sections = tables.map(t => ({
      title: titleFor(t),
      rows: readTable(t)
    })).filter(s => s.rows.length);

    // De-duplicate consecutive identical headings: the second table under
    // one heading keeps an empty title, which preserves the page order
    // without pretending the heading applies twice.
    for (let i = 1; i < sections.length; i++) {
      if (sections[i].title && sections[i].title === sections[i - 1].title) {
        sections[i].title = '';
      }
    }

    const bodyText = clean(doc.body ? doc.body.innerText : '');

    return {
      company: rawTitle.replace(/\s*(IPO\s*)?Details\s*$/i, '').trim(),
      company_raw_title: rawTitle,
      url: url,
      scraped_at: new Date().toISOString(),
      headline_strip: bodyText.slice(0, 400),
      total_applications_text: findLabelled(doc, /Total\s+Applications?\s*[:\-]?\s*([\d,]+)/i),
      registrar: findLabelled(doc, /Registrar\s*[:\-]?\s*(.+?)(?:Address|Phone|Email|$)/i),
      lead_managers: Array.from(doc.querySelectorAll('a,li'))
        .map(el => clean(el.innerText))
        .filter(t => /Lead Manager/i.test(t) === false && /Pvt\.?Ltd\.?$|Limited$|Ltd\.$/.test(t) && t.length < 90)
        .slice(0, 6),
      sections: sections
    };
  }

  /* ---------------- main loop ----------------------------------------- */
  for (let i = RESUME_FROM; i < urls.length; i++) {
    const url = urls[i];
    const tag = `[${i + 1}/${urls.length}]`;

    try {
      win.location.href = url;
      const tableCount = await waitForRender(win);

      if (!tableCount) {
        results.push({ url, error: 'no tables — page did not render or is cross-origin', sections: [] });
        failed++;
        console.warn(`${tag} EMPTY  ${url}`);
      } else {
        const rec = parsePage(win.document, url);
        results.push(rec);
        if (tableCount < MIN_TABLES_OK) {
          thin++;
          console.warn(`${tag} THIN   ${rec.company || url} — only ${tableCount} tables, may be partly rendered`);
        } else {
          console.log(`${tag} OK     ${rec.company || url} — ${rec.sections.length} sections`);
        }
      }
    } catch (e) {
      results.push({ url, error: String(e && e.message || e), sections: [] });
      failed++;
      console.error(`${tag} FAIL   ${url} — ${e.message}`);
    }

    // Checkpoint: a run that dies at record 47 resumes instead of restarting.
    if ((i + 1) % CHECKPOINT_EVERY === 0) {
      download(results, `details_checkpoint_${i + 1}.json`);
      console.log(`--- checkpoint saved at ${i + 1}. To resume later, set RESUME_FROM = ${i + 1} ---`);
    }

    await sleep(PAUSE_BETWEEN_MS);
  }

  /* ---------------- finish -------------------------------------------- */
  download(results, 'details_batch.json');
  try { win.close(); } catch (e) {}

  console.log('=== done ===');
  console.log(`captured ${results.length - failed} of ${urls.length} · thin ${thin} · failed ${failed}`);
  console.log('Next: python ingest_batch_json.py details_batch.json --output dataset.xlsx');

  window.__extractResults = results;   // also left in memory for inspection
})();
