# Skynet — Strukturerad PMF-loop

**Syfte:** Definiera hur vi systematiskt mäter, intervjuar och omvandlar signal till backlog-beslut tills vi når PMF. Dokumentet äger loopen, inte en enskild sprint.

---

## 1. Prioriterade segment (i ordning)

### Segment A — Lead/senior-utvecklare på litet tech-team (2–20 pers) ⭐ primärt

**Profil:** 1–3 års erfarenhet av Claude Code/Codex, ansvarig för kodkvalitet och merge-beslut, frustrerad av hur agenter blockerar varandra och kräver babysitting.

**Varför primärt:** De lider tydligast av det Skynet löser (parallell drift utan kaos + governance), de har budget-befogenhet, och de är tidiga adopters som sprider via mun-till-mun. Den lokala desktop-app-modellen (BYO key, data stannar på maskinen) är en direkt match mot deras säkerhetskrav.

**Vad de inte kan lösa med status quo:** Coordinator-ångest — en agent väntar, en annan kolliderar, merge-kön är manuell, ingen audit-trail för chefen.

---

### Segment B — Soloutvecklare med stor backlog ⭐ sekundärt

**Profil:** Indie-hacker, konsult, startup-CTO utan team. Kör 2–5 agenter i parallell för att multiplicera sin kapacitet. Budget-känslig men betalar för verktyg som ger tydlig ROI.

**Varför sekundärt:** Lättare att nå och intervjua, ger snabb signal, men betalningsvilja och fleet-storleken är lägre — de väljer bort governance om det känns som overhead.

**Differentierare för detta segment:** autonomy-läget (agenter väljer och utför utan paus), budget-tak per dag, och att de slipper manuell merge-koordination.

---

### Segment C — Tech lead / engineering manager på mid-storlek (20–200 pers) (deferred tills vi har signal)

**Profil:** Ansvarig för AI-policy, SOC 2 / EU AI Act-compliance, vill ha audit-trail och godkännandeflöde för AIgenererad kod. Värderar compliance-bevispaket och rollseparation.

**Varför deferred:** Längre sales-cykel, kräver funktioner vi ännu inte har mognat (SSO, SIEM, fler roller). Lägg inte intervjuresurser här förrän Segment A visar bra retention.

---

## 2. Användar­signaler som räknas

Vi behöver separera **vanitymätvärden** (installationer, stjärnor) från **PMF-signaler** (riktig användning som vi inte vill se försvinna).

### Kvantitativa tier-1-signaler (veckouppdateras)

| Signal | Definition | PMF-tröskelvärde |
|--------|-----------|-----------------|
| **WAA — Weekly Active Agents** | Antal unika agentrundar startade per användare per vecka | ≥3 per aktiv användare |
| **HITL-lösningstid** | Median tid från gate → operatörsresolution | <5 min (annars är flödet för kladdigt) |
| **Merge-succesrate** | Andel diffs som godkänns utan rework-loop | >70% |
| **Autonomy-on-andel** | Andel projekt med autonomy-toggle aktiverat | >50% bland >2-veckorbrukare |
| **7-/30-dagars retention** | Andel användare som kör ≥1 agent-session vecka 2 resp. månad 2 | Wk-2: >40%, Mo-2: >25% |
| **Dagligt spendgolv** | Andel aktiva användare som når sin dagliga budget-tröskel | >20% (visar att de faktiskt kör) |

### Kvantitativa tier-2-signaler (månadsvis)

- **Flottsstorlek per användare** — median antal konfigurerade runners.
- **HITL-typfördelning** — approval / diff-review / merge-conflict / escalation: dominans av diff-review är god signal (agenter gör jobb); dominans av escalation indikerar att agenten fastnar för ofta.
- **Session circuit-breaker-frekvens** — autonomy pausat pga on-rad-failures: hög frekvens → uppgiftskvalitet eller runner-inställning är dålig.

### Kvalitativa PMF-signal

**Sean Ellis-testet** (körs i intervjuer och kvartalsvisa enkäter):

> "Hur besviken skulle du vara om Skynet slutade existera imorgon?"
> A) Mycket besviken (would be very disappointed)
> B) Lite besviken
> C) Inte besviken alls

**PMF-tröskel:** ≥40% svarar "Mycket besviken" bland aktiva användare (≥4 sessioner i månaden).

**Nuläge:** Vi är pre-PMF. Målsättning: nå ≥40% i Segment A senast Q1 2027.

