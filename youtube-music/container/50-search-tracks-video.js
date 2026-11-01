boppa.data.register(credentialedData(['YOUTUBE_MUSIC_API_KEY', 'YOUTUBE_MUSIC_CLIENT_VERSION'], {
  "search/tracks/video": async function(params) {
    const apiKey = boppa.store.get('YOUTUBE_MUSIC_API_KEY');
    const clientVersion = boppa.store.get('YOUTUBE_MUSIC_CLIENT_VERSION');
    // Search results are not stable across requests unless InnerTube can tie them
    // to one visitor: without a visitor id the continuation token (which embeds the
    // ids of the previous page) is applied against a freshly ranked result set, so
    // items shift between pages and repeat. The visitor id removes most of that;
    // a bounded list of ids already delivered removes what is left.
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
          params: 'EgWKAQIQAWoOEAMQBRAEEAkQChAVEBA%3D'
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

    function extractVideos(response) {
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
            if (section.musicCardShelfRenderer) {
              const card = section.musicCardShelfRenderer;
              const videoId = card.title?.runs?.[0]?.navigationEndpoint?.watchEndpoint?.videoId;
              if (videoId) {
                const artists = [];
                let duration = '';
                const subtitleRuns = card.subtitle?.runs || [];
                for (const run of subtitleRuns) {
                  const pt = run.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType;
                  const browseId = run.navigationEndpoint?.browseEndpoint?.browseId;
                  if (pt === 'MUSIC_PAGE_TYPE_ARTIST' || pt === 'MUSIC_PAGE_TYPE_USER_CHANNEL') {
                    artists.push({ id: browseId || run.text, name: run.text, metadata: browseId ? { browseId: browseId } : {} });
                  } else if (/^\d+:\d+$/.test(run.text.trim())) {
                    duration = run.text.trim();
                  }
                }
                if (artists.length === 0 && subtitleRuns.length > 0 && subtitleRuns[0].text && subtitleRuns[0].text !== ' \u2022 ') {
                  artists.push({ id: subtitleRuns[0].text, name: subtitleRuns[0].text });
                }
                const result = {
                  id: videoId,
                  title: card.title.runs[0].text,
                  subtitle: artists.map(a => a.name).join(', ') || undefined,
                  duration: duration ? parseDuration(duration) : undefined,
                  lowResArtworkUrl: card.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.[1]?.url || card.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.[0]?.url,
                  highResArtworkUrl: upgradeArtwork(card.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.[0]?.url),
                  url: 'https://music.youtube.com/watch?v=' + videoId
                };
                if (artists.length > 0) result.profiles = artists;
                if (!seen.has(videoId)) { seen.add(videoId); results.push(result); }
              }
            }
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
          const videoId = listItem?.playlistItemData?.videoId
            || listItem?.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint?.videoId;
          if (videoId) {
            const flexColumns = listItem.flexColumns || [];
            const title = flexColumns[0]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs?.[0]?.text || '';
            const artists = [];
            let duration = '';
            const col1Runs = flexColumns[1]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
            for (const run of col1Runs) {
              const pt = run.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType;
              const browseId = run.navigationEndpoint?.browseEndpoint?.browseId;
              if (pt === 'MUSIC_PAGE_TYPE_ARTIST' || pt === 'MUSIC_PAGE_TYPE_USER_CHANNEL') {
                artists.push({ id: browseId || run.text, name: run.text, metadata: browseId ? { browseId: browseId } : {} });
              } else if (/^\d+:\d+$/.test(run.text.trim())) {
                duration = run.text.trim();
              }
            }
            if (artists.length === 0 && col1Runs.length > 0 && col1Runs[0].text && col1Runs[0].text !== ' \u2022 ') {
              artists.push({ id: col1Runs[0].text, name: col1Runs[0].text });
            }
            const result = {
              id: videoId,
              title: title,
              subtitle: artists.map(a => a.name).join(', ') || undefined,
              duration: duration ? parseDuration(duration) : undefined,
              lowResArtworkUrl: listItem.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.[1]?.url || listItem.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.[0]?.url,
              highResArtworkUrl: upgradeArtwork(listItem.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.[0]?.url),
              url: 'https://music.youtube.com/watch?v=' + videoId
            };
            if (artists.length > 0) result.profiles = artists;
            if (!seen.has(videoId)) { seen.add(videoId); results.push(result); }
          }
        }
      } catch (e) {}
      return { items: results, continuation: nextContinuation };
    }

    const result = extractVideos(data);
    const output = { items: result.items };
    if (result.continuation) {
      output.continuation = result.continuation;
      output.seenIds = Array.from(seen).slice(-maxSeenIds);
    }
    return output;
  },
}));
