boppa.data.register(credentialedData(['YOUTUBE_MUSIC_API_KEY', 'YOUTUBE_MUSIC_CLIENT_VERSION'], {
  "list/tracklist/album": async function(params) {
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
    const browseId = params.id;
    const albumArtist = '';
    const albumArtwork = undefined;

    const url = 'https://music.youtube.com/youtubei/v1/browse?prettyPrint=false&key=' + apiKey;

    const body = {
      context: clientContext(),
      browseId: browseId
    };

    const resp = await credentialFetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body)
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

    function extractAlbumTracks(response) {
      const results = [];
      let resolvedArtist = albumArtist;
      let resolvedArtwork = albumArtwork;
      let resolvedArtworkLow = albumArtwork;
      let resolvedAlbumTitle = '';
      let resolvedArtistBrowseId = '';

      try {
        let shelfContents = [];

        const tabs = response.contents?.twoColumnBrowseResultsRenderer?.tabs || [];
        const tabContent = tabs[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
        for (const section of tabContent) {
          const header = section.musicResponsiveHeaderRenderer;
          if (header) {
            if (!resolvedAlbumTitle) resolvedAlbumTitle = header.title?.runs?.[0]?.text || '';
            if (!resolvedArtist) {
              const straplineRun = header.straplineTextOne?.runs?.[0];
              resolvedArtist = straplineRun?.text || '';
              resolvedArtistBrowseId = straplineRun?.navigationEndpoint?.browseEndpoint?.browseId || '';
            }
            if (!resolvedArtwork) {
              const thumbs = header.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
              resolvedArtworkLow = thumbs.length > 0 ? (thumbs[1]?.url || thumbs[0].url) : undefined;
              resolvedArtwork = thumbs.length > 0 ? upgradeArtwork(thumbs[thumbs.length - 1].url) : undefined;
            }
          }
        }

        const secondaryContents = response.contents?.twoColumnBrowseResultsRenderer?.secondaryContents?.sectionListRenderer?.contents || [];
        for (const section of secondaryContents) {
          if (section.musicShelfRenderer) {
            shelfContents = section.musicShelfRenderer.contents || [];
            break;
          }
        }

        for (const item of shelfContents) {
          const listItem = item.musicResponsiveListItemRenderer;
          if (!listItem) continue;

          const videoId = listItem.playlistItemData?.videoId
            || listItem.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId;
          if (!videoId) continue;

          const flexColumns = listItem.flexColumns || [];
          const title = flexColumns[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text || '';

          const artists = [];
          const col1Runs = flexColumns[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
          for (const run of col1Runs) {
            const pt = run.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType;
            const browseId = run.navigationEndpoint?.browseEndpoint?.browseId;
            if (pt === 'MUSIC_PAGE_TYPE_ARTIST' || pt === 'MUSIC_PAGE_TYPE_USER_CHANNEL') {
              artists.push({ id: browseId || run.text, name: run.text, metadata: browseId ? { browseId: browseId } : {} });
            }
          }

          let duration;
          const fixedCols = listItem.fixedColumns || [];
          const durationText = fixedCols[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs?.[0]?.text || '';
          if (durationText && /^\d+:\d+/.test(durationText.trim())) {
            duration = parseDuration(durationText.trim());
          }

          const trackArtists = artists.length > 0 ? artists : (resolvedArtist && resolvedArtistBrowseId ? [{ id: resolvedArtistBrowseId, name: resolvedArtist, metadata: { browseId: resolvedArtistBrowseId } }] : []);
          results.push({
            id: videoId,
            title: title,
            subtitle: artists.length > 0 ? artists.map(a => a.name).join(', ') : (resolvedArtist || undefined),
            profiles: trackArtists.length > 0 ? trackArtists : undefined,
            tracklists: (resolvedAlbumTitle && browseId) ? [{ id: browseId, title: resolvedAlbumTitle, lowResArtworkUrl: resolvedArtworkLow, highResArtworkUrl: resolvedArtwork, metadata: { browseId: browseId } }] : undefined,
            duration: duration,
            lowResArtworkUrl: resolvedArtworkLow,
            highResArtworkUrl: resolvedArtwork,
            url: 'https://music.youtube.com/watch?v=' + videoId
          });
        }
      } catch (e) {}

      return { items: results };
    }

    const result = extractAlbumTracks(data);
    return { items: result.items };
  },
}));