---

## 3. Hypoteser om must-have use cases

Formulerade som falsifierbara påståenden. Vi körs in tills vi kan stryka eller bekräfta.

### H1 — Parallell fleet utan manuell koordination

> *"Operatörer som kör ≥3 agenter i parallell slutar använda Skynet om konflikthanterings- och merge-kön tas bort."*

**Testar:** Är konfliktfamiljer + HITL-inkorg det som låser upp fleet-drift, eller kör folk ändå aldrig mer än 1 agent i parallell?

**Indikatorer:** WAA >3 per aktiv användare, låg HITL-lösningstid på merge-conflict, hög merge-succesrate.

---

### H2 — Säker autonomi (agenter som inte babysittas)

> *"Operatörer aktiverar autonomy-toggle och lämnar agenter utan aktiv bevakning — och de litar på att safety-lagret (policy, blast-radius, injection-firewall) skyddar dem."*

**Testar:** Är det autonomy-tillståndet (let it run) eller hands-on-tillståndet (every gate) som ger värde? Är governance en feature eller ett hinder?

**Indikatorer:** Autonomy-on-andel >50%, låg escalation-frekvens, Sean Ellis "mycket besviken" refererar governance som anledning.

---

### H3 — Cross-vendor flexibilitet

> *"Operatörer väljer Skynet för att slippa vendor lock-in — de kör aktivt minst 2 olika runners (t.ex. Claude + Codex) i samma workspace."*

**Testar:** Är multi-vendor ett köpargument eller bara "nice to have"? Väljer folk oss just för detta?

**Indikatorer:** Andel workspaces med ≥2 konfigurerade runners. Intervjusvar om varför de valde Skynet.

---

### H4 — Audit + compliance som affärsmöjjligare

> *"Tech leads godkänner AI-driven coding för sin organisation BARA för att Skynet ger audit-trail och godkännandeflöde — utan det blockeras det av CISO/compliance."*

**Testar:** Är governance-wedgen ett starkt säljargument mot Segment C, eller är det främst ett retention-argument för Segment A?

**Indikatorer:** Intervjusvar om beslutsprocess. Hur många i Segment A vs C åberopar compliance som skäl.

---

### H5 — Memory som switching-cost

> *"Användare som har byggt upp ≥30 dagar av decisions i audit-trail uppvisar signifikant högre retention och lägre churn än de som inte nått det."*

**Testar:** Är det Memory-lagret som skapar den moat vi tror — eller är det enbart orchestration-värdet?

**Indikatorer:** Kohortanalys retention 30d+ vs <30d. Mätbart först Q2 2027 när vi har tillräcklig bas.

---

## 4. Intervjuguide — Segment A och B

**Format:** 30–40 min, video eller Slack-huddle, ej säljsamtal.
**Rekrytering:** Befintliga beta-användare (>3 sessioner), Discord/community, kalla kontakter via referral.
**Mål per månad:** 4–6 intervjuer, ej fler (kvalitet > kvantitet).

---

### Del 1: Kontext och problem (10 min)

1. Berätta hur ett typiskt veckodag ser ut när du arbetar med kodning idag — vilka AI-verktyg använder du?
2. Hur ofta kör du mer än ett agent-jobb i parallell? Vad händer när du gör det?
3. Berätta om senaste gången en agent skapade ett problem du fick städa upp. Vad gick fel?
4. Vad kostar dig mest tid/mental energi i din nuvarande AI-coding-setup?

*Lyssningsmål: Identifiera konkret smärta. Leta efter "jag slutade göra X pga…" och "jag fick manuellt…"*

---

### Del 2: Skynet-användning (10 min)

5. Berätta om de senaste 2–3 gångerna du använde Skynet — vad försökte du åstadkomma?
6. Vad fungerade precis som förväntat? Vad var förvånande (positivt eller negativt)?
7. Fanns det ett ögonblick då du tänkte "nu behöver jag inte göra det manuellt längre"? Berätta.
8. Vilken del av Skynet är du mest rädd att förlora?

*Lyssningsmål: Hitta det faktiska jobs-to-be-done. Notera ordvalen de använder för värde.*

---

### Del 3: PMF och alternativ (10 min)

