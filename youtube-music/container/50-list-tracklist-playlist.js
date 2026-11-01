boppa.data.register(credentialedData(['YOUTUBE_MUSIC_API_KEY', 'YOUTUBE_MUSIC_CLIENT_VERSION'], {
  "list/tracklist/playlist": async function(params) {
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
    const continuation = params.previousResult?.continuation;
    const playlistArtwork = undefined;

    const url = 'https://music.youtube.com/youtubei/v1/browse?prettyPrint=false&key=' + apiKey;

    const body = continuation
      ? {
          context: clientContext(),
          continuation: continuation
        }
      : {
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

    function extractPlaylistTracks(response) {
      const results = [];
      let nextContinuation = null;
      let resolvedArtwork = playlistArtwork;
      let resolvedArtworkLow = playlistArtwork;

      try {
        let shelfContents = [];

        if (response.onResponseReceivedActions) {
          for (const action of response.onResponseReceivedActions) {
            if (action.appendContinuationItemsAction) {
              shelfContents = action.appendContinuationItemsAction.continuationItems || [];
              break;
            }
          }
        } else {
          const secondaryContents = response.contents?.twoColumnBrowseResultsRenderer?.secondaryContents?.sectionListRenderer?.contents || [];
          for (const section of secondaryContents) {
            if (section.musicPlaylistShelfRenderer) {
              shelfContents = section.musicPlaylistShelfRenderer.contents || [];
              break;
            }
          }
        }

        for (let i = shelfContents.length - 1; i >= 0; i--) {
          if (shelfContents[i].continuationItemRenderer) {
            const token = shelfContents[i].continuationItemRenderer.continuationEndpoint?.continuationCommand?.token;
            if (token) nextContinuation = token;
            shelfContents.splice(i, 1);
            break;
          }
        }

        for (const item of shelfContents) {
          const listItem = item.musicResponsiveListItemRenderer;
          if (!listItem) continue;

          const watchEndpoint = listItem.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer?.playNavigationEndpoint?.watchEndpoint;
          const videoId = listItem.playlistItemData?.videoId || watchEndpoint?.videoId;
          if (!videoId) continue;
          const musicVideoType = watchEndpoint?.watchEndpointMusicSupportedConfigs?.watchEndpointMusicConfig?.musicVideoType || '';
          if (!musicVideoType) continue;

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
          if (artists.length === 0 && col1Runs.length > 0 && col1Runs[0].text && col1Runs[0].text !== ' \u2022 ') {
            const fallbackRun = col1Runs[0];
            const fallbackBrowseId = fallbackRun.navigationEndpoint?.browseEndpoint?.browseId;
            artists.push({ id: fallbackBrowseId || fallbackRun.text, name: fallbackRun.text, metadata: fallbackBrowseId ? { browseId: fallbackBrowseId } : {} });
          }

          let albumName = '';
          let albumBrowseId = '';
          const col2Runs = flexColumns[2]?.musicResponsiveListItemFlexColumnRenderer?.text?.runs || [];
          for (const run of col2Runs) {
            const pt = run.navigationEndpoint?.browseEndpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig?.pageType;
            const bid = run.navigationEndpoint?.browseEndpoint?.browseId;
            if (pt === 'MUSIC_PAGE_TYPE_ALBUM' && bid) {
              albumName = run.text;
              albumBrowseId = bid;
            }
          }

          let duration;
          const fixedCols = listItem.fixedColumns || [];
          const durationText = fixedCols[0]?.musicResponsiveListItemFixedColumnRenderer?.text?.runs?.[0]?.text || '';
          if (durationText && /^\d+:\d+/.test(durationText.trim())) {
            duration = parseDuration(durationText.trim());
          }

          const rawItemArtwork = listItem.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.[1]?.url || listItem.thumbnail?.musicThumbnailRenderer?.thumbnail?.thumbnails?.[0]?.url;
          const itemArtwork = upgradeArtwork(rawItemArtwork);
          if (!resolvedArtwork && itemArtwork) {
            resolvedArtwork = itemArtwork;
          }
          if (!resolvedArtworkLow && rawItemArtwork) {
            resolvedArtworkLow = rawItemArtwork;
          }

          results.push({
            id: videoId,
            title: title,
            subtitle: artists.length > 0 ? artists.map(a => a.name).join(', ') : undefined,
            profiles: artists.length > 0 ? artists : undefined,
            tracklists: albumBrowseId ? [{ id: albumBrowseId, title: albumName, lowResArtworkUrl: rawItemArtwork || resolvedArtworkLow, highResArtworkUrl: itemArtwork || resolvedArtwork, metadata: { browseId: albumBrowseId } }] : undefined,
            duration: duration,
            lowResArtworkUrl: rawItemArtwork || resolvedArtworkLow,
            highResArtworkUrl: itemArtwork || resolvedArtwork,
            url: 'https://music.youtube.com/watch?v=' + videoId
          });
        }
      } catch (e) {}

      return { items: results, continuation: nextContinuation };
    }

    const result = extractPlaylistTracks(data);
    const output = { items: result.items };
    if (result.continuation) {
      output.continuation = result.continuation;
    }
    return output;
  },
}));
