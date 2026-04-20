use super::constants::{BYTES_PER_PIXEL_RGBA8, FRAME_PACKET_HEADER_LEN, FRAME_PACKET_MAGIC};

pub(crate) fn make_frame_packet(
    stream_id: u64,
    sequence: u64,
    pts_us: u64,
    width: u32,
    height: u32,
    tier_id: u8,
) -> Vec<u8> {
    let stride = width.saturating_mul(BYTES_PER_PIXEL_RGBA8 as u32);
    let payload_len = stride as usize * height as usize;
    let mut packet = vec![0_u8; FRAME_PACKET_HEADER_LEN + payload_len];

    write_header(
        &mut packet,
        stream_id,
        sequence,
        pts_us,
        width,
        height,
        tier_id,
        payload_len,
        stride,
    );
    fill_synthetic_rgba(
        &mut packet[FRAME_PACKET_HEADER_LEN..],
        width,
        height,
        sequence,
        stream_id,
    );
    packet
}

pub(crate) fn make_frame_packet_from_payload(
    stream_id: u64,
    sequence: u64,
    pts_us: u64,
    width: u32,
    height: u32,
    tier_id: u8,
    payload: &[u8],
) -> Vec<u8> {
    let stride = width.saturating_mul(BYTES_PER_PIXEL_RGBA8 as u32);
    let payload_len = stride as usize * height as usize;
    let mut packet = vec![0_u8; FRAME_PACKET_HEADER_LEN + payload_len];

    write_header(
        &mut packet,
        stream_id,
        sequence,
        pts_us,
        width,
        height,
        tier_id,
        payload_len,
        stride,
    );
    packet[FRAME_PACKET_HEADER_LEN..].copy_from_slice(&payload[..payload_len]);
    packet
}

fn write_header(
    packet: &mut [u8],
    stream_id: u64,
    sequence: u64,
    pts_us: u64,
    width: u32,
    height: u32,
    tier_id: u8,
    payload_len: usize,
    stride: u32,
) {
    packet[0..4].copy_from_slice(FRAME_PACKET_MAGIC);
    packet[4] = 1;
    packet[5] = FRAME_PACKET_HEADER_LEN as u8;
    packet[6] = 1;
    packet[7] = 0;
    write_u64(packet, 8, sequence);
    write_u64(packet, 16, pts_us);
    write_u64(packet, 24, stream_id);
    write_u32(packet, 32, width);
    write_u32(packet, 36, height);
    write_u32(packet, 40, stride);
    write_u32(packet, 44, payload_len as u32);
    write_u16(packet, 48, tier_id as u16);
    write_u16(packet, 50, 0);
    write_u32(packet, 52, 0);
    write_u32(packet, 56, width);
    write_u32(packet, 60, height);
}

fn fill_synthetic_rgba(payload: &mut [u8], width: u32, height: u32, sequence: u64, stream_id: u64) {
    let r_base = (stream_id & 0xff) as u8;
    let g_base = ((stream_id >> 8) & 0xff) as u8;
    let b_base = ((stream_id >> 16) & 0xff) as u8;
    let motion = (sequence % 255) as u8;
    let width = width as usize;
    let height = height as usize;

    for y in 0..height {
        let row = y * width * 4;
        for x in 0..width {
            let offset = row + x * 4;
            payload[offset] = r_base.wrapping_add((x as u8).wrapping_add(motion));
            payload[offset + 1] = g_base.wrapping_add((y as u8).wrapping_sub(motion));
            payload[offset + 2] = b_base.wrapping_add(((x + y) as u8) / 2);
            payload[offset + 3] = 255;
        }
    }
}

fn write_u16(packet: &mut [u8], offset: usize, value: u16) {
    packet[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
}

fn write_u32(packet: &mut [u8], offset: usize, value: u32) {
    packet[offset..offset + 4].copy_from_slice(&value.to_le_bytes());
}

fn write_u64(packet: &mut [u8], offset: usize, value: u64) {
    packet[offset..offset + 8].copy_from_slice(&value.to_le_bytes());
}
