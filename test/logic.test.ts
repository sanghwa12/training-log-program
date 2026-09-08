import { test } from "node:test";
import assert from "node:assert/strict";
import {
  localDate, localTime, daysBetween, shiftDate, weekStart, weekday, topKg, bestSet, historyOf, weeklyTrend, monthlyTrend, hints,
  nextSession, templatesOf, todayPlan, toLogText, parseLogText, defaultDoc, newExercise, slugId, removeExercise, restoreExercise, HIDDEN, ParseError,
} from "../src/logic.ts";
import type { SetRec, Doc, HistItem } from "../src/logic.ts";

// ---------- 도우미 ----------

const S = (s: string): SetRec[] => s.split(" ").map(tok => {
  const [kg, reps] = tok.split("x").map(Number);
  return { kg, reps };
});
const H = (...items: [string, string][]): HistItem[] => items.map(([date, sets]) => ({ date, sets: S(sets) })); // 최신 우선
const TODAY = "2026-09-08";

// ---------- 날짜·시각 ----------

test("localDate: 자정 30분은 그날(UTC였다면 전날); localTime HH:MM", () => {
  assert.equal(localDate(new Date(2026, 8, 7, 0, 30)), "2026-09-07");
  assert.equal(localTime(new Date(2026, 8, 7, 18, 5)), "18:05");
});
test("daysBetween / shiftDate / weekStart(월요일) / weekday", () => {
  assert.equal(daysBetween("2026-09-07", "2026-09-27"), 20);
  assert.equal(shiftDate("2026-08-30", 3), "2026-09-02");
  assert.equal(weekStart("2026-09-08"), "2026-09-07"); // 화 → 월
  assert.equal(weekStart("2026-09-07"), "2026-09-07"); // 월
  assert.equal(weekStart("2026-09-13"), "2026-09-07"); // 일 → 같은 주 월
  assert.equal(weekday("2026-09-08"), "화");
});

// ---------- 세트 요약·추세 ----------

test("topKg / bestSet: 무게 우선, 같으면 횟수", () => {
  assert.equal(topKg(S("40x8 42.5x5 42.5x6")), 42.5);
  assert.deepEqual(bestSet(S("40x8 42.5x5 42.5x6")), { kg: 42.5, reps: 6 });
  assert.equal(bestSet([]), null);
  assert.equal(topKg([]), 0);
});
test("weeklyTrend: 주별 최고 무게·최고 세트·세션 수, 최신 주부터, 기록 있는 주만", () => {
  const hist = H(["2026-09-08", "62.5x8 62.5x7"], ["2026-09-03", "60x8 60x8"], ["2026-09-01", "60x6 60x6"], ["2026-08-20", "57.5x8"]);
  const w = weeklyTrend(hist);
  assert.deepEqual(w.map(p => [p.label, p.topKg, p.best, p.sessions]), [
    ["9/7~9/13", 62.5, { kg: 62.5, reps: 8 }, 1],
    ["8/31~9/6", 60, { kg: 60, reps: 8 }, 2],
    ["8/17~8/23", 57.5, { kg: 57.5, reps: 8 }, 1],
  ]);
  assert.equal(weeklyTrend(hist, 2).length, 2);
});
test("monthlyTrend: 월별", () => {
  const hist = H(["2026-09-08", "62.5x8"], ["2026-09-01", "60x6"], ["2026-08-20", "57.5x8"], ["2026-06-01", "50x5"]);
  assert.deepEqual(monthlyTrend(hist).map(p => [p.label, p.topKg, p.sessions]), [["2026년 9월", 62.5, 2], ["2026년 8월", 57.5, 1], ["2026년 6월", 50, 1]]);
});
test("hints: 공백·같은 무게 연속·직전 변화. 숫자 제안은 없음", () => {
  assert.deepEqual(hints([], null, TODAY), []);
  assert.deepEqual(hints(H(["2026-08-20", "60x8"]), "2026-08-20", TODAY), ["19일 만의 운동"]);
  const streak = H(["2026-09-05", "60x8"], ["2026-09-03", "60x7 60x6"], ["2026-09-01", "60x5"], ["2026-08-28", "57.5x8"]);
  assert.deepEqual(hints(streak, "2026-09-05", TODAY), ["60 kg로 3세션 연속 (9/1부터)"]);
  assert.deepEqual(hints(H(["2026-09-05", "62.5x5"], ["2026-09-03", "60x8"]), "2026-09-05", TODAY), ["직전 62.5 kg, 그 전 60 kg (+2.5 kg)"]);
  assert.deepEqual(hints(H(["2026-09-05", "55x5"], ["2026-09-03", "60x8"]), "2026-09-05", TODAY), ["직전 55 kg, 그 전 60 kg (-5 kg)"]);
  for (const h of hints(streak, "2026-08-01", TODAY)) assert.ok(!/다음|목표/.test(h));
});
// ---------- 세션 순서 ----------

