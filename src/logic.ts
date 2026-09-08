// src/logic.ts — 순수 함수만. DOM·Obsidian API를 모른다. `node --test`로 검증한다.
// 이 파일은 Node의 타입 제거 실행 대상이므로 enum·namespace·생성자 매개변수 프로퍼티를 쓰지 않는다.
//
// 설계: 무게·횟수는 사용자가 정한다. 앱은 계산하지 않고, 날짜별 기록을 쌓아 추세(주간·월간 최고)와
// 사실만 알려 주는 힌트("60 kg로 3세션 연속")를 보여 준다.

export const FORMAT = "tlog v4";
export const LOG_PATH = "tlog.md";
export const GAP_DAYS = 14;     // 이 일수 이상 쉬었으면 알려 준다(정보)
export const SAME_STREAK = 3;   // 같은 최고 무게가 이만큼 이어지면 알려 준다(정보)

/** 종목. 템플릿(A/B) 구분은 없다 — 오늘 할 종목은 사용자가 그때그때 고른다. hidden이면 목록에서만 뺀다(기록은 유지). */
export type Exercise = { id: string; name: string; hidden: boolean };
export type SetRec = { kg: number; reps: number };
export type Entry = { id: string; sets: SetRec[] };
/** 하루 = 세션 하나. time은 첫 세트를 찍은 시각. */
export type Session = { date: string; time: string | null; entries: Entry[] };
export type Doc = { writtenAt: string; exercises: Exercise[]; sessions: Session[] };
export type HistItem = { date: string; sets: SetRec[] };
export type Period = { key: string; label: string; topKg: number; best: SetRec; sessions: number };

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

/** 요일 한 글자. */
export function weekday(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return "일월화수목금토"[new Date(y, m - 1, d).getDay()];
}

/** 9/8 처럼 짧게. */
export const fmtShort = (date: string): string => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

// ---------- 세트 요약 ----------

export const topKg = (sets: SetRec[]): number => (sets.length ? Math.max(...sets.map(s => s.kg)) : 0);

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

function summarize(hist: HistItem[], keyOf: (d: string) => string, labelOf: (d: string) => string, limit: number): Period[] {
  const out: Period[] = [];
  for (const h of hist) {
    const key = keyOf(h.date);
    let p = out.length && out[out.length - 1].key === key ? out[out.length - 1] : null;
    if (!p) {
      if (out.length >= limit) break;
      p = { key, label: labelOf(h.date), topKg: 0, best: { kg: 0, reps: 0 }, sessions: 0 };
      out.push(p);
    }
    p.sessions++;
    p.topKg = Math.max(p.topKg, topKg(h.sets));
    const b = bestSet(h.sets);
    if (b && (b.kg > p.best.kg || (b.kg === p.best.kg && b.reps > p.best.reps))) p.best = b;
  }
  return out;
}

/** 주간 최고(월~일), 최신 주부터 limit개. 기록이 있는 주만. */
export function weeklyTrend(hist: HistItem[], limit: number = 8): Period[] {
  return summarize(hist, weekStart, d => `${fmtShort(weekStart(d))}~${fmtShort(shiftDate(weekStart(d), 6))}`, limit);
}

/** 월간 최고, 최신 달부터 limit개. 기록이 있는 달만. */
export function monthlyTrend(hist: HistItem[], limit: number = 6): Period[] {
  return summarize(hist, monthKey, d => `${d.slice(0, 4)}년 ${Number(d.slice(5, 7))}월`, limit);
}

/**
 * 정보성 힌트. 숫자를 제안하지 않고 사실만 말한다.
 *  - 마지막 세션(어느 템플릿이든)이 GAP_DAYS 이상 전
 *  - 같은 최고 무게가 SAME_STREAK 세션 이상 이어짐
 *  - 직전 세션과 그 전 세션의 최고 무게가 다름(변화량)
 */
export function hints(hist: HistItem[], lastSessionDate: string | null, today: string): string[] {
  const out: string[] = [];
  if (lastSessionDate) {
    const n = daysBetween(lastSessionDate, today);
    if (n >= GAP_DAYS) out.push(`${n}일 만의 운동`);
  }
  if (hist.length) {
    const W = topKg(hist[0].sets);
    let n = 0;
    for (const h of hist) { if (topKg(h.sets) === W) n++; else break; }
    if (n >= SAME_STREAK) out.push(`${W} kg로 ${n}세션 연속 (${fmtShort(hist[n - 1].date)}부터)`);
    if (hist.length >= 2) {
      const P = topKg(hist[1].sets);
      if (P !== W) {
        const d = round2(W - P);
        out.push(`직전 ${W} kg, 그 전 ${P} kg (${d > 0 ? "+" : ""}${d} kg)`);
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
  for (const e of doc.exercises) lines.push(`%% ${e.hidden ? "hidden" : "ex"} ${e.id} ${e.name} %%`);
  for (const s of doc.sessions) {
    lines.push(`${s.date} session${s.time ? " " + s.time : ""}`);
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
  const doc: Doc = { writtenAt: head[2], exercises: [], sessions: [] };
  const ids = new Set<string>();
  let cur: Session | null = null;

  for (let i = 1; i < lines.length; i++) {
    const ln = i + 1;
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith("%%")) {
      if (line.length < 4 || !line.endsWith("%%")) throw new ParseError(ln, "닫는 %% 가 없음");
      const body = line.slice(2, -2).trim();
      const kw = body.split(/\s+/)[0];
      if (kw !== "ex" && kw !== "hidden") continue; // 그 밖의 주석은 무시
      const t = body.split(/\s+/);
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
  };
}
