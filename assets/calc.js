/* Page wiring for the industrial electricity bill decoder.
   Every rule and every rupee is computed in engine.js; this file reads the
   form, calls the engine and writes the result. No network, no eval, and no
   inline styles — showing and hiding a field uses the `hidden` attribute,
   because the page's Content-Security-Policy forbids inline style outright. */
(function () {
  "use strict";

  var E = window.BillDecoder;
  if (!E) return;

  /* ---------------- formatting ---------------- */

  var money0 = new Intl.NumberFormat("en-IN", {
    style: "currency", currency: "INR", maximumFractionDigits: 0
  });
  var money2 = new Intl.NumberFormat("en-IN", {
    style: "currency", currency: "INR", minimumFractionDigits: 2, maximumFractionDigits: 2
  });
  var num2 = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });
  /* Power factors read as a pair, so they are always shown to 2 decimals. */
  var pfNum = new Intl.NumberFormat("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 3 });
  var num0 = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });

  var DASH = "—";

  /* Money that is genuinely unknown prints a dash. Money that is zero prints
     zero. Neither prints NaN. */
  function rupees(n) {
    if (n === null || n === undefined) return DASH;
    if (typeof n !== "number" || !isFinite(n)) return DASH;
    return money0.format(n);
  }
  function rupeesExact(n) {
    if (n === null || n === undefined || typeof n !== "number" || !isFinite(n)) return DASH;
    return money2.format(n);
  }
  function qty(n) {
    if (n === null || n === undefined || typeof n !== "number" || !isFinite(n)) return DASH;
    return num2.format(n);
  }
  function whole(n) {
    if (n === null || n === undefined || typeof n !== "number" || !isFinite(n)) return DASH;
    return num0.format(n);
  }
  function pf2(n) {
    if (n === null || n === undefined || typeof n !== "number" || !isFinite(n)) return DASH;
    return pfNum.format(n);
  }
  function pct(n) {
    if (n === null || n === undefined || typeof n !== "number" || !isFinite(n)) return DASH;
    return num2.format(n) + "%";
  }
  function months(n) {
    if (n === null || n === undefined || typeof n !== "number" || !isFinite(n)) return DASH;
    if (n < 1) return "under a month";
    if (n < 24) return num2.format(n) + " months";
    return num2.format(n / 12) + " years";
  }

  /* ---------------- element lookup ---------------- */

  function el(id) { return document.getElementById(id); }

  /* Every number field, and the engine key it feeds. */
  var NUMBERS = {
    "contract-demand": "contractDemand",
    "recorded-md": "recordedMd",
    "peak-md-12m": "annualPeakMd",
    "demand-rate": "demandRate",
    "penal-multiple": "penalMultiple",
    "min-bill-pct": "minBillPct",
    "cd-step": "cdStep",
    "headroom-pct": "headroomPct",
    "cd-revision-cost": "cdRevisionCost",
    "pf-now": "pfNow",
    "pf-target": "pfTarget",
    "pf-penalty-pct": "pfPenaltyPctPerPoint",
    "pf-incentive-pct": "pfIncentivePctPerPoint",
    "pf-cap-pct": "pfCapPct",
    "sizing-kw": "sizingKw",
    "cap-cost-per-kvar": "capCostPerKvar",
    "cap-fixed-cost": "capFixedCost",
    "base-rate": "baseRate",
    "tod-peak-pct": "todPeakPct",
    "tod-offpeak-pct": "todOffPeakPct",
    "rate-offpeak": "rateOffPeak",
    "rate-normal": "rateNormal",
    "rate-peak": "ratePeak",
    "units-offpeak": "unitsOffPeak",
    "units-normal": "unitsNormal",
    "units-peak": "unitsPeak",
    "shift-kwh": "shiftKwh",
    "fppca-rate": "fppcaRate",
    "duty-pct": "dutyPct",
    "other-charges": "otherCharges"
  };
  var NUMBER_IDS = Object.keys(NUMBERS);

  /* The segmented controls: one pressed button each. */
  var SEGS = [
    { id: "unit-seg", attr: "data-unit", key: "demandUnit" },
    { id: "pf-step-seg", attr: "data-pfstep", key: "pfStep" },
    { id: "pf-base-seg", attr: "data-pfbase", key: "pfBase" },
    { id: "tod-seg", attr: "data-tod", key: "todMode" },
    { id: "shift-seg", attr: "data-shift", key: "shiftTo" }
  ];

  var state = {};
  var initialState = {};
  var initialNumbers = {};

  function segValue(seg) {
    var box = el(seg.id);
    if (!box) return null;
    var pressed = box.querySelector("button[aria-pressed=true]");
    var first = box.querySelector("button[" + seg.attr + "]");
    var node = pressed || first;
    return node ? node.getAttribute(seg.attr) : null;
  }

  function setSeg(seg, value) {
    var box = el(seg.id);
    if (!box) return;
    var buttons = box.querySelectorAll("button[" + seg.attr + "]");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute("aria-pressed", buttons[i].getAttribute(seg.attr) === value ? "true" : "false");
    }
    state[seg.key] = value;
  }

  /* ---------------- reading the form ---------------- */

  function readInput() {
    var out = {};
    NUMBER_IDS.forEach(function (id) {
      var node = el(id);
      /* The raw string goes to the engine: it decides what blank means, and
         for power factor blank must stay distinguishable from zero. */
      out[NUMBERS[id]] = node ? node.value : "";
    });
    SEGS.forEach(function (seg) { out[seg.key] = state[seg.key]; });
    return out;
  }

  /* ---------------- labels that follow the mode ---------------- */

  function applyUnit() {
    var unit = state.demandUnit === "kW" ? "kW" : "kVA";
    ["suf-cd", "suf-md", "suf-peak", "suf-step"].forEach(function (id) {
      var node = el(id);
      if (node) node.textContent = unit;
    });
    var rate = el("suf-rate");
    if (rate) rate.textContent = "/" + unit;
  }

  function applyTodMode() {
    var direct = state.todMode === "direct";
    ["f-base-rate", "f-tod-pct"].forEach(function (id) {
      var node = el(id);
      if (node) node.hidden = direct;
    });
    var d = el("f-direct-rates");
    if (d) d.hidden = !direct;
  }

  /* ---------------- table rendering ---------------- */

  function row(tbody, label, value, opts) {
    opts = opts || {};
    var tr = document.createElement("tr");
    if (opts.total) tr.className = "total";
    else if (opts.sub) tr.className = "sub";
    var th = document.createElement("td");
    th.textContent = label;
    var td = document.createElement("td");
    td.className = opts.negative ? "num neg" : "num";
    td.textContent = value === undefined || value === null ? DASH : value;
    tr.appendChild(th);
    tr.appendChild(td);
    tbody.appendChild(tr);
    return tr;
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
  }

  /* ---------------- the bill, line by line ---------------- */

  function renderBill(r) {
    var tbody = el("r-bill");
    if (!tbody) return;
    clear(tbody);

    var b = r.current;
    var d = b.demand;
    var unit = r.unit;

    row(tbody,
      "Demand charge, " + qty(d.normalBillable) + " " + unit + " at " + rupeesExact(d.rate),
      rupees(d.normalCharge));
    row(tbody,
      "Recorded MD " + qty(d.recordedMd) + " " + unit + " · contract " + qty(d.contractDemand) +
      " " + unit + " · minimum billing " + qty(d.minBillPct) + "% = " + qty(d.minBillFloor) + " " + unit,
      d.utilisationPct === null ? DASH : pct(d.utilisationPct) + " of contract",
      { sub: true });

    if (d.excess > 0) {
      row(tbody,
        "Demand above contract, " + qty(d.excess) + " " + unit + " at " + qty(d.penalMultiple) + "× the rate",
        rupees(d.penalCharge), { negative: true });
      row(tbody, "of which penal premium, over and above the normal rate",
        rupees(d.penalPremium), { sub: true, negative: true });
    }
    if (d.idleCapacity > 0) {
      row(tbody,
        "of which " + qty(d.idleCapacity) + " " + unit + " of contract capacity never drawn",
        rupees(d.idleCost), { sub: true, negative: true });
    }

    b.tod.slabs.forEach(function (s) {
      row(tbody,
        "Energy, " + s.label.toLowerCase() + " · " + whole(s.units) + " kWh at " + rupeesExact(s.rate),
        rupees(s.charge));
    });
    row(tbody,
      "Total " + whole(b.totalUnits) + " kWh · peak share " +
      (r.diagnostics.peakSharePct === null ? DASH : pct(r.diagnostics.peakSharePct)),
      b.tod.blendedRate === null ? DASH : rupeesExact(b.tod.blendedRate) + "/kWh",
      { sub: true });

    row(tbody,
      "Fuel / power-purchase adjustment, " + whole(b.totalUnits) + " kWh at " + rupeesExact(b.fppcaRate),
      rupees(b.fppca));

    if (!b.pf.ok) {
      row(tbody, "Power-factor adjustment — input refused, see above", DASH);
    } else if (b.pf.direction === "surcharge") {
      row(tbody,
        "Power-factor surcharge, " + qty(b.pf.points) + " × " + qty(b.pf.pctPerPoint) +
        "% = " + qty(b.pf.pct) + "% of " + b.pf.baseLabel + (b.pf.capped ? " (capped)" : ""),
        rupees(b.pf.amount), { negative: true });
      row(tbody,
        "Power factor " + pf2(b.pf.pfNow) + " against a target of " + pf2(b.pf.pfTarget) +
        " \u00b7 surcharge taken on",
        rupees(b.pf.base), { sub: true });
    } else if (b.pf.direction === "rebate") {
      row(tbody,
        "Power-factor rebate, " + qty(b.pf.points) + " × " + qty(b.pf.pctPerPoint) +
        "% = " + qty(b.pf.pct) + "% of " + b.pf.baseLabel,
        rupees(b.pf.amount));
    } else {
      row(tbody, "Power factor exactly at target — no surcharge, no rebate", rupees(0));
    }

    if (b.other !== 0) row(tbody, "Other charges on the bill", rupees(b.other));

    row(tbody, "Subtotal before duty", rupees(b.subtotal));
    row(tbody, "Electricity duty at " + qty(b.dutyPct) + "%", rupees(b.duty));
    row(tbody, "All-in cost per unit on this bill",
      b.avgRatePerUnit === null ? DASH : rupeesExact(b.avgRatePerUnit) + "/kWh", { sub: true });
    row(tbody, "Bill total", rupees(b.total), { total: true });
  }

  /* ---------------- where the avoidable money is ---------------- */

  function renderAttribution(r) {
    var tbody = el("r-attrib");
    if (!tbody) return;
    clear(tbody);

    var g = r.diagnostics;
    var unit = r.unit;

    row(tbody,
      "Demand-exceedance penal premium" +
      (r.current.demand.excess > 0 ? " on " + qty(r.current.demand.excess) + " " + unit : ""),
      rupees(g.exceedancePremium), { negative: g.exceedancePremium > 0 });
    row(tbody,
      "Contract capacity paid for and never drawn" +
      (g.idleCapacity > 0 ? ", " + qty(g.idleCapacity) + " " + unit : ""),
      rupees(g.idleCapacityCost), { negative: g.idleCapacityCost > 0 });
    row(tbody,
      r.powerFactorPlan.usable ? "Power-factor surcharge" : "Power-factor surcharge — input refused",
      r.powerFactorPlan.usable ? rupees(g.pfSurcharge) : DASH,
      { negative: g.pfSurcharge > 0 });
    if (g.pfRebate > 0) {
      row(tbody, "Power-factor rebate already being earned", rupees(g.pfRebate), { sub: true });
    }
    row(tbody,
      "Peak premium on the " + whole(r.timeOfDayPlan.moved) + " kWh you could shift",
      rupees(g.peakPremiumOnShiftable), { negative: g.peakPremiumOnShiftable > 0 });

    row(tbody, "Listed items overlap — use the combined figure below, not their sum", "", { sub: true });
    row(tbody, "Combined: this bill against the same bill with every change applied",
      rupees(r.savings.combinedMonthly), { total: true });
    row(tbody, "The same over twelve months", rupees(r.savings.combinedAnnual), { sub: true });
  }

  /* ---------------- what to do about it ---------------- */

  function renderActions(r) {
    var tbody = el("r-actions");
    if (!tbody) return;
    clear(tbody);

    var unit = r.unit;
    var cd = r.demandRecommendation;
    var pf = r.powerFactorPlan;
    var tod = r.timeOfDayPlan;

    /* --- contract demand --- */
    if (cd.direction === "unchanged") {
      row(tbody, "Contract demand of " + qty(r.resolved.contractDemand) + " " + unit +
        " already matches your demand on record", rupees(0));
    } else {
      row(tbody,
        (cd.direction === "reduce" ? "Reduce" : "Raise") + " contract demand from " +
        qty(r.resolved.contractDemand) + " to " + qty(cd.asIs.recommended) + " " + unit,
        rupees(r.levers.contractDemand.monthly));
      row(tbody,
        "Covers your " + qty(cd.asIs.peakConsidered) + " " + unit + " peak (" + cd.asIs.peakSource +
        ") plus " + qty(cd.asIs.headroomPct) + "% headroom, rounded up to " + qty(cd.asIs.step) + " " + unit,
        "", { sub: true });
      if (r.resolved.cdRevisionCost > 0) {
        row(tbody, "One-time cost of the revision, " + rupees(r.resolved.cdRevisionCost) + ", pays back in",
          cd.payback.ok ? months(cd.payback.months) : "no payback at this saving", { sub: true });
      }
    }
    if (pf.improves && cd.afterPf.recommended !== cd.asIs.recommended) {
      row(tbody, "Once power factor is corrected, " + qty(cd.afterPf.recommended) + " " + unit +
        " would be enough — apply for that only after the bank is proven", "", { sub: true });
    }

    /* --- power factor --- */
    if (!pf.usable) {
      row(tbody, "Fix the power-factor input before a capacitor can be sized", DASH);
    } else if (!pf.improves) {
      row(tbody, "Power factor " + pf2(pf.pfNow) + " is already at or above the " + pf2(pf.pfTarget) +
        " target — no capacitor needed", rupees(0));
    } else {
      row(tbody,
        "Fit an APFC bank of " + qty(pf.capacitor.kvar) + " kVAR to move power factor from " +
        pf2(pf.pfNow) + " to " + pf2(pf.pfTarget),
        rupees(r.levers.powerFactor.monthly));
      row(tbody,
        "Sized on " + qty(pf.kwForSizing) + " kW (" + pf.capacitor.kwBasis + ") · " +
        qty(pf.capacitor.kvar) + " kVAR at " + rupees(pf.capacitor.costPerKvar) + " plus " +
        rupees(pf.capacitor.fixedCost) + " fitted",
        rupees(pf.capacitor.totalCost) + " once", { sub: true });
      row(tbody, "Payback on that outlay",
        pf.payback.ok ? months(pf.payback.months) : "no payback at this saving", { sub: true });
      if (pf.mdReduction > 0) {
        row(tbody, "Billed demand falls " + qty(pf.mdReduction) + " " + unit + " to " +
          qty(pf.mdImproved) + " " + unit + " at the same real load", "", { sub: true });
      } else {
        row(tbody, "Demand is billed in kW, so correction changes no demand charge — only the surcharge",
          "", { sub: true });
      }
    }

    /* --- time of day --- */
    if (tod.applied > 0) {
      row(tbody,
        "Shift " + whole(tod.applied) + " kWh out of peak into the " + tod.destinationLabel.toLowerCase() + " slab",
        rupees(r.levers.timeOfDay.monthly));
      row(tbody,
        "Peak " + rupeesExact(tod.peakRate) + "/kWh against " + rupeesExact(tod.destRate) +
        "/kWh — a gap of " + rupeesExact(tod.savingPerKwh),
        "", { sub: true });
    } else if (tod.requested > 0) {
      row(tbody, "No worthwhile peak shift at these rates", rupees(0));
    } else {
      row(tbody, "Enter the units you could move out of peak to cost a load shift", DASH);
    }

    row(tbody, "Everything above, applied together", rupees(r.savings.combinedMonthly), { total: true });
  }

  /* ---------------- errors and warnings ---------------- */

  function renderIssues(r) {
    var box = el("r-issues");
    var body = el("r-issues-body");
    if (!box || !body) return;
    var items = r.errors.concat(r.warnings);
    if (!items.length) {
      box.hidden = true;
      body.textContent = "";
      return;
    }
    clear(body);
    items.forEach(function (it, i) {
      var p = document.createElement("div");
      p.textContent = (r.errors.length && i < r.errors.length ? "Check this: " : "Note: ") + it.message;
      body.appendChild(p);
    });
    box.hidden = false;
  }

  /* ---------------- the headline ---------------- */

  function renderPrimary(r) {
    var k = el("r-key"), v = el("r-value"), sub = el("r-sub");
    if (!k || !v || !sub) return;

    if (r.errors.length) {
      var blocking = r.errors.filter(function (e) { return e.code.indexOf("PF_") === 0; });
      k.textContent = blocking.length
        ? "Avoidable on this month's bill, power factor excluded"
        : "Avoidable on this month's bill, incomplete inputs";
    } else {
      k.textContent = "Avoidable on this month's bill";
    }

    v.textContent = rupees(r.savings.headlineMonthly);

    var parts = [];
    parts.push(rupees(r.savings.headlineAnnual) + " a year");
    parts.push("bill as entered " + rupees(r.current.total));
    if (r.savings.combinedMonthly < 0) {
      parts.push("the changes would cost " + rupees(-r.savings.combinedMonthly) + " more this month — see the note");
    }
    sub.textContent = parts.join(" · ");
  }

  /* ---------------- recompute ---------------- */

  function recompute() {
    var r = E.compute(readInput());
    renderPrimary(r);
    renderIssues(r);
    renderBill(r);
    renderAttribution(r);
    renderActions(r);
  }

  /* ---------------- wiring ---------------- */

  function wire() {
    SEGS.forEach(function (seg) {
      var box = el(seg.id);
      if (!box) return;
      state[seg.key] = segValue(seg);
      initialState[seg.key] = state[seg.key];
      box.addEventListener("click", function (ev) {
        var btn = ev.target && ev.target.closest
          ? ev.target.closest("button[" + seg.attr + "]")
          : null;
        if (!btn) return;
        setSeg(seg, btn.getAttribute(seg.attr));
        if (seg.key === "demandUnit") applyUnit();
        if (seg.key === "todMode") applyTodMode();
        recompute();
      });
    });

    NUMBER_IDS.forEach(function (id) {
      var node = el(id);
      if (!node) return;
      initialNumbers[id] = node.getAttribute("value") || "";
      node.addEventListener("input", recompute);
    });

    var printBtn = el("print");
    if (printBtn) printBtn.addEventListener("click", function () { window.print(); });

    var resetBtn = el("reset");
    if (resetBtn) {
      resetBtn.addEventListener("click", function () {
        NUMBER_IDS.forEach(function (id) {
          var node = el(id);
          if (node) node.value = initialNumbers[id];
        });
        SEGS.forEach(function (seg) { setSeg(seg, initialState[seg.key]); });
        applyUnit();
        applyTodMode();
        recompute();
      });
    }
  }

  wire();
  applyUnit();
  applyTodMode();
  recompute();
})();