test("nextSession: 빈 기록 → A, 마지막 A → B, 마지막 B → A, 강제 A", () => {
  const doc = defaultDoc("x");
  assert.equal(nextSession(doc.exercises, []).template, "A");
  assert.deepEqual(nextSession(doc.exercises, []).exercises.map(e => e.id), ["squat", "bench", "row"]);
  const A = { date: "2026-09-01", time: "18:00", template: "A", entries: [] };
  const B = { date: "2026-09-03", time: null, template: "B", entries: [] };
  assert.equal(nextSession(doc.exercises, [A]).template, "B");
  assert.equal(nextSession(doc.exercises, [A, B]).template, "A");
  assert.equal(nextSession(doc.exercises, [A], "A").template, "A");
});
test("todayPlan: 블록 없음 → null", () => {
  assert.equal(todayPlan(defaultDoc("x"), TODAY), null);
});
test("todayPlan: 진행 중 → 마지막 entry가 현재, 목록 = 블록 순서 + 남은 종목", () => {
  const doc = defaultDoc("x");
  doc.sessions = [{ date: TODAY, time: "18:00", template: "A", entries: [
    { id: "squat", sets: S("60x5 60x5 60x5") },
    { id: "bench", sets: S("40x5") },
  ] }];
  const p = todayPlan(doc, TODAY)!;
  assert.deepEqual(p.exercises.map(e => e.id), ["squat", "bench", "row"]);
  assert.equal(p.current, 1);
});
test("todayPlan: 세트 수 계획이 없으므로 몇 세트를 했든 현재는 마지막 entry; 건너뛴 종목은 뒤로", () => {
  const doc = defaultDoc("x");
  doc.sessions = [{ date: TODAY, time: null, template: "A", entries: [
    { id: "squat", sets: S("60x5 60x5 60x5") },
    { id: "row", sets: S("40x5") },
  ] }];
  const p = todayPlan(doc, TODAY)!;
  assert.deepEqual(p.exercises.map(e => e.id), ["squat", "row", "bench"]);
  assert.equal(p.current, 1);
  doc.sessions[0].entries[1].sets = S("40x5 40x5 40x5 40x5 40x5");
  assert.equal(todayPlan(doc, TODAY)!.current, 1);
});
test("todayPlan: entry 없는 블록(손편집) → 현재 0", () => {
  const doc = defaultDoc("x");
  doc.sessions = [{ date: TODAY, time: null, template: "B", entries: [] }];
  const p = todayPlan(doc, TODAY)!;
  assert.deepEqual(p.exercises.map(e => e.id), ["deadlift", "ohp", "pullup"]);
  assert.equal(p.current, 0);
});

// ---------- 종목 관리 ----------

