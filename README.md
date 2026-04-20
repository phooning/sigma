# SIGMA Media Canvas (Community Edition)

**SIGMA Media Canvas** is a high-performance, local-first infinite canvas designed for organizing, visualizing, and analyzing media assets. Built with **Tauri**, **Rust**, and **React**, it offers a lightweight OS-native alternative to heavy electron-based media tools, specifically optimized for creative workflows and technical analysis.

Film edit planning, ML/dataset triage, moodboarding with massive clips, evidence intel boards: just throw a bunch of media down and think about it spatially.

- Save your config preserves the just the video location, so you can load up templates at any time.
- Lightweight: currently under 1K LoC
- Video/images as first class assets in spatial state

<div align="center">
  <video src="https://github.com/user-attachments/assets/646810a7-b566-4168-8cd3-a6a06a22df72" 
         autoplay 
         loop 
         muted 
         playsinline 
         width="100%" 
         style="max-width: 800px;">
  </video>
</div>

## Key Features
- **Infinite Spatial Canvas**: Drag, drop, and organize videos and images in a non-linear workspace.
- **Advanced Video Controls**: Frame-accurate scrubbing, A/B looping, and dynamic visual cropping.
- **Local-First Performance**: Leverages Rust-based backend for zero-latency media handling and low memory footprint.
- **ComfyUI Integration**: Connect to your local ComfyUI instance to visualize AI generation outputs in real-time.
- **Export Utility**: Basic H.264 export for A/B loops and cropped segments.

## Tech Stack
- **Frontend**: React + Vite + TypeScript
- **Backend**: Tauri (Rust)
- **Styling**: Tailwind CSS
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

## Roadmap & Tiers
This Community Edition provides the core visualization engine. **SIGMA Pro** offers advanced features for power users and industrial applications:

| Feature | Community | Pro |
| :--- | :--- | :--- |
| **Canvas** | Single Infinite Canvas | Multiple/Project-based Workspaces |
| **Exports** | 1080p H.264 | 4K+, ProRes, Hardware Accelerated |
| **Automation** | ComfyUI Browser & Execution (WIP) | Cloud Compute & Folder Watching |
| **Asset Support** | Standard (JPG/MP4) | RAW, 3D (OBJ/STL), EXR |

## License

Licensed under the **Apache 2.0**.

---
*Created by [David Pham](https://github.com/phooning/).*
