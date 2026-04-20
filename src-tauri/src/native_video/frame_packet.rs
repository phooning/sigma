use super::constants::{
    FRAME_PACKET_HEADER_LEN, FRAME_PACKET_MAGIC, PIXEL_FORMAT_YUV420, YUV420_BYTES_PER_2_PIXELS,
    YUV420_PIXELS_PER_BYTE_GROUP,
};

pub(crate) fn yuv420_payload_len(width: u32, height: u32) -> usize {
    let width = even_dimension(width) as u64;
    let height = even_dimension(height) as u64;
    (width * height * YUV420_BYTES_PER_2_PIXELS / YUV420_PIXELS_PER_BYTE_GROUP) as usize
}

pub(crate) fn frame_packet_len(width: u32, height: u32) -> usize {
    FRAME_PACKET_HEADER_LEN + yuv420_payload_len(width, height)
}

pub(crate) fn make_frame_packet(
    stream_id: u64,
    sequence: u64,
    pts_us: u64,
    width: u32,
    height: u32,
    tier_id: u8,
) -> Vec<u8> {
    // SVF1 synthetic packets now carry planar YUV420 instead of RGBA8.
    let mut packet = vec![0_u8; frame_packet_len(width, height)];
    write_synthetic_yuv420_packet(
        &mut packet,
        stream_id,
        sequence,
        pts_us,
        width,
        height,
        tier_id,
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
    // SVF1 payloads are packed as YUV420 planar bytes at 1.5 Bpp.
    let payload_len = yuv420_payload_len(width, height);
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
        even_dimension(width),
    );
    packet[FRAME_PACKET_HEADER_LEN..].copy_from_slice(&payload[..payload_len]);
    packet
}

pub(crate) fn write_synthetic_yuv420_packet(
    packet: &mut [u8],
    stream_id: u64,
    sequence: u64,
    pts_us: u64,
    width: u32,
    height: u32,
    tier_id: u8,
) -> usize {
    let width = even_dimension(width);
    let height = even_dimension(height);
    let payload_len = yuv420_payload_len(width, height);
    let packet_len = FRAME_PACKET_HEADER_LEN + payload_len;
    assert!(packet.len() >= packet_len);

    write_header(
        &mut packet[..packet_len],
        stream_id,
        sequence,
        pts_us,
        width,
        height,
        tier_id,
        payload_len,
        width,
    );
    fill_synthetic_yuv420(
        &mut packet[FRAME_PACKET_HEADER_LEN..packet_len],
        width,
        height,
        sequence,
        stream_id,
    );
    packet_len
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
    packet[6] = PIXEL_FORMAT_YUV420;
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
    write_u32(packet, 52, FRAME_PACKET_HEADER_LEN as u32);
    write_u32(
        packet,
        56,
        FRAME_PACKET_HEADER_LEN as u32 + (width as usize * height as usize) as u32,
    );
    write_u32(
        packet,
        60,
        FRAME_PACKET_HEADER_LEN as u32
            + (width as usize * height as usize) as u32
            + ((width as usize / 2) * (height as usize / 2)) as u32,
    );
}

fn fill_synthetic_yuv420(
    payload: &mut [u8],
    width: u32,
    height: u32,
    sequence: u64,
    stream_id: u64,
) {
    let width = width as usize;
    let height = height as usize;
    let y_len = width * height;
    let chroma_width = width / 2;
    let chroma_height = height / 2;
    let chroma_len = chroma_width * chroma_height;
    let (y_plane, chroma) = payload.split_at_mut(y_len);
    let (u_plane, v_plane) = chroma.split_at_mut(chroma_len);
    let luma_base = (stream_id & 0x3f) as u8;
    let u_base = 96_u8.wrapping_add(((stream_id >> 8) & 0x1f) as u8);
    let v_base = 160_u8.wrapping_add(((stream_id >> 16) & 0x1f) as u8);
    let motion = (sequence % 255) as u8;

    for y in 0..height {
        let row = y * width;
        for x in 0..width {
            y_plane[row + x] = 48_u8
                .wrapping_add(luma_base)
                .wrapping_add((x as u8).wrapping_mul(2))
                .wrapping_add((y as u8).wrapping_mul(3))
                .wrapping_add(motion);
        }
    }

    for y in 0..chroma_height {
        let row = y * chroma_width;
        for x in 0..chroma_width {
            u_plane[row + x] = u_base.wrapping_add((x as u8).wrapping_add(motion / 2));
            v_plane[row + x] = v_base.wrapping_sub((y as u8).wrapping_add(motion / 3));
        }
    }
}

fn even_dimension(value: u32) -> u32 {
    value.saturating_sub(value % 2).max(2)
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