test("newExercise: 이름 → id(공백은 _), 겹치면 _2, 예약어·% 처리", () => {
  const doc = defaultDoc("x");
  const a = newExercise(doc, " 레그 프레스 ", "A");
  assert.deepEqual(a, { id: "레그_프레스", name: "레그 프레스", template: "A" });
  doc.exercises.push(a);
  assert.equal(newExercise(doc, "레그 프레스", "B").id, "레그_프레스_2");
  assert.equal(newExercise(doc, "session", "A").id, "ex_session");
  assert.equal(slugId("50% 세트"), "50_세트");
  assert.equal(newExercise(doc, "squat", "A").id, "squat_2");
});
test("removeExercise: 기록 없으면 삭제, 있으면 숨김(-); 숨긴 종목은 세션 목록에서 빠지고 기록은 파싱됨; 복원", () => {
  const doc = defaultDoc("2026-09-07T20:15:33+09:00");
  assert.equal(removeExercise(doc, "row"), "deleted");
  assert.ok(!doc.exercises.some(e => e.id === "row"));
  doc.sessions = [{ date: "2026-09-01", time: "18:00", template: "A", entries: [{ id: "squat", sets: S("60x5 60x5 60x5") }] }];
  assert.equal(removeExercise(doc, "squat"), "hidden");
  assert.equal(doc.exercises.find(e => e.id === "squat")!.template, HIDDEN);
  assert.deepEqual(templatesOf(doc.exercises), ["A", "B"]);
  assert.deepEqual(nextSession(doc.exercises, []).exercises.map(e => e.id), ["bench"]);
  assert.equal(removeExercise(doc, "nope"), "missing");
  const text = toLogText(doc);
  assert.ok(text.includes("%% ex squat - 스쿼트 %%\n"));
  assert.deepEqual(parseLogText(text), doc);
  assert.equal(restoreExercise(doc, "squat", "A"), true);
  assert.deepEqual(nextSession(doc.exercises, []).exercises.map(e => e.id), ["squat", "bench"]);
  removeExercise(doc, "squat");
  doc.sessions.push({ date: "2026-09-07", time: null, template: "A", entries: [{ id: "squat", sets: S("60x5") }] });
  assert.deepEqual(todayPlan(doc, "2026-09-07")!.exercises.map(e => e.id), ["squat", "bench"]);
});

// ---------- 텍스트 왕복 ----------

function sampleDoc(): Doc {
  const doc = defaultDoc("2026-09-07T20:15:33+09:00");
  doc.exercises.push(newExercise(doc, "레그 프레스", "A"));
  doc.sessions = [
    { date: "2026-09-05", time: "18:32", template: "A", entries: [
      { id: "squat", sets: S("60x8 60x8 60x8") },
      { id: "bench", sets: S("42.5x8 42.5x7 42.5x6") },
      { id: "레그_프레스", sets: S("80x12") },
    ] },
    { date: "2026-09-07", time: null, template: "B", entries: [
      { id: "deadlift", sets: S("80x5 80x5") },
      { id: "pullup", sets: S("0x6 0x6 0x5") },
    ] },
  ];
  return doc;
}

test("toLogText → parseLogText 왕복 (v3: 세션 시각, 한글 id·이름, 소수)", () => {
  const doc = sampleDoc();
  const text = toLogText(doc);
  assert.deepEqual(parseLogText(text), doc);
  assert.match(text, /^%% tlog v3 2026-09-07T20:15:33\+09:00 %%\n/);
  assert.ok(text.includes("\n%% ex ohp B 오버헤드 프레스 %%\n"));
  assert.ok(text.includes("\n%% ex 레그_프레스 A 레그 프레스 %%\n"));
  assert.ok(text.includes("\n2026-09-05 session A 18:32\n2026-09-05 squat 60x8 60x8 60x8\n"));
  assert.ok(text.includes("\n2026-09-07 session B\n2026-09-07 deadlift 80x5 80x5\n"));
  assert.ok(text.includes("\n2026-09-05 레그_프레스 80x12\n"));
});
test("왕복: \\r\\n 입력과 BOM도 같은 문서; 기타 %% 주석·빈 줄 무시", () => {
  const doc = sampleDoc();
  const text = toLogText(doc);
  assert.deepEqual(parseLogText(text.replace(/\n/g, "\r\n")), doc);
  assert.deepEqual(parseLogText("\uFEFF" + text), doc);
  assert.deepEqual(parseLogText(text.replace("\n2026-09-05 session A", "\n%% 메모 %%\n\n2026-09-05 session A")), doc);
});
test("v1·v2 파일도 읽힌다(id·템플릿·이름만 취함), 저장은 v3", () => {
  const v1 = [
    "%% tlog v1 2026-09-07T20:15:33+09:00 %%",
    "%% ex squat A 3 5 8 5 60 스쿼트 %%",
    "%% ex ohp B 3 5 8 2.5 - 오버헤드 프레스 %%",
    "2026-09-05 session A",
    "2026-09-05 squat 60x8 60x8 60x8",
    "",
  ].join("\n");
  const doc = parseLogText(v1);
  assert.deepEqual(doc.exercises, [
    { id: "squat", template: "A", name: "스쿼트" },
    { id: "ohp", template: "B", name: "오버헤드 프레스" },
  ]);
  assert.deepEqual(doc.sessions, [{ date: "2026-09-05", time: null, template: "A", entries: [{ id: "squat", sets: S("60x8 60x8 60x8") }] }]);
  assert.match(toLogText(doc), /^%% tlog v3 /);
  const v2 = "%% tlog v2 2026-09-08T10:00:00+09:00 %%\n%% ex 레그_프레스 A 3 레그 프레스 %%\n2026-09-08 session A 18:32\n2026-09-08 레그_프레스 80x12\n";
  const d2 = parseLogText(v2);
  assert.deepEqual(d2.exercises, [{ id: "레그_프레스", template: "A", name: "레그 프레스" }]);
  assert.equal(d2.sessions[0].time, "18:32");
});
test("historyOf: 최신 우선, 세트 있는 entry만", () => {
  const doc = sampleDoc();
  assert.deepEqual(historyOf(doc.sessions, "squat"), [{ date: "2026-09-05", sets: S("60x8 60x8 60x8") }]);
  assert.deepEqual(historyOf(doc.sessions, "row"), []);
});

