// src/main.ts — 플러그인 진입점. 뷰 등록, 명령·리본, 시작 시 열기, 복귀 시 재동기화.
import { Notice, Plugin } from "obsidian";
import { TlogView, VIEW_TYPE } from "./view.ts";

/** Remotely Save의 동기화 명령 id. 후보이며 M2b에서 executeCommandById 반환값으로 검증한다. */
export const SYNC_COMMAND = "remotely-save:start-sync";
const OPEN_DELAY_MS = 2000; // 시작 시 동기화(1초)의 쓰기 창을 피한다

export default class TlogPlugin extends Plugin {
  lastWriteAt = 0; // 마지막 기록 시각(ms)
  lastSyncAt = 0;  // 마지막으로 동기화 명령을 부른 시각(ms)

  async onload(): Promise<void> {
    this.registerView(VIEW_TYPE, (leaf) => new TlogView(leaf, this));
    this.addRibbonIcon("dumbbell", "운동 일지 열기", () => void this.open());
    this.addCommand({ id: "open", name: "열기", callback: () => void this.open() });
    this.app.workspace.onLayoutReady(() => {
      window.setTimeout(() => void this.open(), OPEN_DELAY_MS);
    });
    // 미동기화 기록이 있으면 앱을 벗어날 때(다른 앱·PC로 넘어갈 때)와 다시 돌아올 때 한 번씩 올린다.
    // iOS는 앱을 서스펜드로 두므로 시작 시 동기화만으로는 늦다.
    this.registerDomEvent(document, "visibilitychange", () => {
      if (this.lastWriteAt > this.lastSyncAt) this.sync(true);
    });
  }

  /** 뷰가 있으면 앞으로, 없으면 만든다. 여러 번 불러도 리프는 하나. */
  async open(): Promise<void> {
    const ws = this.app.workspace;
    const leaves = ws.getLeavesOfType(VIEW_TYPE);
    if (leaves.length) {
      await ws.revealLeaf(leaves[0]);
      return;
    }
    const leaf = ws.getLeaf(false);
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    await ws.revealLeaf(leaf);
  }

  /** Remotely Save 동기화 실행. 명령이 없으면 안내만(quiet면 조용히). */
  sync(quiet: boolean = false): boolean {
    const commands = (this.app as unknown as { commands?: { executeCommandById?: (id: string) => boolean } }).commands;
    const ok = commands?.executeCommandById?.(SYNC_COMMAND) === true;
    if (ok) this.lastSyncAt = Date.now();
    else if (!quiet) new Notice("기록은 저장됐습니다. 동기화는 건너뜀 (이 볼트에 Remotely Save 없음)");
    return ok;
  }
}
