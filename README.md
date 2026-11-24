# Factory electricity bill decoder — maximum demand and power-factor penalties

A single-page, dependency-free web tool that decodes an Indian HT or LT industrial
electricity bill and separates what you had to pay from what you did not.

You enter one month's figures. It returns:

- **The demand charge, split three ways** — the part billed at the normal rate, the
  part billed penally because recorded maximum demand crossed your contract demand,
  and the part you pay under the minimum-billing clause for contract capacity that
  was never drawn.
- **A revised contract demand**, covering the worst demand you have on record plus
  your chosen headroom, rounded up to the step your licensee accepts — with the
  monthly and annual saving (or, where raising the contract to cover a seasonal
  spike would cost more than the penalty it removes, that finding instead).
- **The power-factor surcharge or rebate** against the target in your tariff, and
  **the capacitor bank that clears it**: the kVAR to fit, what it costs at your
  installer's rate, and the payback in months against the monthly saving.
- **Time-of-Day**: units and charge slab by slab, and the saving from moving a given
  load out of the peak slab.

Everything runs in the browser. Nothing is uploaded, stored or sent anywhere.

## Who it is for

Small and medium factory owners, plant managers and in-house electricians on an
HT or LT industrial connection — the people who get a dense multi-page bill every
month, suspect they are paying penalties, and have no way to see which lines are
avoidable or what a capacitor bank would actually be worth.

## Named regulation

