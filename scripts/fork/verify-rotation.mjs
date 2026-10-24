// Synthetic HDR quadrants: orientation is checked without personal media or a database.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ffmpeg = process.env.FFMPEG_PATH || "ffmpeg";
const ffprobe = process.env.FFPROBE_PATH || "ffprobe";
const cuda = process.argv.includes("--cuda");
const run = (binary, args) => {
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  assert.equal(
    result.status,
    0,
    `${binary} ${args.join(" ")}\n${result.stderr}`,
  );
  return result.stdout;
};
const width = 384;
const height = 256;
const pixels = width * height;
const raw = Buffer.alloc(pixels * 3);
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const quadrant = (y >= height / 2 ? 2 : 0) + (x >= width / 2 ? 1 : 0);
    raw.writeUInt16LE([256, 384, 512, 640][quadrant], (y * width + x) * 2);
  }
}
for (let i = pixels; i < pixels * 1.5; i++) raw.writeUInt16LE(512, i * 2);
const dir = mkdtempSync(join(tmpdir(), "immich-rotation-"));
const probe = (path) =>
  JSON.parse(
    run(ffprobe, [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height:stream_side_data=rotation",
      "-of",
      "json",
      path,
    ]),
  ).streams[0];
const colors = [
  "-color_primaries",
  "bt709",
  "-color_trc",
  "bt709",
  "-colorspace",
  "bt709",
  "-color_range",
  "pc",
];
const cpuFilter =
  "tonemapx=tonemap=hable:desat=0:p=bt709:t=bt709:m=bt709:r=pc:peak=100:format=yuv420p";
const gpuFilter =
  "tonemap_cuda=desat=0:matrix=bt709:primaries=bt709:range=pc:tonemap=hable:tonemap_mode=lum:transfer=bt709:peak=100:format=nv12";
const cases = [
  { rotation: -90, direction: "clock", order: [2, 0, 3, 1] },
  { rotation: 90, direction: "cclock", order: [1, 3, 0, 2] },
  { rotation: 180, direction: "reversal", order: [3, 2, 1, 0] },
];
const check = (path, test) => {
  const stream = probe(path);
  const sideways = Math.abs(test.rotation) === 90;
  assert.equal(
    stream.width,
    sideways ? height : width,
    `${path}: wrong output width`,
  );
  assert.equal(
    stream.height,
    sideways ? width : height,
    `${path}: wrong output height`,
  );
  for (const data of stream.side_data_list || []) {
    if (data.rotation !== undefined)
      assert.equal(data.rotation % 360, 0, "Output must not rotate twice");
  }
  const plane = `${path}.gray`;
  run(ffmpeg, [
    "-v",
    "error",
    "-noautorotate",
    "-i",
    path,
    "-frames:v",
    "1",
    "-pix_fmt",
    "gray",
    "-f",
    "rawvideo",
    plane,
  ]);
  const bytes = readFileSync(plane);
  const values = [];
  for (const [cx, cy] of [
    [1, 1],
    [3, 1],
    [1, 3],
    [3, 3],
  ]) {
    let total = 0;
    for (
      let y = (stream.height * cy) / 4 - 8;
      y < (stream.height * cy) / 4 + 8;
      y++
    ) {
      for (
        let x = (stream.width * cx) / 4 - 8;
        x < (stream.width * cx) / 4 + 8;
        x++
      )
        total += bytes[y * stream.width + x];
    }
    values.push(total / 256);
  }
  const sorted = [...values].sort((a, b) => a - b);
  for (let i = 1; i < sorted.length; i++)
    assert.ok(sorted[i] - sorted[i - 1] > 5, `Quadrants collapsed: ${values}`);
  assert.deepEqual(
    values.map((v) => sorted.indexOf(v)),
    test.order,
    `Wrong rotation direction: ${values}`,
  );
  return `${stream.width}x${stream.height}, quadrant order ${test.order.join(",")}`;
};
try {
  writeFileSync(join(dir, "quadrants.yuv"), Buffer.concat([raw, raw, raw]));
  for (const transfer of ["arib-std-b67", "smpte2084"]) {
    const source = join(dir, `${transfer}.mp4`);
    run(ffmpeg, [
      "-v",
      "error",
      "-f",
      "rawvideo",
      "-pixel_format",
      "yuv420p10le",
      "-video_size",
      `${width}x${height}`,
      "-framerate",
      "1",
      "-i",
      join(dir, "quadrants.yuv"),
      "-frames:v",
      "3",
      "-c:v",
      "libx265",
      "-x265-params",
      `log-level=error:colorprim=9:transfer=${transfer === "arib-std-b67" ? 18 : 16}:colormatrix=9:range=full`,
      "-color_primaries",
      "bt2020",
      "-color_trc",
      transfer,
      "-colorspace",
      "bt2020nc",
      "-color_range",
      "pc",
      source,
    ]);
    for (const test of cases) {
      const input = join(dir, `${transfer}-${test.rotation}.mp4`);
      run(ffmpeg, [
        "-v",
        "error",
        "-display_rotation",
        String(test.rotation),
        "-i",
        source,
        "-map",
        "0:v:0",
        "-c",
        "copy",
        input,
      ]);
      assert.ok(
        probe(input).side_data_list?.some(
          (s) => Math.abs(s.rotation) === Math.abs(test.rotation),
        ),
        "Input rotation missing",
      );
      const cpu = join(dir, `${transfer}-${test.rotation}-cpu.mp4`);
      run(ffmpeg, [
        "-v",
        "error",
        "-i",
        input,
        "-map_metadata",
        "-1",
        "-vf",
        cpuFilter,
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        ...colors,
        cpu,
      ]);
      console.log(`${transfer} ${test.rotation} CPU: ${check(cpu, test)}`);
      if (cuda) {
        const gpu = join(dir, `${transfer}-${test.rotation}-cuda.mp4`);
        run(ffmpeg, [
          "-v",
          "error",
          "-hwaccel",
          "cuda",
          "-hwaccel_output_format",
          "cuda",
          "-noautorotate",
          "-display_rotation",
          "0",
          "-i",
          input,
          "-map_metadata",
          "-1",
          "-vf",
          `${gpuFilter},transpose_cuda=dir=${test.direction}`,
          "-c:v",
          "h264_nvenc",
          ...colors,
          gpu,
        ]);
        console.log(`${transfer} ${test.rotation} CUDA: ${check(gpu, test)}`);
      }
    }
  }
  console.log(
    cuda
      ? "HDR CUDA rotation regression passed."
      : "HDR CPU rotation regression passed.",
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
