// src/view.ts — 뷰 하나에 홈(종목 목록)·기록 두 모드. 상태의 원본은 tlog.md이고 여기는 그리기와 탭 처리만.
// 홈은 종목 전체 목록이다(A/B 같은 구분 없음). 종목을 누르면 기록 화면: 무게 −/+, 횟수 −/+, 큰 "기록" 버튼.
// 지난번 값이 미리 채워져 있어 보통은 "기록"만 누른다. 가끔 쓰는 기능은 "더보기" 안에 둔다.
import { ItemView, Notice } from "obsidian";
import type { WorkspaceLeaf } from "obsidian";
import type TlogPlugin from "./main.ts";
import {
  LOG_PATH, GAP_DAYS, localDate, localTime, weekday, daysBetween, fmtShort, historyOf, hints, weeklyTrend, monthlyTrend,
  todayBlock, visibleExercises, lastEntryId, defaultDoc, newExercise, removeExercise, restoreExercise, ParseError,
} from "./logic.ts";
import type { Doc, Exercise, Session, SetRec, HistItem } from "./logic.ts";
import { readDoc, updateDoc, logFile } from "./store.ts";

export const VIEW_TYPE = "tlog-view";
const STEP_KG = 2.5;         // 무게 ± 단위
const REPEAT_DELAY = 300;    // 길게 누르기 시작(ms)
const REPEAT_EVERY = 200;    // 반복 간격(ms) = 초당 5회
const REPEAT_MAX = 40;       // 한 번 누름당 최대 반복
const RELOAD_DEBOUNCE = 150; // modify 이벤트 디바운스(ms)
const HISTORY_ROWS = 10;     // 기록 보기의 날짜별 줄 수
const DEFAULT_REPS = 8;      // 기록이 전혀 없을 때의 횟수 초기값

type Field = "kg" | "reps";

const round2 = (x: number): number => Math.round(x * 100) / 100;
const fmtWhen = (iso: string): string => (iso.length >= 16 ? `${fmtShort(iso)} ${iso.slice(11, 16)}` : iso);
const fmtSets = (sets: SetRec[]): string => sets.map(s => `${s.kg}×${s.reps}`).join("  ");
const fmtDay = (date: string): string => `${fmtShort(date)} (${weekday(date)})`;

/** 오늘 블록을 뺀 과거 기록. 힌트·"지난번"·미리 채움은 과거만 본다. */
function pastOf(doc: Doc, today: string) {
  const past = doc.sessions.filter(s => s.date !== today);
  const lastS: Session | null = past.length ? past[past.length - 1] : null;
  const histOf = (id: string): HistItem[] => historyOf(past, id);
  return { lastS, lastDate: lastS ? lastS.date : null, histOf };
}

