# eldolaron.com — code and UI audit

**What this repo does:** It serves El Dolarón’s public storefront, shows changing inventory from the store API, and directs customers to WhatsApp or the physical shop. The audited journey is browsing and asking about products, not online checkout. Assumed load: ordinary local shoppers, mostly on phones, browsing a live catalog that showed **1,006 items** during this review; no high-volume traffic assumption or load test.

Date: 2026-10-08. Tracking: [Issue #241](https://github.com/iskaar/El-Dolaron-Social-Kit/issues/241). Source baseline: [5609afe](https://github.com/iskaar/El-Dolaron-Social-Kit/tree/5609afe0db9fec3aee81da5d047a140eba295ca0). All source line references below refer to that commit. This report changes no application code or production data.

## Overall assessment

Keep the approved **Tabloide de ofertas** direction. The paper, navy/yellow/red palette, cutout headline, price tags and real photos make this recognizable as El Dolarón. The next work should improve finding and understanding merchandise, reliability and access; a new framework or visual reset would not solve the findings below.

The foundations are useful: static HTML/CSS with no site build dependencies; local fonts; explicit product-field selection in the public API; parameterized SQL; textContent when rendering product data; named WhatsApp links carrying product codes; category selection announced with aria-pressed; image space reserved; lazy catalog photos; and reduced-motion support. Reviewed code did not reveal a product-name HTML injection path or a public route exposing staff data. That is a scoped observation, not a full security certification.

## Scope and evidence

- Read all site HTML, CSS and JS, site README/DESIGN/Wrangler config, both site JS checks, the site validator, catalog API/tests and its public routing boundary. The prior [infrastructure audit #234](https://github.com/iskaar/El-Dolaron-Social-Kit/pull/234) remains the reference for the broader store backend.
- Inspected the live homepage at **375×812**, **1280×900**, and the normal **1536×826** browser viewport. The tested 375 and 1280 layouts did not overflow horizontally; scrollbar widths reduced their content area. These are desktop-browser responsive checks, not physical-phone tests.
- Used the catalog and clothing filter, keyboard navigation, rendered styles and image dimensions. The live stylesheet matched the audited source byte for byte. The complete deployed JS/Worker versions were not compared byte for byte.
- Both group links redirected to matching WhatsApp invitations: **Dolaron Ropa** and **Dolaron MG**. No group was joined and no message was sent. The privacy page loaded. Map and product-message destinations were inspected, not submitted.
- The live clothing filter returned two items, including **dama 50**, code **ED-000281**, priced **$60**, with a toy-like photo. Inventory is mutable; these observations are dated examples, not permanent assertions about current stock.
- The appendix runs source-based reproductions with synthetic data. It does not inject failures into the live site or modify its inventory.

## Must fix

### 1. Retrying “Ver más” skips the failed page — code defect

Source: [catalogo.js:125–155,170](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/5609afe0db9fec3aee81da5d047a140eba295ca0/site/public/catalogo.js#L125).

- **What this is:** The button loads the next 24 items.
- **Problem:** The counter advances before success. With page 1 loaded and page 2 failing, the offered retry requests page 3; the synthetic run rendered Page 1 and Page 3 and omitted Page 2.
- **Fix:** Keep the last successful page; request its successor and commit that page number only after success. Acceptance: requests are 1, 2, 2 when the first page-2 attempt fails.
- **If we skip it:** A brief network failure silently hides merchandise from a browsing customer.

### 2. Internal stock names leak into the storefront — code and content defect

Source: [catalogo.ts:18–25,59–68](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/5609afe0db9fec3aee81da5d047a140eba295ca0/app/src/catalogo.ts#L18).

- **What this is:** A name heuristic keeps unfinished/internal stock entries out of the public catalog and lists them for staff review.
- **Problem:** It only catches names already in uppercase. The live example **dama 50** passes; the same text as **DAMA 50** is excluded, and the lowercase version also escapes this staff-review reason.
- **Fix:** Normalize recognized internal naming patterns and share the rule with staff review; add lowercase/mixed-case fixtures while retaining legitimate names such as the existing gift-card test. Correct the observed item’s name/category/photo through a separate authorized content task.
- **If we skip it:** Customers see confusing product identities and staff do not get a reliable cleanup list. The known uppercase false-positive shortcut is not being reported again as a new defect.

### 3. The API supplies clothing size, but cards discard it — code/UI defect

Source: [catalogo.ts:40–44](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/5609afe0db9fec3aee81da5d047a140eba295ca0/app/src/catalogo.ts#L40), [catalogo.js:96–122](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/5609afe0db9fec3aee81da5d047a140eba295ca0/site/public/catalogo.js#L96).

- **What this is:** Product cards render the public API’s merchandise data.
- **Problem:** A synthetic product with talla: M renders only its name, price and WhatsApp action. Size is omitted from both visible details and the prepared message.
- **Fix:** Render a short size line when supplied; include it in the inquiry when useful. Acceptance: adult and child sizes appear, null size does not create an empty label, and the product code stays in the inquiry.
- **If we skip it:** Customers must start a conversation to learn a basic clothing attribute the system already knows.

### 4. A sale between pages makes catalog items disappear from browsing — code defect

Source: [catalogo.ts:81–101](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/5609afe0db9fec3aee81da5d047a140eba295ca0/app/src/catalogo.ts#L81).

- **What this is:** The API pages through currently sellable products using an offset: skip N rows, then return the next rows.
- **Problem:** If a product from page 1 sells out before page 2 is fetched, every later row shifts forward. A 49-item fixture skips ED-25 after ED-49 sells; new products can instead repeat previously shown rows.
- **Fix:** Page from the last returned creation-time/code pair, using the existing stable ordering, rather than a row count. Acceptance: an intervening sale or new arrival does not skip or repeat unaffected products; keep existing clients compatible during transition.
- **If we skip it:** The store’s normal inventory changes make a browsing session incomplete even with a healthy network.

### 5. Several small text labels fail minimum contrast — accessibility defect

Source: [styles.css:97–98,141,163,309](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/5609afe0db9fec3aee81da5d047a140eba295ca0/site/public/styles.css#L97).

- **What this is:** Red text is used for crossed-out list prices, the small opening-hours label and coupon introductions.
- **Problem:** Measured declared-color ratios are **3.45:1** on yellow, **3.94:1** on paper and **3.94:1** on the coupon. The list prices are 12px on mobile; these small labels need **4.5:1** under [WCAG’s minimum-contrast guidance](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html).
- **Fix:** Use the existing navy for small text, or choose a tested darker red token for those labels while keeping decorative brand red. Acceptance: measure each foreground/background combination at its actual font size, including textured backgrounds.
- **If we skip it:** Customers with reduced vision or a phone in bright light have trouble reading important price and hours details.

### 6. Coupon masks hide keyboard focus — accessibility defect

Source: [styles.css:32,130–133,183](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/5609afe0db9fec3aee81da5d047a140eba295ca0/site/public/styles.css#L130).

- **What this is:** The WhatsApp group coupons are links with a perforated-edge CSS mask.
- **Problem:** Keyboard focus applies an outline outside the link, but the same link’s mask clips it. On the live clothing coupon, focus was confirmed, hover was false, and the yellow outer indicator was not visible.
- **Fix:** Draw a focus indicator inside the coupon body, or put the mask on a decorative child. Acceptance: Tab and Shift+Tab clearly distinguish each focused coupon without relying on hover; see [Focus Visible](https://www.w3.org/WAI/WCAG22/Understanding/focus-visible.html).
- **If we skip it:** Keyboard users cannot reliably tell which invitation they are about to open.

### 7. Loading has no bounded wait, and initial errors remove the retry path — code/UI defect

Source: [catalogo.js:125–155](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/5609afe0db9fec3aee81da5d047a140eba295ca0/site/public/catalogo.js#L125), [index.html:65–69](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/5609afe0db9fec3aee81da5d047a140eba295ca0/site/public/index.html#L65).

- **What this is:** The catalog shows loading and fallback states.
- **Problem:** A request that does not settle stays at Cargando piezas… with aria-busy=true; there is no application timeout. A first-load failure hides all filter controls and offers groups/WhatsApp, but no in-page catalog retry.
- **Fix:** Add a bounded request timeout and a Reintentar action that restores controls on success. Distinguish user-initiated cancellation from timeout so the timeout reaches the error UI instead of the current aborted early-return branch.
- **If we skip it:** An ordinary weak connection can strand the customer until they reload or leave the catalog.

### 8. The moving information strip has no in-page pause control — accessibility gap

Source: [styles.css:253–264](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/5609afe0db9fec3aee81da5d047a140eba295ca0/site/public/styles.css#L253), [index.html:56](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/5609afe0db9fec3aee81da5d047a140eba295ca0/site/public/index.html#L56).

- **What this is:** Store information scrolls automatically on a 38-second infinite animation.
- **Problem:** There is no page control to stop it. The reduced-motion preference is respected, which is good, but visitors using the normal motion setting have no local pause mechanism; [Pause, Stop, Hide](https://www.w3.org/WAI/WCAG22/Understanding/pause-stop-hide.html) addresses this continuing motion alongside other content.
- **Fix:** Make the strip static after its entrance, or add an accessible pause/resume control that stays paused after focus moves away. Acceptance: both normal and reduced-motion paths remain readable.
- **If we skip it:** Visitors who find continuous movement distracting cannot quiet the page while continuing to shop.

## Should fix

### 9. Finding a specific item does not scale to this catalog — UI improvement

Source: [index.html:62–70](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/5609afe0db9fec3aee81da5d047a140eba295ca0/site/public/index.html#L62), [catalogo.ts:81–101](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/5609afe0db9fec3aee81da5d047a140eba295ca0/app/src/catalogo.ts#L81).

- **What this is:** Customers can select one of 13 category chips and load another 24 items.
- **Problem:** With 1,006 items, an unfiltered full browse needs 42 pages, or 41 Ver más clicks. There is no search by name, brand or code; some mobile categories sit offscreen with their scrollbar hidden.
- **Fix:** Start with one labeled search field backed by the existing API, searching the whole matching catalog rather than only loaded cards. Keep category filters and give the horizontal row a visible continuation cue.
- **If we skip it:** A shopper looking for one known product has to browse repeatedly or ask staff to search for them. This is a product improvement, not an assertion that an existing search feature is broken.

### 10. Mobile navigation favors rewards over browsing — UI improvement

Source: [index.html:35,43–46](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/5609afe0db9fec3aee81da5d047a140eba295ca0/site/public/index.html#L35), [styles.css:296–328](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/5609afe0db9fec3aee81da5d047a140eba295ca0/site/public/styles.css#L296).

- **What this is:** The desktop header links to catalog, clothing, directions and rewards.
- **Problem:** At 375px, only Mis Dolarones remains in the header. The catalog starts around document y=2,018px and the first shortcut is the decorative Ver lo nuevo stamp lower in the hero, so the main browse action is easy to overlook.
- **Fix:** Keep a compact Catálogo link or add Ver catálogo beside the existing hero actions on phones; retain WhatsApp and directions. Acceptance: browsing has an obvious first-screen route at 375px without horizontal overflow.
- **If we skip it:** First-time mobile visitors have a weaker path to merchandise than returning loyalty members do.

### 11. Product photos are cropped without a way to inspect the whole item — UI improvement

Source: [styles.css:109,157–158](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/5609afe0db9fec3aee81da5d047a140eba295ca0/site/public/styles.css#L157), [catalogo.js:96–107](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/5609afe0db9fec3aee81da5d047a140eba295ca0/site/public/catalogo.js#L96).

- **What this is:** Phone photos are displayed inside square cards with object-fit: cover.
- **Problem:** Observed 512×1024 product photos lose half their vertical content in a square crop. Catalog photos are not links or zoom controls, leaving labels, proportions or condition details unavailable to the shopper.
- **Fix:** First use contain for catalog product photos on the existing neutral background; keep the scrapbook card frame. If that is insufficient, add a simple accessible full-image view with an explicit close action and focus return.
- **If we skip it:** The visual design stays attractive but can hide the very product details customers need before asking or visiting.

### 12. The hero downloads a full collage and then hides it under five more photos — measured performance opportunity

Source: [index.html:50–53](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/5609afe0db9fec3aee81da5d047a140eba295ca0/site/public/index.html#L50), [catalogo.js:38–73](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/5609afe0db9fec3aee81da5d047a140eba295ca0/site/public/catalogo.js#L38), [styles.css:105–118](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/5609afe0db9fec3aee81da5d047a140eba295ca0/site/public/styles.css#L105).

- **What this is:** A high-priority static hero is replaced visually once live-product photos finish decoding.
- **Problem:** The downloaded fallback was **263,866 bytes**; the five replacement JPEGs totaled **514,007 bytes**, before fonts or other images. They were 1024px tall but rendered in roughly 163–178px square desktop frames; this is an image-delivery opportunity, not a measured Web Vitals failure.
- **Fix:** Provide card-size thumbnails and a much lighter fallback, or choose one initial hero image path. Measure cold mobile loading before/after and preserve the reliable fallback; the 263,866-byte hidden image is a byte upper bound for that particular avoidable download, not promised total savings.
- **If we skip it:** Cold visits pay for both visual treatments, making the first screen unnecessarily expensive on constrained connections.

### 13. Site behavior checks are outside CI, and existing tests miss the failed-page flow — testing gap

Source: [validate.yml:18–47](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/5609afe0db9fec3aee81da5d047a140eba295ca0/.github/workflows/validate.yml#L18), [check_site_catalogo.cjs](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/5609afe0db9fec3aee81da5d047a140eba295ca0/tools/check_site_catalogo.cjs).

- **What this is:** CI runs the static site validator and app tests; separate scripts check site currency/message helpers and motion.
- **Problem:** Neither site JS script is invoked by the workflow. The catalog script tests formatting and API override rules but never exercises loading, failure, retry, size rendering or changing inventory between pages; all existing checks passed while the reproduced bugs remained.
- **Fix:** Run the two existing scripts in the current Node job and add focused regressions as findings 1–4 and 7 are fixed. A small DOM fixture is sufficient for the retry logic; preserve browser checks for layout/focus.
- **If we skip it:** CI can stay green after a change breaks the actual public shopping interaction.

## Nice to have

### 14. The four clothing prices need a short explanation of what determines the price — UI/content improvement

Source: [index.html:57–60](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/5609afe0db9fec3aee81da5d047a140eba295ca0/site/public/index.html#L57).

- **What this is:** A full section displays $150, $100, $80 and $50 tags and says prices depend on type.
- **Problem:** No caption tells the customer which items belong to which tier. At 375px this section occupies roughly 1,026px of document height before the catalog, while providing four numbers rather than a selection rule.
- **Fix:** Add one short owner-confirmed explanation or category caption per tier, then tighten mobile spacing if the information fits. Do not invent garment-to-price mappings or change confirmed prices to make the design work.
- **If we skip it:** The tags establish the bargain theme but do less to answer a shopper’s practical price question.

## Performance evidence and limits

| Metric | Result | Interpretation |
| --- | --- | --- |
| LCP / CLS / INP | Not measured | No trace-capable DevTools tool or field dataset was available. No Lighthouse score is claimed. |
| Hero image file bodies | 777,873 bytes combined | Downloaded observed assets; excludes compression of other resource types, headers and cache effects. |
| Stylesheet file body | 27,078 bytes | Live file matched source. This is not a large application bundle. |
| Six local font files | 356,484 bytes combined | All six appeared in the resource inventory; file sizes are not a timed network waterfall. Keep the brand faces unless measurements justify a narrower font build. |
| Horizontal layout | No overflow at tested 375 and 1280 widths | Does not certify all widths, browser zoom or mobile browsers. |
| Browser errors | None in the inspected homepage console sample | Does not exclude errors outside the sampled states. |

The site is already simple enough. Do not add a frontend framework, carousel dependency or performance service to fix these issues. Measure real loading before adding caching layers or rebuilding font delivery. The existing single-page catalog is the main interaction to improve.

## Suggested order of work

1. Fix catalog reliability and public data quality: **1, 2, 3, 4, 7**, with regression checks from **13**. Each fix should remain a small, reviewable Issue/PR.
2. Make the existing design accessible: **5, 6, 8**. Verify visually with keyboard navigation and both motion preferences.
3. Improve the mobile shopping path: **9, 10, 11**, then confirm the price explanation for **14**. Preserve the approved visual vocabulary in site/DESIGN.md.
4. Profile cold mobile loading and address **12** with a before/after comparison. Do not use a perceived loading improvement as a substitute for measurements.

No additional dependencies are needed for the first two groups. Search is a scoped product enhancement and needs acceptance criteria; it is not permission for a full commerce rebuild.

## Validation performed

- python tools/validate_assets.py — **27 assets passed**.
- python tools/validate_site.py — **passed**.
- node tools/check_site_catalogo.cjs — **passed**.
- node tools/check_site_motion.cjs — **passed**.
- From app/: node --test src/catalogo.test.ts — **12/12 passed**.
- Appendix reproduction — **passed**, confirming the described current failures in synthetic cases.

The previously reported privacy-email receiving issue remains linked to [infrastructure audit #234](https://github.com/iskaar/El-Dolaron-Social-Kit/pull/234); the address is still printed on the live privacy page. Mail delivery/DNS was not retested in this website audit, and no legal-compliance conclusion is made.

**Verdict:** Keep the visual direction; fix catalog recovery, merchandise clarity and keyboard/contrast access before expanding the page.

**Not checked:** Lighthouse/Core Web Vitals, throttled cold-load timings, load capacity, Safari/Firefox, physical phones, a real screen-reader session, full keyboard coverage, actual WhatsApp delivery or group joining, map routing accuracy, legal compliance, authenticated Dolarones flows, or every item in the catalog. The final attempt to inspect the public Dolarones landing page was not executed: automatic approval review hit a usage limit, not a finding that the action was unsafe. That portal handoff remains unverified. No production settings or customer data were changed.

## Appendix — reproducible source checks

Copy this block into a temporary audit-site.cjs at the repository root and run node audit-site.cjs with Node 24 at the audited commit. The assertions deliberately describe the current bugs; convert them to the corrected expectations when implementing fixes. The small DOM double checks control flow, not browser layout or full D1 behavior.

```javascript
// Save as audit-site.cjs in the repository root; run with Node 24.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const source = fs.readFileSync('site/public/catalogo.js', 'utf8');
class Element {
  constructor() { this.children = []; this.listeners = {}; this.attrs = {}; this.hidden = false; this.textContent = ''; }
  append(...xs) { this.children.push(...xs); }
  prepend(...xs) { this.children.unshift(...xs); }
  replaceChildren(...xs) { this.children = xs; }
  setAttribute(k, v) { this.attrs[k] = v; }
  removeAttribute(k) { delete this.attrs[k]; }
  addEventListener(k, fn) { this.listeners[k] = fn; }
}
function harness(fetcher) {
  const parts = Object.fromEntries(['.chips', '.catalog-grid', '.catalog-status', '.catalog-more', '.catalog-fallback'].map(k => [k, new Element()]));
  const root = new Element();
  root.querySelector = k => parts[k];
  vm.runInNewContext(source, {
    document: { querySelector: () => null, getElementById: () => root, createElement: () => new Element() },
    location: { search: '' }, Image: class extends Element {}, fetch: fetcher,
    AbortController, URL, URLSearchParams, Intl, Number, encodeURIComponent
  });
  return { parts, root };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
(async () => {
  const requested = [];
  const h = harness(async url => {
    const page = Number(new URL(url).searchParams.get('pagina'));
    requested.push(page);
    if (page === 2) throw Error('temporary network failure');
    return { ok: true, json: async () => ({ piezas: [{ nombre: 'Page ' + page, codigo: 'ED-' + page, precio: 10000, talla: 'M' }], total: 72, hay_mas: page < 3 }) };
  });
  await tick();
  h.parts['.catalog-more'].listeners.click(); await tick();
  assert.match(h.parts['.catalog-status'].textContent, /Intenta de nuevo/);
  h.parts['.catalog-more'].listeners.click(); await tick();
  assert.deepEqual(requested, [1, 2, 3]); // Bug: should retry 2.
  const rendered = h.parts['.catalog-grid'].children.map(x => x.children[1].children[0].textContent);
  assert.deepEqual(rendered, ['Page 1', 'Page 3']);
  const cardText = h.parts['.catalog-grid'].children[0].children[1].children.map(x => x.textContent);
  assert.deepEqual(cardText, ['Page 1', '$100', 'Preguntar por WhatsApp']); // Missing M.
  const failed = harness(async () => { throw Error('offline'); }); await tick();
  assert.equal(failed.parts['.chips'].hidden, true);
  assert.equal(failed.parts['.catalog-more'].hidden, true);
  assert.equal(failed.parts['.catalog-fallback'].hidden, false);
  const pending = harness(() => new Promise(() => {})); await tick();
  assert.equal(pending.root.attrs['aria-busy'], 'true');
  assert.equal(pending.parts['.catalog-status'].textContent, 'Cargando piezas…');
  // Only the image-decoding path has a timer; catalog requests have none.
  assert.equal(source.slice(source.indexOf('async function cargar')).includes('setTimeout'), false);
  const db = new DatabaseSync(':memory:');
  db.exec('create table productos (codigo text, nombre text, creado_en text, stock integer)');
  const insert = db.prepare('insert into productos values (?, ?, ?, 1)');
  for (let i = 1; i <= 49; i++) insert.run('ED-' + i, 'Pieza ' + i, String(i).padStart(3, '0'));
  // Same order/offset as catalogo.ts; all fixture rows are otherwise vendible.
  const page2 = () => db.prepare('select codigo from productos where stock > 0 order by creado_en desc, codigo limit 24 offset 24').all();
  assert.equal(page2()[0].codigo, 'ED-25');
  db.prepare('update productos set stock = 0 where codigo = ?').run('ED-49');
  assert.equal(page2()[0].codigo, 'ED-24'); // ED-25 vanished between pages.
  const internal = db.prepare("select (? glob '*[0-9]*' and upper(?) = ?) as hidden");
  assert.equal(internal.get('DAMA 50', 'DAMA 50', 'DAMA 50').hidden, 1);
  assert.equal(internal.get('dama 50', 'dama 50', 'dama 50').hidden, 0);
  db.close();
  function light(hex) {
    const c = hex.match(/../g).map(x => parseInt(x, 16) / 255).map(x => x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4);
    return c[0] * .2126 + c[1] * .7152 + c[2] * .0722;
  }
  const contrast = (a, b) => (Math.max(light(a), light(b)) + .05) / (Math.min(light(a), light(b)) + .05);
  const ratios = ['FFD447', 'EDE6D3', 'F3E6BF'].map(bg => contrast('D72B32', bg));
  assert.ok(ratios.every(x => x < 4.5));
  console.log({ requested, rendered, missingSize: cardText, contrast: ratios.map(x => x.toFixed(2)) });
  console.log('Reproduced current defects; these assertions describe bugs, not acceptance tests for fixes.');
})().catch(error => { console.error(error); process.exitCode = 1; });
```
