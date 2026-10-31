// Encodes the clips e2e/capture.spec.ts recorded (test-results/capture/clips/<name>.webm + .json) into
// docs/media/<name>.mp4 (H.264, web-ready); the spec writes <name>.poster.png itself. Needs ffmpeg on PATH (FFMPEG overrides).
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../test-results/capture/clips/", import.meta.url));
const OUT = fileURLToPath(new URL("../docs/media/", import.meta.url));
const FFMPEG = process.env.FFMPEG ?? "ffmpeg";
const MAX_BYTES = 3 * 1024 * 1024;

const ff = (...args) => execFileSync(FFMPEG, ["-hide_banner", "-loglevel", "error", "-y", ...args], { stdio: "inherit" });

const names = readdirSync(SRC).filter((f) => f.endsWith(".webm")).map((f) => f.slice(0, -5));
if (!names.length) throw new Error(`no clips in ${SRC}: run the capture first`);
for (const name of names) {
  // the spec notes when the app was ready: cut the blank page load before it
  const { start } = JSON.parse(readFileSync(`${SRC}${name}.json`, "utf8"));
  const ss = (start + 0.3).toFixed(2);
  const mp4 = `${OUT}${name}.mp4`;
  // -map_metadata -1 + bitexact: no encoder/creation-time tags, so a re-encode of the same input is identical
  ff("-ss", ss, "-i", `${SRC}${name}.webm`, "-an", "-c:v", "libx264", "-preset", "slow", "-crf", "28", "-pix_fmt", "yuv420p",
    "-r", "25", "-movflags", "+faststart", "-map_metadata", "-1", "-fflags", "+bitexact", "-flags:v", "+bitexact", mp4);
  const size = statSync(mp4).size;
  console.log(`${name}.mp4 ${(size / 1024).toFixed(0)} KB`);
  if (size > MAX_BYTES) throw new Error(`${name}.mp4 is over 3 MB: shorten the clip or raise -crf`);
}
