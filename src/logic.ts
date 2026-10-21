// src/logic.ts — 순수 함수만. DOM·Obsidian API를 모른다. `node --test`로 검증한다.
// 이 파일은 Node의 타입 제거 실행 대상이므로 enum·namespace·생성자 매개변수 프로퍼티를 쓰지 않는다.
//
// 설계: 무게·횟수는 사용자가 정한다. 앱은 계산하지 않고, 날짜별 기록을 쌓아 추세(주간·월간 최고)와
// 사실만 알려 주는 힌트("60 kg로 3세션 연속")를 보여 준다.

export const FORMAT = "tlog v4";
export const LOG_PATH = "tlog.md";
export const GAP_DAYS = 14;     // 이 일수 이상 쉬었으면 알려 준다(정보)
export const SAME_STREAK = 3;   // 같은 최고 무게가 이만큼 이어지면 알려 준다(정보)
export const DEFAULT_STEP = 2.5; // 무게 칸을 정하지 않은 종목의 −/+ 단위

/** 종목. 템플릿(A/B) 구분은 없다 — 오늘 할 종목은 사용자가 그때그때 고른다. hidden이면 목록에서만 뺀다(기록은 유지). */
/** step = 그 기계의 무게 칸(kg). 없으면 DEFAULT_STEP. 파일에는 `%% step id kg %%` 줄로.
 *  routine = 이 종목이 속한 루틴 날. 파일에는 `%% routine id key %%` 줄로. */
export type Exercise = { id: string; name: string; hidden: boolean; step?: number; routine?: string };
export type SetRec = { kg: number; reps: number };
export type Entry = { id: string; sets: SetRec[] };
/** 하루 = 세션 하나. time은 첫 세트를 찍은 시각. run = 러닝 했음(`%% run 날짜 %%`),
 *  day = 그날의 루틴 날 key(`%% day 날짜 key %%`, 러닝만 한 날도 순환이 넘어가도록). 둘 다 주석 줄이라 0.5.x 이하는 무시한다. */
export type Session = { date: string; time: string | null; entries: Entry[]; run?: boolean; day?: string };

/**
 * 루틴 날. 순서대로 돌고(요일과 무관, 쉬는 날은 따지지 않음) 사용자가 앱에서 이름·개수·순서를 바꾼다.
 * key는 종목·세션이 가리키는 고정 열쇠라 이름을 바꿔도 그대로다. 파일에는 맨 위에 `%% rday key 이름 %%` 줄로, 순서대로.
 */
export type Day = { key: string; name: string };
/** 새 파일의 기본 분할: 가슴·등 → 하체 → 어깨·팔. */
export const DEFAULT_DAYS: Day[] = [{ key: "d1", name: "가슴·등" }, { key: "d2", name: "하체" }, { key: "d3", name: "어깨·팔" }];
export const DEFAULT_RUN_DAY = "d2"; // 러닝이 하체 칸을 대신한다
/** 0.6.0은 이 세 날이 고정이었다. rday 줄 없이 이 key를 쓰는 파일은 그 뜻 그대로 읽는다. */
export const LEGACY_DAYS: Day[] = [{ key: "chest-arms", name: "가슴·팔" }, { key: "legs", name: "하체" }, { key: "back-shoulders", name: "등·어깨" }];
export const dayName = (doc: Doc, key: string): string => doc.days.find(d => d.key === key)?.name ?? key;
/** runDay = 러닝이 대신하는 날(기본: 하체). 러닝한 날은 그 칸도 채운 것으로 친다. 파일에는 `%% runday key %%`. */
export type Doc = { writtenAt: string; exercises: Exercise[]; sessions: Session[]; days: Day[]; runDay?: string };
export type HistItem = { date: string; sets: SetRec[] };
/** 기간 요약. total = 그 기간 세션 합계(총량 kg 또는 맨몸이면 총 반복)의 최고. */
export type Period = { key: string; label: string; total: number; best: SetRec; sessions: number };

export class ParseError extends Error {
  line: number;
  constructor(line: number, message: string) {
    super(`${line}행: ${message}`);
    this.name = "ParseError";
    this.line = line;
  }
}

// ---------- 날짜·시각 ----------