export class TlogView extends ItemView {
  plugin: TlogPlugin;
  doc: Doc | null = null;        // null = 파일 없음
  error: string | null = null;   // 파싱 오류·덮어쓰기 감지 → 홈 + 잠금
  overwrite = false;             // error가 덮어쓰기 감지인지
  lastWrittenAt = "";            // 마지막으로 보거나 쓴 헤더 시각
  day = "";                      // 아래 상태가 유효한 날짜
  logMode = false;               // 기록 화면인가
  exId = "";                     // 기록 화면의 종목
  homeChosen = false;            // 오늘 "‹ 목록"을 눌렀으면 다시 열어도 홈에 머문다
  kg: number | null = null;
  reps: number | null = null;
  valFor = "";                   // kg·reps 값이 어느 종목 것인지
  editing: Field | null = null;  // 숫자를 눌러 직접 입력 중인 칸
  editSet: number | null = null; // 오늘 세트 중 수정 중인 것(인덱스)
  menuOpen = false;
  showHistory = false;
  adding = false;                // 홈: 새 종목 입력칸
  showHidden = false;            // 홈: 숨긴 종목 목록
  confirmDelete = false;
  busy = false;
  private valueEl: Partial<Record<Field, HTMLElement>> = {};
  private recEl: HTMLElement | null = null;
  private recLabel = "기록";
  private repeatTimer: number | null = null;
  private repeatInterval: number | null = null;
  private loadTimer: number | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: TlogPlugin) {
    super(leaf);
    this.plugin = plugin;
  }
  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return "운동 일지"; }
  getIcon(): string { return "dumbbell"; }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("tlog-view");
    this.contentEl.setText("불러오는 중…");
    // tlog.md 자체와 "tlog (충돌하는 사본).md" 같은 사본 생성·삭제에 반응한다.
    const onFile = (path: string) => { if (path === LOG_PATH || path.startsWith("tlog")) this.scheduleLoad(); };
    this.registerEvent(this.app.vault.on("modify", f => onFile(f.path)));
    this.registerEvent(this.app.vault.on("create", f => onFile(f.path)));
    this.registerEvent(this.app.vault.on("delete", f => onFile(f.path)));
    this.registerEvent(this.app.workspace.on("active-leaf-change", leaf => { if (leaf === this.leaf) this.scheduleLoad(); }));
    this.registerDomEvent(document, "visibilitychange", () => { if (document.visibilityState === "hidden") this.stopRepeat(); });
    // 복원된 리프의 onOpen은 볼트 인덱스보다 먼저 불릴 수 있으므로 파일 접근은 여기서만.
    this.app.workspace.onLayoutReady(() => void this.load());
  }

  async onClose(): Promise<void> {
    this.stopRepeat();
    if (this.loadTimer) window.clearTimeout(this.loadTimer);
  }

  // ---------- 읽기 ----------

  scheduleLoad(): void {
    if (this.loadTimer) window.clearTimeout(this.loadTimer);
    this.loadTimer = window.setTimeout(() => void this.load(), RELOAD_DEBOUNCE);
  }

  async load(): Promise<void> {
    try {
      const doc = await readDoc(this.app);
      if (doc && this.lastWrittenAt && doc.writtenAt < this.lastWrittenAt) {
        this.error = `동기화가 폰 기록을 덮어씀 (${fmtWhen(this.lastWrittenAt)} → ${fmtWhen(doc.writtenAt)}). 설정 → 파일 복구에서 되돌리기`;
        this.overwrite = true;
      } else {
        this.error = null;
        this.overwrite = false;
        if (doc) this.lastWrittenAt = doc.writtenAt;
      }
      this.doc = doc;
    } catch (e) {
      this.overwrite = false;
      this.error = e instanceof ParseError ? `${LOG_PATH} ${e.message}` : `읽기 실패: ${String(e)}`;
    }
    this.render();
  }

  // ---------- 그리기 ----------

  render(): void {
    this.stopRepeat();
    const el = this.contentEl;
    el.empty();
    this.valueEl = {};
    this.recEl = null;
    const doc = this.doc ?? defaultDoc("");
    const today = localDate();
    if (this.day !== today) { this.day = today; this.logMode = false; this.homeChosen = false; this.resetPanels(); }
    const block = todayBlock(doc, today);
    // 0탭 복구: 오늘 기록이 있고 아직 홈을 고르지 않았으면 마지막으로 찍던 종목의 기록 화면으로.
    if (!this.error && !this.logMode && !this.homeChosen) {
      const id = lastEntryId(block);
      if (id && doc.exercises.some(e => e.id === id && !e.hidden)) { this.logMode = true; this.exId = id; }
    }
    const ex = doc.exercises.find(e => e.id === this.exId && !e.hidden) ?? null;
    if (this.logMode && !this.error && ex) this.renderLog(el, doc, today, ex, block);
    else { this.logMode = false; this.renderHome(el, doc, today, block); }
  }

  private renderBanners(el: HTMLElement): void {
    if (this.error) {
      const b = el.createDiv({ cls: "tlog-banner is-error" });
      b.createSpan({ text: this.error });
      const file = logFile(this.app);
      if (file && !this.overwrite) {
        const open = b.createEl("button", { text: "파일 열기" });
        open.onclick = () => void this.app.workspace.getLeaf(true).openFile(file);
      }
      if (this.overwrite) {
        const ok = b.createEl("button", { text: "확인(현재 파일 유지)" });
        ok.onclick = () => { this.error = null; this.overwrite = false; this.lastWrittenAt = this.doc?.writtenAt ?? ""; this.render(); };
      }
    }
    const copies = this.app.vault.getFiles().filter(f => f.path !== LOG_PATH && f.extension === "md" && f.basename.startsWith("tlog"));
    if (copies.length) el.createDiv({ cls: "tlog-banner is-warn", text: `충돌 사본 발견 (${copies[0].name}): PC에서 병합 후 삭제` });
    if (!this.doc && !this.error) el.createDiv({ cls: "tlog-note", text: "첫 기록을 하면 tlog.md 파일이 생깁니다" });
  }

  private renderHome(el: HTMLElement, doc: Doc, today: string, block: Session | null): void {
    this.renderBanners(el);
    const { lastS, histOf } = pastOf(doc, today);
    const list = visibleExercises(doc);
    const hidden = doc.exercises.filter(e => e.hidden);
    const sets = block ? block.entries.reduce((n, e) => n + e.sets.length, 0) : 0;

    el.createDiv({ cls: "tlog-date", text: `오늘 ${fmtDay(today)}` });
    if (block) el.createDiv({ cls: "tlog-title", text: `오늘 ${sets}세트 저장됨${block.time ? ` · ${block.time} 시작` : ""}` });
    else if (lastS) el.createDiv({ cls: "tlog-title", text: `지난 운동 ${fmtShort(lastS.date)}${lastS.time ? " " + lastS.time : ""} · ${daysBetween(lastS.date, today)}일 전` });
    else el.createDiv({ cls: "tlog-title", text: "첫 운동" });
    if (lastS && daysBetween(lastS.date, today) >= GAP_DAYS) el.createDiv({ cls: "tlog-hint", text: `${daysBetween(lastS.date, today)}일 만의 운동` });
    el.createDiv({ cls: "tlog-note", text: list.length ? "종목을 누르면 기록 화면이 열립니다" : "종목이 없습니다. 아래에서 추가하세요." });

    // 종목 목록: 파일 순서. 오늘 세트가 있으면 "오늘:", 없으면 지난번 기록.
    const listEl = el.createDiv({ cls: "tlog-list" });
    for (const ex of list) {
      const todaySets = block?.entries.find(e => e.id === ex.id)?.sets ?? [];
      const last = histOf(ex.id)[0];
      const row = listEl.createDiv({ cls: this.error ? "tlog-item" : "tlog-item is-link" });
      row.createDiv({ cls: "tlog-item-main", text: `${ex.name} ›` });
      row.createDiv({ cls: "tlog-sub", text: todaySets.length ? `오늘: ${fmtSets(todaySets)}` : last ? `지난번 ${fmtShort(last.date)}: ${fmtSets(last.sets)}` : "기록 없음" });
      if (!this.error) row.onclick = () => this.enterLog(ex.id);
    }

    // 종목 추가 · 숨긴 종목 · 동기화
    const links = el.createDiv({ cls: "tlog-links" });
    const addLink = links.createEl("button", { cls: "tlog-link", text: this.adding ? "추가 취소" : "+ 종목 추가" });
    addLink.disabled = !!this.error;
    addLink.onclick = () => { this.adding = !this.adding; this.showHidden = false; this.render(); };
    if (hidden.length) {
      const hl = links.createEl("button", { cls: "tlog-link", text: this.showHidden ? "숨긴 종목 닫기" : `숨긴 종목 ${hidden.length}개` });
      hl.onclick = () => { this.showHidden = !this.showHidden; this.adding = false; this.render(); };
    }
    const sync = links.createEl("button", { cls: "tlog-link", text: "동기화" });
    sync.disabled = !!this.error;
    sync.onclick = () => { this.plugin.sync(); };
    if (this.adding) {
      const form = el.createDiv({ cls: "tlog-newex" });
      const nameIn = form.createEl("input", { cls: "tlog-nameinput", type: "text", placeholder: "종목 이름 (예: 레그프레스)" });
      const addBtn = form.createEl("button", { text: "추가" });
      addBtn.disabled = this.busy;
      addBtn.onclick = () => void this.addExercise(nameIn.value);
      nameIn.onkeydown = (e: KeyboardEvent) => { if (e.key === "Enter") void this.addExercise(nameIn.value); };
      window.setTimeout(() => nameIn.focus(), 0);
    }
    if (this.showHidden) {
      const box = el.createDiv({ cls: "tlog-add" });
      box.createDiv({ cls: "tlog-note", text: "숨긴 종목 (누르면 목록에 복원)" });
      for (const hx of hidden) {
        const b = box.createEl("button", { cls: "tlog-pick", text: hx.name });
        b.disabled = this.busy;
        b.onclick = () => void this.restoreHidden(hx.id);
      }
    }

    el.createDiv({ cls: "tlog-footer", text: `tlog ${this.plugin.manifest.version} · 마지막 기록 ${doc.writtenAt ? fmtWhen(doc.writtenAt) : "없음"}` });
  }

  private enterLog(id: string): void {
    this.logMode = true;
    this.exId = id;
    this.homeChosen = false;
    this.valFor = "";
    this.resetPanels();
    this.render();
  }

  private goHome(): void {
    this.logMode = false;
    this.homeChosen = true;
    this.resetPanels();
    this.render();
  }

  private resetPanels(): void {
    this.editing = null;
    this.editSet = null;
    this.menuOpen = false;
    this.showHistory = false;
    this.adding = false;
    this.showHidden = false;
    this.confirmDelete = false;
  }

  private renderLog(el: HTMLElement, doc: Doc, today: string, ex: Exercise, block: Session | null): void {
    const { lastDate, histOf } = pastOf(doc, today);
    const list = visibleExercises(doc);
    const idx = list.findIndex(e => e.id === ex.id);
    const nextEx: Exercise | null = idx >= 0 && idx + 1 < list.length ? list[idx + 1] : null;
    const sets = block?.entries.find(e => e.id === ex.id)?.sets ?? [];
    const hist = histOf(ex.id);                       // 과거만: 힌트·지난번·미리 채움용
    const allHist = historyOf(doc.sessions, ex.id);    // 오늘 포함: 기록 보기용
    const last = hist[0] ?? null;
    if (this.editSet != null && this.editSet >= sets.length) this.editSet = null; // 수정 중이던 세트가 사라짐
    if (this.editSet == null && (this.valFor !== ex.id || this.kg == null || this.reps == null)) {
      const src = sets.length ? sets[sets.length - 1] : last ? last.sets[last.sets.length - 1] : null;
      this.kg = src ? src.kg : 0;
      this.reps = src ? src.reps : DEFAULT_REPS;
      this.valFor = ex.id;
    }

    el.createDiv({ cls: "tlog-date", text: `${fmtDay(today)} · ${block?.time ? `${block.time} 시작` : "오늘 첫 기록 전"}` });
    const head = el.createDiv({ cls: "tlog-head" });
    head.createDiv({ cls: "tlog-exname", text: ex.name });
    head.createDiv({ cls: "tlog-sub", text: idx >= 0 ? `${idx + 1}/${list.length}` : "" });
    el.createDiv({ cls: "tlog-last", text: last ? `지난번 ${fmtShort(last.date)}: ${fmtSets(last.sets)}` : "첫 기록" });
    for (const h of hints(hist, lastDate, today)) el.createDiv({ cls: "tlog-hint", text: h });

    // 무게·횟수 −/+ (숫자를 누르면 직접 입력), 그리고 기록 버튼. 세트를 수정 중이면 "n세트 수정"이 된다.
    this.renderStepper(el, "무게", "kg");
    this.renderStepper(el, "횟수", "reps");
    const editIdx = this.editSet;
    this.recLabel = editIdx != null ? `${editIdx + 1}세트 수정` : "기록";
    const rec = el.createEl("button", { cls: "tlog-main", text: `${this.recLabel}   ${this.kg} kg × ${this.reps}회` });
    rec.disabled = this.busy || this.editing !== null;
    rec.onclick = () => void (editIdx != null ? this.updateSet(editIdx) : this.logSet());
    this.recEl = rec;
    if (editIdx != null) {
      const links = el.createDiv({ cls: "tlog-links" });
      const del = links.createEl("button", { cls: "tlog-link", text: `${editIdx + 1}세트 삭제` });
      del.disabled = this.busy;
      del.onclick = () => void this.deleteSet(editIdx);
      const cancel = links.createEl("button", { cls: "tlog-link", text: "취소" });
      cancel.onclick = () => { this.editSet = null; this.valFor = ""; this.render(); };
    }

    // 오늘 찍은 세트. 세트를 누르면 값이 위로 올라오고 수정·삭제할 수 있다.
    const todayRow = el.createDiv({ cls: "tlog-today" });
    todayRow.createSpan({ cls: "tlog-today-label", text: sets.length ? `오늘 ${sets.length}세트:` : "오늘 아직 없음" });
    sets.forEach((s, i) => {
      const b = todayRow.createEl("button", { cls: "tlog-setbtn", text: `${s.kg}×${s.reps}` });
      if (i === editIdx) b.addClass("is-selected");
      b.disabled = this.busy;
      b.onclick = () => {
        if (this.editSet === i) { this.editSet = null; this.valFor = ""; }
        else { this.editSet = i; this.kg = s.kg; this.reps = s.reps; this.valFor = ex.id; this.editing = null; }
        this.render();
      };
    });
    if (sets.length && editIdx == null) el.createDiv({ cls: "tlog-note", text: "세트를 누르면 고치거나 지울 수 있습니다" });

    // 이동: 목록으로, 또는 목록 순서상 다음 종목으로
    const nav = el.createDiv({ cls: "tlog-row" });
    const home = nav.createEl("button", { text: "‹ 목록" });
    home.onclick = () => this.goHome();
    const next = nav.createEl("button", { cls: "tlog-next", text: nextEx ? `다음: ${nextEx.name} ›` : "다음 ›" });
    next.disabled = !nextEx;
    next.onclick = () => { if (nextEx) this.enterLog(nextEx.id); };

    // 더보기
    const more = el.createEl("button", { cls: "tlog-link", text: this.menuOpen ? "닫기" : "더보기 ⋯" });
    more.onclick = () => { this.menuOpen = !this.menuOpen; this.showHistory = false; this.confirmDelete = false; this.render(); };
    if (this.menuOpen) {
      const menu = el.createDiv({ cls: "tlog-menu" });
      const hb = menu.createEl("button", { text: this.showHistory ? "기록 닫기" : `기록 보기 (${allHist.length}회)` });
      hb.onclick = () => { this.showHistory = !this.showHistory; this.render(); };
      if (this.showHistory) this.renderHistory(menu, allHist);
      const syncBtn = menu.createEl("button", { text: "동기화" });
      syncBtn.onclick = () => { this.plugin.sync(); };
      const delBtn = menu.createEl("button", { cls: "tlog-danger", text: this.confirmDelete ? "정말 삭제? (다시 누르면 삭제)" : `"${ex.name}" 삭제` });
      delBtn.disabled = this.busy;
      delBtn.onclick = () => {
        if (sets.length) { new Notice("오늘 기록이 있는 종목은 세트를 먼저 지우세요"); return; }
        if (!this.confirmDelete) {
          this.confirmDelete = true;
          this.render();
          window.setTimeout(() => { if (this.confirmDelete) { this.confirmDelete = false; this.render(); } }, 4000);
          return;
        }
        this.confirmDelete = false;
        void this.removeExercise(ex.id);
      };
    }
  }

  /** 한 줄: 라벨 [−] 값 [+]. 값을 누르면 입력칸으로 바뀐다. */
  private renderStepper(el: HTMLElement, label: string, field: Field): void {
    const row = el.createDiv({ cls: "tlog-stepper" });
    row.createSpan({ cls: "tlog-stepper-label", text: label });
    const minus = row.createEl("button", { cls: "tlog-step", text: "−" });
    const unit = field === "kg" ? " kg" : "회";
    if (this.editing === field) {
      const inp = row.createEl("input", { cls: "tlog-valinput", type: "text" });
      inp.inputMode = field === "kg" ? "decimal" : "numeric";
      inp.value = String(this[field]);
      let done = false;
      const apply = () => {
        if (done) return;
        done = true;
        const raw = inp.value.trim().replace(",", ".");
        const v = Number(raw);
        if (raw !== "" && Number.isFinite(v) && v >= 0) {
          if (field === "kg") this.kg = round2(v);
          else this.reps = Math.max(1, Math.round(v));
        }
        this.editing = null;
        this.render();
      };
      inp.onkeydown = (e: KeyboardEvent) => {
        if (e.key === "Enter") apply();
        if (e.key === "Escape") { done = true; this.editing = null; this.render(); }
      };
      inp.onblur = apply;
      window.setTimeout(() => inp.focus(), 0);
    } else {
      const valBtn = row.createEl("button", { cls: "tlog-value", text: `${this[field]}${unit}` });
      valBtn.onclick = () => { this.editing = field; this.render(); };
      this.valueEl[field] = valBtn;
    }
    const plus = row.createEl("button", { cls: "tlog-step", text: "+" });
    this.bindRepeat(minus, field, -1);
    this.bindRepeat(plus, field, 1);
  }

  private renderHistory(el: HTMLElement, hist: HistItem[]): void {
    const box = el.createDiv({ cls: "tlog-hist" });
    if (!hist.length) { box.createDiv({ cls: "tlog-note", text: "아직 기록이 없습니다" }); return; }
    box.createDiv({ cls: "tlog-hist-title", text: "날짜별" });
    for (const h of hist.slice(0, HISTORY_ROWS)) box.createDiv({ cls: "tlog-hist-row", text: `${h.date}  ${fmtSets(h.sets)}` });
    if (hist.length > HISTORY_ROWS) box.createDiv({ cls: "tlog-note", text: `… 이전 ${hist.length - HISTORY_ROWS}회는 tlog.md에` });
    box.createDiv({ cls: "tlog-hist-title", text: "주간 최고" });
    for (const p of weeklyTrend(hist)) box.createDiv({ cls: "tlog-hist-row", text: `${p.label}  ${p.topKg} kg  (${p.best.kg}×${p.best.reps}, ${p.sessions}회)` });
    box.createDiv({ cls: "tlog-hist-title", text: "월간 최고" });
    for (const p of monthlyTrend(hist)) box.createDiv({ cls: "tlog-hist-row", text: `${p.label}  ${p.topKg} kg  (${p.best.kg}×${p.best.reps}, ${p.sessions}회)` });
  }

  // ---------- 쓰기 ----------

  private async logSet(): Promise<void> {
    if (this.busy) return;
    const exId = this.exId;
    const kg = this.kg ?? 0;
    const reps = this.reps ?? DEFAULT_REPS;
    const today = localDate();
    this.busy = true;
    this.render();
    try {
      await updateDoc(this.app, (doc) => {
        let s: Session | undefined = doc.sessions.find(x => x.date === today);
        if (!s) {
          const last = doc.sessions.length ? doc.sessions[doc.sessions.length - 1] : null;
          if (last && last.date > today) throw new Error(`파일의 마지막 날짜(${last.date})가 오늘보다 뒤입니다`);
          s = { date: today, time: localTime(), entries: [] };
          doc.sessions.push(s);
        }
        let e = s.entries.find(x => x.id === exId);
        if (!e) { e = { id: exId, sets: [] }; s.entries.push(e); }
        e.sets.push({ kg, reps });
      });
      this.plugin.lastWriteAt = Date.now();
    } catch (e) {
      new Notice(e instanceof ParseError ? `${LOG_PATH} ${e.message}` : `기록 실패: ${String(e)}`);
    }
    this.busy = false;
    await this.load();
  }

  /** 오늘의 i번째 세트를 현재 무게·횟수로 바꾼다. */
  private async updateSet(i: number): Promise<void> {
    if (this.busy) return;
    const exId = this.exId;
    const kg = this.kg ?? 0;
    const reps = this.reps ?? DEFAULT_REPS;
    const today = localDate();
    this.busy = true;
    this.render();
    try {
      await updateDoc(this.app, (doc) => {
        const e = doc.sessions.find(x => x.date === today)?.entries.find(x => x.id === exId);
        if (!e || i >= e.sets.length) throw new Error("그 세트가 이미 없습니다");
        e.sets[i] = { kg, reps };
      });
      this.plugin.lastWriteAt = Date.now();
      this.editSet = null;
      this.valFor = "";
    } catch (e) {
      new Notice(e instanceof ParseError ? `${LOG_PATH} ${e.message}` : `수정 실패: ${String(e)}`);
    }
    this.busy = false;
    await this.load();
  }

  /** 오늘의 i번째 세트를 지운다. 종목·블록이 비면 그 줄도 지운다. */
  private async deleteSet(i: number): Promise<void> {
    if (this.busy) return;
    const exId = this.exId;
    const today = localDate();
    this.busy = true;
    this.render();
    try {
      await updateDoc(this.app, (doc) => {
        const s = doc.sessions.find(x => x.date === today);
        const e = s?.entries.find(x => x.id === exId);
        if (!s || !e || i >= e.sets.length) return;
        e.sets.splice(i, 1);
        if (!e.sets.length) s.entries.splice(s.entries.indexOf(e), 1);
        if (!s.entries.length) doc.sessions.splice(doc.sessions.indexOf(s), 1);
      });
      this.plugin.lastWriteAt = Date.now();
      this.editSet = null;
      this.valFor = "";
    } catch (e) {
      new Notice(e instanceof ParseError ? `${LOG_PATH} ${e.message}` : `지우기 실패: ${String(e)}`);
    }
    this.busy = false;
    await this.load();
  }

  /** 새 종목을 파일에 저장하고 그 종목의 기록 화면으로 간다. */
  private async addExercise(name: string): Promise<void> {
    if (this.busy) return;
    if (!name.trim()) { new Notice("종목 이름을 입력하세요"); return; }
    let newId = "";
    this.busy = true;
    this.render();
    try {
      await updateDoc(this.app, (doc) => {
        const ex = newExercise(doc, name);
        doc.exercises.push(ex);
        newId = ex.id;
      });
      this.plugin.lastWriteAt = Date.now();
      // 파일을 다시 읽은 뒤 그려야 새 종목이 보이므로 상태만 바꾸고 load()에 맡긴다.
      this.logMode = true;
      this.exId = newId;
      this.homeChosen = false;
      this.valFor = "";
      this.resetPanels();
    } catch (e) {
      new Notice(e instanceof ParseError ? `${LOG_PATH} ${e.message}` : `종목 추가 실패: ${String(e)}`);
    }
    this.busy = false;
    await this.load();
  }

  /** 종목을 파일에서 삭제(기록 없음) 또는 숨김(기록 있음)하고 목록으로 간다. */
  private async removeExercise(id: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.render();
    const out = { result: "missing" as "deleted" | "hidden" | "missing" };
    try {
      await updateDoc(this.app, (doc) => { out.result = removeExercise(doc, id); });
      this.plugin.lastWriteAt = Date.now();
      new Notice(out.result === "hidden" ? "지난 기록이 있어 목록에서만 숨겼습니다 (홈의 \"숨긴 종목\"에서 복원)" : "종목을 삭제했습니다");
    } catch (e) {
      new Notice(e instanceof ParseError ? `${LOG_PATH} ${e.message}` : `삭제 실패: ${String(e)}`);
    }
    this.busy = false;
    this.goHome();
    await this.load();
  }

  /** 숨긴 종목을 목록에 되돌린다. */
  private async restoreHidden(id: string): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.render();
    try {
      await updateDoc(this.app, (doc) => { restoreExercise(doc, id); });
      this.plugin.lastWriteAt = Date.now();
    } catch (e) {
      new Notice(e instanceof ParseError ? `${LOG_PATH} ${e.message}` : `복원 실패: ${String(e)}`);
    }
    this.busy = false;
    this.showHidden = false;
    this.homeChosen = true; // 홈에서 관리 중이므로 오늘 기록 화면으로 튀지 않게
    await this.load();
  }

  // ---------- −/+ 길게 누르기 ----------

  private bindRepeat(btn: HTMLElement, field: Field, dir: 1 | -1): void {
    const step = () => {
      if (field === "kg") this.kg = Math.max(0, round2((this.kg ?? 0) + dir * STEP_KG));
      else this.reps = Math.max(1, (this.reps ?? DEFAULT_REPS) + dir);
      const v = this.valueEl[field];
      if (v) v.setText(field === "kg" ? `${this.kg} kg` : `${this.reps}회`);
      if (this.recEl) this.recEl.setText(`${this.recLabel}   ${this.kg} kg × ${this.reps}회`);
    };
    this.registerDomEvent(btn, "pointerdown", (e: PointerEvent) => {
      e.preventDefault();
      this.stopRepeat();
      try { btn.setPointerCapture(e.pointerId); } catch { /* 무시 */ }
      step();
      let count = 0;
      this.repeatTimer = window.setTimeout(() => {
        this.repeatInterval = window.setInterval(() => {
          if (++count > REPEAT_MAX) { this.stopRepeat(); return; }
          step();
        }, REPEAT_EVERY);
      }, REPEAT_DELAY);
    });
    for (const ev of ["pointerup", "pointercancel", "pointerleave", "lostpointercapture"] as const) {
      this.registerDomEvent(btn, ev, () => this.stopRepeat());
    }
  }

  private stopRepeat(): void {
    if (this.repeatTimer) { window.clearTimeout(this.repeatTimer); this.repeatTimer = null; }
    if (this.repeatInterval) { window.clearInterval(this.repeatInterval); this.repeatInterval = null; }
  }
}
