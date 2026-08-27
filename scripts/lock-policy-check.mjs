// Standalone verification of the pure lock policy. Run: node scripts/lock-policy-check.mjs
import { applyAttempt, escalationDelayMs, isLockedOut, MAX_FAILS_BEFORE_REAUTH } from "../src/lib/lock-policy.ts";

let pass = 0, fail = 0;
const eq = (a, b, msg) => {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) pass++; else { fail++; console.log("FAIL:", msg, "\n  got", JSON.stringify(a), "\n  want", JSON.stringify(b)); };
};

// escalation table
eq([0,1,2,3,4].map(escalationDelayMs), [0,0,0,0,0], "first 5 fails are free");
eq([5,6,7,8,9].map(escalationDelayMs), [30000,60000,120000,300000,600000], "escalation ramp");

// correct PIN from clean state
eq(applyAttempt({fails:0,lockUntil:null}, true, 1000).outcome, {kind:"ok"}, "match => ok");
eq(applyAttempt({fails:3,lockUntil:null}, true, 1000).next, {fails:0,lockUntil:null}, "match resets fails");

// wrong PIN below threshold: no cooldown, counts down remaining
let s = {fails:0,lockUntil:null};
for (let i=1;i<=4;i++){ const r=applyAttempt(s,false,1000); s=r.next; eq(r.outcome,{kind:"wrong",failsLeft:MAX_FAILS_BEFORE_REAUTH-i},`fail #${i} wrong`); }
eq(s,{fails:4,lockUntil:null},"4 fails, still no lockout");

// 5th wrong => 30s lockout
let r5 = applyAttempt(s, false, 10_000);
eq(r5.outcome, {kind:"locked_out", retryAt:40_000}, "5th fail => 30s lockout");
eq(r5.next, {fails:5,lockUntil:40_000}, "state records lockUntil");

// during lockout, a further attempt (even correct) is refused without changing state
eq(applyAttempt(r5.next, true, 20_000).outcome, {kind:"locked_out",retryAt:40_000}, "locked out ignores correct PIN mid-cooldown");
eq(applyAttempt(r5.next, true, 20_000).next, r5.next, "locked out does not mutate state");
eq(isLockedOut(r5.next, 39_999), true, "still locked just before retryAt");
eq(isLockedOut(r5.next, 40_000), false, "unlocked at retryAt");

// after cooldown expires, a correct PIN succeeds and resets
eq(applyAttempt(r5.next, true, 40_001).outcome, {kind:"ok"}, "correct after cooldown => ok");

// walk to the reauth cliff: fails 5..9 escalate, fail 10 => must_reauth
let t = {fails:9,lockUntil:null};
eq(applyAttempt(t,false,1000).outcome, {kind:"must_reauth"}, "10th fail => must_reauth");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
