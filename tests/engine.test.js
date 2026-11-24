/* Table-driven tests for the HT/LT industrial bill decoder engine.
   Run from the repo root:  node --test
   No test framework is installed and none is needed — node:test ships with Node. */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("../assets/engine.js");

/* ================================================================== *
 * helpers
 * ================================================================== */

/* Walk every number in a result and fail on NaN / Infinity / -Infinity.
   The contract is that no rupee figure can ever reach the page as NaN, so
   this runs over every scenario the suite builds. */
function assertAllFinite(value, path) {
  path = path || "result";
  if (typeof value === "number") {
    assert.ok(Number.isFinite(value), path + " is not finite: " + String(value));
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => assertAllFinite(v, path + "[" + i + "]"));
    return;
  }
  if (value && typeof value === "object") {
    Object.keys(value).forEach((k) => assertAllFinite(value[k], path + "." + k));
  }
}

function near(actual, expected, tol, label) {
  const t = tol === undefined ? 1e-9 : tol;
  assert.ok(
    Math.abs(actual - expected) <= t,
    (label || "value") + ": expected " + expected + " +/- " + t + ", got " + actual
  );
}

const codes = (list) => list.map((e) => e.code);
const hasCode = (list, code) => codes(list).indexOf(code) !== -1;

/* A deliberately plain baseline: round rates so every expected rupee figure
   below is exact decimal arithmetic that can be checked by hand. */
const BASE = {
  demandUnit: "kVA",
  contractDemand: 1000,
  recordedMd: 1150,
  annualPeakMd: 1180,
  demandRate: 400,
  penalMultiple: 2,
  minBillPct: 75,
  cdStep: 5,
  headroomPct: 10,
  cdRevisionCost: 0,

  pfNow: 0.84,
  pfTarget: 0.95,
  pfPenaltyPctPerPoint: 1,
  pfIncentivePctPerPoint: 0.5,
  pfCapPct: 0,
  pfStep: "completed",
  pfBase: "both",
  sizingKw: 0,
  capCostPerKvar: 600,
  capFixedCost: 25000,

  todMode: "percent",
  baseRate: 8,
  unitsOffPeak: 60000,
  unitsNormal: 190000,
  unitsPeak: 90000,
  todPeakPct: 20,
  todOffPeakPct: -10,
  rateNormal: 8,
  ratePeak: 9.6,
  rateOffPeak: 7.2,
  shiftKwh: 30000,
  shiftTo: "offpeak",

  fppcaRate: 0.5,
  dutyPct: 9,
  otherCharges: 5000
};
const withBase = (over) => Object.assign({}, BASE, over);

/* ================================================================== *
 * 1. NO TARIFF TABLE IS SHIPPED
 *
 *    This is the load-bearing promise of the whole tool, so it is a test
 *    and not just a comment: the defaults block must declare itself
 *    indicative, must name what to read instead, and no state tariff
 *    table may appear anywhere in the module.
 * ================================================================== */