**The Electricity Act 2003 (36 of 2003)** — section 62 (tariff is determined by the
State Commission), section 61 (the terms it specifies), section 86(1)(a) (the
Commission's function). The clauses that do the billing — maximum demand, the
exceedance penalty, minimum billing, the power-factor surcharge and rebate and the
Time-of-Day slabs — are not in the Act. They live in your distribution licensee's
tariff schedule and its general terms and conditions of supply, reissued with every
tariff order, and your contract demand is a figure in your own agreement for supply.

## No tariff table is shipped. On purpose.

Industrial tariffs in India are determined state by state and revised roughly every
year. The demand rate, the penal multiple on excess demand, the minimum-billing
percentage, the power-factor target and the Time-of-Day slabs all differ between
states and between tariff years.

So **every rate, slab, multiple, percentage and target in this tool is a field you
fill in.** The numbers the page opens with are round, obviously-round placeholders
whose only job is to make a worked example legible before you type. They are
collected in one named-constants block at the top of `assets/engine.js`, labelled
`INDICATIVE_PLACEHOLDER_DEFAULTS`, and they belong to no state.

**Read your own figures off your own bill and your DISCOM's current tariff order.**
A table of state rates baked into a tool goes stale within a year and then produces
confident wrong rupees on a real bill, which is worse than producing nothing.

## The formulas

**Billing demand.** Billed at the normal rate:
`max( min(recorded MD, contract demand), contract demand × minimum% )`.
Plus, at the penal multiple: `max(0, recorded MD − contract demand)`.
The avoidable part of the penalty is the premium over the normal rate,
`excess × rate × (multiple − 1)`; the rest is electricity you used.
The idle-capacity cost is `max(0, contract × minimum% − recorded MD) × rate`.

**Power factor.** The shortfall is counted in 0.01 steps below the target —
whole completed steps by default, pro rata if your tariff is worded that way —
and charged as a percentage of the demand charge, the energy charge, or both,
whichever your tariff says, with an optional cap.

**Capacitor sizing.**

```
kVAR = kW × ( tan(acos(PF_now)) − tan(acos(PF_target)) )
```

At 100 kW moving from 0.80 to 0.95: `100 × (0.75 − 0.3287) = 42.13 kVAR`.
The `kW` is the real load behind your recorded peak, which is
`recorded MD × recorded PF` on a kVA-billed tariff, or the figure you enter.
Payback is `(kVAR × cost per kVAR + fitting cost) ÷ monthly saving`.

**Time-of-Day shifting.** `units moved × (peak rate − destination rate)`, capped at
the units actually billed in the peak slab.

**The headline.** The whole bill is rebuilt twice — once as entered, once with every
recommendation applied — and the headline is the difference between those two
complete bills. The three levers interact (correcting power factor shrinks the kVA
peak, which changes what contract demand you need, which changes the minimum-billing
floor), so the per-lever figures are shown as attribution and the combined figure is
the one to rely on. The tool says so on screen when they diverge.

## Guards

The arithmetic refuses rather than guesses:

- **Power factor must lie in (0, 1].** Above 1, `acos` is undefined and every rupee
  downstream becomes `NaN`. At exactly 0, worse: `tan(acos(0))` evaluates in binary
  floating point to about 1.6 × 10<sup>16</sup> — a finite, plausible-looking number
  that would size a bank sixteen quadrillion kVAR large. Both are refused by name,
  and the demand and energy lines still decode.
- **A target at or below the current power factor** needs no capacitor, and the tool
  says so instead of returning a negative bank size.
- **Zero contract demand** is flagged as a missing input, not divided by: there is no
  measurable exceedance without a contract, so no penalty is invented.
- **Zero units, zero demand, zero rates** produce zeroes. Ratios with no denominator
  — utilisation with no contract demand, a rate per unit with no units — print a dash.
- **No payback** where there is no monthly saving, rather than infinity.
- A penal multiple below 1 is read as 1, a minimum-billing percentage outside 0–100 is
  bounded, negative rates and units are read as zero, duty is never charged on a
  negative subtotal, and whole 0.01 power-factor steps are computed through a rounding
  guard — without it, `(0.95 − 0.87) × 100` is `7.9999999999999964` and a naive floor
  under-states the surcharge by a whole point.

## Layout

```
index.html              the tool and its own explainer
assets/engine.js        all the rules and arithmetic — pure, no DOM, no network
assets/calc.js          reads the form, calls the engine, writes the result
assets/accent.css       one line: the accent colour
assets/style.css        shared design system
tests/engine.test.js    table-driven tests over engine.js
```

## How to run

```sh
python3 -m http.server 8137
```

Then open `http://localhost:8137/`. Any static file server works; there is no build
step, no package manager and no dependency to install. If port 8137 is busy, pick
another: `python3 -m http.server 8140`.

## Tests

```sh
node --test
```

50 tests, no framework to install — `node:test` ships with Node. They cover the
capacitor formula against values computed by hand from the 3-4-5 triangle and surds,
the same formula cross-checked against the independent `sqrt(kVA² − kW²)` route, the
demand-billing split in both directions, the floating-point guard on 0.01 power-factor
steps, every refusal path, and a sweep asserting that no scenario — blank form, all
zeroes, negatives, text in number fields, inverted Time-of-Day rates — produces a
single `NaN` or `Infinity` anywhere in the result.

## Honesty about scope and accuracy

This is a decoder and a planning aid. It is not a bill, not an audit and not advice.

It arithmetic-checks the figures **you** type against the rules **you** enter. It
cannot know your tariff, it does not read your bill, and it ships no state rates.
Before acting on any number here, confirm the demand rate, the penal multiple, the
minimum-billing percentage and the power-factor clause against your distribution
licensee's current tariff order, and confirm your contract demand against your
agreement for supply.

Two things here are models rather than readings. Correcting power factor is assumed
to shrink the recorded kVA peak in the ratio `PF_now / PF_target` at constant real
power, and the 12-month peak is assumed to improve in the same ratio; real plant
varies, the peak may occur at a different power factor from the monthly average, and
a bank that switches correctly at full load may over-compensate at light load. On a
kW-billed tariff, correction changes no demand charge at all, and the tool shows no
reduction.

Revising contract demand is a formal application with its own charges, notice period
and limits on how often it can be done. Capacitor sizing for an actual installation
needs a load study, a harmonic assessment and a licensed contractor — the figure here
is for deciding whether to commission one, not for placing the order.

MIT licensed.
