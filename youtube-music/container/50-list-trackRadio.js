boppa.data.register(credentialedData(['YOUTUBE_MUSIC_API_KEY', 'YOUTUBE_MUSIC_CLIENT_VERSION'], {
  "list/trackRadio": async function(params) {
    const apiKey = boppa.store.get('YOUTUBE_MUSIC_API_KEY');
    const clientVersion = boppa.store.get('YOUTUBE_MUSIC_CLIENT_VERSION');
    const visitorData = boppa.store.get('YOUTUBE_MUSIC_VISITOR_DATA') || '';
    const videoId = String(params.id || '');
    const seedType = params.type || 'song';
    const previous = params.previousResult || null;
    const maxSeenVideoIds = 1000;
    const maxUsedContinuations = 100;

    if (!apiKey || !clientVersion || !videoId) {
      throw new Error('Missing YouTube Music radio credentials or seed video id');
    }

    const endpoint = 'https://music.youtube.com/youtubei/v1/next?prettyPrint=false&key=' +
      encodeURIComponent(apiKey);
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
      'X-YouTube-Client-Name': '67',
      'X-YouTube-Client-Version': clientVersion
    };
    if (visitorData) headers['X-Goog-Visitor-Id'] = visitorData;

    function clientContext() {
      const client = { clientName: 'WEB_REMIX', clientVersion: clientVersion, hl: 'en', gl: 'US' };
      if (visitorData) client.visitorData = visitorData;
      return { client: client };
    }

    async function postNext(body) {
      const response = await credentialFetch(endpoint, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(Object.assign({ context: clientContext() }, body))
      });
      if (!response.ok) throw new Error('YouTube Music radio request failed with ' + response.status);
      return response.json();
    }

    function playlistPanel(response) {
      if (response?.continuationContents?.playlistPanelContinuation) {
        return response.continuationContents.playlistPanelContinuation;
      }
      const tabs = response?.contents?.singleColumnMusicWatchNextResultsRenderer
        ?.tabbedRenderer?.watchNextTabbedResultsRenderer?.tabs || [];
      return tabs[0]?.tabRenderer?.content?.musicQueueRenderer?.content?.playlistPanelRenderer || null;
    }

    function automixEndpoint(panel) {
      for (const item of panel?.contents || []) {
        const watchEndpoint = item.automixPreviewVideoRenderer?.content?.automixPlaylistVideoRenderer
          ?.navigationEndpoint?.watchPlaylistEndpoint;
        if (watchEndpoint?.playlistId) return watchEndpoint;
      }
      return null;
    }

    function nextContinuation(panel) {
      const data = panel?.continuations?.[0]?.nextRadioContinuationData
        || panel?.continuations?.[0]?.nextContinuationData;
      return data?.continuation || null;
    }

    function parseDuration(timeStr) {
      const parts = String(timeStr || '').split(':').map(part => parseInt(part, 10));
      if (parts.some(part => !Number.isFinite(part))) return undefined;
      if (parts.length === 2) return (parts[0] * 60 + parts[1]) * 1000;
      if (parts.length === 3) return (parts[0] * 3600 + parts[1] * 60 + parts[2]) * 1000;
      return undefined;
    }

    function upgradeArtwork(url) {
      if (!url) return url;
      if (url.indexOf('ytimg.com') !== -1) {
        return url.replace(/\/[^\/?]+\.(jpg|jpeg|webp)(\?.*)?$/i, '/maxresdefault.jpg');
      }
      if (url.indexOf('googleusercontent.com') !== -1) {
        return url.replace(/=w\d+-h\d+[^&]*/, '=w544-h544-l90-rj');
      }
      return url.replace(/=w\d+-h\d+/, '=w544-h544');
    }

    function parsePanelItems(panel, seen) {
      const items = [];
      for (const item of panel?.contents || []) {
        const renderer = item.playlistPanelVideoRenderer;
        if (!renderer?.videoId) continue;
        const id = String(renderer.videoId);
        if (seen.has(id)) continue;
        seen.add(id);

        const bylineRuns = renderer.longBylineText?.runs || renderer.shortBylineText?.runs || [];
        const artists = [];
        const albums = [];
        for (const run of bylineRuns) {
          const browse = run.navigationEndpoint?.browseEndpoint;
          const pageType = browse?.browseEndpointContextSupportedConfigs
            ?.browseEndpointContextMusicConfig?.pageType;
          if ((pageType === 'MUSIC_PAGE_TYPE_ARTIST' || pageType === 'MUSIC_PAGE_TYPE_USER_CHANNEL')
            && run.text) {
            const artistId = browse.browseId || run.text;
            if (!artists.some(artist => artist.id === artistId)) {
              artists.push({
                id: artistId,
                name: run.text,
                metadata: browse.browseId ? { browseId: browse.browseId } : {}
              });
            }
          } else if (pageType === 'MUSIC_PAGE_TYPE_ALBUM' && browse?.browseId && run.text) {
            albums.push({
              id: browse.browseId,
              title: run.text,
              metadata: { browseId: browse.browseId }
            });
          }
        }
        if (!artists.length) {
          const fallback = renderer.shortBylineText?.runs?.find(run =>
            run.text && run.text.trim() && run.text.trim() !== '•');
          if (fallback?.text) artists.push({ id: fallback.text, name: fallback.text });
        }

        const thumbnails = renderer.thumbnail?.thumbnails || [];
        const lowArtwork = thumbnails[1]?.url || thumbnails[0]?.url;
        const highArtwork = upgradeArtwork(thumbnails[thumbnails.length - 1]?.url || lowArtwork);
        for (const album of albums) {
          album.lowResArtworkUrl = lowArtwork;
          album.highResArtworkUrl = highArtwork;
        }

        items.push({
          id: id,
          title: renderer.title?.runs?.[0]?.text || '',
          subtitle: artists.map(artist => artist.name).join(', ') || undefined,
          profiles: artists.length > 0 ? artists : undefined,
          tracklists: albums.length > 0 ? albums : undefined,
          duration: parseDuration(renderer.lengthText?.runs?.[0]?.text),
          lowResArtworkUrl: lowArtwork,
          highResArtworkUrl: highArtwork,
          url: 'https://music.youtube.com/watch?v=' + encodeURIComponent(id)
        });
      }
      return items;
    }

    // Bound state growth for an endless queue. Recommendations older than this
    // window may eventually repeat, while normal adjacent-page overlap is removed.
    const seen = new Set(
      Array.isArray(previous?.seenVideoIds)
        ? previous.seenVideoIds.map(String).slice(-maxSeenVideoIds)
        : []
    );
    const usedContinuations = new Set(
      Array.isArray(previous?.usedContinuations)
        ? previous.usedContinuations.map(String).slice(-maxUsedContinuations)
        : []
    );
    seen.add(videoId);

    let response;
    let panel;
    let playlistId = previous?.playlistId || null;
    let playlistParams = previous?.playlistParams || null;
    let queueContextParams = previous?.queueContextParams || '';
    const currentContinuation = previous?.continuation || null;

    if (currentContinuation) {
      usedContinuations.add(String(currentContinuation));
      response = await postNext({
        enablePersistentPlaylistPanel: true,
        tunerSettingValue: 'AUTOMIX_SETTING_NORMAL',
        continuation: currentContinuation,
        isAudioOnly: true,
        responsiveSignals: { videoInteraction: [] },
        queueContextParams: queueContextParams
      });
      panel = playlistPanel(response);
    } else {
      // This is the website's first request for a standalone song. It returns the
      // seed plus an automixPreviewVideoRenderer that identifies the actual radio.
      const bootstrap = await postNext({
        enablePersistentPlaylistPanel: true,
        tunerSettingValue: 'AUTOMIX_SETTING_NORMAL',
        videoId: videoId,
        watchEndpointMusicSupportedConfigs: {
          watchEndpointMusicConfig: {
            musicVideoType: seedType === 'video' ? 'MUSIC_VIDEO_TYPE_OMV' : 'MUSIC_VIDEO_TYPE_ATV'
          }
        },
        isAudioOnly: true,
        responsiveSignals: { videoInteraction: [] },
        queueContextParams: ''
      });
      const bootstrapPanel = playlistPanel(bootstrap);
      const automix = automixEndpoint(bootstrapPanel);
      queueContextParams = bootstrap.queueContextParams || '';

      if (automix) {
        playlistId = automix.playlistId;
        playlistParams = automix.params || null;
        // Expand the automix in normal server order. The website's Shuffle control
        // performs no request here; it only shuffles this populated queue locally.
        response = await postNext({
          enablePersistentPlaylistPanel: true,
          tunerSettingValue: 'AUTOMIX_SETTING_NORMAL',
          playlistId: playlistId,
          params: playlistParams,
          isAudioOnly: true,
          responsiveSignals: {
            videoInteraction: [{ queueImpress: {}, videoId: videoId, queueIndex: 0 }]
          },
          queueContextParams: queueContextParams
        });
        panel = playlistPanel(response);
      } else if ((bootstrapPanel?.contents || []).some(item => item.playlistPanelVideoRenderer)) {
        response = bootstrap;
        panel = bootstrapPanel;
      } else {
        // Some videos omit the preview renderer. Fall back to the equivalent radio
        // playlist identifier rather than terminating a potentially valid radio.
        playlistId = 'RDAMVM' + videoId;
        response = await postNext({
          enablePersistentPlaylistPanel: true,
          tunerSettingValue: 'AUTOMIX_SETTING_NORMAL',
          videoId: videoId,
          playlistId: playlistId,
          isAudioOnly: true,
          responsiveSignals: { videoInteraction: [] },
          queueContextParams: queueContextParams
        });
        panel = playlistPanel(response);
      }
    }

    queueContextParams = response?.queueContextParams || queueContextParams;
    playlistId = panel?.playlistId || playlistId;
    const items = parsePanelItems(panel, seen);
    const continuation = nextContinuation(panel);
    const output = { items: items };

    // Swift treats every non-item output field as continuation state. Emit state only
    // while a fresh token exists; otherwise RadioService correctly becomes exhausted.
    if (continuation && !usedContinuations.has(String(continuation))) {
      output.continuation = continuation;
      output.playlistId = playlistId;
      output.playlistParams = playlistParams;
      output.queueContextParams = queueContextParams;
      output.seenVideoIds = Array.from(seen).slice(-maxSeenVideoIds);
      output.usedContinuations = Array.from(usedContinuations).slice(-maxUsedContinuations);
    }

    return output;
  },
}));
