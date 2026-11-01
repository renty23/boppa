boppa.data.register(credentialedData(['YOUTUBE_MUSIC_API_KEY', 'YOUTUBE_MUSIC_CLIENT_VERSION'], {
  "search/tracklists/playlist": async function(params) {
    const apiKey = boppa.store.get('YOUTUBE_MUSIC_API_KEY');
    const clientVersion = boppa.store.get('YOUTUBE_MUSIC_CLIENT_VERSION');
    // Tie every page of a search to one visitor so InnerTube's continuation
    // (which embeds the ids already delivered) is applied to a stable result set
    // instead of a freshly ranked one; without it items shift and repeat.
    const visitorData = boppa.store.get('YOUTUBE_MUSIC_VISITOR_DATA') || '';
    const query = params.query;
    const continuation = params.previousResult?.continuation;
    const maxSeenIds = 1000;
    const seen = new Set(
      Array.isArray(params.previousResult?.seenIds)
        ? params.previousResult.seenIds.map(String).slice(-maxSeenIds)
        : []
    );

    const url = 'https://music.youtube.com/youtubei/v1/search?prettyPrint=false&key=' + apiKey;
    const headers = { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' };
    if (visitorData) headers['X-Goog-Visitor-Id'] = visitorData;

    function clientContext() {
      const client = { clientName: 'WEB_REMIX', clientVersion: clientVersion };
      if (visitorData) client.visitorData = visitorData;
      return { client: client };
    }

    const body = continuation
      ? {
          context: clientContext(),
          continuation: continuation
        }
      : {
          context: clientContext(),
          query: query,
          params: 'EgeKAQQoAEABag4QAxAFEAQQCRAKEBUQEA%3D%3D'
        };

    const resp = await credentialFetch(url, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body)
    });

    const data = await resp.json();

    function upgradeArtwork(url) {
      if (!url) return url;
      if (url.indexOf('ytimg.com') !== -1) {
        return url.replace(/\/[^\/?]+\.(jpg|jpeg|webp)(\?.*)?$/i, '/maxresdefault.jpg');
      }
      return url.replace(/=w\d+-h\d+/, '=w544-h544');
    }

    function extractPlaylists(response) {
      const results = [];
      let nextContinuation = null;

      try {
        let shelfContents = [];
        let continuations = null;

        if (response.continuationContents) {
          shelfContents = response.continuationContents.musicShelfContinuation?.contents || [];
          continuations = response.continuationContents.musicShelfContinuation?.continuations;
        } else {
          const sections = response.contents?.tabbedSearchResultsRenderer?.tabs?.[0]?.tabRenderer?.content?.sectionListRenderer?.contents || [];
          for (const section of sections) {
            if (section.musicShelfRenderer) {
              shelfContents = section.musicShelfRenderer.contents || [];
              continuations = section.musicShelfRenderer.continuations;
            }
          }
        }

        if (continuations?.[0]?.nextContinuationData) {
          nextContinuation = continuations[0].nextContinuationData.continuation;
        }

        for (const item of shelfContents) {
          const listItem = item.musicResponsiveListItemRenderer;
          if (listItem) {
            const browseId = listItem.navigationEndpoint?.browseEndpoint?.browseId;
            const pageType = listItem.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType;
            if (browseId && pageType === 'MUSIC_PAGE_TYPE_PLAYLIST' && !seen.has(browseId)) {
              seen.add(browseId);
              const flexColumns = listItem.flexColumns || [];
              const title = flexColumns[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text || '';
              let user = '';
              let trackCount = null;
              if (flexColumns[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs) {
                for (const run of flexColumns[1].musicResponsiveListItemFlexColumnRenderer.text.runs) {
                  const pt = run.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType;
                  if (pt === 'MUSIC_PAGE_TYPE_USER_CHANNEL' || pt === 'MUSIC_PAGE_TYPE_ARTIST') {
                    user = run.text;
                    break;
                  } else if (run.text && run.text !== ' • ' && !/^[\d.]+[KMB]? views$/.test(run.text)) {
                    if (!run.navigationEndpoint && !user) {
                      user = run.text;
                    }
                  }
                }
              }
              const playlistThumbnails = listItem.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails || [];
              results.push({
                id: browseId,
                title: title,
                subtitle: user || undefined,
                trackCount: trackCount,
                lowResArtworkUrl: playlistThumbnails.length > 0 ? (playlistThumbnails[1]?.url || playlistThumbnails[0].url) : undefined,
                highResArtworkUrl: playlistThumbnails.length > 0 ? upgradeArtwork(playlistThumbnails[playlistThumbnails.length - 1].url) : undefined,
                url: 'https://music.youtube.com/browse/' + browseId,
                metadata: { browseId: browseId }
              });
            }
          }
        }
      } catch (e) {}

      return { items: results, continuation: nextContinuation };
    }

    const result = extractPlaylists(data);
    const output = { items: result.items };
    if (result.continuation) {
      output.continuation = result.continuation;
      output.seenIds = Array.from(seen).slice(-maxSeenIds);
    }
    return output;
  },
}));