const pad2 = (n: number): string => String(n).padStart(2, "0");
const round2 = (x: number): number => Math.round(x * 100) / 100;

/** 로컬 날짜 YYYY-MM-DD. toISOString은 UTC라 아침 운동이 전날로 저장되므로 쓰지 않는다. */
export function localDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** 로컬 시각 HH:MM. */
export function localTime(d: Date = new Date()): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 헤더용 시각: 2026-09-07T20:15:33+09:00 */
export function nowIso(d: Date = new Date()): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const a = Math.abs(off);
  return `${localDate(d)}T${localTime(d)}:${pad2(d.getSeconds())}${sign}${pad2(Math.floor(a / 60))}:${pad2(a % 60)}`;
}

const utcOf = (s: string): number => {
  const [y, m, d] = s.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};
const fromUtc = (ms: number): string => {
  const x = new Date(ms);
  return `${x.getUTCFullYear()}-${pad2(x.getUTCMonth() + 1)}-${pad2(x.getUTCDate())}`;
};

/** to - from (일). 두 날짜 문자열을 UTC 자정으로 바꿔 빼므로 DST·시간대에 흔들리지 않는다. */
export function daysBetween(from: string, to: string): number {
  return Math.round((utcOf(to) - utcOf(from)) / 86400000);
}

/** 날짜 + n일. */
export function shiftDate(date: string, days: number): string {
  return fromUtc(utcOf(date) + days * 86400000);
}

/** 그 날짜가 속한 주의 월요일. */
export function weekStart(date: string): string {
  const ms = utcOf(date);
  const dow = (new Date(ms).getUTCDay() + 6) % 7; // 월=0 … 일=6
  return fromUtc(ms - dow * 86400000);
}

export const monthKey = (date: string): string => date.slice(0, 7);

/** "2026-10" + n달. */
export function shiftMonth(month: string, n: number): string {
  const [y, m] = month.split("-").map(Number);
  const k = y * 12 + (m - 1) + n;
  return `${Math.floor(k / 12)}-${pad2((k % 12) + 1)}`;
}

/** 달력: 그 달이 걸친 주들(월요일 시작, 주간 최고와 같은 기준). 칸마다 YYYY-MM-DD, 앞뒤 달 날짜 포함. */
export function monthWeeks(month: string): string[][] {
  const weeks: string[][] = [];
  let d = weekStart(`${month}-01`);
  do {
    const w: string[] = [];
    for (let i = 0; i < 7; i++) { w.push(d); d = shiftDate(d, 1); }
    weeks.push(w);
  } while (monthKey(d) === month);
  return weeks;
}

/** 요일 한 글자. */
export function weekday(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return "일월화수목금토"[new Date(y, m - 1, d).getDay()];
}

/** 9/8 처럼 짧게. */
export const fmtShort = (date: string): string => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

// ---------- 세트 요약 ----------

/** 세션 총량 = 세트마다 kg×횟수의 합. 점진적 과부하는 이 수치로 본다(무게·횟수·세트 수 중 무엇을 늘리든 잡힌다). */
export const volume = (sets: SetRec[]): number => round2(sets.reduce((v, s) => v + s.kg * s.reps, 0));

/** 1680 → "1,680". */
export const fmtVol = (v: number): string => round2(v).toLocaleString("en-US");

/** 진행 기준. vol = 총량(kg×횟수 합), reps = 총 반복(맨몸 종목). */
export type Mode = "vol" | "reps";
export const totalReps = (sets: SetRec[]): number => sets.reduce((n, s) => n + s.reps, 0);
/** 맨몸 = 무게 0. 가장 최근 세션이 모두 0 kg이면 그 종목은 총 반복으로 본다(지난 기록에 다른 무게가 섞여 있어도 반복끼리 비교). */
export const modeOf = (hist: HistItem[]): Mode => (hist.length && hist[0].sets.every(s => s.kg === 0) ? "reps" : "vol");
export const measure = (sets: SetRec[], mode: Mode): number => (mode === "reps" ? totalReps(sets) : volume(sets));
export const fmtMeasure = (v: number, mode: Mode): string => (mode === "reps" ? `${v}회` : `${fmtVol(v)} kg`);
/** 세트 하나: 60×8, 맨몸이면 8회. */
export const fmtSet = (s: SetRec): string => (s.kg === 0 ? `${s.reps}회` : `${s.kg}×${s.reps}`);

