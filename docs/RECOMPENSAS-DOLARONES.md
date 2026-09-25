# El Dolarón — Sistema de recompensas y Dolarones

Fecha del registro: 24 de septiembre de 2026. Moneda: pesos mexicanos (MXN). Zona horaria del negocio: America/Mexico_City.

Este documento conserva la investigación y el diseño del sistema de recompensas de El Dolarón (mecánicas de videojuegos aplicadas a la tienda, Dolarones, regalo de apertura, premios y tabla de posiciones). Es la referencia para cualquier agente (Claude, ChatGPT/Codex, Agy u otro). La versión de trabajo original vive en un documento privado de Claude; **este archivo es la copia compartida**: si una decisión cambia, actualízala aquí mediante Issue y PR.

**Estado:** propuesta con decisiones del propietario. Nada de esto está implementado todavía en la caja (`app/`), ni publicado a clientes. No anunciar reglas, montos o fechas sin confirmación de Isaac.

## 1. Cómo retomar este trabajo

- Leer primero la sección 2 (decisiones confirmadas) y la sección 3 (pendientes). No volver a preguntar lo que ya está decidido.
- El propietario prefiere responder preguntas numeradas en un solo mensaje de texto.
- Regla de diseño central: **aleatorizar el descubrimiento, nunca el pago.** Nada de premios decididos por azar sin permiso de SEGOB (ver sección 4).
- El contenido detallado (secciones 5 y 6) está en inglés, tal como se redactó; las decisiones de las secciones 2–4 prevalecen si hay contradicción.

## 2. Decisiones confirmadas por el propietario

| Tema | Decisión |
| --- | --- |
| Día de Descarga (resurtido) | Martes, **tentativo** |
| Dolarones: valor | 1 Dolarón = $1 MXN |
| Dolarones: uso | Funcionan como dinero dentro de la tienda (cualquier producto) y también para premios de la vitrina |
| Dolarones: acumulación | 10 Dolarones por cada $100 de compra (10%) |
| Bono por visita | Compra mínima de $99 |
| Vigencia | 12 meses desde que se ganan |
| Hora Dorada | Sí, si la dinámica es atractiva: 60 min antes de abrir el día de descarga, primeros en ver abrir las cajas, máximo 5 pases |
| Rebaja semanal | Baja una banda de precio a las 3 semanas; a Bolsa Sorpresa a las 6 semanas (propuesta aceptada como sugerencia) |
| Regalo de apertura | $15,000 en Dolarones para los primeros 100 registrados, escalonado (tabla abajo); gastables en cualquier producto |
| Respaldo sin caja digital | Vales de papel numerados ("dinero físico" de la tienda) |
| Costo de mercancía | **Desconocido.** El 45–50% que mencionó Isaac es el descuento frente al precio de referencia en EE. UU. (Walmart, Target, JCPenney), no su costo. Registrar el costo de cada pallet queda para después |

### Regalo de apertura: reparto propuesto ($15,000 exactos)

| Orden de registro | Personas | Dolarones c/u | Subtotal |
| --- | --- | --- | --- |
| #1 | 1 | 500 | 500 |
| #2–11 | 10 | 300 | 3,000 |
| #12–24 | 13 | 200 | 2,600 |
| #25–50 | 26 | 150 | 3,900 |
| #51–100 | 50 | 100 | 5,000 |
| **Total** | **100** | | **15,000** |

