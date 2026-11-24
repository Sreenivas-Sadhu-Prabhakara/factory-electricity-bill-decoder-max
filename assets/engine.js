/* HT/LT industrial electricity bill decoder — pure arithmetic.
   No DOM, no network, no dependencies. Loaded in the browser as
   window.BillDecoder and exported as a CommonJS module, so tests/ exercise
   exactly the code the page runs.

   ------------------------------------------------------------------------
   WHY THERE IS NO TARIFF TABLE IN THIS FILE
   ------------------------------------------------------------------------
   Industrial tariffs in India are determined state by state, by each State
   Electricity Regulatory Commission, and revised roughly every year. The
   demand rate, the penal multiple on excess demand, the minimum-billing
   percentage, the power-factor target and the Time-of-Day slabs all differ
   between states and between tariff years. A hard-coded table would quietly
   go stale and then produce confident wrong rupees on a real bill.

   So: every rate, slab, multiple, percentage and target is a USER INPUT.
   The only numbers in this file are the indicative placeholder defaults in
   the single DEFAULTS block below — round, obviously-round numbers whose job
   is to make the page legible before the user types, not to be right.
   Read them off your own bill and your own DISCOM's current tariff order.
   ------------------------------------------------------------------------ */
(function (root) {
  "use strict";

  /* ================================================================== *
   * 1. THE ONE NAMED-CONSTANTS BLOCK
   *    Indicative placeholders only. Not a tariff. Not any state's rates.
   * ================================================================== */

  var DEFAULTS = {
    id: "INDICATIVE_PLACEHOLDER_DEFAULTS",
    status:
      "INDICATIVE PLACEHOLDERS — these are NOT any state's tariff and NOT a " +
      "forecast. They exist so the page shows a worked example before you type. " +
      "Replace every one of them with the figure printed on your own bill or in " +
      "your DISCOM's current tariff order.",
    readInstead:
      "Your distribution licensee's tariff order / Schedule of Tariff for the " +
      "current year, as approved by your State Electricity Regulatory Commission, " +
      "together with the licensee's General Terms and Conditions of Supply and " +
      "your own agreement for supply (which is where contract demand is fixed).",
    checkedOn: "2026-11",

    /* --- demand --- */
    demandUnit: "kVA",             /* kVA or kW — which one your tariff bills */
    contractDemand: 1000,          /* kVA — from the supply agreement */
    recordedMd: 1150,              /* kVA — this month's recorded maximum demand */
    annualPeakMd: 1180,            /* kVA — highest MD in the last 12 months */
    demandRate: 400,               /* currency per kVA (or kW) per month */
    penalMultiple: 2,              /* x normal rate, on demand above contract */
    minBillPct: 75,                /* % of contract demand, minimum billable */
    cdStep: 5,                     /* revised contract demand rounds up to this */
    headroomPct: 10,               /* % headroom over peak when revising CD */
    cdRevisionCost: 0,             /* one-time cost of revising contract demand */

    /* --- power factor --- */
    pfNow: 0.84,                   /* recorded average power factor */
    pfTarget: 0.95,                /* the tariff's target / threshold PF */
    pfPenaltyPctPerPoint: 1,       /* % surcharge per 0.01 below target */
    pfIncentivePctPerPoint: 0.5,   /* % rebate per 0.01 above target */
    pfCapPct: 0,                   /* max adjustment %, 0 = uncapped */
    pfStep: "completed",           /* completed = whole 0.01 steps, or prorata */
    pfBase: "both",                /* energy | demand | both */
    sizingKw: 0,                   /* kW for capacitor sizing, 0 = derive */
    capCostPerKvar: 600,           /* installed cost per kVAR */
    capFixedCost: 25000,           /* panel + installation, one time */

    /* --- energy and Time-of-Day --- */
    todMode: "percent",            /* percent = % of base rate, or direct */
    baseRate: 8,                   /* currency per kWh, normal slab */
    unitsOffPeak: 60000,
    unitsNormal: 190000,
    unitsPeak: 90000,
    todPeakPct: 20,                /* + % on base, peak slab */
    todOffPeakPct: -10,            /* + % on base, off-peak slab (negative) */
    rateNormal: 8,                 /* direct mode only */
    ratePeak: 9.6,                 /* direct mode only */
    rateOffPeak: 7.2,              /* direct mode only */
    shiftKwh: 30000,               /* units you could move out of peak */
    shiftTo: "offpeak",            /* offpeak | normal */

    /* --- other bill lines --- */
    fppcaRate: 0.5,                /* fuel / power-purchase adjustment per kWh */
    dutyPct: 9,                    /* electricity duty / tax on sale, % */
    otherCharges: 5000            /* meter rent, arrears, lump-sum lines */
  };

  /* The statutory frame. Sections, not numbers — these do not change annually. */
  var LEGAL_FRAME = {
    act: "The Electricity Act 2003 (36 of 2003)",
    tariffRegulations: "Section 61 — the Commission specifies the tariff terms",
    tariffDetermination: "Section 62 — tariff is determined by the Commission",
    commissionFunction:
      "Section 86(1)(a) — the State Commission determines the tariff for " +
      "generation, supply, transmission and wheeling within the state",
    whereTheClausesLive:
      "Maximum demand, exceedance penalty, minimum billing, power-factor " +
      "surcharge/rebate and Time-of-Day slabs are clauses of the licensee's " +
      "tariff schedule and its General Terms and Conditions of Supply, not of " +
      "the Act. They are reissued with every tariff order.",
    thereforeNoTable:
      "Tariff figures are state-specific and change annually, so none are " +
      "shipped with this tool."
  };

  /* ================================================================== *
   * 2. NUMERIC HELPERS
   * ================================================================== */

  /* Any blank, text or non-finite input reads as 0. Nothing downstream ever
     sees NaN or Infinity, so nothing downstream can render one. */
  function fin(v) {
    var n = typeof v === "number" ? v : parseFloat(v);
    return isFinite(n) ? n : 0;
  }
  function nonNeg(v) {
    var n = fin(v);
    return n > 0 ? n : 0;
  }
  /* Kill binary-floating-point dust before a floor() or a ceil() reads it.
     (0.95 - 0.87) * 100 is 7.999999999999996; floored naively that is 7
     completed points of power-factor shortfall instead of 8. */
  function round6(n) {
    var v = fin(n);
    return Math.round(v * 1e6) / 1e6;
  }
  function r2(n) {
    return Math.round(fin(n) * 100) / 100;
  }
  function clamp(n, lo, hi) {
    var v = fin(n);
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
  }
  function safeDiv(a, b) {
    var x = fin(a), y = fin(b);
    if (y === 0) return null;
    var q = x / y;
    return isFinite(q) ? q : null;
  }

  /* ================================================================== *
   * 3. POWER FACTOR — validation and trigonometry
   *
   *    acos() is only defined on [-1, 1]. A power factor above 1 makes
   *    acos() return NaN and every rupee downstream becomes NaN. A power
   *    factor of exactly 0 is worse than NaN: acos(0) is pi/2 and
   *    tan(pi/2) evaluates to 1.6331e16 in binary floating point rather
   *    than Infinity, so an unguarded formula returns a finite, plausible-
   *    looking, catastrophically wrong capacitor size. Both are refused.
   * ================================================================== */

  var PF_RULES = {
    id: "POWER_FACTOR_DOMAIN",
    mustBeGreaterThan: 0,
    mustBeAtMost: 1,
    note:
      "Power factor is cos(phi) and lies in (0, 1]. A meter cannot read above " +
      "unity; a reading above 1 is a units mistake (95 entered for 0.95) or a " +
      "leading power factor recorded without its sign.",
    lowPfConcern: 0.5,
    lowPfNote:
      "Below about 0.5 most supply codes stop surcharging and start talking " +
      "about disconnection. Re-read the figure before trusting it."
  };

  function pfCheck(value, field) {
    var raw = typeof value === "number" ? value : parseFloat(value);
    if (!isFinite(raw)) {
      return {
        ok: false, field: field, code: "PF_NOT_A_NUMBER",
        message: "Power factor is blank or not a number. Enter it as a decimal between 0 and 1, for example 0.86."
      };
    }
    if (raw > PF_RULES.mustBeAtMost) {
      return {
        ok: false, field: field, code: "PF_ABOVE_UNITY",
        message: "Power factor " + raw + " is above 1, which no meter can record. If your bill shows 86 or 86%, enter 0.86."
      };
    }
    if (raw <= PF_RULES.mustBeGreaterThan) {
      return {
        ok: false, field: field, code: "PF_NOT_POSITIVE",
        message: "Power factor " + raw + " is zero or negative. It must be greater than 0 — a zero power factor means no real power at all, and the capacitor formula has no answer there."
      };
    }
    return { ok: true, pf: raw, field: field };
  }

  /* tan(phi) where phi = acos(PF). Refuses outside the domain. */
  function tanPhi(value, field) {
    var c = pfCheck(value, field);
    if (!c.ok) return c;
    var phi = Math.acos(c.pf);
    var t = Math.tan(phi);
    if (!isFinite(phi) || !isFinite(t)) {
      return {
        ok: false, field: field, code: "PF_DEGENERATE",
        message: "Power factor " + c.pf + " has no finite reactive component. Check the figure."
      };
    }
    return {
      ok: true, pf: c.pf, field: field,
      radians: phi, degrees: phi * 180 / Math.PI, tan: t
    };
  }

  /* ------------------------------------------------------------------ *
   * THE CAPACITOR FORMULA, implemented exactly as stated:
   *
   *     kVAR = kW x ( tan(acos(PF_now)) - tan(acos(PF_target)) )
   *
   * Equivalently it is the difference of two reactive loads at constant
   * real power: kW.tan(phi) is the kVAR drawn at power factor cos(phi),
   * so the bank supplies the gap. tests/ check the formula against both
   * hand-computed values and that independent sqrt(kVA^2 - kW^2) route.
   * ------------------------------------------------------------------ */
  function capacitorKvar(kW, pfNow, pfTarget) {
    var a = tanPhi(pfNow, "pfNow");
    if (!a.ok) return { ok: false, needed: false, kvar: 0, code: a.code, field: a.field, message: a.message };
    var b = tanPhi(pfTarget, "pfTarget");
    if (!b.ok) return { ok: false, needed: false, kvar: 0, code: b.code, field: b.field, message: b.message };

    var kw = nonNeg(kW);
    var out = {
      ok: true, needed: true, kvar: 0,
      kW: kw,
      pfNow: a.pf, pfTarget: b.pf,
      phiNowDeg: r2(a.degrees), phiTargetDeg: r2(b.degrees),
      tanNow: a.tan, tanTarget: b.tan,
      kvarNow: kw * a.tan,              /* reactive load today */
      kvarTarget: kw * b.tan,           /* reactive load once corrected */
      kvaNow: safeDiv(kw, a.pf),        /* apparent power today */
      kvaTarget: safeDiv(kw, b.pf),     /* apparent power once corrected */
      code: null, message: null
    };

    if (b.pf <= a.pf) {
      out.needed = false;
      out.code = "TARGET_NOT_ABOVE_CURRENT";
      out.message =
        "Target power factor " + b.pf + " is not above the recorded " + a.pf +
        ", so no capacitor is needed to reach it. You are already at or past the target.";
      return out;
    }
    if (kw === 0) {
      out.needed = false;
      out.code = "NO_REAL_LOAD";
      out.message = "There is no real load (0 kW) to compensate, so the bank size is zero.";
      return out;
    }

    var kvar = kw * (a.tan - b.tan);
    /* Belt and braces: the two guards above make this unreachable, but a
       rupee figure must never be allowed out of here as NaN or negative. */
    out.kvar = isFinite(kvar) && kvar > 0 ? kvar : 0;
    out.needed = out.kvar > 0;
    return out;
  }

  /* ================================================================== *
   * 4. MAXIMUM DEMAND — billing, exceedance penalty, idle capacity
   * ================================================================== */

  /* Billing demand on an industrial connection is normally built from three
     pieces, and the tool keeps them visible separately because that is where
     the avoidable money hides:

       within contract   min(recorded MD, contract demand)
       minimum billing   contract demand x minBillPct/100, a floor under the
                         within-contract part: you pay it whether or not you
                         draw it
       excess            max(0, recorded MD - contract demand), billed at
                         penalMultiple x the normal rate

     normal part  = max(within contract, minimum billing floor) x rate
     penal part   = excess x rate x penalMultiple
     penal premium= excess x rate x (penalMultiple - 1)   <- the avoidable bit
     idle capacity= max(0, floor - recorded MD)           <- the other trap  */
  function demandBilling(o) {
    var unit = o.unit === "kW" ? "kW" : "kVA";
    var cd = nonNeg(o.contractDemand);
    var md = nonNeg(o.recordedMd);
    var rate = nonNeg(o.demandRate);
    var mult = fin(o.penalMultiple);
    if (mult < 1) mult = 1;                       /* never cheaper than normal */
    var minPct = clamp(o.minBillPct, 0, 100);

    var errors = [];
    var warnings = [];

    if (cd <= 0) {
      errors.push({
        field: "contractDemand", code: "CONTRACT_DEMAND_REQUIRED",
        message:
          "Contract demand is zero or blank. Without it there is no exceedance " +
          "to measure and no minimum-billing floor, so demand is shown at the " +
          "normal rate on the recorded MD only. Copy the figure from your " +
          "agreement for supply."
      });
    }

    var floorDemand = cd * minPct / 100;
    var withinContract = cd > 0 ? Math.min(md, cd) : md;
    var excess = cd > 0 ? Math.max(0, md - cd) : 0;
    var normalBillable = Math.max(withinContract, floorDemand);
    var idleCapacity = Math.max(0, floorDemand - md);

    var normalCharge = normalBillable * rate;
    var penalCharge = excess * rate * mult;
    var penalPremium = excess * rate * (mult - 1);
    var idleCost = idleCapacity * rate;

    if (md === 0 && cd > 0) {
      warnings.push({
        code: "ZERO_RECORDED_DEMAND",
        message:
          "Recorded maximum demand is zero. If the factory ran this month, the " +
          "figure is missing rather than nil — a zero MD still bills the " +
          "minimum-billing floor on your contract demand."
      });
    }
    if (excess > 0) {
      warnings.push({
        code: "DEMAND_EXCEEDED",
        message:
          "Recorded MD is above contract demand by " + r2(excess) + " " + unit +
          ". Exceedance is usually both billed penally and a breach of the supply " +
          "agreement, which can be acted on separately from the money."
      });
    }

    return {
      unit: unit,
      contractDemand: cd,
      recordedMd: md,
      rate: rate,
      penalMultiple: mult,
      minBillPct: minPct,
      minBillFloor: floorDemand,
      withinContract: withinContract,
      normalBillable: normalBillable,
      excess: excess,
      idleCapacity: idleCapacity,
      billedDemand: normalBillable + excess,
      utilisationPct: (function () {
        var u = safeDiv(md * 100, cd);
        return u === null ? null : u;
      })(),
      normalCharge: normalCharge,
      penalCharge: penalCharge,
      penalPremium: penalPremium,
      idleCost: idleCost,
      total: normalCharge + penalCharge,
      errors: errors,
      warnings: warnings
    };
  }

  /* Revised contract demand: cover the worst demand the connection has
     actually shown, plus headroom, rounded up to the step the licensee
     accepts. Never recommends a figure below that peak — a "saving" bought
     by guaranteeing next year's penalty is not a saving. */
  function recommendContractDemand(o) {
    var peak = Math.max(nonNeg(o.annualPeakMd), nonNeg(o.recordedMd));
    var headroom = nonNeg(o.headroomPct);
    var step = nonNeg(o.cdStep);
    var target = peak * (1 + headroom / 100);
    var rounded = step > 0 ? Math.ceil(round6(target / step)) * step : target;
    if (rounded < peak) rounded = peak;
    return {
      unit: o.unit === "kW" ? "kW" : "kVA",
      peakConsidered: peak,
      peakSource: nonNeg(o.annualPeakMd) >= nonNeg(o.recordedMd) ? "12-month peak" : "this month",
      headroomPct: headroom,
      step: step,
      withHeadroom: r2(target),
      recommended: r2(rounded)
    };
  }

  /* ================================================================== *
   * 5. TIME-OF-DAY SLABS AND ENERGY CHARGE
   * ================================================================== */

  var TOD_SLABS = [
    { key: "offpeak", label: "Off-peak" },
    { key: "normal", label: "Normal" },
    { key: "peak", label: "Peak" }
  ];

  /* Two ways tariff orders express Time-of-Day, both supported:
       percent  a base energy rate plus a signed % for the peak and off-peak
                slabs (a surcharge and a rebate on the normal rate)
       direct   an outright currency-per-kWh rate printed against each slab */
  function todSchedule(o) {
    var mode = o.todMode === "direct" ? "direct" : "percent";
    var base = nonNeg(o.baseRate);
    var warnings = [];

    function rateFor(key) {
      if (mode === "direct") {
        if (key === "peak") return nonNeg(o.ratePeak);
        if (key === "offpeak") return nonNeg(o.rateOffPeak);
        return nonNeg(o.rateNormal);
      }
      if (key === "peak") return base * (1 + fin(o.todPeakPct) / 100);
      if (key === "offpeak") return base * (1 + fin(o.todOffPeakPct) / 100);
      return base;
    }

    var units = {
      offpeak: nonNeg(o.unitsOffPeak),
      normal: nonNeg(o.unitsNormal),
      peak: nonNeg(o.unitsPeak)
    };

    var slabs = TOD_SLABS.map(function (s) {
      var raw = rateFor(s.key);
      var rate = raw;
      if (!(rate > 0)) rate = 0;
      if (raw < 0) {
        warnings.push({
          code: "NEGATIVE_SLAB_RATE",
          message:
            "The " + s.label.toLowerCase() + " rate works out negative, which no " +
            "tariff charges. It has been read as zero — check the percentage you entered."
        });
      }
      var u = units[s.key];
      return { key: s.key, label: s.label, units: u, rate: rate, charge: u * rate };
    });

    var totalUnits = slabs.reduce(function (t, s) { return t + s.units; }, 0);
    var energyCharge = slabs.reduce(function (t, s) { return t + s.charge; }, 0);

    if (totalUnits === 0) {
      warnings.push({
        code: "ZERO_UNITS",
        message:
          "No units entered in any slab, so there is no energy charge and no " +
          "average rate per unit to show. Demand and power-factor lines are " +
          "still decoded."
      });
    }

    return {
      mode: mode,
      base: base,
      slabs: slabs,
      byKey: slabs.reduce(function (m, s) { m[s.key] = s; return m; }, {}),
      totalUnits: totalUnits,
      energyCharge: energyCharge,
      blendedRate: safeDiv(energyCharge, totalUnits),
      warnings: warnings
    };
  }

  /* Shifting load out of the peak slab. You cannot shift more than you
     actually consume in peak, and shifting into a dearer slab is reported as
     the loss it is rather than dressed up as a saving. */
  function shiftAnalysis(o, tod) {
    var want = nonNeg(o.shiftKwh);
    var to = o.shiftTo === "normal" ? "normal" : "offpeak";
    var peak = tod.byKey.peak;
    var dest = tod.byKey[to];
    var available = peak.units;
    var moved = Math.min(want, available);
    var perKwh = peak.rate - dest.rate;
    var saving = moved * perKwh;
    var warnings = [];

    if (want > available) {
      warnings.push({
        code: "SHIFT_CAPPED",
        message:
          "You asked to shift " + r2(want) + " kWh but only " + r2(available) +
          " kWh were billed in the peak slab, so the shift is capped at what is there."
      });
    }
    if (moved > 0 && perKwh <= 0) {
      warnings.push({
        code: "SHIFT_NOT_WORTH_IT",
        message:
          "The " + dest.label.toLowerCase() + " rate is not below the peak rate, so " +
          "moving load there saves nothing. The shift is not applied to the optimised bill."
      });
    }

    return {
      requested: want,
      available: available,
      moved: moved,
      capped: want > available,
      destination: to,
      destinationLabel: dest.label,
      peakRate: peak.rate,
      destRate: dest.rate,
      savingPerKwh: perKwh,
      saving: saving,
      worthwhile: moved > 0 && perKwh > 0,
      applied: moved > 0 && perKwh > 0 ? moved : 0,
      warnings: warnings
    };
  }

  /* ================================================================== *
   * 6. POWER-FACTOR SURCHARGE / REBATE
   * ================================================================== */

  var PF_BASE_LABELS = {
    energy: "energy charge",
    demand: "demand charge",
    both: "demand + energy charges"
  };

  function pfBaseAmount(choice, demandTotal, energyTotal) {
    if (choice === "energy") return energyTotal;
    if (choice === "demand") return demandTotal;
    return demandTotal + energyTotal;
  }

  /* Signed money: a positive amount is a surcharge you pay, a negative amount
     is a rebate you receive. Points are whole completed 0.01 steps by default,
     because that is how most orders word it ("for every 1% fall below"); a
     pro-rata mode is offered for orders that word it continuously. */
  function pfAdjustment(o) {
    var now = pfCheck(o.pfNow, "pfNow");
    var tgt = pfCheck(o.pfTarget, "pfTarget");
    if (!now.ok || !tgt.ok) {
      var bad = now.ok ? tgt : now;
      return {
        ok: false, applicable: false, amount: 0, points: 0, pct: 0,
        direction: "refused", base: 0, baseChoice: o.pfBase,
        code: bad.code, field: bad.field, message: bad.message
      };
    }

    var prorata = o.pfStep === "prorata";
    var deltaPoints = round6((tgt.pf - now.pf) * 100);
    var direction, points, pctPerPoint;

    if (deltaPoints > 0) {
      direction = "surcharge";
      points = prorata ? deltaPoints : Math.floor(deltaPoints);
      pctPerPoint = nonNeg(o.pfPenaltyPctPerPoint);
    } else if (deltaPoints < 0) {
      direction = "rebate";
      points = prorata ? -deltaPoints : Math.floor(-deltaPoints);
      pctPerPoint = nonNeg(o.pfIncentivePctPerPoint);
    } else {
      direction = "none";
      points = 0;
      pctPerPoint = 0;
    }

    var pct = points * pctPerPoint;
    var cap = nonNeg(o.pfCapPct);
    var capped = false;
    if (cap > 0 && pct > cap) { pct = cap; capped = true; }

    var base = nonNeg(pfBaseAmount(o.pfBase, o.demandTotal, o.energyTotal));
    var magnitude = base * pct / 100;
    var amount = direction === "rebate" ? -magnitude : magnitude;

    return {
      ok: true, applicable: true,
      pfNow: now.pf, pfTarget: tgt.pf,
      shortfallPoints: deltaPoints > 0 ? deltaPoints : 0,
      surplusPoints: deltaPoints < 0 ? -deltaPoints : 0,
      points: points,
      stepMode: prorata ? "prorata" : "completed",
      pctPerPoint: pctPerPoint,
      pct: pct,
      capped: capped,
      capPct: cap,
      baseChoice: o.pfBase,
      baseLabel: PF_BASE_LABELS[o.pfBase] || PF_BASE_LABELS.both,
      base: base,
      amount: amount,
      direction: direction,
      code: null, message: null
    };
  }

  /* ================================================================== *
   * 7. ONE WHOLE BILL
   * ================================================================== */

  /* A scenario is a fully resolved set of figures. buildBill turns it into
     every line of the bill. Running it twice — once as entered, once with the
     recommended changes applied — is what makes the headline saving honest:
     the levers interact, so the difference of two complete bills is the only
     figure that cannot double-count. */
  function buildBill(s) {
    var demand = demandBilling(s);
    var tod = todSchedule(s);
    var fppcaRate = nonNeg(s.fppcaRate);
    var fppca = tod.totalUnits * fppcaRate;

    var pf = pfAdjustment({
      pfNow: s.pfNow,
      pfTarget: s.pfTarget,
      pfPenaltyPctPerPoint: s.pfPenaltyPctPerPoint,
      pfIncentivePctPerPoint: s.pfIncentivePctPerPoint,
      pfCapPct: s.pfCapPct,
      pfStep: s.pfStep,
      pfBase: s.pfBase,
      demandTotal: demand.total,
      energyTotal: tod.energyCharge
    });

    var other = fin(s.otherCharges);
    var subtotal = demand.total + tod.energyCharge + fppca + pf.amount + other;
    /* Duty on a negative subtotal would be a refund of a tax never paid. */
    var dutyBase = Math.max(0, subtotal);
    var dutyPct = nonNeg(s.dutyPct);
    var duty = dutyBase * dutyPct / 100;
    var total = subtotal + duty;

    return {
      demand: demand,
      tod: tod,
      fppcaRate: fppcaRate,
      fppca: fppca,
      pf: pf,
      other: other,
      subtotal: subtotal,
      dutyPct: dutyPct,
      dutyBase: dutyBase,
      duty: duty,
      total: total,
      totalUnits: tod.totalUnits,
      avgRatePerUnit: safeDiv(total, tod.totalUnits),
      errors: demand.errors.concat(pf.ok ? [] : [{ field: pf.field, code: pf.code, message: pf.message }]),
      warnings: demand.warnings.concat(tod.warnings)
    };
  }

  function paybackMonths(cost, monthlySaving) {
    var c = nonNeg(cost);
    var m = fin(monthlySaving);
    if (m <= 0) {
      return {
        ok: false, months: null, years: null, code: "NO_MONTHLY_SAVING",
        message: "There is no monthly saving to pay this back with, so there is no payback period."
      };
    }
    if (c === 0) {
      return { ok: true, months: 0, years: 0, code: "NO_COST", message: "No cost entered, so it pays back immediately." };
    }
    var months = c / m;
    if (!isFinite(months)) {
      return { ok: false, months: null, years: null, code: "NOT_FINITE", message: "The payback period is not a finite number." };
    }
    return { ok: true, months: months, years: months / 12, code: null, message: null };
  }

  /* ================================================================== *
   * 8. COMPUTE — read the form, decode the bill, cost the levers
   * ================================================================== */

  /* Normalise everything once, so no downstream function re-reads raw input. */
  function resolve(input) {
    var i = input || {};
    var unit = i.demandUnit === "kW" ? "kW" : "kVA";
    return {
      demandUnit: unit,
      unit: unit,
      contractDemand: nonNeg(i.contractDemand),
      recordedMd: nonNeg(i.recordedMd),
      annualPeakMd: nonNeg(i.annualPeakMd),
      demandRate: nonNeg(i.demandRate),
      penalMultiple: fin(i.penalMultiple) < 1 ? 1 : fin(i.penalMultiple),
      minBillPct: clamp(i.minBillPct, 0, 100),
      cdStep: nonNeg(i.cdStep),
      headroomPct: nonNeg(i.headroomPct),
      cdRevisionCost: nonNeg(i.cdRevisionCost),

      /* Power factors stay RAW. They are the one group of inputs that must be
         able to fail validation rather than be silently coerced to 0. */
      pfNow: i.pfNow,
      pfTarget: i.pfTarget,
      pfPenaltyPctPerPoint: nonNeg(i.pfPenaltyPctPerPoint),
      pfIncentivePctPerPoint: nonNeg(i.pfIncentivePctPerPoint),
      pfCapPct: nonNeg(i.pfCapPct),
      pfStep: i.pfStep === "prorata" ? "prorata" : "completed",
      pfBase: (i.pfBase === "energy" || i.pfBase === "demand") ? i.pfBase : "both",
      sizingKw: nonNeg(i.sizingKw),
      capCostPerKvar: nonNeg(i.capCostPerKvar),
      capFixedCost: nonNeg(i.capFixedCost),

      todMode: i.todMode === "direct" ? "direct" : "percent",
      baseRate: nonNeg(i.baseRate),
      unitsOffPeak: nonNeg(i.unitsOffPeak),
      unitsNormal: nonNeg(i.unitsNormal),
      unitsPeak: nonNeg(i.unitsPeak),
      todPeakPct: fin(i.todPeakPct),
      todOffPeakPct: fin(i.todOffPeakPct),
      rateNormal: nonNeg(i.rateNormal),
      ratePeak: nonNeg(i.ratePeak),
      rateOffPeak: nonNeg(i.rateOffPeak),
      shiftKwh: nonNeg(i.shiftKwh),
      shiftTo: i.shiftTo === "normal" ? "normal" : "offpeak",

      fppcaRate: nonNeg(i.fppcaRate),
      dutyPct: nonNeg(i.dutyPct),
      otherCharges: fin(i.otherCharges)
    };
  }

  function compute(input) {
    var s = resolve(input);

    /* --- the bill as entered --- */
    var current = buildBill(s);
    var errors = current.errors.slice();
    var warnings = current.warnings.slice();

    var pfNowOk = pfCheck(s.pfNow, "pfNow");
    var pfTargetOk = pfCheck(s.pfTarget, "pfTarget");
    var pfUsable = pfNowOk.ok && pfTargetOk.ok;

    if (pfUsable) {
      if (pfNowOk.pf < PF_RULES.lowPfConcern) {
        warnings.push({ code: "PF_VERY_LOW", message: PF_RULES.lowPfNote });
      }
      if (pfNowOk.pf === 1) {
        warnings.push({
          code: "PF_UNITY",
          message:
            "A recorded power factor of exactly 1.000 is almost always a rounded " +
            "display. Nothing is left to correct at unity, so the capacitor size reads zero."
        });
      }
      if (pfTargetOk.pf === 1) {
        warnings.push({
          code: "PF_TARGET_UNITY",
          message:
            "A target of 1.000 asks for full compensation, which real plant does " +
            "not hold and which risks over-compensation at light load. Tariff targets are below unity."
        });
      }
    }

    /* --- real power behind the recorded demand --- */
    var kwAtPeak = s.demandUnit === "kVA"
      ? (pfUsable ? s.recordedMd * pfNowOk.pf : null)
      : s.recordedMd;
    var kwForSizing = s.sizingKw > 0
      ? s.sizingKw
      : (kwAtPeak === null ? 0 : kwAtPeak);

    /* --- the power factor we would run at after correction --- */
    var pfOptimised = pfUsable ? Math.max(pfNowOk.pf, pfTargetOk.pf) : null;
    var pfImproves = pfUsable && pfOptimised > pfNowOk.pf;
    /* Correcting PF at constant real power shrinks apparent power in the same
       ratio: kVA' = kW/PF' = (kVA.PF)/PF'. Only matters where demand is billed
       in kVA; a kW-billed tariff sees no demand reduction from a capacitor. */
    var mdRatio = (pfImproves && s.demandUnit === "kVA") ? pfNowOk.pf / pfOptimised : 1;
    var mdImproved = r2(s.recordedMd * mdRatio);
    var annualPeakImproved = r2(s.annualPeakMd * mdRatio);

    /* --- capacitor sizing --- */
    var capacitor = capacitorKvar(kwForSizing, s.pfNow, s.pfTarget);
    capacitor.kwBasis = s.sizingKw > 0 ? "entered" : (s.demandUnit === "kVA" ? "recorded MD \u00d7 recorded PF" : "recorded MD (billed in kW)");
    capacitor.costPerKvar = s.capCostPerKvar;
    capacitor.fixedCost = s.capFixedCost;
    capacitor.variableCost = capacitor.kvar * s.capCostPerKvar;
    capacitor.totalCost = capacitor.needed ? capacitor.variableCost + s.capFixedCost : 0;

    /* --- contract demand recommendation --- */
    var cdAsIs = recommendContractDemand(s);
    var cdAfterPf = recommendContractDemand({
      annualPeakMd: annualPeakImproved,
      recordedMd: mdImproved,
      headroomPct: s.headroomPct,
      cdStep: s.cdStep,
      unit: s.unit
    });

    /* --- Time-of-Day shift --- */
    var shift = shiftAnalysis(s, current.tod);
    warnings = warnings.concat(shift.warnings);

    /* --- single-lever scenarios, each measured against the bill as entered --- */
    function withOverrides(over) {
      var c = {};
      Object.keys(s).forEach(function (k) { c[k] = s[k]; });
      Object.keys(over).forEach(function (k) { c[k] = over[k]; });
      return c;
    }
    function shiftedUnits(moved, to) {
      var out = { unitsPeak: Math.max(0, s.unitsPeak - moved) };
      if (to === "normal") out.unitsNormal = s.unitsNormal + moved;
      else out.unitsOffPeak = s.unitsOffPeak + moved;
      return out;
    }

    var leverCdBill = buildBill(withOverrides({ contractDemand: cdAsIs.recommended }));
    var leverPfBill = pfImproves
      ? buildBill(withOverrides({ pfNow: pfOptimised, recordedMd: mdImproved }))
      : current;
    var leverTodBill = shift.applied > 0
      ? buildBill(withOverrides(shiftedUnits(shift.applied, shift.destination)))
      : current;

    /* --- everything applied at once: the authoritative figure --- */
    var optimisedOverrides = { contractDemand: cdAfterPf.recommended };
    if (pfImproves) {
      optimisedOverrides.pfNow = pfOptimised;
      optimisedOverrides.recordedMd = mdImproved;
    }
    if (shift.applied > 0) {
      var su = shiftedUnits(shift.applied, shift.destination);
      Object.keys(su).forEach(function (k) { optimisedOverrides[k] = su[k]; });
    }
    var optimised = buildBill(withOverrides(optimisedOverrides));

    var levers = {
      contractDemand: {
        key: "cd",
        label: "Revise contract demand to " + cdAsIs.recommended + " " + s.unit,
        monthly: current.total - leverCdBill.total,
        applicableNow: true,
        oneTimeCost: s.cdRevisionCost
      },
      powerFactor: {
        key: "pf",
        label: pfUsable
          ? (pfImproves
            ? "Correct power factor from " + pfNowOk.pf + " to " + pfOptimised
            : "Power factor already at or above target")
          : "Power factor input refused",
        monthly: pfUsable ? current.total - leverPfBill.total : 0,
        applicableNow: pfImproves,
        oneTimeCost: capacitor.totalCost
      },
      timeOfDay: {
        key: "tod",
        label: shift.applied > 0
          ? "Shift " + r2(shift.applied) + " kWh out of peak into " + shift.destinationLabel.toLowerCase()
          : "No worthwhile peak shift available",
        monthly: current.total - leverTodBill.total,
        applicableNow: shift.applied > 0,
        oneTimeCost: 0
      }
    };

    var combinedMonthly = current.total - optimised.total;
    var leverSum = levers.contractDemand.monthly + levers.powerFactor.monthly + levers.timeOfDay.monthly;

    if (combinedMonthly < 0) {
      warnings.push({
        code: "OPTIMISED_COSTS_MORE",
        message:
          "Applied together, the recommendations bill more than the month as " +
          "entered. That is a real finding, not an error: raising contract demand " +
          "to cover your 12-month peak raises the minimum-billing floor every " +
          "month, which can cost more than the exceedance penalty it removes. " +
          "Compare the penalty against the floor before applying for a revision."
      });
    }
    if (Math.abs(leverSum - combinedMonthly) > 1) {
      warnings.push({
        code: "LEVERS_INTERACT",
        message:
          "The three levers interact, so their individual savings do not add up " +
          "to the combined figure. The combined figure is the difference between " +
          "two complete bills and is the one to rely on."
      });
    }

    /* --- paybacks --- */
    var capacitorPayback = paybackMonths(capacitor.totalCost, levers.powerFactor.monthly);
    var cdPayback = paybackMonths(s.cdRevisionCost, levers.contractDemand.monthly);

    /* --- the diagnostic figures, for the attribution table --- */
    var diagnostics = {
      exceedancePremium: current.demand.penalPremium,
      exceedanceFullCharge: current.demand.penalCharge,
      idleCapacityCost: current.demand.idleCost,
      idleCapacity: current.demand.idleCapacity,
      pfSurcharge: current.pf.ok && current.pf.direction === "surcharge" ? current.pf.amount : 0,
      pfRebate: current.pf.ok && current.pf.direction === "rebate" ? -current.pf.amount : 0,
      peakPremiumOnShiftable: shift.moved * Math.max(0, shift.savingPerKwh),
      peakSharePct: safeDiv(current.tod.byKey.peak.units * 100, current.tod.totalUnits)
    };

    return {
      ok: errors.length === 0,
      errors: errors,
      warnings: warnings,
      unit: s.unit,
      resolved: s,
      current: current,
      optimised: optimised,
      leverBills: { contractDemand: leverCdBill, powerFactor: leverPfBill, timeOfDay: leverTodBill },
      levers: levers,
      savings: {
        combinedMonthly: combinedMonthly,
        combinedAnnual: combinedMonthly * 12,
        headlineMonthly: Math.max(0, combinedMonthly),
        headlineAnnual: Math.max(0, combinedMonthly) * 12,
        leverSum: leverSum
      },
      demandRecommendation: {
        asIs: cdAsIs,
        afterPf: cdAfterPf,
        direction: cdAsIs.recommended > s.contractDemand ? "increase"
          : (cdAsIs.recommended < s.contractDemand ? "reduce" : "unchanged"),
        changeAmount: r2(cdAsIs.recommended - s.contractDemand),
        payback: cdPayback
      },
      powerFactorPlan: {
        usable: pfUsable,
        pfNow: pfUsable ? pfNowOk.pf : null,
        pfTarget: pfUsable ? pfTargetOk.pf : null,
        pfOptimised: pfOptimised,
        improves: pfImproves,
        kwAtPeak: kwAtPeak,
        kwForSizing: kwForSizing,
        mdImproved: pfImproves ? mdImproved : s.recordedMd,
        mdReduction: r2(s.recordedMd - (pfImproves ? mdImproved : s.recordedMd)),
        capacitor: capacitor,
        payback: capacitorPayback
      },
      timeOfDayPlan: shift,
      diagnostics: diagnostics
    };
  }

  /* ================================================================== *
   * 9. EXPORTS
   * ================================================================== */

  var API = {
    DEFAULTS: DEFAULTS,
    LEGAL_FRAME: LEGAL_FRAME,
    PF_RULES: PF_RULES,
    PF_BASE_LABELS: PF_BASE_LABELS,
    TOD_SLABS: TOD_SLABS,

    fin: fin,
    nonNeg: nonNeg,
    round6: round6,
    safeDiv: safeDiv,

    pfCheck: pfCheck,
    tanPhi: tanPhi,
    capacitorKvar: capacitorKvar,

    demandBilling: demandBilling,
    recommendContractDemand: recommendContractDemand,

    todSchedule: todSchedule,
    shiftAnalysis: shiftAnalysis,

    pfAdjustment: pfAdjustment,
    pfBaseAmount: pfBaseAmount,

    buildBill: buildBill,
    paybackMonths: paybackMonths,
    resolve: resolve,
    compute: compute
  };

  if (typeof module === "object" && module && module.exports) module.exports = API;
  if (root) root.BillDecoder = API;
})(typeof globalThis !== "undefined" ? globalThis : this);
