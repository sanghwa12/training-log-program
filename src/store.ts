// src/store.ts — 볼트 I/O. tlog.md를 읽고 쓰는 유일한 곳.
import type { App, TFile } from "obsidian";
import { LOG_PATH, parseLogText, toLogText, nowIso, defaultDoc } from "./logic.ts";
import type { Doc } from "./logic.ts";

export function logFile(app: App): TFile | null {
  return app.vault.getFileByPath(LOG_PATH);
}

/** 파일이 없으면 null. 파싱 실패는 ParseError를 그대로 던진다. */
export async function readDoc(app: App): Promise<Doc | null> {
  const file = logFile(app);
  if (!file) return null;
  return parseLogText(await app.vault.read(file));
}

let queue: Promise<void> = Promise.resolve();

/**
 * 직렬화된 읽기-변경-쓰기. 플러그인 쓰기끼리는 절대 겹치지 않는다.
 * 파일이 없으면 여기서만(첫 세트) 만든다 — 시작 시 동기화보다 먼저 기본 파일을 만들면 원격을 덮어쓸 수 있으므로.
 * 파싱이 실패하면 아무것도 쓰지 않고 ParseError를 던진다.
 */
export function updateDoc(app: App, mutate: (doc: Doc) => void): Promise<void> {
  const run = async (): Promise<void> => {
    const file = logFile(app);
    if (!file) {
      const doc = defaultDoc(nowIso());
      mutate(doc);
      await app.vault.create(LOG_PATH, toLogText(doc));
      return;
    }
    await app.vault.process(file, (text) => {
      const doc = parseLogText(text);
      mutate(doc);
      doc.writtenAt = nowIso();
      return toLogText(doc);
    });
  };
  const next = queue.then(run, run);
  queue = next.catch(() => undefined);
  return next;
}
