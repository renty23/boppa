boppa.data.register(credentialedData(['YOUTUBE_MUSIC_API_KEY', 'YOUTUBE_MUSIC_CLIENT_VERSION'], {
  "get/track/song": async function(params) {
    const apiKey = boppa.store.get('YOUTUBE_MUSIC_API_KEY');
    const clientVersion = boppa.store.get('YOUTUBE_MUSIC_CLIENT_VERSION');

    // Tie the request to the same visitor the site would use; InnerTube varies
    // both result sets and continuation behaviour without a visitor id.
    const visitorData = boppa.store.get('YOUTUBE_MUSIC_VISITOR_DATA') || '';
    function clientContext() {
      const client = { clientName: 'WEB_REMIX', clientVersion: clientVersion };
      if (visitorData) client.visitorData = visitorData;
      return { client: client };
    }
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
    };
    if (visitorData) headers['X-Goog-Visitor-Id'] = visitorData;
    const videoId = params.id;

    const url = 'https://music.youtube.com/youtubei/v1/next?prettyPrint=false&key=' + apiKey;
    const resp = await credentialFetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        context: clientContext(),
        videoId: videoId
      })
    });
    const data = await resp.json();

    function parseDuration(timeStr) {
      const parts = timeStr.split(':').map(p => parseInt(p, 10));
      if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
      if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
      return undefined;
    }

    function upgradeArtwork(url) {
      if (!url) return url;
      if (url.indexOf('ytimg.com') !== -1) {
        return url.replace(/\/[^\/?]+\.(jpg|jpeg|webp)(\?.*)?$/i, '/maxresdefault.jpg');
      }
      return url.replace(/=w\d+-h\d+/, '=w544-h544');
    }

    try {
      const panelContents = data.contents?.singleColumnMusicWatchNextResultsRenderer?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.musicQueueRenderer?.content?.playlistPanelRenderer?.contents || [];
      let renderer = null;
      for (const item of panelContents) {
        const candidate = item.playlistPanelVideoRenderer;
        if (candidate && candidate.videoId === videoId) { renderer = candidate; break; }
      }
      if (!renderer) renderer = panelContents.find(item => item.playlistPanelVideoRenderer)?.playlistPanelVideoRenderer;
      if (!renderer) { return { id: videoId, title: '' }; }
      else {
        const title = renderer.title?.runs?.[0]?.text || '';

        const artists = [];
        let albumName = '';
        let albumBrowseId = '';
        let year = null;
        const bylineRuns = renderer.longBylineText?.runs || [];
        for (const run of bylineRuns) {
          const pt = run.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType;
          const browseId = run.navigationEndpoint?.browseEndpoint?.browseId;
          if (pt === 'MUSIC_PAGE_TYPE_ARTIST' || pt === 'MUSIC_PAGE_TYPE_USER_CHANNEL') {
            artists.push({ id: browseId || run.text, name: run.text, metadata: browseId ? { browseId: browseId } : {} });
          } else if (pt === 'MUSIC_PAGE_TYPE_ALBUM' && browseId) {
            albumName = run.text;
            albumBrowseId = browseId;
          } else if (run.text && /^\d{4}$/.test(run.text.trim())) {
            year = parseInt(run.text.trim(), 10);
          }
        }
        if (artists.length === 0 && bylineRuns.length > 0 && bylineRuns[0].text && bylineRuns[0].text !== ' • ') {
          artists.push({ id: bylineRuns[0].text, name: bylineRuns[0].text });
        }

        let duration;
        const durationText = renderer.lengthText?.runs?.[0]?.text || '';
        if (durationText && /^\d+:\d+/.test(durationText.trim())) duration = parseDuration(durationText.trim());

        const thumbnails = renderer.thumbnail?.thumbnails || [];
        const lowResArtworkUrl = thumbnails.length > 0 ? (thumbnails[1]?.url || thumbnails[0].url) : undefined;
        const highResArtworkUrl = thumbnails.length > 0 ? upgradeArtwork(thumbnails[thumbnails.length - 1].url) : undefined;

        const result = {
          id: videoId,
          title: title,
          subtitle: artists.map(a => a.name).join(', ') || undefined,
          duration: duration,
          lowResArtworkUrl: lowResArtworkUrl,
          highResArtworkUrl: highResArtworkUrl,
          url: 'https://music.youtube.com/watch?v=' + videoId
        };
        if (artists.length > 0) result.profiles = artists;
        if (albumBrowseId) {
          const albumItem = { id: albumBrowseId, title: albumName, lowResArtworkUrl: lowResArtworkUrl, highResArtworkUrl: highResArtworkUrl, metadata: { browseId: albumBrowseId } };
          if (year !== null) albumItem.year = year;
          result.tracklists = [albumItem];
        }
        if (year !== null) result.year = year;
        return result;
      }
    } catch (e) {
      return { id: videoId, title: '' };
    }
  },
}));
