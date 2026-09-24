# El Dolarón — Sistema de recompensas y Dolarones

Fecha del registro: 24 de septiembre de 2026. Moneda: pesos mexicanos (MXN). Zona horaria del negocio: America/Mexico_City.

Este documento conserva la investigación y el diseño del sistema de recompensas de El Dolarón (mecánicas de videojuegos aplicadas a la tienda, Dolarones, regalo de apertura, premios y tabla de posiciones). Es la referencia para cualquier agente (Claude, ChatGPT/Codex, Agy u otro). La versión de trabajo original vive en un documento privado de Claude; **este archivo es la copia compartida**: si una decisión cambia, actualízala aquí mediante Issue y PR.

**Estado:** propuesta con decisiones del propietario. Nada de esto está implementado todavía en la caja (`app/`), ni publicado a clientes. No anunciar reglas, montos o fechas sin confirmación de Isaac.

**Revisión para producción: 24/09/2026.** Seguimiento: [Issue #56](https://github.com/iskaar/El-Dolaron-Social-Kit/issues/56). El [plan de implementación](PLAN-IMPLEMENTACION-RECOMPENSAS.md) contiene fases, agentes, modelos, esfuerzo, costos y criterios de lanzamiento. Esta revisión es documental; no certifica la seguridad del despliegue actual.

## 1. Cómo retomar este trabajo

- Leer primero la sección 2 (decisiones confirmadas) y la sección 3 (pendientes). No volver a preguntar lo que ya está decidido.
- El propietario prefiere responder preguntas numeradas en un solo mensaje de texto.
- Regla de diseño central: **aleatorizar el descubrimiento, nunca el pago.** Nada de premios decididos por azar sin permiso de SEGOB (ver sección 4).
- El contenido detallado (secciones 5 y 6) conserva la investigación original en inglés. Las decisiones confirmadas de la sección 2 prevalecen; las secciones 3, 4 y 7 identifican pendientes, correcciones y requisitos. Una propuesta técnica no aprueba una nueva regla comercial.

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
| Apertura prevista | Primera semana de octubre de 2026; día y hora exactos pendientes |
| Portal de clientes | Registro y consulta de saldo en línea; compra y canje en tienda física |
| Identidad | Membresía QR/PIN y correo verificado para acceso en línea; sin SMS/WhatsApp de autenticación en v1 |
| Escala prevista | Hasta 1,000 clientes distintos al inicio y 10,000 durante el primer año; no equivale a usuarios simultáneos |
| Desarrollo y presupuesto inicial | Claude y Codex, usando suscripciones existentes; reducir costos recurrentes hasta que opere la tienda. El plan detalla la propuesta de $50–51 USD/mes de servicios |

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

**Cambio respecto a la idea original:** se sustituyó la reasignación al azar por una lista de espera en orden. La clasificación jurídica debe revisarse con un especialista; no reintroducir azar sin esa revisión y los permisos que correspondan. El detalle de asignación, canje parcial y vencimiento de apertura aún requiere aprobación (sección 7).

## 3. Pendientes

1. Día/hora exactos de apertura, horario de canje de los días 1 y 2, responsable de soporte y número de tiendas/cajas. Registro web confirmado; asistencia en tienda propuesta.
2. Qué artículos de pallet van en la primera Vitrina de Premios.
3. Premios por posición de la temporada 1 (propuesta: TV, Minuto Loco, electrodoméstico chico).
4. Si los revendedores compran lo suficiente como para tener su propia tabla ("Mayoreo").
5. Más adelante: registrar el costo total de cada pallet (precio, envío, importación, comisiones) para calcular el costo real del 10%.
6. Confirmar el martes como Día de Descarga.
7. Revisión legal/contable antes de lanzar (sección 4).
8. Aprobar si +50 por alta y +5 por visita estarán activos y si se acumulan con el regalo. Solo el umbral de compra de $99 está confirmado para visitas; esos montos aparecen como propuestas en la investigación. Recomendación para apertura: desactivarlos y conservar el 10% confirmado.
9. Precisar cálculo proporcional, redondeo, base de acumulación, cuándo se habilita lo ganado, devoluciones y vigencia de créditos restituidos (sección 7).
10. Aprobar presupuesto operativo y nombrar quién atiende incidencias, recuperación de cuentas y ajustes. El plan propone herramientas; no se han contratado.
11. Aprobar reglas contra registros duplicados del regalo. Correo verificado prueba control del correo, no que sea una persona distinta; no exigir identificación oficial por defecto.

## 4. Puntos legales y fiscales (resumen; no es asesoría legal)

- **Promociones:** la regla general del art. 47 tiene excepciones; no es una exención universal. Publicar condiciones, plazos y/o cantidades y cumplirlos según arts. 46–48 de la [LFPC vigente](https://www.diputados.gob.mx/LeyesBiblio/pdf/LFPC.pdf). Revisar las normas aplicables antes de anunciar.
- **Azar:** el art. 7 del [Reglamento de Juegos y Sorteos](https://www.diputados.gob.mx/LeyesBiblio/regley/Reg_LFJS.pdf) exige permiso para los juegos y sorteos comprendidos en él. V1 excluye rifas, ruletas y desempates al azar; un regalo discrecional o una bolsa de contenido desconocido no se presume legal solo por cambiarle el nombre. Retirar del calendario de apertura hasta revisión específica. No usar el plazo de tres meses de la investigación como garantía de trámite.
- **Premios:** revisar con el contador los arts. 137–139 de la [LISR](https://www.diputados.gob.mx/LeyesBiblio/pdf/LISR.pdf), incluidos concursos y posibles obligaciones locales; el monto alto no es el único criterio.
- **Datos:** aplicar la [LFPDPPP vigente, expedida en 2025](https://www.diputados.gob.mx/LeyesBiblio/pdf/LFPDPPP.pdf). Aviso antes de recabar datos, finalidades separadas, medios ARCO, conservación y medidas de seguridad; documentar proveedores y transferencias aplicables. Marketing y publicación de alias son opcionales e independientes de pertenecer al programa.
- **Contabilidad:** el saldo representa una obligación comercial a conciliar; el contador determina reconocimiento contable, tratamiento fiscal y facturación. Registrar por separado crédito promocional, descuentos, dinero cobrado y mercancía entregada; no decidir automáticamente que todo saldo es un pasivo contable idéntico.
- **Vales de papel:** no deben parecerse a billetes: "vale canjeable solo en El Dolarón, no canjeable por efectivo", otro tamaño y colores, folio, nombre del titular y vigencia.

---

## 5. Research and program design (main plan)

### Research premise (historical context)

The studies and market figures below are retained as background, not validated forecasts for this store. They do not establish a legal exemption or an expected sales uplift. The production scope and operating rules in section 7 supersede the original rollout and unapproved examples.

El Dolarón already owns the most powerful hook in game design: an unpredictable reward that shows up on a schedule. Every closed pallet is a loot box — for the owner. The job is to hand that feeling to the customer without charging them for a gamble.

Design principle: **randomize the discovery, never the payment.** Use clear progress and deterministic benefits. Whether any particular promotion needs permission or further safeguards depends on its actual rules; see section 4. Do not infer legality from a game mechanic's name.

Program ideas: Día de Descarga, Dolarones, seasonal levels, missions, weekly streak and a leaderboard. They need an optional stable member ID on each sale, which the caja does not yet have. A phone number is contact information, not that identity. The opening scope is narrower; see section 7.

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

**Identity.** Membership is optional and anonymous sales remain available. The confirmed approach is QR/PIN in store plus verified email online. A phone number is optional contact information, never a credential. The +50 signup bonus remains unapproved; WhatsApp marketing consent must be separate.

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

### Original rollout (superseded by section 7 and the implementation plan)

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

Dolarones are store reward credit: 1 Dolarón = $1 MXN of redemption value, usable on products or approved vitrina prizes. They are not cash, transferable money or a deposit account. Purchase accrual is confirmed; extra visit rewards remain proposed.

| Rule | Value | Why |
| --- | --- | --- |
| Spend | 10 Dolarones per $100, confirmed | Future store credit; not an immediate 10% discount. Calculation details need approval |
| Visit bonus | Proposed +5; $99 minimum confirmed | Amount, daily limit and stacking not yet approved |
| Signup | Proposed +50 | Disabled for launch unless approved |
| When usable | Proposed from the next visit, never on the earning ticket | Define next visit precisely; section 7 proposes the next business date |
| Dolarones Dobles | Proposed 2x on a slow weekday | Post-launch, only after budget approval |
| Expiry | 12 months after earning | Limits the liability; printed on every ticket |
| Never | Sold for pesos, cashed out, given as change, or transferred | Keeps it a loyalty program |

A customer spending $250 once a week earns about **30 Dolarones a week** (25 from spend + 5 visit bonus).

Illustrative merchandise cost only, assuming every earned Dolarón is redeemed, fixed shelf prices and no additional bonuses: earning rate × merchandise cost ratio. This excludes displaced cash sales, taxes, operating costs and the opening gift; it is not the program's full economic cost.

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

**Feasibility correction:** at 30 D/week, credits expiring after 12 months yield roughly 1,560 D available at steady state. Saving 167 weeks for a 5,000 D TV is not possible at that rate. Do not advertise it as a realistically reachable savings goal for this customer; revise the catalog or clearly distinguish a separately funded seasonal prize.

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
| Prizes by threshold | Unapproved: 250 points needs nine purchases at 30 points each, beyond eight weekly purchases in an eight-week season. Recalculate threshold and capacity before promising anything |
| Display | Top 10 in store and weekly on WhatsApp; opt-in alias or first name + initial; points, never pesos |
| Ties | Whoever reached the score first; never a random draw |
| Resellers | Separate "Mayoreo" board if they become a real segment |

The suggested $3,000 season budget is unapproved and does not cover a proposed $5,000 TV by itself. Five Hora Dorada passes per drop means only 40 passes in an eight-week season before other allocations; there is no capacity for an unlimited threshold promise. Resolve these conflicts before announcing a season.

### Caja changes (not implemented)

The caja stores sales with no customer today (`ventas` has no customer column). Minimum additions, append-only like sales:

- `clientes`: stable ID, unique verified auth subject when linked, optional contact/name, signup date and versioned consents. Do not make phone the primary identity.
- `ventas.cliente_id`: nullable, so anonymous sales keep working.
- `dolarones` ledger: one row per movement (compra, visita, alta, doble, misión, canje, vencimiento, ajuste), tied to the sale id so a retried sale never double-counts. Amounts in centavos like all money in the app.
- `premios` catalog: name, photo, price in Dolarones, units available, active flag; pallet prizes can point to their `productos` row.
- Payment: Dolarones as a payment line on any sale; a vitrina prize is a sale paid in Dolarones.
- Leaderboard, later: separate score from spendable balance. Exclude opening grants, signup grants and transfers; reverse purchase scores on refunds. Spending points never reduces earned season score. Exact eligible events require approval.
- Ticket: balance, next prize, Dolarones expiring soon.
- Built this way in D1, it carries over to the future online store.

## 7. Contrato operativo propuesto para lanzamiento

Estas reglas completan lo que hace falta para implementar. **Son propuestas para aprobación donde afectan al cliente**, no nuevas decisiones atribuidas a Isaac. Los controles de seguridad, integridad y auditoría son criterios de entrega.

### 7.1 Alcance y orden

Primera entrega: registro y acceso por correo verificado, membresía QR/PIN, saldo/historial/vencimientos privados, caja con acumulación y canje, devolución trazable, regalo de apertura determinista, respaldo de papel, aviso y soporte. La venta anónima sigue disponible. No hay pago en línea ni IA en el cálculo del saldo.

Temporadas, misiones, rachas, referidos, rankings, cumpleaños, dobles, vitrina especial y experiencias se implementan después del piloto. El 10% y el uso en cualquier producto se conservan. No anunciar la activación digital hasta pasar los criterios del plan; si no llega a tiempo, usar el procedimiento controlado de papel.

### 7.2 Acumulación, canje y devolución

| Tema | Propuesta precisa / control |
| --- | --- |
| Unidad | 1 D = $1 MXN. Guardar centésimas enteras: 100 unidades = 1 D. No flotantes |
| Base | Importe elegible final después de descuentos, pagado en efectivo/tarjeta; no acumular sobre D usados, créditos promocionales ni ventas canceladas. Definir base fiscal con contador |
| Fórmula | `floor(base_centavos / 10)` centésimas de D, una vez por ticket. $99 → 9.90 D; $250 → 25 D. No bloques completos de $100 |
| Disponibilidad | Lo ganado se habilita a las 00:00 de la siguiente fecha en America/Mexico_City; evita dividir la misma visita en tickets para reciclar crédito. Apertura tiene ventana propia |
| Vigencia | Cada lote ganado vence a los 12 meses calendario, conservando fecha/hora local; si falta el día, último día válido del mes. Guardar instante UTC resuelto; no usar 365 días ni extender al hacer nuevos depósitos |
| Aplicación | Consumir primero el lote que vence antes, con desempate por ID. No usar saldo pendiente, expirado o reservado; máximo el total de compra, sin efectivo de cambio por D |
| Pago mixto | `efectivo_aplicado + tarjeta_aplicada + D_aplicados = total`. El cambio solo proviene del efectivo entregado de más. Registrar importes, no solo una etiqueta de forma de pago |
| Confirmación | Caja solo dice «canje completado» después de confirmación del servidor. UUID de operación y huella del contenido: mismo ID/mismo contenido devuelve el resultado original; contenido distinto, conflicto |
| Devolución | Revertir exactamente lo ganado por los artículos devueltos; devolver la parte de D a sus lotes y la parte monetaria a su medio original. Nunca convertir D en efectivo. Guardar asignación de descuentos, pago y recompensa por línea para devoluciones parciales |
| Ganancias ya gastadas | Registrar reversión íntegra y deuda de recompensas separada; nuevas ganancias compensan esa deuda. Saldo gastable nunca negativo. Revisión del gerente y política comunicada; no retener automáticamente una devolución legal |
| Crédito devuelto vencido | Propuesta: crédito de restitución por 30 días, ligado al original y contabilizado aparte; requiere aprobación comercial/legal antes de activar. No rejuvenecer silenciosamente lotes históricos |
| Correcciones | Movimiento compensatorio con motivo, autor, referencia y permiso de gerente. No editar/borrar movimientos para hacer cuadrar el saldo |

Venta, pagos, consumo de lotes, recompensa e inventario deben confirmarse o rechazarse juntos. La verificación de saldo ocurre dentro de la transacción; comprobar saldo antes y luego descontarlo permite doble gasto. El cron limpia vencimientos, pero un cron atrasado no permite gastar saldo vencido.

### 7.3 Apertura: $15,000 con límite verificable

1. Publicar fecha/hora de inicio del registro, elegibilidad, reglas contra duplicados, vencimientos y canales de ayuda. Propuesta: el orden se asigna al completar correo verificado y aceptación de bases; timestamp y secuencia los emite el servidor, nunca el navegador. Verificación asistida en tienda para quien no tenga correo, con un criterio único publicado de registro completo.
2. Asignar de forma atómica los 100 lugares de la tabla, una participación por miembro elegible. La secuencia es interna; no publicar correos, teléfonos ni nombres de la lista.
3. Mantener el regalo en lotes separados del saldo ordinario: ventana del día 1, canje parcial permitido, y excepción explícita a los 12 meses ordinarios. Definir horas exactas con Isaac.
4. Al cierre del día 1, congelar nuevas operaciones, resolver las pendientes y revocar únicamente los remanentes. Ordenar los lotes remanentes por lugar original y asignar uno a cada siguiente participante elegible de la espera; cada uno recibe ese remanente exacto, sin rellenarlo ni sortear. Esta política de reparto debe aprobarse y publicarse.
5. Cada reasignación conserva el linaje del lote y es idempotente. Lo no usado el día 2 vence. El sistema comprueba que valor consumido neto + valor vigente/reservado del regalo nunca exceda 15,000 D. Los asientos de revocación y reasignación no son nuevas autorizaciones presupuestales.
6. Una devolución posterior sigue la política de restitución y su propio registro presupuestal; no recicla automáticamente el regalo hacia la lista de espera. Los abusos o duplicados van a revisión, sin borrar una venta o alterar el orden original.

### 7.4 Identidad, privacidad y papel

- QR = identificador aleatorio de membresía, sin datos personales ni saldo. No autoriza por sí solo. PIN definido por el cliente, hash con sal y derivación resistente, nunca texto claro ni visible al personal; límites de intentos por cuenta y origen, recuperación verificada y revocación de la credencial perdida.
- Para la afiliación presencial sin correo, emitir membresía/PIN con el cliente presente. Vincularla después al correo solo con prueba de posesión de la membresía/PIN o recuperación autorizada; nunca por coincidencia del teléfono o del nombre. Una cuenta autenticada solo ve su propio saldo.
- Marketing separado y opcional; no importar clientes a grupos de WhatsApp automáticamente. Guardar versión/fecha de bases y aviso. No pedir cumpleaños, domicilio o identificación oficial sin necesidad definida.
- Papel y saldo digital no representan dos copias gastables del mismo crédito. Un lote está exclusivamente en uno de los dos canales; conversión implica bloqueo/cancelación del original y recibo firmado. Para papel, libro de folios con titular, monto, vigencia, emisión, canjes parciales y remanente, firma de responsable y resguardo del original.
- Durante caída de internet, la caja puede conservar ventas monetarias pendientes como hoy; lo ganado queda pendiente de validación. **No canjear saldo digital offline.** Solo aceptar vales previamente emitidos en papel bajo custodia de una caja designada. Si la conexión cae antes de bloquear un saldo digital, no convertirlo a papel por su saldo en pantalla.
- Conciliar diariamente folios emitidos, anulados, canjeados y pendientes; importar cada operación de papel una sola vez por folio/subfolio. El gerente resuelve diferencias antes de abrir el siguiente día.

### 7.5 Economía que falta comprobar

El regalo autoriza 15,000 D nominales, no demuestra que cueste $15,000 de mercancía. Asimismo, 10% de crédito futuro no equivale a 10% de descuento inmediato. Con $100 cobrados y 10 D canjeados después sin generar más D, se entregan $110 de valor de anaquel: la proporción promocional es 10/110 = 9.09%, antes de bonos y costos. Son denominadores distintos.

Un +50 universal agrega 50,000 D por 1,000 altas o 500,000 D por 10,000 altas, además del regalo. Por eso no se activa sin presupuesto. Separar en el reporte: D emitidos, pendientes, canjeados, vencidos, revertidos, deuda por devoluciones, saldo vigente y costo de mercancía cuando esté disponible. Nunca presentar un costo de margen inventado como ganancia.

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
