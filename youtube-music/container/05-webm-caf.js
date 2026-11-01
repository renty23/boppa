// WebM (EBML/Matroska) Opus demuxer + CAF muxer.
//
// AVFoundation cannot demux WebM, but CoreAudio decodes Opus when it is carried
// in a Core Audio Format (CAF) file. This library rewrites a complete WebM audio
// stream into an equivalent CAF that CoreAudio decodes identically to Apple's
// own `afconvert -f caff -d opus` output (the raw OpusHead is used as the
// optional magic cookie; CoreAudio accepts that, Apple's 28-byte form, or none).
//
// The exact CAF layout was determined empirically by decoding candidate files
// through CoreAudio and comparing PCM to a reference decoder (see the repo's
// test notes): desc/pakt/data are required, `kuki` and `chan` are optional, and
// packet sizes must all be known up front because `pakt` precedes `data`.
//
// Everything here is pure functions over byte arrays so it can be unit tested in
// Node without the playback container.

(function(global) {
  'use strict';

  // ---- EBML primitives ----

  /// Read an EBML variable-length integer at `pos`. `keepMarker` leaves the
  /// length-marker bit in place (element IDs are compared with it; sizes are not).
  function readVint(bytes, pos, keepMarker) {
    if (pos >= bytes.length) throw new Error('EBML: vint past end at ' + pos);
    const first = bytes[pos];
    let length = 1;
    let mask = 0x80;
    while (length <= 8 && !(first & mask)) { mask >>= 1; length++; }
    if (length > 8) throw new Error('EBML: invalid vint at ' + pos);
    if (pos + length > bytes.length) throw new Error('EBML: truncated vint at ' + pos);
    let value = keepMarker ? first : (first & (mask - 1));
    let unknown = !keepMarker && (first & (mask - 1)) === (mask - 1);
    for (let i = 1; i < length; i++) {
      value = value * 256 + bytes[pos + i];
      if (bytes[pos + i] !== 0xff) unknown = false;
    }
    return { value: value, length: length, unknown: unknown };
  }

  function readUint(bytes, pos, size) {
    let v = 0;
    for (let i = 0; i < size; i++) v = v * 256 + bytes[pos + i];
    return v;
  }

  function readFloat(bytes, pos, size) {
    const view = new DataView(new Uint8Array(bytes.slice(pos, pos + size)).buffer);
    if (size === 4) return view.getFloat32(0);
    if (size === 8) return view.getFloat64(0);
    throw new Error('EBML: float of size ' + size);
  }

  // Element IDs (with marker bit, as they appear in the stream).
  const ID = {
    EBML: 0x1A45DFA3,
    Segment: 0x18538067,
    Info: 0x1549A966,
    TimecodeScale: 0x2AD7B1,
    Duration: 0x4489,
    Tracks: 0x1654AE6B,
    TrackEntry: 0xAE,
    TrackNumber: 0xD7,
    TrackType: 0x83,
    CodecID: 0x86,
    CodecPrivate: 0x63A2,
    CodecDelay: 0x56AA,
    SeekPreRoll: 0x56BB,
    Audio: 0xE1,
    SamplingFrequency: 0xB5,
    Channels: 0x9F,
    Cluster: 0x1F43B675,
    Timecode: 0xE7,
    SimpleBlock: 0xA3,
    BlockGroup: 0xA0,
    Block: 0xA1,
    Cues: 0x1C53BB6B,
    SeekHead: 0x114D9B74,
    Void: 0xEC,
    Tags: 0x1254C367,
  };

  // Master elements we descend into; everything else is a leaf we either read
  // or skip. Cluster is handled specially because its size may be "unknown".
  const MASTER = new Set([ID.Segment, ID.Info, ID.Tracks, ID.TrackEntry, ID.Audio, ID.Cluster, ID.BlockGroup]);

  /// Parse an Opus WebM into { opusHead, preSkipSamples, channels, inputSampleRate,
  /// durationSeconds, packets: Uint8Array[] }. Throws on anything that is not a
  /// single-audio-track Opus WebM, so callers can fall back to another format.
  function demuxWebmOpus(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const out = {
      opusHead: null, preSkipSamples: 0, channels: 0, inputSampleRate: 48000,
      timecodeScale: 1000000, durationTicks: 0, codecDelayNs: 0, packets: [],
    };
    let audioTrackNumber = null;
    let currentTrack = null;

    if (readVint(bytes, 0, true).value !== ID.EBML) throw new Error('not an EBML/WebM stream');

    function walk(start, end, depth) {
      let pos = start;
      while (pos < end) {
        const id = readVint(bytes, pos, true);
        const size = readVint(bytes, pos + id.length, false);
        const dataStart = pos + id.length + size.length;
        // Unknown-size elements (live-style Clusters/Segment) extend to the parent's end.
        const dataEnd = size.unknown ? end : Math.min(end, dataStart + size.value);

        switch (id.value) {
          case ID.TrackEntry:
            currentTrack = { number: null, type: null, codec: null };
            walk(dataStart, dataEnd, depth + 1);
            if (currentTrack.type === 2 && currentTrack.codec === 'A_OPUS') {
              if (audioTrackNumber !== null) throw new Error('WebM has more than one Opus track');
              audioTrackNumber = currentTrack.number;
            }
            currentTrack = null;
            break;
          case ID.TrackNumber: if (currentTrack) currentTrack.number = readUint(bytes, dataStart, size.value); break;
          case ID.TrackType: if (currentTrack) currentTrack.type = readUint(bytes, dataStart, size.value); break;
          case ID.CodecID: if (currentTrack) currentTrack.codec = String.fromCharCode.apply(null, bytes.slice(dataStart, dataEnd)); break;
          case ID.CodecPrivate: if (currentTrack) out.opusHead = bytes.slice(dataStart, dataEnd); break;
          case ID.CodecDelay: if (currentTrack) out.codecDelayNs = readUint(bytes, dataStart, size.value); break;
          case ID.SamplingFrequency: if (currentTrack) out.inputSampleRate = readFloat(bytes, dataStart, size.value); break;
          case ID.Channels: if (currentTrack) out.channels = readUint(bytes, dataStart, size.value); break;
          case ID.TimecodeScale: out.timecodeScale = readUint(bytes, dataStart, size.value); break;
          case ID.Duration: out.durationTicks = readFloat(bytes, dataStart, size.value); break;
          case ID.SimpleBlock:
          case ID.Block: {
            // Block header: track number (vint), int16 timecode, flags, then frame data.
            const track = readVint(bytes, dataStart, false);
            const flags = bytes[dataStart + track.length + 2];
            const lacing = (flags >> 1) & 0x03;
            if (track.value === audioTrackNumber) {
              const frameStart = dataStart + track.length + 3;
              if (lacing !== 0) {
                // YouTube's WebM never laces Opus, and lacing changes packet boundaries,
                // which CAF needs exactly. Refuse rather than guess.
                throw new Error('laced Opus block not supported');
              }
              out.packets.push(bytes.slice(frameStart, dataEnd));
            }
            break;
          }
          default:
            if (MASTER.has(id.value)) walk(dataStart, dataEnd, depth + 1);
            break;
        }
        pos = dataEnd;
      }
    }

    walk(0, bytes.length, 0);

    if (audioTrackNumber === null) throw new Error('WebM has no Opus audio track');
    if (!out.packets.length) throw new Error('WebM has no Opus packets');

    // Pre-skip: authoritative source is OpusHead (little-endian uint16 at offset 10).
    // WebM also carries it as CodecDelay in ns; they agree for well-formed files.
    if (out.opusHead && out.opusHead.length >= 19 &&
        String.fromCharCode.apply(null, out.opusHead.slice(0, 8)) === 'OpusHead') {
      out.preSkipSamples = out.opusHead[10] | (out.opusHead[11] << 8);
      if (!out.channels) out.channels = out.opusHead[9];
    } else if (out.codecDelayNs) {
      out.preSkipSamples = Math.round(out.codecDelayNs * 48000 / 1e9);
    }
    if (!out.channels) throw new Error('WebM Opus track has no channel count');

    out.durationSeconds = out.durationTicks
      ? out.durationTicks * out.timecodeScale / 1e9
      : out.packets.length * 0.02;
    return out;
  }

  // ---- CAF writer ----

  const OPUS_FRAMES_PER_PACKET = 960; // 20 ms at the 48 kHz Opus decode rate

  function be16(v) { return [(v >> 8) & 0xff, v & 0xff]; }
  function be32(v) { return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff]; }
  function be64(v) {
    // Values here are byte counts / frame counts, comfortably below 2^53.
    const hi = Math.floor(v / 4294967296);
    const lo = v - hi * 4294967296;
    return be32(hi).concat(be32(lo));
  }
  function be64f(v) {
    const buf = new ArrayBuffer(8); new DataView(buf).setFloat64(0, v);
    return Array.from(new Uint8Array(buf));
  }
  function fourcc(s) { return [s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)]; }

  /// CAF packet-table sizes are big-endian base-128 varints (high bit = more).
  function packetSizeVarint(n) {
    const groups = [];
    do { groups.unshift(n & 0x7f); n = Math.floor(n / 128); } while (n > 0);
    return groups.map(function(g, i) { return i < groups.length - 1 ? (g | 0x80) : g; });
  }

  function chunk(type, body) {
    return fourcc(type).concat(be64(body.length), body);
  }

  /// Build a complete CAF file (as Uint8Array) from demuxed Opus packets.
  /// `remainderFrames` lets a caller trim trailing padding if it knows the true
  /// PCM length; 0 is what CoreAudio produces for this input too when unknown.
  function muxOpusToCaf(demuxed, options) {
    const opts = options || {};
    const packets = demuxed.packets;
    const channels = demuxed.channels;
    const preSkip = demuxed.preSkipSamples | 0;
    const remainder = opts.remainderFrames | 0;

    const desc = [].concat(
      be64f(48000.0),
      fourcc('opus'),
      be32(0),                        // format flags
      be32(0),                        // bytes per packet (variable)
      be32(OPUS_FRAMES_PER_PACKET),
      be32(channels),
      be32(0)                         // bits per channel (compressed)
    );

    let audioBytes = 0;
    const sizeTable = [];
    for (let i = 0; i < packets.length; i++) {
      audioBytes += packets[i].length;
      const v = packetSizeVarint(packets[i].length);
      for (let j = 0; j < v.length; j++) sizeTable.push(v[j]);
    }
    const numValidFrames = packets.length * OPUS_FRAMES_PER_PACKET - preSkip - remainder;
    const pakt = [].concat(
      be64(packets.length),
      be64(numValidFrames),
      be32(preSkip),
      be32(remainder),
      sizeTable
    );

    // Optional channel layout; stereo/mono use Apple's standard tags. Anything
    // else is left for CoreAudio to infer from channelsPerFrame.
    const layoutTag = channels === 2 ? 0x650002 : channels === 1 ? 0x640001 : 0;
    const chan = layoutTag ? chunk('chan', [].concat(be32(layoutTag), be32(0), be32(0))) : [];

    // Optional magic cookie: the raw OpusHead is accepted by CoreAudio.
    const kuki = demuxed.opusHead && demuxed.opusHead.length ? chunk('kuki', Array.from(demuxed.opusHead)) : [];

    const header = [].concat(fourcc('caff'), be16(1), be16(0));
    const dataHead = fourcc('data').concat(be64(4 + audioBytes), be32(0)); // editCount 0

    const prefix = [].concat(header, chunk('desc', desc), kuki, chan, chunk('pakt', pakt), dataHead);
    const out = new Uint8Array(prefix.length + audioBytes);
    out.set(prefix, 0);
    let off = prefix.length;
    for (let i = 0; i < packets.length; i++) { out.set(packets[i], off); off += packets[i].length; }
    return out;
  }

  const api = {
    demuxWebmOpus: demuxWebmOpus,
    muxOpusToCaf: muxOpusToCaf,
    readVint: readVint,
    packetSizeVarint: packetSizeVarint,
    OPUS_FRAMES_PER_PACKET: OPUS_FRAMES_PER_PACKET,
  };
  global.BoppaOpusCaf = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