Reglas propuestas: canje el día 1; lo no canjeado pasa **a la lista de espera en orden de registro** (#101, #102…) para el día 2; lo no canjeado el día 2 se pierde.

**Cambio respecto a la idea original:** Isaac propuso pasar lo no canjeado a un usuario **al azar**. Eso convierte la promoción en sorteo (requiere permiso de SEGOB). Se sustituyó por la lista de espera en orden. No revertir sin permiso.

## 3. Pendientes

1. Cómo se registran los clientes para el regalo de apertura: WhatsApp, formulario web o en tienda.
2. Qué artículos de pallet van en la primera Vitrina de Premios.
3. Premios por posición de la temporada 1 (propuesta: TV, Minuto Loco, electrodoméstico chico).
4. Si los revendedores compran lo suficiente como para tener su propia tabla ("Mayoreo").
5. Más adelante: registrar el costo total de cada pallet (precio, envío, importación, comisiones) para calcular el costo real del 10%.
6. Confirmar el martes como Día de Descarga.
7. Revisión legal/contable antes de lanzar (sección 4).

## 4. Puntos legales y fiscales (resumen; no es asesoría legal)

- **Promociones** (Dolarones, niveles, misiones, Hora Dorada, regalo de apertura por orden de registro): no requieren autorización ([LFPC art. 47](https://leyes-mx.com/ley_federal_de_proteccion_al_consumidor/47.htm)), pero deben publicar condiciones y vigencia o volumen, y respetarlas ([art. 48](https://leyes-mx.com/ley_federal_de_proteccion_al_consumidor/48.htm)).
- **Todo premio decidido por azar es sorteo** y requiere permiso por escrito de SEGOB ([Reglamento de la Ley Federal de Juegos y Sorteos](https://www.ordenjuridico.gob.mx/Documentos/Federal/html/wo88470.html), art. 7), **aunque no se pague con dinero**: el "sorteo sin venta de boletos" también requiere permiso (art. 3, fracc. XXIV; [trámite SGOB-01-009-A](https://catalogonacional.gob.mx/FichaTramite?traHomoclave=SGOB-01-009-A): solicitar ~3 meses antes, garantía de premios, vigencia 1 año). Por lo tanto: nada de rifas pagadas con Dolarones, desempates al azar, ruletas ni "rasca y gana" sin permiso.
- **Premios de alto valor** (p. ej. la TV del 1er lugar): [LISR art. 137](https://leyes-mx.com/ley_del_impuesto_sobre_la_renta/137.htm) considera ingreso por premios los de "concursos de toda clase"; confirmar con el contador si aplica retención.
- **Datos personales:** aviso de privacidad antes de guardar teléfonos; alias en la tabla solo con autorización del cliente.
- **Contabilidad:** los Dolarones no canjeados son un pasivo; definir con el contador cómo facturar ventas pagadas con Dolarones (descuento o forma de pago).
- **Vales de papel:** no deben parecerse a billetes: "vale canjeable solo en El Dolarón, no canjeable por efectivo", otro tamaño y colores, folio, nombre del titular y vigencia.

---

## 5. Research and program design (main plan)

### Bottom line

El Dolarón already owns the most powerful hook in game design: an unpredictable reward that shows up on a schedule. Every closed pallet is a loot box — for the owner. The job is to hand that feeling to the customer without charging them for a gamble.

The research points to one design rule: **randomize the discovery, never the payment.** Games make money when players pay for a chance; that is the part tied to problem gambling and, in Mexico, the part that needs a SEGOB permit. The rest of the game toolkit — progress bars, streaks, levels, collections, early access, surprise gifts — is legal as an ordinary promotion and works in physical retail.

Program pieces: Día de Descarga (fixed weekly drop), Dolarones (replaces the original stamp card), seasonal levels with Hora Dorada, missions and weekly streak, Bolsa Sorpresa (fixed-price mystery bags with a published minimum store value), and a leaderboard. All of them depend on something the caja doesn't have yet: the customer's phone number on each sale.

### What makes games and microtransactions compelling

Games keep players through a small set of mechanisms that stack. The engine underneath is uncertainty: the brain's dopamine system responds most strongly to rewards it can't predict, and the anticipation before the outcome drives motivation more than the prize itself ([Clark & Zack, 2023](https://www.sciencedirect.com/science/article/pii/S0306460323000217)).

| Mechanic | How games use it | Evidence | Store translation | Risk |
| --- | --- | --- | --- | --- |
| Variable rewards | Loot drops, loot boxes, gacha pulls with rare tiers | Unpredictable, frequent rewards keep dopamine neurons firing; more layers of variability raise addictive potential ([Clark & Zack, 2023](https://www.sciencedirect.com/science/article/pii/S0306460323000217)) | Unknown pallets, weekly drop, "what came in?" | Low if customer sees item before paying |
| Paid chance (loot boxes) | Pay first, then learn what you got | 12 of 13 studies link loot-box spending to problem gambling; mean r = .27 ([Spicer et al., 2022](https://journals.sagepub.com/doi/10.1177/14614448211027175)) | Rasca y gana, ruleta, paid mystery with prizes | High — and a regulated sorteo in Mexico |
| Near-miss | Two jackpot symbols and a third just off | Near-misses activate win-related brain circuits and raise the urge to play ([Clark et al., 2009](https://pubmed.ncbi.nlm.nih.gov/19217383/)) | Don't build it | High |
| Progress bars | XP bars, quest trackers | Coffee-card buyers sped up purchases ~20% as they neared the reward; a 12-stamp card with 2 pre-stamped finished 20% faster than a 10-stamp card ([Kivetz et al., 2006](https://home.uchicago.edu/ourminsky/Goal-Gradient_Illusionary_Goal_Progress.pdf)) | Progress line on the ticket, signup bonus | Low |
| Head start | Tutorial rewards that pre-fill progress | 34% completed a car-wash card with 2 of 10 pre-stamped vs 19% with 0 of 8 ([Nunes & Drèze, 2006](https://academic.oup.com/jcr/article-abstract/32/4/504/1787425)) | Signup gives 50 Dolarones | Low |
| Streaks | Daily login rewards, Duolingo streak | Share of Duolingo daily users on 7+ day streaks rose ~3x to over half; leaderboards added 17% learning time ([Lenny's Newsletter](https://www.lennysnewsletter.com/p/how-duolingo-reignited-user-growth)) | Weekly visit streak with one free miss per season | Medium — keep it weekly, forgiving |
| Seasons / battle pass | Time-boxed tiers; free and paid tracks | Deadline plus visible tiers drives return visits | 8-week season, levels reset | Low–medium |
| Collections | Card sets, skins, sticker albums | Completing 980 World Cup 2026 Panini stickers without trading costs ~$26,000 MXN ([El Informador](https://www.informador.mx/deportes/mundial-2026-el-impactante-costo-de-llenar-el-album-panini-sin-intercambiar-estampas-20260524-0069.html)) | Category missions, not random stickers | Low if deterministic |
| Scarcity / rotation | Daily item shop, limited skins | Rotation creates urgency to check in often | Real one-of-a-kind stock; "si te gusta, llévatelo" | Low if true, illegal if faked |
| Premium currency | V-Bucks, gems at odd exchange rates | EU consumer groups filed against Fortnite, Roblox, others for hiding real prices behind currencies ([BEUC, 2024](https://www.beuc.eu/press-releases/consumer-groups-denounce-video-games-manipulative-spending-tactics)) | Dolarones pegged 1:1 to pesos, earned only | Low if 1:1 |
| Social | Leaderboards, trading, gifting, clans | Leaderboards: +17% learning time at Duolingo | Referral bonus, "Cazador de la semana", WhatsApp group | Low |
| Dark patterns | Confusing buttons, one-tap charges | Epic paid $245M to the FTC over tricking players into purchases ([FTC, 2023](https://www.ftc.gov/news-events/news/press-releases/2023/03/ftc-finalizes-order-requiring-fortnite-maker-epic-games-pay-245-million-tricking-users-making)) | Don't build it | High |

Games work hardest to get the **first purchase**, and rewards feel best right after a reset: in the coffee study, customers slowed down when a new card started, then sped up again near the next reward.

### Retail already runs on these mechanics

| Business | Mechanic | What they do | Lesson for El Dolarón |
| --- | --- | --- | --- |
| [TJX (TJ Maxx, Marshalls)](https://www.tjx.com/company/how-we-do-it) | Treasure hunt + real scarcity | New merchandise "several times a week"; "If you love it, grab it!"; no back-room replenishment | Every week is different, and what you see won't be back |
| [US bin stores](https://thebinmap.com/guide/bin-store-pricing-explained/) | Scheduled drop + falling price | Restock Friday at ~$10 per item, then $7, $4, $2, $1 by Tuesday | A drop day plus a weekly markdown gives two reasons to visit |
| [Pop Mart / Labubu](https://www.demandsage.com/labubu-statistics/) | Blind box, rare "secret" figure | Secret figures often 1 in 72 to 1 in 144; THE MONSTERS line made ~$677M USD in H1 2025 | Mystery works when every box is worth its price on its own |
| [Panini World Cup 2026](https://www.informador.mx/deportes/mundial-2026-el-impactante-costo-de-llenar-el-album-panini-sin-intercambiar-estampas-20260524-0069.html) | Collection + trading | 980 stickers; [mass trading events in Mexico](https://expansion.mx/tendencias/2026/07/06/panini-record-guinness-mayor-intercambio-estampas-mundial) | Completion is a strong local habit |
| [Spin Premia (OXXO)](https://www.fintechexpert.mx/p/spin-oxxo-crece-usuarios-transacciones-femsa-3q25) | Points tied to a phone number | 60.9M members, 27.7M active; 48.2% of OXXO sales earn or redeem points | Mexican shoppers already give a phone number at the register |
| [Surprise coupons (study)](https://journals.sagepub.com/doi/abs/10.1509/jmkr.39.2.242.19081) | Unannounced reward | Unexpected in-store coupons increase unplanned purchases (Heilman et al., 2002) | A surprise gift at the register lifts the ticket; don't announce odds |

### Program components

**Identity.** At the caja: "¿Me das tu número para tus Dolarones?" Always optional; the sale never waits on it. Signup: +50 Dolarones and opt-in to the WhatsApp drop list.

**Día de Descarga.** One fixed weekday and hour (Tuesday, tentative). The day before: 3–5 teaser photos on WhatsApp and Facebook. At the drop hour: open sealed pallet boxes on the floor, live on Facebook/TikTok. Weekly markdown: pieces unsold after 3 weeks move down one price band; after 6 weeks they go into Bolsas Sorpresa. `semana_ingreso` already exists in `productos`.

**Niveles por temporada (8 weeks, free only).** Bronce: sign up. Plata: 4 visits with purchase (teaser photos earlier, birthday bonus). Oro: 8 visits with purchase (Hora Dorada, "Cazadores Oro" board). Levels reset each season. No paid pass for now.

**Misiones y racha.** 3 missions per season with a bonus each (shop on a Día de Descarga; bring someone new; buy from 3 sections — needs a cashier tap or section-specific band codes, since band codes like `G49` don't carry the section). Weekly streak: 4 weeks in a row earns a bonus, one free missed week per season. Never daily.

**Bolsa Sorpresa.** Sealed bags at $49, $99, $199 by theme, each with a published minimum store value (e.g. at least $150 in the $99 bag). Built from slow stock. No "premio mayor" or "gana" wording.

**Sorpresa Dolarón and social.** Occasional unannounced cashier gift (never advertised as a chance to win). Referral bonus for both people. "Cazador de la semana" post with permission. WhatsApp Community with a "Hallazgos" channel.

### What not to copy

- No paid chance without a permit.
- No near-misses or fake odds.
- No fake scarcity or countdowns (LFPC art. 48).
- No confusing currency: Dolarones earned only, never sold for pesos; prices and expiry published.
- No harsh loss mechanics: streaks forgive a missed week.
- No pressure on kids.
- No chasing big spenders: reward visits, watch for bulk mystery-bag buying.

### Rollout

| Phase | When | What goes live |
| --- | --- | --- |
| 0 | Opening, weeks 1–2 | Launch gift in paper Dolarón vales, WhatsApp drop list, fixed Día de Descarga |
| 1 | Weeks 3–6 | Phone at the caja, digital Dolarones; paper vales entered into the ledger |
| 2 | First 8-week season | Levels, Hora Dorada, missions, weekly streak, referral, Bolsa Sorpresa, weekly markdown, leaderboard |
| 3 | After one season | Review data; consider a SEGOB-permitted raffle for the anniversary (3-month lead time) |

### Weekly metrics

| Metric | Definition |
| --- | --- |
| Identified sales | % of sales with a phone number (Spin Premia reference: 48.2%) |
| 30-day return rate | % of members who buy again within 30 days |
| Visits per member | Paid visits per member per month |
| Drop-day traffic | Sales count on Día de Descarga vs other days |
| Average ticket | Members vs non-members |
| Reward cost | Dolarones redeemed at cost ÷ member sales |
| Bolsa sell-through | Bags sold ÷ bags packed; age of stock inside |

Change one rule at a time, for at least 4 weeks.

## 6. Dolarones: rules, prizes and leaderboard

### How Dolarones work

Dolarones are El Dolarón's own money: 1 Dolarón = $1, earned by shopping and visiting, spent like cash on anything in the store or on vitrina prizes.

| Rule | Value | Why |
| --- | --- | --- |
| Spend | 10 Dolarones per $100 | "Te regresamos 10% en Dolarones". It's a real 10% discount; check it once cost is known |
| Visit bonus | +5 per visit with a purchase of $99 or more, max 1 per day | Rewards frequency |
| Signup | +50 | Head start |
| When usable | From the next visit, never on the ticket that earned them | Every purchase creates a reason to come back |
| Dolarones Dobles | 2x on one slow weekday, chosen after 2 weeks of sales data | Moves traffic to empty days |
| Expiry | 12 months after earning | Limits the liability; printed on every ticket |
| Never | Sold for pesos, cashed out, given as change, or transferred | Keeps it a loyalty program |

A customer spending $250 once a week earns about **30 Dolarones a week** (25 from spend + 5 visit bonus).

Cost as a share of sales, if every Dolarón is spent = earning rate × cost ratio:

| Cost as % of shelf price | 5% back | 10% back |
| --- | --- | --- |
| 30% | 1.5% of sales | 3% of sales |
| 40% | 2% of sales | 4% of sales |
| 50% | 2.5% of sales | 5% of sales |

Cost ratio per pallet = landed cost (price, shipping, import, fees) ÷ total shelf price of the pieces it produced.

The ticket always shows the balance and the next prize: "Tienes 80 D · te faltan 20 para tu Pase Hora Dorada."

### Prize catalog (Vitrina de Premios)

Product prizes cost their shelf price in Dolarones; experiences get a fixed price close to the value the winner gets.

| Prize | Price | Weeks to earn at 30 D/week |
| --- | --- | --- |
| Bolsa Sorpresa $49 | 49 D | 2 |
| Pase Hora Dorada, 2 people | 100 D | 4 |
| Any "joya" up to $300 | Up to 300 D | 10 |
| Medio Minuto: 30 seconds, 1 bag, $19–$29 zone | 400 D | 14 |
| Minuto Loco: 60 seconds, 1 cart, bands up to $49 | 1,200 D | 40 |
| Small appliance from a pallet, tested | Its shelf price, e.g. 1,200 D | 40 |
| TV 43–50" from a pallet, tested | Its shelf price, e.g. 5,000 D | 167 |

- The bottom of the ladder (2–4 weeks) keeps people coming back.
- The TV is the poster: on the vitrina wall with its price in Dolarones, and the top leaderboard prize.
- Minuto Loco: ~30 pieces averaging $35 ≈ $1,050 shelf value; 1,200 D keeps it slightly in the store's favor.
- Pick prizes from stock that isn't moving; a TV that would sell today costs the sale.

### Minuto Loco and Hora Dorada rules

**Minuto Loco / Medio Minuto:** before opening only, max one run per week; one cart (or bag) from a marked zone of band-priced pieces up to $49, no joyas, electronics or appliances; walk, no running; winner signs a rules sheet; 18+; visible countdown and staff stopwatch; film with written OK; everything rung up at the caja so reports show the prize cost.

**Pase Hora Dorada:** winner + one guest shop the new drop one hour before opening on Día de Descarga, at normal prices; max ~5 passes per drop.

### Leaderboard

Ranking purely by pesos spent backfires: resellers win every season, only 3 people win, and a public spending ranking exposes private data. Fixed version:

| Rule | Setting |
| --- | --- |
| Season | 8 weeks; board resets each season |
| Score | Dolarones earned in the season, with spend counting up to $1,000 per day; visit bonuses always count |
| Prizes by rank | 1st: TV · 2nd: Minuto Loco · 3rd: small appliance (pending confirmation) |
| Prizes by threshold | Everyone reaching 250 season points (about 8 regular visits) gets a Pase Hora Dorada and a Bolsa Sorpresa |
| Display | Top 10 in store and weekly on WhatsApp; opt-in alias or first name + initial; points, never pesos |
| Ties | Whoever reached the score first; never a random draw |
| Resellers | Separate "Mayoreo" board if they become a real segment |

Budget: fixed prize budget per season in shelf value, set before announcing; about one month of ad spend (~$3,000) as a starting ceiling.

### Caja changes (not implemented)

The caja stores sales with no customer today (`ventas` has no customer column). Minimum additions, append-only like sales:

- `clientes`: phone (unique), optional name, signup date, WhatsApp consent.
- `ventas.cliente_id`: nullable, so anonymous sales keep working.
- `dolarones` ledger: one row per movement (compra, visita, alta, doble, misión, canje, vencimiento, ajuste), tied to the sale id so a retried sale never double-counts. Amounts in centavos like all money in the app.
- `premios` catalog: name, photo, price in Dolarones, units available, active flag; pallet prizes can point to their `productos` row.
- Payment: Dolarones as a payment line on any sale; a vitrina prize is a sale paid in Dolarones.
- Leaderboard: season query over the ledger with the $1,000-per-day spend cap.
- Ticket: balance, next prize, Dolarones expiring soon.
- Built this way in D1, it carries over to the future online store.

## Fuentes

- Clark & Zack (2023), [Engineered highs: reward variability and frequency](https://www.sciencedirect.com/science/article/pii/S0306460323000217)
- Spicer et al. (2022), [Loot boxes, problem gambling and problem video gaming](https://journals.sagepub.com/doi/10.1177/14614448211027175)
- Clark et al. (2009), [Gambling near-misses enhance motivation to gamble](https://pubmed.ncbi.nlm.nih.gov/19217383/)
- Kivetz, Urminsky & Zheng (2006), [The goal-gradient hypothesis resurrected](https://home.uchicago.edu/ourminsky/Goal-Gradient_Illusionary_Goal_Progress.pdf)
- Nunes & Drèze (2006), [The endowed progress effect](https://academic.oup.com/jcr/article-abstract/32/4/504/1787425)
- Heilman, Nakamoto & Rao (2002), [Pleasant surprises: unexpected in-store coupons](https://journals.sagepub.com/doi/abs/10.1509/jmkr.39.2.242.19081)
- [How Duolingo reignited user growth](https://www.lennysnewsletter.com/p/how-duolingo-reignited-user-growth)
- BEUC (2024), [Video games' manipulative spending tactics](https://www.beuc.eu/press-releases/consumer-groups-denounce-video-games-manipulative-spending-tactics)
- FTC (2023), [Epic Games to pay $245 million](https://www.ftc.gov/news-events/news/press-releases/2023/03/ftc-finalizes-order-requiring-fortnite-maker-epic-games-pay-245-million-tricking-users-making)
- [TJX: How we do it](https://www.tjx.com/company/how-we-do-it)
- [TheBinMap: Bin store pricing explained](https://thebinmap.com/guide/bin-store-pricing-explained/)
- [DemandSage: Labubu statistics](https://www.demandsage.com/labubu-statistics/)
- [El Informador: costo del álbum Panini 2026](https://www.informador.mx/deportes/mundial-2026-el-impactante-costo-de-llenar-el-album-panini-sin-intercambiar-estampas-20260524-0069.html)
- [Expansión: intercambio masivo Panini](https://expansion.mx/tendencias/2026/07/06/panini-record-guinness-mayor-intercambio-estampas-mundial)
- [Fintech Expert: Spin by OXXO](https://www.fintechexpert.mx/p/spin-oxxo-crece-usuarios-transacciones-femsa-3q25)
- LFPC arts. [46](https://leyes-mx.com/ley_federal_de_proteccion_al_consumidor/46.htm), [47](https://leyes-mx.com/ley_federal_de_proteccion_al_consumidor/47.htm), [48](https://leyes-mx.com/ley_federal_de_proteccion_al_consumidor/48.htm)
- [Reglamento de la Ley Federal de Juegos y Sorteos](https://www.ordenjuridico.gob.mx/Documentos/Federal/html/wo88470.html)
- [Trámite SGOB-01-009-A](https://catalogonacional.gob.mx/FichaTramite?traHomoclave=SGOB-01-009-A)
- [LISR art. 137](https://leyes-mx.com/ley_del_impuesto_sobre_la_renta/137.htm)
