// The timer cannot fire while this synchronous computation is running.
import { writeFileSync } from "node:fs";
process.once("message", ({ marker }: { marker: string }) => {
  writeFileSync(marker, String(process.pid));
  const until = performance.now() + 30_000;
  while (performance.now() < until) Math.sqrt(performance.now());
  process.send!({ result: "completed" });
  process.disconnect();
});