9. Om Skynet försvann imorgon — hur besviken skulle du vara på en skala 1–10? Varför?
10. Vad skulle du göra istället? (Följdfråga: och hur mycket sämre är det alternativet?)
11. Vad saknar Skynet för att du ska köra det *varje dag* istället för ibland?
12. Har du rekommenderat Skynet till någon? Vad sa du?

*Lyssningsmål: Sean Ellis-mätvärdet, klar alternativ-analys, organisk viral-signal.*

---

### Del 4: Segmentkvalificering (5 min)

13. Hur stor är ditt team? Hur många AI-agent-sessioner per vecka kör ni totalt?
14. Vem bestämmer vilka dev-verktyg ni använder?
15. Är det viktigt för er att AI-genererade kodändringar är spårbara/godkända? Av vem?

*Lyssningsmål: Identifiera Segment A vs B vs C, budget-befogenhet, compliance-drivkraft.*

---

### Avslutning

- Är det ok om jag återkommer om en månad för en uppföljning?
- Känner du någon annan som borde använda Skynet — som jag borde prata med?

---

## 5. Feedback → backlogbeslut

### Insamlingsfrekvens och ägare

| Kanal | Frekvens | Ägare |
|-------|---------|-------|
| Intervjuer | 4–6/mån | PMF-ansvarig |
| Sean Ellis-enkät | Kvartal | PMF-ansvarig |
| Tier-1-mätvärden | Vecka | Tech lead |
| Churn-exit | Varje | Auto-trigger |
| Discord/community-signal | Löpande | Alla |

---

### Beslutsregler — hur signal blir backlog

**Regel 1: Friktionströskel → hög prioritet**
Om ≥3 intervjuer inom 60 dagar nämner *samma* friktionspunkt → direkt P0 i backloggen. Ingen vidare diskussion.

**Regel 2: Sean Ellis <40% → stopp för features, fokus på retention**
Om kvartalsmätningen visar <40% "mycket besviken" bland aktiva användare: frys nya features, lägg all kapacitet på att förstå och reparera de 3 vanligaste orsakerna till att folk inte är på nivå "mycket besviken".

**Regel 3: Hypotest bekräftad → investera djupare**
Om en hypotes (H1–H5) bekräftas av ≥3 intervjuer + kvantitativ korrelation → lägg den kategorin i nästa versionsplanering.

**Regel 4: Hypotest motbevisad → ta bort från roadmap**
Om en hypotes motbevisas av ≥3 intervjuer + negativt kvantitativt mönster → stryk det ur roadmap och frigör kapaciteten.

**Regel 5: Okänd smärta → ny hypotes**
Om ≥2 intervjuer nämner ett problem vi inte har en hypotes för → skapa H6+, lägg i nästa intervjuomgång, behandla inte som feature request förrän det är mönster.

**Regel 6: Autonomy-andel <30% efter 60 dagar → UX-diagnos**
Om <30% av aktiva projekt har autonomy-toggle på efter 60 dagars drift → intervjua specifikt om varför. Hypotes: governance-friktionfeel, inte manglande tillit till agenten.

---

### Backlog-hierarki

```
PMF-signal (intervju + mätvärde) → P0 (blockerar allt annat)
           ↓
Retentionsproblem i kohort-30 → P1 (nästa sprint)
           ↓
Onboarding-friktion (ny användare fastnar <dag 7) → P1
           ↓
Feature request utan PMF-stöd → P3 (direkta nej om <30% "mycket besviken")
           ↓
Teknisk skuld / refactor → P4 (om den inte orsakar PMF-smärta)
```

---

## 6. Första experimentlista

Experiment körs som tidsbegränsade satsningar med en definierad mätning. De är inte features — de är **lärinvesteringar**.

---

### EXP-01 — Onboarding-tid till första merge

**Hypotes:** En ny användare ska kunna nå sin första AI-driven merge på <20 minuter. Nuläge: okänt.

**Metod:** Shadowing av 5 nya användare (screen share) + mät tid mellan "öppna app" och "merge approved".

**Mätning:** Median tid. Identifiera de 3 stegen som tar längst tid.

**Beslut:** Om median >20 min → prioritera onboarding-flöde som P0 block for launch. Om <20 min → dokumentera och gå vidare.

**Tidsram:** 3 veckor.

---

### EXP-02 — Sean Ellis baseline-mätning

**Hypotes:** Vi vet inte om vi är på rätt spår. Vi behöver en baslinje.

