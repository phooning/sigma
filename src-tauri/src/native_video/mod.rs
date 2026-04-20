/*
Ownership contract summary:
ffmpeg or the synthetic decoder writes each frame into an SVF1 packet backed by a buffer borrowed
from the Rust FramePool. The FramePool allocates a fixed ring at native-video startup, hands buffers
to decode workers with a non-blocking recycle-channel try_recv, and records exhaustion when every
slot is in flight. A decoded packet moves to the broker inside a Drop wrapper. If the packet is
dropped before IPC, the wrapper returns the Arc<Vec<u8>> to the pool through the recycle channel.
At IPC dispatch the broker removes the Arc from the wrapper and calls Arc::try_unwrap so Tauri
receives the owned Vec<u8> directly as InvokeResponseBody::Raw, without cloning on a Tokio worker.
If unwrap cannot prove unique ownership within the bounded yield loop, the packet is dropped and
the wrapper recycles the buffer. Once IPC accepts the owned Vec, Rust treats that allocation as
consumed by the IPC boundary. The React surface transfers the resulting ArrayBuffer to the compositor
worker. The worker copies it into a small lazy ArrayBuffer pool, uploads or converts it, then returns
that worker buffer immediately after GPU upload or async bitmap creation so V8 does not retain large
short-lived frame objects.
*/

pub(crate) mod commands;
mod constants;
mod controller;
mod frame_packet;
mod profile;
mod resource_monitor;
mod state;
mod telemetry;
mod types;
mod util;
mod worker;

pub use state::NativeVideoState;

#[cfg(test)]
mod tests;