/** 이 종목의 무게 한 칸. 무게 −/+ 버튼의 단위. */
export const stepOf = (ex: Exercise): number => ex.step ?? DEFAULT_STEP;

/** 최고 세트: 무게가 높은 것, 같으면 횟수가 많은 것. */
export function bestSet(sets: SetRec[]): SetRec | null {
  let best: SetRec | null = null;
  for (const s of sets) if (!best || s.kg > best.kg || (s.kg === best.kg && s.reps > best.reps)) best = s;
  return best;
}

/** 종목의 세션 기록, 최신 우선. 세트가 있는 entry만. */
export function historyOf(sessions: Session[], id: string): HistItem[] {
  const out: HistItem[] = [];
  for (let i = sessions.length - 1; i >= 0; i--) {
    const e = sessions[i].entries.find(x => x.id === id);
    if (e && e.sets.length) out.push({ date: sessions[i].date, sets: e.sets });
  }
  return out;
}

function summarize(hist: HistItem[], keyOf: (d: string) => string, labelOf: (d: string) => string, limit: number, mode: Mode): Period[] {
  const out: Period[] = [];
  for (const h of hist) {
    const key = keyOf(h.date);
    let p = out.length && out[out.length - 1].key === key ? out[out.length - 1] : null;
    if (!p) {
      if (out.length >= limit) break;
      p = { key, label: labelOf(h.date), total: 0, best: { kg: 0, reps: 0 }, sessions: 0 };
      out.push(p);
    }
    p.sessions++;
    p.total = Math.max(p.total, measure(h.sets, mode));
    const b = bestSet(h.sets);
    if (b && (b.kg > p.best.kg || (b.kg === p.best.kg && b.reps > p.best.reps))) p.best = b;
  }
  return out;
}

/** 주간 최고(월~일), 최신 주부터 limit개. 기록이 있는 주만. */
export function weeklyTrend(hist: HistItem[], limit: number = 8, mode: Mode = modeOf(hist)): Period[] {
  return summarize(hist, weekStart, d => `${fmtShort(weekStart(d))}~${fmtShort(shiftDate(weekStart(d), 6))}`, limit, mode);
}

/** 월간 최고, 최신 달부터 limit개. 기록이 있는 달만. */
export function monthlyTrend(hist: HistItem[], limit: number = 6, mode: Mode = modeOf(hist)): Period[] {
  return summarize(hist, monthKey, d => `${d.slice(0, 4)}년 ${Number(d.slice(5, 7))}월`, limit, mode);
}

/**
 * 정보성 힌트. 숫자를 제안하지 않고 사실만 말한다. 기준은 세션 총량(kg×횟수 합), 맨몸 종목은 총 반복.
 *  - 마지막 세션이 GAP_DAYS 이상 전
 *  - 같은 합계가 SAME_STREAK 세션 이상 이어짐
 *  - 직전 세션과 그 전 세션의 합계가 다름(변화량)
 */
export function hints(hist: HistItem[], lastSessionDate: string | null, today: string, mode: Mode = modeOf(hist)): string[] {
  const out: string[] = [];
  if (lastSessionDate) {
    const n = daysBetween(lastSessionDate, today);
    if (n >= GAP_DAYS) out.push(`${n}일 만의 운동`);
  }
  if (hist.length) {
    const name = mode === "reps" ? "총" : "총량";
    const f = (v: number): string => fmtMeasure(v, mode);
    const W = measure(hist[0].sets, mode);
    let n = 0;
    for (const h of hist) { if (measure(h.sets, mode) === W) n++; else break; }
    if (n >= SAME_STREAK) out.push(`${name} ${f(W)}로 ${n}세션 연속 (${fmtShort(hist[n - 1].date)}부터)`);
    if (hist.length >= 2) {
      const P = measure(hist[1].sets, mode);
      if (P !== W) {
        const d = round2(W - P);
        out.push(`직전 ${name} ${f(W)}, 그 전 ${f(P)} (${d > 0 ? "+" : "-"}${f(Math.abs(d))})`);
      }
    }
  }
  return out;
}