**Metod:** Skicka Sean Ellis-enkät till alla användare med ≥4 sessioner (aktiva). Tre frågor: Sean Ellis-frågan, "vad använder du Skynet till mest?", "vad saknas för daglig användning?".

**Mätning:** % "mycket besviken". Öppna svar kategoriserade per tema.

**Beslut:** Om <20% → läs vad vi saknar, det är vår backlog. Om 20–40% → vi är på rätt spår, skala intervjuer. Om >40% → vi har PMF i aktiv kohort, fokusera på acquisition.

**Tidsram:** Starta nu. Resultat inom 4 veckor.

---

### EXP-03 — Fleet-storlek och parallellkörning

**Hypotes (H1):** Operatörer som kör ≥3 agenter i parallell har högre retention och Sean Ellis-score.

**Metod:** Analysera befintlig sessions-data: korrelera fleet-storlek (antal runners) med 30-dagars retention och Sean Ellis-score (när vi har det).

**Mätning:** Retention-kohort uppdelad på: 1 runner, 2 runners, ≥3 runners.

**Beslut:** Om stark korrelation → sätt "nå 3 runners" som ett onboarding-mål. Om ingen korrelation → H1 är svag, revidera.

**Tidsram:** 6 veckor (behöver kohortdata).

---

### EXP-04 — Autonomy-adoption

**Hypotes (H2):** Operatörer vill köra i autonomy-läge men törs inte. Onboarding eller UX blockerar.

**Metod:** Intervjua 4 användare som kör med autonomy OFF trots >10 sessioner. Fråga varför.

**Mätning:** Kategorisera svar: "törs inte" / "vet inte hur" / "det funkar dåligt" / "behöver det inte".

**Beslut:** Om "törs inte" dominerar → skärp governance-kommunikationen (policy-as-code, blast-radius-flaggar är synliga). Om "vet inte hur" → onboarding. Om "det funkar dåligt" → escalation-frekvens som P0.

**Tidsram:** 4 veckor.

---

### EXP-05 — Intervention vid churn (dag 14)

**Hypotes:** Användare som inte returnerar efter dag 14 har en specifik blockering vi kan åtgärda.

**Metod:** Automatisk exit-enkät (3 frågor) + manuell uppföljning av 5 churnade användare per månad.

**Mätning:** Churn-orsaker kategoriserade. Andel räddningsbara (teknisk friktion) vs strukturella (no fit).

**Beslut:** Om >50% churnar av teknisk friktion vi kan fixa → P0. Om >50% är "no fit" → segment-validering felaktig, revidera Segment A-definition.

**Tidsram:** Löpande från dag 1 av beta.

---

### EXP-06 — Compliance-köpargument (Segment C-sond)

**Hypotes (H4):** Audit-trail och compliance-pack är en dörröppnare mot tech leads och managers som annars blockerar AI-coding.

**Metod:** 3 intervjuer med tech leads / engineering managers (Segment C) som vi inte aktivt säljer till. Fråga om beslutsprocessen för AI-verktyg i deras org.

**Mätning:** Nämner de compliance/audit som krav? Är det en dealbreaker utan det?

**Beslut:** Om ≥2/3 säger "vi kan inte använda AI-coding utan audit-trail" → Segment C är snabbare att bearbeta än vi tror. Om de inte nämner det spontant → compliance är ett retention-argument, inte acquisition.

**Tidsram:** 5 veckor.

---

## 7. PMF-loop — rytm och ansvar

```
Vecka 1–2    Kör 2 intervjuer, läs Tier-1-mätvärden
Vecka 3      Synka PMF-signal → backlog-prioritering
Vecka 4      Starta/avsluta ett experiment baserat på senaste signal
─────────────────────────────────────────────────────
Kvartal      Kör Sean Ellis-enkät, granska hypoteser H1–H5
             Uppdatera detta dokument: bekräftade/motbevisade hypoteser
             Revidera segmentprioritering om signal kräver det
```

**Ägarskap:** PMF-ansvarig (1 person, kan vara grundare) äger loopen. Tech lead äger Tier-1-mätvärden. Alla i teamet kan lägga till intervjunoteringar.

**"Definition of PMF":** ≥40% "mycket besviken" i Sean Ellis bland aktiva användare (≥4 sessioner/månaden) i Segment A, med stabil 30-dagars retention >25% och WAA ≥3.

---

*Dokument ägt av PMF-ansvarig. Uppdateras kvartalsvis eller när en hypotes bekräftas/motbevisas.*
