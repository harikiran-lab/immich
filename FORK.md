# Immich HDR and original-first fork

This branch is based on **Immich v3.3.5**, matching the existing server. It has no
database migrations and does not change original media.

## Changes

- The server image replaces Jellyfin FFmpeg 7.1.4-3 with the official **8.1.3-1**
  Debian Trixie package. Downloads are pinned by SHA-256 for each architecture.
  Version 8 includes the upstream correction for the CUDA HLG reference-white bug
  ([jellyfin-ffmpeg#775](https://github.com/jellyfin/jellyfin-ffmpeg/issues/775)).
  NVDEC decoding, CUDA tone mapping and NVENC encoding remain available.
- When FFmpeg exposes HEVC HDR color metadata only on decoded frames, the server
  recovers it from a bounded 32-packet prefix. Known stream metadata takes precedence;
  ordinary untagged 8-bit video does not incur this extra decoding step.
- The web player prefers originals by default. A terminal network, decoding or
  unsupported-format media error switches once to the existing encoded video.
  If experimental real-time transcoding is enabled, the fallback uses HLS instead.
  Aborted loads and stale errors from a previous video do not trigger fallback.
- The player keeps the menu's playback mode in sync, preserves playback position
  and play/pause intent, and tries the original again for the next asset.
- Encoded playback requires cache revalidation, and the web URL bypasses old
  day-long cache entries. Regenerating a video keeps the thumbnail hash unchanged;
  previously this could leave the old dark copy in a browser even after a fresh
  encode was correct. Unchanged files can still reuse cached bytes after validation.

This changes the **web player**. Existing official mobile apps are not modified.
Fallback handles reported playback failures; it cannot detect a browser that
silently displays HDR with incorrect colors. Manual mode selection remains available.

## Publish the image

The **Publish HDR server image** workflow runs on pushes to `hdr-original-fallback`,
tags matching `hdr-v*`, and manual dispatch. It uses hosted Linux runners and
`GITHUB_TOKEN`; no Docker Hub credentials or Immich organization secrets are needed.

Player tests, Svelte checks and the existing media-service tests must pass first.
The workflow then builds the complete server/web image, verifies the installed
FFmpeg version and filters, and runs synthetic HLG and HDR10 CPU conversion tests
inside it **before publishing**.

Published images:

```text
ghcr.io/harikiran-lab/immich-server:hdr
ghcr.io/harikiran-lab/immich-server:sha-<full-commit-sha>
```

Tag builds publish their `hdr-v*` tag instead of replacing `hdr`. The workflow
currently publishes **linux/amd64**, matching the NVIDIA server. The package lock
also records ARM64 checksums for future native ARM64 builds.

GitHub may initially disable Actions on a new fork. Enable Actions in this
repository before running the workflow. A new GHCR package may also need its
visibility changed to public, or the server must authenticate to GHCR to pull it.

## Validate on the NVIDIA host

The hosted build runner has no NVIDIA GPU. After the image is published, run this
isolated check on the server before replacing the production container:

```sh
docker run --rm --gpus all --entrypoint node \
  ghcr.io/harikiran-lab/immich-server:hdr \
  /usr/src/app/server/bin/verify-hdr.mjs --cuda
```

It uses generated 10-bit HLG and PQ video, checks BT.709 output metadata and
non-crushed luminance, and compares the NVDEC/CUDA/NVENC output with CPU tone
mapping. It mounts no library or database. The host's NVIDIA driver must support
the FFmpeg build. The test fails explicitly if GPU initialization or encoding fails.

## Use the fork

1. Keep the current database and library backups. Change only the server image to
   the fork's **immutable `sha-*` tag** once its workflow and GPU check pass. Keep
   the existing v3.3.5 machine-learning and database images.
2. Hardware decoding can be re-enabled after the GPU check passes. Keep tone
   mapping enabled for compatibility copies. Previously dark encoded videos must
   be regenerated with **More → Refresh encoded videos**.
3. Existing browsers may retain an explicit old preference. Enable **Account
   Settings → App Settings → Play original video** to opt into original-first
   playback there; new browser profiles default to it. Reload the web application
   after deploying so the updated player is loaded.
4. Keep background transcoding enabled if fallback should use saved copies.
   Turning it off does not create copies on failure. On-demand conversion instead
   requires enabling experimental real-time transcoding.

Deployment and library-wide regeneration are separate operations; publishing the
image does not perform either of them.

## Maintenance

Keep this branch based on an explicit Immich release and rebase updates deliberately.
Do not run an automatic upstream sync over these changes. The FFmpeg override is
in `docker/hdr/ffmpeg.json`; remove it when a future Immich base image ships the
fixed build, after rerunning the HDR tests. License and source notices are retained,
and image build metadata points to this fork and its exact commit.