// ---------- 파서 거부 (줄 번호) ----------

const HEAD = "%% tlog v3 2026-09-07T20:15:33+09:00 %%\n%% ex squat A 스쿼트 %%\n";
function rejects(text: string, line: number, re: RegExp): void {
  assert.throws(() => parseLogText(text), (e: unknown) => {
    assert.ok(e instanceof ParseError, "ParseError가 아님");
    assert.equal(e.line, line, `줄 번호 기대 ${line}, 실제 ${e.line}: ${e.message}`);
    assert.match(e.message, re);
    return true;
  });
}
test("거부: 깨진 세트 squat 100x", () => {
  rejects(HEAD + "2026-09-07 session A\n2026-09-07 squat 60x8 100x\n", 4, /세트 형식/);
});
test("거부: session 줄 없는 블록", () => {
  rejects(HEAD + "2026-09-07 squat 60x8\n", 3, /session 줄이 없음/);
  rejects(HEAD + "2026-09-05 session A\n2026-09-07 squat 60x8\n", 4, /session 줄이 없음/);
});
test("거부: 모르는 id", () => {
  rejects(HEAD + "2026-09-07 session A\n2026-09-07 bench 40x8\n", 4, /모르는 종목 id: bench/);
});
test("거부: 중복·역순 날짜", () => {
  rejects(HEAD + "2026-09-07 session A\n2026-09-07 session B\n", 4, /중복되거나 역순/);
  rejects(HEAD + "2026-09-07 session A\n2026-09-05 session B\n", 4, /중복되거나 역순/);
});
test("거부: 헤더 없음·빈 파일 → 1행", () => {
  rejects("", 1, /첫 줄/);
  rejects("2026-09-07 session A\n", 1, /첫 줄/);
  rejects("%% ex squat A 스쿼트 %%\n", 1, /첫 줄/);
  rejects("%% tlog v4 2026-09-07T20:15:33+09:00 %%\n", 1, /첫 줄/);
});
test("거부: 닫는 %% 없는 주석 줄, ex 줄 형식, 시각 형식", () => {
  rejects("%% tlog v3 2026-09-07T20:15:33+09:00 %%\n%% ex squat A 스쿼트\n", 2, /닫는 %%/);
  rejects("%% tlog v3 2026-09-07T20:15:33+09:00 %%\n%% ex squat A %%\n", 2, /ex 줄 형식/);
  rejects(HEAD + "2026-09-07 session A 6pm\n", 3, /시각 형식/);
});
test("거부: 같은 날짜에 종목 중복; id에 % 또는 session", () => {
  rejects(HEAD + "2026-09-07 session A\n2026-09-07 squat 60x8\n2026-09-07 squat 60x8\n", 5, /종목 중복/);
  rejects("%% tlog v3 2026-09-07T20:15:33+09:00 %%\n%% ex a%b A 이상 %%\n", 2, /id에 공백/);
  rejects("%% tlog v3 2026-09-07T20:15:33+09:00 %%\n%% ex session A 이상 %%\n", 2, /session은 예약어/);
});
