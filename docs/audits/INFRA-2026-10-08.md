What this repo does: El Dolarón runs store checkout, inventory capture, customer rewards and a public catalog on Cloudflare Workers, D1 and R2. It also contains a static storefront and the social kit. This audit assumes a small store with several staff devices and simultaneous checkout, capture and label requests; Mercado Libre integrations can overlap those requests.

Audit date: 2026-10-08 UTC. Issue: [#233](https://github.com/iskaar/El-Dolaron-Social-Kit/issues/233). Source baseline: `2a1bd041837cd0404a5ede0de206b40f1ba49c1a`, verified against GitHub main. Production Worker version observed: `45ecb338-d6e5-4148-887f-c7fe9f241e65`. Selected vulnerable functions were also checked in the deployed bundle. This is a findings report only: no application fixes or production changes were made.

Result: **15 bugs and one release-control gap**. Thirteen isolated failure cases were reproduced with synthetic data. P1 means inventory integrity, administrative lockout, external selling, or a destructive refresh failure; P2 means a narrower operational/configuration defect. A confirmed code defect does not mean that its triggering incident has already happened in production.

**Must fix**

1. **[P1] Editing a name or price can restore stock already sold**

[app/src/worker.ts:217-232](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/2a1bd041837cd0404a5ede0de206b40f1ba49c1a/app/src/worker.ts#L217-L232); [app/src/worker.ts:279-285](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/2a1bd041837cd0404a5ede0de206b40f1ba49c1a/app/src/worker.ts#L279-L285)

**What this is:** Product edits read the whole record and later write it back.

**Problem:** An edit that does not include stock still writes the stock value read earlier. The local test read 50, simulated a sale reducing it to 49, then renamed the product; stock returned to 50.

**Fix:** Leave stock untouched when the request omits it. When explicitly changing stock, reject stale versions or apply a guarded adjustment.

**If we skip it:** The store can sell inventory that no longer exists.

**Evidence:** Local reproduction; the same read/write pattern is present in the deployed production bundle.

2. **[P1] Retrying a photo upload resets inventory and restarts analysis**

[app/src/worker.ts:150-175](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/2a1bd041837cd0404a5ede0de206b40f1ba49c1a/app/src/worker.ts#L150-L175)

**What this is:** The capture client retries an upload using the same product ID.

**Problem:** The conflict handler overwrites stock with the original captured quantity instead of returning the existing result. After an upload succeeds but its response is lost, a delayed retry can undo a sale or an inventory correction; 49 became 50 in the local test.

**Fix:** Make retries of an accepted upload a no-op. Give intentional photo replacement its own explicitly validated operation.

**If we skip it:** A routine network retry changes real stock, replaces the photo, and can overwrite reviewed names and prices through another analysis.

**Evidence:** Local multipart request against the Worker; no real AI request was sent.

3. **[P1] Two simultaneous merges count the same source inventory twice**

[app/src/worker.ts:416-443](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/2a1bd041837cd0404a5ede0de206b40f1ba49c1a/app/src/worker.ts#L416-L443)

**What this is:** Merging duplicate products deletes the source and adds its quantity to the destination.

**Problem:** Two requests can both read the source before either deletes it. Each then adds the previously read quantity even when its DELETE changes no row: merging 3 into 50 twice returned success twice and produced 56, not 53.

**Fix:** Guard and perform the transfer using the source row inside the transaction, and abort unless that source is consumed exactly once. Keep the stock limit inside the same guard.

**If we skip it:** Inventory increases without receiving merchandise.

**Evidence:** Local concurrent Worker requests; vulnerable flow also confirmed in production code.

4. **[P1] Concurrent label requests replace an already-issued barcode**

[app/src/worker.ts:382-399](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/2a1bd041837cd0404a5ede0de206b40f1ba49c1a/app/src/worker.ts#L382-L399)

**What this is:** The label endpoint assigns codes to products that do not have one.

**Problem:** The initial read checks for an empty code, but the later UPDATE does not. Delaying one request while another finishes produced a label for ED-000163, then changed that product to ED-000164.

**Fix:** Repeat the empty-code condition in the UPDATE and return the code actually stored.

**If we skip it:** A label already printed on merchandise no longer resolves in checkout.

**Evidence:** Local controlled interleaving of two requests; matching deployed code.

5. **[P1] Concurrent account edits can remove every owner**

[app/src/cuentas.ts:309-314](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/2a1bd041837cd0404a5ede0de206b40f1ba49c1a/app/src/cuentas.ts#L309-L314); [app/src/cuentas.ts:336-350](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/2a1bd041837cd0404a5ede0de206b40f1ba49c1a/app/src/cuentas.ts#L336-L350)

**What this is:** Account management is supposed to preserve at least one active owner.

**Problem:** The owner-count check runs before the write transaction. With two owners, simultaneous requests to remove each owner's role both saw another owner, both returned 200, and left zero owners.

**Fix:** Enforce the last-owner condition atomically with the account mutation, for example with a database constraint/trigger covering role changes and deactivation.

**If we skip it:** No account can manage users or approvals; recovery needs direct database administration.

**Evidence:** Local concurrent API reproduction; matching deployed pre-check.

6. **[P1] Deleting or merging a published product leaves its Mercado Libre listing unmanaged**

[app/src/worker.ts:433-451](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/2a1bd041837cd0404a5ede0de206b40f1ba49c1a/app/src/worker.ts#L433-L451); [app/src/mercadolibre.ts:914-918](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/2a1bd041837cd0404a5ede0de206b40f1ba49c1a/app/src/mercadolibre.ts#L914-L918)

**What this is:** Product deletion and listing reconciliation operate on separate tables.

**Problem:** Deletion removes the product but retains its listing. Reconciliation uses an inner join to existing products, so the listing disappears from every future reconciliation run; the reproduction left an active listing and made zero external update calls.

**Fix:** Reject deletion/merge while a live external listing exists, until it is closed or deliberately transferred. Also reconcile already-orphaned listing records.

**If we skip it:** An external listing can keep accepting orders after the corresponding local inventory has been removed.

**Evidence:** Local deletion plus mocked reconciliation. Production had zero ML listings during inspection, so this is a pre-use integration defect, not an observed oversale.

7. **[P1] Listing reconciliation can put sold units back on Mercado Libre**

[app/src/mercadolibre.ts:932-951](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/2a1bd041837cd0404a5ede0de206b40f1ba49c1a/app/src/mercadolibre.ts#L932-L951); [app/src/mercadolibre.ts:1057-1065](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/2a1bd041837cd0404a5ede0de206b40f1ba49c1a/app/src/mercadolibre.ts#L1057-L1065)

**What this is:** Item notifications synchronize the external quantity from the local database.

**Problem:** An item notification can arrive before the corresponding order is imported. With two local units and one remaining on ML after a purchase, reconciliation increased ML back to two; stale concurrent reconciliation snapshots have the same problem.

**Fix:** Do not increase external availability from an item notification using an unreconciled snapshot. Import outstanding orders and serialize or version-check any stock-increasing reconciliation.

**If we skip it:** The same unit can be offered for sale again before the original order reaches local stock.

**Evidence:** Local D1 fixture and mocked ML responses reproduced 1 → 2 external stock; no real listing was changed.

8. **[P1] Failed notifications for older orders are never recovered**

[app/src/mercadolibre.ts:1031-1047](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/2a1bd041837cd0404a5ede0de206b40f1ba49c1a/app/src/mercadolibre.ts#L1031-L1047); [app/src/mercadolibre.ts:1052-1089](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/2a1bd041837cd0404a5ede0de206b40f1ba49c1a/app/src/mercadolibre.ts#L1052-L1089)

**What this is:** Webhooks return success before background processing; the cron is their recovery path.

**Problem:** A processing failure is stored but never retried. The cron searches only orders created in the last 24 hours, so a cancellation today of an order created two days ago is permanently missed if its one background attempt fails.

**Fix:** Retry pending/failed notification records from the existing cron, with bounded batches and idempotent handlers. Use update-time recovery where the upstream API supports it.

**If we skip it:** Cancelled orders retain their stock deduction and inventory stays wrong.

**Evidence:** Local test preserved the failed notification and deducted sale after cron; cron did not fetch the old order.

9. **[P1] Sandbox refresh fails once an opening prize has a customer**

[tools/refrescar_sandbox.py:26-27](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/2a1bd041837cd0404a5ede0de206b40f1ba49c1a/tools/refrescar_sandbox.py#L26-L27); [tools/refrescar_sandbox.py:71-78](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/2a1bd041837cd0404a5ede0de206b40f1ba49c1a/tools/refrescar_sandbox.py#L71-L78); [app/migracion-016-portal.sql:9-15](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/2a1bd041837cd0404a5ede0de206b40f1ba49c1a/app/migracion-016-portal.sql#L9-L15)

**What this is:** The refresh script excludes customers, imports other production data, then clears copied customer references.

**Problem:** It copies premios_apertura with a foreign key to customers that were excluded. Import fails before the later UPDATE can clear that reference, after the sandbox has already been emptied.

**Fix:** Sanitize the prize references before importing those rows, or exclude and rebuild the fixed prize pool. Validate the sanitized import before deleting the existing sandbox data.

**If we skip it:** The first real assigned prize can turn the documented refresh command into a failed sandbox rebuild.

**Evidence:** Synthetic SQLite reproduction with foreign keys enabled; production schema confirms the constraint. There were zero assigned prizes at inspection, so the trigger condition was not yet present.

10. **[P2] Photo analysis can be terminated while the product remains pending**

[app/src/worker.ts:174-177](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/2a1bd041837cd0404a5ede0de206b40f1ba49c1a/app/src/worker.ts#L174-L177); [app/src/analisis.ts:186-202](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/2a1bd041837cd0404a5ede0de206b40f1ba49c1a/app/src/analisis.ts#L186-L202); [app/src/analisis.ts:279-317](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/2a1bd041837cd0404a5ede0de206b40f1ba49c1a/app/src/analisis.ts#L279-L317)

**What this is:** AI analysis runs after the upload response through ctx.waitUntil().

**Problem:** HTTP background execution has a 30-second lifetime, but the Anthropic client uses its default 600,000 ms timeout and retries, while Gemini fetch has no explicit deadline. A slow request can be killed before either success or catch updates the row; no scheduled recovery handles pending analysis.

**Fix:** Set a total analysis deadline comfortably below the background limit, limit retries, and write an error before the deadline. Recover stale pending rows with bounded work in the existing scheduled path if needed.

**If we skip it:** Photos remain stuck in pending and retries can repeat paid work.

**Evidence:** Source/deployed-code inspection plus installed SDK timeout and documented Workers lifecycle. No deliberate production timeout or paid model call; the inspected aggregate found zero old pending rows.

11. **[P2] The borrowed-instance configuration cannot deploy the current application correctly**

[app/wrangler.prestado.jsonc:20-27](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/2a1bd041837cd0404a5ede0de206b40f1ba49c1a/app/wrangler.prestado.jsonc#L20-L27); [app/src/cuentas.ts:216-222](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/2a1bd041837cd0404a5ede0de206b40f1ba49c1a/app/src/cuentas.ts#L216-L222); [app/src/worker.ts:1529-1534](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/2a1bd041837cd0404a5ede0de206b40f1ba49c1a/app/src/worker.ts#L1529-L1534); [app/src/worker.ts:1765-1767](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/2a1bd041837cd0404a5ede0de206b40f1ba49c1a/app/src/worker.ts#L1765-L1767)

**What this is:** The borrowed instance points at the same current Worker entry point.

**Problem:** Its config provides no Access team/audience mapping, no ASSETS binding, and no run_worker_first setting. Deploying current main with it makes API authentication return 401 even behind Access, and authenticated static routing lacks the binding the Worker now expects.

**Fix:** Bring this existing environment's config into line with the shared entry point: its own Access audience, ASSETS binding, Worker-first routing, and explicit disabled public preview endpoints.

**If we skip it:** The next routine redeployment breaks the borrowed scanner. This is an upgrade/configuration defect; its currently deployed September 14 bundle was not declared broken.

**Evidence:** Config inspection, live binding names, and local current-Worker request returning 401 without the omitted Access settings.

12. **[P2] Sandbox refresh carries live production cashier sessions into sandbox**

[tools/refrescar_sandbox.py:26-27](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/2a1bd041837cd0404a5ede0de206b40f1ba49c1a/tools/refrescar_sandbox.py#L26-L27); [tools/refrescar_sandbox.py:47-59](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/2a1bd041837cd0404a5ede0de206b40f1ba49c1a/tools/refrescar_sandbox.py#L47-L59); [app/src/cajeros.ts:29-37](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/2a1bd041837cd0404a5ede0de206b40f1ba49c1a/app/src/cajeros.ts#L29-L37)

**What this is:** The refresh copies every application table except a short denylist.

**Problem:** sesiones_cajero is not excluded, so the same live session hash is installed in both databases. A synthetic production session was accepted in both environments; resetting or revoking it in sandbox does not revoke its production copy.

**Fix:** Exclude cashier sessions and other transient authentication state from refresh. Explicitly classify the new ML account/OAuth tables too, rather than automatically copying new tables.

**If we skip it:** Environment separation does not extend to cashier sessions. This requires a still-valid production token and the normal Access gate; it is not an anonymous Access bypass.

**Evidence:** Local authentication reproduction with identical copied session rows. The live aggregate showed zero active cashier sessions at inspection.

13. **[P2] A first visit does not prepare checkout for an offline reload**

[app/public/caja.html:145](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/2a1bd041837cd0404a5ede0de206b40f1ba49c1a/app/public/caja.html#L145); [app/public/sw-caja.js:16-22](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/2a1bd041837cd0404a5ede0de206b40f1ba49c1a/app/public/sw-caja.js#L16-L22); [app/public/sw-caja.js:25-39](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/2a1bd041837cd0404a5ede0de206b40f1ba49c1a/app/public/sw-caja.js#L25-L39)

**What this is:** The new service worker promises that checkout can reload without a network.

**Problem:** Install and activation neither cache the checkout page nor warm its scripts. The initial navigation occurred before the new worker controlled the page; if the next navigation is offline, its fallback cache has no /caja entry.

**Fix:** Warm the allowed shell resources after authenticated activation, or explicitly load them after control is acquired. Only report offline readiness once the shell is stored.

**If we skip it:** A freshly opened register can work online all day and still fail at its first offline reload unless it had a subsequent controlled online navigation.

**Evidence:** Local service-worker lifecycle simulation: install/activate left the cache empty and offline /caja rejected. Physical/browser acceptance testing is still needed.

14. **[P2] The database setup commands do not initialize a usable application database**

[app/package.json:11-12](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/2a1bd041837cd0404a5ede0de206b40f1ba49c1a/app/package.json#L11-L12); [app/schema.sql:60-68](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/2a1bd041837cd0404a5ede0de206b40f1ba49c1a/app/schema.sql#L60-L68); [app/src/cuentas.ts:230-235](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/2a1bd041837cd0404a5ede0de206b40f1ba49c1a/app/src/cuentas.ts#L230-L235)

**What this is:** db:local and db:remote run only schema.sql.

**Problem:** That file lacks required migrated fields and tables. A fresh database initialized exactly that way cannot even execute the authenticated user lookup: usuarios.caja is missing; tests hide this because their fixture separately applies every migration.

**Fix:** Provide a documented fresh-database sequence including all migrations, and make the setup command use it or clearly identify itself as base-schema-only. Do not blindly rerun ALTER migrations on an existing database.

**If we skip it:** A new environment or recovery built from the advertised setup commands fails on ordinary requests.

**Evidence:** Local schema-only database rejected the exact authentication SELECT. Existing fully migrated databases are not claimed to be broken.

15. **[P2] The published privacy email has no receiving mail infrastructure**

[app/src/legal.ts:113](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/2a1bd041837cd0404a5ede0de206b40f1ba49c1a/app/src/legal.ts#L113)

**What this is:** The application publishes privacidad@eldolaron.com as a contact channel.

**Problem:** The live Cloudflare DNS list for eldolaron.com contained only three proxied web AAAA records and no MX record or mail host. The apex is a Worker web endpoint, so the implicit mail fallback is not a configured receiving mail server.

**Fix:** Configure the existing domain's intended receiving mailbox/routing and its DNS, then test delivery; alternatively publish an already-working confirmed address.

**If we skip it:** Customers who choose the published email channel cannot reliably deliver their request.

**Evidence:** Read-only authoritative-zone configuration inspection. No test email was sent; this is an infrastructure finding, not a legal assessment.

**Should fix**

16. **[P2] Required review and green CI are not enforced on main**

[README.md:31-39](https://github.com/iskaar/El-Dolaron-Social-Kit/blob/2a1bd041837cd0404a5ede0de206b40f1ba49c1a/README.md#L31-L39)

**What this is:** The repository's operating contract requires review and passing CI before merging.

**Problem:** GitHub reported main.protected=false with required status checks disabled, and the repository rulesets list was empty. A user with write access can push or merge without satisfying the stated release gates.

**Fix:** Enable a main-branch rule requiring pull requests, review, and the existing required check names. No new automation is necessary.

**If we skip it:** An unreviewed or failing change can reach the publishable branch.

**Evidence:** Read-only GitHub branch and ruleset API responses. This is a release-control gap, not an observed bad merge.

**Validation and boundaries**

- `python tools/validate_assets.py`: passed, 27 assets.
- `python tools/validate_site.py`: passed.
- Existing Node 24 test suite: 383 passed, zero failures.
- TypeScript `tsc --noEmit`: passed.
- Thirteen additional local failure reproductions: confirmed. These assert that the reported broken behavior exists; they are not assertions that the app is correct.
- Tests used an isolated snapshot of the exact audited commit and the already-installed dependencies. The initial snapshot run lacked its dependency path; rerunning with the existing node_modules resolved that environment issue. No dependencies were added.
- Live checks were GETs and read-only aggregate/schema SQL. No products, customers, sessions, listings, DNS, Access settings or deployments were changed.
- Production aggregates: 1,094 inventory product records; zero ML listings, assigned opening prizes, active cashier sessions, or old pending analyses under the inspected query. Therefore ML and refresh scenarios are reproducible defects with conditional future impact, not claims of existing customer incidents.
- Production/sandbox D1 and R2 resources are separate. The three inspected photo buckets have public r2.dev access disabled and no public custom domains. Production/sandbox/borrowed workers.dev and preview endpoints are disabled in the live account.
- The sandbox deployment is from October 5 and production from October 8. Sandbox acceptance alone is not evidence for all current production behavior.
- The error-log query returned no events for the selected window/filter. This does not establish that the application had no errors.

**Platform evidence**

The background analysis finding uses Cloudflare's documented [HTTP waitUntil lifecycle](https://developers.cloudflare.com/workers/runtime-apis/context/), which permits up to 30 seconds after the response. The sandbox import finding uses [D1 foreign-key enforcement](https://developers.cloudflare.com/d1/sql-api/foreign-keys/): deferral does not make missing references valid at the end of a transaction. The installed Anthropic SDK sets its default timeout to 600,000 ms; the application does not override it.

Live metadata was read from Cloudflare Workers settings/subdomain/schedules/deployments, custom domains, Access applications, R2 domain settings, and the eldolaron.com DNS record list. Release-gate evidence came from GitHub `GET /repos/iskaar/El-Dolaron-Social-Kit/branches/main` and `GET /repos/iskaar/El-Dolaron-Social-Kit/rulesets`.

**Reproducing the isolated checks**

Use an isolated checkout of the baseline, Node 24, and the project's installed dependencies. Save the appendix below as `app/audit-repro.mjs`, then run `node audit-repro.mjs` from `app/`. It uses the existing in-memory SQLite/R2 fixture and mock external responses, not production credentials. The cases intentionally demonstrate defective behavior; after fixing a finding, its corresponding assertion should be replaced with an assertion of the correct result.

Verdict: Fix stock mutation races, barcode stability and owner preservation first; fix ML synchronization before publishing real listings. Make sandbox refresh safe before it is used after real reward allocation.

Not checked: real USB/Bluetooth printers or scanners, a physical offline browser acceptance run, Firebase project/SMS-console settings, paid AI behavior, real Mercado Libre credentials/orders, mailbox delivery, backup restoration, dependency CVEs, every frontend interaction, or load/stress testing. This audit does not guarantee that no other bugs exist. Proposed fixes remain unapplied.

**Appendix: synthetic reproductions**

```javascript
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import worker from './src/worker.ts';
import { tienda, DUENO, PRODUCTO } from './src/prueba-d1.ts';
import { cajeroEnTurno } from './src/cajeros.ts';
import { guardarTokens, conciliarPublicaciones, sincronizar } from './src/mercadolibre.ts';
const checks=[];
const check=async(name,fn)=>{await fn();checks.push(name);console.log('CONFIRMED: '+name)};
const stock=t=>t.db.prepare('select stock from productos where id=?').get(PRODUCTO).stock;
await check('PATCH of name resurrects stock sold during request',async()=>{
 const t=tienda(); t.db.prepare('update productos set precio_lista=50000 where id=?').run(PRODUCTO);
 const prep=t.env.DB.prepare.bind(t.env.DB); let injected=false;
 t.env.DB.prepare=sql=>{const s=prep(sql); if(sql.startsWith('select nombre, categoria, marca, talla, precio_lista')){const first=s.first.bind(s);s.first=async()=>{const row=await first(); t.db.prepare('update productos set stock=stock-1 where id=?').run(PRODUCTO);injected=true;return row;}}return s;};
 const r=await t.pedir('/api/borradores/'+PRODUCTO,{nombre:'Renamed'},'PATCH');assert.equal(r.status,200);assert.ok(injected);assert.equal(stock(t),50);console.log('Stock: 50 -> concurrent sale 49 -> rename 50');
});
await check('photo upload retry resets inventory',async()=>{
 const t=tienda();t.db.prepare('update productos set stock=49 where id=?').run(PRODUCTO);t.env.MODELO_ANALISIS='gemini';
 const form=new FormData();form.append('id',PRODUCTO);form.append('cantidad','50');form.append('foto',new Blob(['synthetic']), 'photo.jpg');
 const r=await worker.fetch(new Request('https://caja.prueba/api/borradores',{method:'POST',body:form}),t.env,t.ctx);await t.esperar();assert.equal(r.status,201);assert.equal(stock(t),50);
});
await check('concurrent merge counts source stock twice',async()=>{
 const t=tienda();const id=crypto.randomUUID();t.db.prepare('insert into productos(id,nombre,stock,semana_ingreso,creado_en,actualizado_en) values(?,?,3,?,?,?)').run(id,'duplicate','S40','','');
 const rs=await Promise.all([t.pedir('/api/borradores/'+id+'/fusionar',{destino_id:PRODUCTO}),t.pedir('/api/borradores/'+id+'/fusionar',{destino_id:PRODUCTO})]);assert.deepEqual(rs.map(r=>r.status),[200,200]);assert.equal(stock(t),56);console.log('Expected 53, got '+stock(t));
});
await check('concurrent label preparation replaces an issued barcode',async()=>{
 const t=tienda();t.db.prepare('update productos set codigo=null where id=?').run(PRODUCTO);
 let release,signal;const gate=new Promise(r=>release=r),read=new Promise(r=>signal=r);let blocked=false;const prep=t.env.DB.prepare.bind(t.env.DB);
 t.env.DB.prepare=sql=>{const s=prep(sql);if(sql.startsWith('select id from productos where id in')&&!blocked){blocked=true;const all=s.all.bind(s);s.all=async()=>{const rows=await all();signal();await gate;return rows;};}return s;};
 const a=t.pedir('/api/etiquetas',{ids:[PRODUCTO]});await read;const b=await t.pedir('/api/etiquetas',{ids:[PRODUCTO]});const printed=b.cuerpo[0].codigo;release();await a;const final=t.db.prepare('select codigo from productos where id=?').get(PRODUCTO).codigo;assert.notEqual(printed,final);console.log({printed,final});
});
await check('sandbox import fails before clearing customer references',async()=>{
 const t=tienda(); t.db.exec('pragma foreign_keys=on');
 assert.throws(()=>t.db.prepare("update premios_apertura set cliente_id='customer-not-copied',lote_id='lot' where canal='online' and orden=1").run(),/FOREIGN KEY/);
});
await check('copied cashier sessions work in both environments',async()=>{
 const a=tienda(),b=tienda();const token='synthetic-audit-session';const hash=Buffer.from(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))).toString('hex');const expires=new Date(Date.now()+60000).toISOString();
 for(const t of [a,b]) t.db.prepare('insert into sesiones_cajero values(?,?,?,?)').run(hash,DUENO,new Date().toISOString(),expires);
 const r=new Request('https://caja.prueba/api/ventas',{headers:{'x-cajero':token}});assert.ok(await cajeroEnTurno(r,a.env));assert.ok(await cajeroEnTurno(r,b.env));
});
const setupML=async()=>{const t=tienda();t.env.ML_LLAVE_TOKENS=Buffer.alloc(32,1).toString('base64');await guardarTokens(t.env,{access_token:'synthetic-access',refresh_token:'synthetic-refresh',expires_in:3600,user_id:555});t.db.prepare('insert into ml_publicaciones(producto_id,ml_item_id,estado,actualizado_en) values(?,?,?,?)').run(PRODUCTO,'MLM123','activa','');return t;};
await check('deleting a published product removes it from reconciliation',async()=>{
 const t=await setupML();let calls=0;const original=globalThis.fetch;globalThis.fetch=async()=>{calls++;throw Error('unexpected network');};try{
 const r=await t.pedir('/api/borradores/'+PRODUCTO,{},'DELETE');assert.equal(r.status,200);await conciliarPublicaciones(t.env);assert.equal(calls,0);assert.equal(t.db.prepare('select estado from ml_publicaciones where producto_id=?').get(PRODUCTO).estado,'activa');
 }finally{globalThis.fetch=original;}
});
await check('item reconciliation restores ML stock before order is imported',async()=>{
 const t=await setupML();t.db.prepare('update productos set stock=2 where id=?').run(PRODUCTO);let remote=1;const original=globalThis.fetch;
 globalThis.fetch=async(url,init={})=>{if(init.method==='PUT'){remote=JSON.parse(init.body).available_quantity;return Response.json({});}return Response.json([{code:200,body:{id:'MLM123',status:'active',available_quantity:remote}}]);};
 try{await conciliarPublicaciones(t.env);assert.equal(remote,2);console.log('ML stock after one sale: 1 -> reconciliation 2');}finally{globalThis.fetch=original;}
});
await check('new service worker activation leaves offline shell cache empty',async()=>{
 const handlers={},store=new Map();const sandbox={URL,self:{location:{origin:'https://caja.prueba'},addEventListener:(n,f)=>handlers[n]=f,skipWaiting:async()=>{},clients:{claim:async()=>{}}},caches:{keys:async()=>[],delete:async()=>{},match:async k=>store.get(k),open:async()=>({put:async(k,v)=>store.set(k,v)})},fetch:async()=>{throw Error('offline')}};
 vm.runInNewContext(readFileSync('public/sw-caja.js','utf8'),sandbox);let pending;handlers.install({waitUntil:p=>pending=p});await pending;handlers.activate({waitUntil:p=>pending=p});await pending;assert.equal(store.size,0);let response;handlers.fetch({request:{method:'GET',url:'https://caja.prueba/caja'},respondWith:p=>response=p});await assert.rejects(response,/offline/);
});
await check('schema-only bootstrap lacks columns read by authentication',async()=>{
 const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(':memory:');db.exec(readFileSync('schema.sql','utf8'));assert.throws(()=>db.prepare('select correo,nombre,roles,activo,caja from usuarios'),/no such column: caja/);
});


await check('concurrent owner removals leave no active owner',async()=>{
 const t=tienda();const second='owner2@prueba.mx';t.db.prepare('insert into usuarios(correo,nombre,roles,activo,creado_en,actualizado_en) values(?,?,?,1,?,?)').run(second,'Owner 2','dueno','','');
 const rs=await Promise.all([t.pedir('/api/cuentas',{correo:DUENO,nombre:'Owner 1',roles:['capturista'],activo:true},'PUT'),t.pedir('/api/cuentas',{correo:second,nombre:'Owner 2',roles:['capturista'],activo:true},'PUT')]);
 assert.deepEqual(rs.map(r=>r.status),[200,200]);assert.equal(t.db.prepare("select count(*) n from usuarios where activo=1 and roles like '%dueno%'").get().n,0);
});
await check('borrowed deployment settings reject authenticated application API',async()=>{
 const t=tienda();delete t.env.ACCESS_EQUIPO;delete t.env.DEV_USUARIO;t.env.ASSETS=undefined;const r=await t.pedir('/api/config');assert.equal(r.status,401);
});

await check('cron does not retry failed notifications for older orders',async()=>{
 const t=await setupML();t.db.prepare('insert into ml_ventas(order_id,ml_item_id,producto_id,cantidad,estado,descontado,recibido_en) values(?,?,?,?,?,?,?)').run('123','MLM123',PRODUCTO,1,'descontada',1,new Date(Date.now()-2*86400000).toISOString());
 t.db.prepare('insert into ml_notificaciones(topic,resource,recibido_en,procesado_en,error) values(?,?,?,?,?)').run('orders_v2','/orders/123',new Date().toISOString(),new Date().toISOString(),'temporary upstream failure');
 const calls=[],original=globalThis.fetch;globalThis.fetch=async(url)=>{calls.push(String(url));return Response.json(String(url).includes('/orders/search')?{results:[]}:[]);};
 try{await sincronizar(t.env);assert.equal(t.db.prepare("select estado from ml_ventas where order_id='123'").get().estado,'descontada');assert.ok(calls.some(u=>u.includes('order.date_created.from=')));assert.ok(!calls.some(u=>u.endsWith('/orders/123')));}finally{globalThis.fetch=original;}
});
console.log('Verified '+checks.length+' independent failure cases. No production writes or external API calls.');
```