test("the defaults block declares itself indicative and names the real source", () => {
  const d = E.DEFAULTS;
  assert.match(d.status, /INDICATIVE PLACEHOLDERS/);
  assert.match(d.status, /NOT any state's tariff/);
  assert.match(d.readInstead, /tariff order/i);
  assert.match(d.readInstead, /State Electricity Regulatory Commission/i);
  assert.match(d.readInstead, /agreement for supply/i);
  assert.ok(d.checkedOn.length > 0, "the defaults carry the month they were set");
});

test("every rate, slab, multiple and target the engine uses is a settable input", () => {
  /* If a figure is in DEFAULTS it must also be read off the input object by
     resolve(), i.e. it is a user input and not a baked-in constant. */
  /* The probe value sits inside each field's legitimate range: minBillPct is
     a percentage of contract demand and is bounded to 0-100 on the way in. */
  const tariffKeys = {
    demandRate: 12345, penalMultiple: 2.75, minBillPct: 85, contractDemand: 12345,
    pfTarget: 0.92, pfPenaltyPctPerPoint: 1.25, pfIncentivePctPerPoint: 0.75, pfCapPct: 12,
    baseRate: 7.77, todPeakPct: 35, todOffPeakPct: -15,
    rateNormal: 7.77, ratePeak: 11.11, rateOffPeak: 6.66,
    fppcaRate: 1.35, dutyPct: 6.5, capCostPerKvar: 825, capFixedCost: 43000
  };
  for (const k of Object.keys(tariffKeys)) {
    assert.ok(k in E.DEFAULTS, k + " has an indicative default");
    const probe = {};
    probe[k] = tariffKeys[k];
    const resolved = E.resolve(probe);
    assert.equal(resolved[k], tariffKeys[k], k + " is read from the input, not hard-coded");
    assert.notEqual(resolved[k], E.DEFAULTS[k], k + " really did move off its default");
  }
});

test("no state tariff table is shipped with the module", () => {
  const src = require("node:fs").readFileSync(
    require("node:path").join(__dirname, "..", "assets", "engine.js"), "utf8"
  );
  /* No state or DISCOM is named as the source of a number anywhere. */
  const discoms = [
    "MSEDCL", "TANGEDCO", "BESCOM", "MESCOM", "HESCOM", "GUVNL", "DGVCL",
    "PSPCL", "UPPCL", "WBSEDCL", "APSPDCL", "TSSPDCL", "KSEB", "JVVNL",
    "MPPKVVCL", "CSPDCL", "OERC", "DHBVN", "UHBVN", "BRPL", "BYPL", "TPDDL"
  ];
  for (const d of discoms) {
    assert.ok(src.indexOf(d) === -1, "engine.js must not name " + d + " against a rate");
  }
  assert.match(src, /WHY THERE IS NO TARIFF TABLE IN THIS FILE/);
  /* The legal frame cites sections, which are stable, not rates, which are not. */
  assert.match(E.LEGAL_FRAME.act, /Electricity Act 2003/);
  assert.match(E.LEGAL_FRAME.tariffDetermination, /Section 62/);
  assert.match(E.LEGAL_FRAME.commissionFunction, /Section 86\(1\)\(a\)/);
  assert.match(E.LEGAL_FRAME.thereforeNoTable, /change annually/);
});

/* ================================================================== *
 * 2. POWER-FACTOR DOMAIN GUARDS
 *
 *    acos() is defined on [-1, 1] only. Outside it the formula yields NaN;
 *    at exactly zero it yields a finite but absurd 1.63e16. Both must be
 *    refused rather than turned into a capacitor size.
 * ================================================================== */

test("pfCheck accepts only the open interval (0, 1]", () => {
  const cases = [
    { pf: 0.84, ok: true },
    { pf: 0.5, ok: true },
    { pf: 1, ok: true, note: "unity is arithmetically valid" },
    { pf: 0.0001, ok: true, note: "absurd but in domain" },
    { pf: 0, ok: false, code: "PF_NOT_POSITIVE" },
    { pf: -0.9, ok: false, code: "PF_NOT_POSITIVE" },
    { pf: 1.0001, ok: false, code: "PF_ABOVE_UNITY" },
    { pf: 95, ok: false, code: "PF_ABOVE_UNITY", note: "percent entered by mistake" },
    { pf: NaN, ok: false, code: "PF_NOT_A_NUMBER" },
    { pf: Infinity, ok: false, code: "PF_NOT_A_NUMBER" },
    { pf: "", ok: false, code: "PF_NOT_A_NUMBER" },
    { pf: "abc", ok: false, code: "PF_NOT_A_NUMBER" },
    { pf: undefined, ok: false, code: "PF_NOT_A_NUMBER" },
    { pf: null, ok: false, code: "PF_NOT_A_NUMBER" },
    { pf: "0.9", ok: true, note: "a form field hands over a string" }
  ];
  for (const c of cases) {
    const got = E.pfCheck(c.pf, "pfNow");
    assert.equal(got.ok, c.ok, "pf " + String(c.pf) + " ok flag");
    if (!c.ok) {
      assert.equal(got.code, c.code, "pf " + String(c.pf) + " code");
      assert.ok(got.message.length > 20, "refusal explains itself in words");
    }
  }
});

test("tan(acos(0)) is finite garbage, so a zero power factor is refused outright", () => {
  /* Proof the guard is load-bearing: the raw expression does NOT produce NaN. */
  const raw = Math.tan(Math.acos(0));
  assert.ok(Number.isFinite(raw), "the unguarded expression returns a finite number");
  assert.ok(raw > 1e15, "...and that number is nonsense: " + raw);

  const guarded = E.tanPhi(0, "pfNow");
  assert.equal(guarded.ok, false);
  assert.equal(guarded.code, "PF_NOT_POSITIVE");
});

test("a power factor above unity is refused before acos() can return NaN", () => {
  assert.ok(Number.isNaN(Math.acos(1.05)), "the unguarded expression returns NaN");
  const guarded = E.tanPhi(1.05, "pfNow");
  assert.equal(guarded.ok, false);
  assert.equal(guarded.code, "PF_ABOVE_UNITY");
  assert.match(guarded.message, /0\.86/, "tells the user the decimal form");
});

test("tanPhi returns the angle and its tangent for valid power factors", () => {
  const cases = [
    { pf: 1, tan: 0, deg: 0 },
    { pf: 0.8, tan: 0.75, deg: 36.8698976 },
    { pf: 0.6, tan: 4 / 3, deg: 53.1301024 },
    { pf: 0.95, tan: 0.3286841051788632, deg: 18.1948723 }
  ];
  for (const c of cases) {
    const got = E.tanPhi(c.pf, "pf");
    assert.equal(got.ok, true, "pf " + c.pf);
    near(got.tan, c.tan, 1e-9, "tan(acos(" + c.pf + "))");
    near(got.degrees, c.deg, 1e-5, "phi for pf " + c.pf);
  }
});

/* ================================================================== *
 * 3. THE CAPACITOR FORMULA
 *
 *    kVAR = kW x ( tan(acos(PF_now)) - tan(acos(PF_target)) )
 *
 *    Checked three ways: against values computed by hand from the 3-4-5
 *    triangle and surds, against the independent reactive-power route
 *    sqrt(kVA^2 - kW^2), and against its own linearity in kW.
 * ================================================================== */

test("capacitor sizing matches values computed by hand", () => {
  const cases = [
    {
      label: "100 kW, 0.80 -> 0.95 (the textbook case)",
      kW: 100, now: 0.8, target: 0.95,
      /* tan(acos 0.8) = 0.6/0.8 = 0.75 exactly (3-4-5 triangle).
         tan(acos 0.95) = sqrt(0.0975)/0.95 = 0.3122498999.../0.95
                        = 0.3286841051788632
         difference      = 0.4213158948211368 -> x100 */
      kvar: 42.13158948211368
    },
    {
      label: "100 kW, 0.60 -> 0.80 (both tangents are exact rationals)",
      kW: 100, now: 0.6, target: 0.8,
      /* 4/3 - 3/4 = 7/12 = 0.58333... -> x100 */
      kvar: 700 / 12
    },
    {
      label: "250 kW, 0.75 -> 0.95",
      kW: 250, now: 0.75, target: 0.95,
      /* tan(acos 0.75) = sqrt(7)/4 / 0.75 = 0.8819171036881968 */
      kvar: 250 * (Math.sqrt(7) / 4 / 0.75 - Math.sqrt(0.0975) / 0.95)
    },
    {
      label: "100 kW, 0.90 -> 1.00 (target tangent is zero)",
      kW: 100, now: 0.9, target: 1,
      /* tan(acos 1) = 0, so the bank carries the whole reactive load:
         100 x sqrt(0.19)/0.9 = 48.4322104837... */
      kvar: 100 * Math.sqrt(0.19) / 0.9
    },
    {
      label: "966 kW, 0.84 -> 0.95 (the page's worked example)",
      kW: 966, now: 0.84, target: 0.95,
      kvar: 966 * (Math.sqrt(1 - 0.84 * 0.84) / 0.84 - Math.sqrt(0.0975) / 0.95)
    }
  ];

  for (const c of cases) {
    const got = E.capacitorKvar(c.kW, c.now, c.target);
    assert.equal(got.ok, true, c.label + " computes");
    assert.equal(got.needed, true, c.label + " needs a bank");
    near(got.kvar, c.kvar, 1e-9, c.label);
    assertAllFinite(got, "capacitor(" + c.label + ")");
  }

  /* Spot-check the first case against the number an engineer would quote. */
  near(E.capacitorKvar(100, 0.8, 0.95).kvar, 42.13, 0.005, "the quotable 42.13 kVAR");
});

test("the tan form equals the independent sqrt(kVA^2 - kW^2) form", () => {
  /* kVAR drawn at power factor PF, for real power kW, is
        sqrt((kW/PF)^2 - kW^2)
     which is a different arithmetic route to kW.tan(acos(PF)). The bank is
     the difference of the two reactive loads, so the two routes must agree. */
  const grid = [
    [100, 0.7, 0.9], [500, 0.65, 0.95], [1250, 0.88, 0.99],
    [40, 0.5, 0.75], [966, 0.84, 0.95], [1, 0.3, 0.98]
  ];
  for (const [kW, now, target] of grid) {
    const viaTan = E.capacitorKvar(kW, now, target).kvar;
    const reactive = (pf) => Math.sqrt(Math.pow(kW / pf, 2) - kW * kW);
    const viaApparent = reactive(now) - reactive(target);
    near(viaTan, viaApparent, 1e-6 * Math.max(1, kW), kW + " kW " + now + "->" + target);
  }
});

test("the bank size is linear in kW", () => {
  const unit = E.capacitorKvar(1, 0.8, 0.95).kvar;
  for (const kW of [0.5, 10, 100, 2500, 99999]) {
    near(E.capacitorKvar(kW, 0.8, 0.95).kvar, unit * kW, 1e-6 * kW, kW + " kW scales");
  }
});

test("a target at or below the current power factor needs no capacitor, and says so", () => {
  const cases = [
    { now: 0.95, target: 0.95, note: "exactly at target" },
    { now: 0.98, target: 0.95, note: "already past target" },
    { now: 1, target: 0.9, note: "unity" }
  ];
  for (const c of cases) {
    const got = E.capacitorKvar(500, c.now, c.target);
    assert.equal(got.ok, true, c.note + " is not an error");
    assert.equal(got.needed, false, c.note + " needs no bank");
    assert.equal(got.kvar, 0, c.note + " sizes to zero, not a negative bank");
    assert.equal(got.code, "TARGET_NOT_ABOVE_CURRENT");
    assert.match(got.message, /no capacitor is needed/);
  }
});

test("capacitor sizing refuses an out-of-domain power factor on either side", () => {
  const cases = [
    { kW: 500, now: 0, target: 0.95, code: "PF_NOT_POSITIVE", field: "pfNow" },
    { kW: 500, now: -0.8, target: 0.95, code: "PF_NOT_POSITIVE", field: "pfNow" },
    { kW: 500, now: 1.2, target: 0.95, code: "PF_ABOVE_UNITY", field: "pfNow" },
    { kW: 500, now: 0.8, target: 0, code: "PF_NOT_POSITIVE", field: "pfTarget" },
    { kW: 500, now: 0.8, target: 1.5, code: "PF_ABOVE_UNITY", field: "pfTarget" },
    { kW: 500, now: 0.8, target: NaN, code: "PF_NOT_A_NUMBER", field: "pfTarget" }
  ];
  for (const c of cases) {
    const got = E.capacitorKvar(c.kW, c.now, c.target);
    assert.equal(got.ok, false, "refuses now=" + c.now + " target=" + c.target);
    assert.equal(got.code, c.code);
    assert.equal(got.field, c.field, "names the offending field");
    assert.equal(got.kvar, 0, "a refusal still carries 0, never NaN");
    assertAllFinite(got, "refusal");
  }
});

test("zero real load sizes to zero rather than dividing by it", () => {
  for (const kW of [0, -5, NaN, "", null]) {
    const got = E.capacitorKvar(kW, 0.8, 0.95);
    assert.equal(got.ok, true);
    assert.equal(got.needed, false);
    assert.equal(got.kvar, 0);
    assert.equal(got.code, "NO_REAL_LOAD");
    assertAllFinite(got, "zero load");
  }
});

/* ================================================================== *
 * 4. MAXIMUM DEMAND
 * ================================================================== */

test("demand billing splits normal, minimum-billing and penal parts", () => {
  const cases = [
    {
      label: "MD above contract: the excess carries the penal multiple",
      in: { contractDemand: 1000, recordedMd: 1150, demandRate: 400, penalMultiple: 2, minBillPct: 75 },
      out: {
        minBillFloor: 750, withinContract: 1000, normalBillable: 1000, excess: 150, idleCapacity: 0,
        normalCharge: 400000, penalCharge: 120000, penalPremium: 60000, idleCost: 0,
        total: 520000, utilisationPct: 115
      }
    },
    {
      label: "MD below the minimum-billing floor: you pay for capacity never drawn",
      in: { contractDemand: 1000, recordedMd: 700, demandRate: 400, penalMultiple: 2, minBillPct: 75 },
      out: {
        minBillFloor: 750, withinContract: 700, normalBillable: 750, excess: 0, idleCapacity: 50,
        normalCharge: 300000, penalCharge: 0, penalPremium: 0, idleCost: 20000,
        total: 300000, utilisationPct: 70
      }
    },
    {
      label: "MD between the floor and the contract: no penalty and no idle capacity",
      in: { contractDemand: 1000, recordedMd: 800, demandRate: 400, penalMultiple: 2, minBillPct: 75 },
      out: {
        minBillFloor: 750, withinContract: 800, normalBillable: 800, excess: 0, idleCapacity: 0,
        normalCharge: 320000, penalCharge: 0, penalPremium: 0, idleCost: 0,
        total: 320000, utilisationPct: 80
      }
    },
    {
      label: "zero recorded demand still pays the floor",
      in: { contractDemand: 1000, recordedMd: 0, demandRate: 400, penalMultiple: 2, minBillPct: 75 },
      out: {
        minBillFloor: 750, withinContract: 0, normalBillable: 750, excess: 0, idleCapacity: 750,
        normalCharge: 300000, penalCharge: 0, penalPremium: 0, idleCost: 300000,
        total: 300000, utilisationPct: 0
      }
    },
    {
      label: "no minimum-billing clause",
      in: { contractDemand: 1000, recordedMd: 700, demandRate: 400, penalMultiple: 2, minBillPct: 0 },
      out: {
        minBillFloor: 0, normalBillable: 700, idleCapacity: 0,
        normalCharge: 280000, total: 280000, idleCost: 0
      }
    },
    {
      label: "a penal multiple of 1 means the excess is billed at the normal rate",
      in: { contractDemand: 1000, recordedMd: 1150, demandRate: 400, penalMultiple: 1, minBillPct: 75 },
      out: { excess: 150, penalCharge: 60000, penalPremium: 0, total: 460000 }
    },
    {
      label: "a tariff that charges three times the rate on the excess",
      in: { contractDemand: 1000, recordedMd: 1150, demandRate: 400, penalMultiple: 3, minBillPct: 75 },
      out: { excess: 150, penalCharge: 180000, penalPremium: 120000, total: 580000 }
    },
    {
      label: "a 100% minimum-billing clause bills the whole contract demand",
      in: { contractDemand: 1000, recordedMd: 400, demandRate: 400, penalMultiple: 2, minBillPct: 100 },
      out: { minBillFloor: 1000, normalBillable: 1000, idleCapacity: 600, total: 400000, idleCost: 240000 }
    }
  ];

  for (const c of cases) {
    const got = E.demandBilling(Object.assign({ unit: "kVA" }, c.in));
    for (const k of Object.keys(c.out)) {
      near(got[k], c.out[k], 1e-6, c.label + " -> " + k);
    }
    assertAllFinite(got, "demand(" + c.label + ")");
  }
});

test("a penal multiple below 1 is clamped and a minimum-billing % outside 0-100 is bounded", () => {
  const half = E.demandBilling({ contractDemand: 1000, recordedMd: 1150, demandRate: 400, penalMultiple: 0.5, minBillPct: 75, unit: "kVA" });
  assert.equal(half.penalMultiple, 1, "the excess is never cheaper than the normal rate");
  assert.equal(half.penalPremium, 0);

  const over = E.demandBilling({ contractDemand: 1000, recordedMd: 400, demandRate: 400, penalMultiple: 2, minBillPct: 150, unit: "kVA" });
  assert.equal(over.minBillPct, 100, "a floor above the contract demand is not a thing");

  const under = E.demandBilling({ contractDemand: 1000, recordedMd: 400, demandRate: 400, penalMultiple: 2, minBillPct: -20, unit: "kVA" });
  assert.equal(under.minBillPct, 0);
});

test("zero contract demand is refused as an input, not divided by", () => {
  const got = E.demandBilling({ contractDemand: 0, recordedMd: 500, demandRate: 400, penalMultiple: 2, minBillPct: 75, unit: "kVA" });
  assert.ok(hasCode(got.errors, "CONTRACT_DEMAND_REQUIRED"), "flags the missing figure");
  assert.equal(got.utilisationPct, null, "utilisation is reported as unknown, not NaN or Infinity");
  assert.equal(got.excess, 0, "no contract means no measurable exceedance");
  assert.equal(got.penalCharge, 0, "and therefore no invented penalty");
  assert.equal(got.total, 200000, "demand still bills at the normal rate on the recorded MD");
  assertAllFinite(got, "zero contract demand");
});

test("an entirely zero bill produces zeroes, not NaN", () => {
  const got = E.demandBilling({ contractDemand: 0, recordedMd: 0, demandRate: 0, penalMultiple: 0, minBillPct: 0, unit: "kVA" });
  assert.equal(got.total, 0);
  assert.equal(got.utilisationPct, null);
  assertAllFinite(got, "all-zero demand");
});

test("revised contract demand covers the worst demand on record plus headroom", () => {
  const cases = [
    {
      label: "12-month peak drives it, rounded up to the 5 kVA step",
      in: { annualPeakMd: 1180, recordedMd: 1150, headroomPct: 10, cdStep: 5 },
      out: { peakConsidered: 1180, withHeadroom: 1298, recommended: 1300, peakSource: "12-month peak" }
    },
    {
      label: "no 12-month figure: this month's MD is all there is",
      in: { annualPeakMd: 0, recordedMd: 1150, headroomPct: 0, cdStep: 25 },
      out: { peakConsidered: 1150, recommended: 1150, peakSource: "this month" }
    },
    {
      label: "an over-set contract comes down",
      in: { annualPeakMd: 420, recordedMd: 400, headroomPct: 10, cdStep: 5 },
      out: { peakConsidered: 420, withHeadroom: 462, recommended: 465 }
    },
    {
      label: "no rounding step: the headroom figure stands",
      in: { annualPeakMd: 777, recordedMd: 700, headroomPct: 10, cdStep: 0 },
      out: { peakConsidered: 777, recommended: 854.7 }
    },
    {
      label: "no headroom and an exact multiple of the step",
      in: { annualPeakMd: 1150, recordedMd: 1000, headroomPct: 0, cdStep: 25 },
      out: { recommended: 1150 }
    },
    {
      label: "a 100 kVA step rounds a 1298 target up to 1300",
      in: { annualPeakMd: 1180, recordedMd: 0, headroomPct: 10, cdStep: 100 },
      out: { recommended: 1300 }
    },
    {
      label: "zero demand everywhere recommends zero, not NaN",
      in: { annualPeakMd: 0, recordedMd: 0, headroomPct: 10, cdStep: 5 },
      out: { peakConsidered: 0, recommended: 0 }
    }
  ];
  for (const c of cases) {
    const got = E.recommendContractDemand(Object.assign({ unit: "kVA" }, c.in));
    for (const k of Object.keys(c.out)) {
      if (typeof c.out[k] === "number") near(got[k], c.out[k], 1e-6, c.label + " -> " + k);
      else assert.equal(got[k], c.out[k], c.label + " -> " + k);
    }
    assert.ok(got.recommended >= got.peakConsidered, c.label + ": never recommends a contract below the peak");
    assertAllFinite(got, "cd(" + c.label + ")");
  }
});

test("the rounding step is immune to binary-floating-point dust", () => {
  /* 1150/25 is 46 in exact arithmetic but can land at 45.999999999999996,
     which an unguarded Math.ceil turns into 46 -> fine, or 46.000000000001,
     which it turns into 47 and overshoots the contract by a whole step. */
  for (const step of [1, 2.5, 5, 10, 25, 50, 100]) {
    for (const peak of [100, 345, 777.7, 1150, 2875, 9999.99]) {
      const got = E.recommendContractDemand({ annualPeakMd: peak, recordedMd: 0, headroomPct: 0, cdStep: step, unit: "kVA" });
      assert.ok(got.recommended >= peak, "covers the peak at step " + step);
      assert.ok(
        got.recommended - peak < step + 1e-6,
        "never overshoots by more than one step (" + step + " at peak " + peak + " gave " + got.recommended + ")"
      );
    }
  }
});

/* ================================================================== *
 * 5. TIME-OF-DAY
 * ================================================================== */

test("Time-of-Day rates can be entered as percentages of base or as outright rates", () => {
  const pct = E.todSchedule(withBase({ todMode: "percent" }));
  near(pct.byKey.offpeak.rate, 7.2, 1e-9, "off-peak = base - 10%");
  near(pct.byKey.normal.rate, 8, 1e-9, "normal = base");
  near(pct.byKey.peak.rate, 9.6, 1e-9, "peak = base + 20%");

  const direct = E.todSchedule(withBase({ todMode: "direct", rateOffPeak: 7.2, rateNormal: 8, ratePeak: 9.6 }));
  for (const k of ["offpeak", "normal", "peak"]) {
    near(direct.byKey[k].rate, pct.byKey[k].rate, 1e-9, k + " agrees across both entry modes");
  }
  near(direct.energyCharge, pct.energyCharge, 1e-6, "and so does the energy charge");
});

test("the energy charge is units times the slab rate, slab by slab", () => {
  const got = E.todSchedule(BASE);
  /* 60000 x 7.2 = 4,32,000 | 190000 x 8 = 15,20,000 | 90000 x 9.6 = 8,64,000 */
  near(got.byKey.offpeak.charge, 432000, 1e-6);
  near(got.byKey.normal.charge, 1520000, 1e-6);
  near(got.byKey.peak.charge, 864000, 1e-6);
  near(got.energyCharge, 2816000, 1e-6, "total energy charge");
  assert.equal(got.totalUnits, 340000);
  near(got.blendedRate, 2816000 / 340000, 1e-9, "blended rate per unit");
});

test("zero units gives a zero charge and a null blended rate, never a division by zero", () => {
  const got = E.todSchedule(withBase({ unitsOffPeak: 0, unitsNormal: 0, unitsPeak: 0 }));
  assert.equal(got.totalUnits, 0);
  assert.equal(got.energyCharge, 0);
  assert.equal(got.blendedRate, null, "reported as unknown, not NaN");
  assert.ok(hasCode(got.warnings, "ZERO_UNITS"));
  assertAllFinite(got, "zero units");
});

test("a percentage that drives a slab rate negative is read as zero and flagged", () => {
  const got = E.todSchedule(withBase({ todOffPeakPct: -200 }));
  assert.equal(got.byKey.offpeak.rate, 0);
  assert.ok(hasCode(got.warnings, "NEGATIVE_SLAB_RATE"));
  assertAllFinite(got, "negative slab rate");
});

test("shifting load out of peak saves the rate difference on the units moved", () => {
  const tod = E.todSchedule(BASE);
  const cases = [
    {
      label: "30,000 kWh peak -> off-peak at a 2.40 gap",
      in: { shiftKwh: 30000, shiftTo: "offpeak" },
      out: { moved: 30000, savingPerKwh: 2.4, saving: 72000, capped: false, worthwhile: true }
    },
    {
      label: "the same units into the normal slab save less",
      in: { shiftKwh: 30000, shiftTo: "normal" },
      out: { moved: 30000, savingPerKwh: 1.6, saving: 48000, worthwhile: true }
    },
    {
      label: "you cannot shift more than the peak slab holds",
      in: { shiftKwh: 500000, shiftTo: "offpeak" },
      out: { moved: 90000, saving: 216000, capped: true }
    },
    {
      label: "shifting nothing saves nothing",
      in: { shiftKwh: 0, shiftTo: "offpeak" },
      out: { moved: 0, saving: 0, worthwhile: false, applied: 0 }
    }
  ];
  for (const c of cases) {
    const got = E.shiftAnalysis(withBase(c.in), tod);
    for (const k of Object.keys(c.out)) {
      if (typeof c.out[k] === "number") near(got[k], c.out[k], 1e-6, c.label + " -> " + k);
      else assert.equal(got[k], c.out[k], c.label + " -> " + k);
    }
    assertAllFinite(got, "shift(" + c.label + ")");
  }
  assert.ok(hasCode(E.shiftAnalysis(withBase({ shiftKwh: 500000 }), tod).warnings, "SHIFT_CAPPED"));
});

test("shifting into a dearer slab is reported as a loss and is not applied", () => {
  /* An inverted schedule: off-peak dearer than peak. Nonsense as a tariff, but
     a user can type it, and the tool must not call the loss a saving. */
  const odd = withBase({ todMode: "direct", ratePeak: 7, rateOffPeak: 9, rateNormal: 8 });
  const tod = E.todSchedule(odd);
  const got = E.shiftAnalysis(odd, tod);
  near(got.savingPerKwh, -2, 1e-9, "the gap is reported with its sign");
  assert.equal(got.worthwhile, false);
  assert.equal(got.applied, 0, "a losing shift is not applied to the optimised bill");
  assert.ok(hasCode(got.warnings, "SHIFT_NOT_WORTH_IT"));
});

test("peak units with no peak consumption cannot be shifted", () => {
  const noPeak = withBase({ unitsPeak: 0, shiftKwh: 50000 });
  const got = E.shiftAnalysis(noPeak, E.todSchedule(noPeak));
  assert.equal(got.available, 0);
  assert.equal(got.moved, 0);
  assert.equal(got.saving, 0);
  assert.ok(got.capped);
});

/* ================================================================== *
 * 6. POWER-FACTOR SURCHARGE AND REBATE
 * ================================================================== */

test("whole completed 0.01 steps survive binary-floating-point dust", () => {
  /* This is the bug this guard exists for. In IEEE 754, (0.95 - 0.87) * 100
     is 7.9999999999999964, so a naive Math.floor reports 7 points of
     shortfall instead of 8 and under-states the surcharge by a whole point.
     Five of the nine pairs below are wrong without the guard. */
  const cases = [
    { target: 0.95, pf: 0.87, points: 8, naiveWouldSay: 7 },
    { target: 0.95, pf: 0.88, points: 7, naiveWouldSay: 6 },
    { target: 0.95, pf: 0.9, points: 5, naiveWouldSay: 4 },
    { target: 0.95, pf: 0.84, points: 11, naiveWouldSay: 10 },
    { target: 0.95, pf: 0.79, points: 16, naiveWouldSay: 15 },
    { target: 0.95, pf: 0.86, points: 9, naiveWouldSay: 8 },
    { target: 0.95, pf: 0.875, points: 7, naiveWouldSay: 7 },
    { target: 0.9, pf: 0.87, points: 3, naiveWouldSay: 3 },
    { target: 0.92, pf: 0.85, points: 7, naiveWouldSay: 7 }
  ];
  for (const c of cases) {
    const got = E.pfAdjustment({
      pfNow: c.pf, pfTarget: c.target, pfPenaltyPctPerPoint: 1,
      pfIncentivePctPerPoint: 0.5, pfCapPct: 0, pfStep: "completed",
      pfBase: "both", demandTotal: 100000, energyTotal: 0
    });
    assert.equal(got.points, c.points, "pf " + c.pf + " vs target " + c.target);
    near(got.amount, 100000 * c.points / 100, 1e-6, "surcharge for pf " + c.pf);
    /* Show the naive route really would differ, so the test is not vacuous. */
    assert.equal(Math.floor((c.target - c.pf) * 100), c.naiveWouldSay,
      "naive floor for pf " + c.pf);
  }
});

test("pro-rata mode charges the fractional shortfall too", () => {
  const args = {
    pfNow: 0.875, pfTarget: 0.95, pfPenaltyPctPerPoint: 1, pfIncentivePctPerPoint: 0.5,
    pfCapPct: 0, pfBase: "both", demandTotal: 100000, energyTotal: 0
  };
  const completed = E.pfAdjustment(Object.assign({}, args, { pfStep: "completed" }));
  const prorata = E.pfAdjustment(Object.assign({}, args, { pfStep: "prorata" }));
  assert.equal(completed.points, 7);
  near(prorata.points, 7.5, 1e-6);
  near(prorata.amount - completed.amount, 500, 1e-6, "the half point is worth 0.5% of 1,00,000");
});

test("the surcharge base follows the tariff's wording", () => {
  const args = {
    pfNow: 0.9, pfTarget: 0.95, pfPenaltyPctPerPoint: 1, pfIncentivePctPerPoint: 0.5,
    pfCapPct: 0, pfStep: "completed", demandTotal: 500000, energyTotal: 2000000
  };
  const cases = [
    { base: "demand", amount: 25000, label: "demand charge" },
    { base: "energy", amount: 100000, label: "energy charge" },
    { base: "both", amount: 125000, label: "demand + energy charges" }
  ];
  for (const c of cases) {
    const got = E.pfAdjustment(Object.assign({}, args, { pfBase: c.base }));
    assert.equal(got.points, 5);
    near(got.amount, c.amount, 1e-6, "5% on the " + c.label);
    assert.equal(got.baseLabel, c.label);
  }
  /* An unrecognised choice falls back to the widest base rather than zero. */
  assert.equal(E.pfAdjustment(Object.assign({}, args, { pfBase: "nonsense" })).baseLabel, "demand + energy charges");
});

test("power factor above target produces a rebate carried as negative money", () => {
  const got = E.pfAdjustment({
    pfNow: 0.98, pfTarget: 0.95, pfPenaltyPctPerPoint: 1, pfIncentivePctPerPoint: 0.5,
    pfCapPct: 0, pfStep: "completed", pfBase: "both", demandTotal: 500000, energyTotal: 500000
  });
  assert.equal(got.direction, "rebate");
  assert.equal(got.points, 3);
  near(got.pct, 1.5, 1e-9);
  near(got.amount, -15000, 1e-6, "a rebate reduces the bill");
  assert.equal(got.surplusPoints, 3);
  assert.equal(got.shortfallPoints, 0);
});

test("power factor exactly at target is neither surcharged nor rebated", () => {
  const got = E.pfAdjustment({
    pfNow: 0.95, pfTarget: 0.95, pfPenaltyPctPerPoint: 1, pfIncentivePctPerPoint: 0.5,
    pfCapPct: 0, pfStep: "completed", pfBase: "both", demandTotal: 500000, energyTotal: 500000
  });
  assert.equal(got.direction, "none");
  assert.equal(got.points, 0);
  assert.equal(got.amount, 0);
});

test("a capped surcharge stops at the cap and records that it was capped", () => {
  const args = {
    pfNow: 0.7, pfTarget: 0.95, pfPenaltyPctPerPoint: 1, pfIncentivePctPerPoint: 0.5,
    pfStep: "completed", pfBase: "both", demandTotal: 400000, energyTotal: 600000
  };
  const uncapped = E.pfAdjustment(Object.assign({}, args, { pfCapPct: 0 }));
  assert.equal(uncapped.points, 25);
  near(uncapped.pct, 25, 1e-9);
  near(uncapped.amount, 250000, 1e-6);
  assert.equal(uncapped.capped, false, "0 means no cap");

  const capped = E.pfAdjustment(Object.assign({}, args, { pfCapPct: 10 }));
  near(capped.pct, 10, 1e-9);
  near(capped.amount, 100000, 1e-6);
  assert.equal(capped.capped, true);
});

test("an out-of-domain power factor refuses the adjustment instead of charging NaN", () => {
  for (const bad of [{ pfNow: 0 }, { pfNow: 1.4 }, { pfNow: NaN }, { pfTarget: 0 }, { pfTarget: 2 }]) {
    const got = E.pfAdjustment(Object.assign({
      pfNow: 0.9, pfTarget: 0.95, pfPenaltyPctPerPoint: 1, pfIncentivePctPerPoint: 0.5,
      pfCapPct: 0, pfStep: "completed", pfBase: "both", demandTotal: 500000, energyTotal: 500000
    }, bad));
    assert.equal(got.ok, false, JSON.stringify(bad) + " is refused");
    assert.equal(got.applicable, false);
    assert.equal(got.amount, 0, "and contributes exactly zero to the bill");
    assert.ok(got.message.length > 20);
    assertAllFinite(got, "refused pf adjustment");
  }
});

/* ================================================================== *
 * 7. THE WHOLE BILL
 * ================================================================== */

test("the baseline bill adds up line by line to a figure checkable by hand", () => {
  const b = E.buildBill(E.resolve(BASE));
  /* demand   1000 x 400 normal + 150 x 400 x 2 penal        = 5,20,000
     energy   4,32,000 + 15,20,000 + 8,64,000                = 28,16,000
     fppca    3,40,000 units x 0.50                          =  1,70,000
     pf       11 points x 1% of (5,20,000 + 28,16,000)        =  3,66,960
     other                                                   =     5,000
     subtotal                                                = 38,77,960
     duty     9% of 38,77,960                                 =  3,49,016.40
     total                                                   = 42,26,976.40 */
  near(b.demand.total, 520000, 1e-6, "demand charge");
  near(b.tod.energyCharge, 2816000, 1e-6, "energy charge");
  near(b.fppca, 170000, 1e-6, "fuel adjustment");
  assert.equal(b.pf.points, 11);
  near(b.pf.amount, 366960, 1e-6, "power-factor surcharge");
  near(b.other, 5000, 1e-9, "other charges");
  near(b.subtotal, 3877960, 1e-6, "subtotal before duty");
  near(b.duty, 349016.4, 1e-6, "electricity duty");
  near(b.total, 4226976.4, 1e-6, "bill total");
  near(b.avgRatePerUnit, 4226976.4 / 340000, 1e-9, "all-in rate per unit");
  assertAllFinite(b, "baseline bill");
});

test("duty is never charged on a negative subtotal", () => {
  /* A large rebate with no other charges could push the subtotal below zero;
     duty on that would be a refund of a tax nobody paid. */
  const b = E.buildBill(E.resolve(withBase({
    pfNow: 0.99, pfTarget: 0.6, pfIncentivePctPerPoint: 40,
    demandRate: 0, baseRate: 1, fppcaRate: 0, otherCharges: 0,
    unitsOffPeak: 0, unitsNormal: 1000, unitsPeak: 0, todPeakPct: 0, todOffPeakPct: 0
  })));
  assert.ok(b.subtotal < 0, "this contrived case really does go negative");
  assert.equal(b.duty, 0, "no duty on a negative subtotal");
  assertAllFinite(b, "negative subtotal");
});

test("a completely empty form produces a zero bill and no NaN anywhere", () => {
  const b = E.buildBill(E.resolve({}));
  assert.equal(b.total, 0);
  assert.equal(b.totalUnits, 0);
  assert.equal(b.avgRatePerUnit, null);
  assert.ok(hasCode(b.errors, "CONTRACT_DEMAND_REQUIRED"));
  assert.ok(codes(b.errors).indexOf("PF_NOT_A_NUMBER") !== -1, "blank power factor is refused, not read as zero");
  assertAllFinite(b, "empty form");
});

test("payback months", () => {
  const cases = [
    { cost: 200000, saving: 50000, months: 4, ok: true },
    { cost: 208879.3, saving: 516101.92, months: 208879.3 / 516101.92, ok: true },
    { cost: 0, saving: 50000, months: 0, ok: true, code: "NO_COST" },
    { cost: 200000, saving: 0, ok: false, code: "NO_MONTHLY_SAVING" },
    { cost: 200000, saving: -1000, ok: false, code: "NO_MONTHLY_SAVING" },
    { cost: 200000, saving: NaN, ok: false, code: "NO_MONTHLY_SAVING" },
    { cost: NaN, saving: 50000, months: 0, ok: true, code: "NO_COST" }
  ];
  for (const c of cases) {
    const got = E.paybackMonths(c.cost, c.saving);
    assert.equal(got.ok, c.ok, "cost " + c.cost + " / saving " + c.saving);
    if (c.ok) {
      near(got.months, c.months, 1e-6, "months");
      near(got.years, c.months / 12, 1e-6, "years");
    } else {
      assert.equal(got.months, null, "no payback is null, never Infinity");
      assert.equal(got.years, null);
    }
    if (c.code) assert.equal(got.code, c.code);
  }
});

/* ================================================================== *
 * 8. COMPUTE — the whole decode end to end
 * ================================================================== */

test("the baseline decode reaches the figures derived by hand", () => {
  const r = E.compute(BASE);
  assert.equal(r.ok, true, "no errors on a complete form");
  near(r.current.total, 4226976.4, 1e-6, "bill as entered");

  /* contract demand: 12-month peak 1180 x 1.10 = 1298 -> 1300 at a 5 step */
  assert.equal(r.demandRecommendation.asIs.recommended, 1300);
  assert.equal(r.demandRecommendation.direction, "increase");
  near(r.demandRecommendation.changeAmount, 300, 1e-9);

  /* power factor 0.84 -> 0.95 at 966 kW (1150 kVA x 0.84) */
  near(r.powerFactorPlan.kwForSizing, 966, 1e-9, "kW behind the recorded kVA peak");
  near(r.powerFactorPlan.capacitor.kvar, 966 * (Math.sqrt(1 - 0.7056) / 0.84 - Math.sqrt(0.0975) / 0.95), 1e-9);
  near(r.powerFactorPlan.capacitor.totalCost, 966 * (Math.sqrt(1 - 0.7056) / 0.84 - Math.sqrt(0.0975) / 0.95) * 600 + 25000, 1e-6);

  /* correcting to 0.95 shrinks the kVA peak in the ratio 0.84/0.95 */
  near(r.powerFactorPlan.mdImproved, 1016.84, 1e-9, "improved recorded MD, rounded to 2dp");
  near(r.powerFactorPlan.mdReduction, 133.16, 1e-9, "kVA shaved off the peak");

  /* single levers, each against the bill as entered */
  near(r.levers.contractDemand.monthly, 72594, 1e-6, "contract-demand lever");
  near(r.levers.powerFactor.monthly, 516101.92, 1e-6, "power-factor lever");
  near(r.levers.timeOfDay.monthly, 87112.8, 1e-6, "peak-shift lever");

  /* all three together: one complete bill against another */
  near(r.optimised.total, 3625052.24, 1e-6, "optimised bill");
  near(r.savings.combinedMonthly, 601924.16, 1e-6, "combined monthly saving");
  near(r.savings.combinedAnnual, 601924.16 * 12, 1e-4, "annualised");

  assertAllFinite(r, "baseline compute");
});

test("the combined saving is a difference of two complete bills, not a sum of levers", () => {
  const r = E.compute(BASE);
  near(r.savings.combinedMonthly, r.current.total - r.optimised.total, 1e-9, "definition holds");
  assert.ok(
    Math.abs(r.savings.leverSum - r.savings.combinedMonthly) > 1,
    "on this bill the levers really do overlap, so the distinction matters"
  );
  assert.ok(hasCode(r.warnings, "LEVERS_INTERACT"), "and the overlap is disclosed");
});

test("an over-set contract demand is found and costed, and the revision comes down", () => {
  /* Same plant, but the owner contracted 1000 kVA and never draws past 420. */
  const r = E.compute(withBase({ contractDemand: 1000, recordedMd: 400, annualPeakMd: 420 }));
  near(r.current.demand.minBillFloor, 750, 1e-9);
  near(r.current.demand.idleCapacity, 350, 1e-9, "350 kVA of capacity paid for and never drawn");
  near(r.diagnostics.idleCapacityCost, 140000, 1e-6, "350 x 400");
  assert.equal(r.current.demand.excess, 0, "no exceedance in this direction");
  assert.equal(r.demandRecommendation.direction, "reduce");
  assert.equal(r.demandRecommendation.asIs.recommended, 465, "420 x 1.10 = 462 -> 465 at a 5 step");
  assert.ok(r.levers.contractDemand.monthly > 0, "and reducing it saves money every month");
  assertAllFinite(r, "over-set contract demand");
});

test("the recommendation never trades a penalty for a guaranteed future penalty", () => {
  const r = E.compute(withBase({ contractDemand: 500, recordedMd: 1150, annualPeakMd: 1180 }));
  assert.ok(r.demandRecommendation.asIs.recommended >= 1180, "covers the 12-month peak");
  assert.equal(r.demandRecommendation.direction, "increase");
  /* With the contract raised to cover the peak, the exceedance penalty goes. */
  assert.equal(r.leverBills.contractDemand.demand.excess, 0);
});

test("raising contract demand can cost more than the penalty it removes, and that is reported", () => {
  /* A seasonal plant: one spike to 1180 kVA, but this month it drew 300 kVA.
     Contracting for the spike raises the minimum-billing floor all year. */
  const r = E.compute(withBase({
    contractDemand: 320, recordedMd: 300, annualPeakMd: 1180,
    pfNow: 0.95, pfTarget: 0.95, shiftKwh: 0
  }));
  assert.ok(r.savings.combinedMonthly < 0, "the optimised month bills more");
  assert.equal(r.savings.headlineMonthly, 0, "the headline does not show a negative saving as a saving");
  assert.ok(hasCode(r.warnings, "OPTIMISED_COSTS_MORE"), "and the finding is spelled out");
  assertAllFinite(r, "seasonal plant");
});

test("a kW-billed tariff gets no demand reduction from a capacitor", () => {
  const kva = E.compute(withBase({ demandUnit: "kVA" }));
  const kw = E.compute(withBase({ demandUnit: "kW" }));
  assert.ok(kva.powerFactorPlan.mdReduction > 0, "kVA billing: correction shaves the billed demand");
  assert.equal(kw.powerFactorPlan.mdReduction, 0, "kW billing: it does not");
  /* The bank is still worth fitting for the surcharge alone, and is sized on
     the recorded kW rather than kVA x PF. */
  near(kw.powerFactorPlan.kwForSizing, 1150, 1e-9);
  assert.ok(kw.levers.powerFactor.monthly > 0, "the surcharge is still avoided");
  assert.ok(kva.levers.powerFactor.monthly > kw.levers.powerFactor.monthly, "but kVA billing saves more");
});

test("an explicit sizing kW overrides the figure derived from the demand", () => {
  const r = E.compute(withBase({ sizingKw: 500 }));
  assert.equal(r.powerFactorPlan.kwForSizing, 500);
  assert.equal(r.powerFactorPlan.capacitor.kwBasis, "entered");
  near(r.powerFactorPlan.capacitor.kvar, 500 * (Math.sqrt(1 - 0.7056) / 0.84 - Math.sqrt(0.0975) / 0.95), 1e-9);
  /* The MD reduction still follows the recorded demand, not the sizing kW. */
  near(r.powerFactorPlan.mdImproved, 1016.84, 1e-9);
});

test("a power factor already above target recommends no capacitor and no PF saving", () => {
  const r = E.compute(withBase({ pfNow: 0.98, pfTarget: 0.95 }));
  assert.equal(r.powerFactorPlan.improves, false);
  assert.equal(r.powerFactorPlan.capacitor.needed, false);
  assert.equal(r.powerFactorPlan.capacitor.kvar, 0);
  assert.equal(r.powerFactorPlan.capacitor.totalCost, 0, "no bank, no cost");
  assert.equal(r.levers.powerFactor.monthly, 0);
  assert.equal(r.powerFactorPlan.payback.ok, false);
  assert.equal(r.powerFactorPlan.payback.months, null);
  assert.equal(r.current.pf.direction, "rebate", "and the rebate already earned is left alone");
  assert.ok(r.current.pf.amount < 0);
  assertAllFinite(r, "already above target");
});

test("compute refuses an out-of-domain power factor and still decodes the rest of the bill", () => {
  const cases = [
    { pfNow: 0, code: "PF_NOT_POSITIVE" },
    { pfNow: 1.5, code: "PF_ABOVE_UNITY" },
    { pfNow: 95, code: "PF_ABOVE_UNITY" },
    { pfNow: "", code: "PF_NOT_A_NUMBER" },
    { pfTarget: 0, code: "PF_NOT_POSITIVE" },
    { pfTarget: 1.2, code: "PF_ABOVE_UNITY" }
  ];
  for (const c of cases) {
    const over = {};
    if ("pfNow" in c) over.pfNow = c.pfNow;
    if ("pfTarget" in c) over.pfTarget = c.pfTarget;
    const r = E.compute(withBase(over));

    assert.equal(r.ok, false, JSON.stringify(over) + " is refused");
    assert.ok(hasCode(r.errors, c.code), "with code " + c.code);
    assert.equal(r.powerFactorPlan.usable, false);
    assert.equal(r.powerFactorPlan.capacitor.kvar, 0, "no capacitor size is invented");
    assert.equal(r.current.pf.amount, 0, "no power-factor money is invented");

    /* The demand and energy lines do not depend on power factor, so they
       still decode: refusing one input must not blank the whole bill. */
    near(r.current.demand.total, 520000, 1e-6, "demand still decoded");
    near(r.current.tod.energyCharge, 2816000, 1e-6, "energy still decoded");
    assert.ok(r.levers.timeOfDay.monthly > 0, "the peak shift is still costed");
    assertAllFinite(r, "refused pf, rest of bill");
  }
});

test("compute survives every degenerate input combination without a NaN", () => {
  const nasty = [
    { label: "everything blank", in: {} },
    { label: "all zeroes", in: withBase({
      contractDemand: 0, recordedMd: 0, annualPeakMd: 0, demandRate: 0, penalMultiple: 0,
      minBillPct: 0, cdStep: 0, headroomPct: 0, baseRate: 0, unitsOffPeak: 0,
      unitsNormal: 0, unitsPeak: 0, todPeakPct: 0, todOffPeakPct: 0, shiftKwh: 0,
      fppcaRate: 0, dutyPct: 0, otherCharges: 0, capCostPerKvar: 0, capFixedCost: 0,
      pfPenaltyPctPerPoint: 0, pfIncentivePctPerPoint: 0
    }) },
    { label: "zero demand, units present", in: withBase({ contractDemand: 0, recordedMd: 0, annualPeakMd: 0 }) },
    { label: "zero units, demand present", in: withBase({ unitsOffPeak: 0, unitsNormal: 0, unitsPeak: 0 }) },
    { label: "zero power factor", in: withBase({ pfNow: 0 }) },
    { label: "power factor above unity", in: withBase({ pfNow: 1.3 }) },
    { label: "target below current", in: withBase({ pfNow: 0.97, pfTarget: 0.9 }) },
    { label: "target equal to current", in: withBase({ pfNow: 0.9, pfTarget: 0.9 }) },
    { label: "unity on both sides", in: withBase({ pfNow: 1, pfTarget: 1 }) },
    { label: "negatives everywhere", in: withBase({
      contractDemand: -1000, recordedMd: -50, demandRate: -400, minBillPct: -10,
      unitsPeak: -9000, baseRate: -8, fppcaRate: -1, dutyPct: -9, cdStep: -5,
      capCostPerKvar: -600, headroomPct: -10, shiftKwh: -100
    }) },
    { label: "strings from the form", in: withBase({
      contractDemand: "1000", recordedMd: "1150", pfNow: "0.84", pfTarget: "0.95",
      unitsPeak: "90000", baseRate: "8", dutyPct: "9"
    }) },
    { label: "text in number fields", in: withBase({
      contractDemand: "abc", recordedMd: "x", demandRate: "-", unitsPeak: "n/a", baseRate: "8.5.5"
    }) },
    { label: "absurdly large figures", in: withBase({
      contractDemand: 1e9, recordedMd: 1e9, demandRate: 1e6, unitsPeak: 1e9, baseRate: 1e3
    }) },
    { label: "tiny power factor in domain", in: withBase({ pfNow: 1e-6 }) },
    { label: "no minimum billing, no penalty, no duty", in: withBase({ minBillPct: 0, penalMultiple: 1, dutyPct: 0 }) },
    { label: "direct Time-of-Day mode with blanks", in: withBase({ todMode: "direct", rateNormal: 0, ratePeak: 0, rateOffPeak: 0 }) },
    { label: "inverted Time-of-Day schedule", in: withBase({ todMode: "direct", ratePeak: 5, rateNormal: 8, rateOffPeak: 11 }) },
    { label: "shift beyond the peak slab", in: withBase({ shiftKwh: 1e9 }) },
    { label: "100% minimum billing", in: withBase({ minBillPct: 100 }) },
    { label: "pro-rata power-factor steps", in: withBase({ pfStep: "prorata" }) },
    { label: "capped power-factor surcharge", in: withBase({ pfCapPct: 5 }) },
    { label: "kW-billed tariff", in: withBase({ demandUnit: "kW" }) },
    { label: "surcharge on the demand charge only", in: withBase({ pfBase: "demand" }) },
    { label: "surcharge on the energy charge only", in: withBase({ pfBase: "energy" }) }
  ];

  for (const c of nasty) {
    const r = E.compute(c.in);
    assertAllFinite(r, "compute(" + c.label + ")");
    /* Rupee figures that the page prints must be real numbers or null. */
    for (const k of ["combinedMonthly", "combinedAnnual", "headlineMonthly", "headlineAnnual", "leverSum"]) {
      assert.ok(Number.isFinite(r.savings[k]), c.label + ": savings." + k + " is finite");
    }
    assert.ok(r.savings.headlineMonthly >= 0, c.label + ": the headline is never negative");
    assert.ok(
      r.powerFactorPlan.payback.months === null || Number.isFinite(r.powerFactorPlan.payback.months),
      c.label + ": payback is a number or null"
    );
    assert.ok(r.powerFactorPlan.capacitor.kvar >= 0, c.label + ": the bank is never negative");
    /* Every error and warning carries prose a factory owner can act on. */
    for (const e of r.errors.concat(r.warnings)) {
      assert.ok(typeof e.code === "string" && e.code.length > 0, c.label + ": issue has a code");
      assert.ok(typeof e.message === "string" && e.message.length > 20, c.label + ": issue " + e.code + " explains itself");
    }
  }
});

test("negative inputs are floored at zero rather than flipping the arithmetic", () => {
  const r = E.compute(withBase({ recordedMd: -500, demandRate: -400, unitsPeak: -9000 }));
  assert.equal(r.resolved.recordedMd, 0);
  assert.equal(r.resolved.demandRate, 0);
  assert.equal(r.resolved.unitsPeak, 0);
  assert.equal(r.current.demand.total, 0, "a negative rate cannot credit the bill");
  assertAllFinite(r, "negatives");
});

test("the decode is a pure function of its input", () => {
  const input = withBase({});
  const frozen = JSON.stringify(input);
  const a = JSON.stringify(E.compute(input));
  const b = JSON.stringify(E.compute(input));
  assert.equal(JSON.stringify(input), frozen, "compute does not mutate the input");
  assert.equal(a, b, "and returns the same answer twice");
});

test("every diagnostic figure the page shows is finite or explicitly unknown", () => {
  const r = E.compute(BASE);
  near(r.diagnostics.exceedancePremium, 60000, 1e-6, "the avoidable half of the penal charge");
  near(r.diagnostics.exceedanceFullCharge, 120000, 1e-6, "the whole penal charge");
  near(r.diagnostics.idleCapacityCost, 0, 1e-9);
  near(r.diagnostics.pfSurcharge, 366960, 1e-6);
  near(r.diagnostics.pfRebate, 0, 1e-9);
  near(r.diagnostics.peakPremiumOnShiftable, 72000, 1e-6, "30,000 kWh x 2.40");
  near(r.diagnostics.peakSharePct, 90000 * 100 / 340000, 1e-9);

  const empty = E.compute({});
  assert.equal(empty.diagnostics.peakSharePct, null, "unknown rather than NaN");
});
