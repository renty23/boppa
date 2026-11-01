boppa.data.register(credentialedData(['SOUNDCLOUD_CLIENT_ID'], {
  "list/tracklist/album": async function(params) {
    const clientId = boppa.store.get('SOUNDCLOUD_CLIENT_ID');
    const targetPageSize = 10;
    const sourceBatchSize = 10;
    const requestDelayMs = 500;

    function upgradeArtwork(url) {
      if (!url) return url;
      return url.replace(/-large(\.[a-zA-Z]+)$/, '-t1080x1080$1');
    }

    function createPacedFetch() {
      let madeRequest = false;
      return async function(url) {
        if (madeRequest) {
          await new Promise(resolve => setTimeout(resolve, requestDelayMs));
        }
        madeRequest = true;
        return credentialFetch(url);
      };
    }

    // Catalog tracks expose encrypted AAC plus MP3 placeholders that resolve as 404.
    // Keep tracks with public AAC and MP3-only uploads that have no encrypted streams.
    function isDrmOnlyTrack(track) {
      const transcodings = track?.media?.transcodings || [];
      const protocol = x => String(x?.format?.protocol || x?.protocol || '');
      const hasEncryptedStream = transcodings.some(x =>
        protocol(x).includes('encrypted'));
      const hasPublicAac = transcodings.some(x =>
        !protocol(x).includes('encrypted')
          && (x?.preset === 'aac_160k' || x?.preset === 'aac_96k')
          && protocol(x) === 'hls');
      return hasEncryptedStream && !hasPublicAac;
    }

    // Keep enough source information for playback to recover if either the signed
    // audio URL or the selected transcoding endpoint expires. The playback config
    // owns selection; Swift persists this object as opaque JSON.
    function soundcloudPlaybackMetadata(t) {
      const transcodings = (t.media?.transcodings || [])
        .filter(x => x?.url && x?.preset
          && !String(x.format?.protocol || '').includes('encrypted')
          && !String(x.preset).startsWith('abr_'))
        .map(x => ({
          url: x.url,
          preset: x.preset,
          protocol: x.format?.protocol || 'progressive',
          mimeType: x.format?.mime_type || null,
          quality: x.quality || null
        }));
      const pick = (preset, protocol) => transcodings.find(x =>
        x.preset === preset && (!protocol || x.protocol === protocol));
      const selected = pick('aac_160k', 'hls')
        || pick('aac_96k', 'hls')
        || pick('mp3_1_0', 'hls')
        || pick('mp3_1_0', 'progressive')
        || pick('mp3_0_1', 'hls')
        || pick('mp3_0_1', 'progressive')
        || pick('mp3_0_0', 'hls')
        || pick('mp3_0_0', 'progressive')
        || null;
      return {
        soundcloudTrackId: String(t.id),
        soundcloudSecretToken: t.secret_token || null,
        streamRequestUrl: selected?.url || null,
        streamPreset: selected?.preset || null,
        streamProtocol: selected?.protocol || null,
        streamMimeType: selected?.mimeType || null,
        transcodings: transcodings
      };
    }

    function mapTrack(t) {
      const playbackMetadata = soundcloudPlaybackMetadata(t);
      return {
        id: t.id, title: t.title, subtitle: t.user?.username,
        profiles: t.user?.username ? [{ id: t.user.id, name: t.user.username }] : undefined,
        duration: t.duration,
        lowResArtworkUrl: t.artwork_url || t.user?.avatar_url,
        highResArtworkUrl: upgradeArtwork(t.artwork_url || t.user?.avatar_url),
        url: t.permalink_url,
        metadata: playbackMetadata
      };
    }

    const pacedFetch = createPacedFetch();
    let nextOffset = params.previousResult?.nextOffset || 0;
    let trackIds = params.previousResult?.trackIds;

    if (!trackIds) {
      const albumResp = await pacedFetch('https://api-v2.soundcloud.com/playlists/'
        + params.id + '?client_id=' + clientId);
      const albumData = await albumResp.json();
      trackIds = (albumData.tracks || []).map(t => t.id);
    }

    const items = [];
    while (nextOffset < trackIds.length && items.length < targetPageSize) {
      const pageIds = trackIds.slice(nextOffset, nextOffset + sourceBatchSize);
      const resp = await pacedFetch('https://api-v2.soundcloud.com/tracks?ids='
        + pageIds.map(encodeURIComponent).join('%2C') + '&client_id=' + clientId);
      const data = await resp.json();
      const trackMap = {};
      if (Array.isArray(data)) {
        for (const t of data) trackMap[t.id] = t;
      }
      items.push(...pageIds.map(id => {
        const t = trackMap[id];
        if (!t || t.policy === 'SNIP' || t.monetization_model === 'SUB_HIGH_TIER'
          || isDrmOnlyTrack(t)) return null;
        return mapTrack(t);
      }).filter(Boolean));
      nextOffset += pageIds.length;
    }

    const output = { items: items };
    if (nextOffset < trackIds.length) {
      output.nextOffset = nextOffset;
      output.trackIds = trackIds;
    }
    return output;
  },
}));
