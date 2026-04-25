# SIGMA Studio

**SIGMA Studio** is a high-performance, local-first infinite canvas designed for organizing, visualizing, and cutting up media assets. 

<img alt="Image" src="https://github.com/user-attachments/assets/443eaeea-3534-4c63-94c9-78b86dd00630" />

I built this with Tauri on Rust and React with the help of multi-agent reviews. It offers a lightweight OS-native alternative to heavy electron-based media tools, specifically optimized for creative workflows and high performance viewing.

<div align="center">
  <video src="https://github.com/user-attachments/assets/1b56a101-d80d-46a1-a4df-2c7f6ced73f8" 
         autoplay 
         loop 
         muted 
         playsinline 
         width="100%" 
         style="max-width: 800px;">
  </video>
</div>

> *Film edit planning, ML/dataset triage, moodboarding with massive clips, evidence intel boards: just drop a bunch of media down and think about it spatially.*

## Key Features

Video/images are first class assets active in spatial state.

- **Infinite Spatial Canvas**: Drag, drop, and organize videos and images in a non-linear workspace.
- **Video Controls**: Frame-accurate scrubbing, A/B looping, and dynamic visual cropping.
- **Local-First Performance**: Leverages Rust-based backend for zero-latency media handling and low memory footprint.
- **Export Utility**: Basic H.264 export for A/B loops and cropped segments.
- **Workflows:** Config can be saved to preserve layout, so you can load up templates at any time.
- **ComfyUI Integration (WIP)**: Connect to your local ComfyUI instance to visualize AI generation outputs in real-time.

## Tech Stack
- **Frontend**: React + Vite + TypeScript
- **Backend**: Tauri (Rust)
- **Styling**: Tailwind CSS/shadcn
- **Testing**: Vitest

## Getting Started

### Prerequisites
- [Rust](https://www.rust-lang.org/tools/install) (latest stable)
- [Node.js](https://nodejs.org/) (v18+)
- [FFmpeg](https://ffmpeg.org/) (installed in your system PATH for export features)

### Installation
1. Clone the repository:
   ```bash
   git clone https://github.com/phooning/sigma.git
   cd sigma
   ```

2. Install dependencies:
   ```bash
   pnpm install
   ```

### Development
Run the app in development mode with hot-reloading:
```bash
pnpm run tauri dev
```

### Build
Generate a production-ready bundled application for your OS:
```bash
pnpm run build
pnpm run tauri build
```

## Testing
Run the unit test suite via Vitest:
```bash
pnpm test
```

Run the unit benchmark suite and compare against the committed baseline:
```bash
pnpm bench:check
```

Refresh the committed benchmark baseline after an intentional performance change:
```bash
pnpm bench:update
```

## Roadmap & Tiers
This Studio edition provides the core visualization capability. A planned **SIGMA Render Lab** offers advanced features for power users and lab applications:

| Feature | Studio | Render Lab |
| :--- | :--- | :--- |
| **Canvas** | Single Infinite Canvas | Multiple/Project-based Workspaces |
| **Engine** | Natively WebView through Tauri | `wgpu` accelerated, direct render pipeline |
| **Exports** | 1080p H.264 | 4K+, ProRes, Wide Gamut, Live Asset Streaming |
| **Automation** | ComfyUI Browser & Execution (WIP) | Cloud Compute & Folder Watching |
| **Asset Support** | Standard (JPG/MP4) | RAW, 3D (OBJ/STL), EXR |

## License

Licensed under the **Apache 2.0**.

---
*Created by [David Pham](https://github.com/phooning/).*