// ---------- 오늘 ----------

/** 오늘 블록(세션). 없으면 null. */
export function todayBlock(doc: Doc, today: string): Session | null {
  return doc.sessions.find(s => s.date === today) ?? null;
}

/** 그 날짜의 세션. 없으면 날짜 순서를 지켜 끼워 넣는다(지난 날짜 기록 보충용). */
export function sessionAt(doc: Doc, date: string, time: string | null): Session {
  const found = doc.sessions.find(s => s.date === date);
  if (found) return found;
  const s: Session = { date, time, entries: [] };
  const i = doc.sessions.findIndex(x => x.date > date);
  if (i < 0) doc.sessions.push(s); else doc.sessions.splice(i, 0, s);
  return s;
}

/** 숨기지 않은 종목, 파일 순서 그대로. 홈 목록이자 "다음 ›" 순서. */
export function visibleExercises(doc: Doc): Exercise[] {
  return doc.exercises.filter(e => !e.hidden);
}

/** 오늘 가장 최근에 세트를 찍기 시작한 종목 id. 앱을 다시 열 때 그 종목으로 돌아간다. */
export function lastEntryId(block: Session | null): string | null {
  return block && block.entries.length ? block.entries[block.entries.length - 1].id : null;
}

// ---------- 종목 관리 ----------

/** 이름 → id: 앞뒤 공백 제거, 안쪽 공백은 _, %는 제거. */
export function slugId(name: string): string {
  return name.trim().replace(/%/g, "").replace(/\s+/g, "_");
}

/** 사용자가 입력한 이름으로 새 종목을 만든다(문서에 넣는 것은 호출자). id가 겹치면 _2, _3… */
export function newExercise(doc: Doc, name: string): Exercise {
  const clean = name.trim();
  const base = slugId(clean) || "ex";
  let id = base === "session" ? "ex_session" : base;
  const ids = new Set(doc.exercises.map(e => e.id));
  for (let n = 2; ids.has(id); n++) id = `${base}_${n}`;
  return { id, name: clean, hidden: false };
}

/** 어느 세션에든 이 종목의 세트가 있는가. */
export function hasRecords(doc: Doc, id: string): boolean {
  return doc.sessions.some(s => s.entries.some(e => e.id === id && e.sets.length > 0));
}

/** 종목 삭제. 기록이 없으면 줄을 지우고 "deleted", 있으면 숨기고 "hidden"(기록 줄이 파서에서 거부되지 않도록). */
export function removeExercise(doc: Doc, id: string): "deleted" | "hidden" | "missing" {
  const i = doc.exercises.findIndex(e => e.id === id);
  if (i < 0) return "missing";
  if (hasRecords(doc, id)) {
    doc.exercises[i].hidden = true;
    return "hidden";
  }
  doc.exercises.splice(i, 1);
  return "deleted";
}

/** 숨긴 종목을 목록에 되돌린다. */
export function restoreExercise(doc: Doc, id: string): boolean {
  const ex = doc.exercises.find(e => e.id === id);
  if (!ex) return false;
  ex.hidden = false;
  return true;
}

/** 무게 칸을 정한다. 기본값(DEFAULT_STEP)이면 줄을 지운다. 0 이하·모르는 id는 false. */
export function setStep(doc: Doc, id: string, kg: number): boolean {
  const ex = doc.exercises.find(e => e.id === id);
  if (!ex || !(kg > 0)) return false;
  if (kg === DEFAULT_STEP) delete ex.step; else ex.step = round2(kg);
  return true;
}

/** 종목의 루틴 날을 정한다. null이면 루틴에서 뺀다. 모르는 id나 없는 날은 false. */
export function setRoutine(doc: Doc, id: string, key: string | null): boolean {
  const ex = doc.exercises.find(e => e.id === id);
  if (!ex || (key && !doc.days.some(d => d.key === key))) return false;
  if (key) ex.routine = key; else delete ex.routine;
  return true;
}

// ---------- 루틴 날 편집 ----------

