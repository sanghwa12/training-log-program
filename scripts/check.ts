// npm run check [경로] — PC 사본(기본: Dropbox의 training/tlog.md)을 파서로 검사한다.
// 정상이면 요약을, 오류면 줄 번호를 출력하고 종료 코드 1.
import { existsSync, readFileSync } from "node:fs";
import { parseLogText, ParseError } from "../src/logic.ts";

const path = process.argv[2] ?? "C:\\Users\\USER\\Dropbox\\앱\\remotely-save\\training\\tlog.md";
if (!existsSync(path)) {
  console.error(`파일 없음: ${path}`);
  process.exit(1);
}
try {
  const doc = parseLogText(readFileSync(path, "utf8"));
  const sets = doc.sessions.reduce((n, s) => n + s.entries.reduce((m, e) => m + e.sets.length, 0), 0);
  console.log(`OK: ${path}\n  종목 ${doc.exercises.length}, 세션 ${doc.sessions.length}, 세트 ${sets}, 마지막 기록 ${doc.writtenAt}`);
} catch (e) {
  if (e instanceof ParseError) {
    console.error(`오류: ${path} ${e.message}`);
    process.exit(1);
  }
  throw e;
}
