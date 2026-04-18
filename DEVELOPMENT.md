# Development

## Create temporary video assets for stress testing

```sh
# Lightweight — fast to generate, good for CI
ffmpeg -f lavfi -i testsrc2=size=1280x720:rate=30 -t 2400 -c:v libx264 -crf 35 ~/test-fixtures/720p_40min.mp4

# Medium
ffmpeg -f lavfi -i testsrc2=size=1920x1080:rate=30 -t 2400 -c:v libx264 -crf 28 ~/test-fixtures/1080p_40min.mp4

# Heavy
ffmpeg -f lavfi -i testsrc2=size=3840x2160:rate=30 -t 2400 -c:v libx264 -crf 28 ~/test-fixtures/4k_40min.mp4

# Pathological — high bitrate, less compression
ffmpeg -f lavfi -i testsrc2=size=3840x2160:rate=60 -t 2400 -c:v libx264 -crf 18 ~/test-fixtures/4k_60fps_hq.mp4
```

## Test large video drop behavior

`fixtures/heavy_video.mkv` is an optional local stress fixture and should not be committed. If it is not present, generate one of the temporary assets above and drop it into the running app.

```sh
pnpm vitest run src/InfiniteCanvas.test.tsx -t "videos"
pnpm tauri dev
```