/** 날을 맨 뒤에 추가하고 key를 돌려준다(d1, d2… 중 안 쓰는 것). 빈 이름이면 null. */
export function addDay(doc: Doc, name: string): string | null {
  const clean = name.trim();
  if (!clean) return null;
  const used = new Set(doc.days.map(d => d.key));
  let n = 1;
  while (used.has(`d${n}`)) n++;
  doc.days.push({ key: `d${n}`, name: clean });
  return `d${n}`;
}

/** 날 이름만 바꾼다(key는 그대로라 종목 지정과 기록이 따라온다). 빈 이름·없는 날은 false. */
export function renameDay(doc: Doc, key: string, name: string): boolean {
  const d = doc.days.find(x => x.key === key);
  const clean = name.trim();
  if (!d || !clean) return false;
  d.name = clean;
  return true;
}

/** 날을 한 칸 앞으로(dir -1) 또는 뒤로(dir 1). 끝이면 그대로. */
export function moveDay(doc: Doc, key: string, dir: -1 | 1): void {
  const i = doc.days.findIndex(d => d.key === key);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= doc.days.length) return;
  [doc.days[i], doc.days[j]] = [doc.days[j], doc.days[i]];
}

/** 날을 지운다. 그 날에 넣은 종목은 루틴에서 빠지고, 세션의 그날 표시도 지운다. 루틴이 비었던 종목 수를 돌려준다. */
export function removeDay(doc: Doc, key: string): number {
  const i = doc.days.findIndex(d => d.key === key);
  if (i < 0) return 0;
  doc.days.splice(i, 1);
  let n = 0;
  for (const e of doc.exercises) if (e.routine === key) { delete e.routine; n++; }
  for (const s of doc.sessions) if (s.day === key) delete s.day;
  if (doc.runDay === key) delete doc.runDay;
  return n;
}

/** 러닝이 대신하는 날을 정한다. null이면 러닝은 순서에 영향을 주지 않는다. 없는 날은 false. */
export function setRunDay(doc: Doc, key: string | null): boolean {
  if (key && !doc.days.some(d => d.key === key)) return false;
  if (key) doc.runDay = key; else delete doc.runDay;
  return true;
}

const runDayOf = (doc: Doc): string | null => (doc.runDay && doc.days.some(d => d.key === doc.runDay) ? doc.runDay : null);

// ---------- 루틴 순환·러닝 ----------

/** 순서상 다음 날. 없는 key면 첫 날. 날이 없으면 null. */
export function nextDay(doc: Doc, key: string): string | null {
  if (!doc.days.length) return null;
  const i = doc.days.findIndex(d => d.key === key);
  return doc.days[(i + 1) % doc.days.length].key;
}

/**
 * 그 세션이 어느 루틴 날이었나: 루틴 종목의 세트 수가 가장 많은 날(실제로 한 운동이 우선, 같으면 앞선 날).
 * 루틴 종목이 없으면 러닝한 날은 러닝 날, 그것도 아니면 적어 둔 day.
 */
export function sessionDay(doc: Doc, s: Session): string | null {
  const n = new Map<string, number>();
  for (const en of s.entries) {
    const k = doc.exercises.find(e => e.id === en.id)?.routine;
    if (k) n.set(k, (n.get(k) ?? 0) + en.sets.length);
  }
  let best: string | null = null;
  let bn = 0;
  for (const { key } of doc.days) { const v = n.get(key) ?? 0; if (v > bn) { best = key; bn = v; } }
  if (best) return best;
  const rd = runDayOf(doc);
  if (s.run && rd) return rd;
  return s.day && doc.days.some(d => d.key === s.day) ? s.day : null;
}

/**
 * 그 세션 다음에 올 날. 그날 채운 날(주된 날 + 러닝했으면 러닝 날)을 건너뛰고 순서상 다음.
 * 예: 가슴·등 → 하체 → 어깨·팔에서 러닝 + 가슴·등이면 하체도 채웠으니 다음은 어깨·팔.
 */
export function nextAfter(doc: Doc, s: Session): string | null {
  const main = sessionDay(doc, s);
  if (!main) return null;
  const covered = new Set([main]);
  const rd = runDayOf(doc);
  if (s.run && rd) covered.add(rd);
  let k = main;
  for (let i = 0; i < doc.days.length; i++) {
    k = nextDay(doc, k)!;
    if (!covered.has(k)) return k;
  }
  return nextDay(doc, main);
}

/** 오늘의 루틴 날. 오늘 이미 한 게 있으면 그 날, 아니면 마지막으로 한 루틴 날의 다음. 날이나 루틴에 넣은 종목이 없으면 null(기능 꺼짐). */
export function todayDay(doc: Doc, today: string): string | null {
  if (!doc.days.length || !doc.exercises.some(e => e.routine && !e.hidden)) return null;
  const cur = doc.sessions.find(s => s.date === today);
  const d0 = cur ? sessionDay(doc, cur) : null;
  if (d0) return d0;
  for (let i = doc.sessions.length - 1; i >= 0; i--) {
    const s = doc.sessions[i];
    if (s.date >= today) continue;
    const next = nextAfter(doc, s);
    if (next) return next;
  }
  return doc.days[0].key;
}

/** 그 날짜의 러닝 체크를 켜거나 끈다. 켤 때 세션이 없으면 만들고, day가 오면 그날의 루틴으로 적는다. 끌 때 세트가 없는 세션은 지운다. */
export function setRun(doc: Doc, date: string, on: boolean, time: string | null, day: string | null): void {
  if (on) {
    const s = sessionAt(doc, date, time);
    s.run = true;
    if (day) s.day = day;
    return;
  }
  const s = doc.sessions.find(x => x.date === date);
  if (!s) return;
  delete s.run;
  if (!s.entries.length) doc.sessions.splice(doc.sessions.indexOf(s), 1);
}

/** 표시 이름만 바꾼다. id는 기록 줄의 열쇠이므로 그대로 둔다. 빈 이름이면 false. */
export function renameExercise(doc: Doc, id: string, name: string): boolean {
  const ex = doc.exercises.find(e => e.id === id);
  const clean = name.trim();
  if (!ex || !clean) return false;
  ex.name = clean;
  return true;
}

// ---------- 텍스트 형식 ----------

const fmtKg = (x: number): string => String(round2(x));

/**
 * 전체 문서 → tlog.md 텍스트.
 *   %% tlog v4 <시각> %%
 *   %% ex <id> <이름> %%          (숨긴 종목은 ex 대신 hidden)
 *   YYYY-MM-DD session [HH:MM]
 *   YYYY-MM-DD <id> <kg>x<reps> ...
 */
export function toLogText(doc: Doc): string {
  const lines: string[] = [`%% ${FORMAT} ${doc.writtenAt} %%`];
  for (const d of doc.days) lines.push(`%% rday ${d.key} ${d.name} %%`);
  if (doc.runDay) lines.push(`%% runday ${doc.runDay} %%`);
  for (const e of doc.exercises) {
    lines.push(`%% ${e.hidden ? "hidden" : "ex"} ${e.id} ${e.name} %%`);
    if (e.step != null) lines.push(`%% step ${e.id} ${fmtKg(e.step)} %%`);
    if (e.routine) lines.push(`%% routine ${e.id} ${e.routine} %%`);
  }
  for (const s of doc.sessions) {
    lines.push(`${s.date} session${s.time ? " " + s.time : ""}`);
    if (s.day) lines.push(`%% day ${s.date} ${s.day} %%`);
    if (s.run) lines.push(`%% run ${s.date} %%`);
    for (const en of s.entries) {
      if (!en.sets.length) continue;
      lines.push(`${s.date} ${en.id} ${en.sets.map(x => `${fmtKg(x.kg)}x${x.reps}`).join(" ")}`);
    }
  }
  return lines.join("\n") + "\n";
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const SET_RE = /^(\d+(?:\.\d+)?)x(\d+)$/;
const ID_RE = /^[^\s%]+$/; // 공백과 %만 아니면 된다(한글 가능). "session"은 예약어.

/** tlog.md 텍스트 → 문서. v1~v3 파일도 읽는다(저장은 항상 v4). 어떤 오류든 줄 번호와 함께 ParseError를 던진다. */
export function parseLogText(text: string): Doc {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const lines = text.split("\n").map(l => l.replace(/\r$/, ""));
  const head = /^%% tlog v([1234]) (\S+) %%$/.exec((lines[0] ?? "").trim());
  if (!head) throw new ParseError(1, `첫 줄이 "%% ${FORMAT} <시각> %%" 형식이 아님`);
  const version = Number(head[1]);
  // 이름이 시작하는 토큰 위치. v1: ex id 템플릿 세트 lo hi inc start 이름 / v2: ex id 템플릿 세트 이름 / v3: ex id 템플릿 이름 / v4: ex id 이름
  const nameFrom = version === 1 ? 8 : version === 2 ? 4 : version === 3 ? 3 : 2;
  const legacy = version < 4; // 템플릿 토큰이 있던 형식
  const doc: Doc = { writtenAt: head[2], exercises: [], sessions: [], days: [] };
  const ids = new Set<string>();
  let cur: Session | null = null;
  const dayRefs: { ln: number; key: string }[] = []; // routine·day 줄이 가리키는 날 — 날 목록이 정해진 뒤 끝에서 확인

  for (let i = 1; i < lines.length; i++) {
    const ln = i + 1;
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith("%%")) {
      if (line.length < 4 || !line.endsWith("%%")) throw new ParseError(ln, "닫는 %% 가 없음");
      const body = line.slice(2, -2).trim();
      const kw = body.split(/\s+/)[0];
      if (!["ex", "hidden", "step", "routine", "day", "run", "rday", "runday"].includes(kw)) continue; // 그 밖의 주석은 무시
      const t = body.split(/\s+/);
      if (kw === "runday") { // %% runday key %% — 기록 앞
        if (cur) throw new ParseError(ln, "runday 줄은 기록보다 앞에 있어야 함");
        if (t.length !== 2) throw new ParseError(ln, "runday 줄 형식: runday key");
        dayRefs.push({ ln, key: t[1] });
        doc.runDay = t[1];
        continue;
      }
      if (kw === "rday") { // %% rday key 이름 %% — 기록 앞, 순서 = 순환 순서
        if (cur) throw new ParseError(ln, "rday 줄은 기록보다 앞에 있어야 함");
        if (t.length < 3 || !ID_RE.test(t[1])) throw new ParseError(ln, "rday 줄 형식: rday key 이름");
        if (doc.days.some(d => d.key === t[1])) throw new ParseError(ln, `루틴 날 key 중복: ${t[1]}`);
        doc.days.push({ key: t[1], name: t.slice(2).join(" ") });
        continue;
      }
      if (kw === "routine") { // %% routine id key %% — 그 종목 줄 뒤, 기록 앞
        if (cur) throw new ParseError(ln, "routine 줄은 기록보다 앞에 있어야 함");
        const ex = doc.exercises.find(e => e.id === t[1]);
        if (t.length !== 3 || !ex) throw new ParseError(ln, "routine 줄 형식: routine id 루틴 (그 종목 줄 뒤에)");
        dayRefs.push({ ln, key: t[2] });
        ex.routine = t[2];
        continue;
      }
      if (kw === "day" || kw === "run") { // %% day 날짜 key %% / %% run 날짜 %% — 그 날짜의 session 줄 뒤
        if (!cur || cur.date !== t[1]) throw new ParseError(ln, `${kw} 줄은 ${t[1]} session 줄 뒤에 있어야 함`);
        if (kw === "run") {
          if (t.length !== 2) throw new ParseError(ln, "run 줄 형식: run 날짜");
          cur.run = true;
        } else {
          if (t.length !== 3) throw new ParseError(ln, `day 줄 형식: day 날짜 루틴 (${t.slice(2).join(" ")})`);
          dayRefs.push({ ln, key: t[2] });
          cur.day = t[2];
        }
        continue;
      }
      if (kw === "step") { // %% step id kg %% — 그 종목 줄 뒤, 기록 앞
        if (cur) throw new ParseError(ln, "step 줄은 기록보다 앞에 있어야 함");
        const ex = doc.exercises.find(e => e.id === t[1]);
        if (t.length !== 3 || !ex) throw new ParseError(ln, "step 줄 형식: step id 무게칸 (그 종목 줄 뒤에)");
        const v = Number(t[2]);
        if (!Number.isFinite(v) || v <= 0) throw new ParseError(ln, `무게 칸이 양수가 아님: ${t[2]}`);
        ex.step = v;
        continue;
      }
      if (cur) throw new ParseError(ln, "ex 줄은 기록보다 앞에 있어야 함");
      if (t.length < nameFrom + 1) throw new ParseError(ln, legacy ? `v${version} ex 줄 형식이 아님` : "ex 줄 형식: ex id 이름");
      const id = t[1];
      if (!ID_RE.test(id) || id === "session") throw new ParseError(ln, `id에 공백·%를 쓸 수 없고 session은 예약어: ${id}`);
      if (ids.has(id)) throw new ParseError(ln, `종목 id 중복: ${id}`);
      const hidden = kw === "hidden" || (legacy && t[2] === "-");
      doc.exercises.push({ id, name: t.slice(nameFrom).join(" "), hidden });
      ids.add(id);
      continue;
    }

    const t = line.split(/\s+/);
    if (!DATE_RE.test(t[0])) throw new ParseError(ln, `날짜(YYYY-MM-DD)로 시작하지 않음: ${t[0]}`);
    if (t[1] === "session") {
      const rest = legacy ? t.slice(3) : t.slice(2); // 옛 형식은 템플릿 토큰을 건너뛴다
      if ((legacy && t.length < 3) || rest.length > 1) throw new ParseError(ln, "session 줄 형식: 날짜 session [HH:MM]");
      if (rest.length === 1 && !TIME_RE.test(rest[0])) throw new ParseError(ln, `시각 형식(HH:MM)이 아님: ${rest[0]}`);
      if (cur && t[0] <= cur.date) throw new ParseError(ln, `날짜가 중복되거나 역순: ${t[0]}`);
      cur = { date: t[0], time: rest.length === 1 ? rest[0] : null, entries: [] };
      doc.sessions.push(cur);
      continue;
    }
    if (!cur || cur.date !== t[0]) throw new ParseError(ln, `${t[0]} 블록에 session 줄이 없음`);
    const id = t[1] ?? "";
    if (!ids.has(id)) throw new ParseError(ln, `모르는 종목 id: ${id}`);
    if (cur.entries.some(e => e.id === id)) throw new ParseError(ln, `같은 날짜에 종목 중복: ${id}`);
    if (t.length < 3) throw new ParseError(ln, "세트가 없음");
    const sets = t.slice(2).map(tok => {
      const m = SET_RE.exec(tok);
      if (!m) throw new ParseError(ln, `세트 형식(무게x반복)이 아님: ${tok}`);
      return { kg: Number(m[1]), reps: Number(m[2]) };
    });
    cur.entries.push({ id, sets });
  }
  // 날 목록: rday 줄이 있으면 그대로. 없으면 0.6.0 key를 쓰는 파일은 그때 뜻대로, 아니면 기본 분할.
  if (!doc.days.length) {
    const legacy = dayRefs.length > 0 && dayRefs.every(r => LEGACY_DAYS.some(d => d.key === r.key));
    doc.days = (legacy ? LEGACY_DAYS : DEFAULT_DAYS).map(d => ({ ...d }));
    if (!doc.runDay) doc.runDay = legacy ? "legs" : DEFAULT_RUN_DAY; // 날 목록을 처음 정할 때만 기본 러닝 날도
  }
  for (const r of dayRefs) if (!doc.days.some(d => d.key === r.key)) throw new ParseError(r.ln, `모르는 루틴: ${r.key}`);
  return doc;
}

/** 기본 종목 6개, 세션 0개. */
export function defaultDoc(writtenAt: string = nowIso()): Doc {
  const ex = (id: string, name: string): Exercise => ({ id, name, hidden: false });
  return {
    writtenAt,
    exercises: [
      ex("squat", "스쿼트"),
      ex("bench", "벤치"),
      ex("row", "바벨로우"),
      ex("deadlift", "데드리프트"),
      ex("ohp", "오버헤드 프레스"),
      ex("pullup", "턱걸이"),
    ],
    sessions: [],
    days: DEFAULT_DAYS.map(d => ({ ...d })),
    runDay: DEFAULT_RUN_DAY,
  };
}
